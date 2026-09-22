import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareWindowsApiPacket} from '../scripts/windows-api-credential.mjs';
import {acceptApiPacket} from '../scripts/accept-api-packet.mjs';
import {configDigest,controlledBootstrap} from '../scripts/controlled-provider.mjs';
test('encrypted worker key crosses Windows decryption, root validation and bootstrap without plaintext files',async()=>{
 const root=mkdtempSync(join(tmpdir(),'yhwh-dpapi-worker-'));const state=join(root,'.local/state/pi-kether');mkdirSync(state,{recursive:true});
 const config=JSON.parse(readFileSync(new URL('../../../templates/provider-config.example.json',import.meta.url)));
 delete config.routes['yhwh-reviewer-api'];config.routes['yhwh-worker-api'].capabilities.maxThinking=true;
 const key='worker_fixture_'+'z'.repeat(30),file=join(state,'provider-credentials.json');
 writeFileSync(join(state,'provider-config.json'),JSON.stringify(config));writeFileSync(file,JSON.stringify({'opencode-go':{type:'api_key',key}}));
 const env={...process.env,USERPROFILE:root};const request={provider:'yhwh-worker-api',providerConfigDigest:configDigest(config)};
 await assert.rejects(prepareWindowsApiPacket(request,{env}),{code:'PI_AUTH_MIGRATION_REQUIRED'});
 const run=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../../../install/Migrate-ApiCredentials.ps1',import.meta.url)),'-TargetHome',root],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.ok(!run.stdout.includes(key));
 const packet=await prepareWindowsApiPacket(request,{env});assert.ok(!readFileSync(file,'utf8').includes(key));
 const selected=acceptApiPacket(request.provider,packet,config,request.providerConfigDigest);
 const result=controlledBootstrap(selected,['--provider',request.provider,'--model','gpt-5.6-luna','--thinking','max','--no-tools','--yhwh-config',request.providerConfigDigest]);
 assert.equal(result.credentials[request.provider].key,key);
 await assert.rejects(prepareWindowsApiPacket({...request,providerConfigDigest:'0'.repeat(64)},{env}),{code:'PI_PROVIDER_CONFIG_CHANGED'});
});
test('old file-based credential helper refuses API providers instead of plaintext fallback',()=>{
 const helper=fileURLToPath(new URL('../scripts/prepare-credentials.mjs',import.meta.url));
 for(const provider of ['anthropic','yhwh-worker-api','yhwh-reviewer-api']){
  const result=spawnSync(process.execPath,[helper,provider,'missing-source','must-not-create'],{encoding:'utf8'});
  assert.equal(result.status,4);assert.equal(result.stdout,'');assert.match(result.stderr,/PI_AUTH_ENCRYPTED_PIPE_REQUIRED/);
 }
});
