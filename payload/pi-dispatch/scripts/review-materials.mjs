import {missingReviewPatchMaterials,validateReviewPacket} from '../extensions/review-contract.js';
const LIMITS=Object.freeze({sectionChars:8000,stringsPerSection:32,totalBytes:131072});
const sections=['requirements','changes','context','verification'];
const redact=text=>text.replace(/(\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*)[^\s,;]+/giu,'$1[REDACTED]').replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu,'Bearer [REDACTED]');

export function buildReviewPacket({stage,requirements,changes,context,verification,tier,changedFiles}) {
  if(!['pre-change','post-change'].includes(stage)) throw new Error('Invalid review stage');
  const packet={version:1,stage};
  for(const name of sections){
    const value={requirements,changes,context,verification}[name];
    if(!value||!Array.isArray(value)||!value.length) throw new Error(`Missing review section: ${name}`);
    const chunks=[];
    for(const raw of value){
      if(typeof raw!=='string'||!raw.trim()||raw.includes('\0')) throw new Error(`Invalid review material: ${name}`);
      const safe=redact(raw);
      for(let i=0;i<safe.length;i+=LIMITS.sectionChars) chunks.push(safe.slice(i,i+LIMITS.sectionChars));
    }
    if(chunks.length>LIMITS.stringsPerSection) throw new Error(`Review section exceeds string budget: ${name}`);
    packet[name]={status:'provided',content:chunks};
  }
  if(tier==='T2'&&!Array.isArray(changedFiles)) throw new Error('T2 review requires trusted changed-file evidence');
  if(tier!=='T2'&&tier!=='T1') throw new Error('Invalid review tier');
  const missing=missingReviewPatchMaterials(changedFiles,packet.changes.content);
  if(stage==='post-change'&&missing.length) throw Object.assign(new Error(`Review changes omit substantive patch material: ${missing.join(', ')}`),{code:'REVIEW_MATERIALS_MISSING'});
  try { return validateReviewPacket(packet,{tier}); }
  catch(error) { throw Object.assign(error,{code:error.code??(Buffer.byteLength(JSON.stringify(packet),'utf8')>LIMITS.totalBytes?'REVIEW_PACKET_TOO_LARGE':'REVIEW_MATERIALS_INVALID')}); }
}

export {LIMITS as REVIEW_MATERIAL_LIMITS};
