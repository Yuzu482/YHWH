export const REVIEW_SECTIONS = Object.freeze(['requirements','changes','context','verification']);
export const REVIEW_FIELDS = Object.freeze(['reviewDecision','missingMaterials']);
export const isReviewer = role => role === 'Geburah' || role === 'reviewer';

export const T1_REVIEW_BUDGET = Object.freeze({version:2,nonDiffMaxUtf8Bytes:8192,totalMaxUtf8Bytes:24576,splitStrategy:'commit-ranges-preserve-whole-goal'});

// Preliminary syntax check only. Admission additionally binds these exact bytes
// to the trusted ledger artifact; a caller's own diff/hash is never provenance.
function completeUnifiedDiff(text) {
  if(typeof text!=='string'||!text||text.includes('\0'))return false;
  const lines=text.split('\n');
  let old=0,next=0,files=0,hunks=0,changed=false,fileHunks=0;
  for(let i=0;i<lines.length;i++){
    const line=lines[i].replace(/\r$/,'');
    if(old||next){
      if(line==='\\ No newline at end of file')continue;
      if(line.startsWith('+')&&next){next--;changed=true;}
      else if(line.startsWith('-')&&old){old--;changed=true;}
      else if(line.startsWith(' ')&&old&&next){old--;next--;}
      else return false;
      continue;
    }
    if(line==='\\ No newline at end of file')continue;
    if(line.startsWith('--- ')){
      if(files&&!fileHunks)return false;
      if(!line.slice(4).trim()||!lines[i+1]?.startsWith('+++ ')||!lines[i+1].slice(4).trim())return false;
      i++;files++;fileHunks=0;continue;
    }
    const hunk=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if(hunk){
      if(!files)return false;
      old=Number(hunk[2]??1);next=Number(hunk[4]??1);
      if(![old,next].every(Number.isSafeInteger)||(!old&&!next))return false;
      hunks++;fileHunks++;continue;
    }
    if(/^(?:diff --git |index [a-f0-9]+\.\.[a-f0-9]+(?: \d+)?$|(?:new file|deleted file|old|new) mode \d+$)/.test(line))continue;
    if(i===lines.length-1&&line==='')continue;
    return false;
  }
  return !old&&!next&&files>0&&hunks>0&&fileHunks>0&&changed;
}

export function measureReviewPacket(packet,{trustedPatch}={}) {
  const full=JSON.stringify(packet),withoutDiff=structuredClone(packet);
  const parts=packet.changes?.content;
  const diff=Array.isArray(parts)?parts.join(''):'';
  const validatedDiff=completeUnifiedDiff(diff)&&(trustedPatch===undefined||diff===trustedPatch);
  if(validatedDiff)withoutDiff.changes.content=parts.map(()=>'');
  return {totalUtf8Bytes:Buffer.byteLength(full,'utf8'),nonDiffUtf8Bytes:Buffer.byteLength(JSON.stringify(withoutDiff),'utf8'),validatedDiff};
}

// Read-only diagnostics. Caller equality is not trusted ledger provenance.
// Without a bound diff we show a conservative measurement and a separately
// labelled estimate; we never mistake the estimate for review admission.
export function inspectReviewPacketBudget(packet,{tier='T2',trustedPatch}={}) {
  if(!['T1','T2'].includes(tier))throw new Error('Invalid review tier');
  const invalid=(location,message)=>({ok:false,readOnly:true,modelCalls:0,admissionReady:false,budget:null,sections:[],
    violations:[{code:'REVIEW_MATERIALS_INVALID',location,message,blocking:true}],nextAction:'correct-materials-before-dispatch'});
  if(!packet||typeof packet!=='object'||Array.isArray(packet))return invalid('reviewPacket','Review packet must be an object');
  for(const name of REVIEW_SECTIONS){
    const part=packet[name];
    if(part!==undefined&&(!part||typeof part!=='object'||Array.isArray(part)||!Array.isArray(part.content??[])))
      return invalid(`reviewPacket.${name}.content`,'Review section content must be an array');
  }
  const measured=measureReviewPacket(packet,{trustedPatch});
  const diffBound=trustedPatch!==undefined&&measured.validatedDiff;
  const budget={...measured,nonDiffUtf8Bytes:diffBound?measured.nonDiffUtf8Bytes:measured.totalUtf8Bytes,
    projectedNonDiffUtf8Bytes:measured.nonDiffUtf8Bytes,diffBound,
    nonDiffMaxUtf8Bytes:tier==='T1'?T1_REVIEW_BUDGET.nonDiffMaxUtf8Bytes:null,
    totalMaxUtf8Bytes:tier==='T1'?T1_REVIEW_BUDGET.totalMaxUtf8Bytes:131072};
  budget.remainingUtf8Bytes={total:Math.max(0,budget.totalMaxUtf8Bytes-budget.totalUtf8Bytes),
    nonDiff:budget.nonDiffMaxUtf8Bytes===null?null:Math.max(0,budget.nonDiffMaxUtf8Bytes-budget.nonDiffUtf8Bytes)};
  budget.overByUtf8Bytes={total:Math.max(0,budget.totalUtf8Bytes-budget.totalMaxUtf8Bytes),
    nonDiff:budget.nonDiffMaxUtf8Bytes===null?null:Math.max(0,budget.nonDiffUtf8Bytes-budget.nonDiffMaxUtf8Bytes)};
  const violations=[];
  const add=(code,location,actual,limit,unit='utf8-bytes',blocking=true)=>violations.push({code,location,actual,limit,unit,blocking});
  if(tier==='T1'&&packet.stage!=='post-change')violations.push({code:'REVIEW_MATERIALS_INVALID',location:'reviewPacket.stage',message:'T1 requires post-change review',blocking:true});
  if(budget.totalUtf8Bytes>budget.totalMaxUtf8Bytes)add(tier==='T1'?'REVIEW_PACKET_T1_LIMIT':'REVIEW_PACKET_TOO_LARGE','reviewPacket.total',budget.totalUtf8Bytes,budget.totalMaxUtf8Bytes);
  if(tier==='T1'&&budget.nonDiffUtf8Bytes>budget.nonDiffMaxUtf8Bytes)
    add('REVIEW_PACKET_T1_LIMIT','reviewPacket.nonDiff',budget.nonDiffUtf8Bytes,budget.nonDiffMaxUtf8Bytes,'utf8-bytes',diffBound||!measured.validatedDiff||measured.nonDiffUtf8Bytes>budget.nonDiffMaxUtf8Bytes);
  const sections=REVIEW_SECTIONS.map(name=>{
    const part=packet[name],content=part?.content??[];
    if(content.length>32)add('REVIEW_SECTION_STRING_LIMIT',`reviewPacket.${name}.content`,content.length,32,'strings');
    content.forEach((s,i)=>{if(typeof s==='string'&&s.length>8000)add('REVIEW_STRING_LIMIT',`reviewPacket.${name}.content[${i}]`,s.length,8000,'utf16-units');});
    return {location:`reviewPacket.${name}`,utf8Bytes:Buffer.byteLength(JSON.stringify(part??null),'utf8'),strings:content.length};
  });
  const hard=violations.some(v=>v.blocking);
  return {ok:!hard,readOnly:true,modelCalls:0,budget,sections,violations,
    requiresTrustedDiffBinding:tier==='T1'&&measured.validatedDiff&&!diffBound,
    admissionReady:false,nextAction:hard?'organize-complete-reviews-by-commit-preserve-goal-quota':
      tier==='T1'&&!diffBound?'bind-complete-diff-to-trusted-artifact-before-admission':'validate-materials-and-trusted-artifact-before-dispatch'};
}

export function enforceT1ReviewBudget(packet,options={}) {
  const measured=measureReviewPacket(packet,options);
  if(packet.stage!=='post-change'||measured.totalUtf8Bytes>T1_REVIEW_BUDGET.totalMaxUtf8Bytes||measured.nonDiffUtf8Bytes>T1_REVIEW_BUDGET.nonDiffMaxUtf8Bytes)throw Object.assign(new Error(`T1 post-change reviewPacket requires non-diff <= 8192 and total <= 24576 UTF-8 bytes (non-diff=${measured.nonDiffUtf8Bytes}, total=${measured.totalUtf8Bytes}); organize complete reviews by commit without resetting whole-goal tier, identity or quota`),{code:'REVIEW_PACKET_T1_LIMIT',...measured,
    ...inspectReviewPacketBudget(packet,{tier:'T1',trustedPatch:options.trustedPatch??(measured.validatedDiff?packet.changes.content.join(''):undefined)})});
  return measured;
}

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
  if (tier==='T1') enforceT1ReviewBudget(result);
  if (serializedBytes>128*1024) throw Object.assign(new Error('reviewPacket exceeds 128 KiB'),{code:'REVIEW_PACKET_TOO_LARGE',
    ...inspectReviewPacketBudget(result,{tier})});
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
