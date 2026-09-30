import {createExecutionTimeline} from '../extensions/execution-timeline.js';
import {createEditorRpc} from './editor-rpc.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { validateUnifiedPatch, compileWriteScope } from '../extensions/write-scope-guard.js';
import { spawn, spawnSync } from 'node:child_process';
import { basename, parse, relative } from 'node:path/win32';

const PATCH_MARKER = '\nPI_SANDBOX_PATCH_B64=';
const PATCH_META_MARKER = '\nPI_SANDBOX_PATCH_META=';
const PATCH_FAILURES = new Set(['PI_PATCH_CONTAINS_ISSUED_CREDENTIAL', 'PI_PATCH_TOKEN_INVALID', 'PI_PATCH_INVALID_BYTES']);

// WSL otherwise translates the gateway's Windows cwd into any currently mounted
// drive, including another job's temporary host-work mount, preventing unmount.
export function wslSandboxArgs(distro, args) {
  return ['-d', distro, '-u', 'root', '--cd', '/', '--', ...args];
}

export function sandboxRequested(env = process.env) {
  return env.PI_DISPATCH_SANDBOX === 'wsl2-bwrap';
}

export function probeWslSandbox(env = process.env) {
  if (!sandboxRequested(env)) return { ok: false, backend: 'unavailable', reason: 'sandbox is not configured' };
  const distro = env.PI_SANDBOX_DISTRO || 'Ubuntu-24.04';
  const orphanScan = spawnSync('wsl.exe', wslSandboxArgs(distro, ['/usr/local/libexec/pi-kether-sandbox', '--cleanup-orphans']), {
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
  const result = spawnSync('wsl.exe', wslSandboxArgs(distro, ['/usr/local/libexec/pi-kether-sandbox', '--probe']), {
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
    const child = spawnFn('wsl.exe', wslSandboxArgs(distro, ['/usr/local/libexec/pi-kether-sandbox', '--cleanup', job]), {
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

export function validateSandboxPatch(patch, { job, requestId, writeScope = [], access } = {}) {
  if (!patch || access !== 'workspace-write' || !requestId) return { patchValidation: undefined, failure: undefined };
  try {
    const baselinePrefix = `/var/lib/pi-kether/jobs/${job}/baseline`;
    const workspacePrefix = `/var/lib/pi-kether/jobs/${job}/workspace`;
    const changedFiles = validateUnifiedPatch(patch, writeScope, baselinePrefix, workspacePrefix).sort();
    const canonicalScope = compileWriteScope(writeScope).map(item => `${item.tree ? 'tree' : 'file'}:${item.path}`).sort().join('\\n');
    return { patchValidation: { ok: true, requestId, jobId: job, changedFiles, patchSha256: createHash('sha256').update(patch, 'utf8').digest('hex'), scopeSha256: createHash('sha256').update(canonicalScope, 'utf8').digest('hex') }, failure: undefined };
  } catch { return { patchValidation: { ok: false, requestId, jobId: job }, failure: 'sandbox-patch-validation-failed' }; }
}

export function stripPatch(stdout, stderr = '') {
  const terminal = stderr.endsWith('\n') ? stderr.slice(0, -1).split('\n').at(-1) : stderr.split('\n').at(-1);
  if (PATCH_FAILURES.has(terminal)) return { stdout: '', stderr: '', failure: terminal };
  const index = stdout.lastIndexOf(PATCH_MARKER);
  if (index < 0) return { stdout, patch: undefined, stderr };
  const tail = stdout.slice(index + PATCH_MARKER.length);
  const metaIndex = tail.indexOf(PATCH_META_MARKER.slice(1));
  if (metaIndex < 0) throw new Error('Sandbox returned an invalid patch payload');
  const encodedRaw = tail.slice(0, metaIndex).replace(/[\r\n]/g, '');
  if (encodedRaw.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedRaw)) throw new Error('Sandbox returned an invalid patch payload');
  const bytes = Buffer.from(encodedRaw, 'base64');
  if (bytes.toString('base64') !== encodedRaw) throw new Error('Sandbox returned an invalid patch payload');
  const metaText = tail.slice(metaIndex + PATCH_META_MARKER.length - 1).trim();
  let meta;
  try { meta = JSON.parse(metaText); } catch { throw new Error('Sandbox returned invalid patch metadata'); }
  if (meta?.ok !== true || meta.patchPolicy !== 'issued-credential-v1' || typeof meta.secretLikeContent !== 'boolean' || !Number.isSafeInteger(meta.patchBytes) || meta.patchBytes !== bytes.length || !/^[a-f0-9]{64}$/.test(meta.patchSha256 ?? '') || createHash('sha256').update(bytes).digest('hex') !== meta.patchSha256) throw new Error('Sandbox returned invalid patch metadata');
  const patch = bytes.toString('utf8');
  if (!Buffer.from(patch, 'utf8').equals(bytes)) throw new Error('Sandbox returned invalid patch bytes');
  return { stdout: stdout.slice(0, index), stderr, patch, patchPolicy: meta.patchPolicy, secretLikeContent: meta.secretLikeContent, patchSha256: meta.patchSha256, patchBytes: meta.patchBytes };
}

export function runWslSandbox(args, { cwd, access, input = '', resourceLimits, writeScope = [], readScope = [], gatewayInstanceId = randomUUID(), gatewayWindowsPid = process.pid, gatewayRequestId, env = process.env, signal, onProgress, editorBroker, apiPacket } = {}) {
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
    const commandArgs = wslSandboxArgs(distro, ['/usr/local/libexec/pi-kether-sandbox', 'run', job, drive, rel, access, resourceLimits.profile, String(resourceLimits.timeoutSeconds), hostUser, scopeManifest, gatewayInstanceId, String(gatewayWindowsPid), ...(apiPacket?['--api-pipe']:[]), ...(editorBroker?['--editor-bridge']:[]), ...args]);
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
      const patchFailure = (() => {
        const terminal = stderr.endsWith('\n') ? stderr.slice(0, -1).split('\n').at(-1) : stderr.split('\n').at(-1);
        return PATCH_FAILURES.has(terminal) ? terminal : null;
      })();
      const cleanupStarted=Date.now();
      const cleanup = await cleanupWslJob(distro, job, { env });
      timeline.cleaned(Date.now()-cleanupStarted);
      if (!cleanup.ok) {
        failure ||= `sandbox-cleanup-failed:${cleanup.error || 'unknown'}`;

      }
      if (patchFailure) {
        done({ exitCode: code, failure: patchFailure, failureCode: patchFailure, stdout: '', stderr: '', sandbox: 'wsl2-bwrap', cleanup: {ok:cleanup.ok,exitCode:cleanup.exitCode}, phaseTimings: timeline.snapshot() });
        return;
      }
      try {
        const separated = stripPatch(stdout, stderr);
        const proof = validateSandboxPatch(separated.patch, { job, requestId: gatewayRequestId, writeScope, access });
        const patchValidation = proof.patchValidation;
        if (proof.failure) failure ||= proof.failure;
        done({ exitCode: code, failure, stdout: separated.stdout, stderr: separated.stderr, patch: separated.patch, ...(separated.patchPolicy ? { patchPolicy: separated.patchPolicy, secretLikeContent: separated.secretLikeContent, patchSha256: separated.patchSha256, patchBytes: separated.patchBytes } : {}), patchValidation, sandbox: 'wsl2-bwrap', cleanup: {ok:cleanup.ok,exitCode:cleanup.exitCode,stderr:cleanup.stderr},phaseTimings:timeline.snapshot() });
      } catch {
        done({ exitCode: code, failure: 'PI_PATCH_INVALID_BYTES', failureCode: 'PI_PATCH_INVALID_BYTES', stdout: '', stderr: '', sandbox: 'wsl2-bwrap', cleanup: {ok:cleanup.ok,exitCode:cleanup.exitCode},phaseTimings:timeline.snapshot() });
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
