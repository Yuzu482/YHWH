export const REVIEW_SECTIONS = Object.freeze(['requirements','changes','context','verification']);
export const REVIEW_FIELDS = Object.freeze(['reviewDecision','missingMaterials']);
export const isReviewer = role => role === 'Geburah' || role === 'reviewer';

export function validateReviewPacket(packet) {
  if (packet === undefined) return undefined;
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('reviewPacket must be an object');
  const keys=['version','stage',...REVIEW_SECTIONS];
  if (Object.keys(packet).some(key=>!keys.includes(key)) || packet.version !== 1 || !['pre-change','post-change'].includes(packet.stage)) throw new Error('Invalid reviewPacket version, stage, or keys');
  const result={version:1,stage:packet.stage};
  for (const name of REVIEW_SECTIONS) {
    const part=packet[name];
    if (part === undefined) { result[name]={status:'missing',content:[],reason:'section not supplied'}; continue; }
    if (!part || typeof part !== 'object' || Array.isArray(part) || Object.keys(part).some(k=>!['status','content','reason'].includes(k))) throw new Error(`Invalid reviewPacket.${name}`);
    if (!['provided','missing','not-applicable'].includes(part.status)) throw new Error(`Invalid reviewPacket.${name}.status`);
    const content=part.content??[];
    if (!Array.isArray(content) || content.length>32 || content.some(s=>typeof s!=='string'||!s.trim()||s.length>8000||s.includes('\0'))) throw new Error(`Invalid reviewPacket.${name}.content`);
    if (part.reason !== undefined && (typeof part.reason!=='string'||!part.reason.trim()||part.reason.length>2000||part.reason.includes('\0'))) throw new Error(`Invalid reviewPacket.${name}.reason`);
    if (part.status==='not-applicable' && (!part.reason || ['requirements','context'].includes(name))) throw new Error(`reviewPacket.${name} cannot be omitted without an applicable justification`);
    result[name]={status:part.status,content:[...content],...(part.reason?{reason:part.reason}:{})};
  }
  if (Buffer.byteLength(JSON.stringify(result))>128*1024) throw new Error('reviewPacket exceeds 128 KiB');
  return result;
}

export function requireReviewMaterials(task) {
  if (!isReviewer(task.role)) return;
  const packet=task.reviewPacket;
  const missing=REVIEW_SECTIONS.filter(name=>!packet || packet[name].status==='missing' || (packet[name].status==='provided'&&!packet[name].content.length));
  if (missing.length) throw Object.assign(new Error(`Review materials missing: ${missing.join(', ')}`),{code:'REVIEW_MATERIALS_MISSING',missingMaterials:missing});
  for (const field of ['status','evidence',...REVIEW_FIELDS]) if (!task.returnFields.includes(field)) throw new Error(`Reviewer returnFields must include ${field}`);
}

export function validateReviewDecision(value) {
  const decisions=['approve','request-changes','insufficient-materials'];
  if (!decisions.includes(value?.reviewDecision) || !Array.isArray(value.missingMaterials) || value.missingMaterials.length>32 || value.missingMaterials.some(v=>typeof v!=='string'||!v.trim()||v.length>2000)) return {ok:false,code:'invalid_review_decision',approved:false};
  const insufficient=value.reviewDecision==='insufficient-materials';
  if ((insufficient && (!value.missingMaterials.length || value.status!=='blocked')) || (!insufficient && (value.missingMaterials.length || value.status!=='completed'))) return {ok:false,code:'inconsistent_review_decision',approved:false};
  if (value.reviewDecision==='approve' && !(typeof value.evidence==='string' ? value.evidence.trim() : Array.isArray(value.evidence)&&value.evidence.length)) return {ok:false,code:'review_evidence_missing',approved:false};
  return {ok:true,code:'valid',approved:value.reviewDecision==='approve',decision:value.reviewDecision,missingMaterials:value.missingMaterials};
}
