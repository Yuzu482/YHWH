import test from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_PREFIX, publicFormatValidation, recoverPrefacedKetherResult, validateKetherResult } from '../extensions/result-format-validator.js';

const fields = ['status', 'result', 'evidence', 'errors'];

test('accepts one exact prefixed JSON object with requested fields', () => {
  const value = { status: 'completed', result: 'done', evidence: ['observed'], errors: [] };
  const validation = validateKetherResult(`${RESULT_PREFIX}${JSON.stringify(value)}`, fields);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.value, value);
  assert.deepEqual(publicFormatValidation(validation), { ok: true, code: 'valid', message: undefined, expectedFields: fields });
});

test('recovers a valid envelope after a CRLF preface without changing strict validation', () => {
  const value = { status: 'completed', result: 'done', evidence: ['observed'], errors: [] };
  const envelope = `${RESULT_PREFIX}${JSON.stringify(value)}`;
  const recovered = recoverPrefacedKetherResult(`Notice\r\n${envelope}`, fields);
  assert.ok(recovered);
  assert.equal(recovered.canonicalText, envelope);
  assert.deepEqual(recovered.validation.value, value);
  assert.equal(validateKetherResult(`Notice\r\n${envelope}`, fields).code, 'missing_prefix');
});

test('rejects invalid prefaces and envelopes at boundaries', () => {
  const envelope = `${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: 'done', evidence: [], errors: [] })}`;
  assert.equal(recoverPrefacedKetherResult(`\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\t\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`${'x'.repeat(257)}\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\nsecond line\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice ${RESULT_PREFIX}\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\n${envelope}\ntrailing prose`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\n${RESULT_PREFIX}{bad`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\n${RESULT_PREFIX}${JSON.stringify({ status: 'completed' })}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\n${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: 'x'.repeat(512 * 1024), evidence: [], errors: [] })}`, fields), null);
});

test('rejects prose, malformed JSON, missing/extra fields, and invalid status', () => {
  assert.equal(validateKetherResult('Here is the result', fields).code, 'missing_prefix');
  assert.equal(validateKetherResult(`${RESULT_PREFIX}{bad`, fields).code, 'invalid_json');
  assert.equal(validateKetherResult(`${RESULT_PREFIX}${JSON.stringify({ status: 'completed' })}`, fields).code, 'field_mismatch');
  assert.equal(validateKetherResult(`${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: '', evidence: [], errors: [], extra: true })}`, fields).code, 'field_mismatch');
  assert.equal(validateKetherResult(`${RESULT_PREFIX}${JSON.stringify({ status: 'maybe', result: '', evidence: [], errors: [] })}`, fields).code, 'invalid_status');
});

test('rejects excessive depth without model evaluation', () => {
  let nested = 'leaf';
  for (let index = 0; index < 14; index++) nested = [nested];
  const validation = validateKetherResult(`${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: nested, evidence: [], errors: [] })}`, fields);
  assert.equal(validation.code, 'complexity_limit');
});
