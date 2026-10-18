import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {createReviewAttemptLedger} from '../scripts/tier-review-policy.mjs';
import {quotaFixture, grant, reviewInput, finish, openState, sha} from './helpers/legacy-state-fixtures.mjs';

test('quota15: exact reconsideration then original range6; prefix and decisions remain byte-equivalent',async()=>{
  const f=await quotaFixture();try{
    const dir=join(f.root,'fifteen'),l=openState(dir,f.initial,f.module,15);
    finish(l,l.reserve(f.five));finish(l,l.reserve(f.six));
    const after=l.snapshot(reviewInput('inspect'));assert.equal(after.attempts.length,15);
    assert.deepEqual(after.attempts.slice(0,13),f.initial.attempts);
    for(const[id,v]of Object.entries(f.initial.decisions))assert.deepEqual(after.decisions[id],v);
    assert.equal(after.timeUsedMs,f.initial.timeUsedMs+2000);
    assert.throws(()=>l.reserve(reviewInput('sixteenth')),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
    assert.throws(()=>l.markStarted(l.reserve(f.five)),/Replay/);
  }finally{f.cleanup();}
});

test('quota16: timeout row conserved, exact recovery then original range6',async()=>{
  const f=await quotaFixture();try{
    const timeout=f.fourteen.attempts[13];assert.equal(timeout.reservedMs,140000);assert.equal(timeout.elapsedMs,136302);
    assert.equal(timeout.started,true);assert.equal(timeout.timeKnown,true);assert.equal(f.fourteen.decisions[timeout.requestId],undefined);
    const l=openState(join(f.root,'sixteen'),f.fourteen,f.module,16);
    const retry={...f.five,requestId:'card-lab-final-range-5-material-timeout-recovery-20261014'};
    finish(l,l.reserve(retry));finish(l,l.reserve(f.six));const after=l.snapshot(reviewInput('inspect'));
    assert.equal(after.attempts.length,16);assert.deepEqual(after.attempts.slice(0,14),f.fourteen.attempts);
    assert.equal(after.timeUsedMs,f.fourteen.timeUsedMs+2000);
    assert.throws(()=>l.reserve(reviewInput('seventeenth')),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
    assert.throws(()=>openState(join(f.root,'old-grant'),after,f.module,15).snapshot(reviewInput('old-grant')),/Review/);
  }finally{f.cleanup();}
});

test('quota17: exact last slot, persisted decisions, one-shot and old-grant rejection',async()=>{
  const f=await quotaFixture();try{
    const l=openState(join(f.root,'seventeen'),f.sixteen,f.module,17);
    const ticket=l.reserve(f.last);assert.equal(ticket.replayed,false);finish(l,ticket);
    const after=l.snapshot(reviewInput('inspect'));assert.equal(after.attempts.length,17);
    assert.equal(after.attempts.filter(a=>a.stage==='pre-review').length,4);assert.equal(after.attempts.filter(a=>a.stage==='post-review').length,13);
    assert.deepEqual(after.attempts.slice(0,16),f.sixteen.attempts);
    for(const[id,v]of Object.entries(f.sixteen.decisions))assert.deepEqual(after.decisions[id],v);
    assert.equal(after.timeUsedMs,f.sixteen.timeUsedMs+1000);
    assert.throws(()=>l.markStarted(l.reserve(f.last)),/Replay/);
    assert.throws(()=>l.reserve({...f.last,requestId:'eighteenth'}),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
    const restarted=openState(join(f.root,'restart17'),after,f.module,17);assert.deepEqual(restarted.snapshot(reviewInput('inspect')),after);
    assert.throws(()=>openState(join(f.root,'rollback16'),after,f.module,16).snapshot(reviewInput('old')),/Review/);
    assert.throws(()=>openState(join(f.root,'actual-source'),f.sixteen,{createReviewAttemptLedger},17).reserve(f.last),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
  }finally{f.cleanup();}
});

test('quota15/16/17 reject changed identity, material, sections, closures and tampered history atomically',async t=>{
  const f=await quotaFixture();try{
    const cases=[['requestId',v=>({...v,requestId:'unapproved'})],['material',v=>({...v,materialDigest:sha('different')})],
      ['artifact',v=>({...v,artifactDigest:sha('different')})],['host',v=>({...v,hostRecordDigest:sha('different')})],
      ['requirements',v=>({...v,materialSections:{...v.materialSections,requirements:sha('different')}})],
      ['changes',v=>({...v,materialSections:{...v.materialSections,changes:sha('different')}})],
      ['missing-section',v=>({...v,materialSections:{changes:v.materialSections.changes}})],
      ['prior',v=>({...v,progress:{...v.progress,previousReviewRequestId:'other'}})],
      ['missing-closure',v=>({...v,progress:{...v.progress,closures:v.progress.closures.slice(1)}})],
      ['duplicate-closure',v=>({...v,progress:{...v.progress,closures:[...v.progress.closures,v.progress.closures[0]]}})],
      ['key',v=>({...v,progress:{...v.progress,closures:v.progress.closures.map((c,i)=>i?c:{...c,key:sha('wrong')})}})],
      ['paths',v=>({...v,progress:{...v.progress,closures:v.progress.closures.map((c,i)=>i?c:{...c,paths:['wrong']})}})],
      ['evidence',v=>({...v,progress:{...v.progress,closures:v.progress.closures.map((c,i)=>i?c:{...c,evidence:'wrong'})}})],
      ['stage',v=>({...v,stage:'pre-review'})],['phase',v=>({...v,phaseIndex:1})],['parent',v=>({...v,parentRunId:'other'})]
    ];
    for(const cap of [15,16,17])for(const[name,change]of cases)await t.test(cap+' '+name,()=>{
      const state=cap===15?f.initial:cap===16?f.fourteen:f.sixteen;
      const valid=cap===15?f.five:cap===16?{...f.five,requestId:'card-lab-final-range-5-material-timeout-recovery-20261014'}:f.last;
      const dir=join(f.root,'bad-'+cap+'-'+name),l=openState(dir,state,f.module,cap),before=fs.readFileSync(join(dir,state.key+'.json'));
      assert.throws(()=>l.reserve(change(structuredClone(valid))),e=>/^PI_REVIEW_/.test(e.code));assert.deepEqual(fs.readFileSync(join(dir,state.key+'.json')),before);
      assert.equal(fs.readdirSync(dir).some(p=>p.includes('lock')),false);
    });
    for(const cap of [15,16,17])for(const mutation of ['attempt','decision','pending','released','unknown-time'])await t.test(cap+' history '+mutation,()=>{
      const state=structuredClone(cap===15?f.initial:cap===16?f.fourteen:f.sixteen),last=state.attempts.at(-1);
      if(mutation==='attempt'){state.attempts[0].materialDigest=sha('forged');state.decisions[state.attempts[0].requestId].materialDigest=sha('forged');}
      if(mutation==='decision')state.decisions[state.attempts[0].requestId].decision.findings[0].description='Forged finding';
      if(mutation==='pending'){last.status='started';last.elapsedMs=null;last.outcome=null;}
      if(mutation==='released'){last.status='released';last.started=false;state.timeUsedMs-=last.elapsedMs;last.elapsedMs=0;last.outcome='not-launched';last.timeKnown=false;}
      if(mutation==='unknown-time')last.timeKnown=false;
      const valid=cap===15?f.five:cap===16?{...f.five,requestId:'card-lab-final-range-5-material-timeout-recovery-20261014'}:f.last;
      const dir=join(f.root,'tamper-'+cap+'-'+mutation),l=openState(dir,state,f.module,cap),before=fs.readFileSync(join(dir,state.key+'.json'));
      assert.throws(()=>l.reserve(valid),e=>/^PI_REVIEW_/.test(e.code));assert.deepEqual(fs.readFileSync(join(dir,state.key+'.json')),before);
    });
  }finally{f.cleanup();}
});

test('quota: no early second range, no continuation after negative/released review, time limit is conserved',async t=>{
  const f=await quotaFixture();try{
    for(const cap of [15,16])await t.test('early and released '+cap,()=>{
      const state=cap===15?f.initial:f.fourteen,l=openState(join(f.root,'early-'+cap),state,f.module,cap);
      assert.throws(()=>l.reserve(f.six),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
      const valid=cap===15?f.five:{...f.five,requestId:'card-lab-final-range-5-material-timeout-recovery-20261014'};
      const ticket=l.reserve(valid);l.finish(ticket,{started:false,outcome:'not-launched'});
      assert.throws(()=>l.markStarted(l.reserve(valid)),/Replay/);assert.throws(()=>l.reserve(f.six),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
    });
    const dir=join(f.root,'time'),state=structuredClone(f.sixteen),last=state.attempts.at(-1);
    last.elapsedMs+=1800000-state.timeUsedMs;state.timeUsedMs=1800000;
    const l=openState(dir,state,f.module,17);assert.throws(()=>l.reserve(f.last),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
    assert.equal(l.snapshot(reviewInput('inspect')).timeUsedMs,1800000);
  }finally{f.cleanup();}
});

import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
test('gateway: real current sources advertise exact 16/17 but reject missing host proof',async()=>{

 const scratch=mkdtempSync(join(tmpdir(),'yhwh-gateway-legacy-'));
 let runtime,server,client;
 try{
  const gateway=await import('../scripts/gateway.mjs');
  const config=join(scratch,'gateway.json'),token=join(scratch,'token');writeFileSync(token,'synthetic-token');
  writeFileSync(config,JSON.stringify({tokenFile:token,auditFile:join(scratch,'audit.jsonl'),providerCircuitFile:join(scratch,'circuit.json'),requestLedgerDir:join(scratch,'ledger'),roots:[scratch],reviewQuotaExceptions:[grant(16)]}));
  const loaded=gateway.loadGatewayOptions({PI_GATEWAY_CONFIG:config});assert.deepEqual([loaded.reviewQuotaExceptions[0].totalCap,loaded.reviewQuotaExceptions[0].stageCap],[16,12]);
  let dispatches=0;runtime=gateway.createGatewayRuntime({...loaded,sandboxStatus:{ok:false,backend:'unavailable',resourceLimits:false},dispatchFn:async()=>{dispatches++;throw new Error('must not dispatch');}});
  const tiers=runtime.capabilities().governance.workflowTiers;assert.deepEqual(tiers.reviewQuotaExceptionSummary,[{id:'infalsus-card-lab-phase2-20261012',totalCap:16,stageCap:12,phaseIndex:2}]);
  assert.deepEqual([tiers.reviewQuota.T2.totalCap,tiers.reviewQuota.T2.stageCap],[5,3]);server=runtime.makeServer();client=new Client({name:'quota15-host-proof-test',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  const workflow=JSON.parse((await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}})).content[0].text);
  const result=await client.callTool({name:'dispatch_subagent',arguments:{cwd:scratch,parentRunId:grant().parentRunId,requestId:'quota15-no-host-proof',reviewOfRequestId:'implementation-no-proof',provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',tier:'T2',workflowReceipt:workflow.receipt,
   task:{contractVersion:2,role:'Geburah',objective:'Require trusted host proof',acceptance:['Reject before dispatch'],context:[],readScope:[],writeScope:[],handoff:{version:2,stage:'post-review',inputs:[{requestId:'implementation-no-proof',role:'Chesed',stage:'implementing',resultSha256:'c'.repeat(64)}],runGoal:'proof gate',runAcceptance:['Require proof'],phaseIndex:2},reviewPacket:{version:1,stage:'post-change',requirements:{status:'provided',content:['Proof']},changes:{status:'provided',content:['No host artifact']},context:{status:'provided',content:['Fixture']},verification:{status:'provided',content:['No host record']}}}}});
  const response=JSON.parse(result.content[0].text);assert.equal(response.ok,false,JSON.stringify(response));assert.equal(response.code,'PI_T2_REVIEW_REFERENCE_REQUIRED');assert.equal(dispatches,0);
  await client.close();client=null;await server.close();server=null;await runtime.shutdown({graceMs:0,abortWaitMs:0});runtime=null;
  writeFileSync(config,JSON.stringify({tokenFile:token,auditFile:join(scratch,'audit.jsonl'),providerCircuitFile:join(scratch,'circuit.json'),requestLedgerDir:join(scratch,'ledger17'),roots:[scratch],reviewQuotaExceptions:[grant(17)]}));
  const loaded17=gateway.loadGatewayOptions({PI_GATEWAY_CONFIG:config});assert.deepEqual([loaded17.reviewQuotaExceptions[0].totalCap,loaded17.reviewQuotaExceptions[0].stageCap],[17,13]);
  runtime=gateway.createGatewayRuntime({...loaded17,sandboxStatus:{ok:false,backend:'unavailable',resourceLimits:false},dispatchFn:async()=>{dispatches++;throw new Error('must not dispatch');}});
  const tiers17=runtime.capabilities().governance.workflowTiers;
  assert.deepEqual(tiers17.reviewQuotaExceptionSummary,[{id:'infalsus-card-lab-phase2-20261012',totalCap:17,stageCap:13,phaseIndex:2}]);
  assert.deepEqual([tiers17.reviewQuota.T2.totalCap,tiers17.reviewQuota.T2.stageCap],[5,3]);
  server=runtime.makeServer();client=new Client({name:'quota17-host-proof-test',version:'1'});
  const [ct17,st17]=InMemoryTransport.createLinkedPair();await server.connect(st17);await client.connect(ct17);
  const workflow17=JSON.parse((await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}})).content[0].text);
  const result17=await client.callTool({name:'dispatch_subagent',arguments:{cwd:scratch,parentRunId:grant().parentRunId,requestId:'quota17-no-host-proof',reviewOfRequestId:'implementation-no-proof',provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',tier:'T2',workflowReceipt:workflow17.receipt,
   task:{contractVersion:2,role:'Geburah',objective:'Require trusted host proof',acceptance:['Reject before dispatch'],context:[],readScope:[],writeScope:[],handoff:{version:2,stage:'post-review',inputs:[{requestId:'implementation-no-proof',role:'Chesed',stage:'implementing',resultSha256:'c'.repeat(64)}],runGoal:'proof gate',runAcceptance:['Require proof'],phaseIndex:2},reviewPacket:{version:1,stage:'post-change',requirements:{status:'provided',content:['Proof']},changes:{status:'provided',content:['No host artifact']},context:{status:'provided',content:['Fixture']},verification:{status:'provided',content:['No host record']}}}}});
  const response17=JSON.parse(result17.content[0].text);assert.equal(response17.ok,false,JSON.stringify(response17));assert.equal(response17.code,'PI_T2_REVIEW_REFERENCE_REQUIRED');assert.equal(dispatches,0);
 }finally{await client?.close().catch(()=>{});await server?.close().catch(()=>{});await runtime?.shutdown({graceMs:0,abortWaitMs:0}).catch(()=>{});rmSync(scratch,{recursive:true,force:true});}
});
