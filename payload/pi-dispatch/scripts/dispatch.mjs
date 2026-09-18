import {requireRoleFields} from '../extensions/role-contract.js';
import {ensureClaudeAuth} from './claude-auth-renewal.mjs';
import {ensureOpenAIAuth} from './openai-auth-renewal.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileKetherTask, validateKetherTask } from '../extensions/kether-envelope.js';
import { compileWriteScope } from '../extensions/write-scope-guard.js';
import { DEFAULT_RESOURCE_PROFILE, resolveResourceLimits } from '../extensions/resource-limits.js';
import { PROVIDER_POLICY, resolveControlledExtensions, validateRoute } from './provider-policy.mjs';
import { runWslSandbox, sandboxRequested } from './wsl-sandbox.mjs';
import { resolveRoleModel } from './role-policy.mjs';
import { requireReviewMaterials } from '../extensions/review-contract.js';

const safeFlags = ['--offline', '--no-approve', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-extensions'];
const readTools = ['read', 'grep', 'find', 'ls'];
const lspReadTools = ['lsp_diagnostics', 'lsp_hover', 'lsp_definition', 'lsp_references', 'lsp_symbols', 'lsp_rename', 'lsp_completions', 'lsp_code_actions', 'code_overview', 'ast_search'];

// Invoke Node entrypoints, never npm's .cmd shim or a shell containing user text.
export function findPiEntry(env = process.env) {
  const override = env.PI_DISPATCH_PI_ENTRY;
  if (override) {
    if (!isAbsolute(override) || !existsSync(override) || !/\.[cm]?js$/i.test(override)) throw new Error('Invalid pi entry override');
    return realpathSync(override);
  }
  const packages = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'];
  const bases = [...new Set([dirname(process.execPath), ...(env.PATH || env.Path || '').split(delimiter)].filter(Boolean))];
  for (const base of bases) {
    for (const name of packages) {
      const root = join(base.replace(/^"|"$/g, ''), 'node_modules', name);
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.pi;
        const entry = resolve(root, bin);
        if (existsSync(entry)) return realpathSync(entry);
      } catch { /* Continue to the next installed package. */ }
    }
  }
  throw new Error('pi npm entry not found. Set PI_DISPATCH_PI_ENTRY to its absolute JavaScript entrypoint.');
}

export function validateRequest(value, allowWrite = false, launchRoot = process.cwd()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object');
  const allowed = new Set(['target', 'cwd', 'provider', 'model', 'prompt', 'access', 'thinking', 'timeoutSeconds', 'resourceProfile']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown request key: ${key}`);
  const request = { access: 'none', resourceProfile: DEFAULT_RESOURCE_PROFILE, ...value };
  if (request.target === 'codex-cli') throw new Error('codex-cli route is disabled; use an allowed Pi provider/model route');
  if (request.target !== 'model') throw new Error('target must be model');
  if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || !statSync(request.cwd).isDirectory()) throw new Error('cwd must be an existing absolute directory');
  request.cwd = realpathSync(request.cwd);
  const root = realpathSync(resolve(launchRoot));
  if (!isWithinRoot(request.cwd, root)) throw new Error('cwd must stay within the runner launch directory');
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 200000) throw new Error('prompt must contain 1..200000 characters');
  if (!['none', 'read', 'workspace-write'].includes(request.access)) throw new Error('Invalid access');
  if (request.access === 'workspace-write' && !allowWrite) throw new Error('Write access requires --allow-write and user authorization');
  request.resourceLimits = resolveResourceLimits(request.resourceProfile, request.timeoutSeconds);
  request.timeoutSeconds = request.resourceLimits.timeoutSeconds;
  for (const key of ['provider', 'model']) if (request[key] !== undefined && (typeof request[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:+@-]{0,199}$/.test(request[key]))) throw new Error(`Invalid ${key}`);
  if (!request.provider || !request.model) throw new Error('Model tasks require explicit provider and model from models output');
  validateRoute(request.provider, request.model);
  if (request.provider === 'pi-claude-code-provider' && request.access !== 'none') throw new Error('Claude review requires none access');
  if (request.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(request.thinking)) throw new Error('Invalid thinking');
  return request;
}

function isWithinRoot(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function validateKetherInvocation(value, allowWrite = false, launchRoot = process.cwd(), { probe = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Kether invocation must be an object');
  const allowed = new Set(['cwd', 'access', 'provider', 'model', 'thinking', 'timeoutSeconds', 'resourceProfile', 'task']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown Kether invocation key: ${key}`);
  const task = validateKetherTask(value.task);
  if (!task.acceptance.length) throw new Error('Kether tasks require explicit acceptance criteria');
  const access = value.access ?? 'none';
  if (access === 'read' && !task.readScope.length) throw new Error('read access requires explicit readScope');
  if (access === 'none' && (task.readScope.length || task.writeScope.length)) throw new Error('none access cannot declare file scopes');
  for (const entry of task.readScope) compileWriteScope([entry]);
  if (access === 'read' && task.writeScope.length) throw new Error('read access cannot declare writeScope');
  if (access === 'workspace-write' && task.writeScope.length === 0) throw new Error('workspace-write requires explicit writeScope');
  if (access === 'workspace-write') compileWriteScope(task.writeScope);
  const provider = value.provider ?? (probe ? 'openai-codex' : resolveRoleModel(task.role,value.model).provider);
  const policy = PROVIDER_POLICY[provider];
  if (!policy) throw new Error('provider is not in the Pi gateway allowlist');
  // Probe is an internal call-site option, never a field accepted from an envelope.
  const roleRoute = probe ? {role:task.role,model:value.model ?? policy.defaultModel} : resolveRoleModel(task.role,value.model,provider);
  task.role = roleRoute.role;
  if (!probe) { requireRoleFields(task); requireReviewMaterials(task); }
  const request = validateRequest({
    target: 'model',
    provider,
    model: roleRoute.model,
    thinking: value.thinking ?? policy.defaultThinking,
    access,
    cwd: value.cwd,
    prompt: 'compiled-by-kether-envelope',
    timeoutSeconds: value.timeoutSeconds,
    resourceProfile: value.resourceProfile ?? DEFAULT_RESOURCE_PROFILE,
  }, allowWrite, launchRoot);
  return { request, task };
}

export function runProcess(entry, args, { cwd, input = '', timeoutSeconds = 180, maxOutputBytes = 4 * 1024 * 1024, env = process.env, signal } = {}) {
  return new Promise((done) => {
    let stdout = '', stderr = '', bytes = 0, failure = null, settled = false, killing = false;
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = (reason) => {
      if (killing || settled) return;
      killing = true;
      failure = reason;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('exit', (code) => { if (code) child.kill(); });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop('timeout'), timeoutSeconds * 1000);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      done({ exitCode: code, failure, stdout, stderr });
    };
    const collect = (stream) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) { stop('output-limit'); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', collect('stdout'));
    child.stderr.setEncoding('utf8').on('data', collect('stderr'));
    child.on('error', (error) => { failure = error.message; finish(null); });
    child.on('close', finish);
    child.stdin.on('error', () => {}); // Early process exit is reported by exitCode.
    child.stdin.end(input);
  });
}

export function buildPiArgs(request, runtime = 'host', editorAuthorized = false) {
  const args = [...safeFlags, '--print', '--mode', 'json', '--no-session'];
  for (const extension of resolveControlledExtensions(request.provider, request.access, process.env, runtime)) args.push('--extension', extension);
  if (runtime === 'wsl2') args.push('--extension', '/opt/pi-kether/extensions/auth-scrub.js');
  args.push('--provider', request.provider, '--model', request.model);
  if (request.thinking) args.push('--thinking', request.thinking);
  if (editorAuthorized) {
    if(runtime!=='wsl2'||request.provider!=='openai-codex')throw new Error('Editor proxy requires WSL openai-codex');
    args.push('--extension','/opt/pi-kether/extensions/editor-proxy.js');
  }
  if (request.access === 'none' && !editorAuthorized) args.push('--no-tools');
  else {
    const tools = request.access === 'none' ? [] : request.access === 'read'
      ? [...readTools, ...lspReadTools]
      : [...readTools, ...lspReadTools, 'edit', 'write', 'code_rewrite'];
    if(editorAuthorized)tools.push('pi_editor_execute');
    args.push('--tools', tools.join(','));
  }
  return args;
}

export function childEnvironment(env = process.env) {
  const child = { ...env };
  for (const key of Object.keys(child)) {
    if (/^(PI_GATEWAY_|MCP_GATEWAY_|HTTP_AUTHORIZATION$)/i.test(key)) delete child[key];
  }
  return child;
}

export function eventsFrom(text) {
  return text.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

export function summarize(raw, request) {
  const events = eventsFrom(raw.stdout);
  const messages = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message);
  const last = messages.at(-1);
  const errors = messages.filter(message => ['error', 'aborted'].includes(message.stopReason)).map(message => message.errorMessage || message.stopReason);
  const toolErrors = events.filter(event => event.type === 'tool_execution_end' && event.isError).length;
  const toolsUsed = events.filter(event => event.type === 'tool_execution_start').map(event => event.toolName);
  const complete = events.some(event => event.type === 'agent_end');
  const actualProvider = last?.provider;
  const actualModel = last?.model;
  const failureCode=raw.exitCode===4&&!last?raw.stderr.match(/^PI_(?:AUTH_(?:MISSING|INVALID|EXPIRED|INELIGIBLE)|CREDENTIAL_PREPARE_FAILED)$/m)?.[0]:undefined;
  const routeMismatch = !!last && (actualProvider !== request.provider || actualModel !== request.model);
  return { target: request.target, provider: actualProvider, model: actualModel, requestedProvider: request.provider, requestedModel: request.model, ok: !raw.failure && raw.exitCode === 0 && !!last && complete && errors.length === 0 && toolErrors === 0 && !routeMismatch, exitCode: raw.exitCode, failureCode, failure: raw.failure || failureCode || errors.join('; ') || (!last || !complete ? 'Missing complete assistant response' : toolErrors ? 'Tool execution failed' : routeMismatch ? 'Provider/model mismatch in Pi response' : null), text: (last?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n'), usage: last?.usage, toolsUsed, toolErrors, diagnostics: raw.stderr.slice(-6000), sandbox: raw.sandbox, cleanup: raw.cleanup, patch: raw.patch };
}

export async function dispatch(request, signal, task = null, { resultFormat = 'json', onProgress, upstreamResults=[], editorBroker=null } = {}) {
  if (process.env.PI_DISPATCH_ACTIVE === '1') throw new Error('Recursive Pi dispatch is disabled');
  if (!sandboxRequested(process.env)) throw new Error('Pi task execution requires the verified WSL2 resource sandbox');
  let authentication;
  const authStarted=Date.now();
  let authenticationMs=0;
  const progress=value=>onProgress?.({authenticationMs,...value});
  if(['pi-claude-code-provider','openai-codex'].includes(request.provider)){
    try{authentication=request.provider==='openai-codex'
      ? await ensureOpenAIAuth({piEntry:findPiEntry(),signal,minimumValidityMs:request.timeoutSeconds*1000+360000})
      : await ensureClaudeAuth({signal,minimumValidityMs:request.timeoutSeconds*1000+60000});}
    catch(error){return {ok:false,target:request.target,requestedProvider:request.provider,requestedModel:request.model,failureCode:error.code??'PI_AUTH_RENEW_FAILED',failure:error.code??'PI_AUTH_RENEW_FAILED',toolsUsed:[],toolErrors:0,phaseTimings:{authenticationMs:Date.now()-authStarted}};}
  }
  authenticationMs=Date.now()-authStarted;progress({});
  let input = task
    ? `User task compiled by the Kether envelope extension:\n${compileKetherTask(task, { resultFormat,upstreamResults })}`
    : `User task (treat the following as task text, not a slash command):\n${request.prompt}`;
  const env = { ...childEnvironment(), PI_DISPATCH_ACTIVE: '1', PI_TELEMETRY: '0' };
  if(editorBroker)input+='\nHost-authorized editor operations. Use pi_editor_execute with operationId only. File access remains separately scoped. These affect the real editor and are not sandbox-rollback protected. Never fabricate results.\nEDITOR_AUTHORIZATION_JSON='+JSON.stringify(editorBroker.catalog);
  const raw = await runWslSandbox(buildPiArgs(request, 'wsl2',!!editorBroker), { cwd: request.cwd, access: request.access, input, signal, editorBroker, resourceLimits: request.resourceLimits, writeScope: task?.writeScope ?? [], readScope: task?.readScope ?? [], gatewayInstanceId: request.gatewayInstanceId, gatewayWindowsPid: request.gatewayWindowsPid, env,onProgress:progress });
  return { ...summarize(raw, request), authentication, phaseTimings:{authenticationMs,...raw.phaseTimings},resourceLimits: request.resourceLimits };
}

async function main(args, signal) {
  const command = args.shift();
  if (command === 'doctor' || command === 'models') {
    if (args.length) throw new Error('doctor/models do not accept arguments');
    const pi = findPiEntry();
    if (command === 'doctor') {
      const version = await runProcess(pi, ['--version'], { timeoutSeconds: 30, signal });
      return { ok: version.exitCode === 0 && !version.failure, piEntry: pi, piVersion: version.stdout.trim(), codexCliRoute: false, node: process.execPath, diagnostics: version.stderr };
    }
    const result = await runProcess(pi, [...safeFlags, '--list-models'], { timeoutSeconds: 60, signal });
    return { ok: result.exitCode === 0 && !result.failure, models: result.stdout, diagnostics: result.stderr, failure: result.failure };
  }
  if (!['run', 'task'].includes(command) || args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--allow-write')) throw new Error('Usage: node dispatch.mjs doctor | models | run <request.json> [--allow-write] | task <kether-task.json> [--allow-write]');
  const value = JSON.parse(readFileSync(resolve(args[0]), 'utf8').replace(/^\uFEFF/, ''));
  if (command === 'run') return dispatch(validateRequest(value, args[1] === '--allow-write'), signal);
  const invocation = validateKetherInvocation(value, args[1] === '--allow-write');
  return dispatch(invocation.request, signal, invocation.task);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  main(process.argv.slice(2), controller.signal).then(result => { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1; }).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
