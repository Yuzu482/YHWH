import {roleValue,handoff,ref} from './contract-fixtures.mjs';
import {listenHttpFixture} from './http-fixture.mjs';
import {resultDigest} from '../extensions/role-contract.js';
import {reviewBlockers} from '../scripts/tier-review-policy.mjs';
import {runAnchor,completedContract} from '../extensions/stage-handoff.js';
import {createRequestLedger} from '../extensions/request-ledger.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BoundedExecutor, createGatewayApp, createGatewayRuntime, registerMcpResponseCleanup, resolveAllowedCwd, resolveAllowedFile, resolveBoundHostEvidence } from '../scripts/gateway.mjs';
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

test('run anchor preserves canonical bytes and rejects malformed inputs', () => {
  assert.equal(runAnchor({runGoal:'runtime-golden',runAcceptance:['alpha','beta']}),'bce09b763afc13b87fd9135181af252dba86b1a65087fe50b4e875ceb4e6fedf');
  assert.equal(runAnchor({runGoal:'  Mixed-CaSe 中文 e\u0301  ',runAcceptance:[' Zeta ','é',' Alpha ','测试']}),'c919c9c83a11f7cb2a0f8885958fa90eabd16267a871d4d81d4bba607e2fe927');
  for (const value of [{runGoal:'',runAcceptance:['a']},{runGoal:'  ',runAcceptance:['a']},{runGoal:'g',runAcceptance:[]},{runGoal:'g',runAcceptance:['  ']},{runGoal:'g',runAcceptance:'a'}]) assert.throws(()=>runAnchor(value));
});

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

test('durable host attestation anchors linked v2 evidence to the recorded Chesed contract', async () => {
  const ledgerDir=mkdtempSync(join(tmpdir(),'pi-linked-anchor-ledger-'));
  const parentRunId='runtime-quality-20261001';
  const goal='Add cross-project runtime-code quality rules and safe readonly fixture snapshots/advisory preflight; deliver restricted-check design only, preserving isolation.';
  const acceptance=['Worker-authored scoped changes verified by primary host real checks and independent review.','Fixture reads remain readonly; escaped/sensitive paths fail; warnings advisory and auditable.','Restricted execution is design only and deployment waits for user decision.'];
  const preId='runtime-quality-20261001-scope-review-2';
  const preTask={role:'Geburah',objective:'Seed synthetic pre-review predecessor',acceptance:['Synthetic fixture only'],readScope:['tests/gateway.test.mjs'],writeScope:[],reviewPacket:{version:1,stage:'pre-change',requirements:{status:'provided',content:['Synthetic fixture']},changes:{status:'provided',content:['Synthetic fixture']},context:{status:'provided',content:['Synthetic fixture']},verification:{status:'provided',content:['Synthetic fixture']}},handoff:{version:2,stage:'pre-review',inputs:[{requestId:'planned-fixture',role:'Chochmah',stage:'planned',resultSha256:'a'.repeat(64)}],runGoal:goal,runAcceptance:acceptance,phaseIndex:1}};
  const preValue=roleValue('Geburah');
  const ledger=createRequestLedger(ledgerDir);
  ledger.recordOutcome(preId,{ok:true,contract:{...completedContract(preTask,{parentRunId},root,preValue),tierPolicyVersion:1},structuredResult:preValue});
  const preRecord=ledger.getOutcome(preId);
  const taskFor=(role,stage,inputs,extra={})=>({contractVersion:2,role,objective:goal,acceptance,readScope:['tests/gateway.test.mjs'],writeScope:role==='Chesed'?['tests/gateway.test.mjs']:[],handoff:{version:2,stage,inputs,runGoal:goal,runAcceptance:acceptance,phaseIndex:1},...extra});
  const preRef={requestId:preId,role:'Geburah',stage:'pre-review',resultSha256:preRecord.contract.resultSha256};
  const checkName='host npm test';
  const evidenceResponses=[];
  let attestationDigest='';
  const evidenceVariants=[{checkName,recordSha256:'pending'},{checkName:'different synthetic check',recordSha256:'pending'},{checkName,recordSha256:'f'.repeat(64)}];
  const patch='--- /var/lib/pi-kether/jobs/11111111-1111-4111-8111-111111111111/baseline/tests/gateway.test.mjs\n+++ /var/lib/pi-kether/jobs/11111111-1111-4111-8111-111111111111/workspace/tests/gateway.test.mjs\n@@ -0,0 +1 @@\n+synthetic\n';
  const scope=['tests/gateway.test.mjs'];
  const canonical=compileWriteScope(scope).map(item=>`${item.tree?'tree':'file'}:${item.path}`).sort().join('\\n');
  const proof={ok:true,requestId:'linked-chesed',jobId:'11111111-1111-4111-8111-111111111111',changedFiles:scope,patchSha256:createHash('sha256').update(patch,'utf8').digest('hex'),scopeSha256:createHash('sha256').update(canonical,'utf8').digest('hex')};
  const linkedDispatch=async(request,_signal,task)=>{
    if(task.role==='Chesed'){
      const value=roleValue('Chesed');
      value.changedFiles=scope;
      value.deliverable.checks=[{name:checkName,outcome:'unverified',evidence:'Host is assigned to run verification; fixture check not run by synthetic worker'}];
      return {ok:true,requestId:request.gatewayRequestId,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value),patch,patchValidation:proof};
    }
    const variant=evidenceVariants[evidenceResponses.length];
    if(variant.recordSha256==='pending')variant.recordSha256=attestationDigest;
    const value=roleValue('Netzach');value.deliverable.checks=[{name:checkName,outcome:'passed',evidence:'Synthetic fixture text only; not production evidence.'}];
    value.deliverable.checks[0].hostEvidence={requestId:'linked-chesed',artifactSha256:proof.patchSha256,recordSha256:variant.recordSha256,checkName:variant.checkName};
    const {default:registerResultSubmit}=await import('../extensions/result-submit.js');
    let submissionTool;
    registerResultSubmit({registerFlag:()=>{},getFlag:()=> 'Netzach',on:()=>{},registerTool:tool=>{submissionTool=tool;}});
    const submitted=await submissionTool.execute('fixture-submit',{payload:value});
    assert.equal(submitted.details.type,'kether_result_submission');
    evidenceResponses.push(value);return {ok:true,provider:request.provider,model:request.model,text:submitted.details.canonicalText};
  };
  try {
    await withGateway(async({client})=>{
      const receipt=await receiptFor(client,'task-tiers');
      const chesed=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,parentRunId,requestId:'linked-chesed',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',workflowReceipt:receipt,dependsOnRequestIds:[preId],...declaredT1(scope),tier:'T2',tierDeclaration:{...declaredT1(scope).tierDeclaration,publicApiOrProtocol:true},task:taskFor('Chesed','implementing',[preRef])}}));
      assert.equal(chesed.status,'awaiting-host-verification',JSON.stringify(chesed));
      const recorded=parsed(await client.callTool({name:'record_host_verification',arguments:{requestId:'linked-chesed',artifactSha256:chesed.hostVerification.artifactSha256,commands:[{checkName,command:'synthetic fixture command',exitCode:0,outputSummary:'Synthetic fixture text only; no production command ran.'}],workflowReceipt:receipt}}));
      assert.equal(recorded.state,'completed');
      const hostRecord=ledger.getHostVerification({requestId:'linked-chesed',artifactSha256:chesed.hostVerification.artifactSha256,recordSha256:recorded.recordSha256});
      assert.equal(hostRecord.outcome,'completed');
      const completed=ledger.getOutcome('linked-chesed');
      assert.equal(completed.state,'completed');
      const chesedRef={requestId:'linked-chesed',role:'Chesed',stage:'implementing',resultSha256:completed.contract.resultSha256};
      const evidenceRef={requestId:'linked-chesed',artifactSha256:proof.patchSha256,recordSha256:recorded.recordSha256,checkName};
      const resolverArgs={task:taskFor('Netzach','verifying',[chesedRef]),parentRunId,cwd:root,ledger};
      assert.equal(resolveBoundHostEvidence(evidenceRef,resolverArgs).ok,true);
      for(const patch of [
        {runAnchorSha256:undefined},{runAnchorSha256:'invalid'},{runAnchorSha256:completed.contract.runAnchorSha256.toUpperCase()},
        {handoffVersion:1},{phaseIndex:2},{parentRunId:'foreign'},{workspaceSha256:'f'.repeat(64)},{mode:'standalone'},{role:'Hod'},{stage:'planned'},
      ]) {
        const alteredLedger={getHostVerification:args=>ledger.getHostVerification(args),getOutcome:()=>({...completed,contract:{...completed.contract,...patch}})};
        assert.equal(resolveBoundHostEvidence(evidenceRef,{...resolverArgs,ledger:alteredLedger}).ok,false,JSON.stringify(patch));
      }
      for(const patch of [{goal:'foreign'},{phase:2},{workspace:'foreign'},{parentRunId:'foreign'},{outcome:'failed'},{commands:[{checkName,exitCode:1}]}]) {
        const alteredLedger={getOutcome:args=>ledger.getOutcome(args),getHostVerification:()=>({...hostRecord,...patch})};
        assert.equal(resolveBoundHostEvidence(evidenceRef,{...resolverArgs,ledger:alteredLedger}).ok,false,JSON.stringify(patch));
      }
      for(const patch of [{runGoal:'foreign'},{runAcceptance:[...acceptance].reverse()},{runAcceptance:['foreign']},{phaseIndex:2}]) {
        assert.equal(resolveBoundHostEvidence(evidenceRef,{...resolverArgs,task:{...resolverArgs.task,handoff:{...resolverArgs.task.handoff,...patch}}}).ok,false);
      }
      assert.equal(resolveBoundHostEvidence(evidenceRef,{...resolverArgs,task:{...resolverArgs.task,handoff:undefined}}).ok,false);
      assert.equal(resolveBoundHostEvidence({...evidenceRef,recordSha256:'f'.repeat(64)},resolverArgs).ok,false);
      const invoke=async(id)=>parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,parentRunId,requestId:id,provider:'openai-codex',model:'gpt-6-luna',access:'read',workflowReceipt:receipt,dependsOnRequestIds:['linked-chesed'],task:taskFor('Netzach','verifying',[chesedRef])}}));
      attestationDigest=recorded.recordSha256;
      evidenceVariants[0].recordSha256=recorded.recordSha256;
      const valid=await invoke('linked-netzach-positive');
      assert.equal(valid.ok,true,JSON.stringify(valid));
      assert.equal(valid.contract.role,'Netzach');
      const wrongName=await invoke('linked-netzach-wrong-check');
      assert.equal(wrongName.ok,false);
      const wrongDigest=await invoke('linked-netzach-wrong-digest');
      assert.equal(wrongDigest.ok,false);
      assert.equal(evidenceResponses.length,3);
    },{requestLedgerDir:ledgerDir,dispatchFn:linkedDispatch});
  } finally { rmSync(ledgerDir,{recursive:true,force:true}); }
});

test('runtime preflight is returned on async admission and terminal execution without blocking dispatch',async()=>{
  const records=[];
  await withGateway(async({client})=>{
    const input={requestId:'preflight-advisory',cwd:root,access:'read',provider:'openai-codex',model:'gpt-6-luna',task:{role:'Malkuth',objective:'Inspect a subprocess file',readScope:['package.json'],acceptance:['Report observed source']}};
    const admitted=parsed(await client.callTool({name:'submit_subagent',arguments:input}));
    assert.equal(admitted.ok,true);assert.equal(admitted.preflight.warnings[0].code,'missing_interface_contract');
    const result=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...input,requestId:'preflight-direct'}}));
    assert.equal(result.ok,true);assert.deepEqual(result.preflight.counts,{missing_interface_contract:1});
  },{auditLogger:{enabled:true,record:value=>records.push(value)}});
  assert.ok(records.some(r=>r.operation==='dispatch_subagent'&&r.preflight?.counts.missing_interface_contract===1));
  assert.ok(records.every(r=>r.preflight===undefined||JSON.stringify(r.preflight).includes('Inspect a subprocess file')===false));
});

function parsed(result) {
  return JSON.parse(result.content[0].text);
}

async function receiptFor(client,topic){
  return parsed(await client.callTool({name:'get_workflow',arguments:{topic}})).receipt;
}

const gatewayLedgerDirs=new WeakMap();
function gatewayLedgerDir(client){return gatewayLedgerDirs.get(client);}
async function completePendingFixture({client,ledgerDir},requestId,pendingResponse){
  const workflowReceipt=await receiptFor(client,'task-tiers');
  const commands=pendingResponse.hostVerification.requiredCheckNames.map(checkName=>({
    checkName,command:'synthetic fixture command (not executed)',exitCode:0,
    outputSummary:'Synthetic fixture evidence only; no host command was executed.',
  }));
  const recorded=parsed(await client.callTool({name:'record_host_verification',arguments:{
    requestId,artifactSha256:pendingResponse.hostVerification.artifactSha256,workflowReceipt,commands,
  }}));
  assert.equal(recorded.state,'completed');
  return createRequestLedger(ledgerDir).getEffectiveResult(requestId);
}

function declaredT1(files = ['package.json']) {
  return { tier: 'T1', tierDeclaration: {
    publicApiOrProtocol: false, dependencyOrLockfile: false, securityAuthOrCredentials: false,
    migration: false, irreversibleOrNoRollback: false,
  } };
}

function syntheticPatchResponse(request, task, jobId = '33333333-3333-4333-8333-333333333333', content = 'synthetic fixture') {
  const scope = task.writeScope;
  const patch = scope.map(path => `--- /var/lib/pi-kether/jobs/${jobId}/baseline/${path}\n+++ /var/lib/pi-kether/jobs/${jobId}/workspace/${path}\n@@ -0,0 +1 @@\n+${content}\n`).join('');
  const canonical = compileWriteScope(scope).map(item => `${item.tree ? 'tree' : 'file'}:${item.path}`).sort().join('\\n');
  const value = roleValue(task.role, task.objective); value.changedFiles = [...scope];
  return {ok:true,requestId:request.gatewayRequestId,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value),patch,patchValidation:{ok:true,requestId:request.gatewayRequestId,jobId,changedFiles:[...scope],patchSha256:createHash('sha256').update(patch,'utf8').digest('hex'),scopeSha256:createHash('sha256').update(canonical,'utf8').digest('hex')}};
}

test('topic gate blocks omitted and mismatched receipts before write dispatch or submission',async()=>{
  const ledgerDir=mkdtempSync(join(tmpdir(),'pi-topic-tier-ledger-'));
  const parentRunId='topic-tier-fixture-run';
  const runGoal='Scoped fixture change';
  const runAcceptance=['Return result'];
  const preId='topic-tier-fixture-pre-review';
  const preTask={role:'Geburah',objective:'Seed synthetic pre-review predecessor',acceptance:['Synthetic fixture only'],readScope:['tests/gateway.test.mjs'],writeScope:[],reviewPacket:{version:1,stage:'pre-change',requirements:{status:'provided',content:['Synthetic fixture']},changes:{status:'provided',content:['Synthetic fixture']},context:{status:'provided',content:['Synthetic fixture']},verification:{status:'provided',content:['Synthetic fixture']}},handoff:{version:2,stage:'pre-review',inputs:[{requestId:'topic-tier-planned',role:'Chochmah',stage:'planned',resultSha256:'a'.repeat(64)}],runGoal,runAcceptance,phaseIndex:1}};
  const preValue=roleValue('Geburah');
  const ledger=createRequestLedger(ledgerDir);
  ledger.recordOutcome(preId,{ok:true,contract:{...completedContract(preTask,{parentRunId},root,preValue),tierPolicyVersion:1},structuredResult:preValue});
  const preRecord=ledger.getOutcome(preId);
  const preRef={requestId:preId,role:'Geburah',stage:'pre-review',resultSha256:preRecord.contract.resultSha256};
  let calls=0;const records=[];
  try {
    await withGateway(async({client})=>{
      const handoff={version:2,stage:'implementing',inputs:[preRef],runGoal,runAcceptance,phaseIndex:1};
      const task={role:'worker',objective:runGoal,acceptance:runAcceptance,readScope:['package.json'],writeScope:['package.json'],handoff};
      const tierDeclaration={publicApiOrProtocol:true,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false};
      const base={cwd:root,parentRunId,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId:'workflow-write',tier:'T2',tierDeclaration,dependsOnRequestIds:[preId],task};
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
    },{requestLedgerDir:ledgerDir,dispatchFn:async(request,_signal,task)=>{calls++;return syntheticPatchResponse(request,task);},auditLogger:{enabled:true,record:value=>records.push(value)}});
  } finally { rmSync(ledgerDir,{recursive:true,force:true}); }
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
    const understated = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'tier-understated', ...declaredT1(), tier: 'T0', tierDeclaration:{...declaredT1().tierDeclaration,publicApiOrProtocol:true} } }));
    assert.equal(understated.code, 'WORKFLOW_TIER_INVALID');
    const standaloneT2 = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: {
      ...base, requestId: 'tier-standalone-t2', ...declaredT1(), tier: 'T2',
      tierDeclaration: { ...declaredT1().tierDeclaration, publicApiOrProtocol: true },
    } }));
    assert.equal(standaloneT2.code, 'WORKFLOW_TIER_PRE_REVIEW_REQUIRED');
    assert.equal(calls, 0);
    const admitted = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: 'tier-valid-t1', ...declaredT1() } }));
    assert.equal(admitted.status, 'awaiting-host-verification');
    assert.equal(admitted.ok, false);
    assert.equal(admitted.contract, undefined);
    const completed = await completePendingFixture({client,ledgerDir:gatewayLedgerDir(client)}, 'tier-valid-t1', admitted);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.tier, 'T1');
    assert.equal(completed.reviewPending, true);
    assert.equal(completed.contract.tier, 'T1');
    assert.equal(calls, 1);
    const oversizedTask={...task,writeScope:['src/a.js','src/b.js','src/c.js','src/d.js']};
    const oversizedArgs={...base,requestId:'tier-oversized',tier:'T0',tierDeclaration:declaredT1().tierDeclaration,task:oversizedTask};
    const oversized=parsed(await client.callTool({name:'dispatch_subagent',arguments:oversizedArgs}));
    assert.equal(oversized.ok,false);
    assert.equal(oversized.code,'PI_TIER_EXCEEDED');
    assert.equal(oversized.requiredTier,'T1');
    assert.equal(oversized.files,4);
    assert.equal(oversized.contract,undefined);
    const replay=parsed(await client.callTool({name:'dispatch_subagent',arguments:oversizedArgs}));
    assert.equal(replay.code,'PI_TIER_EXCEEDED');
    assert.equal(replay.contract,undefined);
    assert.equal(calls,2);
  }, { dispatchFn: async (request, _signal, task) => {
    calls++;
    if(task.writeScope.length>3)return syntheticPatchResponse(request,task);
    const jobId='33333333-3333-4333-8333-333333333333';
    const scope=task.writeScope;
    const patch=scope.map(path=>`--- /var/lib/pi-kether/jobs/${jobId}/baseline/${path}\n+++ /var/lib/pi-kether/jobs/${jobId}/workspace/${path}\n@@ -0,0 +1 @@\n+safe\n`).join('');
    const canonical=compileWriteScope(scope).map(item=>`${item.tree?'tree':'file'}:${item.path}`).sort().join('\\n');
    const value=roleValue(task.role,task.objective); value.changedFiles=[...scope];
    const patchValidation={ok:true,requestId:request.gatewayRequestId,jobId,changedFiles:[...scope],patchSha256:createHash('sha256').update(patch,'utf8').digest('hex'),scopeSha256:createHash('sha256').update(canonical,'utf8').digest('hex')};
    return {ok:true,requestId:request.gatewayRequestId,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value),patch,patchValidation};
  } });
});

test('gateway rejects removed caller-authored file and size tier fields', async () => {
  let calls=0;
  await withGateway(async({client})=>{
    const workflowReceipt=await receiptFor(client,'task-tiers');
    const result=await client.callTool({name:'dispatch_subagent',arguments:{
      cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId:'tier-old-fields',workflowReceipt,
      tier:'T0',tierDeclaration:{...declaredT1().tierDeclaration,files:['package.json'],estimatedLines:1},
      task:{role:'worker',objective:'Reject old declaration shape',acceptance:['Return result'],readScope:['package.json'],writeScope:['package.json']},
    }});
    assert.equal(result.isError,true);
    assert.match(result.content.filter(x=>x.type==='text').map(x=>x.text).join('\\n'),/MCP error|Invalid arguments|Unrecognized|unrecognized/);
    assert.equal(calls,0);
  },{dispatchFn:async()=>{calls++;return {};}});
});

test('gateway CLI dispatches explicit T1 without a compulsory receipt and exits successfully while pending',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'yhwh-cli-write-'));
  try{
    await withGateway(async({port})=>{
      const config=join(directory,'gateway.json'),tokenFile=join(directory,'token'),requestFile=join(directory,'request.json');
      writeFileSync(tokenFile,token);
      writeFileSync(config,JSON.stringify({host:'127.0.0.1',port,tokenFile}));
      writeFileSync(requestFile,JSON.stringify({cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId:'cli-write-receipt',...declaredT1(),task:{role:'worker',objective:'Prepare scoped fixture change',acceptance:['Return result'],readScope:['package.json'],writeScope:['package.json']}}));
      const {stdout}=await execFileAsync(process.execPath,[resolve(root,'scripts/gateway-client.mjs'),'dispatch',requestFile],{env:{...process.env,PI_GATEWAY_CONFIG:config},timeout:15000,windowsHide:true});
      const submitted=JSON.parse(stdout);
      assert.equal(submitted.status,'awaiting-host-verification');
      assert.equal(submitted.ok,false);
      assert.equal(submitted.contract,undefined);
      assert.deepEqual(submitted.hostVerification.requiredCheckNames,['fixture check']);
    },{dispatchFn:async(request,_signal,task)=>syntheticPatchResponse(request,task)});
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

test('gateway role validation keeps timeout as primary cause when a complete-looking result is malformed',async()=>{
 await withGateway(async({client})=>{
  const response=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'none',requestId:'timeout-role-validation',resourceProfile:'standard',task:{role:'Chesed',objective:'Timeout cause',acceptance:['Preserve the cause']}}}));
  assert.equal(response.ok,false);assert.equal(response.failureCode,'EXECUTION_TIMEOUT');assert.match(response.failure,/EXECUTION_TIMEOUT/);
  assert.equal(response.roleValidation.ok,false);assert.ok(response.secondaryValidation.some(value=>value.startsWith('role_schema_invalid:')));assert.equal(response.contract,undefined);
 },{dispatchFn:async(request,_signal,task)=>{const value=roleValue(task.role,task.objective);value.deliverable.checks='invalid checks';return {ok:false,failureCode:'EXECUTION_TIMEOUT',failure:'EXECUTION_TIMEOUT',exitCode:124,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value)};}});
});

test('valid completed role output cannot override an execution timeout',async()=>{
 await withGateway(async({client})=>{
  const response=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'none',requestId:'timeout-valid-role',resourceProfile:'standard',task:{role:'Chesed',objective:'Timeout cause',acceptance:['Preserve the cause']}}}));
  assert.equal(response.ok,false);assert.equal(response.failureCode,'EXECUTION_TIMEOUT');assert.match(response.failure,/EXECUTION_TIMEOUT/);
  assert.equal(response.roleValidation.ok,true);assert.equal(response.contract,undefined);
 },{dispatchFn:async(request,_signal,task)=>({ok:false,failureCode:'EXECUTION_TIMEOUT',failure:'EXECUTION_TIMEOUT',exitCode:124,provider:request.provider,model:request.model,text:formattedTaskResult(task)})});
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
    const rejected=await run('typed-review-reject','Geburah','pre-review',[planRef],{provider:'anthropic',model:'claude-sonnet-5'});assert.equal(rejected.ok,false);assert.equal(rejected.code,'PI_REVIEW_ATTEMPTS_INVALID');assert.match(rejected.error,/anchor|alias|parent/i);
    const blocked=await run('typed-blocked','Chesed','implementing',[ref('typed-review-reject','Geburah','pre-review')]);assert.equal(blocked.ok,false);assert.match(blocked.error,/dependency failed/);assert.equal(invoked.length,4); // Four launches were scout, plan, review, and worker; the changed-anchor review was rejected before model dispatch.
    const freshObjective='One stable failed-pre-review fixture goal';
    const freshAcceptance=['Observe one failed review'];
    const fresh=async(id,role,stage,inputs=[])=>parsed(await client.callTool({name:'dispatch_subagent',arguments:{...common,parentRunId:'typed-fresh-run',requestId:id,provider:role==='Geburah'?'anthropic':common.provider,model:role==='Geburah'?'claude-sonnet-5':common.model,dependsOnRequestIds:inputs.map(input=>input.requestId),task:{role,objective:freshObjective,acceptance:freshAcceptance,handoff:handoff(stage,inputs),...(role==='Geburah'?{reviewPacket:packet}:{})}}}));
    const freshScout=await fresh('typed-fresh-scout','Malkuth','scouted');assert.equal(freshScout.ok,true);
    const freshScoutRef=ref('typed-fresh-scout','Malkuth','scouted',freshScout.contract.resultSha256);
    const freshPlan=await fresh('typed-fresh-plan','Chochmah','planned',[freshScoutRef]);assert.equal(freshPlan.ok,true);
    const freshPlanRef=ref('typed-fresh-plan','Chochmah','planned',freshPlan.contract.resultSha256);
    const freshReview=await fresh('typed-fresh-review','Geburah','pre-review',[freshPlanRef]);assert.equal(freshReview.ok,false);assert.equal(freshReview.reviewValidation.decision,'request-changes');
    const freshBlocked=await fresh('typed-fresh-worker','Chesed','implementing',[ref('typed-fresh-review','Geburah','pre-review')]);assert.equal(freshBlocked.ok,false);assert.match(freshBlocked.error,/dependency failed/);assert.equal(invoked.length,7);
  },{dispatchFn:async(request,_signal,task,options)=>{
    invoked.push({role:task.role,upstream:options.upstreamResults});
    const value=roleValue(task.role,task.objective);if(task.role==='Geburah'&&rejectReview)value.reviewDecision='request-changes';
    return {ok:true,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value)};
  }});
});

test('T1 review extension requires a blocker-matched correction and current host proof', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'pi-t1-elastic-ledger-'));
  const objective = 'Verify a scoped T1 fixture correction';
  const acceptance = ['Preserve host-gated review quota'];
  const changedPath = 'tests/gateway.test.mjs';
  const reviewId1 = 't1-elastic-review-one';
  let implementationCalls = 0, reviewCalls = 0, corruptProofFor = null;
  const artifactArgs = n => ({ cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'workspace-write',
    requestId: `t1-elastic-artifact-${n}`, ...declaredT1([changedPath]), task: { role: 'Chesed', objective, acceptance,
      readScope: [changedPath], writeScope: [changedPath] } });
  const reviewArgs = (requestId, artifact, progress, extraContext = []) => ({ cwd: root, provider: 'anthropic', model: 'claude-sonnet-5',
    access: 'none', tier: 'T1', reviewOfRequestId: artifact.requestId, requestId, task: { role: 'Geburah', objective, acceptance,
      context: [...extraContext, ...(progress ? [`REVIEW_PROGRESS_JSON=${JSON.stringify(progress)}`] : [])],
      reviewPacket: { version: 1, stage: 'post-change', requirements: { status: 'provided', content: ['T1 requirements'] },
        changes: { status: 'provided', content: [artifact.patch] }, context: { status: 'provided', content: ['T1 review context'] },
        verification: { status: 'provided', content: ['Host verified fixture check'] } } } });
  const passHost = async (client, response, id, exitCode = 0) => {
    const recorded = parsed(await client.callTool({ name: 'record_host_verification', arguments: {
      requestId: id, artifactSha256: response.hostVerification.artifactSha256,
      commands: [{ checkName: 'fixture check', command: 'synthetic fixture only', exitCode, outputSummary: 'Synthetic integration evidence only.' }],
      workflowReceipt: await receiptFor(client, 'task-tiers'),
    } }));
    return recorded;
  };
  try {
    await withGateway(async ({ client }) => {
      const makeArtifact = async n => {
        const result = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...artifactArgs(n), workflowReceipt: await receiptFor(client, 'task-tiers') } }));
        assert.equal(result.status, 'awaiting-host-verification', JSON.stringify(result));
        result.requestId = `t1-elastic-artifact-${n}`;
        return result;
      };
      const firstArtifact = await makeArtifact(1);
      assert.equal((await passHost(client, firstArtifact, firstArtifact.requestId)).state, 'completed');
      corruptProofFor = firstArtifact.requestId;
      const mismatchedProof = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: reviewArgs('t1-elastic-mismatched-proof', firstArtifact) }));
      assert.equal(mismatchedProof.code, 'PI_T1_REVIEW_REFERENCE_REQUIRED');
      assert.equal(mismatchedProof.modelExecutionStarted, false);
      assert.equal(reviewCalls, 0);
      corruptProofFor = null;
      const first = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: reviewArgs(reviewId1, firstArtifact) }));
      assert.equal(first.reviewQuota.used, 1);
      assert.equal(first.reviewQuota.blockerPaths.includes(changedPath), true);
      const progress = { version: 1, previousReviewRequestId: reviewId1,
        closures: [{ key: first.reviewQuota.blockerKeys[0], paths: [changedPath], evidence: 'The revised patch corrects the cited tests/gateway.test.mjs blocker.' }] };
      const malformed = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: reviewArgs('t1-elastic-malformed', firstArtifact,
        progress, ['REVIEW_PROGRESS_JSON={']) }));
      assert.equal(malformed.code, 'PI_REVIEW_ATTEMPTS_INVALID');
      const irrelevant = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: reviewArgs('t1-elastic-irrelevant', firstArtifact,
        { ...progress, closures: [] }, ['Unrelated plan paragraph only; no cited correction.']) }));
      assert.equal(irrelevant.code, 'PI_REVIEW_LIMIT_EXCEEDED');
      assert.equal(reviewCalls, 1);
      const failedArtifact = await makeArtifact(2);
      const pendingReview = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: reviewArgs('t1-elastic-pending-review', failedArtifact, progress) }));
      assert.equal(pendingReview.code, 'PI_LEGACY_REVIEW_STATE_UNKNOWN');
      assert.equal(pendingReview.modelExecutionStarted, false);
      const failedHost = await passHost(client, failedArtifact, failedArtifact.requestId, 1);
      assert.notEqual(failedHost.state, 'completed');
      const failedHostReview = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: reviewArgs('t1-elastic-failed-host-review', failedArtifact, progress) }));
      assert.equal(failedHostReview.code, 'PI_LEGACY_REVIEW_STATE_UNKNOWN');
      assert.equal(failedHostReview.modelExecutionStarted, false);
      assert.equal(reviewCalls, 1);
      const repairedArtifact = await makeArtifact(3);
      assert.equal((await passHost(client, repairedArtifact, repairedArtifact.requestId)).state, 'completed');
      const second = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: reviewArgs('t1-elastic-review-two', repairedArtifact, progress) }));
      assert.equal(second.reviewQuota.used, 2);
      assert.equal(second.reviewQuota.extensionUsed, true);
      const denied = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: reviewArgs('t1-elastic-review-three', repairedArtifact, progress) }));
      assert.equal(denied.code, 'PI_REVIEW_LIMIT_EXCEEDED');
      assert.equal(denied.modelExecutionStarted, false);
      assert.equal(reviewCalls, 2);
    }, { requestLedgerDir: ledgerDir, moduleFactories: { ledger: () => {
      const real = createRequestLedger(ledgerDir);
      return new Proxy(real, { get(target, property) {
        if (property === 'getEffectiveResult') return requestId => {
          const result = target.getEffectiveResult(requestId);
          return requestId === corruptProofFor && result ? { ...result, verifiedArtifactSha256: 'f'.repeat(64) } : result;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } }, dispatchFn: async (request, _signal, task, options) => {
      if (task.role === 'Chesed') {
        implementationCalls++;
        return syntheticPatchResponse(request, task, `33333333-3333-4333-8333-${String(implementationCalls).padStart(12, '0')}`, `synthetic fixture revision ${implementationCalls}`);
      }
      reviewCalls++; options.onModelStart();
      const value = roleValue(task.role, task.objective); value.reviewDecision = 'request-changes';
      value.deliverable.findings = [{ severity: 'medium', description: `Blocker in ${changedPath}`, evidence: changedPath, blocking: true }];
      return { ok: true, provider: request.provider, model: request.model, text: `KETHER_RESULT_JSON=${JSON.stringify(value)}`, modelExecutionStarted: true };
    } });
  } finally { rmSync(ledgerDir, { recursive: true, force: true }); }
});

test('MCP pre-review progress admits one shared extension only for cited shrinking blockers',async()=>{
  let calls=0;
  const changes={first:['tests/a.js initial','tests/b.js initial'],second:['tests/a.js corrected','tests/b.js initial'],third:['tests/a.js corrected','tests/b.js corrected']};
  const packet=revision=>({version:1,stage:'pre-change',requirements:{status:'provided',content:['Requirement']},changes:{status:'provided',content:changes[revision]},context:{status:'provided',content:['Context']},verification:{status:'provided',content:['Verification']}});
  const objective='Review only cited fixture changes';
  await withGateway(async({client})=>{
    const invoke = async (requestId, revision, progress) => parsed(await client.callTool({
      name: 'dispatch_subagent', arguments: {
        cwd: root, provider: 'anthropic', model: 'claude-sonnet-5', access: 'none', requestId,
        task: { role: 'Geburah', objective, acceptance: ['Return a review decision'], reviewPacket: packet(revision),
          ...(progress ? { context: [`REVIEW_PROGRESS_JSON=${JSON.stringify(progress)}`] } : {}) },
      },
    }));
    const first=await invoke('progress-review-first','first');assert.equal(first.ok,false);assert.equal(first.reviewQuota.used,1);
    const second=await invoke('progress-review-second','second');assert.equal(second.ok,false);assert.equal(second.reviewQuota.used,2);
    const remaining={reviewDecision:'request-changes',findings:[{severity:'medium',description:'Remaining blocker in tests/b.js',evidence:'tests/b.js',blocking:true}],missingMaterials:[]};
    const key=reviewBlockers(remaining)[0].key;
    const progress={version:1,previousReviewRequestId:'progress-review-second',closures:[{key,paths:['tests/b.js'],evidence:'The revised material corrects the cited tests/b.js blocker.'}]};
    const third=await invoke('progress-review-third','third',progress);assert.equal(third.ok,false);assert.equal(third.reviewQuota.used,3);assert.equal(third.reviewQuota.extensionUsed,true);assert.equal(third.reviewQuota.extensionEligible,false);
    const denied=await invoke('progress-review-fourth','third',progress);assert.equal(denied.ok,false);assert.equal(denied.code,'PI_REVIEW_LIMIT_EXCEEDED');assert.equal(denied.modelExecutionStarted,false);assert.equal(calls,3);
  },{dispatchFn:async(request,_signal,task,options)=>{
    calls++;options.onModelStart();const value=roleValue(task.role,task.objective);value.reviewDecision='request-changes';value.deliverable.findings=calls===1?[
      {severity:'medium',description:'Blocker in tests/a.js',evidence:'tests/a.js',blocking:true},{severity:'medium',description:'Blocker in tests/b.js',evidence:'tests/b.js',blocking:true},
    ]:[{severity:'medium',description:'Remaining blocker in tests/b.js',evidence:'tests/b.js',blocking:true}];
    return{ok:true,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value),modelExecutionStarted:true};
  }});
});

test('review gateway rejects a changed anchor under an already-bound parent alias',async()=>{
  let calls=0;
  const packet={version:1,stage:'pre-change',...Object.fromEntries(['requirements','changes','context','verification'].map(key=>[key,{status:'provided',content:[`Alias fixture ${key}`]}]))};
  await withGateway(async({client})=>{
    const invoke=async(requestId,objective)=>parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,parentRunId:'review-alias-parent',provider:'anthropic',model:'claude-sonnet-5',access:'none',requestId,task:{role:'Geburah',objective,acceptance:['Review the alias fixture'],reviewPacket:packet}}}));
    assert.equal((await invoke('review-alias-first','First anchor')).ok,true);
    const conflict=await invoke('review-alias-conflict','Changed anchor');
    assert.equal(conflict.code,'PI_REVIEW_ATTEMPTS_INVALID');
    assert.match(conflict.error,/anchor|alias|parent/i);
    assert.equal(calls,1);
  },{dispatchFn:async(request,_signal,task)=>{calls++;return{ok:true,provider:request.provider,model:request.model,text:formattedTaskResult(task)};}});
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
    gatewayLedgerDirs.set(client, options.requestLedgerDir ?? ledgerDir);
    await run({ client, port, ledgerDir: options.requestLedgerDir ?? ledgerDir });
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

test('explicit review tier rejects T0 and T1 pre-change before model launch',async()=>{
 let calls=0;
 await withGateway(async({client})=>{
  for(const [id,tier,stage] of [['review-t0-pre','T0','pre-change'],['review-t0-post','T0','post-change'],['review-t1-pre','T1','pre-change']]){
   const reviewPacket={version:1,stage,...Object.fromEntries(['requirements','changes','context','verification'].map(k=>[k,{status:'provided',content:['fixture '+k]}]))};
   const response=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'anthropic',model:'claude-sonnet-5',access:'none',tier,requestId:id,task:{role:'Geburah',objective:'Tier stage guard',acceptance:['Review'],reviewPacket}}}));
   assert.equal(response.code,'PI_REVIEW_STAGE_INVALID');assert.equal(response.modelExecutionStarted,false);
  }
  assert.equal(calls,0);
 },{dispatchFn:async()=>{calls++;throw new Error('must not launch');}});
});

test('durable review quota launches only two base reviews and reports pre-launch exhaustion', async () => {
  let calls = 0;
  const packet = change => ({ version: 1, stage: 'pre-change', requirements: { status: 'provided', content: ['Requirement'] }, changes: { status: 'provided', content: [`Plan revision ${change}`] }, context: { status: 'provided', content: ['Context'] }, verification: { status: 'provided', content: ['Verification'] } });
  await withGateway(async ({ client }) => {
    const invoke = async (requestId, change) => parsed(await client.callTool({ name: 'dispatch_subagent', arguments: {
      cwd: root, provider: 'anthropic', model: 'claude-sonnet-5', access: 'none', requestId,
      task: { role: 'Geburah', objective: 'Persistent quota fixture goal', acceptance: ['Return a review decision'], reviewPacket: packet(change) },
    } }));
    assert.equal((await invoke('quota-review-a', 'one')).ok, true);
    assert.equal((await invoke('quota-review-b', 'two')).ok, true);
    const denied = await invoke('quota-review-c', 'three');
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'PI_REVIEW_LIMIT_EXCEEDED');
    assert.equal(denied.modelExecutionStarted, false);
    assert.equal(denied.used, 2);
    assert.equal(denied.remainingBase, 0);
    assert.equal(calls, 2);
  }, { dispatchFn: async (request, _signal, task, options) => {
    calls++;
    options.onModelStart();
    return { ok: true, provider: request.provider, model: request.model, text: formattedTaskResult(task) };
  } });
});

test('review gateway preserves full request IDs and distinguishes confirmed zero launch from unknown execution',async()=>{
 const audit=[];let mode='zero',calls=0;
 const packet={version:1,stage:'pre-change',...Object.fromEntries(['requirements','changes','context','verification'].map(key=>[key,{status:'provided',content:[`Long-ID fixture ${key}`]}]))};
 const task={role:'Geburah',objective:'Full length review identity',acceptance:['Return an approval decision'],reviewPacket:packet};
 await withGateway(async({client})=>{
  const invoke=async requestId=>parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'anthropic',model:'claude-sonnet-5',access:'none',timeoutSeconds:5,requestId,task}}));
  const zero=await invoke('review-zero-launch');assert.equal(zero.modelExecutionStarted,false);assert.equal(zero.code,undefined);
  mode='unknown';const unknown=await invoke('review-unknown-launch');assert.equal(unknown.modelExecutionStarted,null);
  mode='started';const longId='r'.repeat(128);const complete=await invoke(longId);assert.equal(complete.ok,true);assert.equal(complete.requestId,longId);assert.equal(complete.reviewQuota.available,true);assert.equal(complete.reviewQuota.extensionEligible,false);assert.equal(complete.reviewQuota.extensionEligibilityReason,'review complete');
  assert.equal(calls,3);
 },{auditLogger:{enabled:true,record:value=>audit.push(value)},dispatchFn:async(request,_signal,reviewTask,options)=>{
  calls++;
  if(mode==='zero')throw Object.assign(new Error('launcher confirmed no process'),{modelExecutionStarted:false});
  if(mode==='unknown')throw new Error('launcher outcome unavailable');
  options.onModelStart();return {ok:true,provider:request.provider,model:request.model,text:formattedTaskResult(reviewTask),modelExecutionStarted:true};
 }});
 assert.ok(audit.some(record=>record.requestId==='review-zero-launch'&&record.modelExecution===false));
 assert.ok(audit.some(record=>record.requestId==='review-unknown-launch'&&record.modelExecution===null));
});

test('invalid reviewer role output cannot persist approval, but actual model use consumes quota',async()=>{
 let calls=0;
 const packet=change=>({version:1,stage:'pre-change',...Object.fromEntries(['requirements','changes','context','verification'].map(k=>[k,{status:'provided',content:[`${change} ${k}`]}]))});
 await withGateway(async({client})=>{
  const invoke=(id,change)=>client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'anthropic',model:'claude-sonnet-5',access:'none',requestId:id,task:{role:'Geburah',objective:'Invalid reviewer role result quota',acceptance:['Return review'],reviewPacket:packet(change)}}}).then(parsed);
  const invalid=await invoke('invalid-role-review','same');assert.equal(invalid.reviewValidation.approved,true);assert.equal(invalid.roleValidation.ok,false);assert.equal(invalid.ok,false);assert.equal(invalid.reviewQuota.used,1);
  const valid=await invoke('valid-after-invalid-role','same');assert.equal(valid.reviewValidation.approved,true);assert.equal(valid.ok,true);assert.equal(valid.reviewQuota.used,2);assert.equal(calls,2);
 },{dispatchFn:async(request,_signal,task,options)=>{calls++;const value=roleValue(task.role,task.objective);if(calls===1)value.deliverable.recommendations=7;options.onModelStart();return{ok:true,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value),modelExecutionStarted:true};}});
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

test('authenticated wait_subagent wakes on one execution without replay and returns compact redacted metadata',async()=>{
 let release,calls=0;
 await withGateway(async({client})=>{
  const input={cwd:root,provider:'openai-codex',model:'gpt-6-luna',requestId:'wait-mcp',parentRunId:'wait-mcp',access:'none',resourceProfile:'small',task:{role:'Malkuth',objective:'wait for task',acceptance:['Report result']}};
  assert.equal(parsed(await client.callTool({name:'submit_subagent',arguments:input})).ok,true);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const waiting=client.callTool({name:'wait_subagent',arguments:{requestId:input.requestId,timeoutMs:5000}},undefined,{timeout:6000,maxTotalTimeout:6000});
  release();
  const result=parsed(await waiting);
  assert.equal(result.ready,true);assert.equal(result.state,'completed');assert.equal(result.gatewayInstanceId.length>0,true);
  assert.equal(Object.hasOwn(result,'result'),false);assert.equal(calls,1);
 },{dispatchFn:async(request,_signal,task)=>{calls++;await new Promise(resolve=>{release=resolve;});return {ok:true,provider:request.provider,model:request.model,text:formattedTaskResult(task)};}});
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
      'cancel_subagent', 'check_claude_auth', 'code_graph', 'dispatch_subagent', 'get_subagent_result', 'get_subagent_status', 'get_task_handoff', 'get_workflow', 'list_capabilities',
      'list_host_verification_pending', 'list_subagents', 'lsp_request', 'probe_model', 'project_memory', 'record_host_verification', 'render_subagent_monitor', 'submit_subagent', 'wait_subagent', 'wait_task_handoff',
    ]);
    const caps = parsed(await client.callTool({ name: 'list_capabilities', arguments: {} }));
    assert.equal(caps.writeEnabled, true);
    assert.equal(caps.resourceLimits.enforced, true);
    assert.equal(caps.resourceLimits.defaultProfile, 'standard');
    assert.equal(caps.resourceLimits.profiles.standard.memoryMiB, 3072);
    assert.ok(caps.governance.requiredConnectorTools.includes('wait_subagent'));
    assert.equal(caps.resourceLimits.callerMayOnlyTightenTimeout,false);
    assert.equal(caps.governance?.timeouts?.completionWait?.maxTimeoutMs,55000);
    assert.deepEqual(caps.governance.workflowTiers.reviewQuota,{version:2,T1:{basePerStage:1,stageCap:2,totalCap:2,timeMs:600000},T2:{basePerStage:2,stageCap:3,totalCap:5,timeMs:1200000,sharedExtensions:1}});
    assert.equal(caps.governance.workflowTiers.version,2);
  });
});

test('T0 all-passed worker checks remain pending until bound host proof',async()=>{
  await withGateway(async({client})=>{
    const receipt=await receiptFor(client,'task-tiers');
    const task={role:'Chesed',objective:'Synthetic T0 host gate',acceptance:['Require actual host checks'],readScope:['package.json'],writeScope:['package.json']};
    const value=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId:'t0-all-passed-pending',tier:'T0',tierDeclaration:declaredT1().tierDeclaration,workflowReceipt:receipt,task}}));
    assert.equal(value.status,'awaiting-host-verification');
    assert.equal(value.ok,false);
    assert.equal(value.contract,undefined);
    assert.deepEqual(value.hostVerification.requiredCheckNames,['worker-check']);
  },{dispatchFn:async(request,_signal,task)=>{
    const response=syntheticPatchResponse(request,task);
    const value=JSON.parse(response.text.slice('KETHER_RESULT_JSON='.length));
    value.deliverable.checks=[{name:'worker-check',outcome:'passed',evidence:'Worker reported a pass.'}];
    response.text='KETHER_RESULT_JSON='+JSON.stringify(value);
    return response;
  }});
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

test('personal-profile T2 dispatch round-trips tier metadata through host attestation and ledger restart', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-personal-workspace-'));
  const ledgerDir = mkdtempSync(join(tmpdir(), 'pi-personal-ledger-'));
  const requestId = 'personal-tier-roundtrip';
  const metadataKeys = ['tier','reviewPending','files','addedLines','deletedLines','estimatedLines','baseTier','riskProfile','semanticRisks','reviewRequirement'];
  try {
    await withGateway(async ({ client }) => {
      const workflowReceipt = await receiptFor(client, 'task-tiers');
      const task = {
        role: 'Chesed', objective: 'Exercise personal profile downgrade through durable host verification',
        acceptance: ['Preserve tier metadata after host verification'], readScope: ['package.json'], writeScope: ['package.json'],
      };
      const pending = parsed(await client.callTool({name:'dispatch_subagent',arguments:{
        cwd:workspace,provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',requestId,
        writeScope:['package.json'],tier:'T2',tierDeclaration:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:true,irreversibleOrNoRollback:false},
        workflowReceipt,task,
      }}));
      assert.equal(pending.status, 'awaiting-host-verification', JSON.stringify(pending));
      assert.equal(pending.baseTier, 'T2');
      assert.equal(pending.tier, 'T1');
      assert.equal(pending.riskProfile, 'personal');
      assert.equal(pending.files, 1);
      assert.equal(pending.addedLines, 1);
      assert.equal(pending.deletedLines, 0);
      assert.equal(pending.estimatedLines, 1);
      assert.equal(pending.semanticRisks.migration, true);
      assert.deepEqual(pending.structuredResult.deliverable.checks, [{name:'profile-check',outcome:'unverified',evidence:'host execution unavailable; host must run command'}]);

      const freshReceipt = await receiptFor(client, 'task-tiers');
      const recorded = parsed(await client.callTool({name:'record_host_verification',arguments:{
        requestId,artifactSha256:pending.hostVerification.artifactSha256,
        commands:[{checkName:'profile-check',command:'synthetic personal-profile regression',exitCode:0,outputSummary:'Synthetic evidence only; no host command was executed.'}],
        workflowReceipt:freshReceipt,
      }}));
      assert.equal(recorded.state, 'completed');
    }, {
      roots:[workspace], riskProfiles:[{cwd:workspace,riskProfile:'personal'}], requestLedgerDir:ledgerDir,
      dispatchFn:async(request,_signal,task)=>{
        const response=syntheticPatchResponse(request,task);
        const value=JSON.parse(response.text.slice('KETHER_RESULT_JSON='.length));
        value.deliverable.checks=[{name:'profile-check',outcome:'unverified',evidence:'host execution unavailable; host must run command'}];
        response.text='KETHER_RESULT_JSON='+JSON.stringify(value);
        return response;
      },
    });

    const reopened = createRequestLedger(ledgerDir);
    const effective = reopened.getEffectiveResult(requestId);
    assert.equal(reopened.getOutcome(requestId).state, 'completed');
    assert.equal(effective.state, 'completed');
    assert.deepEqual(Object.fromEntries(metadataKeys.map(key=>[key,effective.contract[key]])),
      Object.fromEntries(metadataKeys.map(key=>[key,key==='semanticRisks'?{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:true,irreversibleOrNoRollback:false}:key==='tier'?'T1':key==='reviewPending'?true:key==='files'||key==='addedLines'||key==='estimatedLines'?1:key==='deletedLines'?0:key==='baseTier'?'T2':key==='riskProfile'?'personal':'independent post-review required'])));
  } finally {
    rmSync(workspace, {recursive:true,force:true});
    rmSync(ledgerDir, {recursive:true,force:true});
  }
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

test('risk profiles resolve canonical cwd ancestors and reject duplicate, malformed, and escaping entries', () => {
  const temp=mkdtempSync(join(tmpdir(),'pi-profile-roots-'));
  const outside=mkdtempSync(join(tmpdir(),'pi-profile-outside-'));
  try {
    const rootDir=join(temp,'root'), child=join(rootDir,'team'), deeper=join(child,'critical'), sibling=join(temp,'root-team');
    mkdirSync(deeper,{recursive:true}); mkdirSync(sibling);
    const symlink=join(rootDir,'escape-link');
    try { symlinkSync(outside,symlink,'junction'); } catch { /* Unsupported platform privilege: real escape path is still tested below. */ }
    const runtime=createGatewayRuntime({roots:[rootDir],riskProfiles:[{cwd:rootDir,riskProfile:'critical'},{cwd:child,riskProfile:'personal'},{cwd:deeper,riskProfile:'critical'}],sandboxStatus:verifiedSandbox});
    assert.equal(runtime.capabilities().riskProfiles.length,3);
    assert.throws(()=>createGatewayRuntime({roots:[rootDir],riskProfiles:[{cwd:child,riskProfile:'personal'},{cwd:child,riskProfile:'critical'}],sandboxStatus:verifiedSandbox}),/Duplicate canonical/);
    for(const entry of [{cwd:sibling,riskProfile:'critical'},{cwd:join(rootDir,'missing'),riskProfile:'critical'},{cwd:rootDir,riskProfile:'unknown'},{cwd:rootDir,riskProfile:'critical',extra:true}]) assert.throws(()=>createGatewayRuntime({roots:[rootDir],riskProfiles:[entry],sandboxStatus:verifiedSandbox}));
    if (process.platform!=='win32') assert.throws(()=>createGatewayRuntime({roots:[rootDir],riskProfiles:[{cwd:outside,riskProfile:'critical'}],sandboxStatus:verifiedSandbox}));
    if (process.platform!=='win32') assert.throws(()=>createGatewayRuntime({roots:[rootDir],riskProfiles:[{cwd:symlink,riskProfile:'critical'}],sandboxStatus:verifiedSandbox}));
  } finally { rmSync(temp,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
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
    const extended=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...common,requestId:'standard-600',timeoutSeconds:600,access:'read'}}));
    assert.equal(extended.resourceLimits.timeoutSeconds,600);assert.equal(extended.resourceLimits.defaultRunSeconds,300);assert.equal(extended.resourceLimits.maxRunSeconds,900);assert.equal(extended.resourceLimits.memoryBytes,3*1024**3);
    const overLimit=await client.callTool({name:'dispatch_subagent',arguments:{...common,requestId:'standard-901',timeoutSeconds:901,access:'read'}});
    assert.equal(overLimit.isError,true);
    const workflowReceipt=await receiptFor(client,'task-tiers');
    const writeResult = await client.callTool({ name: 'dispatch_subagent', arguments: { ...common, access: 'workspace-write', workflowReceipt, ...declaredT1(), task: { ...task, writeScope: ['package.json'] } } });
    assert.equal(writeResult.isError, false);
    assert.equal(parsed(writeResult).writeScopeEnforced, true);
  },{dispatchFn:async(request,_signal,task)=>request.access==='workspace-write' ? syntheticPatchResponse(request,task) : {ok:true,provider:request.provider,model:request.model,text:formattedTaskResult(task)}});
});

test('workspace-write requires requestId and replays one durable result without redispatch', async () => {
  let dispatchCount = 0;
  const records = [];
  const dispatchFn = async (request, _signal, task) => {
    dispatchCount++;
    return syntheticPatchResponse(request,task);
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
    return syntheticPatchResponse(request,task);
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
    const pending=results.map(parsed);
    assert.ok(pending.every(result=>result.status==='awaiting-host-verification'));
    const completed=await Promise.all(pending.map((response,index)=>completePendingFixture({client,ledgerDir:gatewayLedgerDir(client)},index===0?'lock-one':'lock-two',response)));
    assert.ok(completed.every(result=>result.state==='completed'));
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
    assert.equal(recovered.status, 'awaiting-host-verification');
    assert.equal(recovered.ok, false);
    const effective=await completePendingFixture({client,ledgerDir:gatewayLedgerDir(client)},'artifact-recovery',recovered);
    assert.equal(effective.state,'completed');
    assert.equal(effective.artifactRecovery, true);
    assert.equal(effective.unrecoveredErrors, 0);
    assert.equal(effective.recoveredErrors, 1);
    for (const id of ['artifact-transient-denied-attempt', 'artifact-outside', 'artifact-missing', 'artifact-invalid-result', 'artifact-blocked-result', 'artifact-failed-result', 'artifact-unverified-result', 'artifact-status-failed', 'artifact-status-blocked', 'artifact-status-unverified', 'artifact-malformed', 'artifact-no-proof', 'artifact-transport', 'artifact-nonzeroexit', 'artifact-agent-error', 'artifact-provider-mismatch', 'artifact-cleanup']) {
      variant = id;
      const response = parsed(await client.callTool({ name: 'dispatch_subagent', arguments: { ...base, requestId: id } }));
      assert.equal(response.ok, false, id);
      if (id === 'artifact-transient-denied-attempt') {
        assert.equal(response.ok,false);
        assert.equal(response.status,'awaiting-host-verification');
        assert.equal(response.toolErrors, 1);
        const effective = await completePendingFixture({client,ledgerDir:gatewayLedgerDir(client)},id,response);
        assert.equal(effective.state,'completed');
        assert.equal(effective.ok,true);
        assert.equal(effective.artifactRecovery,true);
        assert.equal(effective.recoveredErrors,1);
        assert.equal(effective.unrecoveredErrors,0);
      } else {
        assert.equal(response.artifactRecovery, undefined, id);
        assert.equal(response.ok,false,id);
        assert.equal(response.contract,undefined,id);
        assert.notEqual(response.status,'awaiting-host-verification',id);
        if (id.startsWith('artifact-status-')) {
          const status=id.slice('artifact-status-'.length);
          assert.equal(response.status,status);
          assert.equal(response.failure,`agent_status:${status}`);
          assert.equal(response.hostVerification,undefined);
        }
        if (['artifact-transport','artifact-nonzeroexit','artifact-agent-error','artifact-cleanup','artifact-failed-result','artifact-unverified-result'].includes(id)) {
          assert.equal(response.failure,id);
          assert.notEqual(response.failure,'PI_HOST_VERIFICATION_REQUIRED');
          assert.equal(response.hostVerification,undefined);
          if (id === 'artifact-failed-result') assert.equal(response.status, 'failed');
          if (id === 'artifact-unverified-result') assert.equal(response.status, 'unverified');
        }
      }
    }
  }, { dispatchFn: async (request, _signal, task) => {
    const invalid = variant === 'artifact-invalid-result' || variant === 'artifact-blocked-result';
    const independentFailure = ['artifact-transport', 'artifact-nonzeroexit', 'artifact-agent-error', 'artifact-provider-mismatch', 'artifact-cleanup', 'artifact-failed-result', 'artifact-unverified-result'].includes(variant);
    const candidatePatch = variant === 'artifact-missing' ? undefined : variant === 'artifact-outside' ? patch.replaceAll('/package.json', '/outside.js') : variant === 'artifact-malformed' ? 'not a unified patch' : patch;
    const canonicalScope = compileWriteScope(task.writeScope).map(item => `${item.tree ? 'tree' : 'file'}:${item.path}`).sort().join('\\n');
    const proof = { ok: true, requestId: request.gatewayRequestId, jobId, changedFiles: variant === 'artifact-outside' ? ['outside.js'] : ['package.json'], patchSha256: createHash('sha256').update(candidatePatch ?? '', 'utf8').digest('hex'), scopeSha256: createHash('sha256').update(canonicalScope, 'utf8').digest('hex') };
    const recoveredValue = invalid ? (variant === 'artifact-blocked-result' ? { ...roleValue(task.role, task.objective), status: 'blocked' } : { status: 'completed' }) : roleValue(task.role, task.objective);
    if (variant.startsWith('artifact-status-')) {
      recoveredValue.status=variant.slice('artifact-status-'.length);
      recoveredValue.errors=[variant];
      recoveredValue.changedFiles=[...task.writeScope];
      return {ok:true,failure:null,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(recoveredValue),patch:candidatePatch,patchValidation:proof};
    }
    if (['artifact-failed-result', 'artifact-unverified-result'].includes(variant)) {
      recoveredValue.status = variant === 'artifact-failed-result' ? 'failed' : 'unverified';
      recoveredValue.errors = [variant];
      recoveredValue.changedFiles = [...task.writeScope];
    }
    if (!invalid && !independentFailure && ['valid', 'artifact-transient-denied-attempt'].includes(variant)) recoveredValue.changedFiles = [...task.writeScope];
    return { ok: false, failure: independentFailure ? variant : 'Tool execution failed', provider: variant === 'artifact-provider-mismatch' ? 'other' : request.provider, model: request.model, requestedProvider: request.provider, requestedModel: request.model, text: 'KETHER_RESULT_JSON=' + JSON.stringify(recoveredValue), toolErrors: 1, fileToolErrors: 1, unrecoveredErrors: 1, unrecoveredFileToolErrors: 1, recoverableToolFailure: !independentFailure, recoverableFileToolFailure: !independentFailure, ...(['valid', 'artifact-transient-denied-attempt', 'artifact-failed-result', 'artifact-unverified-result'].includes(variant) ? { exitCode: 0, cleanup: { ok: true } } : {}), ...(variant === 'artifact-transport' ? { transportError: true } : {}), ...(variant === 'artifact-nonzeroexit' ? { exitCode: 1 } : {}), ...(variant === 'artifact-agent-error' ? { agentError: true } : {}), ...(variant === 'artifact-cleanup' ? { cleanupError: true } : {}), patch: candidatePatch, patchValidation: variant === 'artifact-no-proof' ? undefined : proof };
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
