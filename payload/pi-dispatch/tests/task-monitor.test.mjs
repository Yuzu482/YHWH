import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskMonitor } from '../extensions/task-monitor.js';

const base = {
  requestId: 'monitor-1', parentRunId: 'parent-1', provider: 'openai-codex', model: 'gpt-5.6-luna',
  access: 'read', resourceProfile: 'small', priority: 5, dependsOnRequestIds: [], task: { role: 'worker', objective: 'bounded task' },
};

test('memory-only monitor enforces count and byte budgets without a persistence callback', async()=>{
  const monitor=createTaskMonitor({gatewayInstanceId:'memory-count',maxEntries:16,maintenanceIntervalMs:0});
  const budget=createTaskMonitor({gatewayInstanceId:'memory-bytes',maxResultBytes:1,maintenanceIntervalMs:0});
  try {
    for(let i=0;i<19;i++) {
      const id=`memory-${i}`;
      monitor.submit({...base,requestId:id},async()=>({ok:true,patch:'bounded'}));
      assert.equal((await monitor.wait(id)).ready,true);
    }
    assert.equal(monitor.size,16);
    assert.equal(monitor.getResult('memory-0').code,'RESULT_NOT_FOUND');
    assert.equal(monitor.getResult('memory-18').result.patch,'bounded');
    budget.submit(base,async()=>({ok:true,patch:'large'.repeat(100)}));
    assert.equal((await budget.wait(base.requestId)).ready,true);
    assert.equal(budget.getResult(base.requestId).code,'RESULT_NOT_FOUND');
    assert.equal(budget.get(base.requestId).state,'completed');
  } finally {monitor.close();budget.close();}
});

test('memory-only maintenance expires completed results while retaining active work', async()=>{
  const monitor=createTaskMonitor({gatewayInstanceId:'memory-ttl',terminalTtlMs:20,maintenanceIntervalMs:5});
  let release;
  try {
    monitor.submit({...base,requestId:'active'},async(_signal,running)=>{running();await new Promise(resolve=>{release=resolve;});return {ok:true};});
    monitor.submit(base,async()=>({ok:true,patch:'expire'}));
    assert.equal((await monitor.wait(base.requestId)).ready,true);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(monitor.get(base.requestId),null);
    assert.equal(monitor.get('active').state,'running');
  } finally {release?.();monitor.close();}
});

test('configured persistence failure keeps the only copy despite count, TTL and byte pressure', async()=>{
  for(const persistResult of [()=>false,()=>{throw Error('storage offline');}]) {
    const monitor=createTaskMonitor({gatewayInstanceId:'failed-storage',maxEntries:16,terminalTtlMs:0,maxResultBytes:1,maintenanceIntervalMs:0,persistResult});
    try {
      for(let i=0;i<19;i++) {const id=`failed-${i}`;monitor.submit({...base,requestId:id},async()=>({ok:true,patch:'only-copy'}));await monitor.wait(id);}
      assert.equal(monitor.size,19);
      assert.equal(monitor.getResult('failed-0').result.patch,'only-copy');
    } finally {monitor.close();}
  }
});

test('task monitor deduplicates stable request IDs and rejects conflicting reuse', async () => {
  const monitor = createTaskMonitor({ gatewayInstanceId: 'gateway-1' });
  let release;
  const first = monitor.submit(base, async (_signal, running) => {
    running();
    await new Promise(resolvePromise => { release = resolvePromise; });
    return { response: { ok: true, provider: 'openai-codex', model: 'gpt-5.6-luna', toolsUsed: [] }, isError: false };
  });
  assert.equal(first.accepted, true);
  assert.equal(first.task.role, 'worker');
  assert.equal(first.task.displayName, 'Implementer');
  assert.equal(first.task.displayNameZh, '实现开发');
  while (!release) await new Promise(resolvePromise => setImmediate(resolvePromise));
  const replay = monitor.submit(base, async () => { throw new Error('must not run'); });
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.state, 'running');
  assert.throws(() => monitor.submit({ ...base, model: 'different' }, async () => {}), /different monitored task/);
  release();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(monitor.get(base.requestId).state, 'completed');
});

test('result byte budget persists before releasing settled results and keeps summaries', async () => {
  const saved=new Map();
  const monitor=createTaskMonitor({gatewayInstanceId:'gateway-cache',maxResultBytes:32,maintenanceIntervalMs:0,persistResult:(id,value)=>{saved.set(id,value);return true;},loadResult:id=>saved.get(id)});
  monitor.submit(base,async(_signal,running)=>{running();return {response:{ok:true,status:'completed',patch:'large-result'.repeat(20),toolsUsed:['tool'],usage:{input_tokens:4}},isError:false};});
  for(let i=0;i<30&&!saved.has(base.requestId);i++) await new Promise(resolvePromise=>setImmediate(resolvePromise));
  assert.equal(saved.get(base.requestId).state,'completed');
  assert.equal(monitor.get(base.requestId).state,'completed');
  assert.equal(monitor.getResult(base.requestId).result.patch,'large-result'.repeat(20));
  monitor.close();
  const restarted=createTaskMonitor({gatewayInstanceId:'gateway-restarted',maintenanceIntervalMs:0,loadResult:id=>saved.get(id)});
  const recovered=await restarted.wait(base.requestId);
  assert.equal(recovered.ready,true);assert.equal(recovered.state,'completed');assert.equal(recovered.gatewayInstanceId,'gateway-restarted');
  restarted.close();
});

test('count retention trims oldest persisted terminal records and public list/get keep summaries', async()=>{
  const saved=new Map();
  const monitor=createTaskMonitor({gatewayInstanceId:'gateway-count',maxEntries:16,maxResultBytes:1024*1024,maintenanceIntervalMs:0,persistResult:(id,value)=>{saved.set(id,value);return true;},loadResult:id=>saved.get(id)});
  for(let i=0;i<19;i++) {
    const input={...base,requestId:`count-${i}`};
    monitor.submit(input,async(_signal,running)=>{running();return {response:{ok:true,status:'completed',provider:'provider-x',model:'model-y',timings:{executionMs:4},usage:{input_tokens:3},patch:'tiny',toolsUsed:[]},isError:false};});
  }
  for(let i=0;i<50&&monitor.size>16;i++) await new Promise(resolvePromise=>setImmediate(resolvePromise));
  assert.equal(monitor.size,16);
  const listed=monitor.list();
  assert.equal(listed.length,16);
  assert.equal(listed[0].actualProvider,'provider-x');
  assert.equal(listed[0].outcome.ok,true);
  assert.ok(listed[0].outcome.tokens);
  assert.equal(monitor.get(listed[0].requestId).actualProvider,'provider-x');
  assert.equal(monitor.getResult('count-0').result.patch,'tiny');
  monitor.close();
});

test('host projection persistence retries after the pending projection changes', async()=>{
  let attempts=0; const saved=new Map();
  const monitor=createTaskMonitor({gatewayInstanceId:'gateway-host',maintenanceIntervalMs:0,persistResult:(id,value)=>{attempts++;if(attempts===1)return false;saved.set(id,value);return true;},loadResult:id=>saved.get(id)});
  monitor.submit(base,async(_signal,running)=>{running();return {response:{ok:false,status:'awaiting-host-verification',patch:'host-bound-patch'},isError:false};});
  for(let i=0;i<30&&monitor.get(base.requestId).state!=='awaiting-host-verification';i++) await new Promise(resolvePromise=>setImmediate(resolvePromise));
  assert.equal(monitor.resolveHostVerification(base.requestId,{state:'completed',ok:true,status:'completed',patch:'verified-patch',hostVerification:{state:'completed'}}),true);
  assert.equal(saved.get(base.requestId).result.patch,'verified-patch');
  assert.equal(attempts,2);
  monitor.close();
});

test('failed persistence protects the only terminal result from budget eviction', async()=>{
  const monitor=createTaskMonitor({gatewayInstanceId:'gateway-cache',maxResultBytes:1,maintenanceIntervalMs:0,persistResult:()=>false});
  monitor.submit(base,async(_signal,running)=>{running();return {response:{ok:true,patch:'must remain'},isError:false};});
  for(let i=0;i<30&&monitor.get(base.requestId).state!=='completed';i++) await new Promise(resolvePromise=>setImmediate(resolvePromise));
  assert.equal(monitor.getResult(base.requestId).result.patch,'must remain');
  monitor.close();
});

test('wait is event-backed, abort affects only the waiter, and completion remains retrievable', async () => {
  const monitor=createTaskMonitor({gatewayInstanceId:'wait-gateway',maintenanceIntervalMs:0});
  let release; let runs=0;
  monitor.submit({...base,requestId:'wait-one'},async(_signal,running)=>{runs++;running();await new Promise(resolve=>{release=resolve;});return {response:{ok:true,toolsUsed:[]}};});
  while(!release) await new Promise(resolve=>setImmediate(resolve));
  const timed=await monitor.wait('wait-one',{timeoutMs:5});
  assert.equal(timed.ready,false);assert.equal(runs,1);assert.equal(monitor.get('wait-one').state,'running');
  const controller=new AbortController();
  const aborted=monitor.wait('wait-one',{timeoutMs:50000,signal:controller.signal});controller.abort();
  assert.equal((await aborted).code,'WAIT_ABORTED');
  const waiting=monitor.wait('wait-one',{timeoutMs:50000});
  release();
  assert.deepEqual(await waiting,{ok:true,ready:true,requestId:'wait-one',gatewayInstanceId:'wait-gateway',state:'completed'});
  assert.equal(runs,1);assert.equal(monitor.getResult('wait-one').ready,true);
  const closed=monitor.close();
  assert.equal((await monitor.wait('wait-one')).code,'MONITOR_CLOSED');
  assert.equal(closed,undefined);
});

test('wait handles terminal-before-register, host pending, cap, and close cleanup', async()=>{
  const monitor=createTaskMonitor({gatewayInstanceId:'wait-gateway',maintenanceIntervalMs:0});
  monitor.submit({...base,requestId:'host-pending'},async(_signal,running)=>{running();return {response:{ok:false,status:'awaiting-host-verification'}};});
  for(let i=0;i<30&&monitor.get('host-pending').state!=='awaiting-host-verification';i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await monitor.wait('host-pending')).state,'awaiting-host-verification');
  assert.equal((await monitor.wait('missing')).code,'RESULT_NOT_FOUND');
  const uncertain=createTaskMonitor({gatewayInstanceId:'wait-gateway',maintenanceIntervalMs:0,loadResult:()=>({state:'indeterminate'})});
  assert.equal((await uncertain.wait('uncertain')).code,'RESULT_INDETERMINATE');uncertain.close();
  for(let i=0;i<128;i++) monitor.submit({...base,requestId:`pending-${i}`},()=>new Promise(()=>{}));
  const held=Array.from({length:128},(_,i)=>monitor.wait(`pending-${i}`,{timeoutMs:50000}));
  try {
    assert.equal((await monitor.wait('missing')).code,'RESULT_NOT_FOUND');
    assert.equal((await monitor.wait('pending-0')).code,'WAIT_LIMIT');
  } finally {
    monitor.close();
  }
  assert.ok((await Promise.all(held)).every(result=>result.code==='MONITOR_CLOSED'));
  assert.equal((await monitor.wait('later')).code,'MONITOR_CLOSED');
});

test('task monitor cancels active work and redacts a failed reason', async () => {
  const monitor = createTaskMonitor({ gatewayInstanceId: 'gateway-1' });
  monitor.submit(base, signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Bearer secret-token password=hunter2')), { once: true })));
  assert.equal(monitor.cancel(base.requestId).accepted, true);
  for (let i = 0; i < 20 && monitor.get(base.requestId).state !== 'cancelled'; i += 1) await new Promise(resolvePromise => setImmediate(resolvePromise));
  const task = monitor.get(base.requestId);
  assert.equal(task.state, 'cancelled');
  assert.doesNotMatch(JSON.stringify(task), /secret-token|hunter2/);
});
