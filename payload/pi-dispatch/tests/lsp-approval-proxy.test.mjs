import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {startStdioProxy} from '../scripts/stdio-proxy.mjs';
const tempRoot=fs.realpathSync(tmpdir()),base=fs.mkdtempSync(path.join(tempRoot,'pi-lsp-approval-integration-'));
test.after(()=>{const actual=fs.realpathSync(base),relative=path.relative(tempRoot,actual);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('unsafe fixture cleanup');fs.rmSync(actual,{recursive:true,force:true})});
const repo=path.join(base,'repo'),stateDir=path.join(base,'lsp-approval'),token='fixture-token-0123456789-0123456789-abcdef';fs.mkdirSync(repo);
execFileSync('git',['init','-q',repo],{stdio:'pipe'});
const file=path.join(repo,'sample.js'),lines=Array.from({length:2100},(_,i)=>`const v${i}=${i};`);fs.writeFileSync(file,lines.join('\n')+'\n');execFileSync('git',['-C',repo,'add','sample.js'],{stdio:'pipe'});
let lspCalls=0,nextAnswer='accept',onPrompt=null;const prompts=[];
const fixture=createGatewayApp({host:'127.0.0.1',port:0,token,roots:[repo],lspApprovalRoot:stateDir,
 sandboxStatus:{ok:true,backend:'isolated-test',resourceLimits:true},schedulerOptions:{availableMemoryBytes:()=>64*1024**3,hostReserveBytes:0},
 lspFn:async()=>{lspCalls++;return {ok:true,status:'success',toolsUsed:['lsp_symbols'],result:{symbols:['v0']},cleanup:{ok:true}};}});
const http=fixture.app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
const port=http.address().port,config=path.join(base,'gateway.json');fs.writeFileSync(path.join(base,'token.txt'),token);fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port,tokenFile:'token.txt',roots:[repo]}));
const direct=new Client({name:'old-client',version:'1'});await direct.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
let bridge,host;
async function connectHost(elicitation=true){
 const client=new Client({name:'fixture-host',version:'1'},{capabilities:elicitation?{elicitation:{form:{}}}:{}});
 if(elicitation)client.setRequestHandler(ElicitRequestSchema,async request=>{prompts.push(request.params.message);if(onPrompt){const f=onPrompt;onPrompt=null;await f()}return {action:nextAnswer,content:{}}});
 const [a,b]=InMemoryTransport.createLinkedPair();const proxy=await startStdioProxy({configPath:config,transport:b});await client.connect(a);return {client,proxy};
}
const args={cwd:repo,file,method:'symbols',resourceProfile:'small',timeoutSeconds:5,queueTimeoutSeconds:2};
const value=result=>result.structuredContent??JSON.parse(result.content[0].text);
test('LSP approval is enforced at the gateway and at a fresh local proxy',async t=>{
 try{
  await t.test('old direct client cannot bypass initial confirmation',async()=>{const result=await direct.callTool({name:'lsp_request',arguments:args});assert.equal(value(result).code,'PI_LSP_CONFIRMATION_REQUIRED');assert.equal(lspCalls,0)});
  ({client:host,proxy:bridge}=await connectHost());
  await t.test('guarded alias hides internal confirmation fields and has no inaccurate read-only hint',async()=>{const found=(await host.listTools()).tools.find(x=>x.name==='lsp_confirmed_request');assert(found);assert.notEqual(found.annotations?.readOnlyHint,true);assert.equal(found.inputSchema.properties.confirmationNonce,undefined)});
  await t.test('first accepted query runs once and records a baseline',async()=>{const result=await host.callTool({name:'lsp_confirmed_request',arguments:args});assert.equal(result.isError,false);assert.equal(lspCalls,1);assert.equal(prompts.length,1);assert.match(prompts.at(-1),/首次/)});
  await t.test('repeated and small changes run without a new prompt',async()=>{await host.callTool({name:'lsp_request',arguments:args});const small=[...lines];small[0]='const changed=0;';fs.writeFileSync(file,small.join('\n')+'\n');await host.callTool({name:'lsp_request',arguments:args});assert.equal(lspCalls,3);assert.equal(prompts.length,1)});
  await t.test('major change blocks old clients and denial does not execute',async()=>{const big=lines.map((x,i)=>i<1001?`const major${i}=1;`:x);fs.writeFileSync(file,big.join('\n')+'\n');const directResult=await direct.callTool({name:'lsp_request',arguments:args});assert.equal(value(directResult).code,'PI_LSP_CONFIRMATION_REQUIRED');nextAnswer='decline';const denied=await host.callTool({name:'lsp_request',arguments:args});assert.equal(denied.isError,true);assert.equal(lspCalls,3);assert.equal(prompts.length,2)});
  await t.test('acceptance records the new baseline',async()=>{nextAnswer='accept';const accepted=await host.callTool({name:'lsp_request',arguments:args});assert.equal(accepted.isError,false);assert.equal(lspCalls,4);assert.equal(prompts.length,3);await host.callTool({name:'lsp_request',arguments:args});assert.equal(lspCalls,5);assert.equal(prompts.length,3)});
  await t.test('concurrent requests for the same change share confirmation',async()=>{const big=lines.map((x,i)=>i<1001?`const concurrent${i}=2;`:x);fs.writeFileSync(file,big.join('\n')+'\n');const previous=prompts.length;onPrompt=()=>new Promise(resolve=>setTimeout(resolve,2200));const results=await Promise.all([host.callTool({name:'lsp_request',arguments:args}),host.callTool({name:'lsp_request',arguments:args})]);assert(results.every(r=>r.isError===false));assert.equal(lspCalls,7);assert.equal(prompts.length,previous+1)});
  await t.test('changes during confirmation reject the request',async()=>{const big=lines.map((x,i)=>i<1001?`const newer${i}=2;`:x);fs.writeFileSync(file,big.join('\n')+'\n');onPrompt=()=>fs.appendFileSync(file,'late change\n');const result=await host.callTool({name:'lsp_request',arguments:args});assert.equal(result.isError,true);assert.match(result.content[0].text,/repository_changed_during_confirmation/);assert.equal(lspCalls,7)});
  await t.test('clients that cannot present confirmation fail closed',async()=>{const {client,proxy}=await connectHost(false);try{const result=await client.callTool({name:'lsp_request',arguments:args});assert.equal(result.isError,true);assert.match(result.content[0].text,/confirmation_unavailable/);assert.equal(lspCalls,7)}finally{await client.close();await proxy.close()}});
  await t.test('an out-of-scope file remains blocked',async()=>{const outside=path.join(base,'outside.js');fs.writeFileSync(outside,'x\n');const result=await host.callTool({name:'lsp_request',arguments:{...args,file:outside}});assert.equal(result.isError,true);assert.equal(lspCalls,7)});
  await t.test('unscannable project permits only the explicitly confirmed call',async()=>{const large=path.join(repo,'oversized.bin');fs.writeFileSync(large,Buffer.alloc(16*1024*1024+1));const previous=prompts.length;nextAnswer='accept';const one=await host.callTool({name:'lsp_request',arguments:args});assert.equal(one.isError,false);assert.equal(lspCalls,8);assert.equal(prompts.length,previous+1);assert.match(prompts.at(-1),/仅允许这一次/);nextAnswer='decline';const two=await host.callTool({name:'lsp_request',arguments:args});assert.equal(two.isError,true);assert.equal(lspCalls,8);assert.equal(prompts.length,previous+2)});
 } finally {await host?.close();await bridge?.close();await direct.close();await new Promise(resolve=>http.close(resolve));await fixture.runtime.shutdown({graceMs:0,abortWaitMs:0})}
});
test('new proxy cannot silently use an older gateway without the confirmation gate',async()=>{
 let calls=0;const old=createGatewayApp({host:'127.0.0.1',port:0,token,roots:[repo],sandboxStatus:{ok:true,backend:'old-fixture',resourceLimits:true},lspFn:async()=>{calls++;throw Error('must not run')}});
 const listener=old.app.listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));const oldConfig=path.join(base,'old-gateway.json');fs.writeFileSync(oldConfig,JSON.stringify({host:'127.0.0.1',port:listener.address().port,tokenFile:'token.txt',roots:[repo]}));
 const client=new Client({name:'new-proxy-old-gateway-fixture',version:'1'},{capabilities:{elicitation:{form:{}}}});const [a,b]=InMemoryTransport.createLinkedPair();const proxy=await startStdioProxy({configPath:oldConfig,transport:b});
 try{await client.connect(a);assert(!(await client.listTools()).tools.some(x=>x.name==='lsp_confirmed_request'));for(const name of ['lsp_confirmed_request','lsp_request']){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true)}assert.equal(calls,0)}
 finally{await client.close();await proxy.close();await new Promise(r=>listener.close(r));await old.runtime.shutdown({graceMs:0,abortWaitMs:0})}
});
