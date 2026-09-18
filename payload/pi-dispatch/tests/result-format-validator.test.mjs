import test from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_PREFIX, publicFormatValidation, validateKetherResult } from '../extensions/result-format-validator.js';

const fields = ['status', 'result', 'evidence', 'errors'];

test('accepts one exact prefixed JSON object with requested fields', () => {
  const value = { status: 'completed', result: 'done', evidence: ['observed'], errors: [] };
  const validation = validateKetherResult(`${RESULT_PREFIX}${JSON.stringify(value)}`, fields);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.value, value);
  assert.deepEqual(publicFormatValidation(validation), { ok: true, code: 'valid', message: undefined, expectedFields: fields });
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
