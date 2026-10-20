import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {createIsolatedRiskProfileResolver} from './risk-profiles.mjs';

const error = (code, message) => Object.assign(new Error(message), {code});

// Synchronous filesystem/Git inspection is confined to this single owned worker.
if (!isMainThread && workerData?.kind === 'risk-profile') {
  const resolve = createIsolatedRiskProfileResolver(workerData.entries);
  parentPort.on('message', ({id, cwd, deadline}) => {
    try {
      parentPort.postMessage({id, profile: resolve(cwd, {deadline})});
    } catch (e) {
      parentPort.postMessage({id, error: {code: e.code ?? 'PI_RISK_PROFILE_UNRESOLVED', message: 'Git repository identity could not be established'}});
    }
  });
}

export function createRiskProfileService(entries, {timeoutMs = 4000, maxPending = 32, WorkerImpl = Worker} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32) throw Error('Invalid risk inspection bounds');
  // Copy input so later caller mutation cannot alter the trust configuration.
  entries = structuredClone(entries);
  let worker, current, nextId = 0, closed = false, failed = false, stopping;
  const pending = new Map(), queue = [];
  function settle(item, err, profile) {
    if (!pending.delete(item.id)) return;
    clearTimeout(item.timer);
    if (current === item) current = undefined;
    if (err) item.reject(err); else item.resolve(profile);
  }
  function failAll(code) {
    failed = true;
    for (const item of [...pending.values()]) settle(item, error(code, 'Git risk inspection unavailable'));
    queue.length = 0;
    if (worker) stopping ??= worker.terminate();
  }
  function ensureWorker() {
    if (!worker) {
      try {
        worker = new WorkerImpl(new URL(import.meta.url), {workerData: {kind: 'risk-profile', entries}, resourceLimits:{maxOldGenerationSizeMb:64,stackSizeMb:4}});
        worker.on('message', value => {
          const item = current;
          if (!item || value.id !== item.id) { failAll('PI_RISK_PROFILE_UNRESOLVED'); return; }
          if (value.error) settle(item, error(value.error.code, value.error.message));
          else if (['standard', 'personal', 'critical'].includes(value.profile)) settle(item, null, value.profile);
          else { failAll('PI_RISK_PROFILE_UNRESOLVED'); return; }
          pump();
        });
        worker.on('error', () => failAll('PI_RISK_PROFILE_UNRESOLVED'));
        worker.on('exit', () => { if (!closed) failAll('PI_RISK_PROFILE_UNRESOLVED'); });
      } catch { failAll('PI_RISK_PROFILE_UNRESOLVED'); return; }
    }
  }
  function pump() {
    if (closed || failed || current) return;
    while (queue.length && !pending.has(queue[0].id)) queue.shift();
    if (!queue.length) { worker?.unref(); return; }
    ensureWorker(); if(failed)return;
    current = queue.shift();
    worker.ref();
    worker.postMessage({id: current.id, cwd: current.cwd, deadline: current.deadline});
  }
  return {
    // Gateway calls this after successful module construction: startup pins are
    // captured asynchronously, without deferring them until the first write.
    start() {if(!closed&&!failed&&entries.some(e=>e.riskProfile==='critical')){ensureWorker();worker?.unref();}},
    resolve(cwd) {
      if (closed || failed) return Promise.reject(error('PI_RISK_PROFILE_UNRESOLVED', 'Git risk inspection closed or failed'));
      if(typeof cwd!=='string')return Promise.reject(error('PI_RISK_PROFILE_UNRESOLVED','Directory required'));
      if(entries.length===0)return Promise.resolve('standard');
      if (pending.size >= maxPending) return Promise.reject(error('PI_RISK_PROFILE_BUSY', 'Git risk inspection queue full'));
      return new Promise((resolve, reject) => {
        const item = {id: ++nextId, cwd, resolve, reject, deadline: Date.now() + Math.min(3000, timeoutMs)};
        item.timer = setTimeout(() => {
          // A running timeout invalidates this worker: never silently recreate its pins.
          if (current === item) failAll('PI_RISK_PROFILE_TIMEOUT');
          else { settle(item, error('PI_RISK_PROFILE_TIMEOUT', 'Git risk inspection deadline exceeded')); pump(); }
        }, timeoutMs);
        pending.set(item.id, item); queue.push(item); pump();
      });
    },
    async close() {
      closed = true;
      for (const item of [...pending.values()]) settle(item, error('PI_RISK_PROFILE_CLOSED', 'Git risk inspection closed'));
      queue.length = 0;
      if (worker) stopping ??= worker.terminate();
      await stopping;
    },
  };
}
