import { configuredRoute, loadProviderConfig } from './controlled-provider.mjs';

export const WORKER_ENFORCEMENT_INVALID = 'YHWH_WORKER_ENFORCEMENT_INVALID';
export const WORKER_ENFORCEMENT_REJECTED = 'YHWH_WORKER_ENFORCEMENT_REJECTED';
export const WORKER_ENFORCEMENT_HEADLESS_BLOCKED = 'YHWH_WORKER_ENFORCEMENT_HEADLESS_BLOCKED';
export const WORKER_ENFORCEMENT_SCOPE = 'YHWH-managed execution only; external host tools not isolated';
const RESTART_GUIDANCE = 'Restart the gateway/worker host after changing YHWH_WORKER_ENFORCEMENT.';

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

export function getWorkerEnforcementStatus(env = process.env) {
  const configured = env.YHWH_WORKER_ENFORCEMENT;
  const mode = configured === undefined ? 'strict' : configured;
  if (mode !== 'strict' && mode !== 'off') fail(WORKER_ENFORCEMENT_INVALID);
  return { mode, enabled: mode === 'strict', scope: WORKER_ENFORCEMENT_SCOPE, hostRestartGuidance: RESTART_GUIDANCE };
}

export function isReviewerRoute(provider, model, config) {
  if (provider === 'anthropic') return model === 'claude-sonnet-5';
  if (provider !== 'yhwh-reviewer-api') return false;
  const route = configuredRoute(provider, config ?? loadProviderConfig());
  return route?.semanticModel === 'claude-sonnet-5' && route.model === model;
}

function isWorkerRoute(provider, model, config) {
  if (provider === 'openai-codex') return model === 'gpt-6-luna';
  if (provider !== 'yhwh-worker-api') return false;
  const route = configuredRoute(provider, config ?? loadProviderConfig());
  return route?.semanticModel === 'gpt-5.6-luna' && route.model === model;
}

function isGatewayProbeTask(task, token) {
  return typeof token === 'string' && /^PI_GATEWAY_OK_[A-Z0-9]+$/.test(token) && task &&
    task.role === 'Netzach' &&
    task.objective === `Return exactly ${token} and nothing else.` &&
    Array.isArray(task.forbidden) && task.forbidden.length === 2 &&
    task.forbidden[0] === 'Do not call tools' && task.forbidden[1] === 'Do not modify files' &&
    Array.isArray(task.acceptance) && task.acceptance.length === 1 && task.acceptance[0] === `Response contains ${token}`;
}

export function enforceWorkerExecution({ provider, model, access = 'none', reviewerValidated = false, probe = false, probeToken, probeApproved = false, task } = {}) {
  const status = getWorkerEnforcementStatus();
  if (!status.enabled) return status;
  if (probe) {
    if (access === 'none' && probeApproved && isGatewayProbeTask(task, probeToken)) return status;
    fail(WORKER_ENFORCEMENT_REJECTED);
  }
  if (isWorkerRoute(provider, model)) return status;
  if (access === 'none' && reviewerValidated && isReviewerRoute(provider, model)) return status;
  fail(WORKER_ENFORCEMENT_REJECTED);
}

export function assertHeadlessExecutionAllowed(env = process.env) {
  const status = getWorkerEnforcementStatus(env);
  if (status.enabled) fail(WORKER_ENFORCEMENT_HEADLESS_BLOCKED, 'worker_enforcement_headless_blocked');
  return status;
}

export function editorRouteAllowed(provider, model) {
  return provider === 'openai-codex' && model === 'gpt-6-luna';
}
