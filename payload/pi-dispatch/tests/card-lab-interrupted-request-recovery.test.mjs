import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createMilestoneLedger} from '../extensions/milestone-ledger.js';
import {recoveryFixture, pins, sha, canonicalHash, packageRoot, checkSources} from './helpers/legacy-state-fixtures.mjs';

const c=pins.constants.RECOVERY, artifact='b'.repeat(64);
const reject=fn=>assert.throws(fn,e=>/^(PI_MILESTONE_|ENOENT)/.test(e.code||''));
function persist(f,state) { const {integrity,...body}=state;fs.writeFileSync(f.file,JSON.stringify({...body,integrity:canonicalHash(body)})+'\n'); }
function noResidue(f) {assert.deepEqual(fs.readdirSync(f.milestones).sort(),['milestones.json']);}
function cli(f,args) {
  return spawnSync(process.execPath,[join(f.runtime,'scripts/card-lab-interrupted-request-recovery.mjs'),...(args??[
    '--ledger-root',f.requestRoot,'--workspace',f.proof.workspace,'--authorization-file',f.proof.authorizationFile,
    '--snapshot-file',f.proof.snapshotFile,'--operator-evidence-file',f.proof.operatorEvidenceFile])],{encoding:'utf8',timeout:15000,windowsHide:true});
}

test('recovery: CLI, restart, one successor and artifact/apply/host/accepted preserve the original unknown execution',async()=>{
  const f=await recoveryFixture();try {
    const before=JSON.stringify(f.state.attempts),started=fs.readFileSync(join(f.requestRoot,sha(c.originalRequestId),'started.json'));
    const result=cli(f);assert.equal(result.status,0,result.stderr);assert.equal(result.signal,null);assert.equal(result.error,undefined);
    const closed=fs.readFileSync(f.file);assert.equal(cli(f).status,0);assert.deepEqual(fs.readFileSync(f.file),closed);
    let l=f.open();assert.equal(l.reserve(f.input).ordinal,4);l=f.open('restart');assert.equal(l.reserve(f.input).status,'reserved');
    l.markStarted(c.successorRequestId);l.registerArtifact(c.successorRequestId,{artifactSha256:artifact,applied:false});
    l.beginApply(c.successorRequestId,artifact);l.cancelApply(c.successorRequestId,artifact);l.beginApply(c.successorRequestId,artifact);
    l.completeApply(c.successorRequestId,artifact);l.verify(c.successorRequestId,{artifactSha256:artifact,passed:true});
    assert.equal(l.accepted(c.successorRequestId,artifact).status,'accepted');assert.equal(l.reserve(f.input).status,'accepted');
    reject(()=>l.reserve({...f.input,requestId:'unapproved-successor'}));assert.equal(l.get(c.originalRequestId).status,'started');
    const after=JSON.parse(fs.readFileSync(f.file));assert.equal(JSON.stringify(after.attempts.slice(0,3)),before);
    assert.equal(after.operatorInterruptedClosures[0].executionUnknown,true);assert.equal(after.milestones[0].resetOrdinal,4);
    assert.deepEqual(fs.readFileSync(join(f.requestRoot,sha(c.originalRequestId),'started.json')),started);noResidue(f);
  } finally {f.cleanup();}
});

test('recovery: original unmodified module rejects synthetic proof without writes',async()=>{
  const f=await recoveryFixture();try {
    const before=fs.readFileSync(f.file);const actual=createMilestoneLedger(f.milestones,{instanceId:'new-runtime'});
    reject(()=>actual.authorizeInterruptedRecovery(f.proof));assert.deepEqual(fs.readFileSync(f.file),before);noResidue(f);
  }finally{f.cleanup();}
});

test('recovery: named CLI arguments reject missing, duplicate, relative, positional and unknown with exit2',()=>{
  const actual=join(packageRoot,'scripts/card-lab-interrupted-request-recovery.mjs');
  for(const args of [[],['--bad','x'],['--ledger-root','relative'],['positional'],['--ledger-root',packageRoot,'--ledger-root',packageRoot],['--ledger-root']]){
    const r=spawnSync(process.execPath,[actual,...args],{encoding:'utf8',timeout:15000,windowsHide:true});assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/invalid arguments/);
  }
});

test('recovery: every proof and authority mismatch fails atomically and releases locks',async t=>{
  const changes=[
    ['workspace',f=>{f.proof.workspace=f.root;}],
    ['authorization',f=>fs.writeFileSync(f.proof.authorizationFile,'synthetic altered')],
    ['snapshot',f=>fs.writeFileSync(f.proof.snapshotFile,'{}')],
    ['started',f=>fs.writeFileSync(join(f.requestRoot,sha(c.originalRequestId),'started.json'),'{}')],
    ['late-final',f=>fs.writeFileSync(join(f.requestRoot,sha(c.originalRequestId),'final.json'),'{}')],
    ['policy-proof',f=>fs.writeFileSync(join(f.workspace,'payload/pi-dispatch/scripts/tier-review-policy.mjs'),'changed')],
    ['test-proof',f=>fs.writeFileSync(join(f.workspace,'payload/pi-dispatch/tests/review-quota-adjudication.test.mjs'),'changed')],
    ['operator-utf8',f=>fs.writeFileSync(f.proof.operatorEvidenceFile,Buffer.from([255,254]))],
    ['operator-size',f=>fs.writeFileSync(f.proof.operatorEvidenceFile,' '.repeat(4097))],
    ...['requestId','authorizationSha256','executionUnknown','oldProcessInactive','assertion'].map(key=>['operator-'+key,f=>{
      const v=JSON.parse(fs.readFileSync(f.proof.operatorEvidenceFile));v[key]=key==='assertion'?'completed successfully':false;fs.writeFileSync(f.proof.operatorEvidenceFile,JSON.stringify(v));
    }]),
    ['operator-extra',f=>{const v=JSON.parse(fs.readFileSync(f.proof.operatorEvidenceFile));v.extra=true;fs.writeFileSync(f.proof.operatorEvidenceFile,JSON.stringify(v));}],
    ['original-status',f=>{const v=JSON.parse(fs.readFileSync(f.file));v.attempts[2].status='in_doubt';persist(f,v);}],
    ['original-artifact',f=>{const v=JSON.parse(fs.readFileSync(f.file));v.attempts[2].artifactSha256=artifact;persist(f,v);}],
    ['prefix',f=>{const v=JSON.parse(fs.readFileSync(f.file));v.attempts[0].evidence.push({checkName:'forged'});persist(f,v);}],
  ];
  for(const [name,change]of changes)await t.test(name,async()=>{
    const f=await recoveryFixture();try{change(f);const before=fs.readFileSync(f.file);assert.equal(cli(f).status,1);assert.deepEqual(fs.readFileSync(f.file),before);noResidue(f);}finally{f.cleanup();}
  });
});

test('recovery: closure integrity, root binding, original mutator freeze and same-ID replay',async t=>{
  await t.test('all original transitions stay frozen',async()=>{const f=await recoveryFixture();try {
    const l=f.open();l.authorizeInterruptedRecovery(f.proof);const original=c.originalRequestId;
    const operations=[()=>l.markUncertain(original),()=>l.fail(original,{checkName:'late',output:'late failure',modelStarted:true}),
      ()=>l.verify(original,{artifactSha256:artifact,passed:false}),()=>l.verify(original,{artifactSha256:artifact,passed:true}),
      ()=>l.registerArtifact(original,{artifactSha256:artifact,applied:false}),()=>l.registerArtifact(original,{artifactSha256:artifact,applied:true}),
      ()=>l.reconcileFailure(original,{definitionSha256:f.values.definitionSha256,resultSha256:artifact,modelStarted:true,output:'late'}),
      ()=>l.beginApply(original,artifact),()=>l.cancelApply(original,artifact),()=>l.completeApply(original,artifact),()=>l.markApplied(original,artifact),
      ()=>l.abandon(original,{artifactSha256:artifact,reason:'late'}),()=>l.accepted(original,artifact)];
    for(const op of operations){const before=fs.readFileSync(f.file);reject(op);assert.deepEqual(fs.readFileSync(f.file),before);noResidue(f);}
    assert.equal(l.markStarted(original).status,'started');l.reserve(f.input);fs.rmSync(f.proof.operatorEvidenceFile);
    assert.equal(l.reserve(f.input).status,'reserved');reject(()=>l.reserve({...f.input,requestId:'another'}));
  }finally{f.cleanup();}});
  await t.test('old instance cannot authorize or consume closure',async()=>{const f=await recoveryFixture();try{
    reject(()=>f.open(c.originalInstanceId).authorizeInterruptedRecovery(f.proof));f.open().authorizeInterruptedRecovery(f.proof);
    const before=fs.readFileSync(f.file);reject(()=>f.open(c.originalInstanceId).reserve(f.input));assert.deepEqual(fs.readFileSync(f.file),before);noResidue(f);
  }finally{f.cleanup();}});
  await t.test('closure schema and root tampering',async()=>{const f=await recoveryFixture();try{
    const l=f.open();l.authorizeInterruptedRecovery(f.proof);const original=JSON.parse(fs.readFileSync(f.file));
    for(const key of Object.keys(original.operatorInterruptedClosures[0])){
      const v=structuredClone(original);delete v.operatorInterruptedClosures[0][key];persist(f,v);const before=fs.readFileSync(f.file);
      reject(()=>l.reserve(f.input));assert.deepEqual(fs.readFileSync(f.file),before);noResidue(f);
    }
    const moved=structuredClone(original);moved.operatorInterruptedClosures[0].requestRoot=f.root;persist(f,moved);reject(()=>l.get(c.originalRequestId));
    fs.writeFileSync(f.file,'{broken');assert.equal(cli(f).status,1);noResidue(f);
  }finally{f.cleanup();}});
  await t.test('failed successor cannot obtain another retry',async()=>{const f=await recoveryFixture();try{
    const l=f.open();l.authorizeInterruptedRecovery(f.proof);l.reserve(f.input);l.markStarted(c.successorRequestId);
    l.fail(c.successorRequestId,{checkName:'fixture',output:'Synthetic failure',modelStarted:true});
    const before=fs.readFileSync(f.file);reject(()=>l.reserve({...f.input,requestId:'another'}));assert.deepEqual(fs.readFileSync(f.file),before);
    assert.equal(l.reserve(f.input).status,'failed');noResidue(f);
  }finally{f.cleanup();}});
  await t.test('changed proof after closure rejects fresh reservation',async()=>{const f=await recoveryFixture();try{
    const l=f.open();l.authorizeInterruptedRecovery(f.proof);fs.writeFileSync(f.proof.operatorEvidenceFile,'{}');
    const before=fs.readFileSync(f.file);reject(()=>l.reserve(f.input));assert.deepEqual(fs.readFileSync(f.file),before);noResidue(f);
  }finally{f.cleanup();}});
  checkSources();
});
