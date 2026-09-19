import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cleanupWslJob, wslSandboxArgs } from '../scripts/wsl-sandbox.mjs';

test('WSL task and health launches use a native cwd without changing scoped arguments', () => {
  for(const command of ['run','--probe','--cleanup-orphans']) {
    const tail=['/usr/local/libexec/pi-kether-sandbox',command,'scoped file with spaces'];
    assert.deepEqual(wslSandboxArgs('test-distro',tail),['-d','test-distro','-u','root','--cd','/','--',...tail]);
    assert.equal(tail.length,3);
  }
});

test('WSL cleanup cannot inherit a transient Windows-drive mount as cwd', async () => {
  let invocation;
  await cleanupWslJob('test-distro','00000000-0000-0000-0000-000000000000',{
    spawnFn:(...args)=>{invocation=args;return fakeSpawn(0)();}
  });
  assert.equal(invocation[0],'wsl.exe');
  assert.deepEqual(invocation[1].slice(0,7),['-d','test-distro','-u','root','--cd','/','--']);
  assert.equal(invocation[2].shell,false);
});

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
