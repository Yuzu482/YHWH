import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {checkClaudeAuth} from '../scripts/claude-api-auth.mjs';
test('API preflight reads only the dedicated local key file and reports configuration, not account validity',async()=>{
 const root=mkdtempSync(join(tmpdir(),'yhwh-api-fixture-'));
 try{
  const env={...process.env,USERPROFILE:root,ANTHROPIC_API_KEY:'must-not-use',CLAUDE_CODE_OAUTH_TOKEN:'must-not-use'};
  mkdirSync(join(root,'.claude'));writeFileSync(join(root,'.claude','.credentials.json'),'subscription fixture must not be parsed');
  await assert.rejects(checkClaudeAuth({env}),{code:'PI_AUTH_MISSING'});
  const dir=join(root,'.local/state/pi-kether');mkdirSync(dir,{recursive:true});const file=join(dir,'anthropic-api-key.json');
  writeFileSync(file,JSON.stringify({anthropic:{type:'api_key',key:'sk-ant-api03-'+'fixture'.repeat(8)}}));
  await assert.rejects(checkClaudeAuth({env}),{code:'PI_AUTH_MIGRATION_REQUIRED'});
  const migrated=spawnSync('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('../../../install/Migrate-ApiCredentials.ps1',import.meta.url)),'-TargetHome',root],{encoding:'utf8'});assert.equal(migrated.status,0,migrated.stderr);
  assert.deepEqual(await checkClaudeAuth({env}),{ok:true,status:'configured',authentication:'api_key',atRestEncryption:'Windows DPAPI CurrentUser',networkValidated:false,modelCalls:0});
  for(const invalid of ['bad json',JSON.stringify({anthropic:{type:'oauth',access:'private'}}),'x'.repeat(262145)]){
   writeFileSync(file,invalid);await assert.rejects(checkClaudeAuth({env}),{code:'PI_AUTH_INVALID'});
  }
  const controller=new AbortController();controller.abort();await assert.rejects(checkClaudeAuth({env,signal:controller.signal}),{code:'PI_AUTH_CHECK_CANCELLED'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
