import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteScopeLockManager, scopesOverlap } from '../extensions/write-scope-locks.js';

test('scope overlap detects exact files and parent directory trees', () => {
  const root=join('fixture','repo');
  assert.equal(scopesOverlap({ path: join(root,'a.txt'), tree: false }, { path: join(root,'a.txt'), tree: false }), true);
  assert.equal(scopesOverlap({ path: join(root,'src'), tree: true }, { path: join(root,'src','a.ts'), tree: false }), true);
  assert.equal(scopesOverlap({ path: join(root,'src'), tree: true }, { path: join(root,'tests'), tree: true }), false);
});

test('mixed-case workspaces keep containment checks and platform case semantics', () => {
  const directory=mkdtempSync(join(tmpdir(),'Pi-Mixed-Case-'));
  try {
    const locks=createWriteScopeLockManager(join(directory,'locks'));
    const first=locks.tryAcquire({requestId:'case',cwd:directory,writeScope:['Folder/One.js'],timeoutSeconds:30});
    assert.ok(first);
    assert.equal(locks.tryAcquire({requestId:'same',cwd:directory,writeScope:['Folder/One.js'],timeoutSeconds:30}),null);
    assert.throws(()=>locks.tryAcquire({requestId:'escape',cwd:directory,writeScope:['../outside.js'],timeoutSeconds:30}),/outside cwd/);
    assert.throws(()=>locks.tryAcquire({requestId:'absolute',cwd:directory,writeScope:[join(directory,'outside.js')],timeoutSeconds:30}),/outside cwd/);
    const differentCase=locks.tryAcquire({requestId:'case-variant',cwd:directory,writeScope:['Folder/one.js'],timeoutSeconds:30});
    if(process.platform==='win32')assert.equal(differentCase,null);else assert.ok(differentCase);
    if(differentCase)locks.release(differentCase);
    locks.release(first);
  } finally { rmSync(directory,{recursive:true,force:true}); }
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
