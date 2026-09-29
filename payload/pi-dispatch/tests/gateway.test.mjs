import {roleValue,handoff,ref} from './contract-fixtures.mjs';
import {listenHttpFixture} from './http-fixture.mjs';
import {resultDigest} from '../extensions/role-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BoundedExecutor, createGatewayApp, createGatewayRuntime, registerMcpResponseCleanup, resolveAllowedCwd, resolveAllowedFile } from '../scripts/gateway.mjs';
import { createMemoryProviderCircuitState } from '../extensions/provider-circuit-state.js';
import { parseProbeArgs } from '../scripts/gateway-client.mjs';
import { trustedPatchProof } from '../scripts/gateway.mjs';
import { compileWriteScope } from '../extensions/write-scope-guard.js';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = resolve(root, 'tests');
const token = 'test-token-0123456789-0123456789-abcdef';
const verifiedSandbox = { ok: true, backend: 'wsl2-bwrap', hostMountVisible: false, windowsInterop: false, bubblewrap: true, pi: true, resourceLimits: true };
const execFileAsync=promisify(execFile);

test('trusted sandbox patch proof binds request, job, patch hash, scope, and in-scope changed files', () => {
  const patch = '--- /var/lib/pi-kether/jobs/11111111-1111-4111-8111-111111111111/baseline/a.js\n+++ /var/lib/pi-kether/jobs/11111111-1111-4111-8111-111111111111/workspace/a.js\n@@ -0,0 +1 @@\n+ok\n';
  const scope = ['a.js'];
  const canonical = compileWriteScope(scope).map(item => `${item.tree ? 'tree' : 'file'}:${item.path}`).sort().join('\\n');
  const proof = { ok:true, requestId:'trusted-request', jobId:'11111111-1111-4111-8111-111111111111', changedFiles:['a.js'], patchSha256:createHash('sha256').update(patch,'utf8').digest('hex'), scopeSha256:createHash('sha256').update(canonical,'utf8').digest('hex') };
  const response = { patch, patchValidation:proof };
  assert.equal(trustedPatchProof(response,'trusted-request',scope),true);
  assert.equal(trustedPatchProof(response,'stale-request',scope),false);
  assert.equal(trustedPatchProof({...response,patch:patch+'tamper'},'trusted-request',scope),false);
  assert.equal(trustedPatchProof(response,'trusted-request',['other.js']),false);
  assert.equal(trustedPatchProof({...response,patchValidation:{...proof,jobId:'bad'}},'trusted-request',scope),false);
  assert.equal(trustedPatchProof({...response,patchValidation:{...proof,changedFiles:['outside.js']}},'trusted-request',scope),false);
  assert.equal(trustedPatchProof({...response,patchValidation:{...proof,changedFiles:[]}},'trusted-request',scope),false);
  assert.equal(trustedPatchProof({...response,patchValidation:{...proof,changedFiles:['other.js']}},'trusted-request',scope),false);
  const otherJob = '22222222-2222-4222-8222-222222222222';
  const mismatchedHeaderPatch = patch.replaceAll(proof.jobId, otherJob);
  assert.equal(trustedPatchProof({...response,patch:mismatchedHeaderPatch,patchValidation:{...proof,patchSha256:createHash('sha256').update(mismatchedHeaderPatch,'utf8').digest('hex')}},'trusted-request',scope),false);
});

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

async function receiptFor(client,topic){
  return parsed(await client.callTool({name:'get_workflow',arguments:{topic}})).receipt;
}

function declaredT1(files = ['package.json']) {
  return { tier: 'T1', tierDeclaration: {
    files, estimatedLines: 1, isTestOrConfigChange: true,
    publicApiOrProtocol: false, dependencyOrLockfile: false, securityAuthOrCredentials: false,
    migration: false, irreversibleOrNoRollback: false, uncertainFileScope: false,
  } };
}

test('topic gate blocks omitted and mismatched receipts before write dispatch or submission',async()=>{
  let calls=0;const records=[];
  await withGateway(async({client})=>{
    const task={role:'worker',objective:'Scoped fixture change',acceptance:['Return result'],readScope:['package.json'],writeScope:['package.json']};
    const base={cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId:'workflow-write',...declaredT1(),task};
    const omitted=parsed(await client.callTool({name:'dispatch_subagent',arguments:base}));
    assert.equal(omitted.code,'WORKFLOW_TOPIC_REQUIRED');assert.match(omitted.error,/get_workflow.*task-tiers/);
    const wrong=await receiptFor(client,'pi-routing');
    assert.equal(parsed(await client.callTool({name:'dispatch_subagent',arguments:{...base,workflowReceipt:wrong}})).code,'WORKFLOW_TOPIC_REQUIRED');
    assert.equal(parsed(await client.callTool({name:'submit_subagent',arguments:{...base,workflowReceipt:wrong}})).code,'WORKFLOW_TOPIC_REQUIRED');
    assert.equal(calls,0);
    const correct=await receiptFor(client,'task-tiers');
    const accepted=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...base,workflowReceipt:correct}}));
    assert.equal(accepted.ok,true);assert.equal(calls,1);
    assert.ok(records.some(record=>record.operation==='workflow_topic_required'&&record.topic==='task-tiers'));
    assert.ok(records.some(record=>record.operation==='get_workflow'&&record.topic==='task-tiers'));
    assert.ok(records.some(record=>record.operation==='workflow_topic_admitted'&&record.topic==='task-tiers'));
    assert.equal(records.some(record=>JSON.stringify(record).includes(correct)),false);
  },{dispatchFn:async(request,_signal,task)=>{calls++;return {ok:true,provider:request.provider,model:request.model,text:formattedTaskResult(task)};},auditLogger:{enabled:true,record:value=>records.push(value)}});
});

test('gateway tier gate rejects missing, understated and standalone T2 writes before dispatch', async () => {
  let calls = 0;
  await withGateway(async ({ client }) => {
    const workflowReceipt = await receiptFor(client, 'task-tiers');
    const task = { role: 'worker', objective: 'Change a test fixture', acceptance: ['Return result'], readScope: ['package.json'], writeScope: ['package.json'] };
    const base = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'workspace-write', workflowReceipt, task };
    const missing = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'tier-missing' } }));
    assert.equal(missing.code, 'WORKFLOW_TIER_REQUIRED');
    const asyncMissing = parsed(await client.callTool({ name: 'submit_subagent', arguments: { ...base, requestId: 'tier-async-missing' } }));
    assert.equal(asyncMissing.code, 'WORKFLOW_TIER_REQUIRED');
    const understated = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'tier-understated', ...declaredT1(), tier: 'T0' } }));
    assert.equal(understated.code, 'WORKFLOW_TIER_INVALID');
    const standaloneT2 = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: {
      ...base, requestId: 'tier-standalone-t2', ...declaredT1(), tier: 'T2',
      tierDeclaration: { ...declaredT1().tierDeclaration, publicApiOrProtocol: true },
    } }));
    assert.equal(standaloneT2.code, 'WORKFLOW_TIER_PRE_REVIEW_REQUIRED');
    assert.equal(calls, 0);
    const admitted = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'tier-valid-t1', ...declaredT1() } }));
    assert.equal(admitted.ok, true);
    assert.equal(admitted.tier, 'T1');
    assert.equal(admitted.reviewPending, true);
    assert.equal(admitted.contract.tier, 'T1');
    assert.equal(calls, 1);
  }, { dispatchFn: async (request, _signal, task) => {
    calls++;
    return { ok: true, provider: request.provider, model: request.model, text: formattedTaskResult(task) };
  } });
});

test('gateway rejects a T0 worker patch that exceeds 20 changed lines', async () => {
  const oversizedPatch = `diff -ruN a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -0,0 +1,21 @@\n${Array.from({ length: 21 }, (_, i) => `+line-${i}`).join('\n')}\n`;
  await withGateway(async ({ client }) => {
    const workflowReceipt = await receiptFor(client, 'task-tiers');
    const result = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: {
      cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'workspace-write', requestId: 'tier-t0-overflow', workflowReceipt,
      tier: 'T0', tierDeclaration: { ...declaredT1().tierDeclaration, estimatedLines: 20, isTestOrConfigChange: false },
      task: { role: 'worker', objective: 'One bounded file change', acceptance: ['Return result'], readScope: ['package.json'], writeScope: ['package.json'] },
    } }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WORKFLOW_TIER_EXCEEDED');
    assert.equal(result.contract, undefined);
  }, { dispatchFn: async (request, _signal, task) => ({ ok: true, provider: request.provider, model: request.model, text: formattedTaskResult(task), patch: oversizedPatch }) });
});

test('gateway CLI fetches the write topic before submitting a scoped request',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'yhwh-cli-write-'));
  try{
    await withGateway(async({port})=>{
      const config=join(directory,'gateway.json'),tokenFile=join(directory,'token'),requestFile=join(directory,'request.json');
      writeFileSync(tokenFile,token);
      writeFileSync(config,JSON.stringify({host:'127.0.0.1',port,tokenFile}));
      writeFileSync(requestFile,JSON.stringify({cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId:'cli-write-receipt',...declaredT1(),task:{role:'worker',objective:'Prepare scoped fixture change',acceptance:['Return result'],readScope:['package.json'],writeScope:['package.json']}}));
      const {stdout}=await execFileAsync(process.execPath,[resolve(root,'scripts/gateway-client.mjs'),'dispatch',requestFile],{env:{...process.env,PI_GATEWAY_CONFIG:config},timeout:15000,windowsHide:true});
      assert.equal(JSON.parse(stdout).ok,true);
    });
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('typed failed/unverified outputs and type errors cannot produce successful outcomes or contracts', async()=>{
  let mode='failed';
  await withGateway(async({client})=>{
    for (const status of ['failed','blocked','unverified','wrong-type']) {
      mode=status;
      const result=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',requestId:`typed-${status}`,access:'none',resourceProfile:'small',task:{role:'worker',objective:'Controlled negative fixture',acceptance:['Report the actual fixture outcome']}}}));
      assert.equal(result.ok,false,status);assert.equal(result.contract,undefined,status);
      if (status==='wrong-type') assert.equal(result.roleValidation.ok,false);
      else {assert.equal(result.roleValidation.ok,true);assert.equal(result.status,status);}
    }
    const stripped=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'none',task:{role:'worker',objective:'Strip fields',acceptance:['Must block'],returnFields:['result']}}}));
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
  const input={cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'none',requestId:'editor-parent',parentRunId:'editor-run',resourceProfile:'small',task:{role:'worker',objective:'Execute exact authorized read',acceptance:['Read the scene']},editorAuthorization:{version:1,expiresAt:new Date(Date.now()+60000).toISOString(),operations:[{id:'read',editor:'blender',tool:'blender_scene_info',args:{}}]}};
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
    const common={cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'none',resourceProfile:'small',parentRunId:'typed-run',timeoutSeconds:5};
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
    const review=await run('typed-review','Geburah','pre-review',[planRef],{provider:'anthropic',model:'claude-sonnet-5'});assert.equal(review.ok,true);
    const reviewRef=ref('typed-review','Geburah','pre-review',review.contract.resultSha256);
    const worker=await run('typed-worker','Chesed','implementing',[reviewRef]);assert.equal(worker.ok,true);
    const replay=await run('typed-worker','Chesed','implementing',[reviewRef]);assert.equal(replay.idempotency.status,'replayed');assert.equal(invoked.length,4);
    const conflict=await run('typed-worker','Chesed','implementing',[reviewRef],{priority:8});assert.equal(conflict.ok,false);assert.equal(invoked.length,4);
    rejectReview=true;
    const rejected=await run('typed-review-reject','Geburah','pre-review',[planRef],{provider:'anthropic',model:'claude-sonnet-5'});assert.equal(rejected.ok,false);
    const blocked=await run('typed-blocked','Chesed','implementing',[ref('typed-review-reject','Geburah','pre-review')]);assert.equal(blocked.ok,false);assert.match(blocked.error,/dependency failed/);assert.equal(invoked.length,5);
  },{dispatchFn:async(request,_signal,task,options)=>{
    invoked.push({role:task.role,upstream:options.upstreamResults});
    const value=roleValue(task.role,task.objective);if(task.role==='Geburah'&&rejectReview)value.reviewDecision='request-changes';
    return {ok:true,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value)};
  }});
});

test('gateway admits the bounded Claude CLI reviewer route and trusted recovery probe without WSL', async () => {
  const records = [];
  let calls = 0;
  await withGateway(async ({ client }) => {
    const reviewPacket = { version: 1, stage: 'post-change', ...Object.fromEntries(['requirements','changes','context','verification'].map(key => [key, { status: 'provided', content: [`Observed ${key}`] }])) };
    const reviewerTask = { role: 'Geburah', objective: 'Review fixture', acceptance: ['Return an approval decision'], reviewPacket };
    const accepted = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { cwd: root, provider: 'claude-code-cli', model: 'claude-sonnet-5', access: 'none', task: reviewerTask } }));
    assert.equal(accepted.ok, true);
    assert.equal(accepted.reviewValidation.approved, true);
    assert.equal(accepted.runtime, 'host-cli');
    assert.equal(accepted.osSandbox, 'none');
    assert.ok(records.some(record => record.outcome === 'completed' && record.operation === 'dispatch_subagent'));
    for (const args of [
      { cwd: root, provider: 'claude-code-cli', model: 'claude-sonnet-5', access: 'read', task: reviewerTask },
      { cwd: root, provider: 'claude-code-cli', model: 'wrong-model', access: 'none', task: reviewerTask },
      { cwd: root, provider: 'claude-code-cli', model: 'claude-sonnet-5', access: 'none', task: { ...reviewerTask, role: 'Chesed' } },
    ]) assert.equal(parsed(await client.callTool({ name: 'dispatch_subagent', arguments: args })).ok, false);
    const probe = parsed(await client.callTool({ name: 'probe_model', arguments: { cwd: root, provider: 'claude-code-cli', model: 'claude-sonnet-5' } }));
    assert.equal(probe.heartbeat, 'passed');
    assert.equal(probe.osSandbox, 'none');
    const api = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { cwd: root, provider: 'yhwh-worker-api', model: 'gpt-6-luna', access: 'none', task: { role: 'Chesed', objective: 'Blocked without WSL', acceptance: ['Return result'] } } }));
    assert.equal(api.ok, false);
    assert.match(api.error, /resource isolation is unavailable/);
  }, { sandboxStatus: { ok: false, backend: 'unavailable', resourceLimits: false }, auditLogger: { enabled: true, record: value => records.push(value) }, dispatchFn: async (request, _signal, task, options) => {
    calls++;
    const value = roleValue(task.role, task.objective);
    return { ok: true, provider: request.provider, model: request.model, ...(request.provider === 'claude-code-cli' ? { runtime: 'host-cli', osSandbox: 'none' } : {}), text: options?.resultFormat === 'plain' ? task.objective : 'KETHER_RESULT_JSON=' + JSON.stringify(value), toolsUsed: [] };
  } });
  assert.equal(calls, 2);
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
  const http = await listenHttpFixture(app);
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

test('host upgrade maintenance requires authentication and closes admission until resumed', async () => {
  await withGateway(async ({ port, client }) => {
    const base = `http://127.0.0.1:${port}`;
    const post = (action, extra = {}) => fetch(`${base}/admin/upgrade/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, ...extra });
    const identity = await (await post('status')).json(); assert.equal(identity.pid, process.pid); assert.equal(identity.phase, 'running');
    assert.equal((await post('pause', { headers: {} })).status, 401);
    assert.equal((await post('pause', { body: 'body' })).status, 400);
    assert.equal((await post('pause', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.invalid' } })).status, 400);
    assert.equal((await post('unknown')).status, 409);
    const paused = await post('pause'); assert.equal(paused.status, 200); assert.equal((await paused.json()).pid, process.pid);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await (await post('status')).json()).phase, 'maintenance');
    assert.equal((await post('pause')).status, 409);
    const r = parsed(await client.callTool({ name: 'list_capabilities', arguments: {} }));
    assert.equal(r.accepting, false);
    assert.equal((await post('resume')).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  });
});

test('gateway rejects incomplete governance contracts before model execution', async () => {
  let dispatched = 0;
  await withGateway(async ({client}) => {
    for (const task of [
      {role:'worker',objective:'Inspect file',readScope:['package.json']},
      {role:'worker',objective:'Inspect file',acceptance:['Report observed content']},
    ]) {
      const response=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'read',task}}));
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
 const base={cwd:root,provider:'anthropic',model:'claude-sonnet-5',access:'none',resourceProfile:'small',task};
 await withGateway(async({client})=>{
  const missing=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...base,task:{...task,reviewPacket:undefined}}}));
  assert.equal(missing.status,'blocked');assert.equal(missing.code,'REVIEW_MATERIALS_MISSING');assert.equal(calls,0);
  const rejected=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...base,requestId:'review-rejected'}}));
  assert.equal(rejected.ok,false);assert.equal(rejected.reviewValidation.decision,'request-changes');assert.equal(calls,1);
  const dependent=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'none',resourceProfile:'small',queueTimeoutSeconds:1,dependsOnRequestIds:['review-rejected'],task:{role:'worker',objective:'Must not run after failed review',acceptance:['Blocked']}}}));
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
  const input={cwd:root,provider:'openai-codex',model:'gpt-6-luna',requestId:'queue-reasons',parentRunId:'queue-reasons',access:'none',resourceProfile:'small',timeoutSeconds:2,queueTimeoutSeconds:1,dependsOnRequestIds:['pending-dependency'],task:{role:'worker',objective:'Wait for dependency',acceptance:['No dispatch'],handoff:handoff('implementing',[ref('pending-dependency','Geburah','pre-review')])}};
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
      'cancel_subagent', 'check_claude_auth', 'code_graph', 'dispatch_subagent', 'get_subagent_result', 'get_subagent_status', 'get_workflow', 'list_capabilities',
      'list_host_verification_pending', 'list_subagents', 'lsp_request', 'probe_model', 'project_memory', 'record_host_verification', 'render_subagent_monitor', 'submit_subagent',
    ]);
    const caps = parsed(await client.callTool({ name: 'list_capabilities', arguments: {} }));
    assert.equal(caps.writeEnabled, true);
    assert.equal(caps.resourceLimits.enforced, true);
    assert.equal(caps.resourceLimits.defaultProfile, 'standard');
    assert.equal(caps.resourceLimits.profiles.standard.memoryMiB, 3072);
  });
});

test('host verification is ledger-gated, durably completes the patch, and exposes a distinct waiting state', async () => {
  const jobId='11111111-1111-4111-8111-111111111111';
  const patchText=`--- /var/lib/pi-kether/jobs/${jobId}/baseline/package.json\n+++ /var/lib/pi-kether/jobs/${jobId}/workspace/package.json\n@@ -0,0 +1 @@\n+safe\n`;
  const scope=['package.json'];
  const canonical=compileWriteScope(scope).map(item=>`${item.tree?'tree':'file'}:${item.path}`).sort().join('\\n');
  const records=[];
  await withGateway(async({client})=>{
    const workflowReceipt=await receiptFor(client,'task-tiers');
    const task={role:'Chesed',objective:'Implement bounded change',acceptance:['Return verified evidence'],readScope:scope,writeScope:scope};
    const pending=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId:'host-e2e',...declaredT1(scope),workflowReceipt,task}}));
    assert.equal(pending.status,'awaiting-host-verification',JSON.stringify(pending));
    assert.equal(pending.ok,false);
    assert.deepEqual(pending.hostVerification.requiredCheckNames,['host npm test']);
    assert.equal(parsed(await client.callTool({name:'get_subagent_status',arguments:{requestId:'host-e2e'}})).task.state,'awaiting-host-verification');
    assert.equal(parsed(await client.callTool({name:'list_host_verification_pending',arguments:{}})).items.length,1);
    const receipt=await client.callTool({name:'record_host_verification',arguments:{requestId:'host-e2e',artifactSha256:pending.hostVerification.artifactSha256,commands:[{checkName:'host npm test',command:'npm test',exitCode:0,outputSummary:'All tests passed.'}],workflowReceipt}});
    assert.equal(parsed(receipt).state,'completed');
    const duplicate=parsed(await client.callTool({name:'record_host_verification',arguments:{requestId:'host-e2e',artifactSha256:pending.hostVerification.artifactSha256,commands:[{checkName:'host npm test',command:'npm test',exitCode:0,outputSummary:'All tests passed.'}],workflowReceipt}}));
    assert.equal(duplicate.recordSha256,parsed(receipt).recordSha256);
    assert.equal(parsed(await client.callTool({name:'get_subagent_status',arguments:{requestId:'host-e2e'}})).task.state,'completed');
    const result=parsed(await client.callTool({name:'get_subagent_result',arguments:{requestId:'host-e2e'}}));
    assert.equal(result.ok,true);
    assert.equal(result.result.ok,true);
    assert.equal(result.result.contract?.role,'Chesed',JSON.stringify(result));
    assert.equal(records.some(record=>record.operation==='record_host_verification'&&record.outcome==='completed'),true);
    const failedPending=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId:'host-fail',...declaredT1(scope),workflowReceipt,task}}));
    assert.equal(failedPending.status,'awaiting-host-verification');
    const failed=parsed(await client.callTool({name:'record_host_verification',arguments:{requestId:'host-fail',artifactSha256:failedPending.hostVerification.artifactSha256,commands:[{checkName:'host npm test',command:'npm test',exitCode:1,outputSummary:'Test failed.'}],workflowReceipt}}));
    assert.equal(failed.state,'failed');assert.equal(failed.outcome,'failed');
    const failedResult=parsed(await client.callTool({name:'get_subagent_result',arguments:{requestId:'host-fail'}}));
    assert.equal(failedResult.result.ok,false);assert.equal(failedResult.result.contract,undefined);
    const denied=await client.callTool({name:'record_host_verification',arguments:{requestId:'unknown-host-id',artifactSha256:'0'.repeat(64),commands:[{checkName:'host npm test',command:'npm test',exitCode:0,outputSummary:'ok'}]}});
    assert.equal(denied.isError,true);
  },{auditLogger:{enabled:true,record:value=>records.push(value)},dispatchFn:async(request,_signal,task)=>{
    const value=roleValue(task.role,task.objective);
    value.changedFiles=['package.json'];
    value.deliverable.checks=[{name:'host npm test',outcome:'unverified',evidence:'Host test command not run in worker; host is assigned to run verification.'}];
    const proof={ok:true,requestId:request.gatewayRequestId,jobId,changedFiles:['package.json'],patchSha256:createHash('sha256').update(patchText,'utf8').digest('hex'),scopeSha256:createHash('sha256').update(canonical,'utf8').digest('hex')};
    return {ok:true,requestId:request.gatewayRequestId,provider:request.provider,model:request.model,requestedProvider:request.provider,requestedModel:request.model,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value),patch:patchText,patchValidation:proof};
  }});
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
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'read', resourceProfile: 'small', timeoutSeconds: 5, parentRunId: 'run-monitor' };
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
    assert.equal(fullResult.result.model,'gpt-6-luna');
    assert.ok(fullResult.result.structuredResult);
    const unknownResult = parsed(await client.callTool({name:'get_subagent_result',arguments:{requestId:'unknown-request'}}));
    assert.equal(unknownResult.code,'RESULT_NOT_FOUND');

    await client.callTool({ name: 'submit_subagent', arguments: { ...common, model: 'gpt-6-luna', requestId: 'async-cancel', task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'wait for cancel', readScope: ['package.json'] } } });
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
      cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'read',
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
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', timeoutSeconds: 5, task, requestId: 'req-1', parentRunId: 'tifereth-1' };
    const readResult = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...common, access: 'read' } }));
    assert.equal(readResult.ok, true);
    assert.equal(readResult.requestId, 'req-1');
    assert.equal(readResult.parentRunId, 'tifereth-1');
    assert.equal(readResult.writeScopeEnforced, false);
    assert.equal(readResult.resourceLimits.profile, 'standard');
    assert.equal(readResult.resourceLimits.timeoutSeconds, 5);
    assert.equal(readResult.formatValidation.ok, true);
    assert.equal(readResult.structuredResult.status, 'completed');
    const workflowReceipt=await receiptFor(client,'task-tiers');
    const writeResult = await client.callTool({ name: 'dispatch_subagent', arguments: { ...common, access: 'workspace-write', workflowReceipt, ...declaredT1(), task: { ...task, writeScope: ['package.json'] } } });
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
    const workflowReceipt=await receiptFor(client,'task-tiers');
    const base = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'workspace-write', timeoutSeconds: 5, workflowReceipt, ...declaredT1(), task };
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
    assert.deepEqual(records.filter(record=>!['get_workflow','workflow_topic_admitted'].includes(record.operation)).map(record => record.operation), ['dispatch_subagent', 'dispatch_subagent_replay', 'dispatch_subagent_idempotency']);
    assert.equal(records.find(record=>record.operation==='dispatch_subagent_idempotency').failureReason, 'idempotency_key_reused');
  }, { dispatchFn, auditLogger: { enabled: true, record: value => records.push(value) } });
});

test('dependency-aware queue runs a prerequisite before its waiting dependent', async () => {
  const order = [];
  const dispatchFn = async (request, _signal, task) => {
    order.push(task.objective);
    return { ok: true, text: formattedTaskResult(task), provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0 };
  };
  await withGateway(async ({ client }) => {
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'read', resourceProfile: 'small', timeoutSeconds: 5,parentRunId:'dependency-run' };
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
    const workflowReceipt=await receiptFor(client,'task-tiers');
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'workspace-write', workflowReceipt, ...declaredT1(), resourceProfile: 'small', timeoutSeconds: 5 };
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

test('MCP dispatch recovers tool errors only with a completed result and trusted in-scope patch proof', async () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  const patch = `--- /var/lib/pi-kether/jobs/${jobId}/baseline/package.json\n+++ /var/lib/pi-kether/jobs/${jobId}/workspace/package.json\n@@ -0,0 +1 @@\n+safe\n`;
  const scope = ['package.json'];
  const canonical = compileWriteScope(scope).map(item => `${item.tree ? 'tree' : 'file'}:${item.path}`).sort().join('\\n');
  let variant = 'valid';
  await withGateway(async ({ client }) => {
    const workflowReceipt = await receiptFor(client, 'task-tiers');
    const base = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'workspace-write', workflowReceipt, ...declaredT1(scope), task: { role: 'Chesed', objective: 'Recover a tool error', acceptance: ['Return evidence'], readScope: scope, writeScope: scope } };
    const recovered = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'artifact-recovery' } }));
    assert.equal(recovered.ok, true);
    assert.equal(recovered.artifactRecovery, true);
    assert.equal(recovered.unrecoveredErrors, 0);
    assert.equal(recovered.recoveredErrors, 1);
    for (const id of ['artifact-transient-denied-attempt', 'artifact-outside', 'artifact-missing', 'artifact-invalid-result', 'artifact-blocked-result', 'artifact-malformed', 'artifact-no-proof', 'artifact-transport', 'artifact-nonzeroexit', 'artifact-agent-error', 'artifact-provider-mismatch', 'artifact-cleanup']) {
      variant = id;
      const response = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: id } }));
      assert.equal(response.ok, id === 'artifact-transient-denied-attempt', id);
      if (id === 'artifact-transient-denied-attempt') {
        assert.equal(response.artifactRecovery, true);
        assert.equal(response.toolErrors, 1);
        assert.equal(response.recoveredErrors, 1);
        assert.equal(response.unrecoveredErrors, 0);
      } else assert.equal(response.artifactRecovery, undefined, id);
    }
  }, { dispatchFn: async (request, _signal, task) => {
    const invalid = variant === 'artifact-invalid-result' || variant === 'artifact-blocked-result';
    const independentFailure = ['artifact-transport', 'artifact-nonzeroexit', 'artifact-agent-error', 'artifact-provider-mismatch', 'artifact-cleanup'].includes(variant);
    const candidatePatch = variant === 'artifact-missing' ? undefined : variant === 'artifact-outside' ? patch.replaceAll('/package.json', '/outside.js') : variant === 'artifact-malformed' ? 'not a unified patch' : patch;
    const canonicalScope = compileWriteScope(task.writeScope).map(item => `${item.tree ? 'tree' : 'file'}:${item.path}`).sort().join('\\n');
    const proof = { ok: true, requestId: request.gatewayRequestId, jobId, changedFiles: variant === 'artifact-outside' ? ['outside.js'] : ['package.json'], patchSha256: createHash('sha256').update(candidatePatch ?? '', 'utf8').digest('hex'), scopeSha256: createHash('sha256').update(canonicalScope, 'utf8').digest('hex') };
    return { ok: false, failure: independentFailure ? variant : 'Tool execution failed', provider: variant === 'artifact-provider-mismatch' ? 'other' : request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, text: 'KETHER_RESULT_JSON=' + JSON.stringify(invalid ? (variant === 'artifact-blocked-result' ? { ...roleValue(task.role, task.objective), status: 'blocked' } : { status: 'completed' }) : roleValue(task.role, task.objective)), toolErrors: 1, fileToolErrors: 1, unrecoveredErrors: 1, unrecoveredFileToolErrors: 1, recoverableToolFailure: !independentFailure, recoverableFileToolFailure: !independentFailure, ...(variant === 'artifact-transport' ? { transportError: true } : {}), ...(variant === 'artifact-nonzeroexit' ? { exitCode: 1 } : {}), ...(variant === 'artifact-agent-error' ? { agentError: true } : {}), ...(variant === 'artifact-cleanup' ? { cleanupError: true } : {}), patch: candidatePatch, patchValidation: variant === 'artifact-no-proof' ? undefined : proof };
  } });
});

test('dispatch_subagent marks failed execution as an MCP tool error', async () => {
  const dispatchFn = async request => ({ ok: false, failure: 'scope violation', provider: request.provider, model: request.model, toolsUsed: ['write'], toolErrors: 1 });
  const { app } = createGatewayApp({ host: '127.0.0.1', port: 0, roots: [root], token, dispatchFn, lspFn:async request=>({ok:true,toolsUsed:[{hover:'lsp_hover',diagnostics:'lsp_diagnostics'}[request.method]],result:{content:[]}}), sandboxStatus: verifiedSandbox, schedulerOptions: { availableMemoryBytes: () => Number.MAX_SAFE_INTEGER } });
  const http = await listenHttpFixture(app);
  const client = new Client({ name: 'gateway-failure-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'dispatch_subagent', arguments: { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'read', timeoutSeconds: 5, task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Fail safely.', readScope: ['package.json'] } } });
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
      cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'read', timeoutSeconds: 5,
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

test('dispatch_subagent recovers a short preface but rejects ambiguous envelopes', async () => {
  let mode = 'preface';
  const dispatchFn = async (request, _signal, task) => {
    const envelope = formattedTaskResult(task);
    const text = mode === 'preface'
      ? `Short preface.\n${envelope}`
      : mode === 'duplicate'
        ? `${envelope}\n${envelope}`
        : `${envelope} trailing prose`;
    return { ok: true, text, provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0 };
  };

  await withGateway(async ({ client }) => {
    const call = requestId => client.callTool({ name: 'dispatch_subagent', arguments: {
      cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'read', timeoutSeconds: 5, requestId,
      task: { role: 'worker', acceptance: ['Return the requested observable result.'], objective: 'Recover a prefaced envelope.', readScope: ['package.json'] },
    } });

    const recovered = parsed(await call('prefaced-envelope'));
    assert.equal(recovered.ok, true);
    assert.equal(recovered.formatValidation.ok, true);
    assert.ok(recovered.formatRecovery);
    assert.deepEqual(recovered.structuredResult, roleValue('worker', 'Recover a prefaced envelope.'));

    for (const [id, invalidMode] of [['duplicate-envelope', 'duplicate'], ['trailing-prose', 'trailing']]) {
      mode = invalidMode;
      const rejected = parsed(await call(id));
      assert.equal(rejected.ok, false);
      assert.equal(rejected.formatValidation.ok, false);
      assert.equal(rejected.contract, undefined);
      assert.equal(rejected.formatRecovery, undefined);
    }
  }, { dispatchFn });
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
      cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'read', timeoutSeconds: 5,
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

test('gateway client probe flag is opt-in and rejects invalid flags', () => {
  assert.deepEqual(parseProbeArgs(['provider', 'model']), { provider: 'provider', model: 'model', resourceProfile: 'standard', recovery: false });
  assert.deepEqual(parseProbeArgs(['provider', 'model', 'small', '--recovery']), { provider: 'provider', model: 'model', resourceProfile: 'small', recovery: true });
  assert.throws(() => parseProbeArgs(['provider', 'model', '--recovery', '--recovery']), /Duplicate/);
  assert.throws(() => parseProbeArgs(['provider', 'model', '--unknown']), /Unknown/);
  assert.throws(() => parseProbeArgs(['provider', 'model', 'small', 'extra']), /Invalid/);
});

test('probe_model always runs only when Tifereth explicitly requests it', async () => {
  let dispatchCount = 0;
  const circuitState = createMemoryProviderCircuitState();
  const dispatchFn = async (request, _signal, task) => {
    dispatchCount++;
    return { ok: true, text: task.objective, provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0, usage: { input: 2, output: 1, totalTokens: 3 } };
  };
  await withGateway(async ({ client }) => {
    const args = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', timeoutSeconds: 5 };
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
  circuitState.record({ provider: 'openai-codex', model: 'gpt-6-luna', healthy: false, category: 'authentication' });
  const dispatchFn = async (request, _signal, task, options) => {
    dispatchCount++;
    return { ok: true, text: options?.resultFormat === 'plain' ? task.objective : formattedTaskResult(task), provider: request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, toolsUsed: [], toolErrors: 0 };
  };
  await withGateway(async ({ client }) => {
    const common = { cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', timeoutSeconds: 5 };
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
    const result = parsed(await client.callTool({ name: 'lsp_request', arguments: { cwd: testsDir, provider: 'openai-codex', model: 'gpt-6-luna', timeoutSeconds: 5, method: 'hover', query:'fixture', file: 'fixture.mjs', requestId: 'lsp-1' } }));
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
      cwd: testsDir, provider: 'openai-codex', model: 'gpt-6-luna', timeoutSeconds: 5,
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

 test('API key check uses local validation only and does not clear circuit',async()=>{
  const circuitState=createMemoryProviderCircuitState();
  circuitState.record({provider:'anthropic',model:'claude-sonnet-5',healthy:false,category:'authentication'});
  await withGateway(async({client})=>{
   const result=parsed(await client.callTool({name:'check_claude_auth',arguments:{}}));
   assert.equal(result.ok,true);assert.equal(result.modelCalls,0);assert.equal(result.recoveryProbeRequired,true);
   assert.throws(()=>circuitState.assertTaskAllowed('anthropic','claude-sonnet-5'));
  },{circuitState,checkAuthFn:async()=>({ok:true,status:'configured'}),dispatchFn:()=>{throw new Error('must not dispatch');}});
 });


test('gateway preserves observed phase timings when execution times out', async () => {
 const observed={authenticationMs:2,startupMs:5,timeToFirstResponseMs:9,generationMs:null};
 const dispatchFn=async(_request,signal,_task,options)=>{
  options.onProgress(observed);
  await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
 };
 await withGateway(async({client})=>{
  const response=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'none',timeoutSeconds:1,resourceProfile:'small',task:{role:'worker',objective:'Controlled timeout',acceptance:['Timeout retains measured phases']}}}));
  assert.equal(response.code,'EXECUTION_TIMEOUT');
  assert.deepEqual(response.phaseTimings,observed);
 },{dispatchFn});
});
