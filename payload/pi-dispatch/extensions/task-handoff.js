import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function projectTaskHandoff({ledger,taskMonitor,requestId,artifactSha256}) {
  const artifact=ledger?.getHostArtifact(requestId);
  if(!artifact){const live=taskMonitor?.get?.(requestId);const outcome=ledger?.getOutcome?.(requestId);const state=live&&['queued','running','waiting'].includes(live.state)?'wait-worker':outcome?.state==='failed'?'repair-required':'unknown';const value={ok:true,requestId,state,nextAction:state==='wait-worker'?'wait-for-worker':state==='repair-required'?'repair-or-replace-candidate':'reconcile-artifact-evidence',finalAccepted:false};value.revision=hash(value);return value;}
  const {pending,contractTemplate:template}=artifact;
  if(artifactSha256!==undefined&&artifactSha256!==pending.artifactSha256){const value={ok:true,requestId,state:'unknown',nextAction:'candidate-mismatch',finalAccepted:false};value.revision=hash(value);return value;}
  if(!template||template.role!=='Chesed'||template.stage!=='implementing'||!['T0','T1','T2'].includes(template.tier)||!['standalone','linked'].includes(template.mode)||!template.parentRunId||!template.workspaceSha256||!pending.requestId){const value={ok:true,requestId,state:'unknown',nextAction:'unsupported-artifact',finalAccepted:false};value.revision=hash(value);return value;}
  const effective=ledger.getEffectiveResult(requestId);
  const outcome=ledger.getOutcome(requestId);
  let state,nextAction,proofSha256=null,finalAccepted=false,acceptedAt=null,acceptanceState='not-attempted';
  if(!effective){state='unknown';nextAction='reconcile-durable-evidence';}
  else if(effective.state==='awaiting-host-verification'){state='host-verification-required';nextAction='run-required-host-checks';}
  else if(effective.state==='failed'){state='repair-required';nextAction='repair-or-replace-candidate';proofSha256=effective.hostVerification?.recordSha256??null;}
  else if(effective.state==='completed'){
    const source=effective.verificationSource;
    proofSha256=source==='host'?effective.verificationRecordSha256:source==='netzach'?effective.verifierProofSha256:null;
    if(!proofSha256){state='unknown';nextAction='reconcile-proof-binding';}
    else {
      const anchor=template.mode==='linked'?template.runAnchorSha256:template.taskAnchorSha256;
      if(!anchor||!pending.parentRunId||!pending.workspace){state='unknown';nextAction='reconcile-acceptance-binding';}
      else {
        const acceptanceId=`acceptance-${sha(`${requestId}\n${anchor}\ntask_accepted`)}`;
        const input={parentRunId:pending.parentRunId,workspaceSha256:sha(pending.workspace),anchor,artifactSha256:pending.artifactSha256,recordSha256:proofSha256,tier:template.tier};
        const receipt=ledger.getExecutionRecord(acceptanceId,'task_accepted',input);
        acceptanceState=receipt.state;
        const acceptedTime=receipt.result?.acceptedAt;
        const validAcceptedAt=typeof acceptedTime==='string'&&Number.isFinite(Date.parse(acceptedTime))&&new Date(acceptedTime).toISOString()===acceptedTime;
        if(receipt.state==='completed'&&receipt.result?.ok===true&&validAcceptedAt){
          finalAccepted=true;acceptedAt=acceptedTime;state='accepted';nextAction='candidate-accepted';
        }else if(receipt.state==='in-doubt'){state='acceptance-in-doubt';nextAction='reconcile-acceptance-ledger';}
        else if(receipt.state==='damaged'||receipt.state==='completed'){state='unknown';acceptanceState='damaged';nextAction='repair-acceptance-evidence';}
        else if(template.tier!=='T0'){state='post-review-required';nextAction='submit-bound-artifact-for-post-review';}
        else {state='acceptance-missing';nextAction='reconcile-acceptance';}
      }
    }
  } else {state='unknown';nextAction='reconcile-durable-evidence';}
  const base={ok:true,requestId,parentRunId:pending.parentRunId,workspaceSha256:template.workspaceSha256,anchorSha256:template.runAnchorSha256??template.taskAnchorSha256??null,...(Number.isSafeInteger(template.phaseIndex)?{phaseIndex:template.phaseIndex}:{}),tier:template.tier,artifactSha256:pending.artifactSha256,requiredCheckNames:[...pending.requiredCheckNames],proofSha256,finalAccepted,acceptedAt,state,acceptanceState,nextAction};
  base.revision=hash(Object.fromEntries(Object.entries(base).filter(([key])=>key!=='revision'&&key!=='acceptedAt')));
  const live=taskMonitor?.get?.(requestId);
  if(!effective&&live&&['queued','running','waiting'].includes(live.state)) {base.state='wait-worker';base.nextAction='wait-for-worker';base.revision=hash(Object.fromEntries(Object.entries(base).filter(([key])=>key!=='revision'&&key!=='acceptedAt')));}
  return base;
}

export const TASK_HANDOFF_POLICY=Object.freeze({version:1,readOnly:true,candidateBound:true,automaticOrchestration:false,maxWaiters:128,maxTimeoutMs:55000});
