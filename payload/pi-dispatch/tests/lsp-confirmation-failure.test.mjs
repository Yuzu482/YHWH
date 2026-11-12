import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ElicitRequestSchema,ErrorCode,McpError} from '@modelcontextprotocol/sdk/types.js';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {startStdioProxy} from '../scripts/stdio-proxy.mjs';

const tempRoot=fs.realpathSync(tmpdir()),base=fs.mkdtempSync(path.join(tempRoot,'pi-lsp-confirmation-errors-'));
test.after(()=>{
  const actual=fs.realpathSync(base),parent=fs.realpathSync(path.dirname(actual));
  if(parent.toLowerCase()!==tempRoot.toLowerCase()||!path.basename(actual).startsWith('pi-lsp-confirmation-errors-'))throw Error('unsafe fixture cleanup');
  fs.rmSync(actual,{recursive:true,force:false});
});
const token='fixture-only-token-0123456789-0123456789';
async function setup({supported=true,answer='accept',injectedError=null,hold=false}={}){
  const root=fs.mkdtempSync(path.join(base,'failure-fixture-'));
  const repo=path.join(root,'repo'),state=path.join(root,'lsp-approval'),file=path.join(repo,'sample.js');
  fs.mkdirSync(repo);execFileSync('git',['init','-q',repo],{stdio:'pipe'});fs.writeFileSync(file,'export const testSymbol=1;\n');execFileSync('git',['-C',repo,'add','sample.js'],{stdio:'pipe'});
  let calls=0,prompts=0,timeoutOption=null,releasePrompt,notifyPrompt;
  const promptReady=new Promise(resolve=>{notifyPrompt=resolve});
  const fixture=createGatewayApp({host:'127.0.0.1',port:0,token,roots:[repo],lspApprovalRoot:state,
    sandboxStatus:{ok:true,backend:'fixture-only',resourceLimits:true},schedulerOptions:{availableMemoryBytes:()=>64*1024**3,hostReserveBytes:0},
    lspFn:async()=>{calls++;return {ok:true,status:'success',requestedTool:'lsp_symbols',toolsUsed:['lsp_symbols'],unexpectedTools:[],cleanup:{ok:true}}}});
  const http=fixture.app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
  fs.writeFileSync(path.join(root,'token.txt'),token);const config=path.join(root,'gateway.json');fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:http.address().port,tokenFile:'token.txt',roots:[repo]}));
  const host=new Client({name:'fixture-host',version:'1'},{capabilities:supported?{elicitation:{form:{}}}:{}});
  if(supported)host.setRequestHandler(ElicitRequestSchema,async()=>{prompts++;notifyPrompt();if(hold)return await new Promise(resolve=>{releasePrompt=()=>resolve({action:'cancel',content:null})});return {action:answer,content:answer==='accept'?{}:null}});
  const [a,b]=InMemoryTransport.createLinkedPair(),bridge=await startStdioProxy({configPath:config,transport:b});await host.connect(a);
  if(injectedError)bridge.server.elicitInput=async(_params,options)=>{timeoutOption=options.timeout;throw injectedError};
  const invoke=signal=>host.callTool({name:'lsp_confirmed_request',arguments:{cwd:repo,file,method:'symbols',resourceProfile:'small',timeoutSeconds:5,queueTimeoutSeconds:2}},undefined,{timeout:15000,...(signal?{signal}:{})});
  const close=async()=>{releasePrompt?.();await host.close();await bridge.close();await new Promise(resolve=>http.close(resolve));await fixture.runtime.shutdown({graceMs:0,abortWaitMs:0})};
  return {invoke,close,promptReady,calls:()=>calls,prompts:()=>prompts,timeout:()=>timeoutOption,state};
}
const value=result=>result.structuredContent??JSON.parse(result.content[0].text);
for(const scenario of [
  {name:'unsupported form remains blocked',options:{supported:false},reason:'form_unsupported'},
  {name:'timeout remains blocked and is explained',options:{injectedError:new McpError(ErrorCode.RequestTimeout,'private timeout detail')},reason:'confirmation_timeout'},
  {name:'closed connection remains blocked and is explained',options:{injectedError:new McpError(ErrorCode.ConnectionClosed,'private connection detail')},reason:'connection_closed'},
  {name:'unexpected client failure is sanitized and blocked',options:{injectedError:new Error('private marker must not escape')},reason:'client_error'},
]) test(scenario.name,async()=>{
  const f=await setup(scenario.options);try{const r=await f.invoke(),v=value(r);assert.equal(r.isError,true);assert.equal(v.error,'confirmation_unavailable');assert.equal(v.reason,scenario.reason);assert.equal(f.calls(),0);assert(!JSON.stringify(r).includes('private'));if(scenario.options.injectedError)assert.equal(f.timeout(),180000);}finally{await f.close()}
});
test('declined confirmation never runs a query or records a baseline',async()=>{
  const f=await setup({answer:'decline'});try{const r=await f.invoke();assert.equal(value(r).error,'confirmation_declined');assert.equal(f.calls(),0);assert.equal(f.prompts(),1);assert(!fs.existsSync(f.state)||!fs.readdirSync(f.state).some(name=>/^[a-f0-9]{64}\.json$/.test(name)));}finally{await f.close()}
});
test('cancelled request does not turn a pending prompt into permission',async()=>{
  const f=await setup({hold:true}),controller=new AbortController();try{
    const pending=f.invoke(controller.signal);await f.promptReady;controller.abort();await assert.rejects(pending);
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.calls(),0);
    assert(!fs.existsSync(f.state)||!fs.readdirSync(f.state).some(name=>/^[a-f0-9]{64}\.json$/.test(name)));
  }finally{await f.close()}
});
test('accepted confirmation runs once and subsequent query needs no prompt',async()=>{
  const f=await setup();try{assert.equal(value(await f.invoke()).ok,true);assert.equal(value(await f.invoke()).ok,true);assert.equal(f.calls(),2);assert.equal(f.prompts(),1);}finally{await f.close()}
});
