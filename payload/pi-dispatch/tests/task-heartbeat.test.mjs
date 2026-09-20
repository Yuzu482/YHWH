import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHeartbeat } from '../extensions/task-heartbeat.js';
import { createTaskMonitor } from '../extensions/task-monitor.js';

function fakeClock() {
  let value = 0;
  const timers = new Set();
  const createdTimers = [];
  let unrefCount = 0;
  return {
    now: () => value,
    setIntervalFn(fn, ms) {
      const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; unrefCount += 1; } };
      timers.add(timer);
      createdTimers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { timers.delete(timer); },
    advance(ms) { value += ms; },
    tick(ms) { value += ms; for (const timer of [...timers]) timer.fn(); },
    get activeCount() { return timers.size; },
    get createdTimers() { return createdTimers; },
    get unrefCount() { return unrefCount; },
  };
}

function heartbeatFor(clock) {
  return createTaskHeartbeat({ now: clock.now, setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn });
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

const base = {
  parentRunId: 'parent-1', provider: 'openai-codex', model: 'gpt-5.6-luna', access: 'read',
  resourceProfile: 'small', priority: 5, dependsOnRequestIds: [], task: { role: 'worker', objective: 'bounded task' },
};
const task = requestId => ({ ...base, requestId });

function monitorFor(clock, onCreate = () => {}) {
  return createTaskMonitor({
    gatewayInstanceId: 'gateway-test',
    createHeartbeat: () => { onCreate(); return heartbeatFor(clock); },
  });
}

test('heartbeat timers, freshness, independent progress, and stopped snapshots', () => {
  const clock = fakeClock();
  const first = heartbeatFor(clock);
  const second = heartbeatFor(clock);
  assert.equal(first.snapshot().status, 'not-started');
  first.start();
  second.start();
  assert.equal(clock.activeCount, 2);
  assert.equal(clock.unrefCount, 2);
  assert.equal(clock.createdTimers[0].ms, 10_000);
  assert.equal(clock.createdTimers[0].unrefCalled, true);

  clock.tick(10_000);
  assert.equal(first.snapshot().status, 'fresh');
  assert.equal(first.snapshot().sequence, 2);
  assert.equal(second.snapshot().lastProgressAt, null);
  clock.advance(100);
  const sampled = second.snapshot();
  assert.equal(sampled.sequence, 2);
  assert.equal(second.snapshot().sequence, sampled.sequence);
  first.progress();
  assert.notEqual(first.snapshot().lastProgressAt, null);
  assert.equal(second.snapshot().lastProgressAt, null);
  clock.advance(30_001);
  assert.equal(second.snapshot().status, 'stale');

  first.stop();
  second.stop();
  const frozen = first.snapshot();
  clock.advance(10_000);
  for (const timer of clock.createdTimers) timer.fn();
  first.progress();
  assert.deepEqual(first.snapshot(), frozen);
  assert.equal(clock.activeCount, 0);
});

test('monitor leaves queued heartbeat stopped, wires progress, and stops terminal work', async () => {
  const queuedClock = fakeClock();
  const queuedWork = deferred();
  const queuedMonitor = monitorFor(queuedClock);
  queuedMonitor.submit(task('queued'), async () => queuedWork.promise);
  await flush();
  assert.equal(queuedMonitor.get('queued').heartbeat.status, 'not-started');
  assert.equal(queuedClock.activeCount, 0);
  assert.equal(queuedMonitor.cancel('queued').task.heartbeat.status, 'stopped');
  queuedWork.resolve({ response: { ok: true }, isError: false });
  await flush();
  assert.equal(queuedMonitor.get('queued').state, 'cancelled');
  assert.equal(queuedMonitor.get('queued').heartbeat.status, 'stopped');

  const clock = fakeClock();
  const work = deferred();
  let progress;
  const monitor = monitorFor(clock);
  monitor.submit(task('running'), async (_signal, running, _queue, reportProgress) => {
    running();
    progress = reportProgress;
    return work.promise;
  });
  await flush();
  assert.equal(monitor.get('running').heartbeat.sequence, 1);
  assert.equal(clock.activeCount, 1);
  clock.advance(100);
  assert.equal(monitor.get('running').heartbeat.sequence, 1);
  progress({ phase: 'work' });
  assert.notEqual(monitor.get('running').heartbeat.lastProgressAt, null);
  clock.advance(30_001);
  assert.equal(monitor.get('running').heartbeat.status, 'stale');
  clock.tick(10_000);
  assert.equal(monitor.get('running').heartbeat.status, 'fresh');
  work.resolve({ response: { ok: true }, isError: false });
  await flush();
  const stopped = monitor.get('running').heartbeat;
  progress({ phase: 'late' });
  assert.deepEqual(monitor.get('running').heartbeat, stopped);
});

test('monitor stops heartbeat for resolved and thrown terminal outcomes', async t => {
  const cases = [
    ['success', 'completed', async (_signal, running) => { running(); return { response: { ok: true }, isError: false }; }],
    ['blocked', 'blocked', async (_signal, running) => { running(); return { response: { status: 'blocked', error: 'blocked' }, isError: false }; }],
    ['failed', 'failed', async (_signal, running) => { running(); return { response: { ok: false, error: 'failed' }, isError: false }; }],
    ['throw', 'failed', async (_signal, running) => { running(); throw new Error('thrown'); }],
  ];
  for (const [name, expected, runner] of cases) await t.test(name, async () => {
    const clock = fakeClock();
    const monitor = monitorFor(clock);
    monitor.submit(task(name), runner);
    await flush();
    const record = monitor.get(name);
    assert.equal(record.state, expected);
    assert.equal(record.heartbeat.status, 'stopped');
    assert.equal(clock.activeCount, 0);
  });
});

test('replay does not create a timer and cancellation stops active work immediately', async () => {
  const clock = fakeClock();
  const work = deferred();
  let created = 0;
  const monitor = monitorFor(clock, () => { created += 1; });
  monitor.submit(task('dedup'), async (_signal, running) => { running(); return work.promise; });
  await flush();
  const replay = monitor.submit(task('dedup'), () => { throw new Error('must not run'); });
  assert.equal(replay.replayed, true);
  assert.equal(created, 1);
  assert.equal(clock.activeCount, 1);
  const cancelled = monitor.cancel('dedup');
  assert.equal(cancelled.task.heartbeat.status, 'stopped');
  assert.equal(clock.activeCount, 0);
  work.resolve({ response: { ok: true }, isError: false });
  await flush();
  assert.equal(monitor.get('dedup').state, 'cancelled');
  assert.equal(monitor.get('dedup').heartbeat.status, 'stopped');
});
