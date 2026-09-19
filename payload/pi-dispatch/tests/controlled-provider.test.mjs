import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {API_PROVIDERS,validateProviderConfig,configDigest,selectControlledCredential,controlledBootstrap,registrationConfig} from '../scripts/controlled-provider.mjs';
import {validateRequest,validateKetherInvocation,buildPiArgs,childEnvironment,summarize} from '../scripts/dispatch.mjs';
import {resolveRoleModel} from '../scripts/role-policy.mjs';
import {publicCapabilities} from '../scripts/provider-policy.mjs';
const fixture=()=>{const v=JSON.parse(readFileSync(new URL('../../../templates/provider-config.example.json',import.meta.url)));for(const r of Object.values(v.routes))r.capabilities.maxThinking=true;return v;};
const key='aggregator_fixture_'+'a'.repeat(25);
const clone=v=>JSON.parse(JSON.stringify(v));
const base=fixture();
const credentials={'opencode-go':{type:'api_key',key},commandcode:{type:'api_key',key}};
const args=p=>['--provider',p,'--model',base.routes[p].model,'--thinking','max','--no-tools','--yhwh-config',configDigest(base)];
test('platform examples require explicit max capability declaration; presets validate exact endpoint/protocol pairs',()=>{
 assert.throws(()=>validateProviderConfig(JSON.parse(readFileSync(new URL('../../../templates/provider-config.example.json',import.meta.url)))),/CAPABILITY/);
 assert.equal(validateProviderConfig(base),base);
 for(const mutation of [v=>v.extra=true,v=>v.routes['yhwh-worker-api'].headers={},v=>v.routes['yhwh-worker-api'].baseUrl+='/',v=>v.routes['yhwh-worker-api'].baseUrl='https://evil.test/v1',v=>v.routes['yhwh-worker-api'].model='gpt-5.5',v=>v.routes['yhwh-reviewer-api'].protocol='openai-responses',v=>v.routes['yhwh-reviewer-api'].credentialRef='../auth',v=>v.routes['yhwh-worker-api'].capabilities.tools=false,v=>v.routes['yhwh-worker-api'].maxTokens=Infinity]){
  const v=clone(base);mutation(v);assert.throws(()=>validateProviderConfig(v),/PI_PROVIDER/);
 }
});
test('custom endpoint is HTTPS only, with no userinfo, secret query or fragment; unknown options fail closed',()=>{
 for(const address of ['http://example.test/v1','https://user:pass@example.test/v1','https://example.test/v1?key=private','https://example.test/v1#private']){
  const v=fixture();v.routes['yhwh-worker-api'].platform='custom';v.routes['yhwh-worker-api'].baseUrl=address;assert.throws(()=>validateProviderConfig(v));
 }
 const v=fixture();v.routes['yhwh-reviewer-api'].platform='openrouter';v.routes['yhwh-reviewer-api'].baseUrl='https://openrouter.ai/api';v.routes['yhwh-reviewer-api'].model='anthropic/claude-sonnet-5';assert.equal(validateProviderConfig(v),v);
});
test('credential selection exports one selected key, rejects config drift, commands and subscription tokens',()=>{
 const selected=selectControlledCredential(API_PROVIDERS[0],base,credentials,configDigest(base));
 assert.deepEqual(Object.keys(selected),['controlledApi']);assert.equal(selected.controlledApi.apiKey,key);assert.ok(!JSON.stringify(selected).includes('commandcode'));
 assert.throws(()=>selectControlledCredential(API_PROVIDERS[0],base,credentials,'0'.repeat(64)),/CONFIG_CHANGED/);
 for(const bad of ['!command','$ENV_VAR','sk-ant-oat01-'+'x'.repeat(30),key+'\n'])assert.throws(()=>selectControlledCredential(API_PROVIDERS[0],base,{'opencode-go':{type:'api_key',key:bad}},configDigest(base)),/AUTH_INVALID/);
});
test('bootstrap rejects mismatch, key override, tools for reviewer, duplicate flags and thinking downgrade',()=>{
 for(const p of API_PROVIDERS){const packet=selectControlledCredential(p,base,credentials,configDigest(base));const input=args(p);const accepted=controlledBootstrap(packet,input);assert.equal(accepted.credentials[p].key,key);assert.ok(!input.includes('--yhwh-config'));
  for(const bad of [[...args(p),'--provider',p],[...args(p),'--api-key',key],args(p).map(x=>x==='max'?'high':x),args(p).map(x=>x===configDigest(base)?'0'.repeat(64):x)])assert.throws(()=>controlledBootstrap(packet,bad));
 }
 const p=API_PROVIDERS[1],packet=selectControlledCredential(p,base,credentials,configDigest(base));
 assert.throws(()=>controlledBootstrap(packet,[...args(p),'--tools=read']));
});
test('host config enables only explicit routes, preserves defaults, role/access checks, digest and no-tools launch',()=>{
 const previous=process.env.USERPROFILE;const root=mkdtempSync(join(tmpdir(),'yhwh-provider-test-'));const state=join(root,'.local/state/pi-kether');mkdirSync(state,{recursive:true});process.env.USERPROFILE=root;
 try {
  assert.throws(()=>resolveRoleModel('worker',undefined,'yhwh-worker-api'),/binding rejected/);
  writeFileSync(join(state,'provider-config.json'),JSON.stringify(base));
  assert.equal(resolveRoleModel('worker').provider,'openai-codex');assert.equal(resolveRoleModel('reviewer').provider,'anthropic');
  assert.equal(resolveRoleModel('worker',undefined,'yhwh-worker-api').model,'gpt-5.6-luna');
  assert.throws(()=>resolveRoleModel('reviewer',undefined,'yhwh-worker-api'),/binding rejected/);
  assert.equal(publicCapabilities().providers['yhwh-reviewer-api'].defaultThinking,'max');
  const req={target:'model',cwd:process.cwd(),provider:'yhwh-reviewer-api',model:'claude-sonnet-5',access:'none',thinking:'max',prompt:'fixture'};
  const request=validateRequest(req);assert.equal(request.providerConfigDigest,configDigest(base));
  const launch=buildPiArgs(request,'wsl2');assert.ok(launch.includes('--no-tools'));assert.ok(launch.includes('/opt/pi-kether/extensions/controlled-provider.js'));
  assert.throws(()=>validateRequest({...req,access:'read'}),/none access/);
  assert.throws(()=>validateRequest({...req,thinking:'high'}),/no downgrade/);
  assert.throws(()=>validateRequest({...req,baseUrl:'https://evil.test'}),/Unknown/);
  const reviewPacket={version:1,stage:'post-change',...Object.fromEntries(['requirements','changes','context','verification'].map(k=>[k,{status:'provided',content:['fixture']}]))};
  assert.equal(validateKetherInvocation({cwd:process.cwd(),provider:'yhwh-reviewer-api',task:{role:'reviewer',objective:'review',acceptance:['findings'],reviewPacket}}).request.provider,'yhwh-reviewer-api');
 } finally {if(previous===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=previous;}
});
test('ambient aggregator tokens removed and SDK models preserve max without reporting free usage',()=>{
 assert.deepEqual(childEnvironment({PATH:'safe',OPENROUTER_API_KEY:key,COMMANDCODE_API_KEY:key,OPENCODE_API_KEY:key,CMD_API_KEY:key,YHWH_API_KEY:key}),{PATH:'safe'});
 for(const route of Object.values(base.routes)){const config=registrationConfig(route);assert.equal(config.models[0].thinkingLevelMap.max,'max');assert.equal(config.models[0].thinkingLevelMap.high,null);assert.ok(!JSON.stringify(config).includes(key));}
 const raw={exitCode:0,stderr:'',stdout:JSON.stringify({type:'message_end',message:{role:'assistant',provider:'yhwh-worker-api',model:'gpt-5.6-luna',content:[],usage:{cost:{total:0}}}})+'\n'+JSON.stringify({type:'agent_end'})};
 assert.equal(summarize(raw,{provider:'yhwh-worker-api',model:'gpt-5.6-luna'}).usage.cost,null);
});
test('transport rejects redirect/destination escape and redacts opaque keys split across writes',()=>{
 const module=new URL('../scripts/provider-transport.mjs',import.meta.url).href;
 const code=`import {installTransportFence} from ${JSON.stringify(module)};const key=${JSON.stringify(key)};let seen;const target={fetch:async(i,o)=>{seen=o;return {ok:true}}};installTransportFence({apiKey:key,route:{baseUrl:'https://example.test/v1',protocol:'openai-responses'}},target);await target.fetch('https://example.test/v1/responses');if(seen.redirect!=='error')process.exitCode=1;try{await target.fetch('https://evil.test')}catch(e){console.log(e.message)};process.stdout.write(key.slice(0,12));process.stdout.write(key.slice(12)+String.fromCharCode(10));console.error(key);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes('ENDPOINT_REJECTED'));assert.ok(result.stdout.includes('[REDACTED]'));assert.ok(!result.stdout.includes(key));assert.ok(!result.stderr.includes(key));
});

test('root API pipe validator rejects drift, wrong provider and extra credentials without plaintext files',()=>{
 const root=mkdtempSync(join(tmpdir(),'yhwh-root-provider-'));
 const configFile=join(root,'provider-config.json');writeFileSync(configFile,JSON.stringify(base));
 const credentialsPacket=selectControlledCredential('yhwh-worker-api',base,credentials,configDigest(base));
 const packet={version:1,provider:'yhwh-worker-api',credentials:credentialsPacket};
 const helper=fileURLToPath(new URL('../scripts/accept-api-packet.mjs',import.meta.url));
 const call=(digest,value=packet)=>spawnSync(process.execPath,[helper,'yhwh-worker-api',configFile,digest],{input:JSON.stringify(value),encoding:'utf8'});
 const good=call(configDigest(base));assert.equal(good.status,0,good.stderr);assert.deepEqual(JSON.parse(good.stdout),credentialsPacket);
 const changed=call('0'.repeat(64));assert.equal(changed.status,4);assert.match(changed.stderr,/PI_PROVIDER_CONFIG_CHANGED/);assert.equal(changed.stdout,'');assert.ok(!changed.stderr.includes(key));
 assert.equal(call(configDigest(base),{...packet,provider:'anthropic'}).status,4);
 assert.equal(call(configDigest(base),{...packet,credentials:{...credentialsPacket,extra:'secret'}}).status,4);
});
