import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequestLedger, requestDigest, RequestLedgerError } from '../extensions/request-ledger.js';
import { hostRecordDigest } from '../extensions/host-verification.js';
import { resultDigest } from '../extensions/role-contract.js';
import { roleValue } from './contract-fixtures.mjs';
import { applyArtifact } from '../scripts/artifact-apply.mjs';
import { sanitizeResult } from '../extensions/result-export.js';

function withLedgerDir(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-request-ledger-'));
  return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('request digest is canonical and excludes requestId', () => {
  const left = requestDigest('dispatch_subagent', { requestId: 'one', access: 'workspace-write', task: { objective: 'x', role: 'worker' } });
  const right = requestDigest('dispatch_subagent', { task: { role: 'worker', objective: 'x' }, access: 'workspace-write', requestId: 'two' });
  assert.equal(left, right);
});

test('completed write result replays across ledger instances without executing again', async () => withLedgerDir(async directory => {
  let executions = 0;
  const input = { requestId: 'write-1', access: 'workspace-write', task: { role: 'worker', objective: 'change x' } };
  const first = await createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => {
    executions++;
    return { response: { ok: true, patch: 'patch-line\n'.repeat(200), password: 'DUMMY_SECRET_ONLY', diagnostics: 'Bearer secret-token-value' }, isError: false };
  });
  const second = await createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => {
    executions++;
    return { response: { ok: false }, isError: true };
  });
  assert.equal(executions, 1);
  assert.equal(first.disposition, 'executed');
  assert.equal(second.disposition, 'replayed');
  assert.equal(second.source, 'persistent');
  assert.equal(second.value.response.patch, first.value.response.patch);
  assert.equal(second.value.response.patch, 'patch-line\n'.repeat(200));
  assert.equal(second.value.response.password, '[REDACTED]');
  assert.equal(second.value.response.diagnostics, 'Bearer [REDACTED]');
}));

test('workspace write tier is persisted as safe metadata and remains part of idempotency', async () => withLedgerDir(async directory => {
  const ledger = createRequestLedger(directory);
  const input = { requestId: 'write-tier', access: 'workspace-write', tier: 'T1', tierDeclaration: 'raw declaration must not persist', task: { role: 'worker', objective: 'synthetic task must not persist' } };
  const first = await ledger.execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => ({ ok: true }));
  const entryDir = join(directory, readdirSync(directory).find(name => /^[a-f0-9]{64}$/.test(name)));
  const startedText = readFileSync(join(entryDir, 'started.json'), 'utf8');
  const finalText = readFileSync(join(entryDir, 'final.json'), 'utf8');
  const started = JSON.parse(startedText);
  const final = JSON.parse(finalText);
  assert.equal(started.tier, 'T1');
  assert.equal(final.tier, 'T1');
  assert.ok(!startedText.includes('raw declaration must not persist'));
  assert.ok(!finalText.includes('raw declaration must not persist'));
  assert.ok(!startedText.includes('synthetic task must not persist'));
  assert.ok(!finalText.includes('synthetic task must not persist'));
  const replay = await createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => assert.fail('replay must not execute'));
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.value, first.value);
  const changed = { ...input, tier: 'T2' };
  await assert.rejects(
    createRequestLedger(directory).execute({ requestId: changed.requestId, operation: 'dispatch_subagent', input: changed }, async () => ({ ok: true })),
    error => error instanceof RequestLedgerError && error.code === 'idempotency_key_reused',
  );
}));

test('same requestId with a different write envelope is rejected', async () => withLedgerDir(async directory => {
  const ledger = createRequestLedger(directory);
  const first = { requestId: 'write-conflict', access: 'workspace-write', task: { role: 'worker', objective: 'first' } };
  await ledger.execute({ requestId: first.requestId, operation: 'dispatch_subagent', input: first }, async () => ({ ok: true }));
  const changed = { ...first, task: { ...first.task, objective: 'second' } };
  await assert.rejects(
    createRequestLedger(directory).execute({ requestId: changed.requestId, operation: 'dispatch_subagent', input: changed }, async () => ({ ok: true })),
    error => error instanceof RequestLedgerError && error.code === 'idempotency_key_reused',
  );
}));

test('a started write without completion is blocked as indeterminate', async () => withLedgerDir(async directory => {
  let release;
  const input = { requestId: 'write-running', access: 'workspace-write', task: { role: 'worker', objective: 'slow' } };
  const first = createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, () => new Promise(resolvePromise => { release = resolvePromise; }));
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await assert.rejects(
    createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => ({ ok: true })),
    error => error instanceof RequestLedgerError && error.code === 'idempotency_in_doubt',
  );
  release({ ok: true });
  await first;
}));

test('host verification is durable, projects awaiting then completed, and preserves its original evidence', async () => withLedgerDir(async directory => {
  const directoryEntry = createRequestLedger(directory);
  const workerResult = {status:'completed',result:'worker implementation',evidence:['patch validated'],changedFiles:['src.js'],assumptions:[],uncertainty:[],errors:[],nextAction:'host verification',deliverable:{summary:'worker result',changes:['src.js'],checks:[{name:'npm test',outcome:'unverified',evidence:'not run by worker'}]}};
  const originalResult = {status:'completed', response:{ok:true}, structuredResult:workerResult};
  const workspaceSha256=createHash('sha256').update('/workspace').digest('hex');
  const template={version:2,role:'Chesed',stage:'implementing',mode:'linked',parentRunId:'parent',workspaceSha256,resultSha256:resultDigest(workerResult),handoffVersion:2,runAnchorSha256:'b'.repeat(64),phaseIndex:1};
  const pendingInput = {requestId:'host-pass', artifactSha256:'a'.repeat(64), resultSha256:hostRecordDigest(originalResult), workspace:'/workspace', parentRunId:'parent', goal:'verify patch', phase:1, requiredCheckNames:['npm test']};
  directoryEntry.saveMonitorResult('host-pass',{state:'completed',result:{status:'completed',patch:'stale unverified cache'}});
  directoryEntry.registerHostPending(pendingInput,{originalResult,contractTemplate:template});
  assert.equal(directoryEntry.getOutcome('host-pass').state,'awaiting-host-verification');
  assert.equal(directoryEntry.readMonitorResult('host-pass').state,'awaiting-host-verification');
  assert.equal(directoryEntry.readMonitorResult('host-pass').result.status,'awaiting-host-verification');
  assert.notEqual(directoryEntry.readMonitorResult('host-pass').result.patch,'stale unverified cache');
  assert.equal(directoryEntry.getEffectiveResult('host-pass').ok,false);
  assert.equal(directoryEntry.getEffectiveResult('host-pass').status,'awaiting-host-verification');
  assert.equal(directoryEntry.listHostPending().length,1);
  const submission={requestId:'host-pass',artifactSha256:'a'.repeat(64),commands:[{checkName:'npm test',command:'npm test',exitCode:0,outputSummary:'tests passed'}]};
  const record=directoryEntry.recordHostVerification(submission);
  assert.equal(record.outcome,'completed');
  const reopened=createRequestLedger(directory);
  assert.equal(reopened.getOutcome('host-pass').state,'completed');
  assert.equal(reopened.getEffectiveResult('host-pass').hostEvidence[0].checkName,'npm test');
  assert.equal(reopened.readMonitorResult('host-pass').state,'completed');
  assert.equal(reopened.readMonitorResult('host-pass').result.hostEvidence[0].checkName,'npm test');
  assert.equal(reopened.getEffectiveResult('host-pass').status,'completed');
  assert.equal(reopened.getEffectiveResult('host-pass').state,'completed');
  assert.equal(reopened.getEffectiveResult('host-pass').ok,true);
  assert.equal(reopened.getEffectiveResult('host-pass').failure,null);
  assert.deepEqual(reopened.recordHostVerification(submission),record);
  const ref={requestId:'host-pass',artifactSha256:pendingInput.artifactSha256,recordSha256:record.recordSha256};
  assert.deepEqual(reopened.getHostVerification(ref),record);
  assert.equal(reopened.getHostVerification({requestId:ref.requestId,artifactSha256:ref.artifactSha256}),null);
  assert.equal(reopened.getEffectiveResult('host-pass').contract.resultSha256,resultDigest(reopened.getEffectiveResult('host-pass').structuredResult));
  assert.equal(reopened.getEffectiveResult('host-pass').contract.role,'Chesed');
  assert.equal(reopened.getEffectiveResult('host-pass').hostVerification.state,'completed');
  assert.equal(reopened.getEffectiveResult('host-pass').hostVerification.recordSha256,record.recordSha256);
  assert.equal(reopened.getEffectiveResult('host-pass').verificationSource,'host');
  assert.equal(reopened.getEffectiveResult('host-pass').verifiedArtifactSha256,ref.artifactSha256);
  assert.equal(reopened.recordHostVerification(submission).timestamp,record.timestamp);
  assert.equal(reopened.getHostVerification({...ref,extra:true}),null);
  assert.equal(reopened.getHostVerification({...ref,recordSha256:'b'.repeat(64)}),null);
  assert.equal(JSON.parse(readFileSync(join(directory,'host-verification',createHashForTest('host-pass'),'original.json'),'utf8')).result.structuredResult.result,originalResult.structuredResult.result);
  assert.throws(()=>reopened.recordHostVerification({...submission,commands:[{...submission.commands[0],exitCode:1}]}),e=>e.code==='host_verification_conflict');
  const originalPath=join(directory,'host-verification',createHashForTest('host-pass'),'original.json');
  const originalBytes=readFileSync(originalPath,'utf8');
  const changedTemplate={...template,runAnchorSha256:'c'.repeat(64)};
  const stored=JSON.parse(originalBytes); stored.contractTemplate=changedTemplate;
  writeFileSync(originalPath,JSON.stringify(stored)+'\n');
  assert.equal(reopened.getEffectiveResult('host-pass'),null);
  assert.equal(reopened.readMonitorResult('host-pass').state,'indeterminate');
  assert.equal(reopened.getHostVerification(ref),null);
  assert.notEqual(readFileSync(originalPath,'utf8'),originalBytes);
}));

function createHashForTest(value) { return createHash('sha256').update(value).digest('hex'); }

test('host template tier metadata rejects inconsistent profiles, flags, and arithmetic while legacy remains valid', async () => withLedgerDir(async directory => {
  const ledger=createRequestLedger(directory), originalResult={response:{ok:true}};
  const workspaceSha256=createHash('sha256').update('/workspace').digest('hex');
  const base={version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,workspaceSha256,resultSha256:'d'.repeat(64)};
  const metadata={tier:'T1',reviewPending:true,reviewRequirement:'independent post-review required',files:1,addedLines:1,deletedLines:0,estimatedLines:1,baseTier:'T0',riskProfile:'standard',semanticRisks:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},tierPolicyVersion:1};
  const pendingFor=id=>({requestId:id,artifactSha256:'a'.repeat(64),resultSha256:hostRecordDigest(originalResult),workspace:'/workspace',parentRunId:null,goal:'check',phase:1,requiredCheckNames:['test']});
  ledger.registerHostPending(pendingFor('legacy-template'),{originalResult,contractTemplate:base});
  ledger.registerHostPending(pendingFor('legacy-three-tier-fields'),{originalResult,contractTemplate:{...base,tier:'T0',reviewPending:false,reviewRequirement:'none'}});
  assert.throws(()=>ledger.registerHostPending(pendingFor('unmarked-full-tier'),{originalResult,contractTemplate:{...base,...metadata,tierPolicyVersion:undefined}}),e=>e.code==='host_contract_template_invalid');
  for (const [index,patch] of [
    {tier:'T0',reviewPending:false,reviewRequirement:'none',riskProfile:'critical'},
    {riskProfile:'personal',tier:'T2'},
    {semanticRisks:{...metadata.semanticRisks,migration:true}},
    {estimatedLines:9},
    {unknown:'fake'},
    {semanticRisks:{...metadata.semanticRisks,migration:'yes'}},
    {files:-1},
  ].entries()) {
    assert.throws(()=>ledger.registerHostPending(pendingFor(`invalid-meta-${index}`),{originalResult,contractTemplate:{...base,...metadata,...patch}}),e=>e.code==='host_contract_template_invalid');
  }
}));

test('host verification derives failure and rejects missing or mismatched bindings', async () => withLedgerDir(async directory => {
  const ledger=createRequestLedger(directory), originalResult={response:{ok:true}};
  const workspaceSha256=createHash('sha256').update('/workspace').digest('hex');
  const contractTemplate={version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,workspaceSha256,resultSha256:'d'.repeat(64)};
  const input={requestId:'host-fail',artifactSha256:'c'.repeat(64),resultSha256:hostRecordDigest(originalResult),workspace:'/workspace',parentRunId:null,goal:'check',phase:2,requiredCheckNames:['build','tests']};
  assert.throws(()=>ledger.registerHostPending(input,{originalResult}),e=>e.code==='host_contract_template_invalid');
  ledger.registerHostPending(input,{originalResult,contractTemplate});
  assert.throws(()=>ledger.recordHostVerification({requestId:input.requestId,artifactSha256:input.artifactSha256,commands:[{checkName:'build',command:'npm run build',exitCode:0,outputSummary:'ok'}]}),e=>e.code==='incomplete_checks');
  assert.throws(()=>ledger.recordHostVerification({requestId:input.requestId,artifactSha256:'d'.repeat(64),commands:[]}),e=>e.code==='binding_mismatch');
  const record=ledger.recordHostVerification({requestId:input.requestId,artifactSha256:input.artifactSha256,commands:[{checkName:'build',command:'npm run build',exitCode:0,outputSummary:'ok'},{checkName:'tests',command:'npm test',exitCode:2,outputSummary:'failed'}]});
  assert.equal(record.outcome,'failed');
  assert.equal(ledger.getEffectiveResult(input.requestId).hostVerification.state,'failed');
  assert.equal(ledger.getEffectiveResult(input.requestId).hostVerification.recordSha256,record.recordSha256);
  assert.equal(ledger.getOutcome(input.requestId).state,'failed');
  assert.equal(ledger.getOutcome('foreign').state,'pending');
}));

test('host verification rejects damaged source and treats an existing invalid attestation as indeterminate', async () => withLedgerDir(async directory => {
  const ledger=createRequestLedger(directory);
  const requestId='host-integrity', artifactSha256='e'.repeat(64);
  const worker={status:'completed',result:'worker implementation',evidence:['patch'],changedFiles:['src.js'],assumptions:[],uncertainty:[],errors:[],nextAction:'verify',deliverable:{summary:'done',changes:['src.js'],checks:[{name:'test',outcome:'unverified',evidence:'not run'}]}};
  const originalResult={response:{ok:true},structuredResult:worker};
  const template={version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,workspaceSha256:createHash('sha256').update('/workspace').digest('hex'),resultSha256:'f'.repeat(64)};
  const input={requestId,artifactSha256,resultSha256:hostRecordDigest(originalResult),workspace:'/workspace',parentRunId:null,goal:'verify',phase:1,requiredCheckNames:['test']};
  ledger.registerHostPending(input,{originalResult,contractTemplate:template});
  const dir=join(directory,'host-verification',createHashForTest(requestId));
  const originalPath=join(dir,'original.json');
  const original=JSON.parse(readFileSync(originalPath,'utf8'));
  original.result.response.ok=false;
  writeFileSync(originalPath,JSON.stringify(original)+'\n');
  const submission={requestId,artifactSha256,commands:[{checkName:'test',command:'npm test',exitCode:0,outputSummary:'ok'}]};
  assert.throws(()=>ledger.recordHostVerification(submission),e=>e.code==='host_original_integrity');
  original.result=originalResult;
  original.contractTemplate={...template,resultSha256:'0'.repeat(64)};
  writeFileSync(originalPath,JSON.stringify(original)+'\n');
  assert.throws(()=>ledger.recordHostVerification(submission),e=>e.code==='host_template_integrity');
  assert.equal(readdirSync(dir).includes('attestation.json'),false);
}));

test('tampered existing host attestation is indeterminate, not awaiting', async () => withLedgerDir(async directory => {
  const ledger=createRequestLedger(directory), requestId='host-tamper', artifactSha256='a'.repeat(64);
  const originalResult={response:{ok:true}};
  const template={version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,workspaceSha256:createHash('sha256').update('/workspace').digest('hex'),resultSha256:'d'.repeat(64)};
  const input={requestId,artifactSha256,resultSha256:hostRecordDigest(originalResult),workspace:'/workspace',parentRunId:null,goal:'verify',phase:1,requiredCheckNames:['test']};
  ledger.registerHostPending(input,{originalResult,contractTemplate:template});
  const record=ledger.recordHostVerification({requestId,artifactSha256,commands:[{checkName:'test',command:'npm test',exitCode:0,outputSummary:'ok'}]});
  const path=join(directory,'host-verification',createHashForTest(requestId),'attestation.json');
  const tampered=JSON.parse(readFileSync(path,'utf8')); tampered.outcome='failed'; writeFileSync(path,JSON.stringify(tampered)+'\\n');
  assert.equal(createRequestLedger(directory).getEffectiveResult(requestId),null);
  assert.equal(createRequestLedger(directory).getOutcome(requestId).state,'indeterminate');
  assert.ok(record.recordSha256);
}));

test('durable Netzach fallback projects only a bound real-role fixture and detects proof tampering', async () => withLedgerDir(async directory => {
  const ledger=createRequestLedger(directory), requestId='verifier-fallback-case', artifactSha256='a'.repeat(64), workspace='/workspace';
  const worker=roleValue('Chesed','synthetic implementation fixture');
  worker.status='unverified';
  worker.deliverable.checks=[{name:'host-evidence',outcome:'unverified',evidence:'Host execution unavailable in scope-enforced sandbox; host must run command.'},{name:'verifier-fallback',outcome:'unverified',evidence:'Host execution unavailable in scope-enforced sandbox; host must run command.'}];
  const originalResult={status:'completed',response:{ok:true},structuredResult:worker};
  const workspaceSha256=createHash('sha256').update(workspace).digest('hex');
  const contractTemplate={version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,workspaceSha256,resultSha256:resultDigest(worker),tier:'T0',reviewPending:false,reviewRequirement:'none',files:1,addedLines:1,deletedLines:0,estimatedLines:1,baseTier:'T0',riskProfile:'standard',semanticRisks:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},tierPolicyVersion:1};
  const pending={requestId,artifactSha256,resultSha256:hostRecordDigest(originalResult),workspace,parentRunId:null,goal:'synthetic actual-role fixture',phase:1,requiredCheckNames:['host-evidence','verifier-fallback']};
  ledger.registerHostPending(pending,{originalResult,contractTemplate});
  assert.equal(ledger.getHostArtifact('not-pending'),null);
  assert.deepEqual(Object.keys(ledger.getHostArtifact(requestId)).sort(),['contractTemplate','originalResult','pending'].sort());
  assert.equal(ledger.getHostArtifact(requestId).contractTemplate.tier,'T0');
  const verifier=roleValue('Netzach','synthetic actual-role fixture verdict');
  verifier.deliverable.checks=[{name:'host-evidence',outcome:'passed',evidence:'Synthetic fixture confirms host check.'},{name:'verifier-fallback',outcome:'passed',evidence:'Synthetic fixture confirms fallback check.'}];
  const verifierContract={version:2,role:'Netzach',stage:'verifying',mode:'standalone',parentRunId:null,workspaceSha256,resultSha256:resultDigest(verifier),verificationOfRequestId:requestId,artifactSha256};
  const input={implementationRequestId:requestId,verifierRequestId:'netzach-fixture-1',parentRunId:null,workspaceSha256,artifactSha256,verifierContract,verifierResult:verifier};
  for (const bad of [
    {...input,artifactSha256:'b'.repeat(64)},
    {...input,parentRunId:'wrong-parent'},
    {...input,workspaceSha256:'b'.repeat(64)},
    {...input,verifierContract:{...verifierContract,role:'Chesed'}},
    {...input,verifierResult:{...verifier,errors:['unrelated verifier error']}},
    {...input,verifierResult:{...verifier,deliverable:{...verifier.deliverable,checks:[{...verifier.deliverable.checks[0],hostEvidence:{requestId,artifactSha256,recordSha256:'d'.repeat(64),checkName:'host-evidence'}},verifier.deliverable.checks[1]]}}},
    {...input,verifierContract:{...verifierContract,verificationOfRequestId:'other'}},
    {...input,verifierResult:{...verifier,deliverable:{...verifier.deliverable,checks:[{...verifier.deliverable.checks[0],outcome:'failed'},verifier.deliverable.checks[1]]}}},
    {...input,verifierResult:{...verifier,deliverable:{...verifier.deliverable,checks:[{...verifier.deliverable.checks[0],evidence:''},verifier.deliverable.checks[1]]}}},
    {...input,verifierResult:{...verifier,deliverable:{...verifier.deliverable,checks:[verifier.deliverable.checks[0]]}}},
  ]) assert.throws(()=>ledger.recordVerifierVerification(bad));
  const record=ledger.recordVerifierVerification(input);
  assert.equal(record.artifactSha256,artifactSha256);
  assert.deepEqual(ledger.recordVerifierVerification(input),record);
  const reopened=createRequestLedger(directory), effective=reopened.getEffectiveResult(requestId);
  assert.equal(effective.state,'completed');
  assert.equal(effective.ok,true);
  assert.equal(effective.verificationSource,'netzach');
  assert.equal(effective.verifierRequestId,'netzach-fixture-1');
  assert.equal(effective.verifierProofSha256,record.recordSha256);
  assert.equal(effective.verifiedArtifactSha256,artifactSha256);
  assert.deepEqual(effective.hostVerification,{state:'completed',artifactSha256,recordSha256:record.recordSha256,requiredCheckNames:['host-evidence','verifier-fallback'],source:'netzach'});
  assert.equal(Object.hasOwn(effective,'hostEvidence'),false);
  assert.equal(effective.structuredResult.status,'completed');
  assert.equal(effective.contract.resultSha256,resultDigest(effective.structuredResult));
  assert.throws(()=>reopened.recordHostVerification({requestId,artifactSha256,commands:[{checkName:'host-evidence',command:'npm test',exitCode:0,outputSummary:'tests passed'},{checkName:'verifier-fallback',command:'npm test',exitCode:0,outputSummary:'tests passed'}]}),e=>e.code==='host_verification_conflict');
  const verifierPath=join(directory,'host-verification',createHashForTest(requestId),'verifier.json');
  const tampered=JSON.parse(readFileSync(verifierPath,'utf8')); tampered.artifactSha256='c'.repeat(64); writeFileSync(verifierPath,JSON.stringify(tampered)+'\n');
  assert.equal(reopened.getEffectiveResult(requestId),null);
  assert.equal(reopened.getOutcome(requestId).state,'indeterminate');
}));

test('monitor result cache restores only identity- and digest-verified records across ledger instances', async()=>withLedgerDir(async directory=>{
  const ledger=createRequestLedger(directory), value={status:'completed',patch:'issued credential patch',patchPolicy:'issued-credential-v1',password:'DUMMY_SECRET_ONLY'};
  assert.equal(ledger.saveMonitorResult('cache-id',{state:'completed',result:value}),true);
  const reopened=createRequestLedger(directory), loaded=reopened.readMonitorResult('cache-id');
  assert.equal(loaded.state,'completed');
  assert.equal(loaded.result.patch,value.patch);
  assert.equal(loaded.result.password,'[REDACTED]');
  const path=join(directory,'result-cache',createHashForTest('cache-id')+'.json');
  const tampered=JSON.parse(readFileSync(path,'utf8')); tampered.requestId='other'; writeFileSync(path,JSON.stringify(tampered)+'\\n');
  assert.equal(reopened.readMonitorResult('cache-id'),null);
}));

test('monitor result survives TTL release through the bounded persistent ledger cache', async()=>withLedgerDir(async directory=>{
  const {createTaskMonitor}=await import('../extensions/task-monitor.js');
  const ledger=createRequestLedger(directory), id='monitor-disk-recovery';
  const monitor=createTaskMonitor({gatewayInstanceId:'gateway-disk',terminalTtlMs:0,maintenanceIntervalMs:0,persistResult:(requestId,value)=>ledger.saveMonitorResult(requestId,value),loadResult:requestId=>ledger.readMonitorResult(requestId)});
  monitor.submit({requestId:id,task:{role:'worker',objective:'disk recovery'}},async(_signal,running)=>{running();return {response:{ok:true,status:'completed',patch:'full persisted patch',toolsUsed:[]},isError:false};});
  for(let i=0;i<50&&monitor.size;i++) await new Promise(resolvePromise=>setImmediate(resolvePromise));
  assert.equal(monitor.size,0);
  const recovered=monitor.getResult(id);
  assert.equal(recovered.ok,true);
  assert.equal(recovered.result.patch,'full persisted patch');
  monitor.close();
}));

test('ledger retention removes expired completed records but preserves newer critical state', async () => withLedgerDir(async directory => {
  const ledger = createRequestLedger(directory, { retention: { completedDays: 1, criticalDays: 90, totalBytes: 1024 * 1024 } });
  const input = { requestId: 'old-completed', access: 'workspace-write', task: { role: 'worker', objective: 'done' } };
  await ledger.execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => ({ response: { ok: true } }));
  ledger.recordOutcome('new-failed', { ok: false });
  const result = ledger.prune(Date.now() + 2 * 86_400_000);
  assert.ok(result.deletedEntries >= 1);
  assert.equal(ledger.getOutcome('old-completed').state, 'pending');
  assert.equal(ledger.getOutcome('new-failed').state, 'failed');
}));

// Synthetic captured artifacts only; no real gateway history or worker credentials are used.
function privateApplyFixture(directory, {shape='response',flag=true,patch="--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+Bearer synthetic-one\n",mutate=()=>{}}={}) {
  const requestId='private-apply-fixture', artifactSha256=createHashForTest(patch), workspace=directory;
  const response={ok:true,patch,patchPolicy:'issued-credential-v1',patchSha256:artifactSha256,patchBytes:Buffer.byteLength(patch),secretLikeContent:flag,patchConfirmationRequired:flag,trustedWriteScope:['x'],patchValidation:{ok:true,requestId,jobId:'123e4567-e89b-42d3-a456-426614174000',format:'relative-a-b-v1',changedFiles:['x'],patchSha256:artifactSha256,scopeSha256:createHashForTest('file:x')},diagnostics:'Bearer diagnostic-only',nested:{password:'synthetic-password',patch:'Bearer nested-only'}};
  const originalResult=shape==='response'?{response,patch:'Bearer noncanonical-only'}:response;
  mutate(originalResult,response);
  const ledger=createRequestLedger(directory);
  ledger.registerHostPending({requestId,artifactSha256,resultSha256:hostRecordDigest(originalResult),workspace,parentRunId:null,goal:'synthetic private apply regression',phase:1,requiredCheckNames:['fixture-check']},{originalResult,contractTemplate:{version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,workspaceSha256:createHashForTest(workspace),resultSha256:'a'.repeat(64)}});
  return {ledger,requestId,response,patch,originalResult,originalPath:join(directory,'host-verification',createHashForTest(requestId),'original.json')};
}

test('private apply getter preserves bound bytes and warnings while generic/model-facing view stays redacted',async()=>{
  for(const shape of ['root','response'])for(const flag of [false,true])await withLedgerDir(async directory=>{
    const patch=flag?"\ufeff--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-old\r\n+const x = 'Bearer synthetic-one'; // café �\r\n":"\ufeff--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-old\r\n+café �\r\n";
    const f=privateApplyFixture(directory,{shape,flag,patch}), before=readFileSync(f.originalPath);
    for(const ledger of [f.ledger,createRequestLedger(directory,{readOnly:true})]){
      const artifact=ledger.getHostApplyArtifact(f.requestId), record=artifact.originalResult.response??artifact.originalResult;
      assert.equal(record.patch,patch);assert.deepEqual(Buffer.from(record.patch),Buffer.from(patch));
      assert.equal(record.patchSha256,artifact.pending.artifactSha256);assert.equal(record.patchBytes,Buffer.byteLength(patch));
      assert.equal(record.patchPolicy,'issued-credential-v1');assert.equal(record.secretLikeContent,flag);assert.equal(record.patchConfirmationRequired,flag);
      assert.equal(record.diagnostics,'Bearer [REDACTED]');assert.equal(record.nested.password,'[REDACTED]');assert.equal(record.nested.patch,'Bearer [REDACTED]');
      if(shape==='response')assert.equal(artifact.originalResult.patch,'Bearer [REDACTED]');
      const generic=ledger.getHostArtifact(f.requestId), ordinary=generic.originalResult.response??generic.originalResult;
      assert.equal(ordinary.patch,sanitizeResult(patch));
      // This is the exact unchanged gateway fallback serialization when structuredResult is absent.
      const modelContext=JSON.stringify(generic.originalResult.structuredResult??generic.originalResult);
      if(flag){assert.notEqual(ordinary.patch,patch);assert.equal(modelContext.includes('synthetic-one'),false);}
      record.patch='mutated';record.patchValidation.patchSha256='0'.repeat(64);
      assert.equal((ledger.getHostApplyArtifact(f.requestId).originalResult.response??ledger.getHostApplyArtifact(f.requestId).originalResult).patch,patch);
    }
    assert.deepEqual(readFileSync(f.originalPath),before);
    assert.equal(f.ledger.getEffectiveResult(f.requestId).state,'awaiting-host-verification');
  });
});

test('private apply getter rejects raw hash tamper even when sanitized record digest collides',async()=>withLedgerDir(async directory=>{
  const f=privateApplyFixture(directory), stored=JSON.parse(readFileSync(f.originalPath,'utf8'));
  const originalDigest=hostRecordDigest(stored.result);
  stored.result.response.patch=stored.result.response.patch.replace('synthetic-one','synthetic-two');
  assert.equal(hostRecordDigest(stored.result),originalDigest,'regression must exercise sanitized digest collision');
  writeFileSync(f.originalPath,JSON.stringify(stored));
  assert.ok(f.ledger.getHostArtifact(f.requestId),'old generic integrity check alone cannot catch this');
  assert.equal(f.ledger.getHostApplyArtifact(f.requestId),null);
}));

test('private apply getter fails closed for malformed metadata, legacy policies, missing bindings and invalid UTF8',async()=>{
  const cases=[
    r=>{r.patchSha256='a'.repeat(64);},r=>{r.patchBytes+=1;},r=>{r.patchBytes='1';},
    r=>{r.secretLikeContent='true';},r=>{delete r.secretLikeContent;},r=>{r.patchValidation.ok=false;},
    r=>{r.patchValidation.requestId='wrong';},r=>{r.patchValidation.patchSha256='a'.repeat(64);},
    r=>{delete r.patchValidation;},r=>{r.patchPolicy='unknown-policy';},
    r=>{r.patch='\ud800';r.patchSha256=createHashForTest(r.patch);r.patchBytes=Buffer.byteLength(r.patch);r.patchValidation.patchSha256=r.patchSha256;},
  ];
  for(const change of cases)await withLedgerDir(async directory=>{
    const f=privateApplyFixture(directory,{mutate:(_original,r)=>change(r)});
    assert.equal(f.ledger.getHostApplyArtifact(f.requestId),null);assert.equal(f.ledger.getHostApplyArtifact('unknown'),null);
  });
  for(const policy of ['legacy',undefined])await withLedgerDir(async directory=>{
    const f=privateApplyFixture(directory,{mutate:(_original,r)=>{if(policy)r.patchPolicy=policy;else delete r.patchPolicy;}});
    assert.deepEqual(f.ledger.getHostApplyArtifact(f.requestId),f.ledger.getHostArtifact(f.requestId),'legacy must retain redacted compatibility without raw restoration');
    assert.equal(JSON.stringify(f.ledger.getHostApplyArtifact(f.requestId)).includes('synthetic-one'),false);
  });
  for(const field of ['pending.json','original.json'])await withLedgerDir(async directory=>{
    const f=privateApplyFixture(directory), file=join(directory,'host-verification',createHashForTest(f.requestId),field);
    const value=JSON.parse(readFileSync(file,'utf8'));
    if(field==='pending.json')value.artifactSha256='a'.repeat(64);else value.contractTemplate.workspaceSha256='a'.repeat(64);
    writeFileSync(file,JSON.stringify(value));assert.equal(f.ledger.getHostApplyArtifact(f.requestId),null);
  });
});

test('private getter integrates with real Git: safe apply, flagged refusal and failed check leaves files unchanged',async()=>{
  for(const mode of ['safe','flagged','conflict','tampered'])await withLedgerDir(async directory=>{
    execFileSync('git',['init','-q'],{cwd:directory});
    const patch=mode==='flagged'?"--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+Bearer synthetic-one\n":"--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
    const f=privateApplyFixture(directory,{patch,flag:mode==='flagged'});
    writeFileSync(join(directory,'x'),mode==='conflict'?'conflict\n':'old\n');
    const initial=readFileSync(join(directory,'x')),storedBefore=readFileSync(f.originalPath);let spawned=0,releases=0;
    if(mode==='tampered'){const stored=JSON.parse(storedBefore);stored.result.response.patchValidation.patchSha256='a'.repeat(64);writeFileSync(f.originalPath,JSON.stringify(stored));}
    const result=await applyArtifact({requestId:f.requestId,ledger:f.ledger,roots:[directory],writeLocks:{tryAcquire:()=>({}),release:()=>{releases++;}},spawnFn:(...args)=>{spawned++;return spawn(...args);}});
    if(mode==='safe'){assert.equal(result.ok,true);assert.deepEqual(result.changedFiles,['x']);assert.equal(readFileSync(join(directory,'x'),'utf8'),'new\n');assert.equal(spawned,2);assert.equal(releases,1);}
    else {assert.equal(result.ok,false);assert.deepEqual(readFileSync(join(directory,'x')),initial);assert.equal(spawned,mode==='conflict'?1:0);if(mode==='flagged')assert.equal(result.code,'secret_content_confirmation_required');if(mode==='tampered')assert.equal(result.code,'artifact_not_pending');}
    if(mode!=='tampered')assert.deepEqual(readFileSync(f.originalPath),storedBefore);
    if(mode==='tampered')assert.equal(f.ledger.getEffectiveResult(f.requestId),null);
    else assert.equal(f.ledger.getEffectiveResult(f.requestId).state,'awaiting-host-verification');
  });
});

test('apply consumer never falls back to the generic projection after a present private getter rejects',async()=>{
  let genericReads=0,spawned=0;
  const result=await applyArtifact({requestId:'private-reject',ledger:{getHostApplyArtifact:()=>null,getHostArtifact:()=>{genericReads++;throw Error('must not fallback');}},spawnFn:()=>{spawned++;throw Error('must not spawn');}});
  assert.equal(result.code,'artifact_not_pending');assert.equal(genericReads,0);assert.equal(spawned,0);
});
