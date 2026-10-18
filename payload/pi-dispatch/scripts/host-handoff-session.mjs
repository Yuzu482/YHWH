// Host-only, process-local preparation cache. Never executes, dispatches or accepts.
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {sha256,assertCandidate,assertHostCapture} from './host-handoff.mjs';
import {prepareReviewBundle} from './host-handoff-flow.mjs';
import {inspectPrimaryPacket,runtimePreflight} from './runtime-preflight.mjs';
import {validateKetherInvocation} from './dispatch.mjs';
import {inspectReviewPacketBudget,T1_REVIEW_BUDGET} from '../extensions/review-contract.js';
import {inspectCheckCoverage} from './check-coverage.mjs';

const fail = message => {throw new Error(message);};
const clone = value => structuredClone(value);
const digest = value => sha256(JSON.stringify(value));
function binding(input) {
  const {request,candidate}=input??{};
  assertCandidate(candidate);
  if(request?.requestId!==candidate.requestId||request.parentRunId!==candidate.handoff.parentRunId||
    typeof request.cwd!=='string'||sha256(resolve(request.cwd))!==candidate.handoff.workspaceSha256||request.tier!==candidate.handoff.tier)fail('Resume task binding mismatch');
  return {requestId:request.requestId,workspaceSha256:candidate.handoff.workspaceSha256,anchorSha256:candidate.handoff.anchorSha256,
    parentRunId:request.parentRunId,artifactSha256:candidate.artifactSha256,inputSha256:digest(input)};
}

function boundSummary(input, prepared, identity) {
  if(input.hostCapture)assertHostCapture(input.candidate,input.hostCapture);
  if(input.hostRecord && (!input.hostCapture||input.hostRecord.ok!==true||input.hostRecord.requestId!==identity.requestId||
    input.hostRecord.artifactSha256!==identity.artifactSha256||input.hostRecord.state!=='completed'||input.hostRecord.outcome!=='completed'||
    !/^[a-f0-9]{64}$/.test(input.hostRecord.recordSha256??'')||!Array.isArray(input.hostRecord.checks)||
    input.hostRecord.checks.length!==input.candidate.handoff.requiredCheckNames.length||new Set(input.hostRecord.checks.map(c=>c.checkName)).size!==input.hostRecord.checks.length||
    input.hostRecord.checks.some(c=>c.exitCode!==0||!input.candidate.handoff.requiredCheckNames.includes(c.checkName))))fail('Resume host record mismatch');
  const stage=prepared?'review-ready':input.hostRecord?'host-recorded':input.hostCapture?'host-checks-completed':'candidate-ready';
  const nextActions={ 'candidate-ready':['primary-inspect-and-apply','host-checks'], 'host-checks-completed':['record-host-verification'],
    'host-recorded':['prepare-review'], 'review-ready':['primary-inspect-review-materials','explicit-review-dispatch'] }[stage];
  return {version:1,...identity,stage,nextActions,hostRecordSha256:input.hostRecord?.recordSha256??null,
    packetSha256:prepared?.packetSha256??null,budget:prepared?.budget??null,readOnly:true,modelCalls:0,requiresPrimaryInspection:true};
}
export function stageSummary(input, prepared) {return boundSummary(input,prepared,binding(input));}

// Checkpoints are digest-bound local hints, not durable gateway attestations.
export function resumeStage(checkpoint,input) {
  const expected=stageSummary(input);
  for(const key of ['version','requestId','workspaceSha256','anchorSha256','parentRunId','artifactSha256','inputSha256'])
    if(checkpoint?.[key]!==expected[key])fail('Stale or mismatched resume checkpoint: '+key);
  return expected; // Never trust a persisted stage, acceptance flag or cached approval.
}

export function reviewReadiness(input,options) {
  try {const bundle=prepareReviewBundle(input,options);return {ok:true,bundle,budget:bundle.budget,issues:[]};}
  catch(error) {
    const budgetFailure=['REVIEW_PACKET_T1_LIMIT','REVIEW_PACKET_TOO_LARGE','REVIEW_SECTION_STRING_LIMIT','REVIEW_STRING_LIMIT'].includes(error.code);
    return {ok:false,modelCalls:0,issues:[{code:error.code??'HOST_REVIEW_NOT_READY',location:error.location??(budgetFailure?'reviewPacket':'hostReviewInput'),message:error.message}],
      budget:error.budget??{nonDiffMaxUtf8Bytes:input?.request?.tier==='T1'?T1_REVIEW_BUDGET.nonDiffMaxUtf8Bytes:null,
        totalMaxUtf8Bytes:input?.request?.tier==='T1'?T1_REVIEW_BUDGET.totalMaxUtf8Bytes:131072,
        nonDiffUtf8Bytes:error.nonDiffUtf8Bytes??null,totalUtf8Bytes:error.totalUtf8Bytes??null},
      violations:error.violations??[],sections:error.sections??[],
      nextAction:budgetFailure?'organize-complete-reviews-by-commit-preserve-goal-quota':'correct-input-before-dispatch'};
  }
}

// The host supplies already-inspected source and command availability, not task text.
export function inspectDispatchReadiness({request,sourceFacts=[],authorization,hostCommands=[],coverageFacts=[],checkAvailability={available:false,reason:'not-inspected'}}) {
  const issues=[],packetCheck=inspectPrimaryPacket(request?.task);
  let reviewBudget=null;
  try {
    if(request?.task?.reviewPacket)reviewBudget=inspectReviewPacketBudget(request.task.reviewPacket,{tier:request.tier??'T2'});
    if(reviewBudget)issues.push(...reviewBudget.violations.filter(v=>v.blocking));
  }catch(error){issues.push({code:'REVIEW_MATERIALS_INVALID',location:'task.reviewPacket',message:error.message});}
  if(!packetCheck.ok)issues.push(...packetCheck.criticalCodes.map(code=>({code,location:'task'})));
  try {
    const {cwd,access,provider,model,thinking,timeoutSeconds,resourceProfile,task}=request??{};
    validateKetherInvocation({cwd,access,provider,model,thinking,timeoutSeconds,resourceProfile,task},true,cwd);
  }catch(error){issues.push({code:'REQUEST_INVALID',location:'request',message:error.message});}
  const required=request?.task?.readScope??[];
  for(const file of required) {
    const fact=sourceFacts.find(f=>f.path===file);
    if(!fact||fact.available!==true||!/^[a-f0-9]{64}$/.test(fact.sha256??''))issues.push({code:'SOURCE_UNAVAILABLE',location:'task.readScope',path:file});
  }
  const writes=request?.task?.writeScope??[];
  if(writes.some(p=>typeof p!=='string'||p.includes('\\')||p.startsWith('/')||/^[A-Za-z]:/.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..')))
    issues.push({code:'WRITE_SCOPE_INVALID',location:'task.writeScope'});
  const covers=(allowed,p)=>Array.isArray(allowed)&&allowed.some(rule=>typeof rule==='string'&&(rule===p||rule.endsWith('/**')&&p.startsWith(rule.slice(0,-2))));
  if(authorization?.approved!==true||authorization.cwd!==request?.cwd||typeof authorization.source!=='string'||!authorization.source.trim())
    issues.push({code:'AUTHORIZATION_NOT_INSPECTED',location:'authorization'});
  else {
    for(const p of required)if(!covers(authorization.readScope,p))issues.push({code:'READ_SCOPE_NOT_AUTHORIZED',location:'task.readScope',path:p});
    for(const p of writes)if(!covers(authorization.writeScope,p))issues.push({code:'WRITE_SCOPE_NOT_AUTHORIZED',location:'task.writeScope',path:p});
  }
  if(!Array.isArray(hostCommands)||hostCommands.length===0)issues.push({code:'HOST_CHECKS_NOT_INSPECTED',location:'hostCommands'});
  else for(const command of hostCommands)if(command.available!==true||typeof command.name!=='string'||!command.name.trim()||!Array.isArray(command.argv)||!command.argv.length||command.argv.some(a=>typeof a!=='string'||a.includes('\0'))||typeof command.cwd!=='string'||command.cwd!==request?.cwd)
    issues.push({code:'HOST_CHECK_UNAVAILABLE',location:'hostCommands',checkName:command.name??null});
  return {ok:issues.length===0,readOnly:true,modelCalls:0,issues,packetCheck,preflight:runtimePreflight(request?.task),
    reviewBudget,checkCoverage:inspectCheckCoverage(writes,request?.task?.verify?.commands??[],coverageFacts),sandboxChecks:{available:checkAvailability.available===true,reason:checkAvailability.reason??null,advisory:true,hostVerificationRequired:true}};
}

export function timingBreakdown({events=[],intervals=[]}) {
  const byName=new Map(events.map(e=>[e.name,e]));
  return intervals.map(({name,from,to,kind})=>{
    const a=byName.get(from),b=byName.get(to);
    let elapsedMs=null,reason='missing-event';
    if(a&&b) {
      const local=typeof a.clockId==='string'&&a.clockId===b.clockId&&Number.isFinite(a.offsetMs)&&Number.isFinite(b.offsetMs);
      const start=local?a.offsetMs:Date.parse(a.at),end=local?b.offsetMs:Date.parse(b.at);
      if(Number.isFinite(start)&&Number.isFinite(end)&&end>=start){elapsedMs=end-start;reason=null;}else reason='invalid-or-reversed-time';
    }
    return {name,kind,elapsedMs,unavailableReason:reason};
  });
}

export function createHostHandoffSession({maxEntries=16,maxBytes=8*1024*1024,idleTtlMs=15*60*1000,now=()=>performance.now()}={}) {
  if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>64||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024)fail('Invalid session cache bounds');
  if(!Number.isSafeInteger(idleTtlMs)||idleTtlMs<1||typeof now!=='function')fail('Invalid session idle TTL or clock');
  const cache=new Map();let bytes=0,closed=false,lastNow=-Infinity;
  const evictions={expired:0,lru:0,released:0,cleared:0};
  const remove=(key,reason)=>{const entry=cache.get(key);if(!entry)return;bytes-=entry.size;cache.delete(key);evictions[reason]=Math.min(Number.MAX_SAFE_INTEGER,evictions[reason]+1);};
  const time=()=>{const value=now();if(!Number.isFinite(value)||value<lastNow)fail('Invalid or reversed session clock');lastNow=value;return value;};
  const sweep=()=>{const at=time();for(const [key,entry]of cache)if(at-entry.lastAccess>=idleTtlMs)remove(key,'expired');return at;};
  return {
    prepare(input,options) {
      if(closed)fail('Session cache is closed');
      const start=performance.now(),identity=binding(input),key=digest({identity,options}),at=sweep();
      if(cache.has(key)) {const entry=cache.get(key);entry.lastAccess=at;cache.delete(key);cache.set(key,entry);return {...clone(entry.value),cacheHit:true,preparationMs:performance.now()-start};}
      const readiness=reviewReadiness(input,options);
      if(!readiness.ok)return {...readiness,cacheHit:false,preparationMs:performance.now()-start};
      const value={...readiness,summary:boundSummary(input,readiness.bundle,identity)},serialized=JSON.stringify(value),size=Buffer.byteLength(serialized);
      if(size<=maxBytes){while(cache.size>=maxEntries||bytes+size>maxBytes)remove(cache.keys().next().value,'lru');cache.set(key,{value:JSON.parse(serialized),size,lastAccess:at,requestId:identity.requestId});bytes+=size;}
      return {...clone(value),cacheHit:false,preparationMs:performance.now()-start};
    },
    sweep(){sweep();return cache.size;},
    release(requestId){if(typeof requestId!=='string'||!requestId.trim())fail('Invalid session requestId');const keys=[...cache].filter(([,e])=>e.requestId===requestId).map(([key])=>key);if(!keys.length)fail('Unknown session requestId');for(const key of keys)remove(key,'released');return keys.length;},
    clear(){for(const key of cache.keys())remove(key,'cleared');},
    close(){for(const key of cache.keys())remove(key,'cleared');closed=true;},
    get stats(){sweep();return {entries:cache.size,bytes,maxEntries,maxBytes,idleTtlMs,closed,evictions:{...evictions}};},
  };
}
