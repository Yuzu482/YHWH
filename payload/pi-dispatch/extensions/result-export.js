import {createHash} from 'node:crypto';
import {redactSensitiveText} from './audit-log.js';
const sensitive=/^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|passwd|secret|credentials?)$/i;
export function sanitizeResult(value){
  if(typeof value==='string')return redactSensitiveText(value,{compact:false});
  if(Array.isArray(value))return value.map(sanitizeResult);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[redactSensitiveText(key,{compact:false}),sensitive.test(key)?'[REDACTED]':sanitizeResult(item)]));
  return value;
}
function sanitizeCapturedRecord(source,allowResponse=true,mode='projection'){
  if(!source||typeof source!=='object'||Array.isArray(source))return sanitizeResult(source);
  const out={};
  for(const [key,item] of Object.entries(source)){
    const safeKey=redactSensitiveText(key,{compact:false});
    if(sensitive.test(key)){out[safeKey]='[REDACTED]';continue;}
    if(key==='patch'&&typeof item==='string'&&(source.patchPolicy==='issued-credential-v1'||(mode==='stored')||(mode==='export'&&source.patchPolicy==='legacy'))){
      out[safeKey]=item;
      continue;
    }
    if(allowResponse&&key==='response'&&item&&typeof item==='object'&&!Array.isArray(item))out[safeKey]=sanitizeCapturedRecord(item,false,mode);
    else out[safeKey]=sanitizeResult(item);
  }
  if((mode==='projection'||mode==='stored')&&typeof source.patch==='string'&&source.patchPolicy!=='issued-credential-v1'){
    out.patchPolicy='legacy';
    delete out.secretLikeContent;
  } else if(mode==='stored'&&typeof source.patch!=='string'){
    if(source.patchPolicy==='legacy')delete out.patchPolicy;
    delete out.secretLikeContent;
  }
  return out;
}
export function sanitizeCapturedResult(value,{mode='projection'}={}){
  return value&&typeof value==='object'&&!Array.isArray(value)?sanitizeCapturedRecord(value,true,mode):sanitizeResult(value);
}
export function exportResult(result,{offset=0,limit=32768}={}){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>65536)throw new Error('Invalid result page');
  const sanitized=sanitizeCapturedResult(result,{mode:'export'}),json=JSON.stringify(sanitized);
  if(offset>json.length)throw new Error('Result offset exceeds length');
  const end=Math.min(offset+limit,json.length);
  return {encoding:'json-utf16-offsets',offset,nextOffset:end<json.length?end:null,totalLength:json.length,sha256:createHash('sha256').update(json).digest('hex'),redacted:true,
    ...(offset===0&&end===json.length?{result:sanitized}:{resultJsonChunk:json.slice(offset,end)})};
}
