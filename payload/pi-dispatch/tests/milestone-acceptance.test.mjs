import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMilestoneAcceptance} from '../extensions/milestone-acceptance.js';

const artifact='a'.repeat(64);
test('only current verified milestone can precede a new authoritative acceptance event',()=>{
  let emitted=0;
  const emit=attempt=>{assertMilestoneAcceptance(attempt,artifact);emitted++;};
  for(const status of ['reserved','started','applying','failed','passed','awaiting-artifact','applied','superseded','abandoned','in_doubt','accepted']){
    assert.throws(()=>emit({status,artifactSha256:artifact,verifyPassed:true}),e=>e.code==='PI_MILESTONE_NOT_VERIFIED');
  }
  assert.throws(()=>emit({status:'verified-not-accepted',artifactSha256:artifact,verifyPassed:false}));
  assert.equal(emitted,0);
  emit({status:'verified-not-accepted',artifactSha256:artifact,verifyPassed:true});assert.equal(emitted,1);
  assert.throws(()=>emit({status:'verified-not-accepted',artifactSha256:'b'.repeat(64),verifyPassed:true}),e=>e.code==='PI_MILESTONE_CONFLICT');
});

test('accepted sidecar alone cannot bootstrap or replay authoritative acceptance',()=>{
  const attempt={status:'accepted',artifactSha256:artifact,verifyPassed:true};
  for(const acceptanceState of ['missing','unknown','not-verified',undefined])assert.throws(()=>assertMilestoneAcceptance(attempt,artifact,{replaying:true,acceptanceState}));
  assert.doesNotThrow(()=>assertMilestoneAcceptance(attempt,artifact,{replaying:true,acceptanceState:'accepted'}));
  assert.throws(()=>assertMilestoneAcceptance(attempt,artifact,{replaying:false,acceptanceState:'accepted'}));
  assert.doesNotThrow(()=>assertMilestoneAcceptance(null,artifact));
});

test('closure drift between initial check and event callback is checked again',()=>{
  const attempt={status:'verified-not-accepted',artifactSha256:artifact,verifyPassed:true};
  assertMilestoneAcceptance(attempt,artifact);attempt.status='abandoned';
  assert.throws(()=>assertMilestoneAcceptance(attempt,artifact),e=>e.code==='PI_MILESTONE_NOT_VERIFIED');
});
