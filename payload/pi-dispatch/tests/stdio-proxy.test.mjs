import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {startStdioProxy,readProxyConfig} from '../scripts/stdio-proxy.mjs';
import {createGatewayApp} from '../scripts/gateway.mjs';

test('native bridge preserves UI metadata/resources and shares the HTTP monitor instance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-proxy-test-')),token='fixture-private-token-0123456789abcdef';
 const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[resolve('.')],token,sandboxStatus:{ok:true,backend:'fixture',resourceLimits:true}});
 const http=await new Promise(resolveServer=>{const server=app.listen(0,'127.0.0.1',()=>resolveServer(server));});
 let bridge;const client=new Client({name:'fixture-ui-host',version:'1.0.0'});
 try{
  writeFileSync(join(dir,'token.txt'),token);const configPath=join(dir,'config.json');writeFileSync(configPath,JSON.stringify({host:'127.0.0.1',port:http.address().port,tokenFile:'token.txt'}));
  const [a,b]=InMemoryTransport.createLinkedPair();bridge=await startStdioProxy({configPath,transport:b});await client.connect(a);
  const listed=await client.listTools();assert.ok(listed.tools.find(tool=>tool.name==='render_subagent_monitor')._meta.ui.resourceUri);
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
