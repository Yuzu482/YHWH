import test from 'node:test';
import assert from 'node:assert/strict';
import { tierDeclarationSchema, classifyPatchTier, validateT0Patch, validateWriteTier, tierObservation } from '../scripts/workflow-tier-gate.mjs';

const declaration = overrides => ({ publicApiOrProtocol:false, dependencyOrLockfile:false, securityAuthOrCredentials:false, migration:false, irreversibleOrNoRollback:false, ...overrides });

test('tier observations are advisory and never count unknown derivation as T0',()=>{
  assert.deepEqual(tierObservation('T2',null),{declaredTier:'T2'});
  assert.equal(tierObservation('T2',{effective:'T0'}).tierOverDeclared,true);
  const reason='Shared gateway admission semantics affect all concurrent tasks.';
  assert.deepEqual(tierObservation('T2',{effective:'T1'},['TIER_REASON='+reason]),{declaredTier:'T2',derivedTier:'T1',tierOverDeclared:false,tierReason:reason});
  for(const context of [['TIER_REASON='],['TIER_REASON=unknown'],['TIER_REASON='+reason,'TIER_REASON='+reason],['TIER_REASON='+'x'.repeat(401)]]){const observed=tierObservation('T2',{effective:'T1'},context);assert.equal(observed.tierOverDeclared,true);assert.equal(observed.tierReasonInvalid,true);}
  const derived=classifyPatchTier(diff(1),declaration(),'critical',['a.js']);assert.equal(tierObservation('T1',derived).tierOverDeclared,false);assert.equal(derived.effective,'T1');
});
const input = (overrides = {}) => ({ access:'workspace-write', workflowReceipt:'receipt', tier:'T0', tierDeclaration:declaration(), task:{writeScope:['src/a.js']}, ...overrides });
const requireTopic = (topic, receipt) => { assert.equal(topic,'task-tiers'); assert.equal(receipt,'receipt'); };
function diff(count, prefix='diff -ruN old/a.js new/a.js\n') { return `${prefix}--- old/a.js\n+++ new/a.js\n@@ -1,${count} +1,${count} @@\n${'-x\n'.repeat(count)}${'+y\n'.repeat(count)}`; }

test('tier declaration schema accepts exactly five booleans and rejects historical fields', () => {
  assert.equal(tierDeclarationSchema.safeParse(declaration()).success,true);
  for (const key of ['files','estimatedLines','isTestOrConfigChange','uncertainFileScope']) assert.equal(tierDeclarationSchema.safeParse({...declaration(),[key]:key==='files'?['a']:false}).success,false);
  assert.equal(tierDeclarationSchema.safeParse({...declaration(),unexpected:true}).success,false);
});
test('T0 and T1 bypass receipt verification; reads bypass write gate', () => {
  assert.equal(validateWriteTier({access:'read'},()=>assert.fail('read must not require receipt')),null);
  assert.deepEqual(validateWriteTier(input(),null),{level:'T0',minimumLevel:'T0',requiresPreReview:false,requiresPostReview:false});
  assert.deepEqual(validateWriteTier(input({tier:'T1'}),null),{level:'T1',minimumLevel:'T0',requiresPreReview:false,requiresPostReview:true});
});
test('missing and understated tiers reject with clear workflow tier errors', () => {
  assert.throws(()=>validateWriteTier(input({tier:undefined}),requireTopic),e=>e.code==='WORKFLOW_TIER_REQUIRED');
  assert.throws(()=>validateWriteTier(input({tierDeclaration:undefined}),requireTopic),e=>e.code==='WORKFLOW_TIER_REQUIRED');
  assert.throws(()=>validateWriteTier(input({tierDeclaration:{...declaration(),old:true}}),requireTopic),e=>e.code==='WORKFLOW_TIER_INVALID');
});
test('T2 requires linked implementing Chesed handoff with Geburah pre-review input', () => {
  const tierDeclaration=declaration({publicApiOrProtocol:true});
  assert.throws(()=>validateWriteTier(input({tier:'T2',tierDeclaration}),requireTopic),e=>e.code==='WORKFLOW_TIER_PRE_REVIEW_REQUIRED');
  const task={role:'Chesed',writeScope:['src/a.js'],handoff:{version:2,stage:'implementing',inputs:[{role:'Geburah',stage:'pre-review'}]}};
  assert.equal(validateWriteTier(input({tier:'T2',tierDeclaration,task}),requireTopic).requiresPreReview,true);
  assert.throws(()=>validateWriteTier(input({tier:'T2',tierDeclaration,task}),null),e=>e.code==='WORKFLOW_TIER_INVALID');
});
test('profile-adjusted gates promote critical T0 and cap personal T2 without bypassing T2 pre-review', () => {
  assert.throws(()=>validateWriteTier(input(),requireTopic,'critical'),e=>e.code==='WORKFLOW_TIER_INVALID');
  const critical = validateWriteTier(input({tier:'T1'}),()=>assert.fail('critical T1 must not require a receipt'),'critical');
  assert.equal(critical.level,'T1'); assert.equal(critical.requiresPreReview,false);
  const personal = input({tier:'T2',tierDeclaration:declaration({migration:true}),task:{role:'Chesed',writeScope:['src/a.js'],handoff:{version:2,stage:'implementing',inputs:[{role:'Geburah',stage:'pre-review'}]}}});
  const adjusted=validateWriteTier(personal,()=>assert.fail('personal T2 capped to T1 must not require a receipt'),'personal');
  assert.equal(adjusted.level,'T1'); assert.equal(adjusted.requiresPreReview,false);
  assert.throws(()=>validateWriteTier({...personal,task:{...personal.task,handoff:undefined}},requireTopic,'standard'),e=>e.code==='WORKFLOW_TIER_PRE_REVIEW_REQUIRED');
  assert.throws(()=>validateWriteTier(input({riskProfile:'critical'}),requireTopic,'standard'),e=>e.code==='WORKFLOW_TIER_INVALID');
});

test('actual patch classification supports diff -ruN and git, additions and deletions', () => {
  assert.equal(classifyPatchTier(diff(2),declaration()).effective,'T0');
  assert.equal(classifyPatchTier(diff(2,'diff --git a/a.js b/a.js\n'),declaration()).deletedLines,2);
  assert.equal(validateT0Patch(diff(2)),true);
  assert.equal(validateT0Patch(''),false);
});
test('malformed hunk, empty, rename-only, and binary patches fail closed', () => {
  for(const patch of ['', 'diff --git a/a b/a\nrename from a\nrename to b\n','diff --git a/a b/a\nGIT binary patch\n','diff -ruN old/a new/a\n--- old/a\n+++ new/a\n@@ -1,2 +1,1 @@\n-x\n+y\n']) assert.throws(()=>classifyPatchTier(patch,declaration()));
});
