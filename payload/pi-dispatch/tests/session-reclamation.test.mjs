import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createResponseSessionRegistry,registerMcpResponseCleanup,createGatewayApp,createGatewayRuntime} from '../scripts/gateway.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const options=()=>({host:'127.0.0.1',port:0,token:'session-test-token-'.repeat(3),roots:[process.cwd()],schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER}});

test('session teardown attempts both closes, surfaces errors, and removes listeners',async()=>{
  const registry=createResponseSessionRegistry(),res=new EventEmitter();let closes=0;
  const cleanup=registerMcpResponseCleanup(res,{close(){closes++;throw Error('private error text');}},{async close(){closes++;}},registry);
  res.emit('finish');await assert.rejects(cleanup(),/cleanup failed/);
  assert.equal(cleanup(),cleanup());assert.equal(closes,2);assert.equal(res.listenerCount('finish'),0);
  assert.equal(res.listenerCount('close'),0);assert.equal(res.listenerCount('error'),0);
  const state=await registry.drain(10);assert.equal(state.active,0);assert.equal(state.failed,1);
  assert.equal(state.reason,'cleanup-failed');assert.equal(JSON.stringify(state).includes('private'),false);
});

test('hung cleanup remains owned, retry joins same promise and no dependencies dispose early',async()=>{
  const runtime=createGatewayRuntime(options());let finish,closes=0;
  const close=runtime.responseSessions.register(()=>{closes++;return new Promise(resolve=>{finish=resolve;});});
  const a=await runtime.shutdown({graceMs:0,abortWaitMs:15});
  assert.equal(a.disposed,false);assert.equal(a.code,'PI_SESSION_DRAIN_INCOMPLETE');
  assert.equal(a.sessionCleanup.active,1);assert.equal(runtime.capabilities().lifecycle.state,'ready');
  const first=close(),second=close();assert.equal(first,second);assert.equal(closes,1);
  finish();await first;const b=await runtime.shutdown({graceMs:0,abortWaitMs:20});
  assert.equal(b.disposed,true);assert.equal(b.sessionCleanup.active,0);assert.equal(closes,1);
});

test('failed cleanup prevents successful shutdown without silently retrying',async()=>{
  const runtime=createGatewayRuntime(options());let closes=0;
  runtime.responseSessions.register(()=>{closes++;throw Error('close failed');});
  for(let i=0;i<2;i++){const result=await runtime.shutdown({graceMs:0,abortWaitMs:20});assert.equal(result.disposed,false);assert.equal(result.code,'PI_SESSION_CLEANUP_FAILED');}
  assert.equal(closes,1);
  // No child execution or unique result exists; directly close the monitor timer
  // for this deliberately unrecoverable fixture only.
  runtime.taskMonitor.close();
});

test('zero deadline still drains already settled response resources',async()=>{
  const runtime=createGatewayRuntime(options());let closes=0;
  runtime.responseSessions.register(()=>{closes++;});
  const result=await runtime.shutdown({graceMs:0,abortWaitMs:0});
  assert.equal(result.disposed,true);assert.equal(closes,1);
});

test('requests after closing admission allocate no response session',async()=>{
  const {app,runtime}=createGatewayApp(options());const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try{
    await runtime.shutdown({graceMs:0,abortWaitMs:0});
    const response=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{Authorization:'Bearer '+options().token,'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,503);assert.equal(runtime.responseSessions.stats.completed,0);assert.equal(runtime.responseSessions.stats.active,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('protected RAM results retain recovery reads while new model requests stay closed',async()=>{
  let durable=false,disposed=0;
  const unique={value:'unique-protected-fixture'};
  const monitor={size:0,list:()=>[],drain:async()=>({pendingWrites:durable?0:1,protectedResults:durable?0:1,lossRisk:!durable,timedOut:!durable}),close(){disposed++;}};
  const {app,runtime}=createGatewayApp({...options(),taskMonitor:monitor,ownedModules:['taskMonitor']});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const client=new Client({name:'protected-result-reader',version:'1'});
  try{
    const before=await runtime.shutdown({graceMs:0,abortWaitMs:10});assert.equal(before.code,'PI_RESULT_DRAIN_UNSAFE');assert.equal(disposed,0);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+options().token}}}));
    const caps=await client.callTool({name:'list_capabilities',arguments:{}});assert.equal(caps.isError,false);
    for(const name of ['get_subagent_result','get_subagent_status','get_task_handoff','cancel_subagent'])assert.equal(runtime.acceptsMcpRequests({method:'tools/call',params:{name}}),true);
    const blocked=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{Authorization:'Bearer '+options().token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'submit_subagent',arguments:{}}})});
    assert.equal(blocked.status,503);assert.equal(unique.value,'unique-protected-fixture');
    await client.close();durable=true;assert.equal((await runtime.shutdown({graceMs:0,abortWaitMs:20})).disposed,true);assert.equal(disposed,1);
  }finally{await client.close().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('500 sequential sessions and 50 concurrent rounds reclaim all response references',async()=>{
  const registry=createResponseSessionRegistry();let closes=0;
  const run=async()=>{const res=new EventEmitter();const clean=registerMcpResponseCleanup(res,{close(){closes++;}},{async close(){closes++;}},registry);res.emit('finish');res.emit('close');await clean();assert.equal(res.eventNames().length,0);};
  for(let i=0;i<500;i++)await run();
  for(let i=0;i<50;i++){await Promise.all(Array.from({length:16},run));assert.equal(registry.stats.active,0);assert.equal(registry.stats.pendingCleanup,0);}
  assert.equal(closes,2600);assert.equal(registry.stats.completed,1300);assert.equal(registry.stats.failed,0);
});
