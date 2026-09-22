import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

test('Windows gateway process identity rejects a different executable or script', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yhwh-process-check-'));
  const script = path.join(root, 'gateway fixture.mjs');
  fs.writeFileSync(script, 'setInterval(()=>{},1000)');
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const verifier = fileURLToPath(new URL('../../../install/Assert-GatewayProcess.ps1', import.meta.url));
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const check = (exe, file) => execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', verifier, '-TargetPid', String(child.pid), '-Executable', exe, '-GatewayScript', file], { windowsHide: true, stdio: 'pipe', timeout: 10000 });
  check(fs.realpathSync(process.execPath), fs.realpathSync(script));
  assert.throws(() => check(path.join(root, 'other.exe'), script));
  assert.throws(() => check(process.execPath, path.join(root, 'other.mjs')));
});
