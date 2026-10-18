import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {createReviewAttemptLedger, effectiveReviewQuota, validateReviewQuotaExceptions} from '../scripts/tier-review-policy.mjs';
import {quotaFixture, grant, reviewInput, finish, openState, sha, pins, packageRoot, checkSources, temp, clean} from './helpers/legacy-state-fixtures.mjs';

test('quota: exact grant caps, times, identities and unchanged ordinary defaults',()=>{
  const identity={workspaceSha256:grant().workspaceSha256,runAnchorSha256:grant().runAnchorSha256,tier:'T2'};
  for(const cap of [6,8,11,13,14,15,16,17]){
    const g=validateReviewQuotaExceptions([grant(cap)]),post=effectiveReviewQuota(g,identity,{stage:'post-review',parentRunId:grant().parentRunId,phaseIndex:2});
    const pre=effectiveReviewQuota(g,identity,{stage:'pre-review',parentRunId:grant().parentRunId,phaseIndex:2});
    assert.equal(post.total,cap);assert.equal(post.stage,grant(cap).stageCap);assert.equal(pre.stage,cap>=13?4:3);
    assert.equal(post.time,cap>=16?1800000:1200000);
    for(const field of ['parentRunId','phaseIndex']){
      const candidate={stage:'post-review',parentRunId:grant().parentRunId,phaseIndex:2,[field]:field==='phaseIndex'?1:'other'};
      assert.equal(effectiveReviewQuota(g,identity,candidate).total,5);
    }
  }
  for(const change of [{totalCap:18,stageCap:14},{totalCap:17,stageCap:12},{authorizationReference:'wrong'},{parentRunId:'wrong'},{workspaceSha256:sha('wrong')},{runAnchorSha256:sha('wrong')},{tier:'T1'}]){
    assert.throws(()=>validateReviewQuotaExceptions([{...grant(17),...change}]),/Invalid/);
  }
  assert.throws(()=>validateReviewQuotaExceptions([grant(17),grant(16)]),/Duplicate/);
  assert.deepEqual(effectiveReviewQuota([],identity,{}),{base:2,total:5,stage:3,time:1200000,sharedExtensions:1});
  assert.equal(effectiveReviewQuota([],{...identity,tier:'T1'},{}).total,2);
});

test('quota14: synthetic ten-row prefix, exact evidence reconsideration and immutable history',async()=>{
  const f=await quotaFixture();try{
    const l=openState(join(f.root,'fourteen-positive'),f.ten,f.module,14),before=structuredClone(f.ten);
    const ticket=l.reserve(f.retry);assert.equal(ticket.replayed,false);assert.equal(l.snapshot(reviewInput('inspect')).attempts.at(-1).progressVerified,true);finish(l,ticket);
    for(let i=0;i<3;i++)finish(l,l.reserve(reviewInput('synthetic-after-'+i)));
    const after=l.snapshot(reviewInput('inspect-after'));assert.equal(after.attempts.length,14);
    assert.deepEqual(after.attempts.slice(0,10),before.attempts);
    for(const[id,value]of Object.entries(before.decisions))assert.deepEqual(after.decisions[id],value);
    assert.equal(after.timeUsedMs,before.timeUsedMs+4000);assert.equal(after.attempts.filter(a=>a.stage==='pre-review').length,4);
    assert.throws(()=>l.reserve(reviewInput('fifteenth')),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
    const replay=l.reserve(f.retry);assert.equal(replay.replayed,true);assert.throws(()=>l.markStarted(replay),/Replay/);
    assert.deepEqual(openState(join(f.root,'restart14'),after,f.module,14).snapshot(reviewInput('restarted')),after);
  }finally{f.cleanup();}
});

test('quota14: exact evidence boundaries and unchanged original module rejects synthetic history',async t=>{
  const f=await quotaFixture();try{
    const changes=[
      ['requestId',v=>({...v,requestId:'unapproved'})],['artifact',v=>({...v,artifactDigest:sha('wrong')})],['host',v=>({...v,hostRecordDigest:sha('wrong')})],
      ['material',v=>({...v,materialDigest:sha('wrong')})],['previous',v=>({...v,progress:{...v.progress,previousReviewRequestId:'other'}})],
      ['key',v=>({...v,progress:{...v.progress,closures:[{...v.progress.closures[0],key:sha('other')}]}})],
      ['path',v=>({...v,progress:{...v.progress,closures:[{...v.progress.closures[0],paths:['tests/other.mjs']}]}})],
      ['evidence',v=>({...v,progress:{...v.progress,closures:[{...v.progress.closures[0],evidence:'wrong'}]}})],
      ['missing-progress',v=>({...v,progress:undefined})],['unchanged-requirements',v=>({...v,materialSections:f.ten.attempts.at(-1).materialSections})]
    ];
    for(const[name,change]of changes)await t.test(name,()=>{
      const dir=join(f.root,'negative-'+name),l=openState(dir,f.ten,f.module,14),before=fs.readFileSync(join(dir,f.ten.key+'.json'));
      assert.throws(()=>l.reserve(change(structuredClone(f.retry))),e=>/^PI_REVIEW_/.test(e.code));assert.deepEqual(fs.readFileSync(join(dir,f.ten.key+'.json')),before);
    });
    const unmodified=openState(join(f.root,'unmodified14'),f.ten,{createReviewAttemptLedger},14);
    assert.throws(()=>unmodified.reserve(f.retry),e=>e.code==='PI_REVIEW_LIMIT_EXCEEDED');
  }finally{f.cleanup();}
});

test('quota lifecycle: zero-start never launches on replay, unknown execution retained, corrupt state fails closed',()=>{
  const root=temp();try{
    const l=createReviewAttemptLedger(root),input=reviewInput('ordinary',{tier:'T1',phaseIndex:1,parentRunId:'ordinary-run'});
    const ticket=l.reserve(input);l.finish(ticket,{started:false,outcome:'not-launched'});const replay=l.reserve(input);
    assert.equal(replay.replayed,true);assert.throws(()=>l.markStarted(replay),/Replay/);assert.equal(l.snapshot(input).timeUsedMs,0);
    const next=l.reserve({...input,requestId:'uncertain'});l.markStarted(next);l.finish(next,{started:true,outcome:'unknown',executionKnown:false});
    const state=l.snapshot(input);assert.equal(state.attempts.at(-1).timeKnown,false);assert.equal(state.timeUsedMs,120000);
    assert.deepEqual(createReviewAttemptLedger(root).snapshot(input),state);
    const file=join(root,state.key+'.json');fs.writeFileSync(file,'{broken');assert.throws(()=>l.snapshot(input),/Corrupt/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
    assert.equal(fs.readdirSync(root).some(p=>p.includes('lock')),false);
  }finally{clean(root);}
});

test('fixture provenance: pinned bytes, per-path binary attributes, exact release exclusions and no runtime helper import',()=>{
  checkSources();const repository=join(packageRoot,'../..'),attributes=fs.readFileSync(join(repository,'.gitattributes'),'utf8');
  for(const p of ['extensions/milestone-ledger.js','scripts/card-lab-interrupted-request-recovery.mjs','scripts/tier-review-policy.mjs']){
    assert.ok(attributes.split(/\r?\n/).some(line=>line==='payload/pi-dispatch/'+p+' -text'||line.startsWith('payload/pi-dispatch/'+p+' -text ')));
  }
  const build=fs.readFileSync(join(repository,'Build-Release.ps1'),'utf8');
  for(const p of ['tests/card-lab-interrupted-request-recovery.test.mjs','tests/review-quota-adjudication.test.mjs','tests/review-quota-material-reconsideration.test.mjs','tests/helpers/legacy-state-fixtures.mjs','tests/fixtures/legacy-state-pins.json']){
    assert.ok(build.includes("'payload/pi-dispatch/"+p+"'"));
  }
  for(const p of Object.keys(pins.sourceFiles)){
    assert.doesNotMatch(fs.readFileSync(join(packageRoot,p),'utf8'),/from\s+['"][^'"]*legacy-state-fixtures/);
  }
});
