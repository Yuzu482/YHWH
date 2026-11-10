import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync,deflateSync,brotliCompressSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGatewayApp } from '../scripts/gateway.mjs';
import { startStdioProxy } from '../scripts/stdio-proxy.mjs';
import { listenHttpFixture } from './http-fixture.mjs';

const token='fixture-token-0123456789-0123456789-abcdef';
const options={host:'127.0.0.1',port:0,roots:[resolve('.')],token,sandboxStatus:{ok:true,backend:'fixture',resourceLimits:true}};
const oversized={topic:'primary',ignored:Array(32769).fill(0)};
const okWorkflow=async client=>{const r=await client.callTool({name:'get_workflow',arguments:{topic:'primary'}});assert.equal(JSON.parse(r.content[0].text).topic,'primary');};
const rejectsExcess=async client=>{const r=await client.callTool({name:'get_workflow',arguments:oversized});assert.equal(r.isError,true);assert.match(r.content[0].text,/maximum of 32768 elements/);};

test('direct makeServer enforces argument element limit and accepts ordinary calls',async()=>{
 const {runtime}=createGatewayApp(options);const server=runtime.makeServer();const client=new Client({name:'direct-fixture',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try{await server.connect(b);await client.connect(a);await okWorkflow(client);await rejectsExcess(client);await okWorkflow(client);}
 finally{await client.close();await server.close();}
});

test('a representative high-density editor grant passes the element guard',async()=>{
 const {runtime}=createGatewayApp({...options,dispatchFn:async()=>{throw Error('dispatch must not run');}});const server=runtime.makeServer();const client=new Client({name:'large-grant-fixture',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(b);await client.connect(a);
  const operations=Array.from({length:4},(_,i)=>({id:`test${i}`,editor:'blender',tool:'blender_scene_info',args:{values:Array(3500).fill(0)}}));
  const editorAuthorization={version:1,expiresAt:new Date(Date.now()+60000).toISOString(),operations};
  assert.ok(Buffer.byteLength(JSON.stringify(editorAuthorization))<32768);
  const result=await client.callTool({name:'dispatch_subagent',arguments:{cwd:resolve('.'),provider:'openai-codex',model:'gpt-6-luna',access:'read',task:{role:'Malkuth',objective:'fixture',acceptance:['Read fixture'],readScope:['README.md']},editorAuthorization}});
  assert.doesNotMatch(JSON.stringify(result),/maximum of 32768 elements|Input validation error/);
  assert.equal(result.isError,true);
 }finally{await client.close();await server.close();}
});

test('HTTP and stdio proxy enforce limit, preserve authentication and reject oversize bodies',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mcp-input-budget-'));const {app}=createGatewayApp(options);const http=await listenHttpFixture(app);const port=http.address().port;
 const client=new Client({name:'http-fixture',version:'1'});const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
 let bridge,proxyClient;
 try{
  const unauthorized=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
  const bodyLimit=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({data:'x'.repeat(110*1024)})});assert.equal(bodyLimit.status,413);
  const chunkedStatus=await new Promise((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','transfer-encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('{"data":"');req.write('x'.repeat(110*1024));req.end('"}');});assert.equal(chunkedStatus,413);
  const wrongType=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'text/plain',accept:'application/json, text/event-stream'},body:'{}'});assert.equal(wrongType.status,415);
  await client.connect(transport);await okWorkflow(client);await rejectsExcess(client);await okWorkflow(client);
  writeFileSync(join(dir,'token.txt'),token);const config=join(dir,'config.json');writeFileSync(config,JSON.stringify({host:'127.0.0.1',port,tokenFile:'token.txt'}));
  proxyClient=new Client({name:'proxy-fixture',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();bridge=await startStdioProxy({configPath:config,transport:b});await proxyClient.connect(a);
  await okWorkflow(proxyClient);await rejectsExcess(proxyClient);await okWorkflow(proxyClient);
 }finally{await proxyClient?.close();await bridge?.close();await client.close();await new Promise(r=>http.close(r));rmSync(dir,{recursive:true,force:true});}
});

for(const [encoding,compress] of [['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]]) test(`authenticated ${encoding} with delayed chunked trailing bytes cannot crash gateway`,async()=>{
 const {app}=createGatewayApp(options);const http=await listenHttpFixture(app);const port=http.address().port;
 const payload=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:42,method:'tools/call',params:{name:'get_workflow',arguments:{topic:'primary'}}}));
 const post=body=>fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-encoding':encoding,accept:'application/json, text/event-stream'},body});
 try{
  const valid=await post(compress(payload));assert.equal(valid.status,200);
  const zipBomb=compress(Buffer.from(JSON.stringify({data:'x'.repeat(110*1024)})));const limited=await post(zipBomb);assert.equal(limited.status,413);
  const compressed=compress(payload),tail=Buffer.from([1,2,3,4]);
  const delayed=await new Promise((resolve,reject)=>{
   const req=httpRequest({host:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-encoding':encoding,accept:'application/json, text/event-stream','transfer-encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
   req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('probe timeout')));req.write(compressed);setTimeout(()=>req.end(tail),75);
  });assert.ok([200,400].includes(delayed));
  await new Promise(r=>setTimeout(r,100));assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
 }finally{await new Promise(r=>http.close(r));}
});
