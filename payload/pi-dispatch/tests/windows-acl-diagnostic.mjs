import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const platform = process.platform;
const node = process.version;
const allowedErrors = new Set(['ETIMEDOUT', 'ENOENT', 'EACCES', 'UNKNOWN']);
const allowedSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT']);
const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.resolve(here, '../scripts/preserve-auth-acl.ps1');
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const env = () => {
  const value = { ...process.env };
  delete value.PSModulePath;
  delete value.PSModuleAnalysisCachePath;
  return value;
};
const classify = error => {
  if (!error) return null;
  return allowedErrors.has(error.code) ? error.code : 'UNKNOWN';
};
const signal = value => allowedSignals.has(value) ? value : null;
const emit = (name, result, stages = []) => {
  console.log(JSON.stringify({ case: name, platform, node, stages, elapsedMs: result.elapsedMs,
    error: classify(result.error), status: Number.isInteger(result.status) ? result.status : null,
    signal: signal(result.signal) }));
};
const invoke = (args, capture) => {
  const started = Date.now();
  const result = spawnSync(ps, args, { env: env(), shell: false, windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore', timeout: 10000, maxBuffer: 64 * 1024 });
  return { ...result, elapsedMs: Date.now() - started };
};
const stagesOf = (stdout, allowed) => String(stdout || '').split(/\r?\n/)
  .filter(stage => allowed.has(stage));

if (platform !== 'win32') {
  console.log(JSON.stringify({ case: 'platform-skip', platform, node, stages: [], elapsedMs: 0,
    error: 'UNKNOWN', status: 'skipped', signal: null }));
  process.exit(0);
}

let root;
try {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-diagnostic-'));
  const scratch = path.join(root, 'scratch.ps1');
  fs.writeFileSync(scratch, `param([string]$Source,[string]$Destination)
$ErrorActionPreference='Stop'
try { [Console]::WriteLine('START'); [Console]::WriteLine('BEFORE_GET_ACL'); $acl=Get-Acl -LiteralPath $Source; [Console]::WriteLine('AFTER_GET_ACL'); Set-Acl -LiteralPath $Destination -AclObject $acl; [Console]::WriteLine('AFTER_SET_ACL') } catch { [Console]::WriteLine('ERROR'); exit 1 }
`);
  const cases = [
    ['startup-marker', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "[Console]::WriteLine('START')"], new Set(['START']), false],
    ['repository-helper-open', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], new Set(), true],
    ['scratch-helper-open', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scratch], new Set(['START', 'BEFORE_GET_ACL', 'AFTER_GET_ACL', 'AFTER_SET_ACL', 'ERROR']), true],
    ['scratch-helper-closed', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scratch], new Set(['START', 'BEFORE_GET_ACL', 'AFTER_GET_ACL', 'AFTER_SET_ACL', 'ERROR']), false]
  ];
  for (const [name, baseArgs, allowed, keepOpen] of cases) {
    const source = path.join(root, `${name}-source.txt`);
    const destination = path.join(root, `${name}-destination.txt`);
    fs.writeFileSync(source, 'synthetic source');
    let fd = fs.openSync(destination, 'wx', 0o600);
    try {
      if (!keepOpen) {
        fs.closeSync(fd);
        fd = undefined;
      }
      const args = keepOpen || name.startsWith('scratch-') || name === 'repository-helper-open'
        ? [...baseArgs, '-Source', source, '-Destination', destination]
        : baseArgs;
      const result = invoke(args, name === 'startup-marker' || name.startsWith('scratch-'));
      emit(name, result, stagesOf(result.stdout, allowed));
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
        fd = undefined;
      }
    }
  }
} catch {
  console.log(JSON.stringify({ case: 'outer-failure', platform, node, stages: [], elapsedMs: 0,
    error: 'UNKNOWN', status: null, signal: null }));
  process.exitCode = 1;
} finally {
  if (root) fs.rmSync(root, { recursive: true, force: true });
}
