import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequestLedger,requestDigest} from '../extensions/request-ledger.js';
import {createMilestoneLedger} from '../extensions/milestone-ledger.js';
import {inspectMilestoneRecovery,finalizeMilestoneRecovery} from '../scripts/milestone-recovery.mjs';

async function fixture(response,run){
  const directory=mkdtempSync(join(tmpdir(),'milestone-recovery-'));
  try{
    const ledger=createRequestLedger(join(directory,'requests'));
    const milestones=createMilestoneLedger(join(directory,'milestones'),{instanceId:'old'});
    const input={requestId:'write-1',access:'workspace-write',task:{objective:'Fix one feature'}};
    milestones.reserve({requestId:input.requestId,workspace:directory,parentRunId:'parent',milestone:{id:'feature',objective:'Fix one feature',acceptanceCommandIds:['test']},verify:{commands:[{id:'test',argv:['node','--test'],cwd:'.'}]},writeScope:['src/**']});
    await ledger.execute({requestId:input.requestId,operation:'dispatch_subagent',input},async()=>({response,isError:!response.ok}));
    const context={ledger,milestones:createMilestoneLedger(join(directory,'milestones'),{instanceId:'new'}),requestId:input.requestId,requestDigest:requestDigest('dispatch_subagent',input)};
    await run(context);
  }finally{rmSync(directory,{recursive:true,force:true});}
}

for(const modelExecutionStarted of [false,true])test(`recovery uses original terminal record, modelStarted=${modelExecutionStarted}`,async()=>fixture({ok:false,modelExecutionStarted,cleanup:{ok:true},exitCode:1,failureCode:'CHECK_FAILED'},async context=>{
  const proof=inspectMilestoneRecovery(context);
  assert.equal(proof.recoverable,true);
  assert.equal(proof.modelStarted,modelExecutionStarted);
  assert.throws(()=>finalizeMilestoneRecovery({...context,...proof,resultSha256:'a'.repeat(64)}),e=>e.code==='PI_MILESTONE_RECONCILIATION_NEEDED');
  const result=finalizeMilestoneRecovery({...context,...proof});
  assert.equal(result.status,'failed');
  assert.equal(result.strike,modelExecutionStarted);
  assert.deepEqual(finalizeMilestoneRecovery({...context,...proof}),result);
}));

for(const response of [
  {ok:false},
  {ok:false,modelExecutionStarted:true,cleanup:{ok:false},exitCode:1},
  {ok:false,modelExecutionStarted:true,cleanup:{ok:true}},
  {ok:true,modelExecutionStarted:false},
  {ok:false,modelExecutionStarted:false,status:'awaiting-host-verification'},
  {ok:false,modelExecutionStarted:false,hostVerification:{required:true}},
])test(`uncertain or artifact-bearing outcome remains blocked: ${JSON.stringify(response)}`,async()=>fixture(response,async context=>{
  const proof=inspectMilestoneRecovery(context);
  assert.equal(proof.recoverable,false);
  assert.throws(()=>finalizeMilestoneRecovery({...context,...proof}),e=>e.code==='PI_MILESTONE_RECONCILIATION_NEEDED');
  assert.equal(context.milestones.get(context.requestId).status,'reserved');
}));

test('wrong digest cannot release reservation or expose stored result',async()=>fixture({ok:false,modelExecutionStarted:false},async context=>{
  const changed={...context,requestDigest:'a'.repeat(64)};
  assert.deepEqual(context.ledger.getExecutionRecordByDigest(context.requestId,changed.requestDigest),{state:'damaged'});
  assert.equal(inspectMilestoneRecovery(changed).recoverable,false);
  assert.equal(context.milestones.get(context.requestId).status,'reserved');
}));
