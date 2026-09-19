import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyLspResult} from '../scripts/lsp-result.mjs';
import {selectCredential} from '../scripts/prepare-credentials.mjs';
import {summarize} from '../scripts/dispatch.mjs';
import {classifyProviderResult,createMemoryProviderCircuitState} from '../extensions/provider-circuit-state.js';

const output=(text,details={})=>({content:[{type:'text',text}],details});
test('LSP distinguishes tool failure, unavailable service, no match and code diagnostics',()=>{
  assert.equal(classifyLspResult(output('Error: invalid pattern',{matchCount:0}),{tool:'ast_search',backend:'tree-sitter'}).ok,false);
  assert.equal(classifyLspResult(output('No matches found.',{matchCount:0}),{tool:'ast_search',backend:'tree-sitter'}).status,'no-match');
  assert.equal(classifyLspResult(output('No LSP server available for: a.py'),{tool:'lsp_hover',backend:'unavailable'}).status,'unavailable');
  assert.equal(classifyLspResult(output('No diagnostics (clean).'),{tool:'lsp_diagnostics',backend:'lsp'}).ok,false);
  assert.equal(classifyLspResult(output('1 error(s)\na.py:4:1 error: incompatible type'),{tool:'lsp_diagnostics',backend:'lsp',diagnosticsPublished:true}).status,'success');
  assert.equal(classifyLspResult(output('No syntax errors detected. [tree-sitter]'),{tool:'lsp_diagnostics',backend:'tree-sitter'}).status,'degraded');
  assert.equal(classifyLspResult(output('Could not find symbol "x"',{hasResult:false}),{tool:'lsp_hover',backend:'lsp'}).status,'no-match');
  for(const kind of ['hover','definition','references','completion','code action','document symbols','workspace symbols']) assert.equal(classifyLspResult(output(`LSP ${kind} request failed: disconnected`,{count:0,hasResult:false}),{tool:'lsp_hover',backend:'lsp'}).status,'failed');
  assert.equal(classifyLspResult({content:[]},{backend:'lsp'}).ok,false);
});
test('credential preparation forwards only selected API or bounded OAuth data',()=>{
 const key='sk-ant-api03-'+'fixture'.repeat(8);
 assert.deepEqual(selectCredential('anthropic',{anthropic:{type:'api_key',key}}),{anthropicApi:{apiKey:key}});
 assert.throws(()=>selectCredential('anthropic',{claudeAiOauth:{accessToken:'subscription'}}),{code:'PI_AUTH_MISSING'});
 assert.throws(()=>selectCredential('pi-claude-code-provider',{}),{code:'PI_AUTH_INVALID'});
 const data={'openai-codex':{type:'oauth',access:'fixture',refresh:'host-only',expires:900000}};
 assert.deepEqual(selectCredential('openai-codex',data,100),{openaiAccess:{accessToken:'fixture',expiresAt:900000}});
 assert.throws(()=>selectCredential('openai-codex',data,900000),{code:'PI_AUTH_EXPIRED'});
});
test('expired auth reaches the circuit as authentication and immediately blocks normal routing',()=>{
  const request={provider:'anthropic',model:'claude-sonnet-5'};
  const result=summarize({stdout:'',stderr:'PI_AUTH_EXPIRED\n',exitCode:4},request);
  assert.equal(result.failureCode,'PI_AUTH_EXPIRED');
  assert.equal(result.failure,'PI_AUTH_EXPIRED');
  const assessment=classifyProviderResult(result);
  assert.equal(assessment.category,'authentication');
  const circuit=createMemoryProviderCircuitState();
  const state=circuit.record({...request,...assessment});
  assert.equal(state.state,'open');assert.equal(state.canAttemptTask,false);
  assert.equal(classifyProviderResult({...result,failureCode:'PI_CREDENTIAL_PREPARE_FAILED'}).impact,false);
});
