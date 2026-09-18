import test from 'node:test';
import assert from 'node:assert/strict';
import { totalmem } from 'node:os';
import { ResourceAwareExecutor, SCHEDULER_POLICY } from '../extensions/admission-scheduler.js';

const GIB = 1024 ** 3;
const tick = () => new Promise(resolvePromise => setImmediate(resolvePromise));

test('queue wait does not consume the execution budget',async()=>{
 const executor=new ResourceAwareExecutor(1,4,{availableMemoryBytes:()=>64*GIB,pollIntervalMs:5});
 let ready=false;let timing;let reason;
 const task=executor.run(async signal=>{assert.equal(signal.aborted,false);await new Promise(r=>setTimeout(r,40));return 'done';},100,null,{queueTimeoutMs:2000,canRun:()=>ready,onWaiting:v=>{reason=v;},onTiming:v=>{timing=v;}});
 await new Promise(r=>setTimeout(r,200));
 assert.deepEqual(reason.waitReasons,['dependency']);ready=true;
 assert.equal(await task,'done');assert.ok(timing.queueWaitMs>=190);assert.ok(timing.executionMs>=30);
});
test('queue timeout never starts work and reports resource reason',async()=>{
 const executor=new ResourceAwareExecutor(1,4,{availableMemoryBytes:()=>0,pollIntervalMs:5});
 let started=false;
 await assert.rejects(executor.run(async()=>{started=true;},1000,null,{queueTimeoutMs:30,memoryBytes:GIB}),e=>e.code==='QUEUE_TIMEOUT'&&e.waitReasons.includes('host_memory'));
 assert.equal(started,false);
});
test('execution timeout remains enforced after admission and cleanup settles',async()=>{
 const executor=new ResourceAwareExecutor(1,4,{availableMemoryBytes:()=>64*GIB});
 await assert.rejects(executor.run(signal=>new Promise(r=>signal.addEventListener('abort',()=>setTimeout(r,10),{once:true})),20,null,{queueTimeoutMs:1000}),e=>e.code==='EXECUTION_TIMEOUT');
 await tick();assert.equal(executor.active,0);
});

test('resource admission allows one large or two standard tasks, never four large tasks', async () => {
  const executor = new ResourceAwareExecutor(4, 8, { availableMemoryBytes: () => 64 * GIB, pollIntervalMs: 5 });
  let releaseLarge;
  let smallStarted = false;
  const large = executor.run(() => new Promise(resolvePromise => { releaseLarge = resolvePromise; }), 1000, null, { provider: 'openai-codex', memoryBytes: 6 * GIB, cpu: 2 });
  const small = executor.run(async () => { smallStarted = true; }, 1000, null, { provider: 'opencode-go', memoryBytes: GIB, cpu: 0.5 });
  await tick();
  assert.equal(executor.state.active, 1);
  assert.equal(smallStarted, false);
  releaseLarge('done');
  await large;
  await small;
  assert.equal(smallStarted, true);
});

test('scheduler skips blocked dependencies and enforces provider capacity', async () => {
  const executor = new ResourceAwareExecutor(4, 8, { availableMemoryBytes: () => 64 * GIB, providerCapacity: { 'openai-codex': 1 }, pollIntervalMs: 5 });
  let releaseFirst;
  const order = [];
  const first = executor.run(() => new Promise(resolvePromise => { order.push('first'); releaseFirst = resolvePromise; }), 1000, null, { provider: 'openai-codex', memoryBytes: GIB, cpu: 0.5 });
  const sameProvider = executor.run(async () => { order.push('same-provider'); }, 1000, null, { provider: 'openai-codex', memoryBytes: GIB, cpu: 0.5, priority: 9 });
  const blocked = executor.run(async () => { order.push('blocked'); }, 1000, null, { provider: 'opencode-go', memoryBytes: GIB, cpu: 0.5, priority: 9, canRun: () => false });
  const otherProvider = executor.run(async () => { order.push('other-provider'); }, 1000, null, { provider: 'opencode-go', memoryBytes: GIB, cpu: 0.5, priority: 1 });
  await tick();
  assert.deepEqual(order, ['first', 'other-provider']);
  executor.removeQueued(executor.queue.find(item => item.canRun), new Error('test cleanup'));
  await assert.rejects(blocked, /test cleanup/);
  releaseFirst('done');
  await first;
  await sameProvider;
  assert.deepEqual(order, ['first', 'other-provider', 'same-provider']);
});

test('host memory reserve keeps a task queued until headroom is available', async () => {
  let available = 1500 * 1024 * 1024;
  const executor = new ResourceAwareExecutor(1, 2, { availableMemoryBytes: () => available, hostReserveBytes: GIB, pollIntervalMs: 5 });
  let started = false;
  const task = executor.run(async () => { started = true; }, 1000, null, { provider: 'openai-codex', memoryBytes: GIB, cpu: 0.5 });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  assert.equal(started, false);
  available = 3 * GIB;
  await task;
  assert.equal(started, true);
});

test('default host reserve is at least 2 GiB and ten percent of physical memory', () => {
  assert.ok(SCHEDULER_POLICY.hostReserveBytes >= 2 * GIB);
  assert.ok(SCHEDULER_POLICY.hostReserveBytes >= totalmem() * 0.10);
});

test('queue aging eventually lets an older low-priority task run first', async () => {
  const executor = new ResourceAwareExecutor(1, 4, { availableMemoryBytes: () => 64 * GIB, agingIntervalMs: 5, pollIntervalMs: 2 });
  let releaseBlocker;
  const order = [];
  const blocker = executor.run(() => new Promise(resolvePromise => { releaseBlocker = resolvePromise; }), 1000, null, { provider: 'openai-codex' });
  const oldLow = executor.run(async () => { order.push('old-low'); }, 1000, null, { provider: 'openai-codex', priority: 1 });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 45));
  const newHigh = executor.run(async () => { order.push('new-high'); }, 1000, null, { provider: 'openai-codex', priority: 9 });
  releaseBlocker();
  await Promise.all([blocker, oldLow, newHigh]);
  assert.deepEqual(order, ['old-low', 'new-high']);
});

test('graceful shutdown rejects new work, cancels queue, and aborts overlong active work', async () => {
  const executor = new ResourceAwareExecutor(1, 2, { availableMemoryBytes: () => 64 * GIB });
  const active = executor.run(signal => new Promise(resolvePromise => signal.addEventListener('abort', () => resolvePromise('aborted'), { once: true })), 1000, null, { provider: 'openai-codex' });
  const queued = executor.run(async () => 'queued', 1000, null, { provider: 'openai-codex' });
  const queuedRejected = assert.rejects(queued, /shut down while request was queued/);
  await tick();
  const result = await executor.shutdown({ graceMs: 5, abortWaitMs: 100 });
  await queuedRejected;
  assert.equal(await active, 'aborted');
  assert.equal(result.queuedCancelled, 1);
  assert.equal(result.forced, 1);
  assert.equal(result.remainingActive, 0);
  await assert.rejects(executor.run(async () => {}, 100), /shutting down/);
});
