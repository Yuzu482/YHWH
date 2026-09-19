import {createExecutionTimeline} from '../extensions/execution-timeline.js';
import {createEditorRpc} from './editor-rpc.mjs';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { basename, parse, relative } from 'node:path/win32';

const PATCH_MARKER = '\nPI_SANDBOX_PATCH_B64=';

export function sandboxRequested(env = process.env) {
  return env.PI_DISPATCH_SANDBOX === 'wsl2-bwrap';
}

export function probeWslSandbox(env = process.env) {
  if (!sandboxRequested(env)) return { ok: false, backend: 'unavailable', reason: 'sandbox is not configured' };
  const distro = env.PI_SANDBOX_DISTRO || 'Ubuntu-24.04';
  const orphanScan = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '--', '/usr/local/libexec/pi-kether-sandbox', '--cleanup-orphans'], {
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 15000,
  });
  if (orphanScan.error || orphanScan.status !== 0) return { ok: false, backend: 'unavailable', reason: `orphan cleanup failed: ${orphanScan.error?.message || orphanScan.stderr?.trim() || `exited ${orphanScan.status}`}` };
  let orphanCleanup;
  try {
    orphanCleanup = JSON.parse(orphanScan.stdout.trim());
    if (orphanCleanup.ok !== true) throw new Error('orphan cleanup reported failure');
  } catch (error) {
    return { ok: false, backend: 'unavailable', reason: `orphan cleanup returned invalid status: ${error.message}` };
  }
  const result = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '--', '/usr/local/libexec/pi-kether-sandbox', '--probe'], {
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 15000,
  });
  if (result.error || result.status !== 0) return { ok: false, backend: 'unavailable', reason: result.error?.message || result.stderr?.trim() || `probe exited ${result.status}` };
  try {
    const value = JSON.parse(result.stdout.trim());
    return value.ok && value.resourceLimits === true ? { ...value, orphanCleanup } : { ...value, orphanCleanup, ok: false, backend: 'unavailable', reason: 'sandbox isolation or resource-limit checks failed' };
  } catch {
    return { ok: false, backend: 'unavailable', reason: 'sandbox probe returned invalid JSON' };
  }
}

export function cleanupWslJob(distro, job, { env = process.env, spawnFn = spawn, timeoutMs = 15000 } = {}) {
  return new Promise((resolveCleanup) => {
    let settled = false;
    let timer;
    let stderr = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCleanup(value);
    };
    const child = spawnFn('wsl.exe', ['-d', distro, '-u', 'root', '--', '/usr/local/libexec/pi-kether-sandbox', '--cleanup', job], {
      env, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.setEncoding('utf8').on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.on('error', error => finish({ ok: false, exitCode: null, error: error.message, stderr: stderr.trim() }));
    child.on('close', code => finish({ ok: code === 0, exitCode: code, error: code === 0 ? undefined : `cleanup exited ${code}`, stderr: stderr.trim() }));
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, exitCode: null, error: 'cleanup timeout', stderr: stderr.trim() });
    }, timeoutMs);
    timer.unref?.();
  });
}

function workspaceLocation(cwd) {
  const root = parse(cwd).root;
  const drive = root.slice(0, 1).toUpperCase();
  if (!/^[A-Z]$/.test(drive)) throw new Error('WSL sandbox requires a local drive workspace');
  const rel = relative(root, cwd).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || rel.includes('/../')) throw new Error('Invalid sandbox workspace path');
  return { drive, rel };
}

function stripPatch(stdout) {
  const index = stdout.lastIndexOf(PATCH_MARKER);
  if (index < 0) return { stdout, patch: undefined };
  const encoded = stdout.slice(index + PATCH_MARKER.length).trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Sandbox returned an invalid patch payload');
  return { stdout: stdout.slice(0, index), patch: Buffer.from(encoded, 'base64').toString('utf8') };
}

export function runWslSandbox(args, { cwd, access, input = '', resourceLimits, writeScope = [], readScope = [], gatewayInstanceId = randomUUID(), gatewayWindowsPid = process.pid, env = process.env, signal, onProgress, editorBroker, apiPacket } = {}) {
  return new Promise((done) => {
    if (!resourceLimits?.profile || !Number.isInteger(resourceLimits.timeoutSeconds) || !Number.isInteger(resourceLimits.outputBytes)) {
      done({ exitCode: null, failure: 'invalid-resource-limits', stdout: '', stderr: '', sandbox: 'wsl2-bwrap' });
      return;
    }
    const distro = env.PI_SANDBOX_DISTRO || 'Ubuntu-24.04';
    const job = randomUUID();
    const { drive, rel } = workspaceLocation(cwd);
    const hostUser = basename(env.USERPROFILE || '');
    if (!/^[A-Za-z0-9._-]+$/.test(hostUser)) throw new Error('Unable to determine a safe Windows user name');
    if (!/^[a-f0-9-]{36}$/.test(gatewayInstanceId)) throw new Error('Invalid gateway instance id');
    if (!Number.isInteger(gatewayWindowsPid) || gatewayWindowsPid < 1) throw new Error('Invalid gateway Windows pid');
    const scopeManifest = Buffer.from(JSON.stringify({ read: readScope, write: writeScope }), 'utf8').toString('base64');
    const commandArgs = ['-d', distro, '-u', 'root', '--', '/usr/local/libexec/pi-kether-sandbox', 'run', job, drive, rel, access, resourceLimits.profile, String(resourceLimits.timeoutSeconds), hostUser, scopeManifest, gatewayInstanceId, String(gatewayWindowsPid), ...(apiPacket?['--api-pipe']:[]), ...(editorBroker?['--editor-bridge']:[]), ...args];
    const timeline=createExecutionTimeline({onProgress});
    let stdout = '', stderr = '', bytes = 0, failure = null, settled = false, killing = false;
    const child = spawn('wsl.exe', commandArgs, { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = (reason) => {
      if (killing || settled) return;
      killing = true;
      failure = reason;
      if (child.pid) {
        const killer = spawn(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      }
    };
    const timer = setTimeout(() => stop('timeout'), (resourceLimits.timeoutSeconds + 15) * 1000);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const finish = async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      timeline.close();
      await editorRpc?.close();
      const cleanupStarted=Date.now();
      const cleanup = await cleanupWslJob(distro, job, { env });
      timeline.cleaned(Date.now()-cleanupStarted);
      if (!cleanup.ok) {
        failure ||= `sandbox-cleanup-failed:${cleanup.error || 'unknown'}`;
        if (cleanup.stderr) stderr += `${stderr ? '\n' : ''}[cleanup] ${cleanup.stderr}`;
      }
      try {
        const separated = stripPatch(stdout);
        done({ exitCode: code, failure, stdout: separated.stdout, stderr, patch: separated.patch, sandbox: 'wsl2-bwrap', cleanup,phaseTimings:timeline.snapshot() });
      } catch (error) {
        done({ exitCode: code, failure: error.message, stdout: '', stderr, sandbox: 'wsl2-bwrap', cleanup,phaseTimings:timeline.snapshot() });
      }
    };
    const collect = (stream) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > resourceLimits.outputBytes) { stop('output-limit'); return; }
      if (stream === 'stdout') {if(editorRpc)editorRpc.feed(chunk);else {stdout += chunk;timeline.feed(chunk);}} else stderr += chunk;
    };
    const editorRpc=editorBroker?createEditorRpc({broker:editorBroker,maxBytes:resourceLimits.outputBytes,send:line=>{if(!settled&&!killing)child.stdin.write(line);},onOutput:chunk=>{stdout+=chunk;timeline.feed(chunk);},onFailure:stop}):null;
    child.stdout.setEncoding('utf8').on('data', collect('stdout'));
    child.stderr.setEncoding('utf8').on('data', collect('stderr'));
    child.on('error', (error) => { failure = error.message; finish(null); });
    child.on('close', finish);
    child.stdin.on('error', () => {});
    if(apiPacket)child.stdin.write('YHWH_API_CREDENTIAL_V1\n'+JSON.stringify(apiPacket)+'\n');
    if(editorBroker)child.stdin.write(JSON.stringify({prompt:input})+'\n');else child.stdin.end(input);
  });
}
