import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256,captureHostChecks} from '../scripts/host-handoff.mjs';
import {createHostHandoffSession,stageSummary,resumeStage,reviewReadiness,inspectDispatchReadiness,timingBreakdown} from '../scripts/host-handoff-session.mjs';
import {main} from '../scripts/host-handoff-client.mjs';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native review-budget CLI is offline, exclusive and returns actionable diagnostics',()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-budget-cli-'));
 try {
  const patch='--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+x\n';
  const input={stage:'post-change',tier:'T1',requirements:['Fixture'],changes:[patch],context:['漢'.repeat(4000)],verification:['Host exit0'],changedFiles:['x.js'],trustedPatch:patch};
  const source=join(dir,'input.json'),output=join(dir,'output.json'),cli=fileURLToPath(new URL('../scripts/host-handoff-client.mjs',import.meta.url));
  writeFileSync(source,JSON.stringify(input));
  const result=JSON.parse(execFileSync(process.execPath,[cli,'review-budget',source,output],{encoding:'utf8',env:{...process.env,PI_GATEWAY_CONFIG:''}}));
  assert.equal(result.ready,false);assert.equal(result.modelCalls,0);
  const report=JSON.parse(readFileSync(output));assert.equal(report.ok,false);assert.equal(report.readOnly,true);assert.ok(report.budget.nonDiffUtf8Bytes>8192);
  const first=readFileSync(output,'utf8');
  const duplicate=spawnSync(process.execPath,[cli,'review-budget',source,output],{encoding:'utf8'});assert.equal(duplicate.status,1);assert.equal(readFileSync(output,'utf8'),first);
  const bad=spawnSync(process.execPath,[cli,'review-budget',join(dir,'missing.json'),join(dir,'absent.json')],{encoding:'utf8'});assert.equal(bad.status,1);assert.equal(existsSync(join(dir,'absent.json')),false);
  const usage=spawnSync(process.execPath,[cli,'review-budget'],{encoding:'utf8'});assert.equal(usage.status,1);assert.match(usage.stderr,/Usage/);
  writeFileSync(source,'{bad-json');assert.equal(spawnSync(process.execPath,[cli,'review-budget',source,join(dir,'corrupt.json')]).status,1);assert.equal(existsSync(join(dir,'corrupt.json')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('review dispatch readiness returns malformed and hard budget issues without a model',()=>{
 const request={tier:'T1',task:{reviewPacket:{changes:{content:'not-an-array'}}}};
 assert.doesNotThrow(()=>inspectDispatchReadiness({request}));
 assert.equal(inspectDispatchReadiness({request}).ok,false);
 const oversized={version:1,stage:'post-change'};
 for(const name of ['requirements','changes','context','verification'])oversized[name]={status:'provided',content:['x']};
 oversized.context.content=['漢'.repeat(8000),'漢'.repeat(400)];request.task.reviewPacket=oversized;
 const result=inspectDispatchReadiness({request});
 assert.equal(result.ok,false);assert.equal(result.modelCalls,0);
 assert.ok(result.issues.some(v=>v.location==='reviewPacket.total'&&v.unit==='utf8-bytes'));
});

test('offline budget-fit summary never claims review admission or accepts a task',()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-fit-cli-'));
 try{
  const patch='--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+x\n';
  const input={stage:'post-change',tier:'T1',requirements:['R'],changes:[patch],context:['C'],verification:['host exit0'],changedFiles:['x.js']};
  const source=join(dir,'input.json'),output=join(dir,'report.json');writeFileSync(source,JSON.stringify(input));
  const cli=fileURLToPath(new URL('../scripts/host-handoff-client.mjs',import.meta.url));
  const summary=JSON.parse(execFileSync(process.execPath,[cli,'review-budget',source,output],{encoding:'utf8',env:{...process.env,PI_GATEWAY_CONFIG:''}}));
  assert.equal(summary.budgetFits,true);assert.equal(summary.ready,false);assert.equal(summary.admissionReady,false);
  assert.equal(summary.requiresTrustedDiffBinding,true);assert.equal(summary.modelCalls,0);
  assert.equal(JSON.parse(readFileSync(output)).admissionReady,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

export async function sessionFixture() {
  const cwd=process.cwd(),requestId='session-implementation',parentRunId='session-parent';
  const patch='diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n',artifactSha256=sha256(patch);
  const result={requestId,patch,patchSha256:artifactSha256,patchValidation:{changedFiles:['a.js']}};
  const candidate={requestId,artifactSha256,result,resultSha256:sha256(JSON.stringify(result)),handoff:{ok:true,requestId,parentRunId,
    workspaceSha256:sha256(cwd),anchorSha256:'a'.repeat(64),tier:'T1',artifactSha256,requiredCheckNames:['host regression'],state:'host-verification-required'}};
  const request={requestId,parentRunId,cwd,tier:'T1',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',thinking:'medium',
    tierDeclaration:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},
    task:{role:'Chesed',objective:'Preserve behavior with regression coverage',readScope:['a.js'],writeScope:['a.js'],
      acceptance:['Host runs actual node assertions and scope check; require exit code 0'],context:['TIER_REASON=T1: shared behavior with a host check',
        'Interface contract: host callbacks return exitCode, stdout and stderr.'],forbidden:['No deployment']}};
  const hostCapture=await captureHostChecks(candidate,[{checkName:'host regression',command:'node --test a.test.mjs',cwd,run:async()=>({exitCode:0,stdout:'pass',stderr:''})}]);
  const hostRecord={ok:true,requestId,artifactSha256,state:'completed',outcome:'completed',recordSha256:'b'.repeat(64),checks:[{checkName:'host regression',exitCode:0}]};
  return {input:{request,candidate,hostCapture,hostRecord,sources:[{path:'a.js',text:'new',sha256:sha256('new')}]},options:{requestId:'session-review',reason:'Focused host review'}};
}

test('session caches only immutable matching preparation and never trusts returned mutation',async()=>{
  const {input,options}=await sessionFixture(),session=createHostHandoffSession();
  const first=session.prepare(input,options),second=session.prepare(input,options);
  assert.equal(first.ok,true);assert.equal(first.cacheHit,false);assert.equal(second.cacheHit,true);
  assert.deepEqual(second.bundle.packet,first.bundle.packet);assert.equal(second.summary.stage,'review-ready');
  first.bundle.packet.requirements.content[0]='tampered';assert.notEqual(session.prepare(input,options).bundle.packet.requirements.content[0],'tampered');
  input.sources[0]={path:'a.js',text:'changed',sha256:sha256('changed')};assert.equal(session.prepare(input,options).cacheHit,false);
  input.hostRecord.recordSha256='c'.repeat(64);assert.equal(session.prepare(input,options).cacheHit,false);
  input.request.task.context.push('fresh context');assert.equal(session.prepare(input,options).cacheHit,false);
  session.clear();assert.equal(session.stats.entries,0);assert.equal(session.stats.bytes,0);
});

test('session LRU count and byte budget are bounded without caching failures',async()=>{
  const {input,options}=await sessionFixture(),session=createHostHandoffSession({maxEntries:1,maxBytes:65536});
  session.prepare(input,options);session.prepare(input,{...options,requestId:'review-two'});assert.equal(session.stats.entries,1);
  assert.equal(session.prepare(input,options).cacheHit,false);
  const small=createHostHandoffSession({maxBytes:1});small.prepare(input,options);assert.equal(small.stats.entries,0);
  input.hostRecord.checks=[];assert.equal(session.prepare(input,options).ok,false);assert.equal(session.stats.entries,1);
});

test('resume checks all identity and content hashes, never promotes a checkpoint to accepted',async()=>{
  const {input}=await sessionFixture(),checkpoint=stageSummary(input);
  assert.equal(resumeStage({...checkpoint,stage:'accepted',finalAccepted:true},input).stage,'host-recorded');
  for(const key of ['requestId','workspaceSha256','anchorSha256','parentRunId','artifactSha256','inputSha256'])
    assert.throws(()=>resumeStage({...checkpoint,[key]:'other'},input),/mismatch/);
  const drift=structuredClone(input);drift.sources[0].text='drift';assert.throws(()=>resumeStage(checkpoint,drift),/mismatch/);
  const pending=structuredClone(input);delete pending.hostRecord;delete pending.hostCapture;
  assert.equal(stageSummary(pending).stage,'candidate-ready');
  const forged=structuredClone(input);forged.hostRecord.artifactSha256='f'.repeat(64);assert.throws(()=>stageSummary(forged));
});

test('review readiness reports actual UTF8 budget and actionable split instruction without a model call',async()=>{
  const {input,options}=await sessionFixture();
  input.sources[0]={path:'a.js',text:'漢'.repeat(4000),sha256:sha256('漢'.repeat(4000))};
  const result=reviewReadiness(input,options);assert.equal(result.ok,false);assert.equal(result.modelCalls,0);
  assert.equal(result.issues[0].location,'reviewPacket');assert.ok(result.budget.nonDiffUtf8Bytes>8192);
  assert.match(result.nextAction,/commit.*quota/);
});

test('optional unavailable sandbox checks do not block a valid host-owned request',async()=>{
  const {input}=await sessionFixture();
  const value={request:input.request,sourceFacts:[{path:'a.js',available:true,sha256:sha256('old')}],
    authorization:{approved:true,source:'explicit frozen maintenance task',cwd:input.request.cwd,readScope:['a.js'],writeScope:['a.js']},
    hostCommands:[{name:'host regression',argv:['node','--test','test.mjs'],cwd:input.request.cwd,available:true}],
    checkAvailability:{available:false,reason:'readonly cache not configured'}};
  const result=inspectDispatchReadiness(value);assert.equal(result.ok,true,JSON.stringify(result.issues));
  assert.equal(result.sandboxChecks.advisory,true);assert.equal(result.sandboxChecks.hostVerificationRequired,true);
  assert.equal(inspectDispatchReadiness({...value,sourceFacts:[]}).ok,false);
  const bad=structuredClone(value);bad.request.task.writeScope=['../escape'];assert.equal(inspectDispatchReadiness(bad).ok,false);
  assert.ok(inspectDispatchReadiness({...value,authorization:null}).issues.some(i=>i.code==='AUTHORIZATION_NOT_INSPECTED'));
  assert.ok(inspectDispatchReadiness({...value,authorization:{...value.authorization,writeScope:[]}}).issues.some(i=>i.code==='WRITE_SCOPE_NOT_AUTHORIZED'));
  assert.ok(inspectDispatchReadiness({...value,hostCommands:[]}).issues.some(i=>i.code==='HOST_CHECKS_NOT_INSPECTED'));
  assert.ok(inspectDispatchReadiness({...value,hostCommands:[{...value.hostCommands[0],available:false}]}).issues.some(i=>i.code==='HOST_CHECK_UNAVAILABLE'));
});

test('timing differentiates local monotonic work, interprocess gaps and unavailable reversed clocks',()=>{
  const events=[{name:'a',at:'2026-10-12T01:00:01Z',clockId:'one',offsetMs:10},{name:'b',at:'2026-10-12T01:00:00Z',clockId:'one',offsetMs:15},
    {name:'c',at:'2026-10-12T01:00:00Z',clockId:'two',offsetMs:90}];
  const result=timingBreakdown({events,intervals:[{name:'local',from:'a',to:'b',kind:'deterministic'},
    {name:'gap',from:'a',to:'c',kind:'primary-handoff'},{name:'missing',from:'x',to:'b',kind:'model'}]});
  assert.equal(result[0].elapsedMs,5);assert.equal(result[1].elapsedMs,null);assert.equal(result[2].elapsedMs,null);
  assert.equal(result[1].unavailableReason,'invalid-or-reversed-time');
});

test('actual CLI summarize/resume wrapper and readiness commands are read-only and refuse overwrite',async()=>{
  const {input}=await sessionFixture(),dir=mkdtempSync(join(tmpdir(),'yhwh-session-cli-'));
  try{
    const material=join(dir,'material.json'),summary=join(dir,'summary.json');writeFileSync(material,JSON.stringify(input));
    await main(['summarize-stage',material,summary],{});const checkpoint=JSON.parse(readFileSync(summary));
    const resume=join(dir,'resume.json'),result=join(dir,'resumed.json');writeFileSync(resume,JSON.stringify({material:input,checkpoint}));
    await main(['resume-stage',resume,result],{});assert.equal(JSON.parse(readFileSync(result)).stage,'host-recorded');
    await assert.rejects(main(['resume-stage',resume,result],{}),/exist/i);
    const changed=structuredClone(input);changed.request.task.context.push('drift');writeFileSync(resume,JSON.stringify({material:changed,checkpoint}));
    await assert.rejects(main(['resume-stage',resume,join(dir,'stale.json')],{}),/mismatch/);assert.equal(existsSync(join(dir,'stale.json')),false);
    const ready=join(dir,'ready.json');writeFileSync(ready,JSON.stringify({request:input.request,sourceFacts:[{path:'a.js',available:true,sha256:sha256('old')}],
      authorization:{approved:true,source:'explicit frozen maintenance task',cwd:input.request.cwd,readScope:['a.js'],writeScope:['a.js']},
      hostCommands:[{name:'host regression',argv:['node','--test','test.mjs'],cwd:input.request.cwd,available:true}]}));
    await main(['inspect-readiness',ready,join(dir,'readiness.json')],{});assert.equal(JSON.parse(readFileSync(join(dir,'readiness.json'))).ok,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
