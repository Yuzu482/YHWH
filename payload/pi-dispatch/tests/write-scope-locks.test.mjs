import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteScopeLockManager, scopesOverlap } from '../extensions/write-scope-locks.js';

test('scope overlap detects exact files and parent directory trees', () => {
  assert.equal(scopesOverlap({ path: 'c:\\repo\\a.txt', tree: false }, { path: 'c:\\repo\\a.txt', tree: false }), true);
  assert.equal(scopesOverlap({ path: 'c:\\repo\\src', tree: true }, { path: 'c:\\repo\\src\\a.ts', tree: false }), true);
  assert.equal(scopesOverlap({ path: 'c:\\repo\\src', tree: true }, { path: 'c:\\repo\\tests', tree: true }), false);
});

test('persistent write locks reject overlapping scopes and allow disjoint scopes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-write-locks-'));
  const cwd = process.cwd();
  try {
    const firstManager = createWriteScopeLockManager(directory);
    const secondManager = createWriteScopeLockManager(directory);
    const first = firstManager.tryAcquire({ requestId: 'one', cwd, writeScope: ['src/**'], timeoutSeconds: 30 });
    assert.ok(first);
    assert.equal(secondManager.tryAcquire({ requestId: 'two', cwd, writeScope: ['src/file.js'], timeoutSeconds: 30 }), null);
    const disjoint = secondManager.tryAcquire({ requestId: 'three', cwd, writeScope: ['tests/file.js'], timeoutSeconds: 30 });
    assert.ok(disjoint);
    secondManager.release(disjoint);
    firstManager.release(first);
    assert.ok(secondManager.tryAcquire({ requestId: 'four', cwd, writeScope: ['src/file.js'], timeoutSeconds: 30 }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
