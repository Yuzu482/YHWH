import {missingReviewPatchMaterials,validateReviewPacket,inspectReviewPacketBudget} from '../extensions/review-contract.js';
const LIMITS=Object.freeze({sectionChars:8000,stringsPerSection:32,totalBytes:131072});
const sections=['requirements','changes','context','verification'];
const redact=text=>text.replace(/(\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*)[^\s,;]+/giu,'$1[REDACTED]').replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu,'Bearer [REDACTED]');

function preparePacket({stage,requirements,changes,context,verification}) {
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
    if(chunks.length>LIMITS.stringsPerSection){
      // Preserve trusted diff bytes; separate other independent excerpts clearly.
      const packed=chunkReviewText(excerpts.join(name==='changes'?'':'\n'),false);
      if(packed.length<chunks.length)chunks.splice(0,chunks.length,...packed);
    }
    packet[name]={status:'provided',content:chunks};
  }
  return packet;
}

function checkMaterial(input,packet) {
  const {tier,stage,changedFiles,trustedPatch}=input;
  if(tier==='T2'&&!Array.isArray(changedFiles)) throw new Error('T2 review requires trusted changed-file evidence');
  if(tier!=='T2'&&tier!=='T1') throw new Error('Invalid review tier');
  const missing=missingReviewPatchMaterials(changedFiles,[packet.changes.content.join('')]);
  if(stage==='post-change'&&missing.length) throw Object.assign(new Error(`Review changes omit substantive patch material: ${missing.join(', ')}`),{code:'REVIEW_MATERIALS_MISSING',location:'reviewPacket.changes',missingMaterials:missing});
  if(trustedPatch!==undefined&&packet.changes.content.join('')!==trustedPatch)
    throw Object.assign(new Error('Review sanitization changed or mismatched supplied patch; secure handling required'),{code:'REVIEW_PATCH_BINDING_MISMATCH',location:'reviewPacket.changes'});
}

export function inspectReviewMaterialBudget(input) {
  let inspection;
  try {
    const packet=preparePacket(input);
    inspection=inspectReviewPacketBudget(packet,{tier:input.tier,trustedPatch:input.trustedPatch});
    checkMaterial(input,packet);
    // Structural validation uses existing preliminary semantics; budget diagnostics
    // above distinguish conservative unbound diff estimates from hard violations.
    if(inspection.ok)validateReviewPacket(packet,{tier:input.tier});
    return inspection;
  }catch(error){
    return {...(inspection??{}),ok:false,readOnly:true,modelCalls:0,admissionReady:false,
      budget:inspection?.budget??error.budget??null,sections:inspection?.sections??error.sections??[],
      violations:[...(inspection?.violations??error.violations??[]),{code:error.code??'REVIEW_MATERIALS_INVALID',location:error.location??'reviewPacket',message:error.message,blocking:true}],
      nextAction:inspection?.violations.some(v=>v.blocking)?'organize-complete-reviews-by-commit-preserve-goal-quota':'correct-materials-before-dispatch'};
  }
}

export function buildReviewPacket(input) {
  const {tier}=input,packet=preparePacket(input);
  checkMaterial(input,packet);
  const diagnostic=inspectReviewPacketBudget(packet,{tier,trustedPatch:input.trustedPatch});
  const shapeIssue=diagnostic.violations.find(v=>v.code==='REVIEW_SECTION_STRING_LIMIT'||v.code==='REVIEW_STRING_LIMIT');
  if(shapeIssue)throw Object.assign(new Error(`Review section exceeds string budget: ${shapeIssue.location}`),{...diagnostic,code:shapeIssue.code,location:shapeIssue.location});
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
