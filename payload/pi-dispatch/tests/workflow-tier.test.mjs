import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkflowTier, parseUnifiedPatch, validateDeclaredWorkflowTier, validateWorkflowTier } from '../extensions/workflow-tier.js';

const base = overrides => ({ publicApiOrProtocol:false, dependencyOrLockfile:false, securityAuthOrCredentials:false, migration:false, irreversibleOrNoRollback:false, ...overrides });

test('declarations have exactly five semantic boolean flags; file/sizing caller fields fail closed', () => {
  assert.equal(validateWorkflowTier(base()).level, 'T0');
  assert.throws(() => validateWorkflowTier({ ...base(), files:['src/a'] }), { code:'WORKFLOW_TIER_INVALID' });
  assert.throws(() => validateWorkflowTier({ ...base(), estimatedLines:1 }), { code:'WORKFLOW_TIER_INVALID' });
});

test('actual file and line boundaries, conventional exemption, and semantic flags classify correctly', () => {
  const classify = (files, lines, declaration=base()) => classifyWorkflowTier({ files, addedLines:lines, deletedLines:0, declaration });
  assert.equal(classify(['src/a','src/b','src/c'],100).effective,'T0');
  assert.equal(classify(['src/a','src/b','src/c','src/d'],1).effective,'T1');
  assert.equal(classify(['src/a'],101).effective,'T1');
  assert.equal(classify(['tests/a','docs/b','fixtures/c','src/tests-data.js'],500).effective,'T1');
  assert.equal(classify(['tests/a','docs/b','fixtures/c'],500).effective,'T0');
  assert.equal(classify(['tests/a'],500,base({migration:true})).effective,'T2');
  assert.equal(classify(['README.md'],101).effective,'T0');
  assert.equal(classify(['docs/CHANGELOG.txt'],500).effective,'T0');
  assert.equal(classify(['src/widget.test.mjs'],101).effective,'T0');
  assert.equal(classify(['src/widget.spec.ts'],500).effective,'T0');
  assert.equal(classify(['src/widget.js'],101).effective,'T1');
  assert.equal(classify(['config.json'],101).effective,'T1');
  assert.equal(classify(['src/widget.test.mjs'],101,base({securityAuthOrCredentials:true})).effective,'T2');
  assert.equal(classify(['notes.txt'],500).effective,'T1');
});

test('profiles apply exact critical maximum and personal cap semantics', () => {
  const classify = (files, flags, riskProfile) => classifyWorkflowTier({ files, addedLines:1, deletedLines:0, declaration:base(flags), riskProfile });
  assert.equal(classify(['src/a'], {}, 'standard').effective, 'T0');
  assert.equal(classify(['src/a'], {}, 'critical').effective, 'T1');
  assert.equal(classify(['src/a','src/b','src/c','src/d'], {}, 'critical').effective, 'T1');
  assert.equal(classify(['src/a'], {migration:true}, 'personal').effective, 'T1');
  assert.equal(classify(['src/a','src/b','src/c','src/d'], {}, 'personal').effective, 'T1');
  assert.equal(classify(['src/a'], {}, 'personal').effective, 'T0');
});

test('each high-risk trigger requires T2 and both reviews', () => {
  for (const key of ['publicApiOrProtocol', 'dependencyOrLockfile', 'securityAuthOrCredentials', 'migration', 'irreversibleOrNoRollback']) {
    assert.deepEqual(validateWorkflowTier(base({ [key]: true })), { level: 'T2', requiresPreReview: true, requiresPostReview: true });
  }
});

test('minimum tier review requirements are returned', () => {
  assert.deepEqual(validateWorkflowTier(base({})), { level: 'T0', requiresPreReview: false, requiresPostReview: false });
  assert.deepEqual(validateWorkflowTier(base({ migration:true })), { level: 'T2', requiresPreReview: true, requiresPostReview: true });
});

test('declared tier is preserved and effective review follows the higher declared tier', () => {
  assert.throws(() => validateDeclaredWorkflowTier(base({ migration:true }), 'T0', ['src/file.js']), { code: 'WORKFLOW_TIER_INVALID' });
  assert.deepEqual(validateDeclaredWorkflowTier(base({}), 'T2', ['src/file.js']), {
    declaredLevel: 'T2', minimumLevel: 'T0', level: 'T2', requiresPreReview: true, requiresPostReview: true,
  });
  assert.deepEqual(validateDeclaredWorkflowTier(base({ migration:true }), 'T2', ['src/file.js']), {
    declaredLevel: 'T2', minimumLevel: 'T2', level: 'T2', requiresPreReview: true, requiresPostReview: true,
  });
  assert.throws(() => validateDeclaredWorkflowTier(base({}), 'T3', ['src/file.js']), { code: 'WORKFLOW_TIER_INVALID' });
});

test('writeScope preserves exact paths and directory trees independently of actual patch files', () => {
  assert.equal(validateDeclaredWorkflowTier(base(), 'T1', ['src/b.js','src/a.js']).level, 'T1');
  assert.equal(validateDeclaredWorkflowTier(base(), 'T1', ['src/**']).level, 'T1');
  for (const scope of [undefined, [], ['../escape'], ['src/*.js'], ['src/a*'], ['src/  '], ['src/**','src/**'], ['']]) assert.throws(() => validateDeclaredWorkflowTier(base(), 'T1', scope), { code:'WORKFLOW_TIER_INVALID' });
  assert.throws(() => classifyWorkflowTier({ files:['src/**'], addedLines:0, deletedLines:0, declaration:base() }), { code:'WORKFLOW_TIER_INVALID' });
});

test('unified parser verifies hunk counts, CRLF, deletions, newline marker, and actual diff styles', () => {
  for (const prefix of ['diff -ruN old/a.js new/a.js\r\n','diff --git a/a.js b/a.js\r\n']) {
    const patch = `${prefix}--- a/a.js\r\n+++ b/a.js\r\n@@ -2,2 +2,1 @@\r\n-old\r\n keep\r\n\\ No newline at end of file\r\n`;
    const result=parseUnifiedPatch(patch); assert.equal(result[0].deletedLines,1); assert.equal(result[0].addedLines,0);
  }
  assert.throws(() => parseUnifiedPatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,1 @@\n-x\n+y\n'), /hunk counts/);
  const headerOnly = parseUnifiedPatch('--- /var/lib/pi-kether/jobs/11111111-1111-4111-8111-111111111111/baseline/src/a.js\n+++ /var/lib/pi-kether/jobs/11111111-1111-4111-8111-111111111111/workspace/src/a.js\n@@ -0,0 +1 @@\n+line\n');
  assert.deepEqual(headerOnly[0].files, ['src/a.js']);
  const bodyMarkers = parseUnifiedPatch('diff -ruN old/a new/a\n--- old/a\n+++ new/a\n@@ -1 +1 @@\n--- body\n+++ body\n');
  assert.equal(bodyMarkers[0].deletedLines, 1);
  assert.equal(bodyMarkers[0].addedLines, 1);
  assert.throws(() => parseUnifiedPatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +0,0 @@\n'));
  for (const patch of ['', 'diff --git a/a b/a\nrename from a\nrename to b\n', 'diff --git a/a b/a\nGIT binary patch\n', 'diff --git a/a b/a\n--- a/a\n+++ b/a\n']) assert.throws(() => parseUnifiedPatch(patch));
  const trailing = '--- a/src/baseline/a.js\n+++ a/src/baseline/a.js\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file';
  assert.deepEqual(parseUnifiedPatch(trailing)[0].files, ['src/baseline/a.js']);
  for (const suffix of ['\\ No newline at end of file attack', '-outside', '+outside', 'arbitrary metadata']) assert.throws(() => parseUnifiedPatch(`${trailing}\n${suffix}`));
});

test('wildcards, traversal, unknown flags, and unknown keys fail closed', () => {
  for (const path of ['src/**', 'src/*.js', '../file.js', '/absolute.js']) {
    assert.throws(() => validateWorkflowTier(base({ files: [path] })), { code: 'WORKFLOW_TIER_INVALID' });
  }
  assert.throws(() => validateWorkflowTier({ ...base({}), surprise: false }), { code: 'WORKFLOW_TIER_INVALID' });
  assert.throws(() => validateWorkflowTier(base({ publicApiOrProtocol: 'unknown' })), { code: 'WORKFLOW_TIER_INVALID' });
});
