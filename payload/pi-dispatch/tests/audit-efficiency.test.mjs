import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectTaskPlanning,COMPLEXITY_PREFIX} from '../scripts/task-planning.mjs';
import {tierDeclarationSchema} from '../scripts/workflow-tier-gate.mjs';
import {buildReviewPacket} from '../scripts/review-materials.mjs';

test('conservative tier advice is whole-task based and does not alter the five semantic flags',()=>{
 const declaration={publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false};
 assert.equal(tierDeclarationSchema.parse(declaration)&&Object.keys(declaration).length,5);
 const basic={context:[COMPLEXITY_PREFIX+JSON.stringify({changeKind:'exact',uncertainty:'none',coupling:'local',reason:'Small exact task'})]};
 assert.equal(inspectTaskPlanning(basic).tierAdvice.classificationRequiresWholeTaskAssessment,true);
 assert.equal(inspectTaskPlanning(basic).tierAdvice.reasonCode,'classify_whole_task');
 assert.equal(Object.hasOwn(inspectTaskPlanning(basic).tierAdvice,'conservativeUpgradeRecommended'),false);
 assert.equal(inspectTaskPlanning({...basic,context:[...basic.context,'TIER_REASON=Shared behavior is consumed by multiple independently maintained packages']} ).tierAdvice.classificationRequiresWholeTaskAssessment,false);
 assert.equal(inspectTaskPlanning({...basic,context:[...basic.context,'TIER_REASON=be safe']} ).tierAdvice.classificationRequiresWholeTaskAssessment,true);
});

test('bounded complete packet builder rejects missing evidence before dispatch',()=>{
 assert.throws(()=>buildReviewPacket({stage:'post-change',tier:'T2',changedFiles:['a.js'],requirements:['R'],changes:['a.js'],context:['C'],verification:['V']}),/substantive patch/);
});
