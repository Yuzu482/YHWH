import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {listenHttpFixture} from './http-fixture.mjs';
import {roleValue} from './contract-fixtures.mjs';
import {resultDigest} from '../extensions/role-contract.js';
import {createRequestLedger,projectEffectiveResult,inspectHostCompletionCapacity} from '../extensions/request-ledger.js';
import {hostRecordDigest,createHostPending,HOST_VERIFICATION_LIMITS as H} from '../extensions/host-verification.js';
import {DATA_CAPACITY as C} from '../extensions/data-capacity.js';
import {sanitizeCapturedResult,exportResult} from '../extensions/result-export.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const withDir=async fn=>{const d=mkdtempSync(join(tmpdir(),'pi-capacity-'));try{return await fn(d);}finally{rmSync(d,{recursive:true,force:true});}};
function fixture(padding='') {
  const patch='--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n';
  const originalResult={requestId:'capacity-host',patch,patchSha256:sha(patch),patchPolicy:'issued-credential-v1',padding,structuredResult:roleValue('Chesed')};
  const contractTemplate={version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,workspaceSha256:sha('/workspace'),resultSha256:'a'.repeat(64)};
  const input={requestId:originalResult.requestId,artifactSha256:sha(patch),resultSha256:hostRecordDigest(originalResult),workspace:'/workspace',parentRunId:null,goal:'capacity regression',phase:1,requiredCheckNames:['fixture check']};
  return {originalResult,contractTemplate,input};
}

// Historical-format fixtures in isolated ledgers only; never production records.
function legacyPending(d,f) {
  const pending=createHostPending({...f.input,contractTemplateSha256:hostRecordDigest(f.contractTemplate)});
  const p=join(d,'host-verification',sha(f.input.requestId));mkdirSync(p,{recursive:true});
  writeFileSync(join(p,'original.json'),JSON.stringify({result:sanitizeCapturedResult(f.originalResult,{mode:'capture'}),contractTemplate:f.contractTemplate})+'\n');
  writeFileSync(join(p,'pending.json'),JSON.stringify(pending)+'\n');
  return pending;
}
function reserveFor(f) {
  return inspectHostCompletionCapacity({result:sanitizeCapturedResult(f.originalResult,{mode:'capture'}),contractTemplate:f.contractTemplate},
    createHostPending({...f.input,contractTemplateSha256:hostRecordDigest(f.contractTemplate)}));
}

test('new pending reserves exact maximum host-proof envelope; one unit over rejects before apply',async()=>withDir(async d=>{
  for(const count of [1,H.maxCommands]) {
    const f=fixture();f.input.requiredCheckNames=Array.from({length:count},(_,i)=>'check-'+i);
    const initial=reserveFor(f);
    f.originalResult.padding='x'.repeat(C.fullResultMaxUtf16Units-initial.actual);
    f.input.resultSha256=hostRecordDigest(f.originalResult);
    const atLimit=reserveFor(f);assert.equal(atLimit.actual,C.fullResultMaxUtf16Units);assert.equal(atLimit.remainingUnits,0);
    assert.equal(atLimit.checkCount,count);assert.equal(atLimit.completedProjectionComputable,true);
    const ledger=createRequestLedger(join(d,'equal-'+count));ledger.registerHostPending(f.input,f);
    const commands=f.input.requiredCheckNames.map(checkName=>({checkName,command:'\u0001'.repeat(H.commandUtf16Units),exitCode:0,outputSummary:'\u0001'.repeat(H.outputUtf16Units)}));
    const record=ledger.recordHostVerification({requestId:f.input.requestId,artifactSha256:f.input.artifactSha256,commands});
    assert.equal(record.outcome,'completed');const result=ledger.getEffectiveResult(f.input.requestId);
    assert.equal(exportResult(result).totalLength,C.fullResultMaxUtf16Units);
    assert.deepEqual(createRequestLedger(join(d,'equal-'+count)).getEffectiveResult(f.input.requestId),result);
    f.originalResult.padding+='x';f.input.resultSha256=hostRecordDigest(f.originalResult);
    const rejected=createRequestLedger(join(d,'over-'+count));
    assert.throws(()=>rejected.registerHostPending(f.input,f),e=>e.code==='PI_RESULT_CAPACITY_EXCEEDED'&&e.location==='host.completionReserve'&&e.actual===C.fullResultMaxUtf16Units+1&&e.reservation.checkCount===count);
    assert.deepEqual(readdirSync(join(d,'over-'+count,'host-verification')),[]);
  }
}));

test('reserve covers redaction and failed outcome without treating a null completed projection as zero',async()=>withDir(async d=>{
  const f=fixture(),ledger=createRequestLedger(d);ledger.registerHostPending(f.input,f);const bound=reserveFor(f);
  const forms=['secret:x','Bearer x','"secret":""','a://u:p@','\u0001','😀'];
  for(const form of forms){
    const command=form.repeat(Math.floor(H.commandUtf16Units/form.length)),outputSummary=form.repeat(Math.floor(H.outputUtf16Units/form.length));
    const pending=createHostPending({...f.input,contractTemplateSha256:hostRecordDigest(f.contractTemplate)});
    const record={outcome:'completed',artifactSha256:f.input.artifactSha256,recordSha256:'f'.repeat(64),commands:[{checkName:'fixture check',command,exitCode:0,outputSummary}]};
    assert.ok(exportResult(projectEffectiveResult({result:f.originalResult,contractTemplate:f.contractTemplate},pending,{attestation:record})).totalLength<=bound.actual);
  }
  const failed=ledger.recordHostVerification({requestId:f.input.requestId,artifactSha256:f.input.artifactSha256,commands:[{checkName:'fixture check',command:'node test.mjs',exitCode:1,outputSummary:'failed'}]});
  assert.equal(failed.outcome,'failed');assert.ok(exportResult(ledger.getEffectiveResult(f.input.requestId)).totalLength<=bound.actual);
  const invalid=fixture();delete invalid.originalResult.structuredResult;
  const diagnostic=reserveFor(invalid),completed=diagnostic.projections.find(p=>p.kind==='hostCompleted');
  assert.equal(completed.computable,false);assert.equal(completed.actual,null);assert.equal(diagnostic.completedProjectionComputable,false);
  assert.ok(diagnostic.actual>0);assert.equal(diagnostic.projections.find(p=>p.kind==='hostFailed').computable,true);
}));

test('half-written original remains untouched when a new completion reservation fails',async()=>withDir(async d=>{
  const ledger=createRequestLedger(d),f=fixture(),base=reserveFor(f);
  f.originalResult.padding='x'.repeat(C.fullResultMaxUtf16Units-base.actual+1);f.input.resultSha256=hostRecordDigest(f.originalResult);
  const p=join(d,'host-verification',sha(f.input.requestId));mkdirSync(p);writeFileSync(join(p,'original.json'),'previous unique copy');
  assert.throws(()=>ledger.registerHostPending(f.input,f),e=>e.location==='host.completionReserve');
  assert.equal(readFileSync(join(p,'original.json'),'utf8'),'previous unique copy');assert.deepEqual(readdirSync(p),['original.json']);
}));

test('oversized host admission precedes directory creation and preserves ordinary archived result',async()=>withDir(async d=>{
  const ledger=createRequestLedger(d),f=fixture('x'.repeat(C.fullResultMaxUtf16Units));
  assert.equal(ledger.saveMonitorResult(f.input.requestId,{state:'failed',result:f.originalResult}),true);
  assert.throws(()=>ledger.registerHostPending(f.input,f),e=>e.code==='PI_RESULT_CAPACITY_EXCEEDED'&&e.location==='host.awaitingResult');
  assert.deepEqual(readdirSync(join(d,'host-verification')),[]);
  assert.equal(ledger.readMonitorResult(f.input.requestId).state,'failed');
  assert.equal(ledger.readMonitorResult(f.input.requestId).result.patch,f.originalResult.patch);
  assert.equal(ledger.getEffectiveResult(f.input.requestId),null);
}));

test('pure prewrite and durable postwrite projections are byte-identical after reload',async()=>withDir(async d=>{
  const ledger=createRequestLedger(d),f=fixture('漢😀"\\');
  const pending=ledger.registerHostPending(f.input,f),stored={result:sanitizeCapturedResult(f.originalResult,{mode:'capture'}),contractTemplate:f.contractTemplate};
  assert.deepEqual(projectEffectiveResult(stored,pending),ledger.getEffectiveResult(f.input.requestId));
  const submission={requestId:f.input.requestId,artifactSha256:f.input.artifactSha256,commands:[{checkName:'fixture check',command:'node test.mjs',exitCode:0,outputSummary:'host pass'}]};
  const record=ledger.recordHostVerification(submission);
  const expected=projectEffectiveResult(stored,pending,{attestation:record});
  assert.equal(JSON.stringify(expected),JSON.stringify(ledger.getEffectiveResult(f.input.requestId)));
  assert.deepEqual(createRequestLedger(d).getEffectiveResult(f.input.requestId),expected);
  assert.deepEqual(ledger.recordHostVerification(submission),record); // Same-ID proof replay, no model.
}));

test('legacy completion growth fails before writing proof; replay keeps pending and source',async()=>withDir(async d=>{
  const ledger=createRequestLedger(d),f=fixture();
  const pending=createHostPending({...f.input,contractTemplateSha256:hostRecordDigest(f.contractTemplate)});
  const projection=projectEffectiveResult({result:f.originalResult,contractTemplate:f.contractTemplate},pending);
  const projectedSize=JSON.stringify(projection).length;
  f.originalResult.padding='x'.repeat(C.fullResultMaxUtf16Units-projectedSize-200);
  f.input.resultSha256=hostRecordDigest(f.originalResult);
  const legacy=legacyPending(d,f);assert.equal(reserveFor(f).ok,false);
  assert.deepEqual(ledger.registerHostPending(f.input,f),legacy);
  const before=ledger.getEffectiveResult(f.input.requestId);
  assert.throws(()=>ledger.recordHostVerification({requestId:f.input.requestId,artifactSha256:f.input.artifactSha256,
    commands:[{checkName:'fixture check',command:'node test.mjs',exitCode:0,outputSummary:'x'.repeat(4000)}]}),
    e=>e.code==='PI_RESULT_CAPACITY_EXCEEDED'&&e.location==='host.verifiedResult');
  const hostDir=join(d,'host-verification',sha(f.input.requestId));
  assert.equal(existsSync(join(hostDir,'attestation.json')),false);
  assert.deepEqual(ledger.getEffectiveResult(f.input.requestId),before);
  assert.equal(ledger.getHostArtifact(f.input.requestId).originalResult.patch,f.originalResult.patch);
}));

test('legacy oversized awaiting results replay without new-admission checks or writes',async()=>withDir(async d=>{
  const f=fixture('x'.repeat(C.fullResultMaxUtf16Units+1)),pending=legacyPending(d,f);
  const p=join(d,'host-verification',sha(f.input.requestId));
  const before=['original.json','pending.json'].map(n=>sha(readFileSync(join(p,n))));
  assert.deepEqual(createRequestLedger(d).registerHostPending(f.input,f),pending);
  assert.deepEqual(['original.json','pending.json'].map(n=>sha(readFileSync(join(p,n)))),before);
}));

test('Netzach completion uses the same pure projection and enforces legacy final growth',async()=>withDir(async d=>{
  for(const nearLimit of [false,true]) {
    const ledger=createRequestLedger(join(d,String(nearLimit))),f=fixture();
    Object.assign(f.contractTemplate,{tier:'T1',reviewPending:true,reviewRequirement:'independent post-review required'});
    if(nearLimit){
      const projected=projectEffectiveResult({result:f.originalResult,contractTemplate:f.contractTemplate},f.input);
      f.originalResult.padding='x'.repeat(C.fullResultMaxUtf16Units-JSON.stringify(projected).length-200);
      f.input.resultSha256=hostRecordDigest(f.originalResult);
      legacyPending(join(d,String(nearLimit)),f);
    }
    const pending=ledger.registerHostPending(f.input,f),value=roleValue('Netzach');
    const verifierContract={version:2,role:'Netzach',stage:'verifying',mode:'standalone',parentRunId:null,
      workspaceSha256:f.contractTemplate.workspaceSha256,resultSha256:resultDigest(value),verificationOfRequestId:f.input.requestId,artifactSha256:f.input.artifactSha256};
    const input={implementationRequestId:f.input.requestId,verifierRequestId:'v'.repeat(128),parentRunId:null,workspaceSha256:f.contractTemplate.workspaceSha256,
      artifactSha256:f.input.artifactSha256,verifierContract,verifierResult:value};
    if(nearLimit){
      assert.throws(()=>ledger.recordVerifierVerification(input),e=>e.code==='PI_RESULT_CAPACITY_EXCEEDED'&&e.location==='host.verifierResult');
      assert.equal(existsSync(join(d,String(nearLimit),'host-verification',sha(f.input.requestId),'verifier.json')),false);
      assert.equal(ledger.getEffectiveResult(f.input.requestId).state,'awaiting-host-verification');
    }else{
      const record=ledger.recordVerifierVerification(input);
      const expected=projectEffectiveResult({result:sanitizeCapturedResult(f.originalResult,{mode:'capture'}),contractTemplate:f.contractTemplate},pending,{verifier:record});
      assert.deepEqual(ledger.getEffectiveResult(f.input.requestId),expected);
      assert.deepEqual(createRequestLedger(join(d,String(nearLimit))).getEffectiveResult(f.input.requestId),expected);
    }
  }
}));

test('shared capacity module is carried into the WSL installer module graph',()=>{
  const installer=readFileSync(resolve(root,'../../install/Install-PiKether.ps1'),'utf8');
  const provision=readFileSync(resolve(root,'../../install/provision-wsl.sh'),'utf8');
  assert.match(installer,/extensions\\data-capacity\.js.*\/tmp\/pi-kether-install\/data-capacity\.js/);
  assert.match(provision,/\/tmp\/pi-kether-install\/data-capacity\.js \/opt\/pi-kether\/extensions\/data-capacity\.js/);
});

test('sync and async persistence count exact wrapper/digest/newline and leave no failed temp',async()=>withDir(async d=>{
  const ledger=createRequestLedger(d),requestId='persistent-boundary',result={padding:''};
  ledger.saveMonitorResult(requestId,{state:'failed',result});
  const p=join(d,'result-cache',sha(requestId)+'.json');
  const overhead=readFileSync(p).length;
  result.padding='x'.repeat(C.persistentRecordMaxUtf8Bytes-overhead);
  assert.equal(ledger.saveMonitorResult(requestId,{state:'failed',result}),true);
  assert.equal(readFileSync(p).length,C.persistentRecordMaxUtf8Bytes);
  assert.equal(await ledger.saveMonitorResultAsync(requestId,{state:'failed',result}),true);
  result.padding+='x';
  const check=e=>e.code==='PI_RESULT_OVERSIZED'&&e.actual===C.persistentRecordMaxUtf8Bytes+1&&e.limit===C.persistentRecordMaxUtf8Bytes&&e.unit==='utf8-bytes'&&e.location==='persistentRecord';
  assert.throws(()=>ledger.saveMonitorResult(requestId,{state:'failed',result}),check);
  await assert.rejects(ledger.saveMonitorResultAsync(requestId,{state:'failed',result}),check);
  assert.equal(readFileSync(p).length,C.persistentRecordMaxUtf8Bytes);
  assert.ok(readdirSync(join(d,'result-cache')).every(n=>!n.endsWith('.tmp')));
}));

test('gateway capacity failure preserves executed delivery, no host pending or duplicate execution',async()=>withDir(async d=>{
  let executions=0;
  const patch='--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+new\n',requestId='capacity-gateway';
  const token='capacity-test-0123456789-0123456789-abcdef';
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[root],token,requestLedgerDir:d,
    sandboxStatus:{ok:true,backend:'wsl2-bwrap',hostMountVisible:false,windowsInterop:false,bubblewrap:true,pi:true,resourceLimits:true},
    schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5},
    dispatchFn:async()=>{executions++;const value=roleValue('Chesed');value.changedFiles=['x.js'];value.deliverable.changes=['x.js'];
      return {ok:true,requestId,provider:'openai-codex',model:'gpt-6-luna',requestedProvider:'openai-codex',requestedModel:'gpt-6-luna',exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value),patch,patchPolicy:'issued-credential-v1',padding:'x'.repeat(C.fullResultMaxUtf16Units),
        patchValidation:{ok:true,format:'relative-a-b-v1',requestId,jobId:'11111111-1111-4111-8111-111111111111',changedFiles:['x.js'],patchSha256:sha(patch),scopeSha256:sha('file:x.js')}};}});
  const http=await listenHttpFixture(app),client=new Client({name:'capacity-test',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    const request={cwd:root,requestId,provider:'openai-codex',model:'gpt-6-luna',thinking:'medium',access:'workspace-write',tier:'T1',
      tierDeclaration:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},
      task:{role:'Chesed',objective:'Synthetic capacity fixture',acceptance:['Host validates fixture check'],writeScope:['x.js']}};
    const parse=r=>JSON.parse(r.content[0].text);
    const first=parse(await client.callTool({name:'dispatch_subagent',arguments:request}));
    assert.equal(first.failureCode,'PI_RESULT_CAPACITY_EXCEEDED',JSON.stringify({code:first.code,failure:first.failure,format:first.formatValidation,role:first.roleValidation}));assert.equal(first.status,'failed');assert.equal(first.patch,patch);
    assert.equal(first.modelExecutionStarted===false,false);assert.equal(first.contract,undefined);
    const second=parse(await client.callTool({name:'dispatch_subagent',arguments:request}));
    assert.equal(second.patch,patch);assert.equal(executions,1);
    assert.deepEqual(readdirSync(join(d,'host-verification')),[]);
    const ledger=createRequestLedger(d);
    const saved=JSON.parse(readFileSync(join(d,sha(requestId),'final.json'),'utf8')).result;
    assert.equal((saved.response??saved).patch,patch);
    const page=parse(await client.callTool({name:'get_subagent_result',arguments:{requestId,offset:0,limit:65536}}));
    assert.equal(page.ready,true);assert.ok(page.totalLength>C.fullResultMaxUtf16Units);assert.equal(page.nextOffset,65536);
    const read=parse(await client.callTool({name:'dispatch_subagent',arguments:{...request,requestId:'capacity-read',access:'read',tier:undefined,tierDeclaration:undefined,
      task:{role:'Chesed',objective:'Synthetic read capacity fixture',acceptance:['Return fixture'],readScope:['package.json']}}}));
    assert.equal(read.failureCode,'PI_RESULT_CAPACITY_EXCEEDED');assert.equal(read.capacity.location,'dispatch.completedResult');
    assert.equal(read.contract,undefined);assert.equal(executions,2);
    const durable=await runtime.taskMonitor.drain({timeoutMs:2000});assert.equal(durable.lossRisk,false);
    assert.equal(ledger.readMonitorResult(requestId).result.patch,patch);
  }finally{await client.close();await new Promise(r=>http.close(r));assert.equal((await runtime.shutdown({graceMs:1000,abortWaitMs:1000})).disposed,true);}
}));
