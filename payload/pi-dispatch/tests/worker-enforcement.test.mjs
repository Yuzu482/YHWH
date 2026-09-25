import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, childEnvironment, validateKetherInvocation, validateRequest } from '../scripts/dispatch.mjs';
import { publicCapabilities } from '../scripts/provider-policy.mjs';
import { WORKER_ENFORCEMENT_REJECTED, getWorkerEnforcementStatus } from '../scripts/worker-enforcement.mjs';

const cwd = process.cwd();
const raw = (provider, model) => ({ target: 'model', cwd, provider, model, access: 'none', prompt: 'fixture' });
const reviewerTask = { role: 'reviewer', objective: 'Review supplied material', acceptance: ['Return findings'], reviewPacket: { version: 1, stage: 'post-change', ...Object.fromEntries(['requirements', 'changes', 'context', 'verification'].map(k => [k, { status: 'provided', content: ['fixture'] }])) } };
const probeTask = token => ({ role: 'Netzach', objective: `Return exactly ${token} and nothing else.`, forbidden: ['Do not call tools', 'Do not modify files'], acceptance: [`Response contains ${token}`] });
const withMode = (mode, fn) => { const old = process.env.YHWH_WORKER_ENFORCEMENT; if (mode === undefined) delete process.env.YHWH_WORKER_ENFORCEMENT; else process.env.YHWH_WORKER_ENFORCEMENT = mode; try { return fn(); } finally { if (old === undefined) delete process.env.YHWH_WORKER_ENFORCEMENT; else process.env.YHWH_WORKER_ENFORCEMENT = old; } };

test('default and strict modes fail closed for non-worker routes', () => {
  for (const mode of [undefined, 'strict']) withMode(mode, () => {
    assert.equal(getWorkerEnforcementStatus().mode, 'strict');
    for (const [provider, model] of [['openai-codex', 'gpt-5.4'], ['openai-codex', 'gpt-5.6-sol'], ['openai-codex', 'gpt-5.6-terra'], ['anthropic', 'claude-sonnet-5']]) {
      assert.throws(() => validateRequest(raw(provider, model), false, cwd), new RegExp(WORKER_ENFORCEMENT_REJECTED));
    }
    assert.doesNotThrow(() => validateRequest(raw('openai-codex', 'gpt-6-luna'), false, cwd));
    assert.throws(() => validateRequest(raw('openai-codex', 'gpt-5.6-luna'), false, cwd));
    assert.throws(() => validateRequest(raw('openai-codex', 'gpt-6-sol'), false, cwd));
  });
});

test('invalid modes fail closed and off preserves only legacy raw validation', () => {
  for (const mode of ['', 'false', 'STRICT']) withMode(mode, () => assert.throws(() => getWorkerEnforcementStatus(), /YHWH_WORKER_ENFORCEMENT_INVALID/));
  withMode('off', () => {
    assert.equal(getWorkerEnforcementStatus().enabled, false);
    assert.doesNotThrow(() => validateRequest(raw('openai-codex', 'gpt-5.4'), false, cwd));
    assert.throws(() => validateKetherInvocation({ cwd, access: 'none', provider: 'openai-codex', model: 'gpt-5.4', task: { role: 'worker', objective: 'legacy', acceptance: ['done'] } }), /requires model/);
  });
});

test('validated Luna and reviewer envelopes are distinct from raw routes', () => {
  withMode('strict', () => {
    assert.doesNotThrow(() => validateKetherInvocation({ cwd, access: 'none', task: { role: 'worker', objective: 'Work', acceptance: ['done'] } }));
    assert.throws(() => validateRequest(raw('anthropic', 'claude-sonnet-5'), false, cwd), /YHWH_WORKER_ENFORCEMENT_REJECTED/);
    assert.doesNotThrow(() => validateKetherInvocation({ cwd, access: 'none', task: reviewerTask }));
    assert.throws(() => validateKetherInvocation({ cwd, access: 'none', task: { ...reviewerTask, reviewPacket: undefined } }), /review|materials/i);
  });
});

test('direct dispatch rejects before sandbox or authentication', async () => {
  await assert.rejects(() => dispatch(raw('openai-codex', 'gpt-5.4')), /YHWH_WORKER_ENFORCEMENT_REJECTED/);
  await assert.rejects(() => dispatch(raw('anthropic', 'claude-sonnet-5'), undefined, { role: 'reviewer', objective: 'Incomplete review', acceptance: ['Return findings'] }), /review|materials/i);
  await assert.rejects(() => dispatch(raw('anthropic', 'claude-sonnet-5'), undefined, { ...reviewerTask, readScope: ['secret.txt'] }), /none access|file scopes/);
  await assert.rejects(() => dispatch(raw('openai-codex', 'gpt-5.4'), undefined, null, { editorBroker: {} }), { code: 'YHWH_EDITOR_ROUTE_REJECTED' });
  await assert.rejects(() => dispatch(raw('openai-codex', 'gpt-5.6-luna'), undefined, null, { probe: true, probeToken: 'PI_GATEWAY_OK_FIXTURE', editorBroker: {} }), { code: 'YHWH_EDITOR_ROUTE_REJECTED' });
});

test('trusted probe is exact and external fields cannot forge it', () => {
  withMode('strict', () => {
    const token = 'PI_GATEWAY_OK_FIXTURE';
    assert.doesNotThrow(() => validateKetherInvocation({ cwd, access: 'none', task: probeTask(token) }, false, cwd, { probe: true, probeToken: token }));
    for (const task of [probeTask('PI_GATEWAY_OK_WRONG'), { ...probeTask(token), objective: 'arbitrary' }]) assert.throws(() => validateKetherInvocation({ cwd, access: 'none', task }, false, cwd, { probe: true, probeToken: token }), /YHWH_WORKER_ENFORCEMENT_REJECTED/);
    assert.throws(() => validateKetherInvocation({ cwd, access: 'none', probe: true, task: probeTask(token) }, false, cwd, { probe: true, probeToken: token }), /Unknown Kether invocation key/);
  });
});

test('child environments strip enforcement and gateway secrets; capabilities disclose scope', () => {
  const child = childEnvironment({ PATH: 'safe', YHWH_WORKER_ENFORCEMENT: 'off', PI_GATEWAY_TOKEN: 'secret' });
  assert.equal(child.YHWH_WORKER_ENFORCEMENT, undefined);
  assert.equal(child.PI_GATEWAY_TOKEN, undefined);
  withMode('strict', () => {
    const capabilities = publicCapabilities();
    assert.equal(capabilities.workerEnforcement.mode, 'strict');
    assert.match(capabilities.workerEnforcement.scope, /YHWH-managed/);
    assert.match(capabilities.providerCatalog.purpose, /discovery\/probe/);
  });
});
