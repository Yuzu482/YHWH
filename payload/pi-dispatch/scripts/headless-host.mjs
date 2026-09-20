import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { adapters, invocation, parseResult } from './headless-adapters.mjs';

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['scripts/headless-host.mjs', 'scripts/headless-adapters.mjs', 'workflow/headless.example.json', 'workflow/catalog.json'];
const fail = code => { throw new Error(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('invalid_configuration');
};
const bounded = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const token = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value);

export function validateConfig(config) {
  keys(config, ['schemaVersion', 'workspaceRoots', 'timeoutSeconds', 'maxOutputBytes', 'clients']);
  if (config.schemaVersion !== 1 || !Array.isArray(config.workspaceRoots) || !config.workspaceRoots.length ||
      config.workspaceRoots.some(p => typeof p !== 'string' || !path.isAbsolute(p)) ||
      !bounded(config.timeoutSeconds, 1, 1800) || !bounded(config.maxOutputBytes, 1024, 8 * 1024 * 1024)) fail('invalid_configuration');
  keys(config.clients, Object.keys(adapters));
  for (const [id, c] of Object.entries(config.clients)) {
    keys(c, ['enabled', 'executable', 'nodeScript', 'expectedVersion', 'model', 'effort', 'policy', 'acceptNativePermissions']);
    if (typeof c.enabled !== 'boolean') fail('invalid_configuration');
    if (!c.enabled) continue;
    if (typeof c.executable !== 'string' || !path.isAbsolute(c.executable) || /\.(?:cmd|bat|ps1)$/i.test(c.executable) ||
        (c.nodeScript !== undefined && (typeof c.nodeScript !== 'string' || !path.isAbsolute(c.nodeScript) || !/\.[cm]?js$/i.test(c.nodeScript))) ||
        typeof c.expectedVersion !== 'string' || !c.expectedVersion.trim() || c.expectedVersion.length > 200 || /[\r\n]/.test(c.expectedVersion) ||
        !token(c.model) || !adapters[id].policies.includes(c.policy) ||
        (c.effort !== undefined && !(id === 'antigravity' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max']).includes(c.effort))) fail('invalid_configuration');
    if (c.policy === 'native' && c.acceptNativePermissions !== true) fail('native_permissions_not_acknowledged');
  }
  return config;
}

export function resolveWorkspace(config, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) fail('invalid_workspace');
  const real = fs.realpathSync(cwd);
  if (!fs.statSync(real).isDirectory()) fail('invalid_workspace');
  const inside = config.workspaceRoots.some(root => {
    const rel = path.relative(fs.realpathSync(root), real);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  });
  if (!inside) fail('workspace_not_allowed');
  return real;
}

// No shell, prompt argv, raw child logs, or arbitrary caller-supplied flags.
export function runProcess(executable, args, { cwd, input = '', timeoutMs, maxOutputBytes, signal } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ failure: 'cancelled', exitCode: null, stdout: '', stderr: '' });
    let bytes = 0, failure = null, stdout = [], stderr = [], settled = false, killTimer;
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = code => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve({ failure, exitCode: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const stop = reason => {
      if (failure || settled) return;
      failure = reason;
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          killer.on('error', () => { failure = 'cleanup_unverified'; child.kill(); });
          killer.on('exit', code => { if (code !== 0 && !settled) { failure = 'cleanup_unverified'; child.kill(); } });
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }
      killTimer = setTimeout(() => {
        failure = 'cleanup_unverified'; child.kill();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null);
      }, 3000);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { failure = 'spawn_failed'; finish(null); });
    child.on('close', finish);
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop('output_limit');
      else output.push(chunk);
    });
    child.stdin.on('error', () => {}); // Early CLI exit may close stdin before the prompt drains.
    child.stdin.end(input);
  });
}

export function fingerprint(root = ownRoot) {
  const digests = Object.fromEntries(files.map(name => [name, hash(fs.readFileSync(path.join(root, name)))]));
  return { sha256: hash(JSON.stringify(digests)), files: digests };
}

function launch(c, args, options) {
  return runProcess(c.executable, [...(c.nodeScript ? [c.nodeScript] : []), ...args], options);
}

export async function doctor(config, { signal } = {}) {
  validateConfig(config);
  const clients = {};
  for (const id of Object.keys(adapters)) {
    const c = config.clients[id];
    if (!c?.enabled) { clients[id] = { status: 'disabled', authenticated: 'unverified' }; continue; }
    const options = { cwd: ownRoot, timeoutMs: 10000, maxOutputBytes: 256 * 1024, signal };
    if (![c.executable, ...(c.nodeScript ? [c.nodeScript] : [])].every(p => fs.existsSync(p) && fs.statSync(p).isFile())) {
      clients[id] = { status: 'missing', authenticated: 'unverified' }; continue;
    }
    const v = await launch(c, adapters[id].versionArgs, options);
    const observedVersion = v.stdout.trim();
    if (v.failure || v.exitCode !== 0 || observedVersion !== c.expectedVersion) {
      clients[id] = { status: v.failure || (v.exitCode !== 0 ? 'version_probe_failed' : 'version_mismatch'), authenticated: 'unverified' }; continue;
    }
    const h = await launch(c, adapters[id].helpArgs, options);
    const missingFlags = adapters[id].requiredFlags.filter(flag => !h.stdout.includes(flag));
    clients[id] = { status: h.failure || (h.exitCode !== 0 ? 'help_probe_failed' : missingFlags.length ? 'unsupported_cli' : 'ready'),
      version: c.expectedVersion, missingFlags, authenticated: 'unverified', modelAccess: 'unverified',
      executableSha256: hash(fs.readFileSync(c.executable)), ...(c.nodeScript ? { scriptSha256: hash(fs.readFileSync(c.nodeScript)) } : {}) };
  }
  return { schemaVersion: 1, feature: 'primary-headless-cli', modelCalls: 0, adapter: fingerprint(), clients };
}

export async function runHeadless(config, request, { signal } = {}) {
  validateConfig(config);
  keys(request, ['client', 'cwd', 'prompt']);
  const c = config.clients[request.client];
  if (!Object.hasOwn(adapters, request.client) || !c?.enabled) fail('client_disabled');
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 200000) fail('invalid_prompt');
  const cwd = resolveWorkspace(config, request.cwd);
  // Probe only the requested client; unrelated installations cannot block it.
  const check = await doctor({ ...config, clients: { [request.client]: c } }, { signal });
  if (check.clients[request.client].status !== 'ready') return { status: 'blocked', reason: check.clients[request.client].status, modelCalls: 0 };
  const catalog = JSON.parse(fs.readFileSync(path.join(ownRoot, 'workflow/catalog.json'), 'utf8'));
  if (typeof catalog.topics?.primary !== 'string' || !catalog.topics.primary.trim()) fail('workflow_contract_missing');
  const prompt = `YHWH primary workflow contract (subordinate to host policies and user authorization):\n${catalog.topics.primary}\n\nUser task:\n${request.prompt}`;
  const call = invocation(request.client, c, prompt);
  const started = Date.now();
  const result = await launch(c, call.args, { cwd, input: call.input, timeoutMs: config.timeoutSeconds * 1000, maxOutputBytes: config.maxOutputBytes, signal });
  const evidence = { client: request.client, requestedModel: c.model, requestedEffort: c.effort ?? null, policy: c.policy,
    version: c.expectedVersion, adapterSha256: check.adapter.sha256,
    profileSha256: hash(JSON.stringify({ client: request.client, version: c.expectedVersion, model: c.model, effort: c.effort ?? null, policy: c.policy, timeoutSeconds: config.timeoutSeconds, maxOutputBytes: config.maxOutputBytes })),
    durationMs: Date.now() - started, exitCode: result.exitCode,
    modelCalls: 'unverified', acceptance: 'requires-primary-review', nativeConfiguration: 'host-owned-not-fingerprinted' };
  if (result.failure || result.exitCode !== 0) return { status: 'failed', reason: result.failure || 'cli_exit_nonzero', evidence };
  try {
    const parsed = parseResult(request.client, result.stdout);
    // Native CLIs may soft-deny tools but still produce a successful answer.
    const denied = /(?:soft.denied|permission denied|not allowed|requires? approval|permission_denials)/i.test(result.stderr) ||
      (request.client === 'claude' && (JSON.parse(result.stdout).permission_denials?.length > 0));
    return { status: denied ? 'unverified' : 'completed', ...(denied ? { reason: 'tool_permission_denied' } : {}), ...parsed, evidence };
  } catch { return { status: 'failed', reason: 'invalid_cli_result', evidence }; }
}

async function main() {
  const [action, configFile, other] = process.argv.slice(2);
  if (action === 'fingerprint') {
    const expected = fingerprint(); const actual = configFile ? fingerprint(path.resolve(configFile)) : expected;
    const equal = expected.sha256 === actual.sha256;
    console.log(JSON.stringify({ status: equal ? 'matched' : 'drift', expected, actual }, null, 2));
    if (!equal) process.exitCode = 1;
    return;
  }
  if (!['doctor', 'run'].includes(action) || !configFile) fail('usage: headless-host.mjs doctor|run <config.local.json> [request.json]; fingerprint [installed-plugin-root]');
  const config = validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    let result;
    if (action === 'doctor') result = await doctor(config, { signal: controller.signal });
    else {
      if (!other) fail('request_file_required');
      if (fs.statSync(other).size > 220000) fail('request_too_large');
      result = await runHeadless(config, JSON.parse(fs.readFileSync(other, 'utf8').replace(/^\uFEFF/, '')), { signal: controller.signal });
    }
    console.log(JSON.stringify(result, null, 2));
    if (action === 'run' ? result.status !== 'completed' : Object.values(result.clients).some(c => !['disabled', 'ready'].includes(c.status))) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  // Do not echo native CLI stderr, configuration paths or credentials in failures.
  console.log(JSON.stringify({ status: 'failed', reason: /^[a-z_]+$/.test(e.message) ? e.message : 'headless_configuration_or_io_error' }));
  process.exitCode = 1;
});
