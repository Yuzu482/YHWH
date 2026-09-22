import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { adapters, invocation, parseResult } from './headless-adapters.mjs';

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['scripts/headless-host.mjs', 'scripts/headless-adapters.mjs', 'scripts/headless-job.ps1', 'scripts/headless-acceptance.mjs', 'workflow/headless.example.json', 'workflow/catalog.json'];
const fail = code => { throw new Error(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('invalid_configuration');
};
const bounded = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const token = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value);

export function validateConfig(config) {
  keys(config, ['schemaVersion', 'workspaceRoots', 'timeoutSeconds', 'maxOutputBytes', 'clients', 'processTreeMode']);
  if (config.processTreeMode !== undefined && !['native', 'job-object'].includes(config.processTreeMode)) fail('invalid_process_tree_mode');
  if (config.processTreeMode === 'job-object' && process.platform !== 'win32') fail('job_object_requires_windows');
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
export function runProcess(executable, args, { cwd, input = '', timeoutMs, maxOutputBytes, signal, onStdout, onStarted, processTreeMode = 'native' } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ failure: 'cancelled', exitCode: null, stdout: '', stderr: '' });
    let bytes = 0, failure = null, stdout = [], stderr = [], settled = false, killTimer;
    if (processTreeMode === 'job-object') {
      if (process.platform !== 'win32') return resolve({ failure: 'job_object_requires_windows', exitCode: null, stdout: '', stderr: '' });
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ownRoot, 'scripts/headless-job.ps1'), '-Executable', executable,
        '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64'), '-WorkingDirectory', cwd, '-ParentPid', String(process.pid)];
      executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    }
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
          if (processTreeMode === 'job-object') {
            // The launcher alone owns the non-inheritable KILL_ON_JOB_CLOSE handle.
            // Closing it avoids racing taskkill's enumeration of native CLI children.
            if (!child.kill()) failure = 'cleanup_unverified';
          } else {
            const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
            killer.on('error', () => { failure = 'cleanup_unverified'; child.kill(); });
            killer.on('exit', code => { if (code !== 0 && !settled) { failure = 'cleanup_unverified'; child.kill(); } });
          }
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
    child.once('spawn', () => { try { onStarted?.(); } catch { stop('start_handler_failed'); } });
    child.on('close', finish);
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop('output_limit');
      else { output.push(chunk); if (stream === child.stdout && onStdout) { try { onStdout(chunk); } catch { stop('progress_handler_failed'); } } }
    });
    child.stdin.on('error', () => {}); // Early CLI exit may close stdin before the prompt drains.
    child.stdin.end(input);
  });
}

function fileIdentity(file) {
  const real = fs.realpathSync(file), s = fs.statSync(real, { bigint: true });
  if (!s.isFile()) fail('invalid_probe_file');
  return JSON.stringify([real, ...[s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String)]);
}

// Session-local optimization, not protection against a hostile filesystem owner.
// Recheck identity on every access; expire even unchanged entries after one minute.
function fileDigest(file, cache, metrics) {
  const identity = fileIdentity(file), cached = cache?.get(identity);
  if (cached && Date.now() - cached.at < 60000) {
    if (metrics) metrics.hits++;
    return cached.digest;
  }
  const bytes = fs.readFileSync(file), digest = hash(bytes);
  if (fileIdentity(file) !== identity) fail('file_changed_during_probe');
  if (metrics) { metrics.misses++; metrics.bytesRead += bytes.length; }
  if (cache) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(identity, { at: Date.now(), digest });
  }
  return digest;
}

export function fingerprint(root = ownRoot, cache, metrics) {
  const digests = Object.fromEntries(files.map(name => [name, fileDigest(path.join(root, name), cache, metrics)]));
  return { sha256: hash(JSON.stringify(digests)), files: digests };
}

function launch(c, args, options) {
  return runProcess(c.executable, [...(c.nodeScript ? [c.nodeScript] : []), ...args], options);
}

export async function doctor(config, { signal, helpCache, digestCache, onPhase } = {}) {
  validateConfig(config);
  const clients = {}, digestMetrics = { hits: 0, misses: 0, bytesRead: 0 };
  for (const id of Object.keys(adapters)) {
    const c = config.clients[id];
    if (!c?.enabled) { clients[id] = { status: 'disabled', authenticated: 'unverified' }; continue; }
    const options = { cwd: ownRoot, timeoutMs: 10000, maxOutputBytes: 256 * 1024, signal };
    if (![c.executable, ...(c.nodeScript ? [c.nodeScript] : [])].every(p => fs.existsSync(p) && fs.statSync(p).isFile())) {
      clients[id] = { status: 'missing', authenticated: 'unverified' }; continue;
    }
    onPhase?.('version');
    const identity = JSON.stringify([id, c.expectedVersion, ...[c.executable, ...(c.nodeScript ? [c.nodeScript] : [])].map(fileIdentity)]);
    const v = await launch(c, adapters[id].versionArgs, options);
    const observedVersion = v.stdout.trim();
    if (v.failure || v.exitCode !== 0 || observedVersion !== c.expectedVersion) {
      clients[id] = { status: v.failure || (v.exitCode !== 0 ? 'version_probe_failed' : 'version_mismatch'), authenticated: 'unverified' }; continue;
    }
    onPhase?.('help');
    const cached = helpCache?.get(identity);
    const helpCacheHit = !!cached && Date.now() - cached.at < 60000;
    const h = helpCacheHit ? cached.result : await launch(c, adapters[id].helpArgs, options);
    if (!helpCacheHit && !h.failure && h.exitCode === 0 && helpCache) {
      if (helpCache.size >= 16) helpCache.delete(helpCache.keys().next().value);
      helpCache.set(identity, { at: Date.now(), result: h });
    }
    const missingFlags = adapters[id].requiredFlags.filter(flag => !h.stdout.includes(flag));
    if (identity !== JSON.stringify([id, c.expectedVersion, ...[c.executable, ...(c.nodeScript ? [c.nodeScript] : [])].map(fileIdentity)])) fail('file_changed_during_probe');
    clients[id] = { status: h.failure || (h.exitCode !== 0 ? 'help_probe_failed' : missingFlags.length ? 'unsupported_cli' : 'ready'),
      version: c.expectedVersion, missingFlags, helpCacheHit, authenticated: 'unverified', modelAccess: 'unverified',
      executableSha256: fileDigest(c.executable, digestCache, digestMetrics), ...(c.nodeScript ? { scriptSha256: fileDigest(c.nodeScript, digestCache, digestMetrics) } : {}) };
  }
  onPhase?.('fingerprint');
  const adapter = fingerprint(ownRoot, digestCache, digestMetrics);
  return { schemaVersion: 1, feature: 'primary-headless-cli', modelCalls: 0, adapter, clients, digestCache: digestMetrics };
}

function validateRequest(config, request) {
  validateConfig(config);
  keys(request, ['client', 'cwd', 'prompt']);
  const c = config.clients[request.client];
  if (!Object.hasOwn(adapters, request.client) || !c?.enabled) fail('client_disabled');
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 200000) fail('invalid_prompt');
  return resolveWorkspace(config, request.cwd);
}

export async function runHeadless(config, request, options = {}) {
  const totalStarted = Date.now(), progressController = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, progressController.signal]) : progressController.signal;
  let phase = 'preflight', progressFailed = false;
  const emit = event => {
    if (!options.onProgress || progressFailed) return;
    if (event.type === 'phase') phase = event.phase;
    try { options.onProgress({ ...event, elapsedMs: Date.now() - totalStarted }); }
    catch { progressFailed = true; progressController.abort(); }
  };
  const timer = options.onProgress ? setInterval(() => emit({ type: 'waiting', phase }), 1000) : null;
  try {
    emit({ type: 'phase', phase });
    const result = await executeHeadless(config, request, { ...options, signal, onProgress: emit, totalStarted });
    return progressFailed ? { ...result, status: 'failed', reason: 'progress_handler_failed' } : result;
  } finally { clearInterval(timer); }
}

async function executeHeadless(config, request, { signal, helpCache, digestCache, onProgress, onStarted, heartbeat = false, totalStarted }) {
  const cwd = validateRequest(config, request), c = config.clients[request.client];
  if (signal.aborted) return { status: 'blocked', reason: 'cancelled', modelCalls: 0 };
  // Probe only the requested client; unrelated installations cannot block it.
  const check = await doctor({ ...config, clients: { [request.client]: c } }, { signal, helpCache, digestCache, onPhase: phase => onProgress({ type: 'phase', phase }) });
  if (signal.aborted || check.clients[request.client].status !== 'ready') return { status: 'blocked', reason: signal.aborted ? 'cancelled' : check.clients[request.client].status, modelCalls: 0,
    evidence: { totalMs: Date.now() - totalStarted, preflightMs: Date.now() - totalStarted, durationMs: 0, digestCache: check.digestCache } };
  onProgress({ type: 'cache', helpCacheHit: check.clients[request.client].helpCacheHit, digestCache: check.digestCache });
  const catalog = JSON.parse(fs.readFileSync(path.join(ownRoot, 'workflow/catalog.json'), 'utf8'));
  if (typeof catalog.topics?.primary !== 'string' || !catalog.topics.primary.trim()) fail('workflow_contract_missing');
  const prompt = heartbeat ? request.prompt : `YHWH primary workflow contract (subordinate to host policies and user authorization):\n${catalog.topics.primary}\n\nUser task:\n${request.prompt}`;
  const call = invocation(request.client, c, prompt);
  const started = Date.now();
  let pending = '', firstOutputMs = null, firstResponseMs = null, eventCount = 0;
  const decoder = new TextDecoder();
  const recordLine = line => {
    let e; try { e = JSON.parse(line); } catch { return; }
    if (!e || typeof e !== 'object') return;
    eventCount++;
    const response = e.item?.type === 'agent_message' || e.step_update?.step_type === 'agent_response' || e.type === 'result' || e.event === 'result';
    if (response) firstResponseMs ??= Date.now() - started;
    onProgress({ type: response ? 'response' : 'activity', eventCount });
  };
  const result = await launch(c, call.args, { cwd, input: call.input, timeoutMs: config.timeoutSeconds * 1000, maxOutputBytes: config.maxOutputBytes, signal,
    onStarted: () => { onProgress({ type: 'phase', phase: 'running' }); onStarted?.(); }, processTreeMode: config.processTreeMode ?? 'native',
    onStdout: chunk => {
      if (firstOutputMs === null) onProgress({ type: 'first-output' });
      firstOutputMs ??= Date.now() - started;
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        // Never expose tool arguments, stderr, account information or partial prompts.
        recordLine(line);
      }
    } });
  pending += decoder.decode();
  if (pending.trim()) recordLine(pending);
  const evidence = { client: request.client, requestedModel: c.model, requestedEffort: c.effort ?? null, policy: c.policy,
    version: c.expectedVersion, adapterSha256: check.adapter.sha256,
    profileSha256: hash(JSON.stringify({ client: request.client, version: c.expectedVersion, model: c.model, effort: c.effort ?? null, policy: c.policy, processTreeMode: config.processTreeMode ?? 'native', timeoutSeconds: config.timeoutSeconds, maxOutputBytes: config.maxOutputBytes })),
    processTreeMode: config.processTreeMode ?? 'native', durationMs: Date.now() - started, totalMs: Date.now() - totalStarted, preflightMs: started - totalStarted,
    firstOutputMs, firstResponseMs, eventCount, helpCacheHit: check.clients[request.client].helpCacheHit, digestCache: check.digestCache, exitCode: result.exitCode,
    modelCalls: 'unverified', acceptance: 'requires-primary-review', nativeConfiguration: 'host-owned-not-fingerprinted' };
  if (result.failure || result.exitCode !== 0) return { status: 'failed', reason: result.failure || classifyFailure(result.stderr), evidence };
  try {
    const parsed = parseResult(request.client, result.stdout);
    // Native CLIs may soft-deny tools but still produce a successful answer.
    const denied = /(?:soft.denied|permission denied|not allowed|requires? approval|permission_denials)/i.test(result.stderr) ||
      (request.client === 'claude' && (JSON.parse(result.stdout).permission_denials?.length > 0));
    return { status: denied ? 'unverified' : 'completed', ...(denied ? { reason: 'tool_permission_denied' } : {}), ...parsed, evidence };
  } catch { return { status: 'failed', reason: 'invalid_cli_result', evidence }; }
}

export function classifyFailure(stderr) {
  if (/authentication required|not logged in|unauthorized|invalid.api.key|login required|token.expired/i.test(stderr)) return 'authentication_required';
  if (/rate.limit|too many requests|quota|usage.limit/i.test(stderr)) return 'rate_limited';
  if (/model.*(?:unavailable|not found|not recognized|not supported)/i.test(stderr)) return 'model_unavailable';
  if (/permission denied|not allowed|requires? approval/i.test(stderr)) return 'permission_denied';
  if (/ECONN|ENOTFOUND|network|fetch failed/i.test(stderr)) return 'network_error';
  return 'cli_exit_nonzero';
}

// Reuse only preflight data, never model conversation, credentials or processes.
// Freeze admitted inputs, serialize calls, and fail closed after a failed call.
export function createHeadlessSession() {
  const helpCache = new Map(), digestCache = new Map();
  let tail = Promise.resolve(), pending = 0, stopped = false;
  return {
    async run(config, request, options = {}) {
      const admittedConfig = structuredClone(config), admittedRequest = structuredClone(request);
      validateRequest(admittedConfig, admittedRequest);
      if (pending >= 20) fail('session_queue_full');
      const queuedAt = Date.now(); pending++;
      const next = tail.then(async () => {
        const queueMs = Date.now() - queuedAt;
        if (stopped || options.signal?.aborted) {
          const reason = stopped ? 'previous_call_failed' : 'cancelled'; stopped = true;
          return { status: 'blocked', reason, modelCalls: 0, evidence: { queueMs } };
        }
        try {
          const result = await runHeadless(admittedConfig, admittedRequest, { ...options, helpCache, digestCache });
          if (result.status !== 'completed') stopped = true;
          return { ...result, evidence: { ...result.evidence, queueMs } };
        } catch (e) { stopped = true; throw e; }
      });
      tail = next.catch(() => {}).finally(() => { pending--; });
      return next;
    },
    clear: () => { helpCache.clear(); digestCache.clear(); }
  };
}

const safeReason = e => /^[a-z_]+$/.test(e.message) ? e.message : 'headless_configuration_or_io_error';

export async function runHeadlessBatch(config, requests, { signal, onEvent } = {}) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20) fail('invalid_batch');
  config = structuredClone(config); requests = structuredClone(requests);
  // A malformed later request must not be discovered after earlier model calls.
  for (const request of requests) validateRequest(config, request);
  const started = Date.now(), session = createHeadlessSession(), results = [];
  let eventFailure = false;
  const emit = event => {
    if (!onEvent || eventFailure) return;
    try { onEvent({ ...event, batchElapsedMs: Date.now() - started, count: requests.length }); }
    catch { eventFailure = true; }
  };
  emit({ type: 'batch-start' });
  for (let index = 0; index < requests.length; index++) {
    if (signal?.aborted || eventFailure) break;
    emit({ type: 'request-start', index });
    if (eventFailure) break;
    let result;
    try {
      result = await session.run(config, requests[index], { signal, onProgress: e => {
        emit({ ...e, index });
        if (eventFailure) fail('progress_handler_failed');
      } });
    } catch (e) { result = { status: 'failed', reason: safeReason(e) }; }
    results.push(result);
    emit({ type: 'request-result', index, result });
    if (result.status !== 'completed' || eventFailure) break;
  }
  const sum = field => results.reduce((n, r) => n + (r.evidence?.[field] ?? 0), 0);
  return { status: !eventFailure && results.length === requests.length && results.every(r => r.status === 'completed') ? 'completed' : 'failed',
    ...(eventFailure ? { reason: 'progress_handler_failed' } : signal?.aborted ? { reason: 'cancelled' } : {}),
    results, notRun: requests.length - results.length,
    summary: { totalMs: Date.now() - started, preflightMs: sum('preflightMs'), executionMs: sum('durationMs'),
      helpCacheHits: results.filter(r => r.evidence?.helpCacheHit).length,
      digestCacheHits: results.reduce((n, r) => n + (r.evidence?.digestCache?.hits ?? 0), 0),
      digestBytesRead: results.reduce((n, r) => n + (r.evidence?.digestCache?.bytesRead ?? 0), 0) } };
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
  if (!['doctor', 'run', 'run-events', 'batch', 'batch-events'].includes(action) || !configFile) fail('invalid_action');
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
      const input = JSON.parse(fs.readFileSync(other, 'utf8').replace(/^\uFEFF/, ''));
      if (action === 'batch' || action === 'batch-events') {
        result = await runHeadlessBatch(config, input, { signal: controller.signal,
          ...(action === 'batch-events' ? { onEvent: e => console.log(JSON.stringify(e)) } : {}) });
      } else result = await runHeadless(config, input, { signal: controller.signal,
        ...(action === 'run-events' ? { onProgress: e => console.log(JSON.stringify(e)) } : {}) });
    }
    const events = action.endsWith('-events');
    console.log(JSON.stringify(events ? { type: 'result', result } : result, null, events ? 0 : 2));
    if (action !== 'doctor' ? result.status !== 'completed' : Object.values(result.clients).some(c => !['disabled', 'ready'].includes(c.status))) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  // Do not echo native CLI stderr, configuration paths or credentials in failures.
  console.log(JSON.stringify({ status: 'failed', reason: /^[a-z_]+$/.test(e.message) ? e.message : 'headless_configuration_or_io_error' }));
  process.exitCode = 1;
});
