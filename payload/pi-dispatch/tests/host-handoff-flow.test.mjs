import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256,captureHostChecks,prepareHostReview,fetchCompleteResult} from '../scripts/host-handoff.mjs';
import {waitForHostCandidate,prepareReviewBundle,collectAcceptanceInspection,phaseIntervals} from '../scripts/host-handoff-flow.mjs';
import {main} from '../scripts/host-handoff-client.mjs';
import {exportResult} from '../extensions/result-export.js';
import {runProcess} from '../scripts/headless-host.mjs';
import {createReplayGateway} from './host-handoff-flow-benchmark.mjs';

async function fixture() {
  const requestId='flow-implementation',parentRunId='flow-parent',cwd=process.cwd();
  const patch='diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n';
  const artifactSha256=sha256(patch),anchorSha256='a'.repeat(64),recordSha256='b'.repeat(64);
  const handoff={ok:true,requestId,parentRunId,workspaceSha256:sha256(cwd),anchorSha256,tier:'T1',artifactSha256,
    requiredCheckNames:['host regression'],state:'host-verification-required',finalAccepted:false};
  const result={requestId,patch,patchSha256:artifactSha256,patchValidation:{changedFiles:['a.js']}};
  const candidate={requestId,artifactSha256,handoff,result,resultSha256:sha256(JSON.stringify(result))};
  const request={requestId,parentRunId,cwd,tier:'T1',tierDeclaration:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},
    task:{role:'Chesed',objective:'Preserve behavior with regression coverage',acceptance:['Host runs actual node assertions and scope check; require exit code 0'],
      context:['TIER_REASON=T1: shared behavior','Interface contract: host callbacks return exitCode, stdout and stderr.',
        'After editing call yhwh_run_check; host check unverified pending host execution; submit Chesed result.'],forbidden:['No deployment']}};
  const hostCapture=await captureHostChecks(candidate,[{checkName:'host regression',command:'node -e <host-selected assertions>',cwd,
    run:()=>runProcess(process.execPath,['-e','console.log("host pass");console.error("diagnostic")'],{cwd,timeoutMs:2000,maxOutputBytes:8192})}]);
  const hostRecord={ok:true,requestId,artifactSha256,recordSha256,state:'completed',outcome:'completed',checks:[{checkName:'host regression',exitCode:0}]};
  const text='export const behavior = "new";';
  const input={request,candidate,hostCapture,hostRecord,sources:[{path:'a.js',text,sha256:sha256(text)}]};
  const options={requestId:'flow-review',reason:'Focused host evidence and local behavior'};
  const review={ok:true,requestId:options.requestId,provider:'claude-code-cli',model:'claude-sonnet-5',workerRuntime:'claude-code-cli',modelExecutionStarted:true,toolsUsed:[],
    formatValidation:{ok:true},roleValidation:{ok:true,role:'Geburah'},reviewValidation:{ok:true,approved:true},
    structuredResult:{status:'completed',reviewDecision:'approve',missingMaterials:[],errors:[],deliverable:{findings:[{blocking:false,severity:'low',description:'nonblocking suggestion'}]}},
    contract:{role:'Geburah',stage:'post-review',parentRunId,workspaceSha256:handoff.workspaceSha256,taskAnchorSha256:anchorSha256}};
  const accepted={...handoff,state:'accepted',finalAccepted:true,acceptanceState:'completed',proofSha256:recordSha256,acceptedAt:'2026-10-12T00:00:00.000Z'};
  const calls=[];
  const call=async(name,args)=>{
    calls.push({name,args});
    if(name==='wait_subagent')return {structuredContent:{ok:true,ready:true,requestId,state:'awaiting-host-verification'}};
    if(name==='get_task_handoff')return {structuredContent:accepted};
    if(name==='get_subagent_result')return {structuredContent:{ok:true,ready:true,requestId:args.requestId,...exportResult(args.requestId===requestId?result:review,args)}};
    throw Error('Unexpected mutation or query');
  };
  return {input,options,review,accepted,call,calls};
}
const closure=(f,bundle)=>({...f.input,reviewRequest:bundle.reviewRequest,expectedReviewRequestSha256:bundle.reviewRequestSha256});

test('P3 waits once then reads candidate once with an exact derived patch identity',async()=>{
  const f=await fixture();f.input.candidate.result.padding='😀漢字'.repeat(20000);
  const r=await waitForHostCandidate(f.call,{requestId:f.input.request.requestId});
  assert.equal(r.ready,true);assert.equal(r.candidate.result.padding,f.input.candidate.result.padding);
  assert.deepEqual(f.calls.map(c=>c.name),['wait_subagent','get_subagent_result','get_subagent_result','get_task_handoff']);
  assert.equal(f.calls.at(-1).args.artifactSha256,f.input.candidate.artifactSha256);
  assert.equal(r.requiresPrimaryInspection,true);assert.equal(r.candidate.handoff.finalAccepted,true);
});
test('P3 wait timeout does not poll, read results, cancel or dispatch',async()=>{
  const calls=[];
  const r=await waitForHostCandidate(async(name,args)=>{calls.push(name);return {structuredContent:{ok:true,ready:false,requestId:args.requestId,state:'running'}};},{requestId:'running',timeoutMs:0});
  assert.equal(r.ready,false);assert.deepEqual(calls,['wait_subagent']);
  await assert.rejects(waitForHostCandidate(()=>{}, {requestId:'bad',timeoutMs:55001}));
  await assert.rejects(waitForHostCandidate(async()=>({structuredContent:{ok:true,ready:true,requestId:'other'}}),{requestId:'candidate'}),/identity/);
});
test('P3 rejects stale derived identity, malformed pages and page limit',async()=>{
  const f=await fixture();f.input.candidate.result.patchSha256='0'.repeat(64);
  await assert.rejects(waitForHostCandidate(f.call,{requestId:f.input.request.requestId}),/mismatch/);
  const g=await fixture();
  await assert.rejects(fetchCompleteResult(async(n,a)=>{const r=await g.call(n,a);r.structuredContent.sha256='0'.repeat(64);return r;},g.input.request.requestId),/digest/);
  let count=0;
  await assert.rejects(fetchCompleteResult(async(n,a)=>{count++;return {structuredContent:{ok:true,ready:true,requestId:a.requestId,encoding:'json-utf16-offsets',offset:a.offset,
    resultJsonChunk:'x',totalLength:129,sha256:'a'.repeat(64),nextOffset:a.offset+1}};},'too-many'),/budget/);
  assert.equal(count,128);
});
test('P4 output summary keeps beginning, TAP totals, skip reason, scope and every step exit',async()=>{
  const f=await fixture(),cwd=f.input.request.cwd;
  const stdout='TAP version 13\n'+'ok detail\n'.repeat(500)+'# tests 6\n# pass 5\n# skipped 1 EPERM\nscope: a.js\n';
  const hostCapture=await captureHostChecks(f.input.candidate,[{checkName:'host regression',command:'host-selected node test and git checks',cwd,run:async()=>({exitCode:0,stdout,stderr:'',
    steps:[{name:'test',command:'node --test a.test.mjs',exitCode:0,failure:null,elapsedMs:1,stdout,stderr:''},
      {name:'whitespace',command:'git diff --check',exitCode:0,elapsedMs:1,stdout:'',stderr:''},
      {name:'scope',command:'git diff --name-only',exitCode:0,elapsedMs:1,stdout:'a.js\n',stderr:''}]})}]);
  const summary=JSON.parse(hostCapture.evidence.commands[0].outputSummary);
  assert.match(summary.stdout,/TAP version/);assert.match(summary.stdout,/# pass 5/);assert.match(summary.stdout,/EPERM/);assert.match(summary.stdout,/scope: a.js/);
  assert.equal(summary.steps.length,3);assert.ok(summary.steps.every(s=>s.exitCode===0));assert.ok(hostCapture.evidence.commands[0].outputSummary.length<=4096);
  assert.equal(hostCapture.outcomes[0].stdout,stdout);assert.equal(hostCapture.outcomes[0].steps[2].stdout,'a.js\n');
  const b=prepareReviewBundle({...f.input,hostCapture},f.options);
  assert.match(JSON.stringify(b.packet.verification),/whitespace/);assert.match(JSON.stringify(b.packet.verification),/scope/);
});
test('P4 failed individual step cannot hide behind aggregate exit zero',async()=>{
  const f=await fixture();
  for(const [exitCode,failure] of [[7,null],[null,'timeout'],[null,'output_limit']]) {
    const c=await captureHostChecks(f.input.candidate,[{checkName:'host regression',command:'host-selected check',cwd:f.input.request.cwd,run:async()=>({exitCode:0,stdout:'aggregate',stderr:'',
      steps:[{name:'actual step',command:'node assertions',exitCode,failure,elapsedMs:2,stdout:'',stderr:'failed'}]})}]);
    assert.equal(c.passed,false);assert.equal(c.evidence,null);assert.equal(c.outcomes[0].steps[0].failure,failure);
    assert.throws(()=>prepareReviewBundle({...f.input,hostCapture:c},f.options),/host evidence/);
  }
});
test('P4 binds durable host receipt, returns full preflight, and separates historical worker instructions',async()=>{
  const f=await fixture(),b=prepareReviewBundle(f.input,f.options);
  assert.equal(b.plan.ok,true);assert.equal(b.modelCalls,0);assert.equal(b.plan.readOnly,true);
  assert.equal(b.reviewRequestSha256,sha256(JSON.stringify(b.reviewRequest)));assert.equal(b.reviewRequest.thinking,'medium');
  assert.equal(b.reviewRequest.provider,'claude-code-cli');assert.equal(b.reviewRequest.access,'none');
  assert.deepEqual(b.reviewRequest.task.acceptance,f.input.request.task.acceptance);assert.equal(b.packet.changes.content.join(''),f.input.candidate.result.patch);
  assert.ok(b.budget.nonDiffUtf8Bytes<=8192);assert.ok(b.budget.totalUtf8Bytes<=24576);
  assert.match(b.packet.context.content[0],/historicalWorkerContext/);assert.match(b.packet.context.content[0],/yhwh_run_check/);
  assert.ok(!b.reviewRequest.task.context.some(s=>s.startsWith('After editing')));
  assert.match(b.packet.verification.content[0],/Host execution and recording completed/);
  assert.equal(JSON.parse(b.packet.verification.content[0]).recordSha256,f.input.hostRecord.recordSha256);
  for(const mutate of [i=>delete i.hostRecord,i=>i.hostRecord.artifactSha256='0'.repeat(64),i=>i.hostRecord.checks=[],i=>i.request.parentRunId='other',i=>i.request.cwd+='other']){
    const i=structuredClone(f.input);mutate(i);assert.throws(()=>prepareReviewBundle(i,f.options));
  }
  assert.throws(()=>prepareReviewBundle(f.input,{...f.options,thinking:'max'}));
  assert.throws(()=>prepareReviewBundle({...f.input,request:{...f.input.request,tier:'T2'}},f.options),/T1 only/);
  const oversized=structuredClone(f.input);oversized.sources[0].text='漢'.repeat(4000);oversized.sources[0].sha256=sha256(oversized.sources[0].text);
  assert.throws(()=>prepareReviewBundle(oversized,f.options),/8192/);
});
test('P4 legacy persisted capture summaries remain valid without recapture',async()=>{
  const f=await fixture(),o=f.input.hostCapture.outcomes[0];delete o.summaryVersion;delete o.steps;
  f.input.hostCapture.evidence.commands[0].outputSummary=JSON.stringify({cwd:o.cwd.slice(0,512),cwdSha256:sha256(o.cwd),elapsedMs:o.elapsedMs,outputSha256:o.outputSha256,
    stdout:o.stdout.slice(0,1200),stderr:o.stderr.slice(0,1200),summaryTruncated:false});
  assert.ok(prepareHostReview(f.input).packet);assert.ok(prepareReviewBundle(f.input,f.options).plan.ok);
});
test('P5 reconciles full approved review and actual durable accepted projection, never accepts itself',async()=>{
  const f=await fixture(),b=prepareReviewBundle(f.input,f.options),r=await collectAcceptanceInspection(f.call,closure(f,b));
  assert.equal(r.readyForPrimaryAcceptance,true);assert.equal(r.requiresPrimaryAcceptance,true);assert.equal(r.readOnly,true);
  assert.equal(r.nonblockingFindings.length,1);assert.equal(r.hostRecordSha256,f.input.hostRecord.recordSha256);
  assert.deepEqual(f.calls.map(c=>c.name),['get_subagent_result','get_task_handoff']);assert.equal(r.trace.length,3);
});
test('P5 rejects altered request, missing/blocked review, wrong parent/workspace/anchor and failed acceptance',async()=>{
  for(const mutate of [
    f=>f.review.ok=false,f=>f.review.requestId='other',f=>f.review.formatValidation.ok=false,f=>f.review.roleValidation.role='Chesed',
    f=>f.review.provider='other',f=>f.review.model='other',f=>f.review.workerRuntime='pi',f=>f.review.modelExecutionStarted=false,f=>f.review.toolsUsed=['read'],
    f=>f.review.reviewValidation.approved=false,f=>f.review.structuredResult.reviewDecision='request-changes',
    f=>f.review.structuredResult.missingMaterials=['missing source'],f=>f.review.structuredResult.errors=['transport'],
    f=>f.review.structuredResult.deliverable.findings[0].blocking=true,f=>f.review.contract.parentRunId='other',
    f=>f.review.contract.workspaceSha256='0'.repeat(64),f=>f.review.contract.taskAnchorSha256='0'.repeat(64),
    f=>f.accepted.state='post-review-required',f=>f.accepted.finalAccepted=false,f=>f.accepted.acceptanceState='in-doubt',
    f=>f.accepted.artifactSha256='0'.repeat(64),f=>f.accepted.proofSha256='0'.repeat(64),f=>f.accepted.acceptedAt=null,
    f=>f.accepted.requiredCheckNames=['different check'],
  ]){const f=await fixture(),b=prepareReviewBundle(f.input,f.options);mutate(f);await assert.rejects(collectAcceptanceInspection(f.call,closure(f,b)));}
  const f=await fixture(),b=prepareReviewBundle(f.input,f.options);b.reviewRequest.task.objective+='changed';
  await assert.rejects(collectAcceptanceInspection(f.call,closure(f,b)),/fingerprint/);assert.equal(f.calls.length,0);
  const g=await fixture(),c=prepareReviewBundle(g.input,g.options);c.reviewRequest.task.acceptance=['different goal'];c.reviewRequestSha256=sha256(JSON.stringify(c.reviewRequest));
  await assert.rejects(collectAcceptanceInspection(g.call,closure(g,c)),/target/);assert.equal(g.calls.length,0);
});
test('timing intervals keep missing phases unknown and reject nonmonotonic/duplicate events',()=>{
  const e=[{name:'a',at:'2026-10-12T00:00:00.000Z',offsetMs:0},{name:'b',at:'2026-10-12T00:00:00.003Z',offsetMs:3}];
  assert.deepEqual(phaseIntervals(e,[['a','b'],['b','missing']]).map(v=>v.elapsedMs),[3,null]);
  assert.throws(()=>phaseIntervals([...e,e[1]],[]));assert.throws(()=>phaseIntervals(e,[['b','a']]));
  assert.throws(()=>phaseIntervals([{...e[0],offsetMs:-1}],[]));
});
test('P4 real CLI produces inspectable plan without gateway or overwrite',async t=>{
  const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'yhwh-flow-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const input=join(dir,'input.json'),output=join(dir,'bundle.json');writeFileSync(input,JSON.stringify({...f.input,reviewOptions:f.options}));
  const r=await runProcess(process.execPath,['scripts/host-handoff-client.mjs','prepare-review-plan',input,output],{cwd:process.cwd(),timeoutMs:10000,maxOutputBytes:262144});
  assert.equal(r.exitCode,0,r.stderr);const saved=readFileSync(output,'utf8');assert.ok(JSON.parse(saved).plan.ok);
  const again=await runProcess(process.execPath,['scripts/host-handoff-client.mjs','prepare-review-plan',input,output],{cwd:process.cwd(),timeoutMs:10000,maxOutputBytes:8192});
  assert.equal(again.exitCode,1);assert.match(again.stderr,/EEXIST/);assert.equal(readFileSync(output,'utf8'),saved);
  writeFileSync(input,JSON.stringify({...f.input,hostRecord:null,reviewOptions:f.options}));
  const failed=join(dir,'failed.json');await assert.rejects(main(['prepare-review-plan',input,failed]));assert.equal(existsSync(failed),false);
});

test('P3/P5 authenticated local HTTP commands complete read-only bundles, with no model or writes',async t=>{
  const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'yhwh-flow-http-'));
  const gateway=await createReplayGateway({requestId:f.input.request.requestId,result:f.input.candidate.result,review:f.review,handoff:f.accepted});
  t.after(async()=>{await gateway.close();rmSync(dir,{recursive:true,force:true});});
  const config=join(dir,'gateway.json'),tokenFile=join(dir,'token');writeFileSync(tokenFile,gateway.token);
  writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:gateway.port,tokenFile}));
  const env={PI_GATEWAY_CONFIG:config},waitFile=join(dir,'wait.json'),candidateFile=join(dir,'candidate.json');
  writeFileSync(waitFile,JSON.stringify({requestId:f.input.request.requestId,timeoutMs:0}));
  assert.equal((await main(['wait-candidate',waitFile,candidateFile],env)).ready,true);
  assert.equal(JSON.parse(readFileSync(candidateFile,'utf8')).candidate.result.patch,f.input.candidate.result.patch);
  const b=prepareReviewBundle(f.input,f.options),closureFile=join(dir,'closure.json'),output=join(dir,'inspection.json');
  writeFileSync(closureFile,JSON.stringify(closure(f,b)));
  assert.equal((await main(['close-acceptance',closureFile,output],env)).requiresPrimaryAcceptance,true);
  assert.ok(gateway.calls.every(c=>['wait_subagent','get_subagent_result','get_task_handoff'].includes(c.name)));
  f.accepted.proofSha256='0'.repeat(64);const bad=join(dir,'bad.json');
  await assert.rejects(main(['close-acceptance',closureFile,bad],env),/acceptance/);assert.equal(existsSync(bad),false);
});

test('P3 authenticated timeout CLI returns once without collecting a result',async t=>{
  const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'yhwh-flow-timeout-'));
  const gateway=await createReplayGateway({requestId:f.input.request.requestId,result:f.input.candidate.result,review:f.review,handoff:f.accepted,ready:false});
  t.after(async()=>{await gateway.close();rmSync(dir,{recursive:true,force:true});});
  const tokenFile=join(dir,'token'),config=join(dir,'gateway.json'),input=join(dir,'input.json'),output=join(dir,'output.json');
  writeFileSync(tokenFile,gateway.token);writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:gateway.port,tokenFile}));
  writeFileSync(input,JSON.stringify({requestId:f.input.request.requestId,timeoutMs:0}));
  assert.equal((await main(['wait-candidate',input,output],{PI_GATEWAY_CONFIG:config})).ready,false);
  assert.deepEqual(gateway.calls.map(c=>c.name),['wait_subagent']);
});
