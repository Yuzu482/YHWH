import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  buildAuditRecord, createAuditLogger, redactSensitiveText,
  summarizePatch, summarizeTaskEnvelope, summarizeUsage,
  summarizeOutputLimit,
} from '../extensions/audit-log.js';

test('output-limit diagnostics keep bounded counters and never retain task/patch secrets',()=>{
  assert.deepEqual(summarizeOutputLimit({bucket:'direct',directBytes:129,limitBytes:128,task:'secret',patch:'source',credential:'private'}),{bucket:'direct',directBytes:129,limitBytes:128});
  assert.equal(summarizeOutputLimit({bucket:'guessed-tool-output'}),undefined);
  const r=buildAuditRecord({requestId:'limit',operation:'dispatch_subagent',input:{access:'workspace-write'},task:null,result:{ok:false,failure:'output-limit',outputLimitObservation:{bucket:'patch',patchBytes:7000000,limitBytes:6291456,body:'private patch'}}});
  assert.equal(r.outputLimitObservation.bucket,'patch');assert.equal(JSON.stringify(r).includes('private patch'),false);
});

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

test('URL credential redaction preserves prefixes, schemes and noncredential text', () => {
  const prefixes = ['', '123', '+.-', '0+.-9', '_', '中文', '"', '(', '\n'];
  const schemes = ['https', 'HTTP', 'git+ssh', 'a.b-c', 'x'];
  for (const prefix of prefixes) for (const scheme of schemes) {
    const head = `${prefix}${scheme}://`;
    assert.equal(redactSensitiveText(`${head}alice:p%40ss@example.test/path`, {compact:false}), `${head}[REDACTED]@example.test/path`);
    for (const tail of ['example.test/path', 'alice@example.test', 'alice:p%40ss/no-at', '']) {
      assert.equal(redactSensitiveText(head + tail, {compact:false}), head + tail);
    }
  }
  assert.equal(redactSensitiveText('https://a:b@one.test ssh://c:d@two.test', {compact:false}), 'https://[REDACTED]@one.test ssh://[REDACTED]@two.test');
});

test('large result redaction finishes within a bounded child process without dropping content', () => {
  // A process deadline also catches synchronous regexp stalls that a test timeout cannot interrupt.
  const moduleUrl = new URL('../extensions/audit-log.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {redactSensitiveText} from ${JSON.stringify(moduleUrl)};
    const started = performance.now();
    for (const value of ['x'.repeat(262144), 'x.'.repeat(131072), '9+'.repeat(131072)]) {
      assert.equal(redactSensitiveText(value, {compact:false}), value);
      assert.equal(redactSensitiveText(value), value.slice(0, 1000));
      assert.equal(redactSensitiveText(value + ' https://alice:secret-value@example.test', {compact:false}), value + ' https://[REDACTED]@example.test');
    }
    console.log(JSON.stringify({ok:true, milliseconds:performance.now()-started}));
  `], {encoding:'utf8', timeout:5000, windowsHide:true});
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).ok, true);
});

test('audit record preserves host CLI runtime evidence', () => {
  const record = buildAuditRecord({ requestId: 'cli-review', operation: 'dispatch_subagent', input: { access: 'none', provider: 'claude-code-cli' }, task: { role: 'Geburah', objective: 'private packet' }, result: { ok: true, runtime: 'host-cli', osSandbox: 'none' }, durationMs: 1 });
  assert.equal(record.runtime, 'host-cli');
  assert.equal(record.outcome, 'completed');
  assert.doesNotMatch(JSON.stringify(record), /private packet/);
});

test('audit distinguishes host verification waiting from worker failure', () => {
  const record = buildAuditRecord({ requestId:'host-wait', operation:'dispatch_subagent', input:{access:'workspace-write'}, result:{ok:false,status:'awaiting-host-verification',failure:'awaiting-host-verification'}, durationMs:1 });
  assert.equal(record.status,'awaiting-host-verification');
  assert.equal(record.outcome,'awaiting-host-verification');
  const verified = buildAuditRecord({ requestId:'host-pass', operation:'record_host_verification', input:{access:'none'}, result:{ok:true,state:'completed',outcome:'completed',artifactSha256:'a'.repeat(64),recordSha256:'b'.repeat(64),checks:[{checkName:'npm test',exitCode:0,command:'private command',outputSummary:'private output'}]}, durationMs:1 });
  assert.equal(verified.hostVerification.checkCount,1);
  assert.equal(verified.hostVerification.passedChecks,1);
  assert.doesNotMatch(JSON.stringify(verified),/private command|private output/);
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
    assert.equal(saved.tools.errors, 1);
    assert.equal(saved.tools.recoveredErrors, 0);
    assert.equal(saved.tools.unrecoveredErrors, 1);
    assert.equal(saved.tools.errors, saved.tools.recoveredErrors + saved.tools.unrecoveredErrors);
    assert.equal(saved.durationMs, 12);
    assert.equal(saved.failureReason, 'authorization=[REDACTED]');
    assert.doesNotMatch(JSON.stringify(saved), /secret-value|Inspect safely/);
    assert.deepEqual(summarizeUsage(null), { available: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host telemetry is bounded, redacted, and acceptance requires a bound host event', () => {
  const hash = 'a'.repeat(64);
  const telemetry = { parentRunId: 'run-1', workspaceSha256: hash, runAnchorSha256: 'b'.repeat(64), thinking: 'high', declaredTier: 'T1', baseTier: 'T0', tier: 'T1', riskProfile: 'standard', semanticRisks: { publicApiOrProtocol:false, dependencyOrLockfile:false, securityAuthOrCredentials:false, migration:false, irreversibleOrNoRollback:false }, counts: { files:2, addedLines:3, deletedLines:1, estimatedLines:4 }, modelExecution:true, submittedAt:'2026-10-02T12:00:00Z', startedAt:'2026-10-02T12:01:00Z', completedAt:'2026-10-02T12:02:00Z', reviewStage:'post-review', conditionalApproval:false };
  const record = buildAuditRecord({ operation:'dispatch_subagent', input:{ parentRunId:'fallback-1' }, telemetry, result:{ ok:true, status:'completed', modelExecution:false, acceptedAt:'2026-10-02T12:03:00Z' } });
  assert.equal(record.parentRunId, 'run-1');
  assert.equal(record.modelExecution, true);
  assert.equal(record.files, 2);
  assert.deepEqual(record.semanticRisks, telemetry.semanticRisks);
  const invalidRisks = buildAuditRecord({ telemetry: { semanticRisks: { a:false, b:false, c:false, d:false, e:false } } });
  assert.equal(invalidRisks.semanticRisks, undefined);
  const extraRisk = buildAuditRecord({ telemetry: { semanticRisks: { ...telemetry.semanticRisks, unknown:false } } });
  assert.equal(extraRisk.semanticRisks, undefined);
  assert.equal(buildAuditRecord({ operation:'probe_model', telemetry:{ modelExecution:true } }).modelExecution, false);
  assert.equal(buildAuditRecord({ operation:'dispatch_subagent', telemetry:{ modelExecution:true } }).modelExecution, true);
  assert.equal(record.acceptedAt, undefined);
  assert.equal(buildAuditRecord({ operation:'dispatch_subagent', input:{ parentRunId:'fallback-2' }, failure:'failed' }).parentRunId, 'fallback-2');
  const fake = buildAuditRecord({ operation:'dispatch_subagent', input:{ modelExecution:true, acceptedAt:'2026-10-02T12:03:00Z' }, task:{ acceptedAt:'2026-10-02T12:03:00Z' }, result:{ ok:true, acceptedAt:'2026-10-02T12:03:00Z', modelExecution:true } });
  assert.equal(fake.modelExecution, undefined);
  assert.equal(fake.acceptedAt, undefined);
  const ordinary = buildAuditRecord({ operation:'dispatch_subagent', result:{ ok:true, status:'completed' }, telemetry:{ taskAccepted:true, acceptedAt:'2026-10-02T12:03:00Z', parentRunId:'run-1', workspaceSha256:'a'.repeat(64), runAnchorSha256:'b'.repeat(64), implementationRequestIds:['req-1'] } });
  assert.equal(ordinary.acceptedAt, undefined);
  const accepted = buildAuditRecord({ operation:'task_accepted', telemetry:{ taskAccepted:true, acceptedAt:'2026-10-02T12:03:00Z', parentRunId:'run-1', workspaceSha256:'a'.repeat(64), runAnchorSha256:'b'.repeat(64), implementationRequestIds:['req-1'] } });
  assert.equal(accepted.acceptedAt, '2026-10-02T12:03:00Z');
  assert.deepEqual(accepted.implementationRequestIds, ['req-1']);
  const validProof = { state:'completed', source:'netzach', artifactSha256:'c'.repeat(64), recordSha256:'d'.repeat(64) };
  const acceptedProof = buildAuditRecord({ operation:'task_accepted', telemetry:{ taskAccepted:true, acceptedAt:'2026-10-02T12:03:00.123Z', parentRunId:'run-1', workspaceSha256:'a'.repeat(64), runAnchorSha256:'b'.repeat(64), implementationRequestIds:['req-1'], verification:validProof } });
  assert.deepEqual(acceptedProof.verification, validProof);
  const badProof = buildAuditRecord({ operation:'task_accepted', telemetry:{ taskAccepted:true, acceptedAt:'2026-10-02T12:03:00Z', parentRunId:'run-1', workspaceSha256:'a'.repeat(64), runAnchorSha256:'b'.repeat(64), implementationRequestIds:['req-1'], verification:{ ...validProof, artifactSha256:'bad' } } });
  assert.equal(badProof.verification, undefined);
  const missingProof = buildAuditRecord({ operation:'task_accepted', telemetry:{ taskAccepted:true, acceptedAt:'2026-10-02T12:03:00Z', parentRunId:'run-1', workspaceSha256:'a'.repeat(64), runAnchorSha256:'b'.repeat(64), implementationRequestIds:['req-1'], verification:{ state:'completed', source:'netzach', recordSha256:'d'.repeat(64) } } });
  assert.equal(missingProof.verification, undefined);
  assert.equal(buildAuditRecord({ operation:'dispatch_subagent', telemetry:{ verification:validProof } }).verification, undefined);
  const invalid = buildAuditRecord({ operation:'task_accepted', telemetry:{ taskAccepted:true, acceptedAt:'not a timestamp secret', parentRunId:'run secret', workspaceSha256:'bad', runAnchorSha256:'bad', implementationRequestIds:['bad id secret'] } });
  assert.equal(invalid.acceptedAt, undefined);
  assert.doesNotMatch(JSON.stringify(invalid), /secret|not a timestamp/);
  const badCounts = buildAuditRecord({ telemetry:{ counts:{ files:1, addedLines:2, deletedLines:1, estimatedLines:8 } } });
  assert.equal(badCounts.counts, undefined);
});

test('audit records only bounded execution-limitation warning codes and counts',()=>{
  const warning=buildAuditRecord({operation:'dispatch_subagent',result:{ok:true,roleValidation:{warnings:['execution-limitation-invalid','untrusted arbitrary prose','execution-limitation-invalid']}}});
  assert.deepEqual(warning.metadataWarnings,{codes:['execution-limitation-invalid'],count:2});
  assert.deepEqual(warning.roleValidation,{warnings:['execution-limitation-invalid','execution-limitation-invalid']});
  assert.doesNotMatch(JSON.stringify(warning),/untrusted arbitrary prose/);
  const clean=buildAuditRecord({operation:'dispatch_subagent',result:{ok:true,roleValidation:{warnings:['other']}}});
  assert.equal(clean.metadataWarnings,undefined);
});

test('audit outcomes separate successful operation from task decision', () => {
  const completed = buildAuditRecord({ operation: 'dispatch_subagent', result: { ok: true, status: 'completed' } });
  assert.equal(completed.outcome, 'completed');
  assert.equal(completed.operationOutcome, 'completed');
  assert.equal(completed.taskOutcome, 'completed');

  const failedTask = buildAuditRecord({ operation: 'record_host_verification', result: { ok: true, state: 'failed', outcome: 'failed' } });
  assert.equal(failedTask.outcome, 'completed');
  assert.equal(failedTask.operationOutcome, 'completed');
  assert.equal(failedTask.taskOutcome, 'failed');

  const waiting = buildAuditRecord({ operation: 'dispatch_subagent', result: { ok: false, status: 'awaiting-host-verification', failure: 'awaiting-host-verification', exitCode: 0, sandbox: 'wsl2-bwrap' } });
  assert.equal(waiting.operationOutcome, 'completed');
  assert.equal(waiting.taskOutcome, 'awaiting-host-verification');
  assert.equal(waiting.runtime, 'wsl2-bwrap');
  for (const [decision, expected] of [['approve', 'completed'], ['request-changes', 'changes-requested'], ['insufficient-materials', 'blocked']]) {
    const review = buildAuditRecord({ operation: 'review', result: { ok: true, status: 'completed', reviewValidation: { ok: true, decision } } });
    assert.equal(review.operationOutcome, 'completed');
    assert.equal(review.taskOutcome, expected);
    assert.equal(review.reviewDecision, decision);
  }
  const review = buildAuditRecord({ operation: 'review', result: { ok: false, status: 'failed', failure: 'review_changes_requested', reviewValidation: { ok: true, decision: 'request-changes' } } });
  assert.equal(review.operationOutcome, 'completed');
  assert.equal(review.taskOutcome, 'changes-requested');
  const invalidReview = buildAuditRecord({ operation: 'review', result: { ok: false, status: 'failed', reviewValidation: { ok: false, decision: 'approve' } } });
  assert.equal(invalidReview.operationOutcome, 'failed');
  assert.equal(invalidReview.taskOutcome, 'failed');
  for (const state of ['blocked', 'unverified']) assert.equal(buildAuditRecord({ operation: 'dispatch_subagent', result: { ok: true, status: state } }).taskOutcome, state);
  assert.equal(buildAuditRecord({ operation: 'dispatch_subagent', failure: 'PI_AUTH_MISSING' }).operationOutcome, 'failed');
  const rejected = buildAuditRecord({ operation: 'dispatch_subagent', result: { ok: false, failure: 'rejected' } });
  assert.equal(rejected.operationOutcome, 'failed');
  assert.equal(rejected.taskOutcome, 'failed');
});

test('runtime requires dispatch evidence and failed task outcomes receive critical retention', () => {
  const actual = buildAuditRecord({ operation: 'dispatch_subagent', input: { provider: 'some-provider' }, result: { ok: true, osSandbox: 'wsl2-bwrap', sandbox: 'wsl2-bwrap', exitCode: 0, phaseTimings: { processMs: 5 } } });
  assert.equal(actual.runtime, 'wsl2-bwrap');
  const configuredOnly = buildAuditRecord({ operation: 'dispatch_subagent', result: { ok: false, osSandbox: 'wsl2-bwrap', failure: 'PI_AUTH_MISSING', phaseTimings: { authenticationMs: 10 }, timings: { executionMs: 10 } } });
  assert.equal(configuredOnly.runtime, undefined);
  const missing = buildAuditRecord({ operation: 'dispatch_subagent', input: { provider: 'some-provider' }, result: { ok: false, failure: 'preflight' } });
  assert.equal(missing.runtime, undefined);
  const noResult = buildAuditRecord({ operation: 'dispatch_subagent', input: { provider: 'some-provider' } });
  assert.equal(noResult.runtime, undefined);
  assert.equal(noResult.operationOutcome, 'unknown');

  const dir = mkdtempSync(join(tmpdir(), 'pi-audit-task-outcome-'));
  try {
    const file = join(dir, 'audit.jsonl');
    const logger = createAuditLogger(file);
    logger.record(buildAuditRecord({ operation: 'record_host_verification', result: { ok: true, state: 'failed', outcome: 'failed' } }));
    logger.close();
    assert.match(readFileSync(`${file}.critical`, 'utf8'), /"taskOutcome":"failed"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
