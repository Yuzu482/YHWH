import {roleValue,handoff,ref} from './contract-fixtures.mjs';
import {resultDigest} from '../extensions/role-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BoundedExecutor, createGatewayApp, createGatewayRuntime, registerMcpResponseCleanup, resolveAllowedCwd, resolveAllowedFile } from '../scripts/gateway.mjs';
import { createMemoryProviderCircuitState } from '../extensions/provider-circuit-state.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = resolve(root, 'tests');
const token = 'test-token-0123456789-0123456789-abcdef';
const verifiedSandbox = { ok: true, backend: 'wsl2-bwrap', hostMountVisible: false, windowsInterop: false, bubblewrap: true, pi: true, resourceLimits: true };

test('MCP response cleanup is registered early and runs exactly once', async () => {
  const res = new EventEmitter();
  res.destroyed = false;
  let transportCloses = 0;
  let serverCloses = 0;
  const cleanup = registerMcpResponseCleanup(res, { close: async () => { transportCloses += 1; } }, { close: async () => { serverCloses += 1; } });
  assert.equal(res.listenerCount('close'), 1);
  assert.equal(res.listenerCount('finish'), 1);
  assert.equal(res.listenerCount('error'), 1);
  res.emit('close');
  res.emit('finish');
  await cleanup();
  assert.equal(transportCloses, 1);
  assert.equal(serverCloses, 1);
  assert.equal(res.listenerCount('close'), 0);
});

test('MCP response cleanup handles an already destroyed response', async () => {
  const res = new EventEmitter();
  res.destroyed = true;
  let closes = 0;
  const cleanup = registerMcpResponseCleanup(res, { close: () => { closes += 1; } }, { close: () => { closes += 1; } });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await cleanup();
  assert.equal(closes, 2);
});

test('MCP response cleanup covers response errors', async () => {
  const res = new EventEmitter();
  res.destroyed = false;
  let closes = 0;
  const cleanup = registerMcpResponseCleanup(res, { close: () => { closes += 1; } }, { close: () => { closes += 1; } });
  res.emit('error', new Error('socket failed'));
  await cleanup();
  assert.equal(closes, 2);
});

function formattedTaskResult(task) { return 'KETHER_RESULT_JSON='+JSON.stringify(roleValue(task.role,task.objective)); }

function parsed(result) {
  return JSON.parse(result.content[0].text);
}

test('typed failed/unverified outputs and type errors cannot produce successful outcomes or contracts', async()=>{
  let mode='failed';
  await withGateway(async({client})=>{
    for (const status of ['failed','blocked','unverified','wrong-type']) {
      mode=status;
      const result=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-5.6-luna',requestId:`typed-${status}`,access:'none',resourceProfile:'small',task:{role:'worker',objective:'Controlled negative fixture',acceptance:['Report the actual fixture outcome']}}}));
      assert.equal(result.ok,false,status);assert.equal(result.contract,undefined,status);
      if (status==='wrong-type') assert.equal(result.roleValidation.ok,false);
      else {assert.equal(result.roleValidation.ok,true);assert.equal(result.status,status);}
    }
    const stripped=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-5.6-luna',access:'none',task:{role:'worker',objective:'Strip fields',acceptance:['Must block'],returnFields:['result']}}}));
    assert.equal(stripped.code,'ROLE_FIELDS_REQUIRED');
  },{dispatchFn:async(request)=>{
    const value=roleValue('Chesed');
    if(mode==='wrong-type')value.evidence='not an array';else value.status=mode;
    return {ok:true,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value),contract:{version:2,stage:'implementing'}};
  }});
});

test('editor authorization is explicit, ledger-protected, closed and not inherited by ordinary tasks',async()=>{
 let calls=0,brokers=0,closes=0;const outcomes=[];
 await withGateway(async({client})=>{
  const input={cwd:root,provider:'openai-codex',model:'gpt-5.6-luna',access:'none',requestId:'editor-parent',parentRunId:'editor-run',resourceProfile:'small',task:{role:'worker',objective:'Execute exact authorized read',acceptance:['Read the scene']},editorAuthorization:{version:1,expiresAt:new Date(Date.now()+60000).toISOString(),operations:[{id:'read',editor:'blender',tool:'blender_scene_info',args:{}}]}};
  const first=parsed(await client.callTool({name:'dispatch_subagent',arguments:input}));assert.equal(first.ok,true);assert.equal(first.editorExecution.authorized,true);
  const replay=parsed(await client.callTool({name:'dispatch_subagent',arguments:input}));assert.equal(replay.idempotency.status,'replayed');assert.equal(calls,1);assert.equal(brokers,1);assert.ok(closes>=1);
  const bad=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...input,requestId:'editor-no-run',parentRunId:undefined}}));assert.equal(bad.ok,false);assert.match(bad.error,/TRACE/);assert.equal(calls,1);
  const conflict=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...input,editorAuthorization:{...input.editorAuthorization,operations:[{...input.editorAuthorization.operations[0],id:'changed'}]}}}));assert.equal(conflict.ok,false);assert.equal(calls,1);
  const normal=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...input,requestId:'no-editor',editorAuthorization:undefined}}));assert.equal(normal.ok,true);assert.equal(outcomes[1],null);assert.equal(brokers,1);
 },{editorBrokerFactory:()=>{brokers++;return {catalog:[],close:async()=>{closes++;},report:()=>({ok:true,authorized:true,operations:[]})};},dispatchFn:async(request,_signal,task,opts)=>{calls++;outcomes.push(opts.editorBroker);return {ok:true,provider:request.provider,model:request.model,text:formattedTaskResult(task)};}});
});

test('MCP stage chain injects ledger evidence and blocks cross-run/hash/review bypass before dispatch',async()=>{
  const invoked=[];let rejectReview=false;
  const packet={version:1,stage:'pre-change',...Object.fromEntries(['requirements','changes','context','verification'].map(k=>[k,{status:'provided',content:['Observed synthetic '+k]}]))};
  await withGateway(async({client})=>{
    const common={cwd:root,provider:'openai-codex',model:'gpt-5.6-luna',access:'none',resourceProfile:'small',parentRunId:'typed-run',timeoutSeconds:5};
    const run=async(id,role,stage,inputs=[],extras={})=>parsed(await client.callTool({name:'dispatch_subagent',arguments:{...common,...extras,requestId:id,dependsOnRequestIds:inputs.map(i=>i.requestId),task:{role,objective:id,acceptance:['Observe fixture'],handoff:handoff(stage,inputs),...(role==='Geburah'?{reviewPacket:packet}:{})}}}));
    const scout=await run('typed-scout','Malkuth','scouted');assert.equal(scout.ok,true);
    const scoutRef=ref('typed-scout','Malkuth','scouted',scout.contract.resultSha256);
    for (const [id,inputs,extras] of [
      ['wrong-run',[scoutRef],{parentRunId:'other-run'}],
      ['wrong-hash',[{...scoutRef,resultSha256:'f'.repeat(64)}],{}],
    ]) {const bad=await run(id,'Chochmah','planned',inputs,extras);assert.equal(bad.ok,false);assert.equal(bad.code,'HANDOFF_INVALID');}
    assert.deepEqual(invoked.map(x=>x.role),['Malkuth']);
    const plan=await run('typed-plan','Chochmah','planned',[scoutRef]);assert.equal(plan.ok,true);
    assert.equal(invoked[1].upstream[0].result.result,'typed-scout');
    const planRef=ref('typed-plan','Chochmah','planned',plan.contract.resultSha256);
    const review=await run('typed-review','Geburah','pre-review',[planRef],{provider:'pi-claude-code-provider',model:'claude-sonnet-5'});assert.equal(review.ok,true);
    const reviewRef=ref('typed-review','Geburah','pre-review',review.contract.resultSha256);
    const worker=await run('typed-worker','Chesed','implementing',[reviewRef]);assert.equal(worker.ok,true);
    const replay=await run('typed-worker','Chesed','implementing',[reviewRef]);assert.equal(replay.idempotency.status,'replayed');assert.equal(invoked.length,4);
    const conflict=await run('typed-worker','Chesed','implementing',[reviewRef],{priority:8});assert.equal(conflict.ok,false);assert.equal(invoked.length,4);
    rejectReview=true;
    const rejected=await run('typed-review-reject','Geburah','pre-review',[planRef],{provider:'pi-claude-code-provider',model:'claude-sonnet-5'});assert.equal(rejected.ok,false);
    const blocked=await run('typed-blocked','Chesed','implementing',[ref('typed-review-reject','Geburah','pre-review')]);assert.equal(blocked.ok,false);assert.match(blocked.error,/dependency failed/);assert.equal(invoked.length,5);
  },{dispatchFn:async(request,_signal,task,options)=>{
    invoked.push({role:task.role,upstream:options.upstreamResults});
    const value=roleValue(task.role,task.objective);if(task.role==='Geburah'&&rejectReview)value.reviewDecision='request-changes';
    return {ok:true,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value)};
  }});
});

async function withGateway(run, options = {}) {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'pi-gateway-ledger-'));
  const dispatchFn = async (request, _signal, task, options) => ({
    ok: true,
    text: options?.resultFormat === 'plain' ? task.objective : formattedTaskResult(task),
    provider: request.provider,
    model: request.model,
    requestedProvider: request.provider,
    requestedModel: request.model,
    toolsUsed: task.acceptance?.[0]?.match(/includes ([A-Za-z0-9_]+)/)?.[1] ? [task.acceptance[0].match(/includes ([A-Za-z0-9_]+)/)[1]] : [],
  });
  const { app } = createGatewayApp({ host: '127.0.0.1', port: 0, roots: [root], token, dispatchFn, lspFn:async request=>({ok:true,toolsUsed:[{hover:'lsp_hover',diagnostics:'lsp_diagnostics'}[request.method]],result:{content:[]}}), sandboxStatus: verifiedSandbox, requestLedgerDir: ledgerDir, schedulerOptions: { availableMemoryBytes: () => Number.MAX_SAFE_INTEGER, pollIntervalMs: 5 }, ...options });
  const http = await new Promise(resolvePromise => {
    const instance = app.listen(0, '127.0.0.1', () => resolvePromise(instance));
  });
  const port = http.address().port;
  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    await run({ client, port });
  } finally {
    await client.close();
    await new Promise(resolvePromise => http.close(resolvePromise));
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

test('gateway rejects incomplete governance contracts before model execution', async () => {
  let dispatched = 0;
  await withGateway(async ({client}) => {
    for (const task of [
      {role:'worker',objective:'Inspect file',readScope:['package.json']},
      {role:'worker',objective:'Inspect file',acceptance:['Report observed content']},
    ]) {
      const response=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-5.6-luna',access:'read',task}}));
      assert.equal(response.ok,false);
      assert.match(response.error,/acceptance criteria|explicit readScope/);
    }
    assert.equal(dispatched,0);
  },{dispatchFn:async()=>{dispatched++;throw new Error('Must not execute');}});
});

test('review material gate blocks before dispatch and rejects non-approval outcomes',async()=>{
 let calls=0;
 const reviewPacket={version:1,stage:'post-change',...Object.fromEntries(['requirements','changes','context','verification'].map(k=>[k,{status:'provided',content:['Synthetic evidence for '+k]}]))};
 const task={role:'reviewer',objective:'Review fixture',acceptance:['Evidence based decision'],reviewPacket};
 const base={cwd:root,provider:'pi-claude-code-provider',model:'claude-sonnet-5',access:'none',resourceProfile:'small',task};
 await withGateway(async({client})=>{
  const missing=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...base,task:{...task,reviewPacket:undefined}}}));
  assert.equal(missing.status,'blocked');assert.equal(missing.code,'REVIEW_MATERIALS_MISSING');assert.equal(calls,0);
  const rejected=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...base,requestId:'review-rejected'}}));
  assert.equal(rejected.ok,false);assert.equal(rejected.reviewValidation.decision,'request-changes');assert.equal(calls,1);
  const dependent=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-5.6-luna',access:'none',resourceProfile:'small',queueTimeoutSeconds:1,dependsOnRequestIds:['review-rejected'],task:{role:'worker',objective:'Must not run after failed review',acceptance:['Blocked']}}}));
  assert.equal(dependent.ok,false);assert.match(dependent.error,/explicit typed handoff/);assert.equal(calls,1);
 },{dispatchFn:async(request,_signal,t)=>{
  calls++;
  const value=JSON.parse(formattedTaskResult(t).slice('KETHER_RESULT_JSON='.length));
  Object.assign(value,{reviewDecision:'request-changes',missingMaterials:[]});
  return {ok:true,provider:request.provider,model:request.model,requestedProvider:request.provider,requestedModel:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value),toolsUsed:[]};
 }});
});

test('async monitor exposes waiting reason and independent deadlines',async()=>{
 await withGateway(async({client})=>{
  const input={cwd:root,provider:'openai-codex',model:'gpt-5.6-luna',requestId:'queue-reasons',parentRunId:'queue-reasons',access:'none',resourceProfile:'small',timeoutSeconds:2,queueTimeoutSeconds:1,dependsOnRequestIds:['pending-dependency'],task:{role:'worker',objective:'Wait for dependency',acceptance:['No dispatch'],handoff:handoff('implementing',[ref('pending-dependency','Geburah','pre-review')])}};
  await client.callTool({name:'submit_subagent',arguments:input});
  await new Promise(r=>setTimeout(r,20));
  const status=parsed(await client.callTool({name:'get_subagent_status',arguments:{requestId:input.requestId}}));
  assert.ok(status.task.waitReasons.includes('dependency'));assert.equal(status.task.queueTimeoutSeconds,1);assert.equal(status.task.executionTimeoutSeconds,2);assert.ok(status.task.queueDeadlineAt);
  await new Promise(r=>setTimeout(r,1100));
  const done=parsed(await client.callTool({name:'get_subagent_status',arguments:{requestId:input.requestId}}));
  assert.equal(done.task.state,'failed');assert.equal(done.task.startedAt,null);assert.equal(done.task.executionMs,0);assert.ok(done.task.queueWaitMs>=900);
 });
});

test('gateway requires bearer auth and exposes only governed MCP tools', async () => {
  await withGateway(async ({ client, port }) => {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/readyz`)).json(), { ok: true, service: 'pi-kether-gateway' });
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
      'cancel_subagent', 'dispatch_subagent', 'get_subagent_result', 'get_subagent_status', 'get_workflow', 'list_capabilities', 'list_subagents',
      'lsp_request', 'probe_model', 'render_subagent_monitor', 'renew_claude_auth', 'submit_subagent',
    ]);
    const caps = parsed(await client.callTool({ name: 'list_capabilities', arguments: {} }));
    assert.equal(caps.writeEnabled, true);
    assert.equal(caps.resourceLimits.enforced, true);
    assert.equal(caps.resourceLimits.defaultProfile, 'standard');
    assert.equal(caps.resourceLimits.profiles.standard.memoryMiB, 3072);
  });
});

test('monitor resource and render tool expose a structured inline card payload', async () => {
  await withGateway(async ({ client }) => {
    const resources = await client.listResources();
    assert.equal(resources.resources.some(resource => resource.uri === 'ui://pi-kether/subagent-monitor.html'), true);
    const resource = await client.readResource({ uri: 'ui://pi-kether/subagent-monitor.html' });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.contents[0].text, /Pi 子 Agent 监控/);
    const rendered = await client.callTool({ name: 'render_subagent_monitor', arguments: { parentRunId: 'run-card' } });
    assert.equal(rendered.structuredContent.ok, true);
    assert.equal(rendered.structuredContent.parentRunId, 'run-card');
    assert.deepEqual(rendered.structuredContent.tasks, []);
  });
});

test('asynchronous subagent submission exposes running, completed, list, and cancel states', async () => {
  let releaseFirst;
  const dispatchFn = async (request, signal, task) => {
    if (task.objective === 'complete later') await new Promise(resolvePromise => { releaseFirst = resolvePromise; });
    else await new Promise((resolvePromise, rejectPromise) => signal.addEventListener('abort', () => rejectPromise(new Error('aborted')), { once: true }));
    return { ok: true, text: formattedTaskResult(task), provider: request.provider, model: request.model, toolsUsed: [], toolErrors: 0, usage: { totalTokens: 7 } };
  };
  await withGateway(async ({ client }) => {
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'read', resourceProfile: 'small', timeoutSeconds: 5, parentRunId: 'run-monitor' };
    const first = await client.callTool({ name: 'submit_subagent', arguments: { ...common, requestId: 'async-complete', task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'complete later', readScope: ['package.json'] } } });
    assert.equal(first.structuredContent.accepted, true);
    while (!releaseFirst) await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    const running = await client.callTool({ name: 'get_subagent_status', arguments: { requestId: 'async-complete' } });
    assert.equal(running.structuredContent.task.state, 'running');
    const pendingResult = parsed(await client.callTool({name:'get_subagent_result',arguments:{requestId:'async-complete'}}));
    assert.equal(pendingResult.ready,false);
    releaseFirst();
    let completed;
    for (let i = 0; i < 50; i += 1) {
      completed = (await client.callTool({ name: 'get_subagent_status', arguments: { requestId: 'async-complete' } })).structuredContent.task;
      if (completed.state === 'completed') break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    }
    assert.equal(completed.state, 'completed');
    assert.equal(completed.actualProvider, 'openai-codex');
    assert.equal(completed.outcome.tokens.totalTokens, 7);
    const fullResult = parsed(await client.callTool({name:'get_subagent_result',arguments:{requestId:'async-complete'}}));
    assert.equal(fullResult.ready,true);
    assert.equal(fullResult.state,'completed');
    assert.equal(fullResult.result.ok,true);
    assert.equal(fullResult.result.model,'gpt-5.6-luna');
    assert.ok(fullResult.result.structuredResult);
    const unknownResult = parsed(await client.callTool({name:'get_subagent_result',arguments:{requestId:'unknown-request'}}));
    assert.equal(unknownResult.code,'RESULT_NOT_FOUND');

    await client.callTool({ name: 'submit_subagent', arguments: { ...common, model: 'gpt-5.6-luna', requestId: 'async-cancel', task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'wait for cancel', readScope: ['package.json'] } } });
    let cancellable;
    for (let i = 0; i < 50; i += 1) {
      cancellable = (await client.callTool({ name: 'get_subagent_status', arguments: { requestId: 'async-cancel' } })).structuredContent.task;
      if (cancellable.state === 'running') break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    }
    const cancellation = await client.callTool({ name: 'cancel_subagent', arguments: { requestId: 'async-cancel' } });
    assert.equal(cancellation.structuredContent.accepted, true);
    let cancelled;
    for (let i = 0; i < 50; i += 1) {
      cancelled = (await client.callTool({ name: 'get_subagent_status', arguments: { requestId: 'async-cancel' } })).structuredContent.task;
      if (cancelled.state === 'cancelled') break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    }
    assert.equal(cancelled.state, 'cancelled');
    const listed = await client.callTool({ name: 'list_subagents', arguments: { parentRunId: 'run-monitor' } });
    assert.deepEqual(new Set(listed.structuredContent.tasks.map(task => task.state)), new Set(['completed', 'cancelled']));
  }, { dispatchFn });
});

test('verified WSL sandbox enables workspace-write capability', () => {
  const runtime = createGatewayRuntime({
    roots: [root],
    sandboxStatus: verifiedSandbox,
  });
  const caps = runtime.capabilities();
  assert.equal(caps.writeEnabled, true);
  assert.equal(caps.osSandbox, 'wsl2-bwrap');
  assert.deepEqual(caps.access, ['none', 'read', 'workspace-write']);
  assert.equal(caps.sandbox.hostMountVisible, false);
  assert.equal(caps.writeScopeEnforced, true);
  assert.equal(caps.writeScopeSyntax.directoryTree, 'path/to/directory/**');
  assert.equal(caps.writeScopeSyntax.shellWrites, false);
  assert.equal(caps.resourceLimits.enforced, true);
});

test('dispatch fails closed when kernel resource isolation is unavailable', async () => {
  let dispatched = false;
  await withGateway(async ({ client }) => {
    const result = await client.callTool({ name: 'dispatch_subagent', arguments: {
      cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'read',
      task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Must not run.', readScope: ['package.json'] },
    } });
    assert.equal(result.isError, true);
    assert.match(parsed(result).error, /resource isolation is unavailable/);
    assert.equal(dispatched, false);
  }, { sandboxStatus: { ok: false, backend: 'unavailable', resourceLimits: false }, dispatchFn: async () => { dispatched = true; } });
});

test('HTTP auth runs before bounded JSON parsing, including chunked bodies', async () => {
  await withGateway(async ({ port }) => {
    const oversized = '"' + 'x'.repeat(110 * 1024) + '"';
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
    assert.equal(unauthorized.status, 401);
    const status = await new Promise((resolvePromise, rejectPromise) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
        res.resume();
        res.on('end', () => resolvePromise(res.statusCode));
      });
      req.on('error', rejectPromise);
      req.write(oversized.slice(0, 50 * 1024));
      req.end(oversized.slice(50 * 1024));
    });
    assert.equal(status, 413);
  });
});

test('gateway preserves Tifereth trace ids and reports the enforced resource profile', async () => {
  await withGateway(async ({ client }) => {
    const task = { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Inspect package metadata.', readScope: ['package.json'], forbidden: ['Do not modify files'], acceptance: ['Return an observation'] };
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', timeoutSeconds: 5, task, requestId: 'req-1', parentRunId: 'tifereth-1' };
    const readResult = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...common, access: 'read' } }));
    assert.equal(readResult.ok, true);
    assert.equal(readResult.requestId, 'req-1');
    assert.equal(readResult.parentRunId, 'tifereth-1');
    assert.equal(readResult.writeScopeEnforced, false);
    assert.equal(readResult.resourceLimits.profile, 'standard');
    assert.equal(readResult.resourceLimits.timeoutSeconds, 5);
    assert.equal(readResult.formatValidation.ok, true);
    assert.equal(readResult.structuredResult.status, 'completed');
    const writeResult = await client.callTool({ name: 'dispatch_subagent', arguments: { ...common, access: 'workspace-write', task: { ...task, writeScope: ['package.json'] } } });
    assert.equal(writeResult.isError, false);
    assert.equal(parsed(writeResult).writeScopeEnforced, true);
  });
});

test('workspace-write requires requestId and replays one durable result without redispatch', async () => {
  let dispatchCount = 0;
  const records = [];
  const dispatchFn = async (request, _signal, task) => {
    dispatchCount++;
    return { ok: true, text: formattedTaskResult(task), provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0, patch: 'safe patch' };
  };
  await withGateway(async ({ client }) => {
    const task = { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Prepare one scoped change.', readScope: ['package.json'], writeScope: ['package.json'] };
    const base = { cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'workspace-write', timeoutSeconds: 5, task };
    const missing = await client.callTool({ name: 'dispatch_subagent', arguments: base });
    assert.equal(missing.isError, true);
    assert.match(parsed(missing).error, /stable requestId/);
    const first = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'write-idempotent-1' } }));
    const replay = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'write-idempotent-1' } }));
    assert.equal(dispatchCount, 1);
    assert.equal(first.idempotency.status, 'executed');
    assert.equal(replay.idempotency.status, 'replayed');
    assert.equal(replay.idempotency.source, 'persistent');
    assert.equal(replay.patch, first.patch);
    const conflict = await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'write-idempotent-1', task: { ...task, objective: 'Different change.' } } });
    assert.equal(conflict.isError, true);
    assert.equal(parsed(conflict).idempotency.status, 'idempotency_key_reused');
    assert.equal(dispatchCount, 1);
    assert.deepEqual(records.map(record => record.operation), ['dispatch_subagent', 'dispatch_subagent_replay', 'dispatch_subagent_idempotency']);
    assert.equal(records[2].failureReason, 'idempotency_key_reused');
  }, { dispatchFn, auditLogger: { enabled: true, record: value => records.push(value) } });
});

test('dependency-aware queue runs a prerequisite before its waiting dependent', async () => {
  const order = [];
  const dispatchFn = async (request, _signal, task) => {
    order.push(task.objective);
    return { ok: true, text: formattedTaskResult(task), provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0 };
  };
  await withGateway(async ({ client }) => {
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'read', resourceProfile: 'small', timeoutSeconds: 5,parentRunId:'dependency-run' };
    const dependent = client.callTool({ name: 'dispatch_subagent', arguments: { ...common, requestId: 'dep-b', priority: 9, dependsOnRequestIds: ['dep-a'], task: { role: 'Chochmah', acceptance: ['Return the requested observable result.'], objective: 'B', readScope: ['package.json'],handoff:handoff('planned',[ref('dep-a','Malkuth','scouted',resultDigest(roleValue('Malkuth','A')))]) } } });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    const prerequisite = client.callTool({ name: 'dispatch_subagent', arguments: { ...common, requestId: 'dep-a', priority: 1, task: { role: 'Malkuth', acceptance: ['Return the requested observable result.'], objective: 'A', readScope: ['package.json'],handoff:handoff('scouted') } } });
    const [a, b] = await Promise.all([prerequisite, dependent]);
    assert.equal(parsed(a).ok, true);
    assert.equal(parsed(b).ok, true);
    assert.deepEqual(order, ['A', 'B']);
  }, { dispatchFn });
});

test('overlapping write scopes are serialized across different requestIds', async () => {
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const dispatchFn = async (request, _signal, task) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (task.objective === 'first write') await new Promise(resolvePromise => { releaseFirst = resolvePromise; });
    active--;
    return { ok: true, text: formattedTaskResult(task), provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0, patch: 'safe patch' };
  };
  await withGateway(async ({ client }) => {
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'workspace-write', resourceProfile: 'small', timeoutSeconds: 5 };
    const first = client.callTool({ name: 'dispatch_subagent', arguments: { ...common, requestId: 'lock-one', task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'first write', readScope: ['package.json'], writeScope: ['package.json'] } } });
    while (!releaseFirst) await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    const second = client.callTool({ name: 'dispatch_subagent', arguments: { ...common, requestId: 'lock-two', task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'second write', readScope: ['package.json'], writeScope: ['package.json'] } } });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(maxActive, 1);
    releaseFirst();
    const results = await Promise.all([first, second]);
    assert.equal(results.every(result => parsed(result).ok), true);
    assert.equal(maxActive, 1);
  }, { dispatchFn });
});

test('dispatch_subagent marks failed execution as an MCP tool error', async () => {
  const dispatchFn = async request => ({ ok: false, failure: 'scope violation', provider: request.provider, model: request.model, toolsUsed: ['write'], toolErrors: 1 });
  const { app } = createGatewayApp({ host: '127.0.0.1', port: 0, roots: [root], token, dispatchFn, lspFn:async request=>({ok:true,toolsUsed:[{hover:'lsp_hover',diagnostics:'lsp_diagnostics'}[request.method]],result:{content:[]}}), sandboxStatus: verifiedSandbox, schedulerOptions: { availableMemoryBytes: () => Number.MAX_SAFE_INTEGER } });
  const http = await new Promise(resolvePromise => { const instance = app.listen(0, '127.0.0.1', () => resolvePromise(instance)); });
  const client = new Client({ name: 'gateway-failure-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'dispatch_subagent', arguments: { cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'read', timeoutSeconds: 5, task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Fail safely.', readScope: ['package.json'] } } });
    assert.equal(result.isError, true);
    assert.equal(parsed(result).ok, false);
  } finally {
    await client.close();
    await new Promise(resolvePromise => http.close(resolvePromise));
  }
});

test('dispatch_subagent rejects malformed lower-agent output without opening provider circuit', async () => {
  const circuitState = createMemoryProviderCircuitState();
  const dispatchFn = async request => ({ ok: true, text: 'unstructured prose', provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0 });
  await withGateway(async ({ client }) => {
    const result = await client.callTool({ name: 'dispatch_subagent', arguments: {
      cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'read', timeoutSeconds: 5,
      task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Return structured output.', readScope: ['package.json'] },
    } });
    const response = parsed(result);
    assert.equal(result.isError, true);
    assert.equal(response.formatValidation.code, 'missing_prefix');
    assert.match(response.failure, /result_format_invalid/);
    assert.equal(response.providerCircuit.state, 'closed');
    assert.equal(response.providerCircuit.consecutiveFailures, 0);
  }, { circuitState, dispatchFn });
});

test('gateway persists a sanitized audit record and generates requestId', async () => {
  const records = [];
  const auditLogger = { enabled: true, record: value => records.push(value) };
  const dispatchFn = async request => ({
    ok: false, failure: 'Bearer sensitive-token password=hidden', provider: request.provider,
    model: request.model, toolsUsed: ['read'], toolErrors: 1,
    usage: { input: 7, output: 3 }, patch: '--- a/private.txt\n+++ b/private.txt\n+secret body\n',
  });
  await withGateway(async ({ client }) => {
    const result = await client.callTool({ name: 'dispatch_subagent', arguments: {
      cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'read', timeoutSeconds: 5,
      task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Sensitive task text', readScope: ['package.json'] },
    } });
    const response = parsed(result);
    assert.equal(result.isError, true);
    assert.match(response.requestId, /^req-/);
    assert.equal(records.length, 1);
    assert.equal(records[0].requestId, response.requestId);
    assert.equal(records[0].route.actualProvider, 'openai-codex');
    assert.equal(records[0].tokens.totalTokens, 10);
    assert.equal(records[0].patch.fileCount, 1);
    assert.doesNotMatch(JSON.stringify(records[0]), /sensitive-token|password=hidden|Sensitive task text|private\.txt|secret body/);
  }, { auditLogger, dispatchFn });
});

test('probe_model always runs only when Tifereth explicitly requests it', async () => {
  let dispatchCount = 0;
  const circuitState = createMemoryProviderCircuitState();
  const dispatchFn = async (request, _signal, task) => {
    dispatchCount++;
    return { ok: true, text: task.objective, provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0, usage: { input: 2, output: 1, totalTokens: 3 } };
  };
  await withGateway(async ({ client }) => {
    const args = { cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', timeoutSeconds: 5 };
    const first = parsed(await client.callTool({ name: 'probe_model', arguments: { ...args, requestId: 'probe-one' } }));
    const second = parsed(await client.callTool({ name: 'probe_model', arguments: { ...args, requestId: 'probe-two' } }));
    assert.equal(first.heartbeat, 'passed');
    assert.equal(second.heartbeat, 'passed');
    assert.equal(dispatchCount, 2);
  }, { circuitState, dispatchFn, auditLogger: { enabled: true, record: () => {} } });
});

test('gateway authentication circuit requires one explicit recovery probe before tasks resume', async () => {
  let dispatchCount = 0;
  const circuitState = createMemoryProviderCircuitState();
  circuitState.record({ provider: 'openai-codex', model: 'gpt-5.6-luna', healthy: false, category: 'authentication' });
  const dispatchFn = async (request, _signal, task, options) => {
    dispatchCount++;
    return { ok: true, text: options?.resultFormat === 'plain' ? task.objective : formattedTaskResult(task), provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0 };
  };
  await withGateway(async ({ client }) => {
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-5.6-luna', timeoutSeconds: 5 };
    const task = { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Inspect health gate.', readScope: ['package.json'] };
    const disabled = await client.callTool({ name: 'dispatch_subagent', arguments: { ...common, access: 'read', task } });
    assert.equal(disabled.isError, true);
    assert.match(parsed(disabled).error, /repair login/);
    assert.equal(dispatchCount, 0);
    const ordinaryProbe = await client.callTool({ name: 'probe_model', arguments: common });
    assert.equal(ordinaryProbe.isError, true);
    assert.match(parsed(ordinaryProbe).error, /recovery=true/);
    assert.equal(dispatchCount, 0);
    const probe = parsed(await client.callTool({ name: 'probe_model', arguments: { ...common, recovery: true } }));
    assert.equal(probe.heartbeat, 'passed');
    const accepted = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...common, access: 'read', task } }));
    assert.equal(accepted.ok, true);
    assert.equal(dispatchCount, 2);
  }, { circuitState, dispatchFn, auditLogger: { enabled: true, record: () => {} } });
});

test('LSP file stays inside selected cwd and exact requested tool is verified', async () => {
  assert.equal(resolveAllowedCwd(root, [root]), root);
  assert.equal(resolveAllowedFile('fixture.mjs', testsDir), resolve(testsDir, 'fixture.mjs'));
  assert.throws(() => resolveAllowedFile('../package.json', testsDir), /outside/);
  await withGateway(async ({ client }) => {
    const result = parsed(await client.callTool({ name: 'lsp_request', arguments: { cwd: testsDir, provider: 'openai-codex', model: 'gpt-5.6-luna', timeoutSeconds: 5, method: 'hover', query:'fixture', file: 'fixture.mjs', requestId: 'lsp-1' } }));
    assert.equal(result.ok, true);
    assert.equal(result.requestedTool, 'lsp_hover');
    assert.deepEqual(result.toolsUsed, ['lsp_hover']);
    assert.equal(result.requestId, 'lsp-1');
  });
});

test('rejected LSP path is audited without persisting the path', async () => {
  const records = [];
  await withGateway(async ({ client }) => {
    const result = await client.callTool({ name: 'lsp_request', arguments: {
      cwd: testsDir, provider: 'openai-codex', model: 'gpt-5.6-luna', timeoutSeconds: 5,
      method: 'hover', file: '../package.json', requestId: 'lsp-rejected-1',
    } });
    assert.equal(result.isError, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].requestId, 'lsp-rejected-1');
    assert.equal(records[0].envelope.present, false);
    assert.doesNotMatch(JSON.stringify(records[0]), /\.\.\/package\.json/);
  }, { auditLogger: { enabled: true, record: value => records.push(value) } });
});

test('bounded executor enforces queue capacity and cancels active work on timeout', async () => {
  assert.throws(() => new BoundedExecutor(5, 1), /1 to 4/);
  const executor = new BoundedExecutor(1, 1);
  let release;
  const first = executor.run(signal => new Promise(resolvePromise => {
    release = resolvePromise;
    signal.addEventListener('abort', () => resolvePromise('aborted'), { once: true });
  }), 50);
  const second = executor.run(async () => 'second', 500);
  await assert.rejects(executor.run(async () => 'third', 500), /queue is full/);
  await assert.rejects(first, e=>e.code==='EXECUTION_TIMEOUT');
  assert.equal(await second, 'second');
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(executor.state.active, 0);
  assert.equal(executor.state.queued, 0);
  assert.equal(executor.state.maxConcurrency, 1);
  assert.equal(executor.state.maxQueue, 1);
});

test('queued cancellation removes work before it can start', async () => {
  const executor = new BoundedExecutor(1, 1);
  let release;
  let queuedStarted = false;
  const first = executor.run(() => new Promise(resolvePromise => { release = resolvePromise; }), 500);
  const controller = new AbortController();
  const second = executor.run(async () => { queuedStarted = true; }, 500, controller.signal);
  controller.abort();
  await assert.rejects(second, /cancelled while queued/);
  release('done');
  await first;
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(queuedStarted, false);
  assert.equal(executor.state.queued, 0);
});

 test('direct LSP needs no provider or model and never calls model dispatch',async()=>{
  let calls=0;
  await withGateway(async({client})=>{
    const result=parsed(await client.callTool({name:'lsp_request',arguments:{cwd:testsDir,method:'diagnostics',file:'fixture.mjs',timeoutSeconds:5}}));
    assert.equal(result.ok,true);assert.equal(result.modelCalls,0);assert.equal(result.model,null);assert.equal(result.executionMode,'direct');assert.equal(calls,0);
    const bad=parsed(await client.callTool({name:'lsp_request',arguments:{cwd:testsDir,method:'hover',file:'fixture.mjs'}}));
    assert.equal(bad.ok,false);assert.match(bad.error,/line\/character/);
  },{dispatchFn:()=>{calls++;throw new Error('model dispatch forbidden');}});
 });
 test('direct LSP rejects unavailable sandbox before execution',async()=>{
  await withGateway(async({client})=>{
    const result=parsed(await client.callTool({name:'lsp_request',arguments:{cwd:testsDir,method:'diagnostics',file:'fixture.mjs'}}));
    assert.equal(result.ok,false);assert.match(result.error,/sandbox/);
  },{sandboxStatus:{ok:false},lspFn:()=>{throw new Error('must not launch');}});
 });

 test('auth renewal tool uses host maintenance only and does not clear circuit',async()=>{
  const circuitState=createMemoryProviderCircuitState();
  circuitState.record({provider:'pi-claude-code-provider',model:'claude-sonnet-5',healthy:false,category:'authentication'});
  await withGateway(async({client})=>{
   const result=parsed(await client.callTool({name:'renew_claude_auth',arguments:{}}));
   assert.equal(result.ok,true);assert.equal(result.modelCalls,0);assert.equal(result.recoveryProbeRequired,true);
   assert.throws(()=>circuitState.assertTaskAllowed('pi-claude-code-provider','claude-sonnet-5'));
  },{circuitState,renewAuthFn:async()=>({ok:true,status:'renewed'}),dispatchFn:()=>{throw new Error('must not dispatch');}});
 });


test('gateway preserves observed phase timings when execution times out', async () => {
 const observed={authenticationMs:2,startupMs:5,timeToFirstResponseMs:9,generationMs:null};
 const dispatchFn=async(_request,signal,_task,options)=>{
  options.onProgress(observed);
  await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
 };
 await withGateway(async({client})=>{
  const response=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-5.6-luna',access:'none',timeoutSeconds:1,resourceProfile:'small',task:{role:'worker',objective:'Controlled timeout',acceptance:['Timeout retains measured phases']}}}));
  assert.equal(response.code,'EXECUTION_TIMEOUT');
  assert.deepEqual(response.phaseTimings,observed);
 },{dispatchFn});
});
