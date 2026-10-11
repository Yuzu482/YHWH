import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReviewPacket,requireReviewMaterials,validateReviewDecision,missingReviewPatchMaterials,measureReviewPacket,enforceT1ReviewBudget} from '../extensions/review-contract.js';
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
 const empty=packet();empty.changes={status:'provided',content:['  ']};
 assert.throws(()=>validateKetherTask({role:'reviewer',objective:'Empty material',reviewPacket:empty}),/Invalid reviewPacket.changes.content/);
 assert.throws(()=>requireReviewMaterials({role:'reviewer',reviewPacket:empty}),e=>e.code==='REVIEW_MATERIALS_MISSING'&&e.missingMaterials.includes('changes'));
 assert.throws(()=>requireReviewMaterials({...task,returnFields:['status']}),/must include/);
 const omittedFields={...task};delete omittedFields.returnFields;
 assert.doesNotThrow(()=>requireReviewMaterials(omittedFields));
 assert.throws(()=>requireReviewMaterials({...task,returnFields:'status'}),/must be an array/);
});
test('review omissions require explicit justification and cannot omit requirements or context',()=>{
 const p=packet();p.changes={status:'not-applicable',reason:'Pre-change design review; no diff exists',content:[]};p.verification={status:'not-applicable',reason:'No host execution is applicable before changes',content:[]};p.stage='pre-change';
 assert.doesNotThrow(()=>validateReviewPacket(p));
 assert.doesNotThrow(()=>requireReviewMaterials(validateKetherTask({role:'Geburah',objective:'Review justified omissions',reviewPacket:p})));
 delete p.changes.reason;assert.throws(()=>validateReviewPacket(p),/justification/);
 p.changes={status:'missing'};p.context={status:'not-applicable',reason:'skip'};assert.throws(()=>validateReviewPacket(p),/justification/);
 p.context={status:'provided',content:['Context']};p.requirements={status:'not-applicable',reason:'skip'};
 assert.throws(()=>requireReviewMaterials({role:'Geburah',reviewPacket:p}),e=>e.code==='REVIEW_MATERIALS_MISSING'&&e.missingMaterials.includes('requirements'));
});
test('T1 budgets include normalized JSON overhead and Unicode at exact independent boundaries',()=>{
 const exact=packet();exact.context.content=['中文🙂'];
 const size=()=>measureReviewPacket(validateReviewPacket(exact)).nonDiffUtf8Bytes;
 while(size()<8192){const key=exact.requirements.content[0].length<7900?'requirements':'verification';exact[key].content[0]+='x';}
 assert.equal(size(),8192);assert.doesNotThrow(()=>validateReviewPacket(exact,{tier:'T1'}));
 exact.verification.content[0]+='x';assert.equal(size(),8193);
 assert.throws(()=>validateReviewPacket(exact,{tier:'T1'}),e=>e.code==='REVIEW_PACKET_T1_LIMIT');
 exact.stage='pre-change';assert.throws(()=>validateReviewPacket(exact,{tier:'T1'}),e=>e.code==='REVIEW_PACKET_T1_LIMIT');
 assert.doesNotThrow(()=>validateReviewPacket(exact)); // T2 safety cap is unchanged.
 const large=packet();
 const setDiff=n=>{const patch='--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+'+'x'.repeat(n)+'\n';large.changes.content=[patch.slice(0,6000),patch.slice(6000,12000),patch.slice(12000,18000),patch.slice(18000)];return patch;};
 let length=23000,patch=setDiff(length);
 length+=24576-measureReviewPacket(large).totalUtf8Bytes;patch=setDiff(length);
 assert.equal(measureReviewPacket(large).totalUtf8Bytes,24576);
 assert.equal(measureReviewPacket(large).validatedDiff,true);
 assert.ok(measureReviewPacket(large).nonDiffUtf8Bytes<8192);
 assert.doesNotThrow(()=>enforceT1ReviewBudget(large,{trustedPatch:patch}));
 assert.doesNotThrow(()=>validateReviewPacket(large,{tier:'T1'}));
 setDiff(length+1);assert.throws(()=>validateReviewPacket(large,{tier:'T1'}),e=>e.code==='REVIEW_PACKET_T1_LIMIT'&&e.totalUtf8Bytes===24577);
});
test('only complete validated diff can be exempt; prose and stale fingerprints never earn budget',()=>{
 const patch='--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n';
 const p=packet();p.changes.content=[patch.slice(0,22),patch.slice(22)];
 const original=JSON.stringify(p);
 const measured=measureReviewPacket(p,{trustedPatch:patch});
 const stripped=structuredClone(p);stripped.changes.content=['',''];
 assert.equal(measured.nonDiffUtf8Bytes,Buffer.byteLength(JSON.stringify(stripped),'utf8'));
 assert.equal(JSON.stringify(p),original);
 for(const invalid of [patch.replace('+new','+stale'),patch.replace('@@ -1 +1 @@','@@ -1 +2 @@'),patch+'explanatory prose\n',patch.slice(0,patch.indexOf('+new')), 'x.js changed']){
  p.changes.content=[invalid];const m=measureReviewPacket(p,{trustedPatch:patch});
  assert.equal(m.validatedDiff,false);assert.equal(m.nonDiffUtf8Bytes,m.totalUtf8Bytes);
 }
 p.changes.content=[patch];p.changes.reason='An explanation always counts';
 assert.ok(measureReviewPacket(p).nonDiffUtf8Bytes>measured.nonDiffUtf8Bytes);
 p.context.content=['x'.repeat(7900),'y'.repeat(400)];
 assert.throws(()=>validateReviewPacket(p,{tier:'T1'}),e=>e.code==='REVIEW_PACKET_T1_LIMIT');
});
test('T1 patch material coverage requires changed lines in a matching unified-diff section',()=>{
 const patch='--- /sandbox/baseline/src/a.js\n+++ /sandbox/workspace/src/a.js\n@@ -1 +1 @@\n-old\n+new\n';
 assert.deepEqual(missingReviewPatchMaterials(['src/a.js','src/b.js'],[patch]),['src/b.js']);
 assert.deepEqual(missingReviewPatchMaterials(['src/a.js'],['src/a.js changed']),['src/a.js']);
 assert.deepEqual(missingReviewPatchMaterials(['src/a.js'],['--- /sandbox/baseline/src/a.js\n+++ /sandbox/workspace/src/a.js\n@@ -1 +1 @@\n context\n']),['src/a.js']);
 assert.deepEqual(missingReviewPatchMaterials(['a.js'],['--- /sandbox/baseline/one/a.js\n+++ /sandbox/workspace/one/a.js\n@@ -1 +1 @@\n+x\n']),['a.js']);
 assert.deepEqual(missingReviewPatchMaterials(['a/dir/x.js'],['--- a/a/dir/x.js\n+++ b/a/dir/x.js\n@@ -0,0 +1 @@\n+x\n']),[]);
 assert.deepEqual(missingReviewPatchMaterials(['b/dir/x.js'],['--- "a/b/dir/x.js"\n+++ "b/b/dir/x.js"\n@@ -1 +0,0 @@\n-old\n']),[]);
 assert.deepEqual(missingReviewPatchMaterials(['a/dir/x.js','b/dir/y.js','src/file with spaces.js'],[
  '--- a/a/dir/x.js\n+++ b/a/dir/x.js\n@@ -1 +1 @@\n-old\n+new',
  '--- a/b/dir/y.js\n+++ b/b/dir/y.js\n@@ -1 +1 @@\n-old\n+new',
  '--- "a/src/file with spaces.js"\n+++ "b/src/file with spaces.js"\n@@ -1 +1 @@\n-old\n+new',
 ]),[]);
 assert.deepEqual(missingReviewPatchMaterials(['src/file with spaces.js'],['--- "a/src/file with spaces.js"\n+++ "b/src/file with spaces.js"\n@@ -1 +1 @@\n-old\n+new\n']),[]);
 assert.deepEqual(missingReviewPatchMaterials(['dir/x.js'],['--- a/a/dir/x.js\n+++ b/a/dir/x.js\n@@ -1 +1 @@\n-old\n+new']),['dir/x.js']);
 assert.deepEqual(missingReviewPatchMaterials(['a/x.js'],['--- a/x.js\n+++ b/x.js\n prose +not a hunk\n']),['a/x.js']);
 assert.deepEqual(missingReviewPatchMaterials(['a/x.js'],['--- a/a/x.js\n+++ b/a/x.js\n@@ -1 +1 @@\n+x\n--- a/other.js\n+++ b/other.js\n@@ -1 +1 @@\n+y\n']),[]);
 assert.deepEqual(missingReviewPatchMaterials(['x.js'],['--- /var/lib/pi-kether/jobs/1/baseline/x.js\n+++ /var/lib/pi-kether/jobs/1/workspace/x.js\n@@ -1 +1 @@\n+x\n']),[]);
 assert.deepEqual(missingReviewPatchMaterials([''],['--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n+x']),['<changed-file-list-unavailable>']);
});
test('T1 conditional approval requires every finding explicitly nonblocking and non-high',()=>{
 const base={status:'completed',reviewDecision:'approve',missingMaterials:[],evidence:['Reviewed']};
 const decision=findings=>validateReviewDecision({...base,deliverable:{findings}}, {tier:'T1'});
 assert.equal(decision([]).conditional,false);
 const approved=decision([{severity:'low',description:'Note',evidence:'e',blocking:false}]);
 assert.equal(approved.approved,true);assert.equal(approved.conditional,true);assert.equal(approved.code,'conditional_approval');
 for(const finding of [
  {severity:'low',description:'x',evidence:'e'},
  {severity:'low',description:'x',evidence:'e',blocking:true},
  {severity:'high',description:'x',evidence:'e',blocking:false},
  {severity:'critical',description:'x',evidence:'e',blocking:false},
  {severity:'low',description:'x',evidence:'e',blocking:'false'},
  {severity:'low',description:'x',evidence:'e',blocking:false,extra:true},
 ]) assert.equal(decision([finding]).approved,false);
 assert.equal(validateReviewDecision({...base,reviewDecision:'request-changes',deliverable:{findings:[{severity:'low',description:'x',evidence:'e',blocking:false}]}},{tier:'T1'}).approved,false);
 assert.equal(validateReviewDecision({...base,deliverable:{findings:[{severity:'high',description:'x',evidence:'e'}]}},{tier:'T2'}).approved,true);
});
test('review cannot approve with missing materials, blocked status, or no evidence',()=>{
 const valid={status:'completed',reviewDecision:'approve',missingMaterials:[],evidence:['Observed fixture']};
 assert.equal(validateReviewDecision(valid).approved,true);
 for(const changes of [{missingMaterials:['tests']},{status:'blocked'},{evidence:[]},{reviewDecision:'unknown'}]) assert.equal(validateReviewDecision({...valid,...changes}).ok,false);
 assert.equal(validateReviewDecision({status:'blocked',reviewDecision:'insufficient-materials',missingMaterials:['tests']}).ok,true);
 assert.equal(validateReviewDecision({...valid,reviewDecision:'request-changes'}).approved,false);
});

test('sandbox root removal preserves repository baseline and workspace directories',()=>{
 const paths=['workspace/x.js','baseline/x.js','src/workspace/x.js','src/baseline/workspace/x.js','a/workspace/x.js','b/baseline/x.js'];
 for(const file of paths) for(const root of ['/sandbox','/var/lib/pi-kether/jobs/123']) {
  const patch='--- '+root+'/baseline/'+file+'\n+++ '+root+'/workspace/'+file+'\n@@ -1 +1 @@\n-old\n+new\n';
  assert.deepEqual(missingReviewPatchMaterials([file],[patch]),[],root+'/'+file);
  assert.deepEqual(missingReviewPatchMaterials(['x.js'],[patch]),['x.js']);
 }
 for(const file of paths) assert.deepEqual(missingReviewPatchMaterials([file],['--- a/'+file+'\n+++ b/'+file+'\n@@ -1 +1 @@\n-old\n+new']),[]);
 assert.deepEqual(missingReviewPatchMaterials(['x.js'],['--- /unrelated/workspace/x.js\n+++ /unrelated/baseline/x.js\n@@ -1 +1 @@\n-old\n+new']),['x.js']);
});
