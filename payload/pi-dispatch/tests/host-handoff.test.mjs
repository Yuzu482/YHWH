import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exportResult} from '../extensions/result-export.js';
import {runProcess} from '../scripts/headless-host.mjs';
import {fetchHostCandidate,captureHostChecks,prepareHostReview,summarizeCandidate,sha256} from '../scripts/host-handoff.mjs';
import {main,loadReviewInput} from '../scripts/host-handoff-client.mjs';
import {runtimePreflight} from '../scripts/runtime-preflight.mjs';
import {projectTaskHandoff} from '../extensions/task-handoff.js';
import {createHostPending,createHostAttestation} from '../extensions/host-verification.js';

function projectedHandoff(requestId,artifactSha256,phase='host') {
  const pending={requestId,artifactSha256,workspace:'/synthetic',parentRunId:'synthetic-parent',requiredCheckNames:['host regression']};
  const contractTemplate={role:'Chesed',stage:'implementing',tier:'T1',mode:'standalone',parentRunId:pending.parentRunId,workspaceSha256:sha256(pending.workspace),taskAnchorSha256:'b'.repeat(64)};
  const ledger={getHostArtifact:()=>({pending,contractTemplate}),getOutcome:()=>({state:'completed'}),
    getEffectiveResult:()=>phase==='host'?{state:'awaiting-host-verification'}:{state:'completed',verificationSource:'host',verificationRecordSha256:'c'.repeat(64)},
    getExecutionRecord:()=>phase==='accepted'?{state:'completed',result:{ok:true,acceptedAt:'2026-10-12T00:00:00.000Z'}}:{state:'missing'}};
  return projectTaskHandoff({ledger,requestId,artifactSha256});
}

function fixture() {
  const patch='diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n';
  const requestId='host-handoff-fixture', artifactSha256=sha256(patch);
  const result={requestId,patch,patchSha256:artifactSha256,patchValidation:{changedFiles:['a.js']},patchPolicy:'issued-credential-v1',sandboxEvidence:[{exitCode:0}]};
  const handoff=projectedHandoff(requestId,artifactSha256);
  const calls=[];
  const call=async(name,args)=>{
    calls.push({name,args});
    if(name==='get_task_handoff')return {structuredContent:handoff};
    if(name==='get_subagent_result')return {structuredContent:{ok:true,ready:true,requestId,...exportResult(result,args)}};
    throw Error('Unexpected gateway call');
  };
  const request={requestId,tier:'T1',task:{objective:'Preserve behavior with regression coverage',acceptance:['Host runs actual node test'],context:['Interface contract: node assertions; host owns verification'],forbidden:['No production deployment']}};
  return {patch,requestId,artifactSha256,result,handoff,call,calls,request};
}
const check=(overrides={})=>({checkName:'host regression',command:'node -e <host-selected assertions>',cwd:process.cwd(),
  run:()=>runProcess(process.execPath,['-e','console.log("host pass");console.error("diagnostic");process.exit(0)'],{cwd:process.cwd(),timeoutMs:1000,maxOutputBytes:4096}),...overrides});
async function reviewInput() {
  const f=fixture(),candidate=await fetchHostCandidate(f.call,f);
  const hostCapture=await captureHostChecks(candidate,[check()]);
  const text='export const behavior = "new";';
  return {request:f.request,candidate,hostCapture,sources:[{path:'a.js',text,sha256:sha256(text)}]};
}

test('exact candidate ignores historical pending count and validates complete UTF-16 pagination',async()=>{
  const f=fixture();f.result.padding='😀漢字'.repeat(20000);
  const c=await fetchHostCandidate(f.call,f);
  assert.equal(c.result.padding,f.result.padding);assert.equal(c.timings.pages,2);
  assert.deepEqual(f.calls.map(c=>c.name),['get_task_handoff','get_subagent_result','get_subagent_result']);
  assert.equal(summarizeCandidate(c).finalAccepted,false);
  assert.equal('patch' in summarizeCandidate(c),false);
});
test('candidate consumes actual gateway projection states before and after host verification',async()=>{
  for(const phase of ['host','review','accepted']) {
    const f=fixture();Object.assign(f.handoff,projectedHandoff(f.requestId,f.artifactSha256,phase));
    const candidate=await fetchHostCandidate(f.call,f);
    assert.equal(candidate.handoff.finalAccepted,phase==='accepted');
  }
});
test('UTF-16 pages reassemble a surrogate pair split exactly at the page boundary',async()=>{
  const f=fixture();f.result.padding='';
  const start=JSON.stringify(f.result).indexOf('"padding":"')+'"padding":"'.length;
  f.result.padding='x'.repeat(65535-start)+'😀tail';
  assert.equal(JSON.stringify(f.result).charCodeAt(65535),0xd83d);
  const c=await fetchHostCandidate(f.call,f);assert.equal(c.result.padding,f.result.padding);
});
test('candidate rejects error/not-ready, stale patch, offsets, changing digest and incomplete pages',async()=>{
  for(const mutate of [
    p=>({...p,ready:false}),p=>({...p,requestId:'other'}),p=>({...p,offset:1}),
    p=>({...p,sha256:'0'.repeat(64)}),p=>({...p,totalLength:p.totalLength+1}),
    p=>({...p,nextOffset:0}),p=>({...p,result:{...p.result,patch:'tampered'}}),
  ]) {
    const f=fixture();
    await assert.rejects(fetchHostCandidate(async(n,a)=>n==='get_subagent_result'?{structuredContent:mutate((await f.call(n,a)).structuredContent)}:f.call(n,a),f));
  }
  const f=fixture();await assert.rejects(fetchHostCandidate(async()=>({isError:true}),f),/error/);
  f.handoff.artifactSha256='0'.repeat(64);await assert.rejects(fetchHostCandidate(f.call,f),/changed/);
  const g=fixture();g.result.padding='x'.repeat(70000);
  await assert.rejects(fetchHostCandidate(async(n,a)=>{const v=await g.call(n,a);if(a.offset>0)v.structuredContent.sha256='0'.repeat(64);return v;},g),/changing/);
});
test('capture retains real stderr and successful exit; does not count sandbox evidence as host checks',async()=>{
  const f=fixture(),c=await fetchHostCandidate(f.call,f);
  await assert.rejects(captureHostChecks(c,[]),/exactly/);
  const captured=await captureHostChecks(c,[check()]);
  assert.equal(captured.passed,true);assert.match(captured.outcomes[0].stderr,/diagnostic/);
  assert.equal(captured.evidence.commands[0].exitCode,0);
  assert.equal(captured.evidence.artifactSha256,f.artifactSha256);
  assert.equal(c.finalAccepted,undefined);assert.equal(c.handoff.finalAccepted,false);
});
test('escaped real output summary satisfies existing attestation limits, while full local output is retained',async()=>{
  const f=fixture(),c=await fetchHostCandidate(f.call,f);
  const r=await captureHostChecks(c,[check({run:()=>runProcess(process.execPath,['-e','process.stdout.write("\\t".repeat(2400));process.stderr.write("\\t".repeat(2400))'],{cwd:process.cwd(),timeoutMs:1000,maxOutputBytes:16384})})]);
  assert.equal(r.passed,true);assert.equal(r.outcomes[0].stdout.length,2400);
  assert.ok(r.evidence.commands[0].outputSummary.length<=4096);assert.equal(JSON.parse(r.evidence.commands[0].outputSummary).summaryTruncated,true);
  const pending=createHostPending({requestId:f.requestId,artifactSha256:f.artifactSha256,resultSha256:c.resultSha256,workspace:process.cwd(),parentRunId:'synthetic-parent',goal:'output escaping regression',phase:1,requiredCheckNames:['host regression']});
  assert.doesNotThrow(()=>createHostAttestation(pending,r.evidence));
  let ran=false;await assert.rejects(captureHostChecks(c,[check({command:'x'.repeat(2049),run:async()=>{ran=true;}})]));assert.equal(ran,false);
});
test('real nonzero exit, timeout, output limit and callback exception never generate passing evidence',async()=>{
  const f=fixture(),c=await fetchHostCandidate(f.call,f);
  for(const [program,timeoutMs,maxOutputBytes] of [
    ['console.error("failed");process.exit(7)',1000,4096],
    ['setTimeout(()=>{},10000)',80,4096],
    ['console.log("x".repeat(10000))',1000,256],
  ]) {
    const r=await captureHostChecks(c,[check({run:()=>runProcess(process.execPath,['-e',program],{cwd:process.cwd(),timeoutMs,maxOutputBytes})})]);
    assert.equal(r.passed,false);assert.equal(r.evidence,null);assert.ok(r.outcomes[0].elapsedMs>=0);
  }
  const thrown=await captureHostChecks(c,[check({run:async()=>{throw Error('private details');}})]);
  assert.equal(thrown.outcomes[0].failure,'host_callback_threw');assert.equal(thrown.evidence,null);
});
test('review uses exact diff and genuine host evidence without sandbox receipt substitution',async()=>{
  const input=await reviewInput(),r=prepareHostReview(input);
  assert.equal(r.packet.changes.content.join(''),input.candidate.result.patch);
  assert.equal(r.budget.validatedDiff,true);assert.ok(r.budget.nonDiffUtf8Bytes<=8192);
  assert.equal(r.packetSha256,sha256(JSON.stringify(r.packet)));
  assert.equal(r.requiresPrimaryInspection,true);
  assert.equal(r.taskTemplate.role,'Geburah');assert.deepEqual(runtimePreflight(r.taskTemplate).warnings,[]);
  input.hostCapture={kind:'sandboxEvidence',passed:true};assert.throws(()=>prepareHostReview(input),/host evidence/);
});
test('authenticated local HTTP CLI fails closed for unknown candidate without dispatch or output',async t=>{
  const {createGatewayApp}=await import('../scripts/gateway.mjs');
  const {listenHttpFixture}=await import('./http-fixture.mjs');
  const directory=mkdtempSync(join(tmpdir(),'yhwh-handoff-http-'));
  const token='synthetic-handoff-test-token-0123456789',tokenFile=join(directory,'token');
  const config=join(directory,'gateway.json'),input=join(directory,'input.json'),output=join(directory,'output.json');
  let dispatches=0;
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[],token,requestLedgerDir:join(directory,'ledger'),dispatchFn:async()=>{dispatches++;throw Error('No dispatch authorized');}});
  const http=await listenHttpFixture(app);
  t.after(async()=>{await new Promise(r=>http.close(r));await runtime.shutdown?.();rmSync(directory,{recursive:true,force:true});});
  writeFileSync(tokenFile,token);writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:http.address().port,tokenFile}));
  writeFileSync(input,JSON.stringify({requestId:'unknown-candidate',artifactSha256:'a'.repeat(64)}));
  await assert.rejects(main(['candidate',input,output],{PI_GATEWAY_CONFIG:config}),/ready|changed|successful|error/);
  assert.equal(dispatches,0);assert.equal(existsSync(output),false);
});
test('review rejects missing interface, stale source, stale artifact and omitted changed-file evidence',async()=>{
  for(const mutate of [
    i=>i.request.task.context=[],i=>i.sources[0].text+=' changed',i=>i.hostCapture.artifactSha256='0'.repeat(64),
    i=>delete i.candidate.result.patchValidation,i=>i.hostCapture.evidence.commands[0].exitCode=7,
  ]) {
    const i=await reviewInput();mutate(i);assert.throws(()=>prepareHostReview(i));
  }
});
test('review stops on each UTF-8 budget and never truncates trusted changes',async()=>{
  const i=await reviewInput();i.sources[0].text='漢'.repeat(3000);i.sources[0].sha256=sha256(i.sources[0].text);
  assert.throws(()=>prepareHostReview(i),/8192/);
  const j=await reviewInput();j.candidate.result.patch='--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+'+'x'.repeat(26000)+'\n';
  j.candidate.artifactSha256=sha256(j.candidate.result.patch);j.candidate.result.patchSha256=j.candidate.artifactSha256;
  j.candidate.handoff.artifactSha256=j.candidate.artifactSha256;j.candidate.resultSha256=sha256(JSON.stringify(j.candidate.result));
  j.hostCapture.artifactSha256=j.candidate.artifactSha256;j.hostCapture.evidence.artifactSha256=j.candidate.artifactSha256;
  assert.throws(()=>prepareHostReview(j),/24576/);
  const k=await reviewInput();k.candidate.result.patch=k.candidate.result.patch.replace('+new','+token=private-value');
  k.candidate.artifactSha256=sha256(k.candidate.result.patch);k.candidate.result.patchSha256=k.candidate.artifactSha256;k.candidate.handoff.artifactSha256=k.candidate.artifactSha256;
  k.candidate.resultSha256=sha256(JSON.stringify(k.candidate.result));k.hostCapture.artifactSha256=k.candidate.artifactSha256;k.hostCapture.evidence.artifactSha256=k.candidate.artifactSha256;
  assert.throws(()=>prepareHostReview(k),/sanitization/);
});
test('CLI material preparation writes complete local evidence exclusively; rejects malformed input',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'yhwh-host-handoff-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const input=join(dir,'input.json'),output=join(dir,'output.json');writeFileSync(input,JSON.stringify(await reviewInput()));
  const r=await main(['prepare-review',input,output]);assert.equal(r.ok,true);
  const saved=readFileSync(output,'utf8');assert.ok(JSON.parse(saved).packet);
  await assert.rejects(main(['prepare-review',input,output]),/EEXIST/);assert.equal(readFileSync(output,'utf8'),saved);
  await assert.rejects(main(['execute',input,output]),/Usage/);
  const bad=join(dir,'bad.json');writeFileSync(input,'{}');await assert.rejects(main(['prepare-review',input,bad]));assert.equal(existsSync(bad),false);
});
test('manifest gathers exact admitted current source ranges; rejects stale/unadmitted/traversal context',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'yhwh-review-sources-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const input=await reviewInput();input.request.cwd=dir;input.request.task.readScope=['a.js'];
  writeFileSync(join(dir,'a.js'),'first\nselected\nlast\n');
  const manifest={requestFile:join(dir,'request.json'),candidateFile:join(dir,'candidate.json'),hostCaptureFile:join(dir,'capture.json'),
    sourceSelections:[{path:'a.js',startLine:2,endLine:2,fileSha256:sha256(readFileSync(join(dir,'a.js')))}]};
  for(const [key,value] of [['requestFile',input.request],['candidateFile',input.candidate],['hostCaptureFile',input.hostCapture]])writeFileSync(manifest[key],JSON.stringify(value));
  const loaded=loadReviewInput(manifest);assert.equal(loaded.sources[0].text,'selected');assert.ok(prepareHostReview(loaded).packet);
  for(const change of [s=>s.fileSha256='0'.repeat(64),s=>s.path='../a.js',s=>s.path='missing.js',s=>s.endLine=99]) {
    const bad=structuredClone(manifest);change(bad.sourceSelections[0]);assert.throws(()=>loadReviewInput(bad));
  }
  writeFileSync(join(dir,'a.js'),'drift');assert.throws(()=>loadReviewInput(manifest),/hash mismatch/);
});
