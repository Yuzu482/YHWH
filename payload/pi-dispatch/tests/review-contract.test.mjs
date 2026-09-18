import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReviewPacket,requireReviewMaterials,validateReviewDecision} from '../extensions/review-contract.js';
import {validateKetherTask,compileKetherTask} from '../extensions/kether-envelope.js';
const packet=()=>({version:1,stage:'post-change',...Object.fromEntries(['requirements','changes','context','verification'].map(k=>[k,{status:'provided',content:[`${k}: concrete fixture evidence`]}]))});
test('review packet requires all evidence sections and fixed decision fields',()=>{
 const task=validateKetherTask({role:'reviewer',objective:'Review fixture',reviewPacket:packet()});
 assert.doesNotThrow(()=>requireReviewMaterials(task));
 assert.ok(task.returnFields.includes('reviewDecision'));
 assert.match(compileKetherTask(task),/insufficient-materials/);
 for (const key of ['requirements','changes','context','verification']) {
  const p=packet();delete p[key];
  assert.throws(()=>requireReviewMaterials(validateKetherTask({...task,reviewPacket:p})),e=>e.code==='REVIEW_MATERIALS_MISSING'&&e.missingMaterials.includes(key));
 }
 assert.throws(()=>requireReviewMaterials(validateKetherTask({role:'reviewer',objective:'No packet'})),/Review materials missing/);
 assert.throws(()=>requireReviewMaterials({...task,returnFields:['status']}),/must include/);
});
test('review omissions require explicit justification and cannot omit requirements or context',()=>{
 const p=packet();p.changes={status:'not-applicable',reason:'Pre-change design review; no diff exists',content:[]};p.stage='pre-change';
 assert.doesNotThrow(()=>validateReviewPacket(p));
 delete p.changes.reason;assert.throws(()=>validateReviewPacket(p),/justification/);
 p.changes={status:'missing'};p.context={status:'not-applicable',reason:'skip'};assert.throws(()=>validateReviewPacket(p),/justification/);
});
test('review cannot approve with missing materials, blocked status, or no evidence',()=>{
 const valid={status:'completed',reviewDecision:'approve',missingMaterials:[],evidence:['Observed fixture']};
 assert.equal(validateReviewDecision(valid).approved,true);
 for(const changes of [{missingMaterials:['tests']},{status:'blocked'},{evidence:[]},{reviewDecision:'unknown'}]) assert.equal(validateReviewDecision({...valid,...changes}).ok,false);
 assert.equal(validateReviewDecision({status:'blocked',reviewDecision:'insufficient-materials',missingMaterials:['tests']}).ok,true);
 assert.equal(validateReviewDecision({...valid,reviewDecision:'request-changes'}).approved,false);
});
