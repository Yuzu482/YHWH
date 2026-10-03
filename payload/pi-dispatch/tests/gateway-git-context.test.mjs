import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {listenHttpFixture} from './http-fixture.mjs';
import {roleValue} from './contract-fixtures.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token='git-context-gateway-test-token-with-at-least-thirty-two-characters';
test('MCP dispatch receives a cloned Git-enriched task after scheduler admission',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gateway-git-context-'));let http,client,runtime;
 try{
  const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,...args],{cwd:root,encoding:'utf8'});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'source.txt'),'baseline\n');git('add','source.txt');git('commit','-qm','baseline');writeFileSync(join(root,'source.txt'),'dispatch evidence\n');
  const callerTask={role:'Chesed',objective:'Inspect scoped diff',acceptance:['Return a result'],readScope:['source.txt'],context:['caller context']};let observed;
  const {app,runtime:gatewayRuntime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[root],token,sandboxStatus:{ok:true,backend:'fixture',resourceLimits:true},dispatchFn:async(request,_signal,task)=>{observed=task;return {ok:true,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(roleValue(task.role,task.objective))};}});runtime=gatewayRuntime;
  http=await listenHttpFixture(app);client=new Client({name:'git-context-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const receipt=JSON.parse((await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}})).content[0].text).receipt;
  const response=JSON.parse((await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'read',workflowReceipt:receipt,task:callerTask}})).content[0].text);
  assert.equal(response.ok,true,JSON.stringify(response));assert.notEqual(observed,callerTask);assert.deepEqual(callerTask.context,['caller context']);
  assert.equal(observed.context[0],'caller context');assert.ok(observed.context.some(value=>value.includes('category=unstaged')&&value.includes('source.txt')));
 }finally{await client?.close();await runtime?.shutdown({graceMs:0,abortWaitMs:0});if(http)await new Promise(resolve=>http.close(resolve));rmSync(root,{recursive:true,force:true});}
});
