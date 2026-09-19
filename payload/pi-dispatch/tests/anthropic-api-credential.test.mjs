import test from 'node:test';
import assert from 'node:assert/strict';
import {selectAnthropicApiCredential,anthropicBootstrapAuth} from '../scripts/anthropic-api-credential.mjs';
const key='sk-ant-api03-'+'fixture'.repeat(8);
const args=['--provider','anthropic','--model','claude-sonnet-5','--no-tools'];
test('only literal API credential enters the bounded memory payload',()=>{
 assert.deepEqual(selectAnthropicApiCredential({anthropic:{type:'api_key',key},unrelated:'secret'}),{anthropicApi:{apiKey:key}});
 assert.deepEqual(anthropicBootstrapAuth({anthropicApi:{apiKey:key}},args),{anthropic:{type:'api_key',key}});
});
test('rejects subscription credentials, OAuth tokens, command keys and malformed keys without exposing them',()=>{
 for(const input of [{claudeAiOauth:{accessToken:'private'}},{anthropic:{type:'oauth',access:'private'}},...['sk-ant-oat01-private','sk-ant-ort01-private','!echo private','ANTHROPIC_API_KEY',key+'\n'].map(key=>({anthropic:{type:'api_key',key}}))]){
  assert.throws(()=>selectAnthropicApiCredential(input),e=>/^PI_AUTH_(MISSING|INVALID)$/.test(e.message));
 }
});
test('rejects mismatched routes, duplicate providers, tools, command-line secrets and mixed credentials',()=>{
 for(const bad of [args.map(a=>a==='anthropic'?'openai-codex':a),args.map(a=>a==='claude-sonnet-5'?'claude-opus-5':a),args.filter(a=>a!=='--no-tools'),[...args,'--provider','anthropic'],[...args,'--tools','read'],[...args,'--tools=read'],[...args,'--api-key',key]])assert.throws(()=>anthropicBootstrapAuth({anthropicApi:{apiKey:key}},bad),/PI_AUTH_INVALID/);
 assert.throws(()=>anthropicBootstrapAuth({anthropicApi:{apiKey:key},openaiAccess:{}},args),/PI_AUTH_INVALID/);
});

import {readFileSync} from 'node:fs';
import {childEnvironment,buildPiArgs,validateRequest} from '../scripts/dispatch.mjs';
import {redactSensitiveText} from '../extensions/audit-log.js';
test('review launch preserves no-tools and removes ambient Claude/API credential overrides',()=>{
 const env=childEnvironment({PATH:'retained',ANTHROPIC_API_KEY:key,ANTHROPIC_BASE_URL:'https://invalid.test',CLAUDE_CODE_OAUTH_TOKEN:'oauth',NODE_OPTIONS:'--require unsafe'});
 assert.deepEqual(env,{PATH:'retained'});
 const route=validateRequest({target:'model',cwd:process.cwd(),provider:'anthropic',model:'claude-sonnet-5',thinking:'max',access:'none',prompt:'fixture'});
 const launch=buildPiArgs(route,'wsl2');
 assert.ok(launch.includes('--no-tools'));assert.ok(!launch.includes('--tools'));assert.ok(!launch.join(' ').includes('claude-review'));
 assert.throws(()=>validateRequest({...route,provider:'pi-claude-code-provider'}));
 assert.ok(!redactSensitiveText(key).includes(key));
 const sandbox=readFileSync(new URL('../sandbox/pi-kether-sandbox',import.meta.url),'utf8');
 assert.ok(sandbox.includes('PI_AUTH_ENCRYPTED_PIPE_REQUIRED'));assert.ok(!sandbox.includes('anthropic-api-key.json'));assert.ok(!sandbox.includes('.claude/'));assert.ok(!sandbox.includes('--proc /proc'));
});
