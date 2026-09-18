import {createHash} from 'node:crypto';
import {redactSensitiveText} from './audit-log.js';
const sensitive=/^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|passwd|secret|credentials?)$/i;
export function sanitizeResult(value){
  if(typeof value==='string')return redactSensitiveText(value,{compact:false});
  if(Array.isArray(value))return value.map(sanitizeResult);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[redactSensitiveText(key,{compact:false}),sensitive.test(key)?'[REDACTED]':sanitizeResult(item)]));
  return value;
}
export function exportResult(result,{offset=0,limit=32768}={}){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>65536)throw new Error('Invalid result page');
  const sanitized=sanitizeResult(result),json=JSON.stringify(sanitized);
  if(offset>json.length)throw new Error('Result offset exceeds length');
  const end=Math.min(offset+limit,json.length);
  return {encoding:'json-utf16-offsets',offset,nextOffset:end<json.length?end:null,totalLength:json.length,sha256:createHash('sha256').update(json).digest('hex'),redacted:true,
    ...(offset===0&&end===json.length?{result:sanitized}:{resultJsonChunk:json.slice(offset,end)})};
}
