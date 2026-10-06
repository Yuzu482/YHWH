import test from 'node:test';
import assert from 'node:assert/strict';
import {completedContract,runAnchor,validateHandoff} from '../extensions/stage-handoff.js';
import {roleValue} from './contract-fixtures.mjs';

test('completed standalone contracts carry a host-derived task anchor when original acceptance exists',()=>{
  const task={role:'Chesed',objective:'Implement the requested change',acceptance:['Keep the change scoped','Run focused tests']};
  const contract=completedContract(task,{},'/workspace',roleValue('Chesed'));
  assert.equal(contract.taskAnchorSha256,runAnchor({runGoal:task.objective,runAcceptance:task.acceptance}));
  assert.equal(Object.hasOwn(task,'taskAnchorSha256'),false);
});

test('phase-one primary plan can root pre-review and approved pre-review plus implementation can root direct post-review',()=>{
  const hash='a'.repeat(64);
  const base={version:2,runGoal:'Known scoped task',runAcceptance:['Host verifies the final artifact'],phaseIndex:1};
  const preReview={role:'Geburah',context:['KNOWN_SCOPE= bounded parser rule'],reviewPacket:{stage:'pre-change',changes:{content:['Primary supplied scoped plan']}},handoff:{...base,stage:'pre-review',inputs:[]}};
  assert.equal(validateHandoff(preReview.handoff,preReview).stage,'pre-review');
  assert.throws(()=>validateHandoff({...preReview.handoff,inputs:[]},{...preReview,context:[]}),/KNOWN_SCOPE/);
  const continuation={...base,phaseIndex:2,stage:'pre-review',inputs:[{requestId:'post-1',role:'Geburah',stage:'post-review',resultSha256:hash}]};
  assert.equal(validateHandoff(continuation,{...preReview,handoff:continuation}).phaseIndex,2);
  const legacyPlanned={...continuation,inputs:[{requestId:'plan-2',role:'Chochmah',stage:'planned',resultSha256:hash}]};
  assert.equal(validateHandoff(legacyPlanned,{...preReview,handoff:legacyPlanned}).phaseIndex,2);
  assert.throws(()=>validateHandoff({...continuation,inputs:[]},{...preReview,handoff:{...continuation,inputs:[]}}),error=>error.code==='HANDOFF_INVALID'&&/predecessor/.test(error.message));
  const postReview={role:'Geburah',reviewPacket:{stage:'post-change'},handoff:{...base,stage:'post-review',inputs:[
    {requestId:'pre-1',role:'Geburah',stage:'pre-review',resultSha256:hash},
    {requestId:'impl-1',role:'Chesed',stage:'implementing',resultSha256:'b'.repeat(64)},
  ]}};
  assert.equal(validateHandoff(postReview.handoff,postReview).inputs.length,2);
});

test('legacy standalone task contracts remain valid without missing objective or acceptance',()=>{
  const contract=completedContract({role:'Chesed'}, {}, '/workspace', roleValue('Chesed'));
  assert.equal(Object.hasOwn(contract,'taskAnchorSha256'),false);
});
