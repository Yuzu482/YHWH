import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskMonitor } from '../extensions/task-monitor.js';

const base = {
  requestId: 'monitor-1', parentRunId: 'parent-1', provider: 'openai-codex', model: 'gpt-5.6-luna',
  access: 'read', resourceProfile: 'small', priority: 5, dependsOnRequestIds: [], task: { role: 'worker', objective: 'bounded task' },
};

test('task monitor deduplicates stable request IDs and rejects conflicting reuse', async () => {
  const monitor = createTaskMonitor({ gatewayInstanceId: 'gateway-1' });
  let release;
  const first = monitor.submit(base, async (_signal, running) => {
    running();
    await new Promise(resolvePromise => { release = resolvePromise; });
    return { response: { ok: true, provider: 'openai-codex', model: 'gpt-5.6-luna', toolsUsed: [] }, isError: false };
  });
  assert.equal(first.accepted, true);
  while (!release) await new Promise(resolvePromise => setImmediate(resolvePromise));
  const replay = monitor.submit(base, async () => { throw new Error('must not run'); });
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.state, 'running');
  assert.throws(() => monitor.submit({ ...base, model: 'different' }, async () => {}), /different monitored task/);
  release();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(monitor.get(base.requestId).state, 'completed');
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
