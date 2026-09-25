import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESULT_PREFIX,
  validateKetherResult,
  publicFormatValidation,
} from '../extensions/result-format-validator.js';

const sentinel = 'SYNTHETIC_SENTINEL_7f2c';
const diagnosticKeys = [
  'category',
  'categoryIsHeuristic',
  'payloadLength',
  'parseErrorOffset',
];

function checkInvalidJson(payload) {
  const validation = validateKetherResult(`${RESULT_PREFIX}${payload}`, ['status', 'result']);
  assert.equal(validation.ok, false);
  assert.equal(validation.code, 'invalid_json');

  const diagnostic = validation.diagnostic;
  assert.ok(diagnostic);
  assert.ok(['incomplete', 'trailing_data', 'syntax_error/unknown'].includes(diagnostic.category));
  assert.equal(diagnostic.categoryIsHeuristic, true);
  assert.ok(Number.isInteger(diagnostic.payloadLength));
  assert.ok(diagnostic.parseErrorOffset === null || Number.isInteger(diagnostic.parseErrorOffset));
  assert.deepEqual(Object.keys(diagnostic).sort(), [...diagnosticKeys].sort());

  const publicResult = publicFormatValidation(validation);
  assert.equal(typeof publicResult, 'object');
  const serialized = JSON.stringify(publicResult);
  assert.ok(!serialized.includes(sentinel));
  return diagnostic;
}

test('valid and missing-prefix results retain their validation behavior', () => {
  const valid = validateKetherResult(
    `${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: 'synthetic' })}`,
    ['status', 'result'],
  );
  assert.equal(valid.ok, true);

  const missingPrefix = validateKetherResult(
    JSON.stringify({ status: 'ok', result: 'synthetic' }),
    ['status', 'result'],
  );
  assert.equal(missingPrefix.ok, false);
  assert.equal(missingPrefix.code, 'missing_prefix');
});

test('invalid JSON reports sanitized diagnostics for incomplete, syntax, and trailing input', () => {
  const incomplete = checkInvalidJson('{"status":"ok","result":"unfinished');
  assert.equal(incomplete.category, 'incomplete');

  const syntax = checkInvalidJson(`{"status":${sentinel} !}`);
  assert.equal(syntax.category, 'syntax_error/unknown');

  const trailing = checkInvalidJson(`{"status":"ok","result":"fine"} ${sentinel}`);
  assert.equal(trailing.category, 'trailing_data');
});
