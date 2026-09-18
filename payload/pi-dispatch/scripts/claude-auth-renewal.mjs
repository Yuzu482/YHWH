import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,openSync,closeSync,readFileSync,writeFileSync,unlinkSync,renameSync} from 'node:fs';
import {dirname,delimiter,join,isAbsolute} from 'node:path';

export const AUTH_RENEWAL_POLICY=Object.freeze({renewBeforeMs:5*60_000,timeoutMs:30_000,lockWaitMs:35_000,cooldownMs:5*60_000});
const fail=code=>Object.assign(new Error(code),{code});
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
function load(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}}
function atomic(path,data){const temp=path+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,JSON.stringify(data),{mode:0o600});renameSync(temp,path);}finally{try{unlinkSync(temp);}catch{}}}

export function findClaudeAuthCli(env=process.env){
  const candidates=[env.PI_CLAUDE_AUTH_CLI,join(env.USERPROFILE||'', '.pi','agent','npm','node_modules','@anthropic-ai','claude-code','bin','claude.exe'),join(env.USERPROFILE||'', '.local','bin','claude.exe')];
  for(const base of [dirname(process.execPath),...(env.PATH||env.Path||'').split(delimiter)])if(base)candidates.push(join(base,'node_modules','@anthropic-ai','claude-code','bin','claude.exe'));
  const path=candidates.find(path=>path&&isAbsolute(path)&&/claude\.exe$/i.test(path)&&existsSync(path));
  if(!path)throw fail('PI_AUTH_CLI_UNAVAILABLE');
  return path;
}

export function renewalEnvironment(env,credential,configDir){
  const result={};
  for(const name of ['SystemRoot','WINDIR','COMSPEC','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PATH','Path','TEMP','TMP','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'])if(env[name])result[name]=env[name];
  return {...result,CLAUDE_CONFIG_DIR:configDir,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_OAUTH_REFRESH_TOKEN:credential.refreshToken,CLAUDE_CODE_OAUTH_SCOPES:credential.scopes.join(' ')};
}

export function runClaudeLogin({executable,env,cwd,signal,timeoutMs=AUTH_RENEWAL_POLICY.timeoutMs}){
  if(signal?.aborted)return Promise.resolve({ok:false,code:'PI_AUTH_RENEW_CANCELLED'});
  return new Promise(resolveRun=>{
    let child,output='',failure,timer;
    const stop=code=>{if(failure)return;failure=code;child?.kill('SIGKILL');};
    const abort=()=>stop('PI_AUTH_RENEW_CANCELLED');
    try{child=spawn(executable,['auth','login','--claudeai'],{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch{return resolveRun({ok:false,code:'PI_AUTH_CLI_UNAVAILABLE'});}
    const collect=chunk=>{if(output.length<16384)output+=chunk.toString().slice(0,16384-output.length);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',()=>{failure='PI_AUTH_CLI_UNAVAILABLE';});
    child.on('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      const rejected=/invalid_grant|refresh token.{0,40}(invalid|expired|revoked)|\b401\b|\b403\b/i.test(output);
      resolveRun({ok:!failure&&code===0,code:failure??(code===0?null:rejected?'PI_AUTH_RELOGIN_REQUIRED':'PI_AUTH_RENEW_FAILED')});
    });
    timer=setTimeout(()=>stop('PI_AUTH_RENEW_TIMEOUT'),timeoutMs);timer.unref?.();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}

export async function ensureClaudeAuth({env=process.env,signal,runLogin=runClaudeLogin,now=Date.now,policy=AUTH_RENEWAL_POLICY,minimumValidityMs=0}={}){
  if(!Number.isFinite(minimumValidityMs)||minimumValidityMs<0||minimumValidityMs>960000)throw fail('PI_AUTH_VALIDITY_INVALID');
  const validityMs=Math.max(policy.renewBeforeMs,minimumValidityMs);
  if(!env.USERPROFILE||!isAbsolute(env.USERPROFILE))throw fail('PI_AUTH_HOME_INVALID');
  const configDir=join(env.USERPROFILE,'.claude'),credentialPath=join(configDir,'.credentials.json');
  const stateDir=join(env.USERPROFILE,'.local','state','pi-kether');
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  const lockPath=join(stateDir,'claude-auth-renew.lock'),statePath=join(stateDir,'claude-auth-renew.json');
  const deadline=Date.now()+policy.lockWaitMs,owner=randomUUID();let fd;
  while(fd===undefined){
    if(signal?.aborted)throw fail('PI_AUTH_RENEW_CANCELLED');
    try{fd=openSync(lockPath,'wx',0o600);writeFileSync(fd,JSON.stringify({owner,pid:process.pid,createdAt:now()}));}
    catch(error){
      if(fd!==undefined){closeSync(fd);unlinkSync(lockPath);throw fail('PI_AUTH_LOCK_FAILED');}
      if(error.code!=='EEXIST')throw fail('PI_AUTH_LOCK_FAILED');
      if(Date.now()>=deadline)throw fail('PI_AUTH_RENEW_BUSY');
      await pause();
    }
  }
  try{
    // Re-read under the lock: another request or the user's CLI may have renewed.
    const credential=load(credentialPath)?.claudeAiOauth;
    if(!credential?.accessToken||!Number.isFinite(credential.expiresAt))throw fail('PI_AUTH_MISSING');
    if(credential.expiresAt>now()+validityMs)return {ok:true,status:'valid',expiresAt:credential.expiresAt,minimumValidityMs:validityMs};
    const fingerprint=createHash('sha256').update(JSON.stringify(credential)).digest('hex');
    const state=load(statePath);
    if(state?.fingerprint===fingerprint&&(state.reloginRequired||state.retryAt>now()))throw fail(state.reloginRequired?'PI_AUTH_RELOGIN_REQUIRED':'PI_AUTH_RENEW_COOLDOWN');
    if(typeof credential.refreshToken!=='string'||!credential.refreshToken||!Array.isArray(credential.scopes)||!credential.scopes.length||!credential.scopes.every(scope=>typeof scope==='string'&&/^[a-z0-9_:.-]+$/i.test(scope)))throw fail('PI_AUTH_RELOGIN_REQUIRED');
    const executable=findClaudeAuthCli(env);
    const outcome=await runLogin({executable,env:renewalEnvironment(env,credential,configDir),cwd:configDir,signal,timeoutMs:policy.timeoutMs});
    const current=load(credentialPath)?.claudeAiOauth;
    if(current?.accessToken&&Number.isFinite(current.expiresAt)&&current.expiresAt>now()+validityMs){
      atomic(statePath,{status:'renewed',updatedAt:now()});
      return {ok:true,status:'renewed',expiresAt:current.expiresAt,minimumValidityMs:validityMs};
    }
    const code=outcome.code??'PI_AUTH_RENEW_NOT_PERSISTED';
    atomic(statePath,{status:'failed',fingerprint,retryAt:now()+policy.cooldownMs,reloginRequired:code==='PI_AUTH_RELOGIN_REQUIRED',code,updatedAt:now()});
    throw fail(code);
  }finally{
    closeSync(fd);
    if(load(lockPath)?.owner===owner)unlinkSync(lockPath);
  }
}
