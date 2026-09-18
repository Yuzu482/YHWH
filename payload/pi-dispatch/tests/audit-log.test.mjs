import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildAuditRecord, createAuditLogger, redactSensitiveText,
  summarizePatch, summarizeTaskEnvelope, summarizeUsage,
} from '../extensions/audit-log.js';

test('audit summaries retain evidence without raw task or patch text', () => {
  const secret = 'sk-super-secret-123456789';
  const task = { role: 'worker', objective: `Use ${secret}`, context: ['private text'], writeScope: ['src/**'] };
  const envelope = summarizeTaskEnvelope(task);
  const patch = summarizePatch('--- a/src/private.txt\n+++ b/src/private.txt\n@@ -1 +1 @@\n-secret\n+replacement\n');
  assert.equal(envelope.present, true);
  assert.equal(envelope.listCounts.writeScope, 1);
  assert.equal(patch.fileCount, 1);
  assert.equal(patch.additions, 1);
  assert.equal(patch.deletions, 1);
  const serialized = JSON.stringify({ envelope, patch });
  assert.doesNotMatch(serialized, /super-secret|private\.txt|replacement/);
});

test('audit failure redaction removes common credential forms', () => {
  const redacted = redactSensitiveText('Bearer abc.def api_key=topsecret password:hunter2 https://user:pass@example.com sk-tokenvalue123');
  assert.doesNotMatch(redacted, /abc\.def|topsecret|hunter2|user:pass|tokenvalue123/);
  assert.match(redacted, /REDACTED/);
  const record = buildAuditRecord({ requestId: 'sk-request-secret-12345678', operation: 'probe_model', input: {}, durationMs: 0, failure: 'failed' });
  assert.equal(record.requestId, '[REDACTED_TOKEN]');
});

test('audit usage normalizes token counters and logger persists JSONL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-audit-'));
  try {
    const file = join(dir, 'audit.jsonl');
    const logger = createAuditLogger(file);
    const record = buildAuditRecord({
      requestId: 'req-test', operation: 'dispatch_subagent', durationMs: 12.4,
      input: { access: 'read', provider: 'openai-codex', model: 'gpt-5.6-luna' },
      task: { role: 'worker', objective: 'Inspect safely.' },
      result: { ok: false, provider: 'openai-codex', model: 'gpt-5.6-luna', toolsUsed: ['read', 'read'], toolErrors: 1, usage: { input: 10, output: 5, cacheRead: 2 }, failure: 'authorization=secret-value' },
    });
    logger.record(record);
    logger.close();
    const saved = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.equal(saved.tokens.totalTokens, 17);
    assert.equal(saved.tools.counts.read, 2);
    assert.equal(saved.durationMs, 12);
    assert.equal(saved.failureReason, 'authorization=[REDACTED]');
    assert.doesNotMatch(JSON.stringify(saved), /secret-value|Inspect safely/);
    assert.deepEqual(summarizeUsage(null), { available: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit logger rotates and protects failed or write records longer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-audit-retention-'));
  try {
    const file = join(dir, 'audit.jsonl');
    const logger = createAuditLogger(file, { segmentBytes: 120, completedDays: 14, criticalDays: 90, totalBytes: 1024, criticalTotalBytes: 1024 });
    logger.record({ operation: 'dispatch_subagent', access: 'read', outcome: 'completed', payload: 'x'.repeat(100) });
    logger.record({ operation: 'dispatch_subagent', access: 'workspace-write', outcome: 'completed', payload: 'y'.repeat(100) });
    logger.record({ operation: 'probe_model', access: 'none', outcome: 'failed', payload: 'z'.repeat(100) });
    logger.close();
    assert.ok(readdirSync(dir).some(name => /^audit\.jsonl\.\d{13}-\d+\.jsonl$/.test(name)));
    assert.equal(existsSync(`${file}.critical`), true);
    const critical = readFileSync(`${file}.critical`, 'utf8');
    assert.match(critical, /failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
