import {hostRecordDigest} from '../extensions/host-verification.js';

const fail=message=>{throw Object.assign(new Error(message),{code:'PI_MILESTONE_RECONCILIATION_NEEDED'});};

// No process launch, ledger edit, caller-asserted execution or guessed zero-start.
// Only an immutable completed dispatch record can establish a terminal failure.
export function inspectMilestoneRecovery({ledger,milestones,requestId,requestDigest}){
  const attempt=milestones?.get(requestId);if(!attempt)fail('Original milestone identity is unavailable');
  const execution=ledger?.getExecutionRecordByDigest(requestId,requestDigest);
  if(execution?.state!=='completed')return {requestId,recoverable:false,reason:`dispatch-${execution?.state??'unavailable'}`,definitionSha256:attempt.definitionSha256};
  const response=execution.result?.response??execution.result;
  const modelStarted=response?.modelExecutionStarted;
  const terminalFailure=response?.ok===false&&response?.status!=='awaiting-host-verification'&&!response?.hostVerification;
  const executionKnown=modelStarted===false||modelStarted===true&&response.cleanup?.ok===true&&Number.isInteger(response.exitCode);
  const recoverable=['reserved','started','in_doubt'].includes(attempt.status)&&terminalFailure&&executionKnown;
  return {requestId,recoverable,reason:recoverable?'durable-known-terminal-failure':'execution-or-artifact-reconciliation-still-required',definitionSha256:attempt.definitionSha256,resultSha256:hostRecordDigest(execution.result),modelStarted:typeof modelStarted==='boolean'?modelStarted:null};
}

export function finalizeMilestoneRecovery({ledger,milestones,requestId,requestDigest,definitionSha256,resultSha256}){
  const proof=inspectMilestoneRecovery({ledger,milestones,requestId,requestDigest});
  if(proof.definitionSha256!==definitionSha256||proof.resultSha256!==resultSha256)fail('Reconciliation fingerprint changed');
  const previous=milestones.get(requestId);
  if(previous.reconciliationSha256===resultSha256&&previous.status==='failed')return previous;
  if(!proof.recoverable)fail('Unknown execution and interrupted apply cannot be released automatically');
  const record=ledger.getExecutionRecordByDigest(requestId,requestDigest),response=record.result?.response??record.result;
  milestones.reconcileFailure(requestId,{definitionSha256,resultSha256,modelStarted:proof.modelStarted,output:response.failureCode??response.code??response.failure??response.error??'Recorded terminal failure'});
  return milestones.get(requestId);
}
