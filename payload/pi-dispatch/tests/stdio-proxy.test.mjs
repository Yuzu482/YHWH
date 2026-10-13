import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {startStdioProxy,readProxyConfig} from '../scripts/stdio-proxy.mjs';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {listenHttpFixture} from './http-fixture.mjs';

test('native bridge preserves UI metadata/resources and shares the HTTP monitor instance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-proxy-test-')),token='fixture-private-token-0123456789abcdef';
 const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[resolve('.')],token,sandboxStatus:{ok:true,backend:'fixture',resourceLimits:true}});
 const http=await listenHttpFixture(app);
 let bridge;const client=new Client({name:'fixture-ui-host',version:'1.0.0'});
 try{
  writeFileSync(join(dir,'token.txt'),token);const configPath=join(dir,'config.json');writeFileSync(configPath,JSON.stringify({host:'127.0.0.1',port:http.address().port,tokenFile:'token.txt'}));
  const [a,b]=InMemoryTransport.createLinkedPair();bridge=await startStdioProxy({configPath,transport:b});await client.connect(a);
  const listed=await client.listTools();assert.ok(listed.tools.find(tool=>tool.name==='render_subagent_monitor')._meta.ui.resourceUri);
  const workflow=await client.callTool({name:'get_workflow',arguments:{topic:'primary'}});
  assert.equal(JSON.parse(workflow.content[0].text).topic,'primary');
  assert.equal(listed.tools.find(tool=>tool.name==='list_subagents')._meta['openai/widgetAccessible'],true);
  const resource=await client.readResource({uri:'ui://pi-kether/subagent-monitor.html'});assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');assert.match(resource.contents[0].text,/ui\/notifications\/tool-result/);
  assert.equal(resource.contents[0]._meta['openai/widgetShowCodexWidgetInline'],true);
  assert.equal(resource.contents[0]._meta['openai/widgetMinFrameHeight'],240);
  const result=await client.callTool({name:'render_subagent_monitor',arguments:{limit:10}});
  assert.equal(result.structuredContent.gateway.instanceId,runtime.gatewayInstanceId);
  assert.equal(result.structuredContent.ok,true);
  await bridge.close();assert.equal(runtime.capabilities().accepting,true);
 }finally{await client.close();await bridge?.close();await new Promise(r=>http.close(r));rmSync(dir,{recursive:true,force:true});}
});
test('native bridge refuses a remote token destination',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-proxy-config-'));
 try{const path=join(dir,'config.json');writeFileSync(path,JSON.stringify({host:'example.com',port:7331,tokenFile:'unused'}));assert.throws(()=>readProxyConfig(path),/loopback/);}
 finally{rmSync(dir,{recursive:true,force:true});}
});

test('two fresh stdio proxies share HTTP identity and can reconnect without disposing the gateway',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-shared-reconnect-')),token='fixture-private-token-0123456789abcdef';
 const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[resolve('.')],token,sandboxStatus:{ok:true,backend:'fixture',resourceLimits:true}}),http=await listenHttpFixture(app);
 try{
  writeFileSync(join(dir,'token.txt'),token);const configPath=join(dir,'config.json');writeFileSync(configPath,JSON.stringify({host:'127.0.0.1',port:http.address().port,tokenFile:'token.txt'}));
  for(let i=0;i<2;i++){
   const client=new Client({name:'fresh-shared-client',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('scripts/stdio-server.mjs')],env:{...process.env,PI_GATEWAY_CONFIG:configPath},stderr:'pipe'});
   try{await client.connect(transport);const result=await client.callTool({name:'list_subagents',arguments:{limit:1}});assert.equal(result.structuredContent.gateway.instanceId,runtime.gatewayInstanceId);const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='abandon_artifact'));}finally{await client.close();}
   assert.equal(runtime.capabilities().accepting,true);
  }
 }finally{await runtime.shutdown();await new Promise(r=>http.close(r));rmSync(dir,{recursive:true,force:true});}
});

test('configured shared stdio fails on unavailable HTTP and never falls back to standalone',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-shared-unavailable-'));
 try{
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[resolve('.')],token:'fixture-private-token-0123456789abcdef'}),http=await listenHttpFixture(app),port=http.address().port;await runtime.shutdown();await new Promise(r=>http.close(r));
  writeFileSync(join(dir,'token.txt'),'fixture-private-token-0123456789abcdef');const configPath=join(dir,'config.json');writeFileSync(configPath,JSON.stringify({host:'127.0.0.1',port,tokenFile:'token.txt'}));
  const child=spawn(process.execPath,[resolve('scripts/stdio-server.mjs')],{env:{...process.env,PI_GATEWAY_CONFIG:configPath,PI_GATEWAY_ROOTS:JSON.stringify([dir]),PI_GATEWAY_AUDIT_FILE:join(dir,'audit.jsonl'),PI_GATEWAY_PROVIDER_CIRCUIT_FILE:join(dir,'circuit.jsonl'),PI_GATEWAY_REQUEST_LEDGER_DIR:join(dir,'ledger')},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let error='';child.stderr.on('data',b=>{error+=b.toString();});child.stdin.end();
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},10000);
  try{const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);});assert.equal(timedOut,false);assert.equal(code,1);assert.match(error,/Shared Pi gateway unavailable/);assert.equal(existsSync(join(dir,'ledger')),false);}finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('shared proxy cannot authenticate with a wrong token and never returns token text',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-proxy-auth-')),token='fixture-real-token-0123456789abcdef',wrong='fixture-wrong-token-0123456789abcdef';
 const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[resolve('.')],token}),http=await listenHttpFixture(app);
 try{writeFileSync(join(dir,'token.txt'),wrong);const configPath=join(dir,'config.json');writeFileSync(configPath,JSON.stringify({host:'127.0.0.1',port:http.address().port,tokenFile:'token.txt'}));const [a,b]=InMemoryTransport.createLinkedPair();
  try{await assert.rejects(startStdioProxy({configPath,transport:b}),error=>{assert.ok(!error.message.includes(token));assert.ok(!error.message.includes(wrong));return /unavailable/.test(error.message);});}finally{await a.close();await b.close();}
  assert.equal(runtime.capabilities().active,0);
 }finally{await runtime.shutdown();await new Promise(r=>http.close(r));rmSync(dir,{recursive:true,force:true});}
});
