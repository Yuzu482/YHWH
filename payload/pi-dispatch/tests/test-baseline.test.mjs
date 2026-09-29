import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareBaseline, parseTap } from '../scripts/test-baseline.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/test-baseline.mjs', import.meta.url));

function tapLog({ failures = [], passes = [] } = {}) {
  const points = [...passes.map((name) => ({ name, failed: false })), ...failures.map((item) => ({ ...item, failed: true }))];
  const lines = ['TAP version 13'];
  points.forEach((point, index) => {
    lines.push(`${point.failed ? 'not ok' : 'ok'} ${index + 1} - ${point.name}`);
    if (point.failed) {
      lines.push('  ---');
      lines.push(`  location: 'C:\\repo\\payload\\pi-dispatch\\tests\\${point.file ?? 'sample.test.mjs'}:${point.line ?? 7}:2'`);
      lines.push('  failureType: testCodeFailure');
      lines.push(`  error: |-`);
      lines.push(`    ${point.error ?? 'Expected true, got false'}`);
      lines.push('  code: ERR_ASSERTION');
      lines.push('  ...');
    }
  });
  lines.push(`# tests ${points.length}`, `# pass ${passes.length}`, `# fail ${failures.length}`, '# cancelled 0', '# skipped 0');
  return `${lines.join('\n')}\n`;
}

function withTempDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'yhwh-test-baseline-'));
  try { callback(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', windowsHide: true });
}

test('parses TAP failures into stable test identity, source location and concise error', () => {
  const parsed = parseTap(tapLog({ failures: [{ name: 'rejects invalid token', file: 'auth.test.mjs', line: 19, error: 'token=do-not-copy' }] }));
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0].id, 'tests/auth.test.mjs::rejects invalid token');
  assert.equal(parsed.failures[0].file, 'tests/auth.test.mjs');
  assert.equal(parsed.failures[0].line, 19);
  assert.match(parsed.failures[0].errorSummary, /token=\[REDACTED\]/);
});

test('rejects malformed or empty TAP input and inconsistent failure totals', () => {
  assert.throws(() => parseTap('not a test log'), /TAP version/);
  assert.throws(() => parseTap('TAP version 13\n# tests 0\n# fail 0\n'), /no test points/);
  assert.throws(() => parseTap(tapLog({ failures: [{ name: 'broken' }] }).replace('# fail 1', '# fail 2')), /failure count mismatch/);
});

test('comparison groups new, fixed and still-failing tests and retains A/B classification', () => {
  const baseline = {
    schemaVersion: 1,
    failures: [
      { id: 'tests/a.test.mjs::still broken', name: 'still broken', classification: 'A' },
      { id: 'tests/b.test.mjs::fixed now', name: 'fixed now', classification: 'B' },
    ],
  };
  const current = { failures: [
    { id: 'tests/a.test.mjs::still broken', name: 'still broken' },
    { id: 'tests/c.test.mjs::new issue', name: 'new issue' },
  ] };
  const compared = compareBaseline(baseline, current);
  assert.deepEqual(compared.newFailures.map((failure) => failure.name), ['new issue']);
  assert.deepEqual(compared.fixed.map((failure) => failure.name), ['fixed now']);
  assert.deepEqual(compared.stillFailing.map((failure) => [failure.name, failure.classification]), [['still broken', 'A']]);
});

test('record CLI writes classifications and compare exits nonzero for new or unresolved B failures', () => {
  withTempDirectory((directory) => {
    const log = join(directory, 'run.tap');
    const baselinePath = join(directory, 'baseline.json');
    writeFileSync(log, tapLog({ failures: [{ name: 'known failure', file: 'known.test.mjs' }] }));
    const recorded = runCli(['--record', log, '--classification', 'A', '--baseline', baselinePath]);
    assert.equal(recorded.status, 0, recorded.stderr);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.equal(baseline.schemaVersion, 1);
    assert.match(baseline.commit, /^[0-9a-f]{40}$|^unknown$/);
    assert.equal(baseline.failures[0].classification, 'A');
    assert.equal(baseline.failures[0].name, 'known failure');

    writeFileSync(log, tapLog({ failures: [
      { name: 'known failure', file: 'known.test.mjs' },
      { name: 'new failure', file: 'new.test.mjs' },
    ] }));
    const comparison = runCli(['--compare', log, '--baseline', baselinePath]);
    assert.equal(comparison.status, 1);
    assert.match(comparison.stdout, /New failures \(1\)/);
    assert.match(comparison.stdout, /Still failing \(1\)/);
  });

  withTempDirectory((directory) => {
    const log = join(directory, 'run.tap');
    const baselinePath = join(directory, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 1, failures: [{ id: 'tests/known.test.mjs::known failure', name: 'known failure', classification: 'B' }] }));
    writeFileSync(log, tapLog({ failures: [{ name: 'known failure', file: 'known.test.mjs' }] }));
    const comparison = runCli(['--compare', log, '--baseline', baselinePath]);
    assert.equal(comparison.status, 1);
    assert.match(comparison.stderr, /Unresolved B-class/);
  });
});
