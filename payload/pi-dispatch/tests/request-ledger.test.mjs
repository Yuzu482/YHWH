import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestLedger, requestDigest, RequestLedgerError } from '../extensions/request-ledger.js';

function withLedgerDir(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-request-ledger-'));
  return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('request digest is canonical and excludes requestId', () => {
  const left = requestDigest('dispatch_subagent', { requestId: 'one', access: 'workspace-write', task: { objective: 'x', role: 'worker' } });
  const right = requestDigest('dispatch_subagent', { task: { role: 'worker', objective: 'x' }, access: 'workspace-write', requestId: 'two' });
  assert.equal(left, right);
});

test('completed write result replays across ledger instances without executing again', async () => withLedgerDir(async directory => {
  let executions = 0;
  const input = { requestId: 'write-1', access: 'workspace-write', task: { role: 'worker', objective: 'change x' } };
  const first = await createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => {
    executions++;
    return { response: { ok: true, patch: 'patch-line\n'.repeat(200), password: 'DUMMY_SECRET_ONLY', diagnostics: 'Bearer secret-token-value' }, isError: false };
  });
  const second = await createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => {
    executions++;
    return { response: { ok: false }, isError: true };
  });
  assert.equal(executions, 1);
  assert.equal(first.disposition, 'executed');
  assert.equal(second.disposition, 'replayed');
  assert.equal(second.source, 'persistent');
  assert.equal(second.value.response.patch, first.value.response.patch);
  assert.equal(second.value.response.patch, 'patch-line\n'.repeat(200));
  assert.equal(second.value.response.password, '[REDACTED]');
  assert.equal(second.value.response.diagnostics, 'Bearer [REDACTED]');
}));

test('same requestId with a different write envelope is rejected', async () => withLedgerDir(async directory => {
  const ledger = createRequestLedger(directory);
  const first = { requestId: 'write-conflict', access: 'workspace-write', task: { role: 'worker', objective: 'first' } };
  await ledger.execute({ requestId: first.requestId, operation: 'dispatch_subagent', input: first }, async () => ({ ok: true }));
  const changed = { ...first, task: { ...first.task, objective: 'second' } };
  await assert.rejects(
    createRequestLedger(directory).execute({ requestId: changed.requestId, operation: 'dispatch_subagent', input: changed }, async () => ({ ok: true })),
    error => error instanceof RequestLedgerError && error.code === 'idempotency_key_reused',
  );
}));

test('a started write without completion is blocked as indeterminate', async () => withLedgerDir(async directory => {
  let release;
  const input = { requestId: 'write-running', access: 'workspace-write', task: { role: 'worker', objective: 'slow' } };
  const first = createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, () => new Promise(resolvePromise => { release = resolvePromise; }));
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await assert.rejects(
    createRequestLedger(directory).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => ({ ok: true })),
    error => error instanceof RequestLedgerError && error.code === 'idempotency_in_doubt',
  );
  release({ ok: true });
  await first;
}));

test('ledger retention removes expired completed records but preserves newer critical state', async () => withLedgerDir(async directory => {
  const ledger = createRequestLedger(directory, { retention: { completedDays: 1, criticalDays: 90, totalBytes: 1024 * 1024 } });
  const input = { requestId: 'old-completed', access: 'workspace-write', task: { role: 'worker', objective: 'done' } };
  await ledger.execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => ({ response: { ok: true } }));
  ledger.recordOutcome('new-failed', { ok: false });
  const result = ledger.prune(Date.now() + 2 * 86_400_000);
  assert.ok(result.deletedEntries >= 1);
  assert.equal(ledger.getOutcome('old-completed').state, 'pending');
  assert.equal(ledger.getOutcome('new-failed').state, 'failed');
}));
