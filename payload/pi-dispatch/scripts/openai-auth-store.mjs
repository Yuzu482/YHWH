import {createHash,randomUUID} from 'node:crypto';
import {openSync,closeSync,readFileSync,writeFileSync,fsyncSync,renameSync,unlinkSync,mkdirSync,lstatSync,fchmodSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export const OPENAI_AUTH_POLICY=Object.freeze({renewBeforeMs:300000,lockWaitMs:35000,timeoutMs:30000,cooldownMs:300000});
const fail=code=>Object.assign(new Error(code),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
function load(path,optional=false){
  try {
    const stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw fail('PI_AUTH_INVALID');
    const value=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
    if(!value||typeof value!=='object'||Array.isArray(value))throw fail('PI_AUTH_INVALID');
    return value;
  }catch(error){if(optional&&error.code==='ENOENT')return null;throw fail(error.code==='ENOENT'?'PI_AUTH_MISSING':'PI_AUTH_INVALID');}
}
function validate(credential){
  if(!credential)throw fail('PI_AUTH_MISSING');
  if(credential.type!=='oauth'||typeof credential.access!=='string'||!credential.access.trim()||!Number.isFinite(credential.expires))throw fail('PI_AUTH_INVALID');
}

// Never replace a restrictive Windows DACL with the temp directory's inherited DACL.
// The temporary file is empty until permissions have been copied successfully.
export function atomicAuthWrite(path,value,{preserveAclFrom}={}){
  const temporary=path+'.'+randomUUID()+'.tmp';let fd;
  try {
    fd=openSync(temporary,'wx',0o600);
    if(preserveAclFrom){
      if(process.platform==='win32'){
        const command=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
        const aclEnv={...process.env};delete aclEnv.PSModulePath;delete aclEnv.PSModuleAnalysisCachePath;
        const outcome=spawnSync(command,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./preserve-auth-acl.ps1',import.meta.url)),'-Source',preserveAclFrom,'-Destination',temporary],{env:aclEnv,shell:false,windowsHide:true,stdio:'ignore',timeout:10000});
        if(outcome.error||outcome.status!==0)throw fail('PI_AUTH_RENEW_PERSIST_FAILED');
      }else fchmodSync(fd,lstatSync(preserveAclFrom).mode&0o777);
    }
    writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temporary,path);
    if(process.platform!=='win32'){const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
  } finally {if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
}

function refreshFailure(error){
  // Explicit rejection/rate limiting can be classified without replaying an
  // uncertain rotation. A server-side 5xx can occur after rotating the token.
  // Transport errors/timeouts can follow a successful rotation: never replay them.
  const message=String(error?.message||'');
  if(/token refresh failed \((400|401|403)\)/i.test(message)||/invalid_grant|refresh_token_(reused|expired|invalidated)/i.test(message))return 'PI_AUTH_RELOGIN_REQUIRED';
  if(/token refresh failed \(429\)/i.test(message))return 'PI_AUTH_RENEW_FAILED';
  return 'PI_AUTH_RENEW_UNCERTAIN';
}

export async function maintainOpenAIAuth({authPath,stateDir,refresh,withAuthLock,signal,minimumValidityMs=0,refreshNow=false,now=Date.now,policy=OPENAI_AUTH_POLICY,atomicWrite=atomicAuthWrite}){
  if(!Number.isFinite(minimumValidityMs)||minimumValidityMs<0||minimumValidityMs>1260000||typeof refreshNow!=='boolean')throw fail('PI_AUTH_VALIDITY_INVALID');
  const validityMs=Math.max(policy.renewBeforeMs,minimumValidityMs);
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  const lockPath=join(stateDir,'openai-auth-renew.lock'),statePath=join(stateDir,'openai-auth-renew.json');
  const owner=randomUUID(),deadline=Date.now()+policy.lockWaitMs;let fd;
  while(fd===undefined){
    if(signal?.aborted)throw fail('PI_AUTH_RENEW_CANCELLED');
    try{fd=openSync(lockPath,'wx',0o600);writeFileSync(fd,JSON.stringify({owner,pid:process.pid,createdAt:now()}));fsyncSync(fd);}
    catch(error){
      if(fd!==undefined){closeSync(fd);unlinkSync(lockPath);throw fail('PI_AUTH_LOCK_FAILED');}
      if(error.code!=='EEXIST')throw fail('PI_AUTH_LOCK_FAILED');
      if(Date.now()>=deadline)throw fail('PI_AUTH_RENEW_BUSY');
      await pause();
    }
  }
  try {
    return await withAuthLock(async checkLock=>{
      const assertLock=()=>{if(checkLock)checkLock();};
      const data=load(authPath),credential=data['openai-codex'];validate(credential);
      const fingerprint=digest(credential),state=load(statePath,true);
      if(state?.fingerprint===fingerprint){
        if(['pending','uncertain'].includes(state.status))throw fail('PI_AUTH_RENEW_UNCERTAIN');
        if(state.reloginRequired)throw fail('PI_AUTH_RELOGIN_REQUIRED');
        if(state.retryAt>now())throw fail('PI_AUTH_RENEW_COOLDOWN');
      }
      if(!refreshNow&&credential.expires>now()+validityMs)return {ok:true,status:'valid',expiresAt:credential.expires,minimumValidityMs:validityMs};
      if(typeof credential.refresh!=='string'||!credential.refresh.trim())throw fail('PI_AUTH_RELOGIN_REQUIRED');
      if(signal?.aborted)throw fail('PI_AUTH_RENEW_CANCELLED');
      assertLock();
      // Durable intent BEFORE the one potentially rotating network request.
      atomicWrite(statePath,{version:1,status:'pending',fingerprint,updatedAt:now()});
      let renewed;
      try {
        renewed=await refresh(structuredClone(credential),signal);
      }catch(error){
        const code=refreshFailure(error);
        atomicWrite(statePath,{version:1,status:code==='PI_AUTH_RENEW_UNCERTAIN'?'uncertain':'failed',fingerprint,code,reloginRequired:code==='PI_AUTH_RELOGIN_REQUIRED',retryAt:now()+policy.cooldownMs,updatedAt:now()});
        throw fail(code);
      }
      // Once rotation succeeds, persist even if the caller just cancelled. Do not
      // let a late abort discard the only usable refresh token.
      try {
        validate(renewed);
        if(typeof renewed.refresh!=='string'||!renewed.refresh.trim())throw fail('PI_AUTH_RENEW_PERSIST_FAILED');
        assertLock();
        const latest=load(authPath);
        if(digest(latest['openai-codex'])!==fingerprint)throw fail('PI_AUTH_RENEW_CONFLICT');
        atomicWrite(authPath,{...latest,'openai-codex':renewed},{preserveAclFrom:authPath});
        assertLock();
        if(digest(load(authPath)['openai-codex'])!==digest(renewed))throw fail('PI_AUTH_RENEW_PERSIST_FAILED');
        const sufficient=renewed.expires>now()+validityMs;
        atomicWrite(statePath,{version:1,status:sufficient?'renewed':'failed',fingerprint:digest(renewed),code:sufficient?null:'PI_AUTH_RENEW_TOO_SHORT',retryAt:sufficient?null:now()+policy.cooldownMs,updatedAt:now()});
        if(!sufficient)throw fail('PI_AUTH_RENEW_TOO_SHORT');
        return {ok:true,status:'renewed',expiresAt:renewed.expires,minimumValidityMs:validityMs,persisted:true};
      }catch(error){
        // The pending journal survives save/validation/crash failures. It prevents
        // another worker from reusing the original refresh credential.
        throw fail(['PI_AUTH_RENEW_TOO_SHORT','PI_AUTH_RENEW_CONFLICT'].includes(error.code)?error.code:'PI_AUTH_RENEW_PERSIST_FAILED');
      }
    },signal);
  } finally {
    closeSync(fd);
    if(load(lockPath,true)?.owner===owner)unlinkSync(lockPath);
  }
}
