import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve, isAbsolute} from 'node:path';
import {redactSensitiveText} from './audit-log.js';
import {MilestoneLedgerError,describeMilestone} from './milestone-identity.js';
export {MilestoneLedgerError,describeMilestone,validateMilestone,validateMilestonePlan,validatePreviousFailure} from './milestone-identity.js';

const VERSION=1, MAX_MILESTONES=1024, MAX_ATTEMPTS=4096, MAX_DIAGNOSES=4096, MAX_BYTES=4*1024*1024;
const HEX=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, MILESTONE_ID=/^[a-z][a-z0-9-]{0,63}$/;
const RECOVERY=Object.freeze({originalRequestId:'card-lab-evidence-adjudication-gateway-normalization-repair-20261013',requestDigest:'e2a9a15835c8657ada5789173787388fa4fa9f6849b97b53fe4b204401187127',definitionSha256:'9659bec5306acee57468cfd4b011d996f2af0d8a88e068621dbf7ec3c684d92c',milestoneKey:'9d99b1e2f2bd78b35f0333f04a4cf7bd29ca71def0df2d45185b5b8ddb5777c7',originalInstanceId:'2aa7c299-bd0e-4c2b-bf55-79d3d138bb8a',parentRunId:'card-lab-evidence-adjudication-gateway-20261013',successorRequestId:'card-lab-evidence-adjudication-gateway-normalization-restored-20261013',authorizationSha256:'2ff292613a0f5df0af1f5e967b5aec3b6997e6d5a5b1f3878815406f4ed926ad',policySha256:'51830bddf32b06a592b95ab6c032f99e9b919cd90f8f215d05152e2b80601352',testsSha256:'b50b83bb66316988bc0f534701d275c08534a6ba5930155a027409ce4bd71b4d',snapshotSha256:'26cffe4795cf91fb4ca6730b9491f39e7988e05dfa5609d77dedff9cd78e36df',startedFileSha256:'e984aac943af7fb77099d9961c19bdcdb7c18e4be3d9f7b60197fab37da657c7',prefixCanonicalSha256:'19cc401266c5eba234c571aa3272fc95b0068f322f3cb7ebe3da6b2d0542ccdd'});
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const clone=v=>JSON.parse(JSON.stringify(v));
const RECOVERY_WORKSPACE='e:\\projects\\deepseekharness\\github-publish\\pi-kether-workflow';
const CLOSURE_KEYS=['requestId','successorRequestId','requestDigest','definitionSha256','milestoneKey','originalInstanceId','authorizationSha256','executionUnknown','operatorEvidenceSha256','prefixSha256','proofPaths','requestRoot','createdAt'];
const PROOF_KEYS=['workspace','authorizationFile','snapshotFile','operatorEvidenceFile'];
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const absolutePath=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0')&&isAbsolute(value);
function recoveryCore(s){const m=s.milestones.find(x=>x.key===RECOVERY.milestoneKey);return {key:m?.key,identity:m?.identity,definitionSha256:m?.definitionSha256,ordinal:m?.ordinal,attempts:s.attempts.filter(x=>x.milestoneKey===RECOVERY.milestoneKey).sort((a,b)=>a.ordinal-b.ordinal).slice(0,3)};}
function validClosure(c){return exactKeys(c,CLOSURE_KEYS)&&c.requestId===RECOVERY.originalRequestId&&c.successorRequestId===RECOVERY.successorRequestId&&c.requestDigest===RECOVERY.requestDigest&&c.definitionSha256===RECOVERY.definitionSha256&&c.milestoneKey===RECOVERY.milestoneKey&&c.originalInstanceId===RECOVERY.originalInstanceId&&c.authorizationSha256===RECOVERY.authorizationSha256&&c.executionUnknown===true&&HEX.test(c.operatorEvidenceSha256??'')&&c.prefixSha256===RECOVERY.prefixCanonicalSha256&&Number.isSafeInteger(c.createdAt)&&c.createdAt>=0&&absolutePath(c.requestRoot)&&exactKeys(c.proofPaths,PROOF_KEYS)&&PROOF_KEYS.every(k=>absolutePath(c.proofPaths[k]))&&c.proofPaths.workspace===RECOVERY_WORKSPACE;}
function err(code,message=code){throw new MilestoneLedgerError(code,message);}
function safeText(v,max,code){if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))err(code);return v;}
const digestText=v=>createHash('sha256').update(v,'utf8').digest('hex');
function canonicalWorkspace(path){let p;try{p=realpathSync(path);}catch{err('PI_MILESTONE_INVALID','workspace must resolve to an existing directory');}return process.platform==='win32'?p.toLowerCase():p;}
function validateState(s){
  if(!s||s.version!==VERSION||!Array.isArray(s.milestones)||!Array.isArray(s.attempts)||!Array.isArray(s.diagnoses)||!s.requests||typeof s.requests!=='object'||Array.isArray(s.requests)||!Number.isSafeInteger(s.nextOrdinal)||s.nextOrdinal<1)err('PI_MILESTONE_STORAGE_FAILED','invalid milestone ledger structure');
  if(s.milestones.length>MAX_MILESTONES||s.attempts.length>MAX_ATTEMPTS||s.diagnoses.length>MAX_DIAGNOSES||Object.keys(s.requests).length>MAX_ATTEMPTS)err('PI_MILESTONE_CAPACITY_EXCEEDED');
  const mids=new Set(), reqs=new Set();
  for(const m of s.milestones){if(!m||typeof m.key!=='string'||!HEX.test(m.key)||!m.identity||!HEX.test(m.definitionSha256)||!Number.isSafeInteger(m.ordinal)||m.ordinal<1||mids.has(m.key)||!Array.isArray(m.attempts))err('PI_MILESTONE_STORAGE_FAILED');mids.add(m.key);}
  for(const a of s.attempts){if(!a||!ID.test(a.requestId)||!mids.has(a.milestoneKey)||!Number.isSafeInteger(a.ordinal)||a.ordinal<1||!['reserved','started','applying','failed','passed','awaiting-artifact','applied','verified-not-accepted','superseded','abandoned','accepted','in_doubt'].includes(a.status)||!Array.isArray(a.evidence))err('PI_MILESTONE_STORAGE_FAILED');if(reqs.has(a.requestId))err('PI_MILESTONE_STORAGE_FAILED');reqs.add(a.requestId);}
  for(const m of s.milestones)for(const id of m.attempts)if(!reqs.has(id)||s.attempts.find(a=>a.requestId===id)?.milestoneKey!==m.key)err('PI_MILESTONE_STORAGE_FAILED');
  for(const [id,ref] of Object.entries(s.requests))if(!ID.test(id)||!ref||!Number.isSafeInteger(ref.ordinal)||!mids.has(ref.milestoneKey)||!reqs.has(id)||s.attempts.find(a=>a.requestId===id)?.ordinal!==ref.ordinal)err('PI_MILESTONE_STORAGE_FAILED');
  if(reqs.size!==Object.keys(s.requests).length)err('PI_MILESTONE_STORAGE_FAILED');
  for(const d of s.diagnoses)if(!d||!mids.has(d.milestoneKey)||!Array.isArray(d.failureIds)||d.failureIds.length!==2||d.failureIds.some(id=>!reqs.has(id)))err('PI_MILESTONE_STORAGE_FAILED');
  if(s.legacyClosures!==undefined&&(!Array.isArray(s.legacyClosures)||s.legacyClosures.length>MAX_ATTEMPTS||s.legacyClosures.some(c=>!ID.test(c.requestId??'')||!HEX.test(c.artifactSha256??'')||c.status!=='abandoned'||typeof c.reason!=='string'||c.reason.length>1000)||new Set(s.legacyClosures.map(c=>c.requestId)).size!==s.legacyClosures.length))err('PI_MILESTONE_STORAGE_FAILED');
  if(s.operatorInterruptedClosures!==undefined){const cs=s.operatorInterruptedClosures;if(!Array.isArray(cs)||cs.length>1||cs.some(c=>!validClosure(c))||(cs.length&&hash(recoveryCore(s))!==RECOVERY.prefixCanonicalSha256))err('PI_MILESTONE_STORAGE_FAILED');}
  return s;
}

export function createMilestoneLedger(directory,{now=Date.now,instanceId=randomUUID()}={}){
  if(typeof directory!=='string'||!directory.trim()||typeof now!=='function')err('PI_MILESTONE_INVALID');
  const root=resolve(directory);try{mkdirSync(root,{recursive:true,mode:0o700});}catch(e){err('PI_MILESTONE_STORAGE_FAILED',`milestone ledger directory unavailable: ${e.message}`);}const file=join(root,'milestones.json'),lock=join(root,'milestones.lock');
  const clock=()=>{const n=now();if(typeof n!=='number'||!Number.isFinite(n)||n<0)err('PI_MILESTONE_INVALID','clock must return a finite nonnegative number');return n;};
  function readState(){let s={version:VERSION,nextOrdinal:1,milestones:[],attempts:[],diagnoses:[],requests:Object.create(null)};if(!existsSync(file))return s;try{const raw=readFileSync(file,'utf8');if(Buffer.byteLength(raw)>MAX_BYTES)err('PI_MILESTONE_CAPACITY_EXCEEDED');const parsed=JSON.parse(raw);const{integrity,...body}=parsed;if(!HEX.test(integrity??'')||hash(body)!==integrity)err('PI_MILESTONE_STORAGE_FAILED','milestone ledger integrity failure');validateState(body);if(body.operatorInterruptedClosures?.some(c=>c.requestRoot!==resolve(root,'..')))err('PI_MILESTONE_STORAGE_FAILED');return body;}catch(e){if(e.code)throw e;err('PI_MILESTONE_STORAGE_FAILED','milestone ledger is unreadable');}}
  function transact(fn){try{writeFileSync(lock,`${process.pid}:${instanceId}\n`,{flag:'wx',mode:0o600});}catch(e){err(e.code==='EEXIST'?'PI_MILESTONE_RECONCILIATION_NEEDED':'PI_MILESTONE_STORAGE_FAILED','milestone ledger lock unavailable');}
    let persisted=false;try{const state=readState(), result=fn(state);validateState(state);const{integrity:_old,...body}=state;const text=JSON.stringify({...body,integrity:hash(body)})+'\n';if(Buffer.byteLength(text)>MAX_BYTES)err('PI_MILESTONE_CAPACITY_EXCEEDED');const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;try{writeFileSync(temp,text,{flag:'wx',mode:0o600});renameSync(temp,file);persisted=true;}catch(e){try{unlinkSync(temp);}catch{}err('PI_MILESTONE_STORAGE_FAILED',`milestone ledger write failed: ${e.message}`);}return clone(result);
    }catch(e){if(e.code)throw e;err('PI_MILESTONE_STORAGE_FAILED',e.message);}finally{try{unlinkSync(lock);}catch(e){if(persisted)err('PI_MILESTONE_STORAGE_FAILED',`milestone ledger lock release failed: ${e.message}`);}}
  }
  function attempt(s,id){if(!ID.test(id??''))err('PI_MILESTONE_INVALID');const a=s.attempts.find(x=>x.requestId===id);if(!a)err('PI_MILESTONE_NOT_FOUND');return a;}
  function verifyRecoveryProof(s,p,{fresh=false}={}){
    if(instanceId===RECOVERY.originalInstanceId||!exactKeys(p,PROOF_KEYS)||!PROOF_KEYS.every(k=>absolutePath(p[k])))err('PI_MILESTONE_RECOVERY_PROOF_INVALID');
    const requestRoot=resolve(root,'..'),dir=join(requestRoot,digestText(RECOVERY.originalRequestId)),started=join(dir,'started.json');
    const m=s.milestones.find(x=>x.key===RECOVERY.milestoneKey),a=s.attempts.find(x=>x.requestId===RECOVERY.originalRequestId);
    if(hash(recoveryCore(s))!==RECOVERY.prefixCanonicalSha256||!m||m.definitionSha256!==RECOVERY.definitionSha256||m.identity.parentRunId!==RECOVERY.parentRunId||m.identity.workspace!==RECOVERY_WORKSPACE||!a||a.requestId!==m.attempts[2]||a.ordinal!==3||a.status!=='started'||a.instanceId!==RECOVERY.originalInstanceId||a.artifactSha256!==undefined||a.hostOutcome!==undefined||a.applyInstanceId!==undefined||(a.supersedeIntents??[]).length||fresh&&m.attempts.length!==3||existsSync(join(dir,'final.json')))err('PI_MILESTONE_RECOVERY_PROOF_INVALID');
    const workspace=canonicalWorkspace(p.workspace);
    if(workspace!==RECOVERY_WORKSPACE||digestText(readFileSync(started))!==RECOVERY.startedFileSha256||digestText(readFileSync(p.authorizationFile))!==RECOVERY.authorizationSha256||digestText(readFileSync(p.snapshotFile))!==RECOVERY.snapshotSha256)err('PI_MILESTONE_RECOVERY_PROOF_INVALID');
    const operatorBytes=readFileSync(p.operatorEvidenceFile);
    if(operatorBytes.length>4096)err('PI_MILESTONE_RECOVERY_PROOF_INVALID');
    const operatorText=operatorBytes.toString('utf8');if(!Buffer.from(operatorText,'utf8').equals(operatorBytes))err('PI_MILESTONE_RECOVERY_PROOF_INVALID');
    let op;try{op=JSON.parse(operatorText);}catch{err('PI_MILESTONE_RECOVERY_PROOF_INVALID');}
    if(!exactKeys(op,['requestId','authorizationSha256','executionUnknown','oldProcessInactive','assertion'])||op.requestId!==RECOVERY.originalRequestId||op.authorizationSha256!==RECOVERY.authorizationSha256||op.executionUnknown!==true||op.oldProcessInactive!==true||typeof op.assertion!=='string'||!op.assertion.trim()||op.assertion.length>2000||op.assertion.includes('\0')||/success|failed|failure|zero[ -]?start|not[ -]?started|terminal|completed|no[ -]?execution|未执行|未启动|成功|失败|完成|终态|api[_ -]?key|bearer|password|token\s*[:=]|sk-[a-z0-9]/i.test(op.assertion))err('PI_MILESTONE_RECOVERY_PROOF_INVALID');
    if(digestText(readFileSync(join(workspace,'payload/pi-dispatch/scripts/tier-review-policy.mjs')))!==RECOVERY.policySha256||digestText(readFileSync(join(workspace,'payload/pi-dispatch/tests/review-quota-adjudication.test.mjs')))!==RECOVERY.testsSha256)err('PI_MILESTONE_RECOVERY_PROOF_INVALID');
    return {requestRoot,operatorSha256:digestText(operatorBytes),proofPaths:{workspace,...Object.fromEntries(PROOF_KEYS.slice(1).map(k=>[k,resolve(p[k])]))}};
  }
  function reserve(input){return transact(s=>{
    if(!input||!ID.test(input.requestId??''))err('PI_MILESTONE_INVALID');
    const {identity,scopeSha256,definitionSha256,key}=describeMilestone(input);
    const closure=s.operatorInterruptedClosures?.[0];
    const recovering=input.requestId===RECOVERY.successorRequestId&&!Object.hasOwn(s.requests,input.requestId)&&key===RECOVERY.milestoneKey&&definitionSha256===RECOVERY.definitionSha256&&identity.parentRunId===RECOVERY.parentRunId&&identity.workspace===RECOVERY_WORKSPACE&&closure!==undefined;
    if(recovering){const proof=verifyRecoveryProof(s,closure.proofPaths,{fresh:true});if(proof.requestRoot!==closure.requestRoot||proof.operatorSha256!==closure.operatorEvidenceSha256)err('PI_MILESTONE_RECOVERY_PROOF_INVALID');}
    if(Object.hasOwn(s.requests,input.requestId)){const old=s.attempts.find(a=>a.requestId===input.requestId);if(s.requests[input.requestId].milestoneKey!==key||old.definitionSha256!==definitionSha256)err('PI_MILESTONE_CONFLICT');return old;}
    let m=s.milestones.find(x=>x.key===key);if(m&&m.definitionSha256!==definitionSha256)err('PI_MILESTONE_CONFLICT');if(!m){if(s.milestones.length>=MAX_MILESTONES)err('PI_MILESTONE_CAPACITY_EXCEEDED');m={key,identity,definitionSha256,ordinal:s.nextOrdinal++,attempts:[]};s.milestones.push(m);}
    const attempts=m.attempts.map(id=>s.attempts.find(a=>a.requestId===id));
    if(attempts.some(a=>a.status==='in_doubt'||(['reserved','started','applying'].includes(a.status)&&a.instanceId!==instanceId&&!(recovering&&a.requestId===RECOVERY.originalRequestId&&a.status==='started'&&a.instanceId===RECOVERY.originalInstanceId))))err('PI_MILESTONE_RECONCILIATION_NEEDED');if(attempts.some(a=>['reserved','started'].includes(a.status)&&!(recovering&&a.requestId===RECOVERY.originalRequestId&&a.status==='started'&&a.instanceId===RECOVERY.originalInstanceId)))err('PI_MILESTONE_BUSY');if(attempts.some(a=>['applying','applied','verified-not-accepted'].includes(a.status)))err('PI_MILESTONE_CLOSURE_PENDING');
    const latestPair=attempts.filter(a=>a.strike===true&&a.ordinal>(m.resetOrdinal??0)).sort((a,b)=>a.ordinal-b.ordinal).slice(-2);
    let diagnosis;
    if(latestPair.length===2){diagnosis=s.diagnoses.find(x=>x.milestoneKey===key&&x.failureIds.join('|')===latestPair.map(a=>a.requestId).join('|')&&!x.consumed&&(!x.retryBasisRequestId||x.retryBasisRequestId===attempts.at(-1)?.requestId));if(!diagnosis||diagnosis.action==='escalate')err('PI_REPEATED_FAILURE_DIAGNOSIS_REQUIRED');}
    if(latestPair.length){
      const latest=latestPair.at(-1),evidence=latest.evidence.at(-1),pf=input.previousFailure;
      if(!pf||pf.requestId!==latest.requestId||pf.checkName!==evidence?.checkName||pf.outputSha256!==evidence?.outputSha256||pf.excerpt!==evidence?.excerpt)err('PI_MILESTONE_PREVIOUS_FAILURE_REQUIRED');
    }
    if(diagnosis){diagnosis.consumed=true;diagnosis.consumedByRequestId=input.requestId;}
    if(s.attempts.length>=MAX_ATTEMPTS)err('PI_MILESTONE_CAPACITY_EXCEEDED');const a={requestId:input.requestId,milestoneKey:key,definitionSha256,scopeSha256,ordinal:m.attempts.length+1,status:'reserved',instanceId,createdAt:clock(),strike:false,evidence:[],supersedeIntents:attempts.filter(x=>x.status==='awaiting-artifact').map(x=>x.requestId)};s.attempts.push(a);m.attempts.push(a.requestId);s.requests[a.requestId]={milestoneKey:key,ordinal:a.ordinal};return a;
  });}
  const mutate=(id,fn)=>transact(s=>fn(s,attempt(s,id)));
  function markUncertain(id){return mutate(id,(_s,a)=>{if(!['reserved','started','in_doubt'].includes(a.status))err('PI_MILESTONE_CONFLICT');a.status='in_doubt';return a;});}
  function markStarted(id){return mutate(id,(s,a)=>{if(a.status==='started')return a;if(a.status!=='reserved')err('PI_MILESTONE_CONFLICT');a.status='started';a.startedAt=clock();for(const oldId of a.supersedeIntents??[]){const old=attempt(s,oldId);if(old.status==='awaiting-artifact')old.status='superseded';}a.supersedeIntents=[];return a;});}
  function recordFailure(a,{checkName,output='',modelStarted=true}={}){const text=redactSensitiveText(String(output),{compact:false}),name=safeText(checkName||'dispatch',128,'PI_MILESTONE_INVALID'),sha=digestText(text);if(a.evidence.some(e=>e.checkName===name&&e.outputSha256===sha))return;a.evidence.push({checkName:name,excerpt:text.slice(0,4096),outputSha256:sha,at:clock()});a.strike=a.strike||modelStarted;}
  function failAttempt(id,opts={}){return mutate(id,(s,a)=>{if(!['started','reserved','failed'].includes(a.status))err('PI_MILESTONE_CONFLICT');if(a.status==='reserved'&&a.startedAt!==undefined)err('PI_MILESTONE_CONFLICT');if(opts.modelStarted===false&&a.startedAt!==undefined)err('PI_MILESTONE_CONFLICT');if(opts.modelStarted!==false&&a.startedAt===undefined)err('PI_MILESTONE_CONFLICT');recordFailure(a,opts);a.status='failed';return a;});}
  function verify(id,{passed,artifactSha256,checkName,output=''}={}){return mutate(id,(s,a)=>{
    if(typeof passed!=='boolean'||!HEX.test(artifactSha256??''))err('PI_MILESTONE_INVALID');
    if(a.artifactSha256&&a.artifactSha256!==artifactSha256)err('PI_MILESTONE_CONFLICT');
    if(a.hostOutcome!==undefined&&a.hostOutcome!==passed)err('PI_MILESTONE_CONFLICT');
    if(a.status==='verified-not-accepted'&&passed)return a;
    if(!['started','failed','awaiting-artifact','applied'].includes(a.status))err('PI_MILESTONE_CONFLICT');
    const m=s.milestones.find(m=>m.key===a.milestoneKey);
    if(s.attempts.some(other=>other.milestoneKey===a.milestoneKey&&other.ordinal>a.ordinal&&['reserved','started','in_doubt','applying'].includes(other.status)))err('PI_MILESTONE_RECONCILIATION_NEEDED');
    const latest=s.attempts.filter(x=>x.milestoneKey===a.milestoneKey&&x.startedAt!==undefined).at(-1);
    if(passed&&latest?.requestId!==id)err('PI_MILESTONE_STALE_PASS');
    a.artifactSha256=artifactSha256;a.hostOutcome=passed;
    if(!passed){recordFailure(a,{checkName:checkName||'host-check',output,modelStarted:true});a.status='failed';}
    else{a.status='verified-not-accepted';a.verifyPassed=true;m.resetOrdinal=a.ordinal;}
    return a;
  });}
  function diagnose({workspace,parentRunId,milestoneId,failures,rootCause,action,afterRequestId}){return transact(s=>{
    safeText(parentRunId,128,'PI_MILESTONE_INVALID');if(!MILESTONE_ID.test(milestoneId??''))err('PI_MILESTONE_INVALID');
    const ws=canonicalWorkspace(workspace),key=hash({workspace:ws,parentRunId,milestoneId}),m=s.milestones.find(x=>x.key===key);if(!m)err('PI_MILESTONE_NOT_FOUND');
    safeText(rootCause,4000,'PI_MILESTONE_INVALID');if(!['reduce-scope','split-milestone','host-exception','escalate'].includes(action)||!Array.isArray(failures)||failures.length!==2)err('PI_MILESTONE_INVALID');
    const ordered=m.attempts.map(id=>s.attempts.find(a=>a.requestId===id)),latest=ordered.filter(a=>a.strike&&a.ordinal>(m.resetOrdinal??0)).slice(-2);
    if(latest.length!==2||failures.some((f,i)=>!f||f.requestId!==latest[i].requestId||f.ordinal!==latest[i].ordinal||f.checkName!==latest[i].evidence.at(-1)?.checkName||f.outputSha256!==latest[i].evidence.at(-1)?.outputSha256))err('PI_MILESTONE_DIAGNOSIS_MISMATCH');
    const matching=s.diagnoses.filter(d=>d.milestoneKey===key&&d.failureIds.join('|')===latest.map(a=>a.requestId).join('|'));
    const old=matching.find(d=>d.retryBasisRequestId===afterRequestId);
    if(old){if(old.rootCause!==rootCause||old.action!==action)err('PI_MILESTONE_CONFLICT');return old;}
    if(afterRequestId!==undefined){
      if(!ID.test(afterRequestId??''))err('PI_MILESTONE_INVALID');
      const spent=matching.at(-1),zero=ordered.at(-1);
      if(spent?.consumed&&!spent.consumedByRequestId)err('PI_MILESTONE_RECONCILIATION_NEEDED','Historical consumed diagnosis requires operator escalation');
      if(!spent?.consumed||spent.consumedByRequestId!==afterRequestId||zero?.requestId!==afterRequestId||zero.status!=='failed'||zero.strike||zero.startedAt!==undefined||!zero.evidence.length)err('PI_MILESTONE_DIAGNOSIS_MISMATCH');
    }else if(matching.length)err('PI_MILESTONE_CONFLICT');
    if(s.diagnoses.length>=MAX_DIAGNOSES)err('PI_MILESTONE_CAPACITY_EXCEEDED');
    const d={milestoneKey:key,failureIds:latest.map(a=>a.requestId),rootCause,action,createdAt:clock(),consumed:false,...(afterRequestId?{retryBasisRequestId:afterRequestId}:{})};s.diagnoses.push(d);return d;
  });}
  function artifact(id,{artifactSha256,applied}={}){return mutate(id,(s,a)=>{if(!HEX.test(artifactSha256??'')||typeof applied!=='boolean')err('PI_MILESTONE_INVALID');if(a.artifactSha256&&a.artifactSha256!==artifactSha256)err('PI_MILESTONE_CONFLICT');if(a.status==='awaiting-artifact'||a.status==='applied'){if(a.artifactSha256===artifactSha256&&!applied)return a;err('PI_MILESTONE_CONFLICT');}if(a.status!=='started')err('PI_MILESTONE_CONFLICT');a.artifactSha256=artifactSha256;a.status=applied?'applied':'awaiting-artifact';return a;});}
  function markApplied(id,h){return mutate(id,(s,a)=>{if(!HEX.test(h??''))err('PI_MILESTONE_INVALID');if(a.status==='applied'&&a.artifactSha256===h)return a;if(a.status!=='awaiting-artifact'||a.artifactSha256!==h)err('PI_MILESTONE_CONFLICT');a.status='applied';return a;});}
  function beginApply(id,h){return mutate(id,(s,a)=>{if(a.status!=='awaiting-artifact'||a.artifactSha256!==h||!HEX.test(h??''))err('PI_MILESTONE_CLOSED');a.status='applying';a.applyInstanceId=instanceId;return a;});}
  function completeApply(id,h){return mutate(id,(s,a)=>{if(a.status!=='applying'||a.applyInstanceId!==instanceId||a.artifactSha256!==h)err('PI_MILESTONE_RECONCILIATION_NEEDED');a.status='applied';return a;});}
  function cancelApply(id,h){return mutate(id,(s,a)=>{if(a.status!=='applying'||a.applyInstanceId!==instanceId||a.artifactSha256!==h)err('PI_MILESTONE_RECONCILIATION_NEEDED');a.status='awaiting-artifact';return a;});}
  function assertOpen(id,h){const s=readState(),a=attempt(s,id);if(a.artifactSha256!==h||!HEX.test(h??'')||['superseded','abandoned','accepted','in_doubt','applying'].includes(a.status))err('PI_MILESTONE_CLOSED');const stale=Number.isFinite(a.createdAt)&&clock()-a.createdAt>=7200000;return {...clone(a),stale};}
  function assertVerifiable(id,h){const s=readState(),a=attempt(s,id);if(s.attempts.some(other=>other.milestoneKey===a.milestoneKey&&other.ordinal>a.ordinal&&['reserved','started','in_doubt','applying'].includes(other.status)))err('PI_MILESTONE_RECONCILIATION_NEEDED');return assertOpen(id,h);}
  function abandon(id,{artifactSha256,reason}={}){return mutate(id,(s,a)=>{safeText(reason,1000,'PI_MILESTONE_INVALID');if(!HEX.test(artifactSha256??'')||a.artifactSha256!==artifactSha256)err('PI_MILESTONE_CONFLICT');const clean=redactSensitiveText(reason,{compact:false}).slice(0,1000);if(a.status==='abandoned'){if(a.abandonReason===clean)return a;err('PI_MILESTONE_CONFLICT');}if(['accepted','superseded','applying','reserved','started','in_doubt'].includes(a.status))err('PI_MILESTONE_CLOSED');if(!a.artifactSha256)err('PI_MILESTONE_CONFLICT');a.status='abandoned';a.abandonReason=clean;return a;});}
  function accepted(id,h){return mutate(id,(s,a)=>{if(a.status==='accepted'&&a.artifactSha256===h)return a;if(a.status!=='verified-not-accepted'||a.artifactSha256!==h||a.verifyPassed!==true)err('PI_MILESTONE_NOT_VERIFIED');a.status='accepted';a.acceptedAt=clock();return a;});}
  function listOpen({limit=100,cursor}={}){if(!Number.isInteger(limit)||limit<1||limit>100)err('PI_MILESTONE_INVALID');if(existsSync(lock))err('PI_MILESTONE_RECONCILIATION_NEEDED');const s=readState(),t=clock();const open=s.attempts.filter(a=>!['accepted','abandoned','superseded'].includes(a.status)).sort((a,b)=>a.createdAt-b.createdAt||a.requestId.localeCompare(b.requestId)).map(a=>({...a,status:['reserved','started','applying'].includes(a.status)&&a.instanceId!==instanceId?'in_doubt':a.status,stale:!Number.isFinite(a.createdAt)||t<a.createdAt?null:t-a.createdAt>=7200000}));const snap=hash(open);let start=0;if(cursor){if(cursor.snapshotSha256!==snap||!HEX.test(cursor.snapshotSha256)||typeof cursor.lastKey!=='string')err('PI_MILESTONE_CURSOR_STALE');start=open.findIndex(a=>`${a.createdAt}:${a.requestId}`===cursor.lastKey)+1;if(!start)err('PI_MILESTONE_CURSOR_STALE');}const items=open.slice(start,start+limit),next=start+items.length<open.length?{snapshotSha256:snap,lastKey:`${items.at(-1).createdAt}:${items.at(-1).requestId}`} :null;return {items:clone(items),cursor:next,snapshotSha256:snap};}
  function get(id){const s=readState();if(!Object.hasOwn(s.requests,id))return null;const a=attempt(s,id),m=s.milestones.find(m=>m.key===a.milestoneKey);return clone({...a,identity:m.identity});}
  function reconcileFailure(id,{definitionSha256,resultSha256,modelStarted,output}={}){return mutate(id,(_s,a)=>{
    if(!HEX.test(resultSha256??'')||a.definitionSha256!==definitionSha256||typeof modelStarted!=='boolean')err('PI_MILESTONE_CONFLICT');
    if(a.reconciliationSha256===resultSha256&&a.status==='failed')return a;
    if(!['reserved','started','in_doubt'].includes(a.status))err('PI_MILESTONE_RECONCILIATION_NEEDED');
    if(!modelStarted&&a.startedAt!==undefined)err('PI_MILESTONE_CONFLICT');
    // A proven past start has unknown time; do not fabricate a start timestamp.
    if(modelStarted&&a.startedAt===undefined)a.startedAt=null;
    recordFailure(a,{checkName:'dispatch',output,modelStarted});a.status='failed';a.reconciliationSha256=resultSha256;return a;
  });}
  function getLegacyClosure(id){const state=readState();return clone(state.legacyClosures?.find(c=>c.requestId===id)??null);}
  function classifyRequests(ids){if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!ID.test(id??'')))err('PI_MILESTONE_INVALID');const state=readState();return {trackedIds:ids.filter(id=>Object.hasOwn(state.requests,id)),closedLegacyIds:ids.filter(id=>state.legacyClosures?.some(c=>c.requestId===id))};}
  function abandonLegacy({requestId,artifactSha256,reason}){return transact(s=>{
    if(!ID.test(requestId??'')||!HEX.test(artifactSha256??'')||Object.hasOwn(s.requests,requestId))err('PI_MILESTONE_INVALID');
    safeText(reason,1000,'PI_MILESTONE_INVALID');const clean=redactSensitiveText(reason,{compact:false});
    const closures=s.legacyClosures??=[],prior=closures.find(c=>c.requestId===requestId);
    if(prior){if(prior.artifactSha256!==artifactSha256||prior.reason!==clean)err('PI_MILESTONE_CONFLICT');return prior;}
    if(closures.length>=MAX_ATTEMPTS)err('PI_MILESTONE_CAPACITY_EXCEEDED');
    const record={requestId,artifactSha256,reason:clean,status:'abandoned',milestone:null,createdAt:clock()};closures.push(record);s.legacyClosures=closures;return record;
  });}
  function authorizeInterruptedRecovery(p){return transact(s=>{
    const old=s.operatorInterruptedClosures?.[0],proof=verifyRecoveryProof(s,p,{fresh:!old});
    if(old){if(old.operatorEvidenceSha256===proof.operatorSha256&&old.requestRoot===proof.requestRoot&&hash(old.proofPaths)===hash(proof.proofPaths))return old;err('PI_MILESTONE_CONFLICT');}
    const closure={requestId:RECOVERY.originalRequestId,successorRequestId:RECOVERY.successorRequestId,requestDigest:RECOVERY.requestDigest,definitionSha256:RECOVERY.definitionSha256,milestoneKey:RECOVERY.milestoneKey,originalInstanceId:RECOVERY.originalInstanceId,authorizationSha256:RECOVERY.authorizationSha256,executionUnknown:true,operatorEvidenceSha256:proof.operatorSha256,prefixSha256:hash(recoveryCore(s)),proofPaths:proof.proofPaths,requestRoot:proof.requestRoot,createdAt:clock()};
    s.operatorInterruptedClosures=[closure];return closure;
  });}
  return {reserve,markStarted,markUncertain,fail:failAttempt,verify,diagnose,registerArtifact:artifact,beginApply,completeApply,cancelApply,markApplied,assertOpen,assertVerifiable,abandon,accepted,listOpen,get,reconcileFailure,getLegacyClosure,abandonLegacy,classifyRequests,authorizeInterruptedRecovery};
}
