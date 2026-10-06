import { API_PROVIDERS, loadProviderConfig, configuredRoute, providerPolicy, configDigest } from './controlled-provider.mjs';
import {requireRoleFields, roleResultSchema} from '../extensions/role-contract.js';
import {prepareWindowsApiPacket} from './windows-api-credential.mjs';
import {ensureOpenAIAuth} from './openai-auth-renewal.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileKetherTask, validateKetherTask } from '../extensions/kether-envelope.js';
import { compileRoleWorkerTaskPrompt } from './task-packet-guidance.mjs';
import { compileWriteScope } from '../extensions/write-scope-guard.js';
import { accountToolErrors } from '../extensions/tool-error-recovery.js';
import { DEFAULT_RESOURCE_PROFILE, resolveResourceLimits } from '../extensions/resource-limits.js';
import { PROVIDER_POLICY, resolveControlledExtensions, validateRoute } from './provider-policy.mjs';
import { runWslSandbox, sandboxRequested } from './wsl-sandbox.mjs';
import { runClaudeReviewerCli } from './claude-reviewer-cli.mjs';
import { resolveRoleModel } from './role-policy.mjs';
import { selectTaskThinking } from './task-planning.mjs';
import { validateRoleAccess } from './role-presets.mjs';
import { requireReviewMaterials, validateReviewPacket } from '../extensions/review-contract.js';
import { calculateExecutionBudget } from '../extensions/execution-budget.js';
import { editorRouteAllowed, enforceWorkerExecution, isReviewerRoute } from './worker-enforcement.mjs';

const safeFlags = ['--offline', '--no-approve', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-extensions'];
const readTools = ['read', 'grep', 'find', 'ls'];
const lspReadTools = ['lsp_diagnostics', 'lsp_hover', 'lsp_definition', 'lsp_references', 'lsp_symbols', 'lsp_rename', 'lsp_completions', 'lsp_code_actions', 'code_overview', 'ast_search'];
const wslLspTools = ['diagnostics','hover','definition','references','symbols','completions','code_actions'].map(m => `yhwh_lsp_${m}`);
const rolePresetExtension = '/opt/pi-kether/extensions/role-presets.js';
const resultSubmitExtension = '/opt/pi-kether/extensions/result-submit.js';
const sourceWindowExtension = '/opt/pi-kether/extensions/source-window.js';

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

export function validateRequest(value, allowWrite = false, launchRoot = process.cwd(), { reviewerValidated = false, probe = false, probeToken, probeApproved = false, task, reviewTier='T2' } = {}) {
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
  const policy = validateRoute(request.provider, request.model);
  const tier = ['T0','T1','T2'].includes(reviewTier) ? reviewTier : 'T2';
  if (request.provider === 'claude-code-cli' && (
    request.access !== 'none' || !(probe && probeApproved && probeToken && task?.role === 'Netzach') && (!reviewerValidated || task?.role !== 'Geburah') ||
    request.thinking !== undefined && !['medium','high','xhigh'].includes(request.thinking) ||
    task?.readScope?.length || task?.writeScope?.length
  )) throw Object.assign(new Error('Claude Code review requires validated Geburah reviewer packet, none access, and medium/high/xhigh thinking'), { code: 'YHWH_WORKER_ENFORCEMENT_REJECTED' });
  enforceWorkerExecution({ provider: request.provider, model: request.model, access: request.access, reviewerValidated, probe, probeToken, probeApproved, task });
  if (request.thinking === undefined) request.thinking = policy.defaultThinking;
  if (['anthropic','yhwh-reviewer-api'].includes(request.provider) && request.access !== 'none') throw new Error('Claude review requires none access');
  if (request.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(request.thinking)) throw new Error('Invalid thinking');
  if (reviewerValidated && !probe && !['medium','high','xhigh'].includes(request.thinking)) throw Object.assign(new Error('Reviewer thinking must be medium, high, or xhigh'),{code:'REVIEW_TIER_THINKING_INVALID'});
  if (API_PROVIDERS.includes(request.provider)) {
    const config=loadProviderConfig();
    const route=configuredRoute(request.provider,config);
    if (!route || route.model!==request.model) throw new Error('PI_PROVIDER_CONFIG_CHANGED');
    if (request.thinking!=='max') throw new Error('Controlled API requires max thinking; no downgrade');
    request.providerConfigDigest=configDigest(config);
    request.configuredTransport={platform:route.platform,protocol:route.protocol,baseUrl:route.baseUrl,configSha256:request.providerConfigDigest,capabilityEvidence:'operator-declared'};
  }
  return request;
}

function isWithinRoot(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function validateKetherInvocation(value, allowWrite = false, launchRoot = process.cwd(), { probe = false, probeToken, reviewTier='T2' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Kether invocation must be an object');
  const allowed = new Set(['cwd', 'access', 'provider', 'model', 'thinking', 'timeoutSeconds', 'resourceProfile', 'task']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown Kether invocation key: ${key}`);
  const task = validateKetherTask(value.task);
  if (!task.acceptance.length) throw new Error('Kether tasks require explicit acceptance criteria');
  const access = value.access ?? 'none';
  if (!probe) validateRoleAccess(task.role, access);
  if (access === 'read' && !task.readScope.length) throw new Error('read access requires explicit readScope');
  if (access === 'none' && (task.readScope.length || task.writeScope.length || task.fixtureScope.length)) throw new Error('none access cannot declare file scopes');
  for (const entry of task.readScope) compileWriteScope([entry]);
  if (access === 'read' && task.writeScope.length) throw new Error('read access cannot declare writeScope');
  if (access === 'workspace-write' && task.writeScope.length === 0) throw new Error('workspace-write requires explicit writeScope');
  if (access === 'workspace-write') compileWriteScope(task.writeScope);
  const provider = value.provider ?? (probe ? 'openai-codex' : resolveRoleModel(task.role,value.model).provider);
  const policy = PROVIDER_POLICY[provider] ?? providerPolicy(provider);
  if (!policy) throw new Error('provider is not in the Pi gateway allowlist');
  // Probe is an internal call-site option, never a field accepted from an envelope.
  const roleRoute = probe ? {role:task.role,model:value.model ?? policy.defaultModel} : resolveRoleModel(task.role,value.model,provider);
  task.role = roleRoute.role;
  const trustedReviewTier=['T0','T1','T2'].includes(reviewTier)?reviewTier:'T2';
  if (!probe) { requireRoleFields(task); if(task.role==='Geburah') task.reviewPacket=validateReviewPacket(task.reviewPacket,{tier:trustedReviewTier}); if(trustedReviewTier==='T0'&&task.role==='Geburah') throw Object.assign(new Error('Geburah review is not permitted at T0'),{code:'REVIEW_TIER_INVALID'}); requireReviewMaterials(task); }
  const thinkingDecision = selectTaskThinking({ task, provider, thinking: value.thinking, defaultThinking: policy.defaultThinking, probe });
  const request = validateRequest({
    target: 'model',
    provider,
    model: roleRoute.model,
    thinking: thinkingDecision.selectedThinking,
    access,
    cwd: value.cwd,
    prompt: 'compiled-by-kether-envelope',
    timeoutSeconds: value.timeoutSeconds,
    resourceProfile: value.resourceProfile ?? DEFAULT_RESOURCE_PROFILE,
  }, allowWrite, launchRoot, { reviewerValidated: !probe && task.role === 'Geburah' && access === 'none', probe, probeToken, probeApproved: probe && policy.models.includes(roleRoute.model), task, reviewTier:trustedReviewTier });
  request.reviewTier=trustedReviewTier;
  request.thinkingDecision=thinkingDecision;
  if (!probe) request.rolePresetId = validateRoleAccess(task.role, access).id;
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

export function buildPiArgs(request, runtime = 'host', editorAuthorized = false, structuredResultTool = false) {
  const args = [...safeFlags, '--print', '--mode', 'json', '--no-session'];
  let preset;
  if (request.rolePresetId !== undefined) {
    if (runtime !== 'wsl2') throw new Error('Role presets require WSL2');
    preset = validateRoleAccess(request.rolePresetId, request.access);
    if (preset.id !== request.rolePresetId) throw new Error('Invalid role preset identity');
    args.push('--extension', rolePresetExtension, '--yhwh-role-preset', preset.id);
  }
  for (const extension of resolveControlledExtensions(request.provider, request.access, process.env, runtime)) args.push('--extension', extension);
  if (runtime === 'wsl2') args.push('--extension', '/opt/pi-kether/extensions/auth-scrub.js');
  if (runtime === 'wsl2' && request.access !== 'none') args.push('--extension', sourceWindowExtension);
  if (structuredResultTool) {
    if (runtime !== 'wsl2' || request.access === 'none') throw new Error('Structured result tool requires WSL2 read or workspace-write access');
    if (!preset) throw new Error('Structured result tool requires a trusted role preset');
    args.push('--extension', resultSubmitExtension, '--yhwh-result-role', request.rolePresetId);
  }
  args.push('--provider', request.provider, '--model', request.model);
  if (request.thinking) args.push('--thinking', request.thinking);
  if (API_PROVIDERS.includes(request.provider)) {
    if (!/^[a-f0-9]{64}$/.test(request.providerConfigDigest ?? '')) throw new Error('PI_PROVIDER_CONFIG_REQUIRED');
    args.push('--yhwh-config', request.providerConfigDigest);
  }
  if (editorAuthorized) {
    if(runtime!=='wsl2'||request.provider!=='openai-codex')throw new Error('Editor proxy requires WSL openai-codex');
    args.push('--extension','/opt/pi-kether/extensions/editor-proxy.js');
  }
  if (request.access === 'none' && !editorAuthorized) args.push('--no-tools');
  else {
    const tools = request.access === 'none' ? [] : request.access === 'read'
      ? [...readTools, ...(runtime === 'wsl2' ? [] : lspReadTools)]
      : [...readTools, ...(runtime === 'wsl2' ? [] : lspReadTools), 'edit', 'write', ...(runtime === 'wsl2' ? [] : ['code_rewrite'])];
    if (runtime === 'wsl2' && request.access !== 'none') tools.push(...wslLspTools, 'yhwh_source_window');
    if (structuredResultTool) tools.push('yhwh_submit_result');
    if (preset) {
      const ceiling = new Set(preset.toolCeilings[request.access]);
      const bounded = tools.filter(tool => ceiling.has(tool));
      if (editorAuthorized) bounded.push('pi_editor_execute');
      args.push('--tools', bounded.join(','));
      return args;
    }
    if(editorAuthorized)tools.push('pi_editor_execute');
    args.push('--tools', tools.join(','));
  }
  return args;
}

export function childEnvironment(env = process.env) {
  const child = { ...env };
  for (const key of Object.keys(child)) {
    if (/^(PI_GATEWAY_|MCP_GATEWAY_|HTTP_AUTHORIZATION$|ANTHROPIC_|CLAUDE_|OPENROUTER_|OPENCODE_|COMMANDCODE_|CMD_API_KEY$|YHWH_|NODE_OPTIONS$)/i.test(key)) delete child[key];
  }
  return child;
}

export function eventsFrom(text) {
  return text.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function canonicalResultJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalResultJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalResultJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function resultSubmissionFrom(events) {
  const matching = events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'yhwh_submit_result');
  const successes = matching.filter(event => {
    const details = event.result?.details ?? event.details;
    return details?.type !== 'kether_result_rejection';
  });
  const rejections = matching.filter(event => {
    const details = event.result?.details ?? event.details;
    return details?.type === 'kether_result_rejection' && details.code === 'RESULT_ROLE_SCHEMA_INVALID' && Object.keys(details).length === 2;
  });
  if (matching.length !== successes.length + rejections.length) return { ok: false, code: 'RESULT_SUBMISSION_MALFORMED' };
  if (successes.length !== 1) return { ok: false, code: successes.length ? 'RESULT_SUBMISSION_MULTIPLE' : 'RESULT_SUBMISSION_MISSING' };
  const matchingSuccess = successes[0];
  const details = matchingSuccess.result?.details ?? matchingSuccess.details;
  const canonicalText = details?.type === 'kether_result_submission' ? details.canonicalText : null;
  if (typeof canonicalText !== 'string' || !canonicalText.startsWith('KETHER_RESULT_JSON=')) return { ok: false, code: 'RESULT_SUBMISSION_MALFORMED' };
  try {
    const payloadText = canonicalText.slice('KETHER_RESULT_JSON='.length);
    const payload = JSON.parse(payloadText);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || canonicalResultJson(payload) !== payloadText) return { ok: false, code: 'RESULT_SUBMISSION_MALFORMED' };
    return { ok: true, canonicalText };
  } catch {
    return { ok: false, code: 'RESULT_SUBMISSION_MALFORMED' };
  }
}

export function summarize(raw, request) {
  if (['PI_PATCH_CONTAINS_ISSUED_CREDENTIAL', 'PI_PATCH_TOKEN_INVALID', 'PI_PATCH_INVALID_BYTES'].includes(raw.failureCode ?? raw.failure)) {
    const code = raw.failureCode ?? raw.failure;
    const cleanup = raw.cleanup && typeof raw.cleanup === 'object' ? {
      ...(typeof raw.cleanup.ok === 'boolean' ? { ok: raw.cleanup.ok } : {}),
      ...(Number.isFinite(raw.cleanup.exitCode) ? { exitCode: raw.cleanup.exitCode } : {}),
    } : undefined;
    return {
      target: request.target, requestedProvider: request.provider, requestedModel: request.model,
      ok: false, failureCode: code, failure: code,
      ...(Number.isFinite(raw.exitCode) ? { exitCode: raw.exitCode } : {}),
      ...(typeof raw.sandbox === 'boolean' ? { sandbox: raw.sandbox } : {}),
      ...(cleanup ? { cleanup } : {}),
    };
  }
  const events = eventsFrom(raw.stdout);
  const messages = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message);
  const last = messages.at(-1);
  const errors = messages.filter(message => ['error', 'aborted'].includes(message.stopReason)).map(message => message.errorMessage || message.stopReason);
  const toolRecovery = accountToolErrors(events);
  const toolErrors = toolRecovery.total;
  const toolsUsed = events.filter(event => event.type === 'tool_execution_start').map(event => event.toolName);
  const complete = events.some(event => event.type === 'agent_end');
  if (last?.usage && API_PROVIDERS.includes(request.provider)) { last.usage={...last.usage,cost:null,costUnavailable:true}; }
  const actualProvider = last?.provider;
  const actualModel = last?.model;
  const failureCode=raw.exitCode===4&&!last?raw.stderr.match(/^PI_(?:AUTH_(?:MISSING|INVALID|EXPIRED|INELIGIBLE)|CREDENTIAL_PREPARE_FAILED)$/m)?.[0]:undefined;
  const processFailureCode = raw.failure === 'timeout' || raw.exitCode === 124 ? 'EXECUTION_TIMEOUT' : raw.failure === 'cancelled' ? 'EXECUTION_CANCELLED' : raw.exitCode === 143 ? 'TERMINATED' : undefined;
  const routeMismatch = !!last && (actualProvider !== request.provider || actualModel !== request.model);
  const primaryFailureCode = raw.failureCode ?? failureCode ?? processFailureCode;
  const primaryFailure = primaryFailureCode ?? raw.failure ?? (errors.join('; ') || (!last || !complete ? 'Missing complete assistant response' : toolRecovery.unrecoveredErrors ? 'Tool execution failed' : routeMismatch ? 'Provider/model mismatch in Pi response' : null));
  return { ...(request.resultSubmissionRequired ? { resultSubmission: resultSubmissionFrom(events) } : {}), ...(request.configuredTransport?{configuredTransport:request.configuredTransport}:{}), target: request.target, provider: actualProvider, model: actualModel, requestedProvider: request.provider, requestedModel: request.model, ok: !primaryFailureCode && !raw.failure && raw.exitCode === 0 && !!last && complete && errors.length === 0 && toolRecovery.unrecoveredErrors === 0 && !routeMismatch, exitCode: raw.exitCode, failureCode: primaryFailureCode ?? failureCode, failure: primaryFailure, text: (last?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n'), usage: last?.usage, toolsUsed, toolErrors, ...toolRecovery, recoverableToolFailure: !raw.failure && raw.exitCode === 0 && !!last && complete && errors.length === 0 && !routeMismatch && toolErrors > 0, recoverableFileToolFailure: toolRecovery.unrecoveredFileToolErrors > 0 && toolRecovery.unrecoveredErrors === toolRecovery.unrecoveredFileToolErrors, diagnostics: raw.stderr.slice(-6000), sandbox: raw.sandbox, cleanup: raw.cleanup, patch: raw.patch, patchValidation: raw.patchValidation, ...(raw.patchPolicy === 'issued-credential-v1' ? { patchPolicy: raw.patchPolicy, secretLikeContent: raw.secretLikeContent, ...(raw.secretLikeContent ? { patchConfirmationRequired: true, patchWarning: 'Generic secret-like patterns detected; obtain human confirmation before applying this patch.' } : {}), patchSha256: raw.patchSha256, patchBytes: raw.patchBytes } : {}) };
}

export function findClaudeCliEntry() {
  const executableDir = dirname(process.execPath);
  const adjacent = resolve(executableDir, 'claude.js');
  if (existsSync(adjacent) && statSync(adjacent).isFile()) return realpathSync(adjacent);
  const roots = [executableDir, resolve(executableDir, '..', 'lib', 'node_modules')];
  for (const root of roots) {
    for (const entry of [resolve(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), resolve(root, '@anthropic-ai', 'claude-code', 'cli.js')]) {
      if (existsSync(entry) && statSync(entry).isFile()) return realpathSync(entry);
    }
  }
  throw Object.assign(new Error('Official Claude Code CLI entrypoint not found'), { code: 'CLAUDE_CLI_NOT_FOUND' });
}

export async function dispatch(request, signal, task = null, { resultFormat = 'json', onProgress, upstreamResults=[], editorBroker=null, probe = false, probeToken, claudeReviewerRunner = runClaudeReviewerCli, claudeCliEntryResolver = findClaudeCliEntry, onModelStart } = {}) {
  const dispatchStarted = performance.now();
  const structuredResultTool = !!task && resultFormat === 'json' && !probe && request.access !== 'none';
  if (editorBroker && (!editorRouteAllowed(request.provider, request.model) || probe)) throw Object.assign(new Error('Editor proxy is restricted to the native Luna worker route'), { code: 'YHWH_EDITOR_ROUTE_REJECTED' });
  let reviewerValidated = false;
  if (!probe && isReviewerRoute(request.provider, request.model) && task && request.access === 'none') {
    const normalizedTask = validateKetherTask(task);
    if (normalizedTask.readScope?.length || normalizedTask.writeScope?.length || normalizedTask.fixtureScope?.length) throw new Error('none access cannot declare file scopes');
    const roleRoute = resolveRoleModel(normalizedTask.role, request.model, request.provider);
    const reviewerTask = { ...normalizedTask, role: roleRoute.role };
    const reviewTier=['T0','T1','T2'].includes(request.reviewTier)?request.reviewTier:'T2';
    if(reviewTier==='T0') throw Object.assign(new Error('Geburah review is not permitted at T0'),{code:'REVIEW_TIER_INVALID'});
    reviewerTask.reviewPacket=validateReviewPacket(reviewerTask.reviewPacket,{tier:reviewTier});
    requireRoleFields(reviewerTask);
    requireReviewMaterials(reviewerTask);
    reviewerValidated = roleRoute.role === 'Geburah';
  }
  let probeApproved = false;
  if (probe) {
    try { validateRoute(request.provider, request.model); probeApproved = true; } catch { /* Gate below rejects unapproved probe routes. */ }
  }
  enforceWorkerExecution({ provider: request.provider, model: request.model, access: request.access, reviewerValidated, probe, probeToken, probeApproved, task });
  if (process.env.PI_DISPATCH_ACTIVE === '1') throw new Error('Recursive Pi dispatch is disabled');
  if (request.provider === 'claude-code-cli') {
    const packet = probe ? `Return exactly ${probeToken} and nothing else.` : compileKetherTask(task, { resultFormat });
    const result = await claudeReviewerRunner({ packet, nodePath: process.execPath, cliScript: claudeCliEntryResolver(), timeoutMs: request.timeoutSeconds * 1000, signal, thinking: request.thinking ?? PROVIDER_POLICY[request.provider]?.defaultThinking ?? 'medium', ...(!probe ? { resultSchema: roleResultSchema('Geburah') } : {}), ...(!probe && typeof onModelStart === 'function' ? { onModelStart } : {}) });
    const failureCode = ['PI_AUTH_EXPIRED', 'PI_QUOTA_LIMITED'].includes(result.reason) ? result.reason : undefined;
    return {
      target: request.target, requestedProvider: request.provider, requestedModel: request.model,
      provider: request.provider, model: request.model, ok: result.status === 'completed',
      ...(result.text !== undefined ? { text: result.text } : {}), usage: result.usage ?? null, modelExecutionStarted: result.modelExecutionStarted === true,
      toolsUsed: [], toolErrors: 0, runtime: 'host-cli', osSandbox: 'none',
      ...(result.status !== 'completed' ? { failureCode: failureCode ?? result.reason, failure: failureCode ?? result.reason ?? 'Claude Code CLI failed' } : {}),
      ...(result.resetTime ? { resetTime: result.resetTime } : {}),
    };
  }
  if (!sandboxRequested(process.env)) throw new Error('Pi task execution requires the verified WSL2 resource sandbox');
  let authentication;
  let apiPacket;
  const authStarted=Date.now();
  let authenticationMs=0;
  const progress=value=>onProgress?.({authenticationMs,...value});
  if(['anthropic','openai-codex',...API_PROVIDERS].includes(request.provider)){
    try{
      if(request.provider==='openai-codex')authentication=await ensureOpenAIAuth({piEntry:findPiEntry(),signal,minimumValidityMs:request.timeoutSeconds*1000+360000});
      else {apiPacket=await prepareWindowsApiPacket(request,{signal});authentication={ok:true,authentication:'api_key',atRestEncryption:'Windows DPAPI CurrentUser',networkValidated:false};}
    }
    catch(error){return {ok:false,...(structuredResultTool ? {resultSubmissionRequired:true} : {}),target:request.target,requestedProvider:request.provider,requestedModel:request.model,failureCode:error.code??'PI_AUTH_RENEW_FAILED',failure:error.code??'PI_AUTH_RENEW_FAILED',toolsUsed:[],toolErrors:0,phaseTimings:{authenticationMs:Date.now()-authStarted}};}
  }
  authenticationMs=Date.now()-authStarted;progress({});
  let input = task
    ? `User task compiled by the Kether envelope extension:\n${compileRoleWorkerTaskPrompt(task, request.access, { resultFormat,upstreamResults, structuredResultTool })}`
    : `User task (treat the following as task text, not a slash command):\n${request.prompt}`;
  const env = { ...childEnvironment(), PI_DISPATCH_ACTIVE: '1', PI_TELEMETRY: '0' };
  if (request.access !== 'none') input+='\nPrefer yhwh_lsp_* for single-file semantic checks. These run credential-free read-only multilspy probes against the current task snapshot. Positions are 1-based UTF-16; failures are not clean diagnostics. Legacy tools remain compatibility tools; do not silently replace a failed semantic check with structural evidence.';
  if(editorBroker)input+='\nHost-authorized editor operations. Use pi_editor_execute with operationId only. File access remains separately scoped. These affect the real editor and are not sandbox-rollback protected. Never fabricate results.\nEDITOR_AUTHORIZATION_JSON='+JSON.stringify(editorBroker.catalog);
  if (task) {
    const guidanceBudget = calculateExecutionBudget({ overallTimeoutSeconds: request.timeoutSeconds, elapsedMs: performance.now() - dispatchStarted });
    const seconds = guidanceBudget.ok ? guidanceBudget.sandboxSeconds : 0;
    input += `\nExecution guidance (soft; no token cap or quality guarantee): target comfortable completion before the remaining ${seconds} sandbox seconds.`;
  }
  const executionBudget = calculateExecutionBudget({ overallTimeoutSeconds: request.timeoutSeconds, elapsedMs: performance.now() - dispatchStarted });
  if (!executionBudget.ok) return { ok:false, ...(structuredResultTool ? {resultSubmissionRequired:true} : {}), target:request.target, requestedProvider:request.provider, requestedModel:request.model, failureCode:'PI_EXECUTION_BUDGET_EXHAUSTED', failure:'No whole sandbox second remains', authentication, phaseTimings:{authenticationMs}, resourceLimits:request.resourceLimits, executionBudget };
  const sandboxResourceLimits = { ...request.resourceLimits, timeoutSeconds: executionBudget.sandboxSeconds };
  const raw = await runWslSandbox(buildPiArgs(request, 'wsl2',!!editorBroker,structuredResultTool), { cwd: request.cwd, access: request.access, input, signal, editorBroker, apiPacket, resourceLimits: sandboxResourceLimits, writeScope: task?.writeScope ?? [], readScope: task?.readScope ?? [], fixtureScope: task?.fixtureScope ?? [], gatewayInstanceId: request.gatewayInstanceId, gatewayWindowsPid: request.gatewayWindowsPid, gatewayRequestId: request.gatewayRequestId, env,onProgress:progress });
  return { ...summarize(raw, { ...request, resultSubmissionRequired: structuredResultTool }), ...(structuredResultTool ? { resultSubmissionRequired: true } : {}), authentication, phaseTimings:{authenticationMs,...raw.phaseTimings},resourceLimits: request.resourceLimits, executionBudget };
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
