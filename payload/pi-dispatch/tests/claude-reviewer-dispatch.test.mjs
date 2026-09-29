import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../scripts/dispatch.mjs';

const cwd = process.cwd();
const task = {
  role: 'Geburah', objective: 'Review supplied material', acceptance: ['Return findings'],
  reviewPacket: { version: 1, stage: 'post-change', ...Object.fromEntries(['requirements', 'changes', 'context', 'verification'].map(key => [key, { status: 'provided', content: ['fixture'] }])) },
};
const request = (provider = 'claude-code-cli', model = 'claude-sonnet-5', access = 'none') => ({
  target: 'model', cwd, provider, model, access, thinking: 'max', prompt: 'ignored', timeoutSeconds: 30,
});

function harness(result) {
  const calls = [];
  return {
    calls,
    options: {
      claudeCliEntryResolver: () => '/trusted/claude.js',
      claudeReviewerRunner: async value => { calls.push(value); return result; },
    },
  };
}

test('exact validated reviewer route runs only injected host CLI and returns compatible response', async () => {
  const fake = harness({ status: 'completed', runtime: 'host-cli', text: 'findings', usage: { input_tokens: 3 } });
  const response = await dispatch(request(), undefined, task, fake.options);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].packet, /TASK_PACKET_JSON=/);
  assert.match(fake.calls[0].packet, /RESULT_SCHEMA_JSON=/);
  assert.equal(fake.calls[0].nodePath, process.execPath);
  assert.equal(fake.calls[0].cliScript, '/trusted/claude.js');
  assert.deepEqual(response, {
    target: 'model', requestedProvider: 'claude-code-cli', requestedModel: 'claude-sonnet-5',
    provider: 'claude-code-cli', model: 'claude-sonnet-5', ok: true, text: 'findings',
    usage: { input_tokens: 3 }, toolsUsed: [], toolErrors: 0, runtime: 'host-cli', osSandbox: 'none',
  });
});

test('auth and quota failures propagate sanitized codes and never fall back', async () => {
  for (const [reason, extra] of [['PI_AUTH_EXPIRED', {}], ['PI_QUOTA_LIMITED', { resetTime: '12:30' }]]) {
    const fake = harness({ status: 'failed', reason, ...extra });
    const response = await dispatch(request(), undefined, task, fake.options);
    assert.equal(response.ok, false);
    assert.equal(response.failureCode, reason);
    assert.equal(response.failure, reason);
    assert.equal(response.resetTime, extra.resetTime);
    assert.equal(fake.calls.length, 1);
    assert.equal(response.osSandbox, 'none');
  }
});

test('trusted exact gateway token probe runs CLI while forged probe is rejected', async () => {
  const token = 'PI_GATEWAY_OK_TEST123';
  const probeTask = { role: 'Netzach', objective: `Return exactly ${token} and nothing else.`, acceptance: [`Response contains ${token}`], forbidden: ['Do not call tools', 'Do not modify files'] };
  const fake = harness({ status: 'completed', text: token });
  const response = await dispatch(request(), undefined, probeTask, { ...fake.options, probe: true, probeToken: token });
  assert.equal(response.ok, true);
  assert.equal(response.text, token);
  assert.equal(fake.calls[0].packet, `Return exactly ${token} and nothing else.`);
  assert.match(fake.calls[0].packet, new RegExp(token));
  assert.doesNotMatch(fake.calls[0].packet, /TASK_PACKET_JSON=|RESULT_SCHEMA_JSON=|Netzach|Kether|governance|system-level/i);
  const forged = harness({ status: 'completed', text: token });
  await assert.rejects(() => dispatch(request(), undefined, { ...probeTask, objective: 'forged' }, { ...forged.options, probe: true, probeToken: token }));
  assert.equal(forged.calls.length, 0);
});

test('invalid role, access, and tuple reject before runner', async () => {
  for (const [req, invalidTask] of [
    [request('claude-code-cli', 'claude-sonnet-5'), { ...task, role: 'Chesed' }],
    [request('claude-code-cli', 'claude-sonnet-5', 'read'), task],
    [request('claude-code-cli', 'other-model'), task],
  ]) {
    const fake = harness({ status: 'completed', text: 'should not run' });
    await assert.rejects(() => dispatch(req, undefined, invalidTask, fake.options));
    assert.equal(fake.calls.length, 0);
  }
});
