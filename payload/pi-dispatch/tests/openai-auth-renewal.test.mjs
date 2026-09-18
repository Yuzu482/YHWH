import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,readdirSync,mkdirSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {maintainOpenAIAuth,atomicAuthWrite} from '../scripts/openai-auth-store.mjs';
import {openAIAuthEnvironment,ensureOpenAIAuth,piCompatibleAuthLock} from '../scripts/openai-auth-renewal.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const fixtureCredential={type:'oauth',access:'fixture-access-original',refresh:'fixture-refresh-original',expires:10};
const renewed=()=>({...fixtureCredential,access:'fixture-access-new',refresh:'fixture-refresh-new',expires:Date.now()+86400000});
async function fixture(work){
  const root=mkdtempSync(join(tmpdir(),'pi-openai-persist-'));
  const authPath=join(root,'auth.json'),stateDir=join(root,'state');
  writeFileSync(authPath,JSON.stringify({'openai-codex':fixtureCredential,other:{type:'api_key',key:'fixture-unrelated'}}),{mode:0o600});
  const f={root,authPath,stateDir,withAuthLock:async work=>work(),refresh:async()=>renewed(),minimumValidityMs:360000};
  try{await work(f);}finally{rmSync(root,{recursive:true,force:true});}
}
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const expectCode=(promise,code)=>assert.rejects(promise,error=>error.code===code&&error.message===code);

test('rotated credentials persist atomically, preserve other providers and survive a fresh invocation',()=>fixture(async f=>{
  const result=await maintainOpenAIAuth(f);
  assert.equal(result.status,'renewed');assert.equal(result.persisted,true);
  assert.equal(read(f.authPath)['openai-codex'].refresh,'fixture-refresh-new');
  assert.equal(read(f.authPath).other.key,'fixture-unrelated');
  assert.equal((await maintainOpenAIAuth({...f,refresh:()=>assert.fail('must use persisted credentials')})).status,'valid');
  assert.ok(!JSON.stringify(result).includes('fixture-'));
  assert.deepEqual(readdirSync(f.root).filter(name=>name.endsWith('.tmp')),[]);
}));

test('four independent processes refresh once; a fifth process reuses persisted state',()=>fixture(async f=>{
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(here,'fixtures','openai-auth-process.mjs'),f.root],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.on('error',reject);
    child.on('close',code=>{try{assert.equal(code,0);resolve(JSON.parse(output));}catch(error){reject(error);}});
  });
  const results=await Promise.all(Array.from({length:4},run));
  assert.equal(results.filter(result=>result.status==='renewed').length,1);
  assert.equal(readFileSync(join(f.root,'refresh-calls.txt'),'utf8'),'refresh\n');
  assert.equal((await run()).status,'valid');
}));

test('timeout after possible rotation is latched across invocations; new login clears the fingerprint latch',()=>fixture(async f=>{
  let calls=0;const refresh=async()=>{calls++;throw new Error('network failure with fixture-secret');};
  for(let i=0;i<2;i++)await expectCode(maintainOpenAIAuth({...f,refresh}),'PI_AUTH_RENEW_UNCERTAIN');
  assert.equal(calls,1);
  assert.ok(!readFileSync(join(f.stateDir,'openai-auth-renew.json'),'utf8').includes('fixture-'));
  writeFileSync(f.authPath,JSON.stringify({'openai-codex':renewed()}));
  assert.equal((await maintainOpenAIAuth({...f,refresh})).status,'valid');
}));

test('rejection requires login; explicit 429 is cooled down without repeating a network request',()=>fixture(async f=>{
  for(const [message,first,second] of [['OpenAI Codex token refresh failed (429): redacted','PI_AUTH_RENEW_FAILED','PI_AUTH_RENEW_COOLDOWN'],['OpenAI Codex token refresh failed (400): invalid_grant','PI_AUTH_RELOGIN_REQUIRED','PI_AUTH_RELOGIN_REQUIRED']]){
    rmSync(f.stateDir,{recursive:true,force:true});let calls=0;
    const refresh=async()=>{calls++;throw new Error(message);};
    await expectCode(maintainOpenAIAuth({...f,refresh}),first);
    await expectCode(maintainOpenAIAuth({...f,refresh}),second);assert.equal(calls,1);
  }
}));

test('save failure keeps old file intact and pending journal blocks replay',()=>fixture(async f=>{
  const before=readFileSync(f.authPath,'utf8');let calls=0;
  const options={...f,refresh:async()=>{calls++;return renewed();},atomicWrite:(path,value,options)=>{if(path===f.authPath)throw new Error('disk full fixture-secret');return atomicAuthWrite(path,value,options);}};
  await expectCode(maintainOpenAIAuth(options),'PI_AUTH_RENEW_PERSIST_FAILED');
  assert.equal(readFileSync(f.authPath,'utf8'),before);
  await expectCode(maintainOpenAIAuth(options),'PI_AUTH_RENEW_UNCERTAIN');assert.equal(calls,1);
}));

test('late cancellation still persists a successfully rotated token',()=>fixture(async f=>{
  const controller=new AbortController();
  const result=await maintainOpenAIAuth({...f,signal:controller.signal,refresh:async()=>{controller.abort();return renewed();}});
  assert.equal(result.status,'renewed');assert.equal(read(f.authPath)['openai-codex'].refresh,'fixture-refresh-new');
}));

test('concurrent external login is not overwritten; unrelated provider updates are retained',()=>fixture(async f=>{
  const external=renewed();external.access='fixture-external-login';
  await expectCode(maintainOpenAIAuth({...f,refresh:async()=>{writeFileSync(f.authPath,JSON.stringify({'openai-codex':external}));return renewed();}}),'PI_AUTH_RENEW_CONFLICT');
  assert.equal(read(f.authPath)['openai-codex'].access,'fixture-external-login');
  writeFileSync(f.authPath,JSON.stringify({'openai-codex':fixtureCredential}));
  rmSync(f.stateDir,{recursive:true,force:true});
  await maintainOpenAIAuth({...f,refresh:async()=>{writeFileSync(f.authPath,JSON.stringify({'openai-codex':fixtureCredential,added:{key:'fixture-added'}}));return renewed();}});
  assert.equal(read(f.authPath).added.key,'fixture-added');
}));

test('too-short refresh is saved before rejection and cools down rather than discarding rotation',()=>fixture(async f=>{
  await expectCode(maintainOpenAIAuth({...f,refresh:async()=>({...renewed(),expires:Date.now()+1000})}),'PI_AUTH_RENEW_TOO_SHORT');
  assert.equal(read(f.authPath)['openai-codex'].refresh,'fixture-refresh-new');
  await expectCode(maintainOpenAIAuth(f),'PI_AUTH_RENEW_COOLDOWN');
}));

test('crash-left lock is never stolen; pre-cancellation makes no auth changes',()=>fixture(async f=>{
  mkdirSync(f.stateDir);writeFileSync(join(f.stateDir,'openai-auth-renew.lock'),'{}');
  await expectCode(maintainOpenAIAuth({...f,policy:{lockWaitMs:1,renewBeforeMs:1}}),'PI_AUTH_RENEW_BUSY');
  const controller=new AbortController();controller.abort();
  await expectCode(maintainOpenAIAuth({...f,signal:controller.signal}),'PI_AUTH_RENEW_CANCELLED');
  await expectCode(ensureOpenAIAuth({signal:controller.signal}),'PI_AUTH_RENEW_CANCELLED');
  assert.equal(read(f.authPath)['openai-codex'].access,fixtureCredential.access);
}));

test('Pi-compatible lock compromise blocks commit; environment excludes executable injection and credentials',()=>fixture(async f=>{
  let options;
  const lockfile={lock:async(_path,value)=>{options=value;return async()=>{};}};
  await expectCode(maintainOpenAIAuth({...f,withAuthLock:piCompatibleAuthLock(lockfile,f.authPath),refresh:async()=>{options.onCompromised();return renewed();}}),'PI_AUTH_RENEW_PERSIST_FAILED');
  assert.equal(options.realpath,false);assert.ok(options.update<options.stale);
  assert.equal(read(f.authPath)['openai-codex'].refresh,fixtureCredential.refresh);
  const env=openAIAuthEnvironment({USERPROFILE:'host',PATH:'trusted',OPENAI_API_KEY:'secret',NODE_OPTIONS:'--require bad',PI_GATEWAY_TOKEN:'secret'});
  assert.deepEqual(env,{USERPROFILE:'host',PATH:'trusted'});
}));

test('server 5xx is ambiguous and cannot automatically repeat a rotating refresh',()=>fixture(async f=>{
  let calls=0;const refresh=async()=>{calls++;throw new Error('OpenAI Codex token refresh failed (503): upstream failure');};
  for(let i=0;i<2;i++)await expectCode(maintainOpenAIAuth({...f,refresh}),'PI_AUTH_RENEW_UNCERTAIN');
  assert.equal(calls,1);
}));

test('actual child crash after synthetic rotation leaves durable intent and a non-stealable lock',()=>fixture(async f=>{
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(here,'fixtures','openai-auth-process.mjs'),f.root,'--crash-after-rotation'],{shell:false,windowsHide:true,stdio:'ignore'});
    child.on('error',reject);child.on('close',resolve);
  });
  assert.equal(code,9);assert.equal(read(join(f.stateDir,'openai-auth-renew.json')).status,'pending');
  assert.equal(readFileSync(join(f.root,'refresh-calls.txt'),'utf8'),'refresh\n');
  await expectCode(maintainOpenAIAuth({...f,policy:{lockWaitMs:1,renewBeforeMs:1}}),'PI_AUTH_RENEW_BUSY');
  assert.equal(read(f.authPath)['openai-codex'].refresh,fixtureCredential.refresh);
}));
