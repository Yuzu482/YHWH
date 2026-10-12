// Host-only orchestration bundles. No dispatch, apply, process execution, evidence
// recording or acceptance mutation. A primary decision separates every write.
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {sha256,unwrap,collectHostCandidate,fetchCompleteResult,assertHostCapture,prepareHostReview} from './host-handoff.mjs';
import {validateKetherInvocation} from './dispatch.mjs';
import {inspectPrimaryPacket,runtimePreflight} from './runtime-preflight.mjs';

const hash = v => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const id = v => typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const require = (value,message) => {if(!value)throw new Error(message);};

// UTC is for cross-process correlation; monotonic time measures only this call.
function clock() {
  const start=performance.now(), events=[];
  return {events,mark(name){events.push({name,at:new Date().toISOString(),offsetMs:performance.now()-start});}};
}
export function phaseIntervals(events, pairs) {
  require(Array.isArray(events)&&events.length<=64&&Array.isArray(pairs)&&pairs.length<=64,'Invalid timing trace');
  const values=new Map();let previous=-Infinity;
  for(const e of events){
    require(e&&typeof e.name==='string'&&e.name.length<=128&&!values.has(e.name)&&typeof e.at==='string'&&
      Number.isFinite(Date.parse(e.at))&&new Date(e.at).toISOString()===e.at&&Number.isFinite(e.offsetMs)&&e.offsetMs>=0&&e.offsetMs>=previous,'Invalid timing event');
    values.set(e.name,e.offsetMs);previous=e.offsetMs;
  }
  return pairs.map(([from,to])=>{const a=values.get(from),b=values.get(to);require(a===undefined||b===undefined||b>=a,'Reversed timing interval');return {from,to,elapsedMs:a===undefined||b===undefined?null:b-a};});
}

export async function waitForHostCandidate(callTool,{requestId,timeoutMs=55000}) {
  require(id(requestId)&&Number.isInteger(timeoutMs)&&timeoutMs>=0&&timeoutMs<=55000,'Invalid completion wait');
  const trace=clock();trace.mark('waitStarted');
  const waited=unwrap(await callTool('wait_subagent',{requestId,timeoutMs}));trace.mark('waitReturned');
  require(waited.requestId===requestId&&typeof waited.ready==='boolean','Completion identity mismatch');
  // Timeout returns immediately to the caller. No poll, replay or cancellation.
  if(!waited.ready)return {ready:false,requestId,state:waited.state??null,trace:trace.events,requiresPrimaryInspection:true};
  const candidate=await collectHostCandidate(callTool,{requestId});trace.mark('candidateReady');
  return {ready:true,candidate,trace:trace.events,requiresPrimaryInspection:true};
}

function assertRecord(request,candidate,hostCapture,hostRecord) {
  assertHostCapture(candidate,hostCapture);
  require(request?.requestId===candidate.requestId&&id(request.parentRunId)&&request.tier===candidate.handoff.tier&&
    request.parentRunId===candidate.handoff.parentRunId&&typeof request.cwd==='string'&&
    sha256(resolve(request.cwd))===candidate.handoff.workspaceSha256&&hash(candidate.handoff.anchorSha256),'Task/candidate binding mismatch');
  require(hostRecord?.ok===true&&hostRecord.requestId===candidate.requestId&&hostRecord.artifactSha256===candidate.artifactSha256&&
    hostRecord.state==='completed'&&hostRecord.outcome==='completed'&&hash(hostRecord.recordSha256)&&
    Array.isArray(hostRecord.checks)&&hostRecord.checks.length===hostCapture.outcomes.length&&
    new Set(hostRecord.checks.map(c=>c.checkName)).size===hostRecord.checks.length&&
    hostRecord.checks.every(c=>c.exitCode===0&&candidate.handoff.requiredCheckNames.includes(c.checkName)),'Completed current-artifact host record required');
}

// Equivalent to gateway-client task-plan. Advisory preflight is returned in full;
// this is not gateway admission, a quota reservation, or proof of auth readiness.
export function planReviewRequest(value) {
  const packetCheck=inspectPrimaryPacket(value?.task);
  require(packetCheck.ok,'Review packet planning failed: '+packetCheck.criticalCodes.join(','));
  const {request,task}=validateKetherInvocation({cwd:value.cwd,access:value.access,provider:value.provider,model:value.model,
    thinking:value.thinking,timeoutSeconds:value.timeoutSeconds,resourceProfile:value.resourceProfile,task:value.task},false,value.cwd);
  return {ok:true,modelCalls:0,readOnly:true,packetCheck,thinkingDecision:request.thinkingDecision,
    preflight:runtimePreflight(task),request:{...value,thinking:request.thinking,task}};
}

export function prepareReviewBundle(input, options) {
  const trace=clock();trace.mark('prepareStarted');
  require(input?.request?.tier==='T1','Review bundles currently support T1 only; preserve the existing T2 linked pre/post-review flow');
  require(options&&Object.keys(options).every(k=>['requestId','thinking','reason'].includes(k))&&id(options.requestId)&&
    options.requestId!==input?.request?.requestId&&['medium','high','xhigh'].includes(options.thinking??'medium')&&
    typeof options.reason==='string'&&options.reason.trim()&&options.reason.length<=400,'Explicit review identity and effort reason required');
  assertRecord(input.request,input.candidate,input.hostCapture,input.hostRecord);
  const prepared=prepareHostReview(input);trace.mark('materialReady');
  const value={requestId:options.requestId,parentRunId:input.request.parentRunId,reviewOfRequestId:input.request.requestId,
    cwd:input.request.cwd,tier:input.request.tier,tierDeclaration:input.request.tierDeclaration,
    provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',resourceProfile:'standard',timeoutSeconds:300,queueTimeoutSeconds:120,
    thinking:options.thinking??'medium',task:{...prepared.taskTemplate,
      context:[...prepared.taskTemplate.context,`Review effort ${options.thinking??'medium'}: ${options.reason}`],reviewPacket:prepared.packet}};
  const plan=planReviewRequest(value);trace.mark('planReady');
  return {...prepared,plan,reviewRequest:plan.request,reviewRequestSha256:sha256(JSON.stringify(plan.request)),
    trace:trace.events,readOnly:true,modelCalls:0,requiresPrimaryInspection:true};
}

// Reconcile a terminal review with the durable gateway projection. This reads
// evidence only; it never manufactures task_accepted or performs primary acceptance.
export async function collectAcceptanceInspection(callTool,input) {
  const {request,candidate,hostCapture,hostRecord,reviewRequest,expectedReviewRequestSha256}=input;
  const trace=clock();trace.mark('inspectionStarted');
  require(request?.tier==='T1','Acceptance inspection bundle currently supports T1 only');
  assertRecord(request,candidate,hostCapture,hostRecord);
  require(hash(expectedReviewRequestSha256)&&sha256(JSON.stringify(reviewRequest))===expectedReviewRequestSha256,'Reviewed request fingerprint mismatch');
  require(id(reviewRequest?.requestId)&&reviewRequest.requestId!==request.requestId&&reviewRequest.reviewOfRequestId===request.requestId&&
    reviewRequest.parentRunId===request.parentRunId&&reviewRequest.cwd===request.cwd&&reviewRequest.tier===request.tier&&
    reviewRequest.provider==='claude-code-cli'&&reviewRequest.model==='claude-sonnet-5'&&reviewRequest.access==='none'&&
    reviewRequest.task?.role==='Geburah'&&reviewRequest.task.objective===request.task.objective&&
    JSON.stringify(reviewRequest.task.acceptance)===JSON.stringify(request.task.acceptance)&&reviewRequest.task.reviewPacket?.stage==='post-change'&&
    reviewRequest.task.reviewPacket.changes?.content?.join('')===candidate.result.patch,'Review target mismatch');
  const complete=await fetchCompleteResult(callTool,reviewRequest.requestId);trace.mark('reviewRead');
  const review=complete.result, contract=review.contract, structured=review.structuredResult;
  require(review.ok===true&&review.requestId===reviewRequest.requestId&&review.provider===reviewRequest.provider&&review.model===reviewRequest.model&&
    review.workerRuntime==='claude-code-cli'&&review.modelExecutionStarted===true&&Array.isArray(review.toolsUsed)&&review.toolsUsed.length===0&&
    review.formatValidation?.ok===true&&review.roleValidation?.ok===true&&
    review.roleValidation.role==='Geburah'&&review.reviewValidation?.ok===true&&review.reviewValidation.approved===true&&
    structured?.status==='completed'&&structured.reviewDecision==='approve'&&Array.isArray(structured.missingMaterials)&&structured.missingMaterials.length===0&&
    Array.isArray(structured.errors)&&structured.errors.length===0&&Array.isArray(structured.deliverable?.findings)&&
    structured.deliverable.findings.every(f=>f.blocking===false)&&
    contract?.role==='Geburah'&&contract.stage==='post-review'&&contract.parentRunId===request.parentRunId&&
    contract.workspaceSha256===candidate.handoff.workspaceSha256&&
    (contract.taskAnchorSha256??contract.runAnchorSha256)===candidate.handoff.anchorSha256,'Independent approved bound review required');
  const handoff=unwrap(await callTool('get_task_handoff',{requestId:candidate.requestId,artifactSha256:candidate.artifactSha256}));trace.mark('handoffRead');
  for(const key of ['requestId','artifactSha256','parentRunId','workspaceSha256','anchorSha256','tier'])require(handoff[key]===candidate.handoff[key],'Accepted handoff binding mismatch');
  require(JSON.stringify(handoff.requiredCheckNames)===JSON.stringify(candidate.handoff.requiredCheckNames),'Accepted required checks changed');
  require(handoff.state==='accepted'&&handoff.finalAccepted===true&&handoff.acceptanceState==='completed'&&
    handoff.proofSha256===hostRecord.recordSha256&&typeof handoff.acceptedAt==='string'&&Number.isFinite(Date.parse(handoff.acceptedAt))&&
    new Date(handoff.acceptedAt).toISOString()===handoff.acceptedAt,'Durable task acceptance missing or inconsistent');
  return {readyForPrimaryAcceptance:true,requiresPrimaryAcceptance:true,readOnly:true,modelCalls:0,
    requestId:candidate.requestId,artifactSha256:candidate.artifactSha256,hostRecordSha256:hostRecord.recordSha256,
    reviewRequestId:reviewRequest.requestId,reviewResultSha256:complete.resultSha256,reviewDecision:structured.reviewDecision,
    nonblockingFindings:structured.deliverable.findings,handoff,hostCommands:hostCapture.evidence.commands,
    trace:trace.events,intervals:phaseIntervals(trace.events,[['inspectionStarted','reviewRead'],['reviewRead','handoffRead']])};
}
