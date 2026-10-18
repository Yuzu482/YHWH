// Read-only projection; never interprets operation completion as task acceptance.
import {createHash} from 'node:crypto';
import {verifyHostPending,verifyHostAttestation} from '../extensions/host-verification.js';
const sha = text => createHash('sha256').update(text).digest('hex');
const digest = x => typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function projectHostEvidence({dispatches,events,hostRecords=[],until,legacyScopeComplete=false}) {
  const end=Date.parse(until);
  if(!Number.isFinite(end)||![dispatches,events,hostRecords].every(Array.isArray)||dispatches.length>256||events.length>100000||hostRecords.length>256)throw Error('Invalid evidence projection input');
  const seen=new Set(),unique=events.filter(e=>{const k=JSON.stringify(e);if(seen.has(k))return false;seen.add(k);return true;});
  const identities=new Map(),conflicts=new Set();
  for(const d of dispatches){const key=JSON.stringify([d.workspaceSha256,d.parentRunId,d.runAnchorSha256,d.requestId]),old=identities.get(key);if(old&&(old.patch?.sha256??old.hostVerification?.artifactSha256)!==(d.patch?.sha256??d.hostVerification?.artifactSha256))conflicts.add(key);else if(!old)identities.set(key,d);}
  const rows=[...identities.entries()].map(([key,d])=>{
    const artifact=d.patch?.sha256??d.hostVerification?.artifactSha256,start=Date.parse(d.startedAt),id=d.requestId;
    const bound=hostRecords.filter(({pending:p})=>p&&verifyHostPending(p)&&p.requestId===id&&p.parentRunId===d.parentRunId&&sha(p.workspace)===d.workspaceSha256&&p.artifactSha256===artifact);
    // Legacy events can omit identity only when the complete supplied request index is unambiguous.
    const foreign=dispatches.some(x=>x.requestId===id&&(x.patch?.sha256??x.hostVerification?.artifactSha256)===artifact&&(x.parentRunId!==d.parentRunId||x.workspaceSha256!==d.workspaceSha256))||hostRecords.some(({pending:p})=>p&&verifyHostPending(p)&&p.requestId===id&&p.artifactSha256===artifact&&(p.parentRunId!==d.parentRunId||sha(p.workspace)!==d.workspaceSha256));
    const ambiguous=bound.length>1||foreign;
    const pending=!ambiguous&&bound.length===1?bound[0].pending:null,a=!ambiguous&&bound.length===1?bound[0].attestation:null;
    const validTime=e=>Number.isFinite(start)&&Date.parse(e.timestamp)>=start&&Date.parse(e.timestamp)<=end;
    const matches=e=>e.requestId===id&&validTime(e)&&((e.parentRunId!==undefined&&e.workspaceSha256!==undefined)||(legacyScopeComplete===true&&pending&&!ambiguous))&&(e.parentRunId===undefined||e.parentRunId===d.parentRunId)&&(e.workspaceSha256===undefined||e.workspaceSha256===d.workspaceSha256);
    const hosts=unique.filter(e=>pending&&matches(e)&&e.operation==='record_host_verification'&&e.hostVerification?.artifactSha256===artifact&&digest(e.hostVerification.recordSha256)&&['completed','failed'].includes(e.hostVerification.outcome??e.outcome)).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
    const first=hosts[0],proof=!!a&&!!pending&&verifyHostAttestation(a,pending),firstVerified=proof&&first?.hostVerification.recordSha256===a.recordSha256&&(first.hostVerification.outcome??first.outcome)===a.outcome;
    const accepted=unique.some(e=>pending&&proof&&matches(e)&&e.operation==='task_accepted'&&e.workspaceSha256===d.workspaceSha256&&e.parentRunId===d.parentRunId&&e.verification?.state==='completed'&&e.verification?.artifactSha256===artifact&&e.verification?.recordSha256===a.recordSha256&&a.outcome==='completed');
    const abandoned=unique.some(e=>pending&&matches(e)&&e.operation==='abandon_artifact'&&e.artifactSha256===artifact);
    const outcome=d.taskOutcome??d.outcome,terminal=['failed','blocked','cancelled','unverified'].includes(outcome);
    let state='evidence-missing';
    if(ambiguous||conflicts.has(key)||accepted&&abandoned)state='evidence-conflict';
    else if(accepted)state='accepted-recorded';
    else if(abandoned)state='abandoned';
    else if(firstVerified&&(first.hostVerification.outcome??first.outcome)==='failed')state='host-failed';
    else if(firstVerified)state='verified-not-accepted';
    else if(pending)state=first?'host-proof-unverified':'awaiting-host-verification';
    else if(terminal)state='delivery-failed';
    return {requestId:id,artifactSha256:digest(artifact)?artifact:null,state,firstHostOutcome:state!=='evidence-conflict'&&firstVerified?(first.hostVerification.outcome??first.outcome):null,hostMissing:!first,proofUnverified:!!first&&(!firstVerified||state==='evidence-conflict')};
  });
  const known=rows.filter(r=>r.firstHostOutcome!==null);
  return {rows,firstHost:{passed:known.filter(r=>r.firstHostOutcome==='completed').length,denominator:known.length,missing:rows.filter(r=>r.hostMissing).length,unverified:rows.filter(r=>r.proofUnverified).length},readOnly:true,acceptanceAuthority:false};
}
