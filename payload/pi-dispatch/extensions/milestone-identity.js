import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {compileWriteScope} from './write-scope-guard.js';
import {validateVerify} from '../scripts/check-policy.mjs';
const HEX=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, MILESTONE_ID=/^[a-z][a-z0-9-]{0,63}$/;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const clone=v=>JSON.parse(JSON.stringify(v));
function err(code,message=code){throw new MilestoneLedgerError(code,message);}
function safeText(v,max,code){if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))err(code);return v;}
const digestText=v=>createHash('sha256').update(v,'utf8').digest('hex');
function canonicalWorkspace(path){let p;try{p=realpathSync(path);}catch{err('PI_MILESTONE_INVALID','workspace must resolve to an existing directory');}return process.platform==='win32'?p.toLowerCase():p;}
export class MilestoneLedgerError extends Error{constructor(code,message=code){super(message);this.name='MilestoneLedgerError';this.code=code;}}
export function validateMilestone(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||!['id','objective','acceptanceCommandIds'].every(k=>Object.hasOwn(value,k))||!MILESTONE_ID.test(value.id??''))err('PI_MILESTONE_INVALID');
  safeText(value.objective,2000,'PI_MILESTONE_INVALID');
  if(!Array.isArray(value.acceptanceCommandIds)||value.acceptanceCommandIds.length<1||value.acceptanceCommandIds.length>8||new Set(value.acceptanceCommandIds).size!==value.acceptanceCommandIds.length||value.acceptanceCommandIds.some(id=>!MILESTONE_ID.test(id)))err('PI_MILESTONE_INVALID');
  return clone(value);
}
export function validateMilestonePlan(value){
  if(!Array.isArray(value)||!value.length||value.length>32)err('PI_MILESTONE_INVALID');
  const seen=new Set();return value.map(item=>{
    if(!item||typeof item!=='object'||Object.keys(item).length!==3||!['milestone','verify','writeScope'].every(k=>Object.hasOwn(item,k)))err('PI_MILESTONE_INVALID');
    const milestone=validateMilestone(item.milestone);if(seen.has(milestone.id))err('PI_MILESTONE_INVALID');seen.add(milestone.id);
    const verify=validateVerify(item.verify);if(!verify||!compileWriteScope(item.writeScope).length)err('PI_MILESTONE_INVALID');
    return {milestone,verify,writeScope:[...item.writeScope]};
  });
}
export function validatePreviousFailure(value){
  const keys=['requestId','checkName','outputSha256','excerpt'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||!ID.test(value.requestId??'')||!HEX.test(value.outputSha256??'')||typeof value.excerpt!=='string'||value.excerpt.length>4096||value.excerpt.includes('\0'))err('PI_MILESTONE_INVALID');
  safeText(value.checkName,128,'PI_MILESTONE_INVALID');return clone(value);
}
// Pure identity preparation is shared by pre-review binding and write admission.
export function describeMilestone({workspace,parentRunId,milestone,verify,writeScope}) {
  milestone=validateMilestone(milestone);
  safeText(parentRunId,128,'PI_MILESTONE_INVALID');if(!ID.test(parentRunId))err('PI_MILESTONE_INVALID');
  if (!milestone || !MILESTONE_ID.test(milestone.id ?? '')) err('PI_MILESTONE_INVALID');
  safeText(milestone.objective,2000,'PI_MILESTONE_INVALID');
  const ids=milestone.acceptanceCommandIds;
  if (!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>!MILESTONE_ID.test(id))) err('PI_MILESTONE_INVALID');
  let checked,scope;
  try { checked=validateVerify(verify); scope=compileWriteScope(writeScope).map(x=>`${x.path}${x.tree?'/**':''}`).sort(); }
  catch { err('PI_MILESTONE_INVALID'); }
  if (!checked || !scope.length) err('PI_MILESTONE_INVALID');
  const commands=ids.map(id=>{const c=checked.commands.find(c=>c.id===id);if(!c)err('PI_MILESTONE_INVALID');return c;}).sort((a,b)=>a.id.localeCompare(b.id));
  const identity={workspace:canonicalWorkspace(workspace),parentRunId,milestone:clone(milestone)};
  const key=hash({workspace:identity.workspace,parentRunId,milestoneId:milestone.id});
  return {identity,key,scope,scopeSha256:hash(scope),commands,definitionSha256:hash({objective:milestone.objective,commands,writeScope:scope})};
}
