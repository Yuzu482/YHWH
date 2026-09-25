import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditRecord } from '../extensions/audit-log.js';

test('audit record stores only allowlisted invalid JSON format diagnostics', () => {
  const sentinel = 'SENTINEL_MUST_NOT_BE_PERSISTED';
  const record = buildAuditRecord({
    operation: 'execute',
    result: {
      ok: false,
      text: sentinel,
      formatValidation: {
        ok: false,
        code: 'invalid_json',
        message: sentinel,
        expectedFields: [sentinel],
        diagnostic: {
          category: 'incomplete',
          categoryIsHeuristic: true,
          payloadLength: 42,
          parseErrorOffset: 12,
          extra: sentinel,
        },
      },
    },
  });

  assert.deepEqual(record.formatDiagnostic, {
    code: 'invalid_json',
    category: 'incomplete',
    categoryIsHeuristic: true,
    payloadLength: 42,
    parseErrorOffset: 12,
  });
  assert.equal(JSON.stringify(record).includes(sentinel), false);
});

test('audit record persists syntax_error/unknown diagnostics without raw sentinel data', () => {
  const sentinel = 'SENTINEL_MUST_NOT_BE_PERSISTED';
  const record = buildAuditRecord({
    operation: 'execute',
    result: {
      ok: false,
      formatValidation: {
        code: 'invalid_json',
        diagnostic: {
          category: 'syntax_error/unknown',
          categoryIsHeuristic: false,
          payloadLength: 17,
          rawMessage: sentinel,
        },
      },
    },
  });

  assert.deepEqual(record.formatDiagnostic, {
    code: 'invalid_json',
    category: 'syntax_error/unknown',
    categoryIsHeuristic: false,
    payloadLength: 17,
  });
  assert.equal(JSON.stringify(record).includes(sentinel), false);
});

test('audit record omits format diagnostic when validation is absent or not invalid JSON', () => {
  const successful = buildAuditRecord({ operation: 'execute', result: { ok: true } });
  assert.equal(Object.hasOwn(successful, 'formatDiagnostic'), false);

  const otherFailure = buildAuditRecord({
    operation: 'execute',
    result: { ok: false, formatValidation: { code: 'other', diagnostic: { category: 'syntax_error' } } },
  });
  assert.equal(Object.hasOwn(otherFailure, 'formatDiagnostic'), false);
});
