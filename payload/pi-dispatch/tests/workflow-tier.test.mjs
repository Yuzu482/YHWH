import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeclaredWorkflowTier, validateWorkflowTier } from '../extensions/workflow-tier.js';

const base = overrides => ({
  files: ['src/file.js'], estimatedLines: 20, isTestOrConfigChange: false,
  publicApiOrProtocol: false, dependencyOrLockfile: false, securityAuthOrCredentials: false,
  migration: false, irreversibleOrNoRollback: false, uncertainFileScope: false,
  ...overrides,
});

test('workflow tiers enforce exact-file, line and file-count boundaries', () => {
  assert.equal(validateWorkflowTier(base({})).level, 'T0');
  assert.equal(validateWorkflowTier(base({ estimatedLines: 21 })).level, 'T1');
  assert.equal(validateWorkflowTier(base({ files: ['a.js', 'b.js'] })).level, 'T1');
  assert.equal(validateWorkflowTier(base({ files: ['a.js'], estimatedLines: 20 })).level, 'T0');
});

test('test/config changes require T1', () => {
  assert.equal(validateWorkflowTier(base({ isTestOrConfigChange: true })).level, 'T1');
});

test('each high-risk trigger requires T2 and both reviews', () => {
  for (const key of ['publicApiOrProtocol', 'dependencyOrLockfile', 'securityAuthOrCredentials', 'migration', 'irreversibleOrNoRollback', 'uncertainFileScope']) {
    assert.deepEqual(validateWorkflowTier(base({ [key]: true })), { level: 'T2', requiresPreReview: true, requiresPostReview: true });
  }
});

test('minimum tier review requirements are returned', () => {
  assert.deepEqual(validateWorkflowTier(base({})), { level: 'T0', requiresPreReview: false, requiresPostReview: false });
  assert.deepEqual(validateWorkflowTier(base({ estimatedLines: 21 })), { level: 'T1', requiresPreReview: false, requiresPostReview: true });
});

test('declared tier is preserved and effective review follows the higher declared tier', () => {
  assert.throws(() => validateDeclaredWorkflowTier(base({ estimatedLines: 21 }), 'T0', ['src/file.js']), { code: 'WORKFLOW_TIER_INVALID' });
  assert.deepEqual(validateDeclaredWorkflowTier(base({}), 'T2', ['src/file.js']), {
    declaredLevel: 'T2', minimumLevel: 'T0', level: 'T2', requiresPreReview: true, requiresPostReview: true,
  });
  assert.deepEqual(validateDeclaredWorkflowTier(base({ estimatedLines: 21 }), 'T2', ['src/file.js']), {
    declaredLevel: 'T2', minimumLevel: 'T1', level: 'T2', requiresPreReview: true, requiresPostReview: true,
  });
  assert.throws(() => validateDeclaredWorkflowTier(base({}), 'T3', ['src/file.js']), { code: 'WORKFLOW_TIER_INVALID' });
});

test('writeScope and declaration files must match exactly irrespective of order', () => {
  const declaration = base({ files: ['src/a.js', 'src/b.js'] });
  assert.equal(validateDeclaredWorkflowTier(declaration, 'T1', ['src/b.js', 'src/a.js']).level, 'T1');
  for (const scope of [['src/a.js'], ['src/a.js', 'src/b.js', 'extra.js'], ['src/a.js', 'src/*.js']]) {
    assert.throws(() => validateDeclaredWorkflowTier(declaration, 'T1', scope), { code: 'WORKFLOW_TIER_INVALID' });
  }
  assert.throws(() => validateDeclaredWorkflowTier(base({}), 'T0', undefined), { code: 'WORKFLOW_TIER_INVALID' });
});

test('wildcards, traversal, unknown flags, and unknown keys fail closed', () => {
  for (const path of ['src/**', 'src/*.js', '../file.js', '/absolute.js']) {
    assert.throws(() => validateWorkflowTier(base({ files: [path] })), { code: 'WORKFLOW_TIER_INVALID' });
  }
  assert.throws(() => validateWorkflowTier({ ...base({}), surprise: false }), { code: 'WORKFLOW_TIER_INVALID' });
  assert.throws(() => validateWorkflowTier(base({ publicApiOrProtocol: 'unknown' })), { code: 'WORKFLOW_TIER_INVALID' });
});
