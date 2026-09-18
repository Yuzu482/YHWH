import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {maintainOpenAIAuth,OPENAI_AUTH_POLICY} from './openai-auth-store.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const safeCode=code=>/^PI_AUTH_[A-Z_]+$/.test(code||'')?code:'PI_AUTH_RENEW_FAILED';
export function openAIAuthEnvironment(env=process.env){
  const result={};
  for(const key of ['SystemRoot','WINDIR','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PATH','Path','TEMP','TMP','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'])if(env[key])result[key]=env[key];
  return result;
}
export async function loadOpenAIAuthSdk(piEntry){
  if(!isAbsolute(piEntry)||!existsSync(piEntry))throw fail('PI_AUTH_CLI_UNAVAILABLE');
  const require=createRequire(piEntry);let lockfile;
  try{lockfile=require('proper-lockfile');}catch{throw fail('PI_AUTH_CLI_UNAVAILABLE');}
  let directory=dirname(piEntry),oauthFile;
  while(true){
    const candidate=join(directory,'node_modules','@earendil-works','pi-ai','dist','auth','oauth','openai-codex.js');
    if(existsSync(candidate)){oauthFile=candidate;break;}
    const parent=dirname(directory);if(parent===directory)break;directory=parent;
  }
  if(!oauthFile)throw fail('PI_AUTH_CLI_UNAVAILABLE');
  const {openaiCodexOAuth}=await import(pathToFileURL(oauthFile).href);
  if(typeof openaiCodexOAuth?.refresh!=='function')throw fail('PI_AUTH_CLI_UNAVAILABLE');
  return {lockfile,refresh:openaiCodexOAuth.refresh};
}
export function piCompatibleAuthLock(lockfile,authPath){
  return async (work,signal)=>{
    let release,compromised=false;
    const deadline=Date.now()+OPENAI_AUTH_POLICY.lockWaitMs;
    while(!release){
      if(signal?.aborted)throw fail('PI_AUTH_RENEW_CANCELLED');
      try{release=await lockfile.lock(authPath,{realpath:false,retries:0,stale:30000,update:2000,onCompromised:()=>{compromised=true;}});}
      catch(error){if(error.code!=='ELOCKED')throw fail('PI_AUTH_LOCK_FAILED');if(Date.now()>=deadline)throw fail('PI_AUTH_RENEW_BUSY');await new Promise(r=>setTimeout(r,100));}
    }
    try{return await work(()=>{if(compromised)throw fail('PI_AUTH_LOCK_FAILED');});}
    finally{await release().catch(()=>{});}
  };
}

// Isolate SDK diagnostics and bound a stuck OAuth request without a shell/window.
// Inputs contain paths and budgets only. Credentials never travel over stdout/IPC.
export function ensureOpenAIAuth({piEntry,env=process.env,signal,minimumValidityMs=0,refreshNow=false,helperTimeoutMs=105000}={}){
  if(signal?.aborted)return Promise.reject(fail('PI_AUTH_RENEW_CANCELLED'));
  if(!env.USERPROFILE||!isAbsolute(env.USERPROFILE))return Promise.reject(fail('PI_AUTH_HOME_INVALID'));
  return new Promise((resolve,reject)=>{
    let output='',failure,timer,killTimer;
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',piEntry,env.USERPROFILE,String(minimumValidityMs),refreshNow?'--refresh-once':'--check'],{cwd:env.USERPROFILE,env:openAIAuthEnvironment(env),shell:false,windowsHide:true,stdio:['ignore','pipe','ignore','ipc']});
    const stop=code=>{if(failure)return;failure=code;try{if(child.connected)child.send({cancel:true},()=>{});}catch{}killTimer=setTimeout(()=>child.kill('SIGKILL'),15000);};
    const abort=()=>stop('PI_AUTH_RENEW_CANCELLED');
    child.stdout.on('data',chunk=>{if(output.length+chunk.length>4096)stop('PI_AUTH_RENEW_FAILED');else output+=chunk;});
    child.on('error',()=>{failure='PI_AUTH_CLI_UNAVAILABLE';});
    child.on('close',code=>{
      clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      if(failure)return reject(fail(failure));
      try{
        const result=JSON.parse(output);
        if(code!==0||!result.ok)throw fail(safeCode(result.code));
        if(!['valid','renewed'].includes(result.status)||!Number.isFinite(result.expiresAt)||!Number.isFinite(result.minimumValidityMs))throw fail('PI_AUTH_RENEW_FAILED');
        resolve({ok:true,status:result.status,expiresAt:result.expiresAt,minimumValidityMs:result.minimumValidityMs,persisted:result.persisted===true});
      }catch(error){reject(fail(safeCode(error.code)));}
    });
    timer=setTimeout(()=>stop('PI_AUTH_RENEW_TIMEOUT'),helperTimeoutMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const controller=new AbortController();
  process.on('message',message=>{if(message?.cancel===true)controller.abort();});
  // Some SDK versions log response bodies. Suppress all console diagnostics here.
  for(const key of ['log','error','warn','info','debug'])console[key]=()=>{};
  try{
    const [, ,mode,piEntry,home,minimum,operation]=process.argv;
    if(mode!=='--worker'||!isAbsolute(home)||!['--check','--refresh-once'].includes(operation))throw fail('PI_AUTH_HOME_INVALID');
    const {lockfile,refresh}=await loadOpenAIAuthSdk(piEntry);
    const authPath=join(home,'.pi','agent','auth.json');
    const result=await maintainOpenAIAuth({authPath,stateDir:join(home,'.local','state','pi-kether'),minimumValidityMs:Number(minimum),refreshNow:operation==='--refresh-once',signal:controller.signal,withAuthLock:piCompatibleAuthLock(lockfile,authPath),refresh:(credential,signal)=>refresh(credential,AbortSignal.any([signal,AbortSignal.timeout(OPENAI_AUTH_POLICY.timeoutMs)]))});
    process.stdout.write(JSON.stringify(result));
  }catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error.code)}));process.exitCode=4;}
  finally{if(process.connected)process.disconnect();}
}
