import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {roleResultSchema,validateRoleResult,requireRoleFields,resultDigest} from '../extensions/role-contract.js';
import {prepareHandoff,completedContract,validateHandoff,collectHandoffResults} from '../extensions/stage-handoff.js';
import {createRequestLedger} from '../extensions/request-ledger.js';
import {roleValue,handoff,ref} from './contract-fixtures.mjs';

test('all eight roles have distinct strict deliverables; field stripping and wrong types fail',()=>{
  for (const role of ['Yesod','Binah','Hod','Malkuth','Chochmah','Chesed','Netzach','Geburah']) {
    const good=roleValue(role);
    assert.equal(validateRoleResult(good,role).ok,true,role);
    for (const bad of [{...good,evidence:'pretend array'},{...good,assumptions:{}},{...good,deliverable:{}},{...good,extra:true}]) assert.equal(validateRoleResult(bad,role).ok,false,role);
    assert.throws(()=>requireRoleFields({role,returnFields:['result']}),/exact role fields/);
    requireRoleFields({role,returnFields:roleResultSchema(role).required});
  }
});

test('completed cannot hide errors, missing evidence, unresolved clarification or unrun verification',()=>{
  for (const patch of [{evidence:[]},{errors:['test failed']},{result:''}]) assert.equal(validateRoleResult({...roleValue('Chesed'),...patch},'Chesed').ok,false);
  const b=roleValue('Binah');b.deliverable.clarificationNeeded=true;assert.equal(validateRoleResult(b,'Binah').ok,false);
  const n=roleValue('Netzach');n.deliverable.checks[0].outcome='unverified';assert.equal(validateRoleResult(n,'Netzach').ok,false);
  n.status='unverified';n.deliverable.verdict='unverified';assert.equal(validateRoleResult(n,'Netzach').ok,true);
});

test('handoffs reject skipped stages, wrong roles, duplicate inputs and undeclared dependencies',()=>{
  assert.throws(()=>validateHandoff(handoff('implementing'),{role:'Chesed'}),/requires predecessor/);
  assert.throws(()=>validateHandoff(handoff('planned',[ref('x','Yesod','scouted')]),{role:'Chochmah'}),/Invalid/);
  assert.throws(()=>validateHandoff(handoff('planned',[ref('x','Malkuth','scouted'),ref('x','Malkuth','scouted')]),{role:'Chochmah'}),/duplicate/);
  assert.throws(()=>prepareHandoff({role:'Chesed'},{dependsOnRequestIds:['x']},'root',{}),/explicit typed handoff/);
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
