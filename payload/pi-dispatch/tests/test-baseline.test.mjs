import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkEntrypoint, compareBaseline, parseTap } from '../scripts/test-baseline.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/test-baseline.mjs', import.meta.url));
const repoRoot = resolve(dirname(scriptPath), '..', '..', '..');

function tapLog({ failures = [], passes = [] } = {}) {
  const points = [...passes.map((item) => typeof item === 'string' ? { name: item, failed: false } : { ...item, failed: false }), ...failures.map((item) => ({ ...item, failed: true }))];
  const lines = ['> pi-dispatch-runtime@ test', '> node --test tests/*.test.mjs', 'TAP version 13'];
  points.forEach((point, index) => {
    lines.push(`${point.failed ? 'not ok' : 'ok'} ${index + 1} - ${point.name}`);
    if (point.failed || point.file) {
      lines.push('  ---', `  location: '${repoRoot.replaceAll('\\', '/')}/payload/pi-dispatch/tests/${point.file ?? 'sample.test.mjs'}:${point.line ?? 7}:2'`);
      if (point.failed) lines.push('  failureType: testCodeFailure', '  error: |- ', `    ${point.error ?? 'Expected true, got false'}`, '  code: ERR_ASSERTION');
      lines.push('  ...');
    }
  });
  lines.push(`1..${points.length}`, `# tests ${points.length}`, `# pass ${passes.length}`, `# fail ${failures.length}`, '# cancelled 0', '# skipped 0', '# todo 0');
  return `${lines.join('\n')}\n`;
}
function withTempDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'yhwh-test-baseline-'));
  try { callback(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function runCli(args) { return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', windowsHide: true }); }

test('parses failures into stable location, concise redacted error and occurrence identity', () => {
  const parsed = parseTap(tapLog({ failures: [
    { name: 'repeated', file: 'one.test.mjs', line: 19, error: 'token=do-not-copy' },
    { name: 'repeated', file: 'one.test.mjs', line: 20, error: 'expected other value' },
  ] }));
  assert.equal(parsed.failures.length, 2);
  assert.deepEqual(parsed.failures.map((p) => p.id), ['payload/pi-dispatch/tests/one.test.mjs::repeated::1', 'payload/pi-dispatch/tests/one.test.mjs::repeated::2']);
  assert.equal(parsed.failures[0].file, 'payload/pi-dispatch/tests/one.test.mjs');
  assert.equal(parsed.failures[0].line, 19);
  assert.match(parsed.failures[0].errorSummary, /token=\[REDACTED\]/);
  const mixed = parseTap(tapLog({ passes: [{ name: 'same', file: 'mixed.test.mjs' }], failures: [{ name: 'same', file: 'mixed.test.mjs' }] }));
  assert.equal(mixed.failures[0].id, 'payload/pi-dispatch/tests/mixed.test.mjs::same::2');
});

test('rejects missing header/root plan/statistics, malformed points, bailout and inconsistent totals', () => {
  assert.throws(() => parseTap('not a test log'), /TAP version/);
  assert.throws(() => parseTap('TAP version 13\nok 1 - only point\n'), /plan/);
  assert.throws(() => parseTap(tapLog().replace('1..0\n', '')), /root plan/);
  assert.throws(() => parseTap(tapLog().replace('# tests 0', '# tests 1')), /tests count mismatch/);
  assert.throws(() => parseTap(tapLog({ passes: ['ok'] }).replace('ok 1 - ok', 'not ok malformed - broken')), /Malformed TAP point/);
  assert.throws(() => parseTap(tapLog({ passes: ['ok'] }).replace('ok 1 - ok', 'not ok 1')), /Malformed TAP point/);
  assert.throws(() => parseTap(tapLog().replace('# todo 0', 'Bail out! harness stopped\n# todo 0')), /bailout/);
  assert.throws(() => parseTap(tapLog({ failures: [{ name: 'broken' }] }).replace('# fail 1', '# fail 2')), /fail count mismatch/);
  assert.throws(() => parseTap(tapLog({ passes: ['one'] }).replace('# pass 1', '')), /missing final pass/);
});

test('parses children-before-parent nested TAP and validates every scope plan', () => {
  const nested = [
    '> npm test', 'TAP version 13',
    '    ok 1 - repeated', '    ---', `    location: '${repoRoot.replaceAll('\\', '/')}/payload/pi-dispatch/tests/nested.test.mjs:7:1'`, '    type: test', '    ...',
    '    not ok 2 - repeated', '    ---', `    location: '${repoRoot.replaceAll('\\', '/')}/payload/pi-dispatch/tests/nested.test.mjs:8:1'`, '    type: test', '    error: |-','      assertion failed','    ...',
    '    ok 3 - repeated', '    ---', `    location: '${repoRoot.replaceAll('\\', '/')}/payload/pi-dispatch/tests/nested.test.mjs:9:1'`, '    type: test', '    ...',
    '    ok 4 - other', '    ---', '    type: test', '    ...', '    1..4',
    'ok 1 - describe group', '  ---', "  type: 'suite'", '  ...', '1..1',
    '# tests 4', '# pass 3', '# fail 1', '# cancelled 0', '# skipped 0', '# todo 0', '',
  ].join('\n');
  const parsed = parseTap(nested);
  assert.equal(parsed.points.length, 5);
  assert.equal(parsed.failures.length, 1);
  const countedParent = parseTap(nested.replace("type: 'suite'", 'type: test').replace('# tests 4', '# tests 5').replace('# pass 3', '# pass 4'));
  assert.equal(countedParent.points.length, 5);
  assert.deepEqual(parsed.points.filter((p) => p.name === 'repeated').map((p) => p.id), [
    'payload/pi-dispatch/tests/nested.test.mjs::repeated::1', 'payload/pi-dispatch/tests/nested.test.mjs::repeated::2', 'payload/pi-dispatch/tests/nested.test.mjs::repeated::3',
  ]);
  assert.throws(() => parseTap(nested.replace('1..4', '1..3')), /plan mismatch/);
  assert.throws(() => parseTap(nested.replace('1..4', '1..5')), /plan mismatch/);
  assert.throws(() => parseTap(nested.replace('    1..4\n', '')), /missing a plan/);
  assert.throws(() => parseTap(nested.replace('ok 1 - describe group', 'ok 2 - describe group')), /sequence mismatch/);
  assert.throws(() => parseTap(nested.replace('    1..4', '    1..3')), /plan mismatch/);
});

test('normalizes repository-root-relative paths including repeated tests ancestors', () => {
  const parsed = parseTap(tapLog({ failures: [{ name: 'ancestor', file: 'outer/tests/inner/tests/ancestor.test.mjs' }] }));
  assert.equal(parsed.failures[0].file, 'payload/pi-dispatch/tests/outer/tests/inner/tests/ancestor.test.mjs');
  const windowsRoot = repoRoot.replaceAll('/', '\\');
  const windows = tapLog({ failures: [{ name: 'windows', file: 'windows.test.mjs' }] }).replaceAll(`${repoRoot.replaceAll('\\', '/')}/payload/pi-dispatch/tests`, `${windowsRoot}\\payload\\pi-dispatch\\tests`);
  assert.equal(parseTap(windows).failures[0].file, 'payload/pi-dispatch/tests/windows.test.mjs');
});

test('comparison validates baseline fields, exact classification and duplicate IDs', () => {
  const valid = { schemaVersion: 1, failures: [{ id: 'id', file: 'f', name: 'n', classification: 'A' }] };
  for (const field of ['id', 'file', 'name']) {
    assert.throws(() => compareBaseline({ ...valid, failures: [{ ...valid.failures[0], [field]: '   ' }] }, { failures: [] }), /nonempty/);
  }
  for (const classification of [' A', 'a', 'A ', 1, null]) assert.throws(() => compareBaseline({ ...valid, failures: [{ ...valid.failures[0], classification }] }, { failures: [] }), /classification/);
  assert.throws(() => compareBaseline({ ...valid, failures: [...valid.failures, valid.failures[0]] }, { failures: [] }), /Duplicate baseline id/);
});

test('comparison groups new, fixed and still-failing records', () => {
  const baseline = { schemaVersion: 1, failures: [
    { id: 'a', file: 'a', name: 'still', classification: 'A' }, { id: 'b', file: 'b', name: 'fixed', classification: 'B' },
  ] };
  const result = compareBaseline(baseline, { failures: [{ id: 'a', name: 'still' }, { id: 'c', name: 'new' }] });
  assert.deepEqual(result.newFailures.map((f) => f.name), ['new']);
  assert.deepEqual(result.fixed.map((f) => f.name), ['fixed']);
  assert.deepEqual(result.stillFailing.map((f) => [f.name, f.classification]), [['still', 'A']]);
});

test('CLI decodes UTF-8, UTF-16LE and UTF-16BE BOM logs', () => {
  withTempDirectory((dir) => {
    const baseline = join(dir, 'baseline.json'); const log = tapLog({ passes: ['passed'] });
    const utf8 = join(dir, 'utf8.tap'); const le = join(dir, 'le.tap'); const be = join(dir, 'be.tap');
    writeFileSync(utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(log)]));
    writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(log, 'utf16le')]));
    const little = Buffer.from(log, 'utf16le'); const big = Buffer.alloc(little.length);
    for (let i = 0; i < little.length; i += 2) { big[i] = little[i + 1]; big[i + 1] = little[i]; }
    writeFileSync(be, Buffer.concat([Buffer.from([0xfe, 0xff]), big]));
    for (const path of [utf8, le, be]) assert.equal(runCli(['--record', path, '--baseline', baseline]).status, 0);
  });
});

test('CLI rejects invalid baseline data and direct entrypoint check handles symlinks and mismatches', (t) => {
  withTempDirectory((dir) => {
    const baseline = join(dir, 'baseline.json'); const log = join(dir, 'run.tap');
    writeFileSync(log, tapLog());
    writeFileSync(baseline, JSON.stringify({ schemaVersion: 1, failures: [{ id: 'x', file: 'x', name: 'x', classification: ' A' }] }));
    assert.equal(runCli(['--compare', log, '--baseline', baseline]).status, 2);
    assert.equal(checkEntrypoint(scriptPath), true);
    assert.throws(() => checkEntrypoint(log), /entrypoint mismatch/);
    const mismatchCode = `import { checkEntrypoint } from ${JSON.stringify(new URL('../scripts/test-baseline.mjs', import.meta.url).href)}; try { checkEntrypoint(${JSON.stringify(scriptPath)}, ${JSON.stringify(log)}); } catch (error) { console.error(error.message); process.exitCode = 2; }`;
    const mismatch = spawnSync(process.execPath, ['--input-type=module', '-e', mismatchCode], { encoding: 'utf8' });
    assert.equal(mismatch.status, 2);
    assert.match(mismatch.stderr, /entrypoint mismatch/);
    const link = join(dir, 'baseline-link.mjs');
    try {
      symlinkSync(scriptPath, link);
      assert.equal(checkEntrypoint(link), true);
      const invoked = spawnSync(process.execPath, [link, '--record', log, '--baseline', baseline], { encoding: 'utf8' });
      assert.equal(invoked.status, 0, invoked.stderr);
    } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic(`SKIP symlink execution checks: ${error.code}`); }
  });
});

test('record and compare CLI preserve classification and nonzero failure behavior', () => {
  withTempDirectory((dir) => {
    const baselinePath = join(dir, 'baseline.json'); const log = join(dir, 'run.tap');
    writeFileSync(log, tapLog({ failures: [{ name: 'known failure' }] }));
    const recorded = runCli(['--record', log, '--classification', 'A', '--baseline', baselinePath]);
    assert.equal(recorded.status, 0, recorded.stderr);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.equal(baseline.failures[0].classification, 'A');
    writeFileSync(log, tapLog({ failures: [{ name: 'known failure' }, { name: 'new failure' }] }));
    assert.equal(runCli(['--compare', log, '--baseline', baselinePath]).status, 1);
  });
});
