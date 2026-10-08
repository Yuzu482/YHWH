export const REVIEW_SECTIONS = Object.freeze(['requirements','changes','context','verification']);
export const REVIEW_FIELDS = Object.freeze(['reviewDecision','missingMaterials']);
export const isReviewer = role => role === 'Geburah' || role === 'reviewer';

export function missingReviewPatchMaterials(changedFiles, content) {
  if (!Array.isArray(changedFiles)) return ['<changed-file-list-unavailable>'];
  if (!Array.isArray(content)) return [...changedFiles];
  const parsePath = value => {
    value=value.trim();
    if (value.startsWith('"')) { try { value=JSON.parse(value); } catch { return null; } }
    else value=value.split('\t')[0];
    return value.replace(/\\/g,'/');
  };
  const normalize = (value, diffHeader = false) => {
    if(typeof value!=='string'||!value.trim())return null;
    let result=diffHeader ? parsePath(value) : value.trim().replace(/\\/g,'/');
    if(!result)return null;
    if(diffHeader) result=result.replace(/^(?:a|b)\//,'');
    result=result.replace(/^\/(?:sandbox|var\/lib\/pi-kether\/jobs\/[^/]+)\/(?:baseline|workspace)\//,'');
    return result.replace(/^\/+/, '');
  };
  const expectedFiles=[...new Set(changedFiles.map(value=>normalize(value)))];
  if(expectedFiles.some(value=>!value))return ['<changed-file-list-unavailable>'];
  const sections=[];
  let section=null, inHunk=false;
  for(const line of content.join('\n').split(/\r?\n/)){
    if(line.startsWith('--- ')){if(section)sections.push(section);section={old:normalize(line.slice(4),true),next:null,changed:false};inHunk=false;}
    else if(section&&line.startsWith('+++ '))section.next=normalize(line.slice(4),true);
    else if(section&&/^@@ /.test(line))inHunk=true;
    else if(section&&inHunk&&(/^\+(?!\+\+)/.test(line)||/^-(?!--)/.test(line)))section.changed=true;
    else if(section&&inHunk&&!line.startsWith(' '))inHunk=false;
  }
  if(section)sections.push(section);
  return expectedFiles.filter(expected=>!sections.some(item=>{
    const old=item.old==='/dev/null'?null:item.old, next=item.next==='/dev/null'?null:item.next;
    return item.changed&&(old===expected||next===expected);
  }));
}

export function validateReviewPacket(packet, {tier='T2'}={}) {
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
  const serializedBytes=Buffer.byteLength(JSON.stringify(result),'utf8');
  if (tier==='T1' && (result.stage!=='post-change' || serializedBytes>10240)) throw Object.assign(new Error('T1 post-change reviewPacket exceeds 10240 UTF-8 bytes or has invalid stage'),{code:'REVIEW_PACKET_T1_LIMIT'});
  if (serializedBytes>128*1024) throw new Error('reviewPacket exceeds 128 KiB');
  return result;
}

export function requireReviewMaterials(task) {
  if (!isReviewer(task.role)) return;
  const packet=task.reviewPacket;
  const missing=REVIEW_SECTIONS.filter(name=>{
    const section=packet?.[name];
    if (!section) return true;
    if (section.status==='not-applicable') return ['requirements','context'].includes(name) || typeof section.reason!=='string' || !section.reason.trim();
    return section.status!=='provided' || !Array.isArray(section.content) || !section.content.length || section.content.some(item=>typeof item!=='string'||!item.trim());
  });
  if (missing.length) throw Object.assign(new Error(`Review materials missing: ${missing.join(', ')}`),{code:'REVIEW_MATERIALS_MISSING',missingMaterials:missing});
  if (task.returnFields !== undefined) {
    if (!Array.isArray(task.returnFields)) throw new Error('Reviewer returnFields must be an array');
    for (const field of ['status','evidence',...REVIEW_FIELDS]) if (!task.returnFields.includes(field)) throw new Error(`Reviewer returnFields must include ${field}`);
  }
}

export function validateReviewDecision(value, {tier='T2'}={}) {
  const decisions=['approve','request-changes','insufficient-materials'];
  if (!decisions.includes(value?.reviewDecision) || !Array.isArray(value.missingMaterials) || value.missingMaterials.length>32 || value.missingMaterials.some(v=>typeof v!=='string'||!v.trim()||v.length>2000)) return {ok:false,code:'invalid_review_decision',approved:false};
  const insufficient=value.reviewDecision==='insufficient-materials';
  if ((insufficient && (!value.missingMaterials.length || value.status!=='blocked')) || (!insufficient && (value.missingMaterials.length || value.status!=='completed'))) return {ok:false,code:'inconsistent_review_decision',approved:false};
  if (value.reviewDecision==='approve' && !(typeof value.evidence==='string' ? value.evidence.trim() : Array.isArray(value.evidence)&&value.evidence.length)) return {ok:false,code:'review_evidence_missing',approved:false};
  let conditional=false;
  const findings=value.deliverable?.findings;
  const severities=['info','low','medium','high','critical'];
  if (findings!==undefined && (!Array.isArray(findings) || findings.some(f=>!f||typeof f!=='object'||Array.isArray(f)||!severities.includes(f.severity)||(Object.hasOwn(f,'blocking')&&typeof f.blocking!=='boolean')||Object.keys(f).some(k=>!['severity','description','evidence','blocking'].includes(k))))) return {ok:false,code:'invalid_review_findings',approved:false};
  if (value.reviewDecision==='approve' && tier==='T1' && findings?.length) {
    conditional=findings.every(f=>f.blocking===false && !['high','critical'].includes(f.severity));
    if (!conditional) return {ok:false,code:'t1_findings_block_approval',approved:false};
  }
  return {ok:true,code:conditional?'conditional_approval':'valid',approved:value.reviewDecision==='approve',conditional,decision:value.reviewDecision,missingMaterials:value.missingMaterials};
}
