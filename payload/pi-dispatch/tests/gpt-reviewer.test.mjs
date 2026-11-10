import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateKetherInvocation,validateRequest,buildPiArgs,dispatch,summarize} from '../scripts/dispatch.mjs';
import {resolveRoleModel,effectiveRoleModels,effectiveRoleProviders} from '../scripts/role-policy.mjs';
import {createReviewAttemptLedger} from '../scripts/tier-review-policy.mjs';
import {createGatewayRuntime} from '../scripts/gateway.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {roleValue} from './contract-fixtures.mjs';
const cwd=process.cwd();
const packet=()=>({version:1,stage:'post-change',...Object.fromEntries(['requirements','changes','context','verification'].map(n=>[n,{status:'provided',content:['Concrete supplied fixture evidence']}]))});
const invocation=()=>({cwd,provider:'openai-codex',model:'gpt-6-sol',access:'none',task:{role:'Geburah',objective:'Review the supplied artifact',acceptance:['Reject unsupported or contradictory evidence'],reviewPacket:packet()}});

test('explicit GPT reviewer is a separate fixed role tuple and launches no tools or sessions',()=>{
 const {request,task}=validateKetherInvocation(invocation());
 assert.equal(task.role,'Geburah');assert.equal(request.model,'gpt-6-sol');assert.equal(request.thinking,'medium');
 const args=buildPiArgs(request,'wsl2');
 for(const flag of ['--no-tools','--no-session','--no-context-files','--no-skills','--no-prompt-templates'])assert.ok(args.includes(flag));
 assert.ok(!args.includes('--tools'));assert.ok(!args.some(s=>s.includes('editor-proxy')||s.includes('result-submit')));
 assert.throws(()=>resolveRoleModel('Chesed','gpt-6-sol','openai-codex'),/requires model/);
 assert.throws(()=>resolveRoleModel('Geburah','gpt-6-luna','openai-codex'),/requires model/);
 for(const thinking of ['medium','high','xhigh'])assert.equal(validateKetherInvocation({...invocation(),thinking}).request.thinking,thinking);
 for(const thinking of ['off','low','max'])assert.throws(()=>validateKetherInvocation({...invocation(),thinking}),{code:'REVIEW_TIER_THINKING_INVALID'});
});

test('GPT reviewer scopes, missing material, raw invocation and editor access fail before execution',async()=>{
 for(const access of ['read','workspace-write'])assert.throws(()=>validateKetherInvocation({...invocation(),access},true),/does not allow/);
 for(const field of ['readScope','writeScope','fixtureScope'])assert.throws(()=>validateKetherInvocation({...invocation(),task:{...invocation().task,[field]:['a.js']}}),/none access/);
 assert.throws(()=>validateKetherInvocation({...invocation(),task:{...invocation().task,reviewPacket:undefined}}),/review|materials/i);
 const raw={target:'model',cwd,provider:'openai-codex',model:'gpt-6-sol',access:'none',prompt:'fixture'};
 assert.throws(()=>validateRequest(raw),{code:'YHWH_WORKER_ENFORCEMENT_REJECTED'});
 let called=false;
 await assert.rejects(dispatch(raw,undefined,null,{runtimeResolver:()=>{called=true;throw Error('must not run');}}),/YHWH_WORKER_ENFORCEMENT_REJECTED/);
 assert.equal(called,false);
 const {request,task}=validateKetherInvocation(invocation());
 await assert.rejects(dispatch(request,undefined,task,{editorBroker:{}}),{code:'YHWH_EDITOR_ROUTE_REJECTED'});
});

test('host config selects GPT model consistently while malformed defaults do not silently fall back',async()=>{
 const home=mkdtempSync(join(tmpdir(),'gpt-review-default-')),previous=process.env.USERPROFILE;
 const dir=join(home,'.local','state','pi-kether');mkdirSync(dir,{recursive:true});
 const file=join(dir,'reviewer-transport.json');let runtime;
 try {
  process.env.USERPROFILE=home;
  assert.equal(effectiveRoleModels(home).Geburah,'claude-sonnet-5');
  writeFileSync(file,JSON.stringify({schemaVersion:1,defaultTransport:'openai-codex'}));
  assert.equal(effectiveRoleModels(home).Geburah,'gpt-6-sol');assert.equal(effectiveRoleProviders(home).Geburah,'openai-codex');
  const {request}=validateKetherInvocation({cwd,access:'none',task:invocation().task});
  assert.equal(request.provider,'openai-codex');assert.equal(request.model,'gpt-6-sol');
  assert.equal(resolveRoleModel('Geburah',undefined,'claude-code-cli',home).model,'claude-sonnet-5');
  runtime=createGatewayRuntime({roots:[cwd],sandboxStatus:{ok:false},dispatchFn:()=>{throw Error('not a model test');}});
  const cap=runtime.capabilities();
  assert.equal(cap.governance.roleModels.Geburah,'gpt-6-sol');assert.equal(cap.governance.roleProviders.Geburah,'openai-codex');
  assert.equal(cap.governance.reviewerRoutes['openai-codex'].runtime,'pi');
  assert.deepEqual(cap.governance.reviewerEffort.controlledApi,['max']);
  writeFileSync(file,'{');
  assert.throws(()=>resolveRoleModel('Geburah',undefined,undefined,home),/PI_REVIEWER_ROUTE_CONFIG_INVALID/);
 } finally {
  if(runtime)await runtime.shutdown();
  if(previous===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=previous;
  rmSync(home,{recursive:true,force:true});
 }
});

test('actual Pi provider/model mismatch or incomplete execution cannot approve a GPT reviewer',()=>{
 const request=validateKetherInvocation(invocation()).request;
 const raw=(provider,model,end=true)=>({exitCode:0,stderr:'',stdout:JSON.stringify({type:'message_end',message:{role:'assistant',provider,model,content:[{type:'text',text:'fixture'}],stopReason:'stop'}})+'\n'+(end?JSON.stringify({type:'agent_end'}):'')});
 assert.equal(summarize(raw('openai-codex','gpt-6-sol'),request).ok,true);
 for(const value of [raw('openai-codex','gpt-6-luna'),raw('anthropic','claude-sonnet-5'),raw('openai-codex','gpt-6-sol',false),{...raw('openai-codex','gpt-6-sol'),failure:'timeout'}])assert.equal(summarize(value,request).ok,false);
});

test('Sonnet and GPT attempts share the original durable quota across route changes and restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gpt-review-quota-'));
 const identity={workspaceSha256:'a'.repeat(64),runAnchorSha256:'b'.repeat(64),stage:'pre-review',tier:'T2',parentRunId:'same-real-goal'};
 const history=[];
 try {
  for(const [requestId,provider] of [['sonnet-attempt','claude-code-cli'],['gpt-attempt','openai-codex']]) {
   const ledger=createReviewAttemptLedger(dir);
   const ticket=ledger.reserve({...identity,requestId});
   ledger.markStarted(ticket);ledger.finish(ticket,{started:true,outcome:'timeout',executionMs:1000});
   history.push({provider,ticket});
  }
  assert.equal(history.length,2);
  const restarted=createReviewAttemptLedger(dir);
  assert.throws(()=>restarted.reserve({...identity,requestId:'new-gpt-request'}),{code:'PI_REVIEW_LIMIT_EXCEEDED'});
  assert.throws(()=>restarted.reserve({...identity,requestId:'new-sonnet-request',provider:'claude-code-cli'}),{code:'PI_REVIEW_ATTEMPTS_INVALID'});
  assert.ok(restarted.snapshot({...identity,requestId:'inspect'}).timeUsedMs>=2000);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

// Genuine MCP admission/validation and durable accounting, with clearly synthetic
// model executions. No network, credential refresh or actual model call.
async function withMemoryGateway(fn,{sandbox=true,decision='approve',contradictory=false,toolsUsed=[]}={}) {
 const dir=mkdtempSync(join(tmpdir(),'gpt-review-mcp-')),calls=[];
 const runtime=createGatewayRuntime({roots:[cwd],requestLedgerDir:dir,
  sandboxStatus:{ok:sandbox,backend:'wsl2-bwrap',resourceLimits:sandbox},
  schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5},
  dispatchFn:async(request,_signal,task,options)=>{
   calls.push({request,task});await options.onModelStart?.();
   const value=roleValue('Geburah','Synthetic independent review fixture');value.reviewDecision=decision;
   if(decision==='request-changes'||contradictory)value.deliverable.findings=[{severity:'high',blocking:true,description:'Fixture invariant needs correction',evidence:'Synthetic supplied plan'}];
   return {ok:true,provider:request.provider,model:request.model,requestedProvider:request.provider,requestedModel:request.model,
    workerRuntime:request.provider==='claude-code-cli'?'claude-code-cli':'pi',modelExecutionStarted:true,
    toolsUsed,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value)};
  }});
 const server=runtime.makeServer(),client=new Client({name:'gpt-review-fixture',version:'1.0.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 const call=async args=>{const r=await client.callTool({name:'dispatch_subagent',arguments:args});return JSON.parse(r.content[0].text);};
 try {await server.connect(a);await client.connect(b);await fn({call,calls});}
 finally {await client.close();await server.close();await runtime.shutdown();rmSync(dir,{recursive:true,force:true});}
}
const preRequest=(requestId,provider='openai-codex',material='original plan')=>({
 cwd,provider,model:provider==='openai-codex'?'gpt-6-sol':'claude-sonnet-5',access:'none',thinking:'medium',
 requestId,parentRunId:'memory-review-original-goal',tier:'T2',timeoutSeconds:30,
 task:{...invocation().task,objective:'Synthetic same real review goal',reviewPacket:{...packet(),stage:'pre-change',context:{status:'provided',content:[material]}}},
});

test('in-memory MCP admits fixed GPT review and validates its structured result and quota',async()=>{
 await withMemoryGateway(async({call,calls})=>{
  const result=await call(preRequest('gpt-mcp-approved'));
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.reviewValidation.approved,true);
  assert.equal(result.contract.role,'Geburah');assert.equal(result.contract.mode,'standalone');
  assert.equal(result.reviewQuota.used,1);assert.equal(result.model,'gpt-6-sol');
  assert.equal(calls.length,1);assert.equal(calls[0].request.rolePresetId,'Geburah');assert.equal(calls[0].request.access,'none');
 });
 await withMemoryGateway(async({call})=>{
  const result=await call(preRequest('gpt-mcp-contradiction'));
  assert.equal(result.ok,false);assert.equal(result.reviewValidation.approved,false);
 },{contradictory:true});
});

test('in-memory MCP counts failed Claude and GPT reviews together rather than resetting quota',async()=>{
 await withMemoryGateway(async({call,calls})=>{
  const first=await call(preRequest('claude-mcp-failed','claude-code-cli','Fixture plan version 1'));
  assert.equal(first.ok,false);assert.equal(first.reviewQuota.used,1);
  const second=await call(preRequest('gpt-mcp-failed','openai-codex','Fixture plan version 2 with unresolved invariant'));
  assert.equal(second.ok,false);assert.equal(second.reviewQuota.used,2);
  const denied=await call(preRequest('gpt-mcp-no-new-quota','openai-codex','Fixture plan version 3'));
  assert.equal(denied.ok,false);assert.equal(denied.code,'PI_REVIEW_LIMIT_EXCEEDED');assert.equal(calls.length,2);
 },{decision:'request-changes'});
});

test('GPT review never receives the native Claude CLI sandbox exemption',async()=>{
 await withMemoryGateway(async({call,calls})=>{
  const denied=await call(preRequest('gpt-requires-sandbox'));
  assert.equal(denied.ok,false);assert.match(denied.error,/resource isolation is unavailable/);assert.equal(calls.length,0);
 },{sandbox:false});
});

test('a nominal approval cannot hide reviewer tool use or missing GPT tool telemetry',async()=>{
 for(const toolsUsed of [['read'],null])await withMemoryGateway(async({call})=>{
  const result=await call(preRequest('gpt-tool-use-rejected'));
  assert.equal(result.ok,false);assert.equal(result.failureCode,'REVIEW_TOOLS_NOT_ALLOWED');
 },{toolsUsed});
 await withMemoryGateway(async({call})=>{
  const result=await call(preRequest('claude-tool-use-rejected','claude-code-cli'));
  assert.equal(result.ok,false);assert.equal(result.failureCode,'REVIEW_TOOLS_NOT_ALLOWED');
 },{toolsUsed:['read']});
});
