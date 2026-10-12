import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskMonitor} from '../extensions/task-monitor.js';
import {createRequestLedger} from '../extensions/request-ledger.js';
import {createGatewayApp,gracefulShutdownHttp} from '../scripts/gateway.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {listenHttpFixture} from './http-fixture.mjs';
import {roleValue} from './contract-fixtures.mjs';
import {ResourceAwareExecutor} from '../extensions/admission-scheduler.js';
const base={requestId:'pressure-one',parentRunId:'pressure-parent',provider:'openai-codex',model:'gpt-6-luna',access:'read',task:{role:'Chesed',objective:'Read fixture'}};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('durable reloadable results release full RAM bodies, including synchronous summaries',async()=>{
  const disk=new Map(),m=createTaskMonitor({gatewayInstanceId:'durable-release',maintenanceIntervalMs:0,
    persistResult:(id,v)=>{disk.set(id,v);return true;},loadResult:id=>disk.get(id)});
  try {
    const full=id=>{let json='',offset=0;do{const page=m.getResult(id,{offset,limit:65536});assert.equal(page.ready,true);json+=page.result?JSON.stringify(page.result):page.resultJsonChunk;offset=page.nextOffset;}while(offset!==null);return JSON.parse(json);};
    m.retainResult(base,{ok:true,patch:'x'.repeat(262144),result:'large body'});
    assert.equal(m.resultCache.retainedBytes,0);
    assert.equal(m.resultCache.protectedResults,0);
    assert.equal(full(base.requestId).patch.length,262144);
    assert.equal(m.get(base.requestId).outcome.ok,true);
    m.submit({...base,requestId:'async-durable'},async()=>({ok:true,patch:'y'.repeat(262144)}));
    await m.wait('async-durable');await turn();
    assert.equal(m.resultCache.retainedBytes,0);
    assert.equal(full('async-durable').patch.length,262144);
  }finally{m.close();}
});

test('false/throw/async rejection protects the only copy, blocks intake and permits exact replay',async()=>{
  for(const persistResult of [()=>false,()=>{throw Error('private path');},async()=>false,async()=>{throw Error('private path');}]){
    const m=createTaskMonitor({gatewayInstanceId:'failure',persistResult,maintenanceIntervalMs:0});
    try {m.submit(base,async()=>({ok:true,patch:'only-copy'}));await m.wait(base.requestId);await turn();
      assert.equal(m.resultCache.degradedReason,'storage_unavailable');assert.equal(m.resultCache.protectedResults,1);
      assert.throws(()=>m.submit({...base,requestId:'new'},()=>{}),{code:'PI_RESULT_STORAGE_UNAVAILABLE'});
      assert.equal(m.submit(base,()=>assert.fail('replayed model')).replayed,true);
      assert.equal(m.getResult(base.requestId).result.patch,'only-copy');assert.equal(m.resultCache.reservations,0);
      assert.ok(!JSON.stringify(m.resultCache).includes('private path'));
    }finally{m.close();}
  }
});

test('entry reservation is atomic under a burst and release is idempotent',async()=>{
  const m=createTaskMonitor({gatewayInstanceId:'burst',maxEntries:16,maintenanceIntervalMs:0});let release;
  const pending=new Promise(resolve=>{release=resolve;});
  try {for(let i=0;i<16;i++)m.submit({...base,requestId:'burst-'+i},async()=>{await pending;return {ok:true};});
    assert.equal(m.resultCache.reservations,16);
    for(let i=0;i<30;i++)assert.throws(()=>m.submit({...base,requestId:'overflow-'+i},()=>{}),{code:'PI_RESULT_CACHE_PRESSURE'});
    release();await Promise.all(Array.from({length:16},(_,i)=>m.wait('burst-'+i)));await turn();
    assert.equal(m.resultCache.reservations,0);assert.ok(m.resultCache.entries<=16);
    const token=m.reserve({...base,requestId:'sync'});m.release(token);m.release(token);assert.equal(m.resultCache.reservations,0);
  }finally{release();m.close();}
});

test('pending completion ownership, cancellation, runner throws and serialization failures release slots',async()=>{
  const m=createTaskMonitor({gatewayInstanceId:'exits',maintenanceIntervalMs:0,persistResult:()=>true});
  try {
    for(const [id,fn] of [['throw',async()=>{throw Error('worker failure');}],['serialize',async()=>({bad:1n})]]){
      m.submit({...base,requestId:id},fn);await m.wait(id);await turn();assert.equal(m.resultCache.reservations,0);assert.equal(m.get(id).state,'failed');
    }
    m.submit({...base,requestId:'cancel'},async signal=>{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {ok:false};});
    await turn();m.cancel('cancel');await m.wait('cancel');await turn();assert.equal(m.resultCache.reservations,0);
    m.close();assert.throws(()=>m.submit({...base,requestId:'after-close'},()=>{}),{code:'PI_GATEWAY_CLOSED'});
  }finally{m.close();}
});

test('deferred persistence keeps capacity counted and host revision cannot be marked durable by an old write',async()=>{
  const writes=[],m=createTaskMonitor({gatewayInstanceId:'revision',maintenanceIntervalMs:0,persistResult:(id,value)=>new Promise(resolve=>writes.push({id,value,resolve}))});
  try {m.submit(base,async()=>({ok:false,status:'awaiting-host-verification',patch:'old'}));await m.wait(base.requestId);await turn();
    assert.equal(m.resultCache.pendingWrites,1);assert.equal(m.resultCache.protectedResults,1);assert.equal(m.resultCache.reservations,0);
    m.resolveHostVerification(base.requestId,{ok:true,state:'completed',status:'completed',patch:'verified'});
    writes[0].resolve(true);await turn();assert.equal(writes.length,2);assert.equal(m.resultCache.protectedResults,1);
    assert.equal(writes[1].value.result.patch,'verified');writes[1].resolve(true);await turn();assert.equal(m.resultCache.protectedResults,0);
  }finally{for(const w of writes)w.resolve(true);m.close();}
});

test('existing maintenance retries failed copies with bounded work and recovers intake',async()=>{
  let healthy=false,attempts=0;
  const m=createTaskMonitor({gatewayInstanceId:'recovery',maintenanceIntervalMs:10,persistResult:()=>{attempts++;return healthy;}});
  try {m.submit(base,async()=>({ok:true,patch:'copy'}));await m.wait(base.requestId);await turn();assert.equal(m.resultCache.accepting,false);
    healthy=true;await delay(60);assert.equal(m.resultCache.accepting,true);assert.equal(m.resultCache.protectedResults,0);assert.ok(attempts<=3);
    m.submit({...base,requestId:'after-recovery'},async()=>({ok:true}));await m.wait('after-recovery');
  }finally{m.close();}
});

test('queued admission recheck prevents quota callback and releases acquired resources',async()=>{
  const m=createTaskMonitor({gatewayInstanceId:'queue-guard',maintenanceIntervalMs:0,persistResult:()=>false});
  const executor=new ResourceAwareExecutor(1,16,{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5});
  let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});let quotaReservations=0;
  const active=executor.run(async()=>{entered();await new Promise(resolve=>{release=resolve;});return 'active';},1000);
  await enteredPromise;
  const queued=executor.run(async()=>{m.assertCanStart();quotaReservations++;return 'must not run';},1000,null,{canRun:()=>{m.assertCanStart();return true;}});
  const rejected=assert.rejects(queued,{code:'PI_RESULT_STORAGE_UNAVAILABLE'});
  m.retainResult(base,{ok:true,patch:'only copy'});release();await active;await rejected;
  assert.equal(quotaReservations,0);assert.equal(executor.state.queued,0);assert.equal(m.getResult(base.requestId).result.patch,'only copy');
  await executor.shutdown({graceMs:100,abortWaitMs:100});m.close();
});

test('a start-time guard failure releases an acquired write lock before any quota callback',async()=>{
  const executor=new ResourceAwareExecutor(1,16,{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5});let locks=0,quota=0;
  const error=Object.assign(new Error('PI_RESULT_STORAGE_UNAVAILABLE'),{code:'PI_RESULT_STORAGE_UNAVAILABLE',modelExecutionStarted:false});
  await assert.rejects(executor.run(async()=>{throw error;quota++;},1000,null,{canRun:()=>true,acquire:()=>{locks++;return {};},release:()=>{locks--;}}),{code:'PI_RESULT_STORAGE_UNAVAILABLE'});
  await turn();assert.equal(locks,0);assert.equal(quota,0);await executor.shutdown({graceMs:100,abortWaitMs:100});
});

test('queue timeout and queued cancellation release monitor reservations',async()=>{
  const m=createTaskMonitor({gatewayInstanceId:'queue-exits',maintenanceIntervalMs:0}),executor=new ResourceAwareExecutor(1,16,{availableMemoryBytes:()=>0,pollIntervalMs:5});
  try {
    m.submit({...base,requestId:'timeout'},signal=>executor.run(async()=>assert.fail('not runnable'),1000,signal,{queueTimeoutMs:10,memoryBytes:1}));
    await m.wait('timeout');await turn();assert.equal(m.resultCache.reservations,0);
    m.submit({...base,requestId:'cancel-queued'},signal=>executor.run(async()=>assert.fail('not runnable'),1000,signal,{queueTimeoutMs:1000,memoryBytes:1}));
    await turn();m.cancel('cancel-queued');await m.wait('cancel-queued');await turn();assert.equal(m.resultCache.reservations,0);
  }finally{await executor.shutdown({graceMs:0,abortWaitMs:100});m.close();}
});

test('async disk persistence survives bounded drain and restart; corrupt records stay unavailable',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-pressure-disk-')),ledger=createRequestLedger(dir);
  const m=createTaskMonitor({gatewayInstanceId:'disk',maintenanceIntervalMs:0,persistResult:(id,v)=>ledger.saveMonitorResultAsync(id,v),loadResult:id=>ledger.readMonitorResult(id)});
  try {m.submit(base,async()=>({ok:true,patch:'durable-copy'}));await m.wait(base.requestId);
    const drained=await m.drain({timeoutMs:2000});assert.equal(drained.lossRisk,false);m.close();ledger.close();
    const restarted=createRequestLedger(dir),restored=createTaskMonitor({gatewayInstanceId:'restart',maintenanceIntervalMs:0,loadResult:id=>restarted.readMonitorResult(id)});
    assert.equal(restored.getResult(base.requestId).result.patch,'durable-copy');
    const file=fs.readdirSync(path.join(dir,'result-cache')).find(f=>f.endsWith('.json'));fs.writeFileSync(path.join(dir,'result-cache',file),'corrupt');
    assert.equal(restored.getResult(base.requestId).ok,false);restored.close();restarted.close();
  }finally{m.close();ledger.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('drain reports loss risk within deadline and close starts no extra persistence',async()=>{
  let calls=0;
  const m=createTaskMonitor({gatewayInstanceId:'hanging',maintenanceIntervalMs:0,persistResult:()=>{calls++;return new Promise(()=>{});}});
  m.submit(base,async()=>({ok:true,patch:'only'}));await m.wait(base.requestId);
  const start=Date.now(),result=await m.drain({timeoutMs:30});assert.equal(result.lossRisk,true);assert.equal(result.timedOut,true);assert.ok(Date.now()-start<500);
  m.close();assert.equal(calls,1);assert.equal(m.getResult(base.requestId).result.patch,'only');
});

test('oversized sole copy is reported and no new operations are admitted',async()=>{
  const m=createTaskMonitor({gatewayInstanceId:'oversized',maintenanceIntervalMs:0,persistResult:()=>false});
  try {m.submit(base,async()=>({ok:true,patch:'x'.repeat(32*1024*1024+1)}));await m.wait(base.requestId);await turn();
    assert.equal(m.resultCache.degradedReason,'oversized_result');assert.ok(m.resultCache.oversizedBytes>32*1024*1024);
    assert.throws(()=>m.reserve({...base,requestId:'next'}),{code:'PI_RESULT_STORAGE_UNAVAILABLE'});
    assert.equal(m.resultCache.entries,1);assert.equal(m.resultCache.reservations,0);
  }finally{m.close();}
});

test('real MCP synchronous/asynchronous admission rejects before model launch under disk fault',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-pressure-http-')),token='pressure-fixture-01234567890123456789';let launches=0;
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[dir],token,requestLedgerDir:path.join(dir,'ledger'),
    sandboxStatus:{ok:true,backend:'fixture',resourceLimits:true},schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5},
    dispatchFn:async(request,signal,task)=>{launches++;return {ok:true,provider:request.provider,model:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(roleValue(task.role))};}});
  const server=await listenHttpFixture(app),client=new Client({name:'pressure-test',version:'1'});
  try {await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    fs.renameSync(path.join(dir,'ledger/result-cache'),path.join(dir,'ledger/cache-backup'));fs.writeFileSync(path.join(dir,'ledger/result-cache'),'disk-fault');
    runtime.taskMonitor.retainResult(base,{ok:true,patch:'only-copy'});await delay(50);
    assert.equal(runtime.capabilities().resultCache.degradedReason,'storage_unavailable');assert.equal(runtime.capabilities().accepting,false);
    for(const name of ['dispatch_subagent','submit_subagent']){
      const response=await client.callTool({name,arguments:{...base,requestId:name,cwd:dir,resourceProfile:'small'}});
      const value=response.structuredContent??JSON.parse(response.content[0].text);
      assert.equal(value.code,'PI_RESULT_STORAGE_UNAVAILABLE');assert.equal(value.modelExecutionStarted,false);
    }
    assert.equal(launches,0);assert.equal(runtime.taskMonitor.getResult(base.requestId).result.patch,'only-copy');
  }finally{
    await client.close();
    fs.unlinkSync(path.join(dir,'ledger/result-cache'));fs.renameSync(path.join(dir,'ledger/cache-backup'),path.join(dir,'ledger/result-cache'));
    try{await runtime.shutdown({graceMs:100,abortWaitMs:100});}finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('unsafe shutdown preserves the HTTP reader and dependencies until persistence recovers',async()=>{
  let healthy=false;
  const m=createTaskMonitor({gatewayInstanceId:'shutdown-recovery',maintenanceIntervalMs:10,persistResult:()=>healthy});
  const token='shutdown-recovery-01234567890123456789';
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[os.tmpdir()],token,taskMonitor:m,sandboxStatus:{ok:false}});
  const server=await listenHttpFixture(app);
  try {
    m.retainResult(base,{ok:true,patch:'only-copy'});
    await assert.rejects(gracefulShutdownHttp(server,runtime,{graceMs:0,abortWaitMs:50}),{code:'PI_RESULT_DRAIN_UNSAFE'});
    assert.equal(server.listening,true);assert.equal(runtime.capabilities().lifecycle.phase,'draining');
    assert.equal(m.getResult(base.requestId).result.patch,'only-copy');
    healthy=true;await delay(60);assert.equal(m.resultCache.protectedResults,0);
    const result=await gracefulShutdownHttp(server,runtime,{graceMs:0,abortWaitMs:50});assert.equal(result.disposed,true);assert.equal(server.listening,false);
  }finally{m.close();if(server.listening)await new Promise(resolve=>server.close(resolve));}
});
