import {MilestoneLedgerError} from './milestone-identity.js';

// Check before creating the authoritative record and again immediately before
// its synchronous event callback. Sidecar closure must never create acceptance.
export function assertMilestoneAcceptance(attempt,artifactSha256,{replaying=false,acceptanceState}={}){
  if(!attempt)return; // Historical records retain their original acceptance gates.
  if(attempt.artifactSha256!==artifactSha256)throw new MilestoneLedgerError('PI_MILESTONE_CONFLICT');
  if(attempt.status==='accepted'&&replaying&&acceptanceState==='accepted')return;
  if(attempt.status!=='verified-not-accepted'||attempt.verifyPassed!==true)throw new MilestoneLedgerError('PI_MILESTONE_NOT_VERIFIED');
}
