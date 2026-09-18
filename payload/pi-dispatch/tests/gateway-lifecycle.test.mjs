import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGatewayApp, createGatewayRuntime, gracefulShutdownHttp } from '../scripts/gateway.mjs';
import { roleValue } from './contract-fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const token = 'lifecycle-fixture-01234567890123456789';
const sandboxStatus = { ok:true, backend:'fixture', resourceLimits:true };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const parsed = result => JSON.parse(result.content[0].text);
const reply = (request, task, label) => ({ ok:true, provider:request.provider, model:request.model, text:'KETHER_RESULT_JSON=' + JSON.stringify(roleValue(task.role, label)) });
const input = { cwd:root, provider:'openai-codex', model:'gpt-5.6-luna', access:'none', resourceProfile:'small', task:{ role:'worker', objective:'Fixture', acceptance:['Return fixture evidence'] } };
const baseOptions = () => ({ host:'127.0.0.1', port:0, roots:[root], token, sandboxStatus, schedulerOptions:{ availableMemoryBytes:() => Number.MAX_SAFE_INTEGER, pollIntervalMs:5 } });

async function withGateway(run, overrides = {}) {
  const { app, runtime } = createGatewayApp({ ...baseOptions(), dispatchFn:async (r, _s, t) => reply(r, t, 'old'), ...overrides });
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name:'lifecycle-test', version:'1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit:{ headers:{ Authorization:`Bearer ${token}` } } }));
  try { await run({ runtime, client, url }); }
  finally {
    await client.close();
    await runtime.shutdown({ graceMs:50, abortWaitMs:50 }).catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
}

test('idle replacement changes actual MCP execution and preserves the governed tool surface', async () => {
  let disposed = 0;
  await withGateway(async ({ runtime, client }) => {
    assert.equal(parsed(await client.callTool({ name:'dispatch_subagent', arguments:input })).structuredResult.result, 'old');
    await runtime.replaceAdapter('dispatch', { create:() => async (r, _s, t) => reply(r, t, 'new'), dispose:() => disposed++ });
    assert.equal(parsed(await client.callTool({ name:'dispatch_subagent', arguments:input })).structuredResult.result, 'new');
    assert.equal(runtime.capabilities().lifecycle.modules.find(m => m.id === 'dispatch').generation, 2);
    for (const name of ['ledger','audit','executor','notKnown']) await assert.rejects(runtime.replaceAdapter(name, { create:() => ({}) }), { code:'MODULE_PINNED' });
    assert.ok(!(await client.listTools()).tools.some(tool => /replace|reload/.test(tool.name)));
    const bad = parsed(await client.callTool({ name:'dispatch_subagent', arguments:{ ...input, model:'unapproved' } }));
    assert.equal(bad.ok, false);
  });
  assert.equal(disposed, 1);
});

test('active dispatch and its result-recording tail both block replacement', async () => {
  const entered = deferred(), release = deferred();
  let runtimeRef, tailCheck;
  await withGateway(async ({ runtime, client }) => {
    runtimeRef = runtime;
    const call = client.callTool({ name:'dispatch_subagent', arguments:input });
    await entered.promise;
    await assert.rejects(runtime.replaceAdapter('dispatch', { create:() => () => {} }), { code:'GATEWAY_BUSY' });
    release.resolve();
    assert.equal(parsed(await call).ok, true);
    await tailCheck;
  }, {
    dispatchFn:async (r, _s, t) => { entered.resolve(); await release.promise; return reply(r, t, 'done'); },
    auditLogger:{ enabled:true, record:record => {
      if (record.operation === 'dispatch_subagent') tailCheck = assert.rejects(runtimeRef.replaceAdapter('dispatch', { create:() => () => {} }), { code:'GATEWAY_BUSY' });
    } },
  });
});

test('queued monitor admissions block replacement even before their runner starts', async () => {
  const tasks = [{ state:'queued' }];
  const monitor = { get size() { return tasks.length; }, list:() => tasks };
  const runtime = createGatewayRuntime({ ...baseOptions(), taskMonitor:monitor });
  await assert.rejects(runtime.replaceAdapter('dispatch', { create:() => () => {} }), { code:'GATEWAY_BUSY' });
  tasks.length = 0;
  await runtime.replaceAdapter('dispatch', { create:() => () => {} });
  await runtime.shutdown();
});

test('direct LSP holds a lifecycle lease and uses the replacement adapter', async () => {
  const entered = deferred(), release = deferred();
  await withGateway(async ({ runtime, client }) => {
    const args = { cwd:root, file:'package.json', method:'hover', line:1, character:1, resourceProfile:'small' };
    const call = client.callTool({ name:'lsp_request', arguments:args });
    await entered.promise;
    await assert.rejects(runtime.replaceAdapter('lsp', { create:() => () => {} }), { code:'GATEWAY_BUSY' });
    release.resolve();
    assert.equal(parsed(await call).ok, true);
    await runtime.replaceAdapter('lsp', { create:() => async () => ({ ok:true, status:'success', toolsUsed:['lsp_hover'], result:{ label:'replacement' } }) });
    assert.equal(parsed(await client.callTool({ name:'lsp_request', arguments:args })).result.label, 'replacement');
  }, { lspFn:async () => { entered.resolve(); await release.promise; return { ok:true, status:'success', toolsUsed:['lsp_hover'], result:{} }; } });
});

test('replacement blocks admission and readiness until retirement completes; shutdown serializes', async () => {
  const release = deferred(); let retired = 0;
  await withGateway(async ({ runtime, client, url }) => {
    await runtime.replaceAdapter('dispatch', { create:() => async (r, _s, t) => reply(r, t, 'first'), dispose:() => release.promise });
    const swapping = runtime.replaceAdapter('dispatch', { create:() => async (r, _s, t) => reply(r, t, 'second'), dispose:() => retired++ });
    assert.equal((await fetch(url + '/readyz')).status, 503);
    assert.equal(parsed(await client.callTool({ name:'dispatch_subagent', arguments:input })).code, 'GATEWAY_UNAVAILABLE');
    assert.equal(parsed(await client.callTool({ name:'submit_subagent', arguments:{ ...input, requestId:'during-swap' } })).ok, false);
    await assert.rejects(runtime.replaceAdapter('lsp', { create:() => () => {} }), { code:'GATEWAY_UNAVAILABLE' });
    const closing = runtime.shutdown({ graceMs:0, abortWaitMs:0 });
    release.resolve();
    await swapping;
    assert.equal((await closing).disposed, true);
    assert.equal(retired, 1);
    assert.equal(runtime.capabilities().lifecycle.phase, 'disposed');
  });
});

test('shutdown aggregates failures while closing owned resources and preserving borrowed ones', async () => {
  const events = [];
  const runtime = createGatewayRuntime({ ...baseOptions(),
    auditLogger:{ enabled:true, record:() => {}, prune:() => { throw Error('prune failed'); }, close:() => events.push('audit-close') },
    requestLedger:{ enabled:true, close:() => events.push('borrowed-ledger-close') },
    ownedModules:['audit'],
    moduleFactories:{ circuit:() => ({ close:async () => { events.push('circuit-close'); throw Error('close failed'); } }) },
  });
  const closing = runtime.shutdown();
  assert.equal(closing, runtime.shutdown());
  await assert.rejects(closing, AggregateError);
  assert.deepEqual(events, ['circuit-close','audit-close']);
});

test('shutdown defers disposal while a non-scheduler operation is still using resources', async () => {
  const entered = deferred(), release = deferred(); let closed = 0;
  await withGateway(async ({ runtime, client }) => {
    const call = client.callTool({ name:'renew_claude_auth', arguments:{} });
    await entered.promise;
    const first = await runtime.shutdown({ graceMs:0, abortWaitMs:1 });
    assert.equal(first.disposed, false);
    assert.equal(closed, 0);
    await assert.rejects(runtime.replaceAdapter('dispatch', { create:() => () => {} }), { code:'GATEWAY_UNAVAILABLE' });
    release.resolve();
    await call;
    const second = await runtime.shutdown({ graceMs:0, abortWaitMs:1 });
    assert.equal(second.disposed, true);
    assert.equal(closed, 1);
  }, { renewAuthFn:async () => { entered.resolve(); await release.promise; return { ok:true }; }, auditLogger:{ enabled:true, record:() => {}, close:() => closed++ }, ownedModules:['audit'] });
});

test('startup factory failure releases earlier owned resources; invalid factory configuration is side-effect free', async () => {
  let closed = 0, started = 0, failure;
  const factories = { audit:() => { started++; return { close:() => closed++ }; }, ledger:() => { throw Error('ledger failed'); } };
  assert.throws(() => createGatewayRuntime({ ...baseOptions(), moduleFactories:{ ...factories, unknown:() => ({}) } }), /Unknown/);
  assert.equal(started, 0);
  try { createGatewayRuntime({ ...baseOptions(), moduleFactories:factories }); } catch (error) { failure = error; }
  await failure.cleanup;
  assert.equal(closed, 1);
});

test('real asynchronous submissions and queued work exclude replacement', async () => {
  const entered = deferred(), release = deferred();
  await withGateway(async ({ runtime, client }) => {
    const first = parsed(await client.callTool({ name:'submit_subagent', arguments:{ ...input, requestId:'life-async-1' } }));
    assert.equal(first.accepted, true);
    await entered.promise;
    const second = parsed(await client.callTool({ name:'submit_subagent', arguments:{ ...input, requestId:'life-async-2' } }));
    assert.equal(second.accepted, true);
    assert.equal(runtime.executor.state.queued, 1);
    await assert.rejects(runtime.replaceAdapter('dispatch', { create:() => () => {} }), { code:'GATEWAY_BUSY' });
    release.resolve();
    for (let i = 0; i < 100 && runtime.capabilities().lifecycle.pendingTasks; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runtime.capabilities().lifecycle.pendingTasks, 0);
    await runtime.replaceAdapter('dispatch', { create:() => async (r, _s, t) => reply(r, t, 'after-queue') });
  }, { maxConcurrency:1, dispatchFn:async (r, _s, t) => { entered.resolve(); await release.promise; return reply(r, t, 'async'); } });
});

test('invalid replacement keeps gateway usable; retirement failure disables admission', async () => {
  let closed = 0;
  await withGateway(async ({ runtime, client }) => {
    await assert.rejects(runtime.replaceAdapter('dispatch', { create:() => ({}), dispose:() => closed++ }));
    assert.equal(closed, 1);
    assert.equal(parsed(await client.callTool({ name:'dispatch_subagent', arguments:input })).structuredResult.result, 'old');
    await runtime.replaceAdapter('dispatch', { create:() => async (r, _s, t) => reply(r, t, 'first'), dispose:() => { throw Error('retirement failed'); } });
    await assert.rejects(runtime.replaceAdapter('dispatch', { create:() => async (r, _s, t) => reply(r, t, 'never'), dispose:() => closed++ }));
    assert.equal(closed, 2);
    assert.equal(runtime.capabilities().accepting, false);
    assert.equal(parsed(await client.callTool({ name:'dispatch_subagent', arguments:input })).ok, false);
  });
});

test('HTTP shutdown still closes sockets after cleanup failure and rejects incomplete disposal', async () => {
  for (const mode of ['failed','incomplete']) {
    let closed = false;
    const server = { close:callback => { closed = true; callback(); }, closeIdleConnections:() => {} };
    const runtime = { shutdown:async () => { if (mode === 'failed') throw Error('cleanup failed'); return { disposed:false }; } };
    await assert.rejects(gracefulShutdownHttp(server, runtime, { socketCloseMs:1 }), mode === 'failed' ? /cleanup failed/ : { code:'GATEWAY_DRAIN_INCOMPLETE' });
    assert.equal(closed, true);
  }
});

test('a rolled-back candidate does not poison subsequent normal shutdown', async () => {
  const runtime = createGatewayRuntime(baseOptions());
  await assert.rejects(runtime.replaceAdapter('dispatch', { create:() => null }));
  assert.equal(runtime.capabilities().accepting, true);
  assert.equal((await runtime.shutdown()).disposed, true);
});
