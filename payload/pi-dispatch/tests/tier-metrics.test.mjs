import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli=fileURLToPath(new URL('../scripts/tier-metrics.mjs',import.meta.url));
const from='2026-10-01T00:00:00Z',to='2026-10-03T00:00:00Z';
function run(args){return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000});}
function rec(over={}){return {timestamp:'2026-10-01T01:00:00Z',requestId:'r1',operation:'dispatch_subagent',access:'workspace-write',envelope:{role:'Chesed'},parentRunId:'p1',workspaceSha256:'w',runAnchorSha256:'a',modelExecution:true,tier:'T0',submittedAt:'2026-10-01T01:00:00Z',...over};}
function fixture(dir,name,rows){const p=join(dir,name);writeFileSync(p,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return p;}
const host={outcome:'completed',artifactSha256:'a'.repeat(64)};
test('spawned CLI aggregates duplicate and rotated logs using verified execution evidence',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-'));try{
  const a=rec(),b=rec({requestId:'r2',timestamp:'2026-10-01T01:01:00Z',startedAt:'2026-10-01T01:01:00Z',modelExecution:true});
  const rows=[a,a,{...a,timestamp:'2026-10-01T01:09:00Z'},{...a,operation:'dispatch_subagent_replay',requestId:'replay'},rec({requestId:'z',parentRunId:null,modelExecution:false}),b,
   {timestamp:'2026-10-01T01:02:00Z',requestId:'g1',operation:'dispatch_subagent',envelope:{role:'Geburah',handoff:{stage:'post-review'}},reviewStage:undefined,thinking:'high',timings:{executionMs:50},modelExecution:true},
   {timestamp:'2026-10-01T01:02:01Z',requestId:'probe',operation:'probe_model',envelope:{role:'Geburah'},modelExecution:true,timings:{executionMs:100}},
   {timestamp:'2026-10-01T01:02:02Z',requestId:'replay-review',operation:'dispatch_subagent_replay',envelope:{role:'Geburah'},modelExecution:true,timings:{executionMs:100}},
   {timestamp:'2026-10-01T01:03:00Z',requestId:'accepted',operation:'task_accepted',parentRunId:'p1',workspaceSha256:'w',runAnchorSha256:'a',acceptedAt:'2026-10-01T01:03:00Z',taskOutcome:'completed',hostVerification:host,envelope:{role:'Chesed'},access:'workspace-write'}];
  const p=fixture(d,'general.jsonl',rows),q=fixture(d,'critical.jsonl',[a]);const r=run(['--audit',p,'--audit',q,'--from',from,'--to',to]);assert.equal(r.status,0,r.stderr);
  const x=JSON.parse(r.stdout);assert.equal(x.realExecutionMetrics.avgCallsPerTask.numerator,2);assert.equal(x.realExecutionMetrics.avgCallsPerTask.denominator,1);assert.equal(x.realExecutionMetrics.t0Share.value,1);assert.equal(x.realExecutionMetrics.geburah.executionCount,1);assert.equal(x.realExecutionMetrics.geburah.byStage.post,1);assert.equal(x.realExecutionMetrics.dispatchToFinalAcceptance.medianMs,180000);assert.equal(x.coverage.recordsAfterDeduplication<rows.length+1,true);
  const out=join(d,'out.json');const w=run(['--audit',p,'--from',from,'--to',to,'--output',out]);assert.equal(w.status,0,w.stderr);assert.deepEqual(JSON.parse(readFileSync(out,'utf8')).window,x.window);
  const existing=run(['--audit',p,'--from',from,'--to',to,'--output',out]);assert.equal(existing.status,1);assert.equal(readdirSync(d).filter(n=>n.endsWith('.tmp')).length,0);
 }finally{rmSync(d,{recursive:true,force:true});}
});
test('unknown tiers and legacy execution remain proxy-only; failed implementation excluded',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-'));try{const p=fixture(d,'old.jsonl',[rec({tier:undefined,modelExecution:undefined,contract:{parentRunId:'old'},timings:{executionMs:25}}),rec({requestId:'fail',parentRunId:'p2',modelExecution:false,startedAt:'2026-10-01T02:00:00Z'})]);const r=run(['--audit',p,'--from',from,'--to',to]);assert.equal(r.status,0,r.stderr);const x=JSON.parse(r.stdout);assert.equal(x.realExecutionMetrics.t0Share.value,null);assert.equal(x.realExecutionMetrics.t0Share.unknownTierTasks,0);assert.equal(x.realExecutionMetrics.t0Share.tasksWithKnownTier,0);assert.equal(x.realExecutionMetrics.t0Share.totalImplementationTasks,0);assert.equal(x.realExecutionMetrics.dispatchToFinalAcceptance.medianMs,null);assert.equal(x.additiveMetrics.implementationCohort.averageCallsPerGoal,null);assert.equal(x.additiveMetrics.finalNecessaryAcceptance.medianMs,null);assert.equal(x.additiveMetrics.finalNecessaryAcceptance.p90Ms,null);assert.equal(x.legacyProxyMetrics.positiveExecutionRecords,1);assert.equal(x.realExecutionMetrics.avgCallsPerTask.denominator,0);assert.equal(x.realExecutionMetrics.t0Share.denominator,0);}finally{rmSync(d,{recursive:true,force:true});}
});
test('same-parent implementations select highest tier; zero execution and unparented calls are not task denominator',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-'));try{const p=fixture(d,'tiers.jsonl',[rec({requestId:'low',parentRunId:'p',tier:'T0'}),rec({requestId:'high',parentRunId:'p',tier:'T2'}),rec({requestId:'failed',parentRunId:'failed',modelExecution:false,tier:'T0'}),rec({requestId:'free',parentRunId:null,modelExecution:true})]);const x=JSON.parse(run(['--audit',p,'--from',from,'--to',to]).stdout);assert.equal(x.realExecutionMetrics.t0Share.numerator,0);assert.equal(x.realExecutionMetrics.t0Share.denominator,1);assert.equal(x.realExecutionMetrics.avgCallsPerTask.coverage.unparentedRealDispatches,1);}finally{rmSync(d,{recursive:true,force:true});}
});
test('legacy Geburah proxy is separate and legacy chain median spans stages, not individual execution times',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-'));try{const rows=[
  {timestamp:'2026-10-01T01:00:00Z',submittedAt:'2026-10-01T01:00:00Z',completedAt:'2026-10-01T01:01:00Z',requestId:'l1',operation:'dispatch_subagent',parentRunId:'p',modelExecution:undefined,timings:{executionMs:5}},
  {timestamp:'2026-10-01T01:00:30Z',submittedAt:'2026-10-01T01:00:30Z',completedAt:'2026-10-01T01:02:00Z',requestId:'l2',operation:'dispatch_subagent',parentRunId:'p',modelExecution:undefined,timings:{executionMs:7}},
  {timestamp:'2026-10-01T01:01:00Z',requestId:'g',operation:'dispatch_subagent',envelope:{role:'Geburah'},timings:{executionMs:11}},
  {timestamp:'2026-10-01T01:01:30Z',requestId:'real-g',operation:'dispatch_subagent',modelExecution:true,envelope:{role:'Geburah'},timings:{executionMs:20}},
  {timestamp:'2026-10-01T01:02:00Z',requestId:'orphan',operation:'dispatch_subagent',modelExecution:undefined,timings:{executionMs:9}}];const p=fixture(d,'legacy.jsonl',rows);const x=JSON.parse(run(['--audit',p,'--from',from,'--to',to]).stdout);assert.equal(x.legacyProxyMetrics.geburah.executionCountProxy,1);assert.equal(x.legacyProxyMetrics.geburah.executionMsProxy,11);assert.equal(x.realExecutionMetrics.geburah.executionCount,1);assert.equal(x.legacyProxyMetrics.legacyChainEndProxyMedianMs,120000);assert.equal(x.legacyProxyMetrics.legacyChainEndProxyCount,1);}finally{rmSync(d,{recursive:true,force:true});}
});
test('acceptance requires complete host-owned evidence and matching parent workspace',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-'));try{const rows=[rec({workspaceSha256:'right',runAnchorSha256:'anchor'}),
  {timestamp:'2026-10-01T02:00:00Z',requestId:'wrong',operation:'task_accepted',parentRunId:'p1',workspaceSha256:'wrong',runAnchorSha256:'anchor',acceptedAt:'2026-10-01T02:00:00Z',taskOutcome:'completed',hostVerification:host},
  {timestamp:'2026-10-01T02:01:00Z',requestId:'nohost',operation:'task_accepted',parentRunId:'p1',workspaceSha256:'right',runAnchorSha256:'anchor',acceptedAt:'2026-10-01T02:01:00Z',taskOutcome:'completed'},
  {timestamp:'2026-10-01T02:02:00Z',requestId:'good',operation:'task_accepted',parentRunId:'p1',workspaceSha256:'right',runAnchorSha256:'anchor',acceptedAt:'2026-10-01T02:02:00Z',taskOutcome:'completed',hostVerification:host}];const p=fixture(d,'accept.jsonl',rows);const x=JSON.parse(run(['--audit',p,'--from',from,'--to',to]).stdout);assert.equal(x.realExecutionMetrics.dispatchToFinalAcceptance.medianMs,3720000);assert.equal(x.coverage.invalidAcceptanceRecords,2);}finally{rmSync(d,{recursive:true,force:true});}
});
test('strict host and Netzach final proof events require matching cohort and valid digests',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-proof-'));try{
  const proof=(source,over={})=>({state:'completed',source,artifactSha256:'a'.repeat(64),recordSha256:'b'.repeat(64),...over});
  const accepted=(requestId,anchor,verification)=>({timestamp:'2026-10-01T02:00:00Z',requestId,operation:'task_accepted',parentRunId:'p1',workspaceSha256:'w',runAnchorSha256:anchor,acceptedAt:'2026-10-01T02:00:00Z',taskOutcome:'completed',verification});
  const rows=[rec(),accepted('host-final','a',proof('host')),accepted('host-final','a',proof('host')),
   accepted('netzach-final','a',proof('netzach')),
   accepted('wrong-anchor','wrong',proof('host')),
   accepted('bad-digest','a',proof('host',{recordSha256:'invalid'}))];
  const p=fixture(d,'strict-proof.jsonl',rows),r=run(['--audit',p,'--from',from,'--to',to]);assert.equal(r.status,0,r.stderr);
  const x=JSON.parse(r.stdout);assert.equal(x.realExecutionMetrics.dispatchToFinalAcceptance.medianMs,3600000);assert.equal(x.coverage.invalidAcceptanceRecords,2);
 }finally{rmSync(d,{recursive:true,force:true});}
});
test('additive metrics report strict implementation cohorts, effort, launch coverage and superseded acceptance',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-additive-'));try{
  const proof={outcome:'completed',artifactSha256:'a'.repeat(64)};
  const task=(id,workspace,anchor,parent,thinking,over={})=>rec({requestId:id,workspaceSha256:workspace,runAnchorSha256:anchor,parentRunId:parent,thinking,submittedAt:'2026-10-01T01:00:00Z',timestamp:'2026-10-01T01:00:00Z',...over});
  const accepted=(id,workspace,anchor,parent,at)=>({timestamp:at,requestId:id,operation:'task_accepted',workspaceSha256:workspace,runAnchorSha256:anchor,parentRunId:parent,acceptedAt:at,taskOutcome:'completed',hostVerification:proof});
  const rows=[
   task('a','w1','a1','p','medium'),task('b','w2','a1','p','high'),task('c','w1','a2','p','xhigh'),
   task('d','w1','a1','p2','max'),task('e','w1','a1','p3','other'),
   task('e2','w1','a1','p3','unknown',{timestamp:'2026-10-01T01:00:10Z',submittedAt:'2026-10-01T01:00:00Z',completedAt:'2026-10-01T01:00:10Z'}),
   rec({requestId:'zero',modelExecution:false}),rec({requestId:'unknown-launch',modelExecution:null}),
   {timestamp:'2026-10-01T01:00:02Z',requestId:'review',operation:'dispatch_subagent',modelExecution:true,envelope:{role:'Geburah'},thinking:'xhigh'},
   accepted('aa','w1','a1','p','2026-10-01T01:00:01Z'),accepted('bb','w2','a1','p','2026-10-01T01:00:02Z'),
   accepted('cc','w1','a2','p','2026-10-01T01:00:03Z'),accepted('dd','w1','a1','p2','2026-10-01T01:00:04Z'),
   accepted('ee','w1','a1','p3','2026-10-01T01:00:05Z')
  ];
  const p=fixture(d,'additive.jsonl',rows),r=run(['--audit',p,'--from',from,'--to',to]);assert.equal(r.status,0,r.stderr);
  const x=JSON.parse(r.stdout),a=x.additiveMetrics;
  assert.deepEqual(a.launchCoverage,{real:7,confirmedZero:1,unknown:1});
  assert.equal(a.implementationCohort.tasks,5);assert.equal(a.implementationCohort.dispatches,6);
  assert.deepEqual(a.implementationCohort.effortBreakdown,{medium:1,high:1,xhigh:1,max:1,unknown:2});
  assert.deepEqual(x.realExecutionMetrics.geburah.effortBreakdown,{medium:0,high:0,xhigh:1,max:0,unknown:0});
  assert.equal(a.finalNecessaryAcceptance.completed,4);assert.equal(a.finalNecessaryAcceptance.superseded,1);
  assert.equal(a.finalNecessaryAcceptance.medianMs,2500);assert.equal(a.finalNecessaryAcceptance.p90Ms,4000);
  assert.equal(x.realExecutionMetrics.geburah.byThinking.unknown,1);
 }finally{rmSync(d,{recursive:true,force:true});}
});
test('strict cohort counts all goal calls, separates unkeyed and unrelated calls, and measures mixed implementation effort',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-cohort-'));try{
  const call=(id,role,workspace,anchor,parent,thinking,tier,over={})=>rec({requestId:id,envelope:{role},access:role==='Chesed'?'workspace-write':'analysis',workspaceSha256:workspace,runAnchorSha256:anchor,parentRunId:parent,thinking,tier,...over});
  const rows=[
   call('pre1','Geburah','w','a','p','high','T0',{envelope:{role:'Geburah',handoff:{stage:'pre-review'}}}),
   call('write1','Chesed','w','a','p','medium','T0'),
   call('write1b','Chesed','w','a','p','high','T0'),
   call('pre2','Geburah','w2','a2','p2','medium','T1',{envelope:{role:'Geburah',handoff:{stage:'pre-review'}}}),
   call('write2','Chesed','w2','a2','p2','medium','T2'),
   call('analysis','Geburah','w3','a3','p3','high','T1'),
   call('unkeyed-analysis','Geburah','','','p4','high','T1'),
   call('unkeyed-write','Chesed',' ','a4','p5','max','T1'),
   rec({requestId:'null-model',modelExecution:null}),
   rec({requestId:'string-model',modelExecution:'true'}),
   rec({requestId:'absent-model',modelExecution:undefined}),
  ];
  const p=fixture(d,'cohort.jsonl',rows),r=run(['--audit',p,'--from',from,'--to',to]);assert.equal(r.status,0,r.stderr);
  const x=JSON.parse(r.stdout),c=x.additiveMetrics.implementationCohort;
  assert.equal(c.goalCount,2);assert.equal(c.callCount,5);assert.equal(c.averageCallsPerGoal,2.5);
  assert.equal(c.mixedEffortTasks,1);assert.equal(c.unkeyedImplementationCalls,1);assert.equal(c.unkeyedRealCalls,2);assert.equal(c.unrelatedRealCalls,1);
  assert.deepEqual(c.tierCounts,{T0:1,T1:0,T2:1,unknown:0});assert.equal(c.divergentParentWorkspaceAnchorGroups,0);
  assert.deepEqual(x.realExecutionMetrics.geburah.effortBreakdown,{medium:1,high:3,xhigh:0,max:0,unknown:0});
  assert.equal(x.additiveMetrics.launchCoverage.unknown,3);
 }finally{rmSync(d,{recursive:true,force:true});}
});
test('final acceptance uses write supersession, latest valid proof, and nearest-rank P90',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-final-'));try{
  const proof={state:'completed',source:'host',artifactSha256:'a'.repeat(64),recordSha256:'b'.repeat(64)};
  const rows=[];
  for(let i=1;i<=10;i++){
   const key=`p${i}`, start=`2026-10-01T01:00:00Z`, end=new Date(Date.parse(start)+i*1000).toISOString();
   rows.push(rec({requestId:`write${i}`,parentRunId:key,submittedAt:start,startedAt:start}));
   rows.push({timestamp:end,requestId:`accept${i}`,operation:'task_accepted',parentRunId:key,workspaceSha256:'w',runAnchorSha256:'a',acceptedAt:end,taskOutcome:'completed',verification:proof});
  }
  const later='2026-10-01T01:00:10Z', after='2026-10-01T01:00:11Z';
  rows.push(rec({requestId:'correction-first',parentRunId:'corrected',submittedAt:'2026-10-01T01:00:00Z',timestamp:'2026-10-01T01:00:00Z'}));
  rows.push({timestamp:'2026-10-01T01:02:00Z',requestId:'old-accept',operation:'task_accepted',parentRunId:'corrected',workspaceSha256:'w',runAnchorSha256:'a',acceptedAt:'2026-10-01T01:00:05Z',taskOutcome:'completed',verification:proof});
  rows.push(rec({requestId:'failed-correction',parentRunId:'corrected',submittedAt:later,timestamp:later,outcome:'failed'}));
  rows.push({timestamp:after,requestId:'new-accept',operation:'task_accepted',parentRunId:'corrected',workspaceSha256:'w',runAnchorSha256:'a',acceptedAt:after,taskOutcome:'completed',verification:proof});
  rows.push({timestamp:'2026-10-01T01:00:12Z',requestId:'review-after',operation:'dispatch_subagent',modelExecution:true,envelope:{role:'Geburah'},parentRunId:'corrected',workspaceSha256:'w',runAnchorSha256:'a',submittedAt:'2026-10-01T01:00:12Z'});
  rows.push(rec({requestId:'superseded-write',parentRunId:'superseded',submittedAt:'2026-10-01T01:05:00Z',timestamp:'2026-10-01T01:05:00Z'}));
  rows.push({timestamp:'2026-10-01T01:02:00Z',requestId:'superseded-accept',operation:'task_accepted',parentRunId:'superseded',workspaceSha256:'w',runAnchorSha256:'a',acceptedAt:'2026-10-01T01:02:00Z',taskOutcome:'completed',verification:proof});
  rows.push(rec({requestId:'invalid-proof-write',parentRunId:'invalid',submittedAt:'2026-10-01T01:00:00Z'}));
  rows.push({timestamp:'2026-10-01T01:03:00Z',requestId:'invalid-proof',operation:'task_accepted',parentRunId:'invalid',workspaceSha256:'w',runAnchorSha256:'a',acceptedAt:'2026-10-01T01:03:00Z',taskOutcome:'failed',verification:proof});
  rows.push({timestamp:'2026-10-01T01:03:00Z',requestId:'unkeyed-accept',operation:'task_accepted',parentRunId:'',workspaceSha256:'w',runAnchorSha256:'a',acceptedAt:'2026-10-01T01:03:00Z',taskOutcome:'completed',verification:proof});
  const p=fixture(d,'final.jsonl',rows),r=run(['--audit',p,'--from',from,'--to',to]);assert.equal(r.status,0,r.stderr);
  const m=JSON.parse(r.stdout).additiveMetrics.finalNecessaryAcceptance;
  assert.equal(m.completed,11);assert.equal(m.medianMs,6000);assert.equal(m.p90Ms,10000);
  assert.equal(m.superseded,1);assert.equal(m.invalidProofRecords,1);assert.equal(m.unkeyed,1);
 }finally{rmSync(d,{recursive:true,force:true});}
});
test('exclusive output publication is race-safe and leaves no temporary files',async()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-race-'));try{const p=fixture(d,'race.jsonl',[rec()]),out=join(d,'same.json');const args=['--audit',p,'--from',from,'--to',to,'--output',out];const results=await Promise.all([1,2].map(()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',status=>resolve({status,stderr}));})));assert.deepEqual(results.map(r=>r.status).sort(),[0,1]);assert.ok(existsSync(out));assert.equal(readdirSync(d).filter(n=>n.endsWith('.tmp')).length,0);}finally{rmSync(d,{recursive:true,force:true});}
});
test('argument, exact UTC date, missing and corrupt input failures have documented exit codes',()=>{
 const d=mkdtempSync(join(tmpdir(),'tier-metrics-'));try{for(const args of [[],['--audit','x','--from','no','--to',to],['--audit','x','--from',to,'--to',from],['--audit','x','--from','2026-02-30T00:00:00Z','--to',to],['--audit','x','--from',from,'--to',to,'--stray'],['--audit','x','--audit','y','--audit','z','--from',from,'--to',to,'--output']])assert.equal(run(args).status,2);assert.equal(run(['--audit',join(d,'missing'),'--from',from,'--to',to]).status,1);const p=fixture(d,'bad.jsonl',[{}]);writeFileSync(p,'{bad\n');assert.equal(run(['--audit',p,'--from',from,'--to',to]).status,1);}finally{rmSync(d,{recursive:true,force:true});}
});
