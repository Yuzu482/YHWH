import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateExecutionBudget } from '../extensions/execution-budget.js';

test('execution budget reserves time and floors sandbox seconds', () => {
  assert.deepEqual(calculateExecutionBudget({ overallTimeoutSeconds: 180 }), {
    ok: true, overallTimeoutSeconds: 180, elapsedMs: 0, reserveSeconds: 15, sandboxSeconds: 165,
  });
  const consumed = calculateExecutionBudget({ overallTimeoutSeconds: 180, elapsedMs: 20_000 });
  assert.equal(consumed.sandboxSeconds, 145);
  assert.equal(consumed.sandboxSeconds + consumed.reserveSeconds + consumed.elapsedMs / 1000 <= consumed.overallTimeoutSeconds, true);
  assert.equal(calculateExecutionBudget({ overallTimeoutSeconds: 5 }).sandboxSeconds, 4);
});

test('execution budget fails closed for exhausted and invalid input', () => {
  for (const input of [
    { overallTimeoutSeconds: 1, elapsedMs: 1_000 },
    { overallTimeoutSeconds: 1, elapsedMs: 2_000 },
    { overallTimeoutSeconds: 0 },
    { overallTimeoutSeconds: NaN },
    { overallTimeoutSeconds: Infinity },
    { overallTimeoutSeconds: -1 },
    { overallTimeoutSeconds: 10, elapsedMs: NaN },
    { overallTimeoutSeconds: 10, elapsedMs: Infinity },
    { overallTimeoutSeconds: 10, elapsedMs: -1 },
  ]) assert.equal(calculateExecutionBudget(input).ok, false);
});
