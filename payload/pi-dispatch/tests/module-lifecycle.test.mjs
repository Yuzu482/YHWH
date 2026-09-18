import test from 'node:test';
import assert from 'node:assert/strict';
import { createModuleLifecycle } from '../extensions/module-lifecycle.js';

test('invalid dependency graphs fail before constructing any service', () => {
  let starts = 0;
  const create = () => { starts++; return {}; };
  for (const definitions of [
    [{ id:'a', create }, { id:'a', create }],
    [{ id:'a', create, dependsOn:['missing'] }],
    [{ id:'a', create, dependsOn:['b'] }, { id:'b', create, dependsOn:['a'] }],
  ]) assert.throws(() => createModuleLifecycle(definitions));
  assert.equal(starts, 0);
});

test('dependencies start first and owned effects unwind once despite cleanup failures', async () => {
  const events = [];
  const host = createModuleLifecycle([
    { id:'child', dependsOn:['base'], create:({ dependencies, defer }) => {
      assert.equal(dependencies.base, 42); events.push('child');
      defer(async () => { await Promise.resolve(); events.push('effect'); });
      return {};
    }, dispose:() => { events.push('child-close'); throw Error('close failure'); } },
    { id:'base', create:() => { events.push('base'); return 42; }, dispose:() => events.push('base-close') },
    { id:'borrowed', owned:false, create:() => ({}), dispose:() => assert.fail('borrowed resource closed') },
  ]);
  const first = host.dispose();
  assert.equal(first, host.dispose());
  await assert.rejects(first, AggregateError);
  assert.deepEqual(events, ['base','child','child-close','effect','base-close']);
  assert.equal(host.snapshot().state, 'failed');
});

test('partial construction exposes awaited rollback and preserves the original cause', async () => {
  const events = [];
  let failure;
  try { createModuleLifecycle([
    { id:'base', create:() => ({}), dispose:() => events.push('base') },
    { id:'bad', dependsOn:['base'], create:({ defer }) => { defer(async () => events.push('partial')); throw Error('factory failed'); } },
  ]); } catch (error) { failure = error; }
  assert.equal(failure.cause.message, 'factory failed');
  await failure.cleanup;
  assert.deepEqual(events, ['partial','base']);
});

test('invalid replacement rolls back acquisitions and keeps the old service usable', async () => {
  const events = [];
  const original = () => 'old';
  const host = createModuleLifecycle([{ id:'adapter', replaceable:true, create:() => original, validate:value => { assert.equal(typeof value, 'function'); }, dispose:() => events.push('old-close') }]);
  await assert.rejects(host.replace('adapter', { create:({ defer }) => { defer(() => events.push('candidate-effect')); return 0; }, dispose:() => events.push('candidate-close') }));
  assert.equal(host.get('adapter'), original);
  assert.deepEqual(events, ['candidate-close','candidate-effect']);
  assert.equal(host.snapshot().modules[0].generation, 1);
  await host.replace('adapter', { create:() => () => 'new', dispose:() => events.push('new-close') });
  assert.equal(host.get('adapter')(), 'new');
  assert.equal(host.snapshot().modules[0].generation, 2);
  await host.dispose();
  assert.deepEqual(events, ['candidate-close','candidate-effect','old-close','new-close']);
});

test('async factories are rejected before their bodies execute', async () => {
  let starts = 0;
  assert.throws(() => createModuleLifecycle([{ id:'bad', create:async () => { starts++; } }]), { code:'MODULE_ASYNC_FACTORY' });
  const host = createModuleLifecycle([{ id:'adapter', replaceable:true, create:() => 1 }]);
  await assert.rejects(host.replace('adapter', { create:async () => { starts++; } }), { code:'MODULE_ASYNC_FACTORY' });
  assert.equal(starts, 0);
  await host.dispose();
});

test('replacement with dependents is pinned and shutdown serializes with replacement', async () => {
  const host = createModuleLifecycle([
    { id:'base', replaceable:true, create:() => 1 },
    { id:'child', dependsOn:['base'], create:() => 2 },
  ]);
  await assert.rejects(host.replace('base', { create:() => 3 }), { code:'MODULE_PINNED' });
  await host.dispose();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const second = createModuleLifecycle([{ id:'adapter', replaceable:true, create:() => 1, dispose:async () => { events.push('old-start'); await gate; events.push('old-end'); } }]);
  const replacement = second.replace('adapter', { create:() => 2, dispose:() => events.push('new-close') });
  const closing = second.dispose();
  await assert.rejects(second.replace('adapter', { create:() => 3 }), { code:'MODULES_UNAVAILABLE' });
  release();
  await replacement;
  await closing;
  assert.deepEqual(events, ['old-start','old-end','new-close']);
});

test('failed retirement closes candidate and leaves service access disabled', async () => {
  let candidateClosed = 0;
  const host = createModuleLifecycle([{ id:'adapter', replaceable:true, create:() => 1, dispose:() => { throw Error('retire failed'); } }]);
  await assert.rejects(host.replace('adapter', { create:() => 2, dispose:() => candidateClosed++ }), AggregateError);
  assert.equal(candidateClosed, 1);
  assert.equal(host.snapshot().state, 'failed');
  assert.throws(() => host.get('adapter'), { code:'MODULES_UNAVAILABLE' });
  await host.dispose();
});

test('validation must complete synchronously before a service becomes visible', async () => {
  let started = false, closed = false, failure;
  assert.throws(() => createModuleLifecycle([{ id:'bad', create:() => { started = true; }, validate:async () => {} }]), { code:'MODULE_ASYNC_VALIDATOR' });
  assert.equal(started, false);
  try { createModuleLifecycle([{ id:'bad', create:() => 1, validate:() => Promise.resolve(), dispose:() => { closed = true; } }]); }
  catch (error) { failure = error; }
  await failure.cleanup;
  assert.equal(failure.code, 'MODULE_ASYNC_VALIDATOR');
  assert.equal(closed, true);
});
