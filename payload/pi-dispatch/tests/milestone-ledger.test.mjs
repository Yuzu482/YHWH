import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createMilestoneLedger} from '../extensions/milestone-ledger.js';
import {redactSensitiveText} from '../extensions/audit-log.js';

const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'milestone-ledger-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function input(directory,requestId,milestoneId='feature'){return {requestId,workspace:directory,parentRunId:'run-1',milestone:{id:milestoneId,objective:'Implement feature safely',acceptanceCommandIds:['test']},verify:{commands:[{id:'test',argv:['node','--test'],cwd:'.'}]},writeScope:['src/**']};}
function fail(ledger,directory,id,output='failed output'){const previous=ledger.listOpen().items.filter(a=>a.strike).at(-1);ledger.reserve({...input(directory,id),...(previous?{previousFailure:priorFailure(previous.requestId,previous)}:{})});ledger.markStarted(id);return ledger.fail(id,{checkName:'test',output,modelStarted:true});}
function diagnosisFailure(id,ordinal,attempt){return {requestId:id,ordinal,checkName:attempt.evidence.at(-1).checkName,outputSha256:attempt.evidence.at(-1).outputSha256};}
function priorFailure(id,attempt){const e=attempt.evidence.at(-1);return {requestId:id,checkName:e.checkName,outputSha256:e.outputSha256,excerpt:e.excerpt};}

test('two durable failures block new request IDs until exact latest evidence is diagnosed once',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'),{instanceId:'one'});
  const a=fail(ledger,directory,'write-1','first failure'),b=fail(ledger,directory,'write-2','second failure');
  assert.throws(()=>ledger.reserve(input(directory,'write-3')),e=>e.code==='PI_REPEATED_FAILURE_DIAGNOSIS_REQUIRED');
  const diagnosis=ledger.diagnose({workspace:directory,parentRunId:'run-1',milestoneId:'feature',failures:[diagnosisFailure('write-1',1,a),diagnosisFailure('write-2',2,b)],rootCause:'Incorrect implementation assumptions',action:'reduce-scope'});
  const reopened=createMilestoneLedger(join(directory,'state'),{instanceId:'two'});
  assert.equal(reopened.reserve(input(directory,'write-1')).status,'failed');
  assert.equal(reopened.reserve({...input(directory,'write-3'),previousFailure:priorFailure('write-2',b)}).ordinal,3);
  assert.throws(()=>reopened.reserve(input(directory,'write-4')),e=>e.code==='PI_MILESTONE_BUSY');
  reopened.markStarted('write-3');
  const c=reopened.fail('write-3',{checkName:'test',output:'third failure',modelStarted:true});
  assert.throws(()=>reopened.reserve({...input(directory,'write-4'),previousFailure:priorFailure('write-3',c)}),e=>e.code==='PI_REPEATED_FAILURE_DIAGNOSIS_REQUIRED');
  assert.equal(diagnosis.consumed,false);
}));

test('same request replay, changed definition rejection, and output evidence are durable',()=>fixture(directory=>{
  const root=join(directory,'state'),ledger=createMilestoneLedger(root);
  const reserved=ledger.reserve(input(directory,'same'));assert.deepEqual(ledger.reserve(input(directory,'same')),reserved);
  assert.throws(()=>ledger.reserve({...input(directory,'same'),milestone:{...input(directory,'same').milestone,objective:'changed'}}),e=>e.code==='PI_MILESTONE_CONFLICT');
  ledger.markStarted('same');const fixtureText=['Bea','rer'].join('') + ' ' + ['secret','token'].join('-') + ' fixture';
  const failed=ledger.fail('same',{checkName:'test',output:fixtureText,modelStarted:true});
  assert.equal(failed.evidence[0].outputSha256,sha(redactSensitiveText(fixtureText,{compact:false})));
  assert.ok(!failed.evidence[0].excerpt.includes(['secret','token'].join('-') + ' fixture'));
  assert.equal(createMilestoneLedger(root).reserve(input(directory,'same')).evidence[0].outputSha256,failed.evidence[0].outputSha256);
}));

test('zero-start failures do not strike and valid successful verification clears prior strike history',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  ledger.reserve(input(directory,'zero'));ledger.fail('zero',{checkName:'dispatch',output:'not launched',modelStarted:false});
  fail(ledger,directory,'bad-1');
  const good=sha('patch');ledger.verify('bad-1',{passed:true,artifactSha256:good,checkName:'test',output:'host passed'});ledger.accepted('bad-1',good);
  assert.equal(ledger.reserve(input(directory,'after-pass')).ordinal,3);
}));

test('closure transitions preserve evidence, require exact abandonment reason and never auto-accept',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  ledger.reserve(input(directory,'closure'));ledger.markStarted('closure');const artifact=sha('patch');
  ledger.registerArtifact('closure',{artifactSha256:artifact,applied:false});
  assert.throws(()=>ledger.markApplied('closure',sha('wrong')),e=>e.code==='PI_MILESTONE_CONFLICT');
  ledger.markApplied('closure',artifact);
  assert.throws(()=>ledger.reserve(input(directory,'blocked')),e=>e.code==='PI_MILESTONE_CLOSURE_PENDING');
  assert.throws(()=>ledger.abandon('closure',{artifactSha256:sha('wrong'),reason:'reason'}),e=>e.code==='PI_MILESTONE_CONFLICT');
  assert.throws(()=>ledger.accepted('closure',artifact),e=>e.code==='PI_MILESTONE_NOT_VERIFIED');
  assert.equal(ledger.assertOpen('closure',artifact).status,'applied');
  ledger.abandon('closure',{artifactSha256:artifact,reason:'operator stopped'});
  assert.equal(ledger.abandon('closure',{artifactSha256:artifact,reason:'operator stopped'}).status,'abandoned');
  assert.throws(()=>ledger.abandon('closure',{artifactSha256:artifact,reason:'different'}),e=>e.code==='PI_MILESTONE_CONFLICT');
  for(const action of [()=>ledger.markStarted('closure'),()=>ledger.registerArtifact('closure',{artifactSha256:artifact,applied:false}),()=>ledger.markApplied('closure',artifact),()=>ledger.verify('closure',{passed:true,artifactSha256:artifact}),()=>ledger.accepted('closure',artifact)])assert.throws(action);
  assert.throws(()=>ledger.assertOpen('closure',artifact),e=>e.code==='PI_MILESTONE_CLOSED');
}));

test('accepted is terminal and requires a prior passing artifact verification',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  ledger.reserve(input(directory,'accepted'));ledger.markStarted('accepted');const artifact=sha('good');
  ledger.verify('accepted',{passed:true,artifactSha256:artifact,checkName:'test',output:'passed'});
  assert.equal(ledger.accepted('accepted',artifact).status,'accepted');
  assert.throws(()=>ledger.abandon('accepted',{artifactSha256:artifact,reason:'no'}),e=>e.code==='PI_MILESTONE_CLOSED');
  assert.equal(ledger.accepted('accepted',artifact).status,'accepted');
  assert.throws(()=>ledger.registerArtifact('accepted',{artifactSha256:artifact,applied:false}),e=>e.code==='PI_MILESTONE_CONFLICT');
}));

test('active identity reservation blocks and other unresolved instances require reconciliation',()=>fixture(directory=>{
  const root=join(directory,'state'),one=createMilestoneLedger(root,{instanceId:'one'});
  one.reserve(input(directory,'first'));
  assert.throws(()=>one.reserve(input(directory,'second')),e=>e.code==='PI_MILESTONE_BUSY');
  const other=createMilestoneLedger(root,{instanceId:'two'});
  assert.throws(()=>other.reserve(input(directory,'third')),e=>e.code==='PI_MILESTONE_RECONCILIATION_NEEDED');
  assert.equal(one.listOpen().items[0].status,'reserved');
}));

test('supersession waits for actual start and failed host verification can be retried only through new lifecycle',()=>fixture(directory=>{
  const root=join(directory,'state'),ledger=createMilestoneLedger(root);
  ledger.reserve(input(directory,'old'));ledger.markStarted('old');const artifact=sha('old');ledger.registerArtifact('old',{artifactSha256:artifact,applied:false});
  const next=input(directory,'next');ledger.reserve(next);
  assert.equal(ledger.assertOpen('old',artifact).status,'awaiting-artifact');
  ledger.markStarted('next');assert.throws(()=>ledger.assertOpen('old',artifact),e=>e.code==='PI_MILESTONE_CLOSED');
  const fresh=createMilestoneLedger(join(directory,'other'));fresh.reserve(input(directory,'host'));fresh.markStarted('host');const h=sha('artifact');
  fresh.registerArtifact('host',{artifactSha256:h,applied:false});fresh.verify('host',{passed:true,artifactSha256:h,checkName:'host',output:'pass'});
  assert.equal(fresh.assertOpen('host',h).status,'verified-not-accepted');
}));

test('host strike evidence deduplicates and diagnoses exact ordinal, check and excerpt',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  const a=fail(ledger,directory,'a','one'), b=fail(ledger,directory,'b','two');
  ledger.verify('b',{passed:false,artifactSha256:sha('patch'),checkName:'test',output:'two'});
  const evidence=[diagnosisFailure('a',1,a),diagnosisFailure('b',2,b)];
  assert.throws(()=>ledger.diagnose({workspace:directory,parentRunId:'run-1',milestoneId:'feature',failures:[evidence[0],{...evidence[1],ordinal:9}],rootCause:'cause',action:'split-milestone'}),e=>e.code==='PI_MILESTONE_DIAGNOSIS_MISMATCH');
  assert.throws(()=>ledger.reserve({...input(directory,'c'),previousFailure:priorFailure('b',b)}),e=>e.code==='PI_REPEATED_FAILURE_DIAGNOSIS_REQUIRED');
}));

test('queries are read-only; invalid clocks, corrupt integrity and stale cursors fail safely',()=>fixture(directory=>{
  const root=join(directory,'state'),ledger=createMilestoneLedger(root,{now:()=>100});ledger.reserve(input(directory,'first'));
  const path=join(root,'milestones.json'),before=readFileSync(path),mtime=statSync(path).mtimeMs;
  ledger.listOpen();
  assert.deepEqual(readFileSync(path),before);assert.equal(statSync(path).mtimeMs,mtime);
  const page=ledger.listOpen({limit:1});assert.equal(page.items[0].stale,false);
  assert.throws(()=>createMilestoneLedger(join(directory,'invalid-time'),{now:()=>Infinity}).reserve(input(directory,'x')),e=>e.code==='PI_MILESTONE_INVALID');
  writeFileSync(path,'{}');assert.throws(()=>ledger.listOpen(),e=>e.code==='PI_MILESTONE_STORAGE_FAILED');
}));

test('pagination detects changed snapshot; corrupt storage and orphan locks fail closed',()=>fixture(directory=>{
  const root=join(directory,'state'),ledger=createMilestoneLedger(root);
  ledger.reserve(input(directory,'first'));ledger.reserve(input(directory,'second','other'));
  const page=ledger.listOpen({limit:1});assert.equal(page.items.length,1);assert.ok(page.cursor);
  ledger.reserve(input(directory,'third','third'));
  assert.throws(()=>ledger.listOpen({limit:1,cursor:page.cursor}),e=>e.code==='PI_MILESTONE_CURSOR_STALE');
  writeFileSync(join(root,'milestones.lock'),'crashed');assert.throws(()=>ledger.reserve(input(directory,'locked','locked')),e=>e.code==='PI_MILESTONE_RECONCILIATION_NEEDED');
  rmSync(join(root,'milestones.lock'));writeFileSync(join(root,'milestones.json'),'{}');
  assert.throws(()=>ledger.listOpen(),e=>e.code==='PI_MILESTONE_STORAGE_FAILED');
  assert.throws(()=>ledger.reserve(input(directory,'corrupt')),e=>e.code==='PI_MILESTONE_STORAGE_FAILED');
}));

test('first repair requires the exact stored failure, not an unsupported repair instruction',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  const failed=fail(ledger,directory,'failed','actual failing assertion');
  assert.throws(()=>ledger.reserve(input(directory,'repair')),e=>e.code==='PI_MILESTONE_PREVIOUS_FAILURE_REQUIRED');
  assert.throws(()=>ledger.reserve({...input(directory,'repair'),previousFailure:{...priorFailure('failed',failed),excerpt:'please fix'}}),e=>e.code==='PI_MILESTONE_PREVIOUS_FAILURE_REQUIRED');
  assert.equal(ledger.reserve({...input(directory,'repair'),previousFailure:priorFailure('failed',failed)}).ordinal,2);
}));

test('applied passing verification closes normally and resets the active failure streak',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  const failed=fail(ledger,directory,'failed');
  ledger.reserve({...input(directory,'repair'),previousFailure:priorFailure('failed',failed)});
  ledger.markStarted('repair');const h=sha('repaired artifact');
  ledger.registerArtifact('repair',{artifactSha256:h,applied:false});ledger.markApplied('repair',h);
  assert.equal(ledger.verify('repair',{passed:true,artifactSha256:h}).status,'verified-not-accepted');
  assert.equal(ledger.accepted('repair',h).status,'accepted');
  assert.equal(ledger.reserve(input(directory,'next')).ordinal,3);
  assert.throws(()=>ledger.diagnose({workspace:directory,parentRunId:'run-1',milestoneId:'feature',failures:[diagnosisFailure('failed',1,failed),diagnosisFailure('failed',1,failed)],rootCause:'obsolete',action:'reduce-scope'}),e=>e.code==='PI_MILESTONE_DIAGNOSIS_MISMATCH');
}));

test('late success cannot clear newer failure evidence',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  fail(ledger,directory,'old');fail(ledger,directory,'new');
  assert.throws(()=>ledger.verify('old',{passed:true,artifactSha256:sha('late')}),e=>e.code==='PI_MILESTONE_STALE_PASS');
  assert.throws(()=>ledger.reserve(input(directory,'third')),e=>e.code==='PI_REPEATED_FAILURE_DIAGNOSIS_REQUIRED');
}));

test('restart exposes uncertainty read-only; stale boundary and future clock are explicit',()=>fixture(directory=>{
  const root=join(directory,'state'),one=createMilestoneLedger(root,{instanceId:'one',now:()=>100});
  one.reserve(input(directory,'live'));const path=join(root,'milestones.json'),bytes=readFileSync(path);
  const restarted=createMilestoneLedger(root,{instanceId:'two',now:()=>7200100});
  assert.equal(restarted.listOpen().items[0].status,'in_doubt');
  assert.equal(restarted.listOpen().items[0].stale,true);
  assert.equal(createMilestoneLedger(root,{now:()=>99}).listOpen().items[0].stale,null);
  assert.deepEqual(readFileSync(path),bytes);
}));

test('a zero-start replacement preserves the earlier artifact and unique failure evidence',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  ledger.reserve(input(directory,'old'));ledger.markStarted('old');const h=sha('still valid');
  ledger.registerArtifact('old',{artifactSha256:h,applied:false});
  ledger.reserve(input(directory,'not-started'));ledger.fail('not-started',{modelStarted:false,output:'admission failed'});
  assert.equal(ledger.assertOpen('old',h).status,'awaiting-artifact');
  assert.equal(ledger.get('not-started').strike,false);
  assert.equal(ledger.get('missing'),null);
}));

test('durable apply intent blocks replacement and survives restart without licensing a second apply',()=>fixture(directory=>{
  const root=join(directory,'state'),ledger=createMilestoneLedger(root,{instanceId:'one'}),h=sha('patch');
  ledger.reserve(input(directory,'apply'));ledger.markStarted('apply');ledger.registerArtifact('apply',{artifactSha256:h,applied:false});
  ledger.beginApply('apply',h);
  assert.throws(()=>ledger.reserve(input(directory,'replacement')),e=>e.code==='PI_MILESTONE_CLOSURE_PENDING');
  assert.throws(()=>ledger.abandon('apply',{artifactSha256:h,reason:'cannot erase uncertain write'}),e=>e.code==='PI_MILESTONE_CLOSED');
  const restarted=createMilestoneLedger(root,{instanceId:'two'});
  assert.equal(restarted.listOpen().items[0].status,'in_doubt');
  assert.throws(()=>restarted.completeApply('apply',h),e=>e.code==='PI_MILESTONE_RECONCILIATION_NEEDED');
  assert.throws(()=>restarted.reserve(input(directory,'after-restart')),e=>e.code==='PI_MILESTONE_RECONCILIATION_NEEDED');
  assert.equal(ledger.completeApply('apply',h).status,'applied');
}));

test('host verification cannot race a reserved successor; proven zero launch restores verifiability',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state')),h=sha('old patch');
  ledger.reserve(input(directory,'old'));ledger.markStarted('old');ledger.registerArtifact('old',{artifactSha256:h,applied:false});
  ledger.reserve(input(directory,'new'));
  assert.throws(()=>ledger.assertVerifiable('old',h),e=>e.code==='PI_MILESTONE_RECONCILIATION_NEEDED');
  assert.throws(()=>ledger.verify('old',{passed:true,artifactSha256:h}),e=>e.code==='PI_MILESTONE_RECONCILIATION_NEEDED');
  ledger.fail('new',{modelStarted:false,output:'launch not attempted'});
  assert.equal(ledger.assertVerifiable('old',h).status,'awaiting-artifact');
  assert.equal(ledger.verify('old',{passed:true,artifactSha256:h}).status,'verified-not-accepted');
}));

test('legacy closure never assigns a milestone or rewrites original attempt evidence',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state')),h=sha('legacy');
  const record=ledger.abandonLegacy({requestId:'legacy',artifactSha256:h,reason:'Retired artifact, evidence retained'});
  assert.equal(record.milestone,null);assert.equal(ledger.get('legacy'),null);
  assert.deepEqual(ledger.abandonLegacy({requestId:'legacy',artifactSha256:h,reason:record.reason}),record);
  assert.throws(()=>ledger.abandonLegacy({requestId:'legacy',artifactSha256:sha('other'),reason:record.reason}),e=>e.code==='PI_MILESTONE_CONFLICT');
  assert.throws(()=>ledger.abandonLegacy({requestId:'legacy',artifactSha256:h,reason:'new reason'}),e=>e.code==='PI_MILESTONE_CONFLICT');
  assert.deepEqual(ledger.classifyRequests(['legacy','unknown']),{trackedIds:[],closedLegacyIds:['legacy']});
  assert.equal(ledger.listOpen().items.length,0);
}));

test('a failed zero-start attempt cannot be relabeled as an actual execution',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  ledger.reserve(input(directory,'zero'));ledger.fail('zero',{modelStarted:false,output:'not started'});
  assert.throws(()=>ledger.fail('zero',{modelStarted:true,output:'same request, invented execution'}),e=>e.code==='PI_MILESTONE_CONFLICT');
  assert.equal(ledger.get('zero').strike,false);
}));

test('spent zero-start diagnosis needs a fresh exact host diagnosis, never an automatic refund',()=>fixture(directory=>{
  const ledger=createMilestoneLedger(join(directory,'state'));
  const a=fail(ledger,directory,'bad-1'),b=fail(ledger,directory,'bad-2');
  const diagnose={workspace:directory,parentRunId:'run-1',milestoneId:'feature',failures:[diagnosisFailure('bad-1',1,a),diagnosisFailure('bad-2',2,b)],rootCause:'Original implementation failure',action:'reduce-scope'};
  ledger.diagnose(diagnose);
  const repair=id=>({...input(directory,id),previousFailure:priorFailure('bad-2',b)});
  for(const [id,next] of [['zero-1','zero-2'],['zero-2','zero-3']]){
    ledger.reserve(repair(id));
    assert.throws(()=>ledger.diagnose({...diagnose,afterRequestId:id}),e=>e.code==='PI_MILESTONE_DIAGNOSIS_MISMATCH');
    ledger.fail(id,{modelStarted:false,output:'Proven not launched'});
    assert.throws(()=>ledger.reserve(repair(next)),e=>e.code==='PI_REPEATED_FAILURE_DIAGNOSIS_REQUIRED');
    const original=ledger.diagnose(diagnose);assert.equal(original.consumed,true);assert.equal(original.consumedByRequestId,'zero-1');
    assert.throws(()=>ledger.diagnose({...diagnose,afterRequestId:'wrong'}),e=>e.code==='PI_MILESTONE_DIAGNOSIS_MISMATCH');
    const fresh=ledger.diagnose({...diagnose,afterRequestId:id,rootCause:'Host diagnosed exact zero-start failure'});
    assert.equal(fresh.consumed,false);assert.equal(fresh.retryBasisRequestId,id);
    assert.deepEqual(ledger.diagnose({...diagnose,afterRequestId:id,rootCause:fresh.rootCause}),fresh);
    assert.throws(()=>ledger.diagnose({...diagnose,afterRequestId:id,rootCause:'Conflicting root cause'}),e=>e.code==='PI_MILESTONE_CONFLICT');
  }
  ledger.reserve(repair('zero-3'));ledger.markUncertain('zero-3');
  assert.throws(()=>ledger.diagnose({...diagnose,afterRequestId:'zero-3'}),e=>e.code==='PI_MILESTONE_DIAGNOSIS_MISMATCH');
}));
