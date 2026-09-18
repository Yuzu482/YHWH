import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cleanupWslJob } from '../scripts/wsl-sandbox.mjs';

function fakeSpawn(exitCode, stderr = '') {
  return () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => child.stderr;
    child.kill = () => {};
    setImmediate(() => {
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    });
    return child;
  };
}

test('WSL cleanup waits for and exposes successful confirmation', async () => {
  const result = await cleanupWslJob('test-distro', '00000000-0000-0000-0000-000000000000', { spawnFn: fakeSpawn(0) });
  assert.deepEqual(result, { ok: true, exitCode: 0, error: undefined, stderr: '' });
});

test('WSL cleanup exposes failures and bounded stderr', async () => {
  const result = await cleanupWslJob('test-distro', '00000000-0000-0000-0000-000000000000', { spawnFn: fakeSpawn(9, 'cgroup remains') });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 9);
  assert.equal(result.error, 'cleanup exited 9');
  assert.equal(result.stderr, 'cgroup remains');
});
