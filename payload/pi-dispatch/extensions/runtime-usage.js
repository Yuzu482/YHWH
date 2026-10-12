// Execution aggregation shares the pure normalizer already shipped with the audit module.
import {normalizeUsage} from './audit-log.js';
export {normalizeUsage};
const count = n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
export function aggregateExecutionUsage(events, {costUnavailable=false}={}) {
  const messages = events.filter(e=>e?.type==='message_end' && e.sourceType==='message_end' && e.role==='assistant');
  if (!messages.length) return undefined;
  const values = messages.map(m=>normalizeUsage(m.usage));
  const fields = Object.keys(values[0]);
  const totals = Object.fromEntries(fields.map(key=>[key,values.every(v=>v[key]!==null) ? count(values.reduce((s,v)=>s+v[key],0)) : null]));
  const observedMessages = values.filter(v=>fields.some(key=>v[key]!==null)).length;
  const execution = {scope:'execution-assistant-message-end',expectedMessages:messages.length,observedMessages,
    complete:observedMessages===messages.length && totals.totalTokens!==null, ...totals};
  // Preserve the legacy single-message shape. New metadata is an explicit equivalence boundary.
  const usage = messages.length===1 ? {...messages[0].usage} : {...totals};
  return {...usage,execution,...(costUnavailable || messages.length>1 ? {cost:null,costUnavailable:true} : {})};
}
