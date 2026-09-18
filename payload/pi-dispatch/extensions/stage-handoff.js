import {createHash} from 'node:crypto';
import {canonicalRole, resultDigest} from './role-contract.js';
import {sanitizeResult} from './result-export.js';

export const STAGES = {compiled:'Yesod', clarified:'Binah', classified:'Hod', scouted:'Malkuth', planned:'Chochmah', 'pre-review':'Geburah', implementing:'Chesed', verifying:'Netzach', 'post-review':'Geburah'};
const required = {compiled:[], clarified:['compiled'], classified:[], scouted:[], planned:['scouted'], 'pre-review':['planned'], implementing:['pre-review'], verifying:['implementing'], 'post-review':['verifying']};
const allowed = {compiled:[], clarified:['compiled'], classified:['compiled','clarified'], scouted:['compiled','clarified','classified'], planned:['compiled','clarified','classified','scouted'], 'pre-review':['planned','scouted'], implementing:['planned','pre-review'], verifying:['implementing','planned'], 'post-review':['verifying','implementing','pre-review']};
const fail = message => {throw Object.assign(new Error(message),{code:'HANDOFF_INVALID'});};
const id = value => typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const sha = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
export const workspaceDigest = cwd => createHash('sha256').update(cwd).digest('hex');
export function stageFor(task) {
  const role=canonicalRole(task.role);
  return role==='Geburah' ? (task.reviewPacket?.stage==='pre-change'?'pre-review':'post-review') : Object.keys(STAGES).find(stage=>STAGES[stage]===role);
}

export function validateHandoff(value, task) {
  if (value===undefined) return undefined;
  if (!exact(value,['version','stage','inputs']) || value.version!==1 || !Object.hasOwn(STAGES,value.stage) || value.stage!==stageFor(task) || !Array.isArray(value.inputs) || value.inputs.length>16) fail('Invalid handoff version, stage, role or inputs');
  const seen=new Set();
  for (const input of value.inputs) {
    if (!exact(input,['requestId','role','stage','resultSha256']) || !id(input.requestId) || !sha(input.resultSha256) || !Object.hasOwn(STAGES,input.stage) || STAGES[input.stage]!==input.role || !allowed[value.stage].includes(input.stage) || seen.has(input.requestId)) fail('Invalid, duplicate or disallowed handoff input');
    seen.add(input.requestId);
  }
  if (required[value.stage].some(stage=>!value.inputs.some(input=>input.stage===stage))) fail(`Stage ${value.stage} requires predecessor ${required[value.stage].join(', ')}`);
  return {version:1,stage:value.stage,inputs:value.inputs.map(input=>({...input}))};
}

export function prepareHandoff(task, input, cwd, ledger) {
  const handoff=validateHandoff(task.handoff,task);
  const deps=input.dependsOnRequestIds??[];
  if (!handoff) {
    if (deps.length) fail('Dependencies require an explicit typed handoff');
    return ()=>true;
  }
  if (!id(input.requestId) || !id(input.parentRunId) || !ledger?.enabled) fail('Handoff requires stable requestId, parentRunId and persistent ledger');
  if (new Set(deps).size!==deps.length || deps.length!==handoff.inputs.length || handoff.inputs.some(ref=>!deps.includes(ref.requestId)||ref.requestId===input.requestId)) fail('Handoff inputs must exactly match dependency request IDs');
  return ()=>{
    for (const ref of handoff.inputs) {
      const prior=ledger.getOutcome(ref.requestId);
      if (prior.state==='pending') return false;
      const c=prior.contract;
      if (prior.state!=='completed' || !c || c.version!==2 || c.mode!=='linked' || c.parentRunId!==input.parentRunId || c.workspaceSha256!==workspaceDigest(cwd) || c.role!==ref.role || c.stage!==ref.stage || c.resultSha256!==ref.resultSha256 || (ref.role==='Geburah' && c.reviewDecision!=='approve')) fail(`Predecessor contract does not match: ${ref.requestId}`);
    }
    return true;
  };
}

export function completedContract(task,input,cwd,value) {
  return {version:2,role:canonicalRole(task.role),stage:stageFor(task),mode:task.handoff?'linked':'standalone',parentRunId:input.parentRunId??null,
    workspaceSha256:workspaceDigest(cwd),resultSha256:resultDigest(value),...(canonicalRole(task.role)==='Geburah'?{reviewDecision:value.reviewDecision}:{})};
}

export function collectHandoffResults(task, ledger) {
  const results=(task.handoff?.inputs??[]).map(ref=>{
    const prior=ledger.getOutcome(ref.requestId);
    if (!prior.handoffResult || prior.contract?.resultSha256!==ref.resultSha256 || resultDigest(prior.handoffResult)!==ref.resultSha256) fail(`Predecessor result unavailable or changed: ${ref.requestId}`);
    return {requestId:ref.requestId,contract:prior.contract,result:sanitizeResult(prior.handoffResult)};
  });
  if (Buffer.byteLength(JSON.stringify(results))>128*1024) fail('Combined upstream results exceed 128 KiB; split the task, do not truncate evidence');
  return results;
}

export const HANDOFF_POLICY={version:1,requiredPredecessors:required,allowedPredecessors:allowed,rootStages:['compiled','classified','scouted'],standaloneAllowed:true};
