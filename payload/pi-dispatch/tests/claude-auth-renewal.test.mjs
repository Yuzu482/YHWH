import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureClaudeAuth,renewalEnvironment,runClaudeLogin} from '../scripts/claude-auth-renewal.mjs';

const policy={renewBeforeMs:100,lockWaitMs:500,timeoutMs:100,cooldownMs:1000};
async function fixture(run){
  const root=mkdtempSync(join(tmpdir(),'pi-renew-test-'));
  try{
    mkdirSync(join(root,'.claude'));const file=join(root,'.claude','.credentials.json');
    const cli=join(root,'claude.exe');writeFileSync(cli,'fixture');
    const write=(expiresAt=10)=>writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:'private-access',refreshToken:'private-refresh',expiresAt,scopes:['user:inference'],subscriptionType:'pro'}}));write();
    await run({root,file,write,env:{USERPROFILE:root,PI_CLAUDE_AUTH_CLI:cli},policy,now:()=>1000});
  }finally{rmSync(root,{recursive:true,force:true});}
}
test('valid login never invokes CLI; concurrent renewals re-read persisted credentials',()=>fixture(async f=>{
  let calls=0;
  const runLogin=async()=>{calls++;await new Promise(r=>setTimeout(r,30));f.write(5000);return {ok:true};};
  const results=await Promise.all([ensureClaudeAuth({...f,runLogin}),ensureClaudeAuth({...f,runLogin})]);
  assert.equal(calls,1);assert.deepEqual(results.map(r=>r.status).sort(),['renewed','valid']);
  assert.ok(results.every(r=>!JSON.stringify(r).includes('private')));
  assert.equal(existsSync(join(f.root,'.local/state/pi-kether/claude-auth-renew.lock')),false);
}));
test('rejected refresh is latched until login contents change',()=>fixture(async f=>{
  let calls=0;const runLogin=async()=>{calls++;return {ok:false,code:'PI_AUTH_RELOGIN_REQUIRED'};};
  for(let i=0;i<2;i++)await assert.rejects(ensureClaudeAuth({...f,runLogin}),{code:'PI_AUTH_RELOGIN_REQUIRED'});
  assert.equal(calls,1);
  f.write(5000);assert.equal((await ensureClaudeAuth({...f,runLogin})).status,'valid');
}));
test('transient failure is cooled down; zero exit without persisted renewal is not success',()=>fixture(async f=>{
  await assert.rejects(ensureClaudeAuth({...f,runLogin:async()=>({ok:true})}),{code:'PI_AUTH_RENEW_NOT_PERSISTED'});
  await assert.rejects(ensureClaudeAuth({...f,runLogin:async()=>assert.fail('must not retry')}),{code:'PI_AUTH_RENEW_COOLDOWN'});
  assert.ok(!readFileSync(join(f.root,'.local/state/pi-kether/claude-auth-renew.json'),'utf8').includes('private-refresh'));
}));
test('missing refresh fields require login; busy lock and cancellation are bounded',()=>fixture(async f=>{
  writeFileSync(f.file,JSON.stringify({claudeAiOauth:{accessToken:'private',expiresAt:10}}));
  await assert.rejects(ensureClaudeAuth(f),{code:'PI_AUTH_RELOGIN_REQUIRED'});
  const lock=join(f.root,'.local/state/pi-kether/claude-auth-renew.lock');writeFileSync(lock,'existing');
  await assert.rejects(ensureClaudeAuth({...f,policy:{...policy,lockWaitMs:1}}),{code:'PI_AUTH_RENEW_BUSY'});
  const controller=new AbortController();controller.abort();
  assert.equal((await runClaudeLogin({signal:controller.signal})).code,'PI_AUTH_RENEW_CANCELLED');
}));
test('refresh environment excludes access tokens, alternate auth and executable config',()=>{
  const env=renewalEnvironment({USERPROFILE:'host',PATH:'trusted',ANTHROPIC_API_KEY:'private',ANTHROPIC_BASE_URL:'https://elsewhere',CLAUDE_CODE_OAUTH_TOKEN:'old',NODE_OPTIONS:'--require untrusted'}, {refreshToken:'refresh',scopes:['user:inference']},'host/.claude');
  assert.equal(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,'refresh');assert.equal(env.CLAUDE_CODE_OAUTH_SCOPES,'user:inference');
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','NODE_OPTIONS'])assert.equal(env[key],undefined);
});

test('native process timeout waits for exit and never returns captured credential output',()=>fixture(async f=>{
  writeFileSync(join(f.root,'auth'),"console.log('private-child-output');setInterval(()=>{},1000);");
  const started=Date.now();
  const result=await runClaudeLogin({executable:process.execPath,cwd:f.root,env:process.env,timeoutMs:300});
  assert.equal(result.code,'PI_AUTH_RENEW_TIMEOUT');assert.ok(Date.now()-started<5000);
  assert.ok(!JSON.stringify(result).includes('private-child-output'));
}));

test('long-task validity requires renewal even when more than five minutes remain',()=>fixture(async f=>{
  f.write(361000);let calls=0;
  const result=await ensureClaudeAuth({...f,policy:{...policy,renewBeforeMs:300000},minimumValidityMs:960000,runLogin:async()=>{calls++;f.write(2000000);return {ok:true};}});
  assert.equal(calls,1);assert.equal(result.minimumValidityMs,960000);assert.equal(result.status,'renewed');
}));
test('renewal must persist enough lifetime for the requested task',()=>fixture(async f=>{
  await assert.rejects(ensureClaudeAuth({...f,minimumValidityMs:960000,runLogin:async()=>{f.write(600000);return {ok:true};}}),{code:'PI_AUTH_RENEW_NOT_PERSISTED'});
  await assert.rejects(ensureClaudeAuth({...f,minimumValidityMs:Infinity}),{code:'PI_AUTH_VALIDITY_INVALID'});
}));
