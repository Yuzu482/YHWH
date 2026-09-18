// Synchronous service construction, with explicit ownership and awaited teardown.
const fault = (code, message) => Object.assign(new Error(message), { code });

function orderDefinitions(definitions) {
  const entries = new Map();
  for (const definition of definitions) {
    const { id, dependsOn = [], create, dispose, validate } = definition;
    if (typeof id !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(id) || entries.has(id)) throw fault('MODULE_DEFINITION_INVALID', 'Module IDs must be unique names');
    if (typeof create !== 'function' || !Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length) throw fault('MODULE_DEFINITION_INVALID', `Invalid factory/dependencies: ${id}`);
    if (create.constructor?.name === 'AsyncFunction') throw fault('MODULE_ASYNC_FACTORY', `Async factory is unsupported: ${id}`);
    if ((dispose !== undefined && typeof dispose !== 'function') || (validate !== undefined && typeof validate !== 'function')) throw fault('MODULE_DEFINITION_INVALID', `Invalid lifecycle hook: ${id}`);
    if (validate?.constructor?.name === 'AsyncFunction') throw fault('MODULE_ASYNC_VALIDATOR', `Async validation is unsupported: ${id}`);
    entries.set(id, { ...definition, dependsOn: [...dependsOn] });
  }
  const ordered = [], visiting = new Set(), visited = new Set();
  const visit = id => {
    if (!entries.has(id)) throw fault('MODULE_DEPENDENCY_MISSING', `Unknown module dependency: ${id}`);
    if (visiting.has(id)) throw fault('MODULE_DEPENDENCY_CYCLE', `Cyclic module dependency: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of entries.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(entries.get(id));
  };
  for (const id of entries.keys()) visit(id);
  return ordered;
}

async function disposeRecords(records) {
  const errors = [];
  for (const record of [...records].reverse()) {
    while (record.cleanups.length) {
      const cleanup = record.cleanups.pop();
      try { await cleanup(); }
      catch (cause) { errors.push(Object.assign(new Error(`Cleanup failed: ${record.id}`, { cause }), { moduleId: record.id })); }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Module cleanup failed');
}

/** Factories are synchronous. On startup failure await error.cleanup for rollback. */
export function createModuleLifecycle(definitions) {
  const ordered = orderDefinitions(definitions);
  const records = new Map();
  let state = 'starting', closing = false, replacement, shutdownPromise;

  function construct(definition, generation = 1) {
    const record = { ...definition, generation, owned: definition.owned !== false, cleanups: [], value: undefined };
    // Keep partial acquisitions visible to rollback even when create throws.
    const defer = cleanup => {
      if (!record.constructing || typeof cleanup !== 'function') throw fault('MODULE_CLEANUP_INVALID', 'Register cleanup synchronously during construction');
      if (!record.owned) throw fault('MODULE_OWNERSHIP_INVALID', 'Borrowed modules cannot register owned effects');
      record.cleanups.push(cleanup);
    };
    record.constructing = true;
    try {
      record.value = definition.create({
        dependencies: Object.freeze(Object.fromEntries(definition.dependsOn.map(id => [id, records.get(id).value]))),
        defer,
      });
      if (record.value && typeof record.value.then === 'function') {
        // Observe a rejected unsupported promise; its producer owns any async acquisitions.
        Promise.resolve(record.value).catch(() => {});
        throw fault('MODULE_ASYNC_FACTORY', `Async factory is unsupported: ${definition.id}`);
      }
      if (record.owned && definition.dispose) record.cleanups.push(() => definition.dispose(record.value));
      const validation = definition.validate?.(record.value);
      if (validation && typeof validation.then === 'function') {
        Promise.resolve(validation).catch(() => {});
        throw fault('MODULE_ASYNC_VALIDATOR', `Async validation is unsupported: ${definition.id}`);
      }
      return record;
    } catch (error) {
      throw Object.assign(new Error(`Module initialization failed: ${definition.id}`, { cause: error }), { code: error.code ?? 'MODULE_INIT_FAILED', partialRecord: record });
    } finally { record.constructing = false; }
  }

  try {
    for (const definition of ordered) records.set(definition.id, construct(definition));
    state = 'ready';
  } catch (error) {
    state = 'failed';
    const cleanup = disposeRecords([...records.values(), ...(error.partialRecord ? [error.partialRecord] : [])]);
    cleanup.catch(() => {}); // Caller can await error.cleanup without an unhandled rejection.
    delete error.partialRecord;
    throw Object.assign(error, { cleanup });
  }

  function get(id) {
    if (state !== 'ready' || closing) throw fault('MODULES_UNAVAILABLE', `Modules are ${state}`);
    if (!records.has(id)) throw fault('MODULE_UNKNOWN', `Unknown module: ${id}`);
    return records.get(id).value;
  }

  function replace(id, candidate) {
    if (state !== 'ready' || closing) return Promise.reject(fault('MODULES_UNAVAILABLE', `Modules are ${state}`));
    const previous = records.get(id);
    if (!previous?.replaceable || [...records.values()].some(r => r.dependsOn.includes(id))) return Promise.reject(fault('MODULE_PINNED', `Module cannot be replaced: ${id}`));
    if (!candidate || typeof candidate.create !== 'function' || (candidate.dispose !== undefined && typeof candidate.dispose !== 'function')) return Promise.reject(fault('MODULE_DEFINITION_INVALID', 'Replacement needs create and optional dispose functions'));
    if (candidate.create.constructor?.name === 'AsyncFunction') return Promise.reject(fault('MODULE_ASYNC_FACTORY', 'Replacement factories must be synchronous'));
    state = 'replacing';
    replacement = (async () => {
      let next;
      try {
        next = construct({ ...previous, create: candidate.create, dispose: candidate.dispose, owned: true }, previous.generation + 1);
      } catch (error) {
        try { if (error.partialRecord) await disposeRecords([error.partialRecord]); }
        catch (cleanupError) { state = 'failed'; throw new AggregateError([error, cleanupError], 'Candidate rollback failed'); }
        finally { delete error.partialRecord; }
        state = 'ready';
        throw error;
      }
      try { await disposeRecords([previous]); }
      catch (error) {
        state = 'failed';
        try { await disposeRecords([next]); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Replacement cleanup failed'); }
        throw error;
      }
      records.set(id, next);
      state = 'ready';
      return { id, generation: next.generation };
    })();
    return replacement;
  }

  function dispose() {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      // Replacement owns its cleanup until it settles; never dispose in parallel.
      try { await replacement; } catch { /* Replacement failure is returned to its caller. */ }
      state = 'disposing';
      try { await disposeRecords([...records.values()]); state = 'disposed'; }
      catch (error) { state = 'failed'; throw error; }
    })();
    return shutdownPromise;
  }

  return {
    get, replace, dispose,
    snapshot: () => ({ state, closing, modules: [...records.values()].map(({ id, dependsOn, generation, owned, replaceable }) => ({ id, dependsOn: [...dependsOn], generation, owned, replaceable: replaceable === true })) }),
  };
}
