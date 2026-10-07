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
    const chunks=[],excerpts=[];
    for(const raw of value){
      if(typeof raw!=='string'||!raw.trim()||raw.includes('\0')) throw new Error(`Invalid review material: ${name}`);
      const safe=redact(raw);
      excerpts.push(safe);
      chunks.push(...chunkReviewText(safe));
    }
    if(chunks.length>LIMITS.stringsPerSection){
      chunks.length=0;
      for(const safe of excerpts) chunks.push(...chunkReviewText(safe,false));
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

function chunkReviewText(text,preferLines=true) {
  const chunks=[];
  let start=0;
  while(start<text.length){
    let end=Math.min(start+LIMITS.sectionChars,text.length);
    if(end<text.length){
      const newline=preferLines?text.lastIndexOf('\n',end-1):-1;
      const nextChunk=text.slice(newline+1,newline+1+LIMITS.sectionChars);
      if(newline>=start&&text.slice(start,newline).trim()&&nextChunk.trim()) end=newline+1;
      else if(text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff) end--;
      else if(text.charCodeAt(end-1)===13&&text.charCodeAt(end)===10) end--;
    }
    if(end===start) end=Math.min(start+LIMITS.sectionChars,text.length);
    chunks.push(text.slice(start,end));
    start=end;
  }
  return chunks;
}
