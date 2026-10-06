import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequestLedger, requestDigest, RequestLedgerError } from '../extensions/request-ledger.js';
import { hostRecordDigest } from '../extensions/host-verification.js';
import { resultDigest } from '../extensions/role-contract.js';
import { roleValue } from './contract-fixtures.mjs';

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
