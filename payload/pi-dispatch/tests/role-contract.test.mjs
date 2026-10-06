import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {roleResultSchema,validateRoleResult,validateRoleSubmission,requireRoleFields,resultDigest} from '../extensions/role-contract.js';
import {prepareHandoff,completedContract,validateHandoff,collectHandoffResults,workspaceDigest} from '../extensions/stage-handoff.js';
import {createRequestLedger,requestDigest} from '../extensions/request-ledger.js';
import {validateKetherTask} from '../extensions/kether-envelope.js';
import {roleValue,handoff,ref} from './contract-fixtures.mjs';

test('legacy contract-2 request and result digests remain stable without typed metadata',()=>{
  const raw={contractVersion:2,role:'Chesed',objective:'Legacy digest fixture',acceptance:['host check'],readScope:['fixture.js'],writeScope:['fixture.js']};
  const task=validateKetherTask(raw);
  const input={requestId:'golden-1',parentRunId:'golden-parent',cwd:'C:/fixture',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',thinking:'medium',task};
  const value={status:'completed',result:'Legacy digest fixture',evidence:['Observed fixture'],changedFiles:[],assumptions:[],uncertainty:[],errors:[],nextAction:'Return to primary',deliverable:{summary:'Processed fixture',changes:[],checks:[{name:'fixture check',outcome:'passed',evidence:'Observed fixture'}]}};
  assert.equal(requestDigest('dispatch_subagent',input),'d286592e256bec9f7449ba7c98bb95524037b483066d405288e3cc2d08cacc4d');
  assert.equal(resultDigest(value),'1541bf73a82f8f2f3ee6e27cb401b676db6c13416228211dd61532e1c08584fa');
});

test('all eight roles have distinct strict deliverables; field stripping and wrong types fail',()=>{
  for (const role of ['Yesod','Binah','Hod','Malkuth','Chochmah','Chesed','Netzach','Geburah']) {
    const good=roleValue(role);
    assert.equal(validateRoleResult(good,role).ok,true,role);
    for (const bad of [{...good,evidence:'pretend array'},{...good,assumptions:{}},{...good,deliverable:{}},{...good,extra:true}]) assert.equal(validateRoleResult(bad,role).ok,false,role);
    assert.throws(()=>requireRoleFields({role,returnFields:['result']}),/exact role fields/);
    requireRoleFields({role,returnFields:roleResultSchema(role).required});
  }
});

test('Geburah finding blocking marker is optional but strictly boolean and closed-shape',()=>{
  const base=roleValue('Geburah');
  base.deliverable.findings=[{severity:'low',description:'Fixture finding',evidence:'Observed'}];
  const finding=base.deliverable.findings[0];
  assert.equal(validateRoleResult(base,'Geburah').ok,true);
  finding.blocking=false;assert.equal(validateRoleResult(base,'Geburah').ok,true);
  finding.blocking='false';assert.equal(validateRoleResult(base,'Geburah').ok,false);
  finding.blocking=false;finding.extra=true;assert.equal(validateRoleResult(base,'Geburah').ok,false);
});

test('completed cannot hide errors, missing evidence, unresolved clarification or unrun verification',()=>{
  for (const patch of [{evidence:[]},{errors:['test failed']},{result:''}]) assert.equal(validateRoleResult({...roleValue('Chesed'),...patch},'Chesed').ok,false);
  const b=roleValue('Binah');b.deliverable.clarificationNeeded=true;assert.equal(validateRoleResult(b,'Binah').ok,false);
  const n=roleValue('Netzach');n.deliverable.checks[0].outcome='unverified';assert.equal(validateRoleResult(n,'Netzach').ok,false);
  n.status='unverified';n.deliverable.verdict='unverified';assert.equal(validateRoleResult(n,'Netzach').ok,true);
});

test('Chesed typed execution limitation is closed-shape and only valid for completed unverified checks without errors',()=>{
  const make=()=>{const value=roleValue('Chesed');value.deliverable.checks=[{name:'host tests',outcome:'unverified',evidence:'Worker cannot run host checks.',executionLimitation:{executor:'host',reason:'worker-execution-unavailable'}}];return value;};
  assert.equal(validateRoleResult(make(),'Chesed').ok,true);
  for(const limitation of [null,{}, {executor:'host'}, {executor:'worker',reason:'worker-execution-unavailable'}, {executor:'host',reason:'other'}, {executor:'host',reason:'worker-execution-unavailable',extra:true}, 'worker-execution-unavailable']){
    const value=make();value.deliverable.checks[0].executionLimitation=limitation;
    assert.equal(validateRoleResult(value,'Chesed').ok,false);
  }
  for(const mutate of [
    value=>{value.status='failed';},
    value=>{value.status='unverified';},
    value=>{value.errors=['failure'];},
    value=>{value.deliverable.checks[0].outcome='passed';},
    value=>{value.deliverable.checks[0].outcome='failed';},
  ]){const value=make();mutate(value);assert.equal(validateRoleResult(value,'Chesed').ok,false);}
  const netzach=roleValue('Netzach');netzach.deliverable.checks[0].executionLimitation=make().deliverable.checks[0].executionLimitation;
  assert.equal(validateRoleResult(netzach,'Netzach').ok,false);
  assert.equal(validateRoleResult(roleValue('Chesed'),'Chesed').ok,true);
});

test('Netzach hostEvidence requires bounded typed references and trusted synchronous resolution',()=>{
  const make=()=>{const n=roleValue('Netzach');const c=n.deliverable.checks[0];c.evidence='';c.hostEvidence={requestId:'run:1',artifactSha256:'a'.repeat(64),recordSha256:'b'.repeat(64),checkName:'focused tests'};return n;};
  const resolve=()=>({ok:true});
  assert.equal(validateRoleResult(make(),'Netzach',{hostEvidenceResolver:resolve}).ok,true);
  for (const options of [{},{hostEvidenceResolver:()=>({ok:false,code:'HOST_EVIDENCE_LINKED_REQUIRED'})},{hostEvidenceResolver:()=>({ok:true,forged:true})},{hostEvidenceResolver:()=>{throw Error('no')}},{hostEvidenceResolver:()=>Promise.resolve({ok:true})}]) assert.equal(validateRoleResult(make(),'Netzach',options).ok,false);
  const malformed=[{...make().deliverable.checks[0].hostEvidence,extra:true},{...make().deliverable.checks[0].hostEvidence,requestId:'!'},{...make().deliverable.checks[0].hostEvidence,recordSha256:'A'.repeat(64)},{...make().deliverable.checks[0].hostEvidence,checkName:'x'.repeat(129)}];
  for(const ref of malformed){const n=make();n.deliverable.checks[0].hostEvidence=ref;assert.equal(validateRoleResult(n,'Netzach',{hostEvidenceResolver:resolve}).ok,false);}
  const other=roleValue('Chesed');other.deliverable.checks=[{...roleValue('Netzach').deliverable.checks[0],hostEvidence:make().deliverable.checks[0].hostEvidence}];
  assert.equal(validateRoleResult(other,'Chesed').ok,false);
});

test('submission defers only typed host-reference resolution, preserving semantic checks and strict acceptance',()=>{
  const make=()=>{
    const value=roleValue('Netzach');
    value.deliverable.checks[0].evidence='';
    value.deliverable.checks[0].hostEvidence={requestId:'fixture-host',artifactSha256:'a'.repeat(64),recordSha256:'b'.repeat(64),checkName:'fixture check'};
    return value;
  };
  const value=make(), unchanged=structuredClone(value);
  assert.deepEqual(validateRoleSubmission(value,'Netzach'),{ok:true,version:2,role:'Netzach',hostEvidencePending:1});
  assert.deepEqual(value,unchanged);
  assert.equal(validateRoleResult(value,'Netzach').ok,false);
  assert.equal(validateRoleResult(value,'Netzach',{hostEvidenceResolver:()=>({ok:false,code:'HOST_EVIDENCE_UNRESOLVED'})}).ok,false);
  assert.equal(validateRoleResult(value,'Netzach',{hostEvidenceResolver:()=>({ok:true})}).ok,true);
  for(const mutate of [
    v=>{v.errors=['failed'];}, v=>{v.evidence=[];}, v=>{v.result='';},
    v=>{v.deliverable.verdict='unverified';}, v=>{v.deliverable.checks[0].outcome='unverified';},
    v=>{delete v.deliverable.checks[0].hostEvidence;},
    v=>{v.deliverable.checks[0].hostEvidence.recordSha256='bad';},
    v=>{v.deliverable.checks[0].hostEvidence.extra=true;},
    v=>{v.deliverable.checks[0].hostEvidence.requestId='!';},
  ]) {const invalid=make();mutate(invalid);assert.equal(validateRoleSubmission(invalid,'Netzach').ok,false);}
  const other=roleValue('Chesed');other.deliverable.checks[0].hostEvidence=make().deliverable.checks[0].hostEvidence;
  assert.equal(validateRoleSubmission(other,'Chesed').ok,false);
  for(const role of ['Yesod','Binah','Hod','Malkuth','Chochmah','Chesed','Netzach','Geburah']) {
    assert.equal(validateRoleSubmission(roleValue(role),role).ok,true,role);
    assert.equal(validateRoleSubmission({...roleValue(role),errors:['failed']},role).ok,false,role);
  }
});

test('handoffs reject skipped stages, wrong roles, duplicate inputs and undeclared dependencies',()=>{
  assert.throws(()=>validateHandoff(handoff('implementing'),{role:'Chesed'}),/requires predecessor/);
  assert.throws(()=>validateHandoff(handoff('planned',[ref('x','Yesod','scouted')]),{role:'Chochmah'}),/Invalid/);
  assert.throws(()=>validateHandoff(handoff('planned',[ref('x','Malkuth','scouted'),ref('x','Malkuth','scouted')]),{role:'Chochmah'}),/duplicate/);
  assert.throws(()=>prepareHandoff({role:'Chesed'},{dependsOnRequestIds:['x']},'root',{}),/explicit typed handoff/);
});

test('awaiting host verification is a soft dependency wait and only its completed durable projection satisfies handoff',()=>{
  const cwd='workspace-host-check';
  const priorValue=roleValue('Chesed','patch ready');
  const runGoal='Verify implementation',runAcceptance=['checks pass'];
  const runAnchorSha256=createHash('sha256').update(JSON.stringify({runGoal,runAcceptance})).digest('hex');
  const contract={version:2,role:'Chesed',stage:'implementing',mode:'linked',parentRunId:'host-run',workspaceSha256:workspaceDigest(cwd),resultSha256:resultDigest(priorValue),handoffVersion:2,runAnchorSha256,phaseIndex:1};
  const task={role:'Netzach',handoff:{version:2,stage:'verifying',runGoal,runAcceptance,phaseIndex:1,inputs:[ref('host-write','Chesed','implementing',contract.resultSha256)]}};
  const input={requestId:'host-verify',parentRunId:'host-run',dependsOnRequestIds:['host-write']};
  let state={state:'awaiting-host-verification'};
  const ledger={enabled:true,getOutcome:()=>state};
  const ready=prepareHandoff(task,input,cwd,ledger);
  assert.equal(ready(),false);
  state={state:'completed',contract,handoffResult:priorValue};
  assert.equal(ready(),true);
  state={state:'failed'};
  assert.throws(()=>ready(),/Predecessor contract/);
});

test('v2 handoffs bind goal and acceptance, version, run and phase; only approved post-review advances a phase',()=>{
  const cwd='workspace-v2';
  const reviewTask={role:'Geburah',reviewPacket:{stage:'post-change'},handoff:{version:2,stage:'post-review',runGoal:'Ship feature',runAcceptance:['works'],phaseIndex:1,inputs:[ref('verify','Netzach','verifying')]}};
  const verifying={version:2,mode:'linked',parentRunId:'run-v2',workspaceSha256:'',resultSha256:'',role:'Netzach',stage:'verifying',handoffVersion:2,runAnchorSha256:'',phaseIndex:1};
  const reviewContract=completedContract(reviewTask,{parentRunId:'run-v2'},cwd,roleValue('Geburah'));
  const scouted={role:'Malkuth',handoff:{version:2,stage:'scouted',runGoal:'Ship feature',runAcceptance:['works'],phaseIndex:2,inputs:[ref('review','Geburah','post-review',reviewContract.resultSha256)]}};
  const input={requestId:'scout-2',parentRunId:'run-v2',dependsOnRequestIds:['review']};
  const ledgerFor=contract=>({enabled:true,getOutcome:id=>({state:'completed',contract:id==='review'?contract:verifying})});
  assert.equal(prepareHandoff(scouted,input,cwd,ledgerFor(reviewContract))(),true);
  const mismatch={...scouted,handoff:{...scouted.handoff,runGoal:'Other goal'}};
  assert.throws(()=>prepareHandoff(mismatch,input,cwd,ledgerFor(reviewContract))(),/Predecessor contract/);
  const v1={...scouted,handoff:{...scouted.handoff,version:1}};
  assert.throws(()=>validateHandoff(v1.handoff,v1),/Invalid/);
  for (const bad of [
    {...reviewContract,parentRunId:'other-run'},
    {...reviewContract,phaseIndex:2},
    {...reviewContract,runAnchorSha256:'f'.repeat(64)},
    {...reviewContract,reviewDecision:'request-changes'},
  ]) assert.throws(()=>prepareHandoff(scouted,input,cwd,ledgerFor(bad))(),/Predecessor contract/);
  const skipped={...scouted,handoff:{...scouted.handoff,inputs:[ref('planned','Chochmah','planned')]}};
  assert.throws(()=>validateHandoff(skipped,skipped),/Invalid/);
  const bypass={...scouted,handoff:{...scouted.handoff,phaseIndex:3,inputs:[ref('review','Geburah','post-review',reviewContract.resultSha256)]}};
  assert.throws(()=>prepareHandoff(bypass,input,cwd,ledgerFor(reviewContract))(),/Predecessor contract/);
});

test('persisted upstream contracts bind role, stage, run, workspace, digest and actual sanitized content',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pi-handoff-'));
  try {
    const ledger=createRequestLedger(dir),cwd='workspace-a';
    const origin={role:'Malkuth',handoff:handoff('scouted')};
    const value=roleValue('Malkuth');value.deliverable.observations.push('Bearer hidden-token');
    const contract=completedContract(origin,{parentRunId:'run-a'},cwd,value);
    ledger.recordOutcome('scout-a',{ok:true,contract,structuredResult:value});
    const restarted=createRequestLedger(dir);
    const task={role:'Chochmah',handoff:handoff('planned',[ref('scout-a','Malkuth','scouted',contract.resultSha256)])};
    const input={requestId:'plan-a',parentRunId:'run-a',dependsOnRequestIds:['scout-a']};
    assert.equal(prepareHandoff(task,input,cwd,restarted)(),true);
    const upstream=collectHandoffResults(task,restarted);
    assert.doesNotMatch(JSON.stringify(upstream),/hidden-token/);
    assert.equal(resultDigest(upstream[0].result),contract.resultSha256);
    assert.throws(()=>prepareHandoff(task,{...input,parentRunId:'other-run'},cwd,restarted)(),/does not match/);
    assert.throws(()=>prepareHandoff(task,input,'other-workspace',restarted)(),/does not match/);
    for (const change of [{resultSha256:'f'.repeat(64)},{stage:'classified',role:'Hod'}]) {
      const altered={...task,handoff:handoff('planned',[{...task.handoff.inputs[0],...change}])};
      assert.throws(()=>prepareHandoff(altered,input,cwd,restarted)());
    }
    const corrupted={getOutcome:()=>({...restarted.getOutcome('scout-a'),handoffResult:roleValue('Malkuth','tampered')})};
    assert.throws(()=>collectHandoffResults(task,corrupted),/unavailable or changed/);
    restarted.recordOutcome('old',{ok:true});
    const old={...task,handoff:handoff('planned',[ref('old','Malkuth','scouted')])};
    assert.throws(()=>prepareHandoff(old,{...input,dependsOnRequestIds:['old']},cwd,restarted)(),/does not match/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
