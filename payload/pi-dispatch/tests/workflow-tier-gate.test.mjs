import test from 'node:test';
import assert from 'node:assert/strict';
import { tierDeclarationSchema, validateT0Patch, validateWriteTier } from '../scripts/workflow-tier-gate.mjs';

const declaration = overrides => ({ files: ['src/a.js'], estimatedLines: 4, isTestOrConfigChange: false,
  publicApiOrProtocol: false, dependencyOrLockfile: false, securityAuthOrCredentials: false,
  migration: false, irreversibleOrNoRollback: false, uncertainFileScope: false, ...overrides });
const input = (overrides = {}) => ({ access: 'workspace-write', workflowReceipt: 'receipt', tier: 'T0',
  tierDeclaration: declaration(), task: { writeScope: ['src/a.js'] }, ...overrides });
const requireTopic = (topic, receipt) => { assert.equal(topic, 'task-tiers'); assert.equal(receipt, 'receipt'); };
function diff(count, prefix = 'diff -ruN old/a.js new/a.js\n') {
  return `${prefix}--- old/a.js\tdate\n+++ new/a.js\tdate\n@@ -1 +1 @@\n${'-x\n'.repeat(count)}${'+y\n'.repeat(count)}`;
}

test('tier declaration schema is bounded and strict', () => {
  assert.equal(tierDeclarationSchema.safeParse(declaration()).success, true);
  assert.equal(tierDeclarationSchema.safeParse({ ...declaration(), unexpected: true }).success, false);
  assert.equal(tierDeclarationSchema.safeParse(declaration({ files: ['../escape'] })).success, false);
  assert.equal(tierDeclarationSchema.safeParse(declaration({ files: ['src/a.js', 'src/a.js'] })).success, false);
});

test('write tiers require task-tiers receipt; reads bypass the write gate', () => {
  assert.equal(validateWriteTier({ access: 'read' }, () => assert.fail('read must not require receipt')), null);
  assert.throws(() => validateWriteTier(input(), null), /receipt verifier/);
  assert.deepEqual(validateWriteTier(input(), requireTopic), {
    level: 'T0', minimumLevel: 'T0', requiresPreReview: false, requiresPostReview: false,
  });
});

test('missing and understated tiers are rejected', () => {
  assert.throws(() => validateWriteTier(input({ tier: undefined }), requireTopic), e => e.code === 'WORKFLOW_TIER_REQUIRED');
  assert.throws(() => validateWriteTier(input({ tierDeclaration: undefined }), requireTopic), e => e.code === 'WORKFLOW_TIER_REQUIRED');
  assert.throws(() => validateWriteTier(input({ tierDeclaration: declaration({ estimatedLines: 21 }) }), requireTopic), /below minimum tier T1/);
});

test('T2 demands v2 implementing Chesed handoff with Geburah pre-review input', () => {
  const tierDeclaration = declaration({ publicApiOrProtocol: true });
  assert.throws(() => validateWriteTier(input({ tier: 'T2', tierDeclaration }), requireTopic), e => e.code === 'WORKFLOW_TIER_PRE_REVIEW_REQUIRED');
  const task = { role: 'Chesed', writeScope: ['src/a.js'], handoff: { version: 2, stage: 'implementing', inputs: [{ role: 'Geburah', stage: 'pre-review' }] } };
  assert.equal(validateWriteTier(input({ tier: 'T2', tierDeclaration, task }), requireTopic).requiresPreReview, true);
});

test('T0 patch gate accepts real diff -ruN and git diff forms up to 20 changed lines', () => {
  assert.equal(validateT0Patch(diff(10)), true);
  assert.equal(validateT0Patch(diff(10, 'diff --git a/a.js b/a.js\n')), true);
  assert.equal(validateT0Patch(diff(11)), false);
  assert.equal(validateT0Patch(diff(10).replace(/\n\+y\n/g, '\n+y\n\n')) , true);
});

test('T0 patch gate rejects multiple files, empty and malformed patches', () => {
  assert.equal(validateT0Patch(''), false);
  assert.equal(validateT0Patch('not a patch'), false);
  assert.equal(validateT0Patch(diff(1) + '\ndiff -ruN old/b.js new/b.js\n--- old/b.js\n+++ new/b.js\n@@ -1 +1 @@\n-x\n+y'), false);
  assert.equal(validateT0Patch('diff -ruN old/a.js new/a.js\n--- old/a.js\n+++ new/a.js\n'), false);
});

test('source lines beginning ++ and -- count as additions and deletions', () => {
  const patch = 'diff -ruN old/a.js new/a.js\n--- old/a.js\n+++ new/a.js\n@@ -1 +1 @@\n--old\n++new\n';
  assert.equal(validateT0Patch(patch), true);
  assert.equal(validateT0Patch(patch.replace('--old\n', `${'--old\n'.repeat(20)}`)), false);
  const plusPlusSource = 'diff -ruN old/a.js new/a.js\n--- old/a.js\n+++ new/a.js\n@@ -1 +1 @@\n+++source\n-y\n';
  assert.equal(validateT0Patch(plusPlusSource), true);
  assert.equal(validateT0Patch(plusPlusSource.replace('-y\n', '-y\n'.repeat(20))), false);
});
