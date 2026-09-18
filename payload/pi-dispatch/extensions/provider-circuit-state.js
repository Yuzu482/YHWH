import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { summarizeUsage } from './audit-log.js';

const DEFAULTS = Object.freeze({
  failureThreshold: 3,
  failureCooldownMs: 5 * 60 * 1000,
  rateLimitCooldownMs: 60 * 1000,
  halfOpenLeaseMs: 2 * 60 * 1000,
});

function routeKey(provider, model) { return `${provider}/${model}`; }
function iso(ms) { return new Date(ms).toISOString(); }
function time(value) { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : 0; }

function retryAfterMs(detail, result) {
  if (Number.isFinite(result?.retryAfterMs) && result.retryAfterMs > 0) return result.retryAfterMs;
  const match = detail.match(/retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)?/i)
    ?? detail.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit.startsWith('m') && unit !== 'ms' && !unit.startsWith('millisecond')) return Math.round(value * 60_000);
  if (unit === 'ms' || unit.startsWith('millisecond')) return Math.round(value);
  return Math.round(value * 1000);
}

export function classifyProviderResult(result, error = null) {
  if (/^PI_AUTH_(MISSING|INVALID|EXPIRED|INELIGIBLE|RELOGIN_REQUIRED)$/.test(result?.failureCode??''))return {healthy:false,category:'authentication',impact:true};
  if(result?.failureCode==='PI_CREDENTIAL_PREPARE_FAILED')return {healthy:false,category:'local_setup',impact:false};
  if(/^PI_AUTH_(?:RENEW_|LOCK_|CLI_|HOME_)/.test(result?.failureCode??''))return {healthy:false,category:'authentication_maintenance',impact:false};
  const detail = `${error?.message || ''} ${result?.failure || ''} ${result?.diagnostics || ''}`.toLowerCase();
  if (/model.{0,200}(not supported|not available|does not exist|not found)|unsupported model|model_not_found/.test(detail)) return { healthy: false, category: 'model_unavailable', impact: true };
  if (/authentication|unauthori[sz]ed|\b401\b|\b403\b|token.{0,24}(expired|invalid)|login required|provider is not configured|api.?key.{0,24}(missing|invalid|required)/.test(detail)) return { healthy: false, category: 'authentication', impact: true };
  if (/sigabrt|bun has crashed|panic\(main thread\)/.test(detail)) return { healthy: false, category: 'runtime_crash', impact: true };
  if (/cancelled|canceled|abort/.test(detail)) return { healthy: false, category: 'cancelled', impact: false };
  if (/rate.?limit|too many requests|\b429\b|quota/.test(detail)) return { healthy: false, category: 'rate_limit', impact: true, retryAfterMs: retryAfterMs(detail, result) };
  if (/timeout|timed out/.test(detail)) return { healthy: false, category: 'timeout', impact: true };
  if (/econnreset|econnrefused|enotfound|eai_again|network|socket|dns|tls|connection (?:closed|lost|failed)/.test(detail)) return { healthy: false, category: 'network', impact: true };
  if (/provider\/model mismatch|route mismatch/.test(detail)) return { healthy: false, category: 'route_mismatch', impact: true };
  const routeMatched = result?.provider && result?.model
    && result.provider === result.requestedProvider && result.model === result.requestedModel;
  if (routeMatched && !error && (!result?.failure || result?.toolErrors > 0)) return { healthy: true, category: 'provider_reachable', impact: true };
  if (error || result?.failure) return { healthy: false, category: 'provider_failure', impact: true };
  return { healthy: false, category: 'not_assessed', impact: false };
}

function validEvent(value) {
  return value && value.version === 1 && typeof value.type === 'string' && typeof value.timestamp === 'string'
    && typeof value.provider === 'string' && typeof value.model === 'string';
}

function deriveState(events, provider, model, now, settings) {
  const routeEvents = events.filter(event => event.provider === provider && event.model === model);
  const outcomes = routeEvents.filter(event => event.type === 'outcome');
  let consecutiveFailures = 0;
  for (let index = outcomes.length - 1; index >= 0; index--) {
    if (outcomes[index].healthy) break;
    consecutiveFailures++;
  }
  const trailing = consecutiveFailures ? outcomes.slice(-consecutiveFailures) : [];
  const last = outcomes.at(-1);
  const authentication = trailing.findLast(event => event.category === 'authentication');
  const unavailable = trailing.findLast(event => event.category === 'model_unavailable');
  const rateLimit = trailing.findLast(event => event.category === 'rate_limit');
  let state = 'closed';
  let reason = null;
  let retryAtMs = 0;
  if (unavailable) {
    state = 'open';
    reason = 'model_unavailable';
  } else if (authentication) {
    state = 'open';
    reason = 'authentication';
  } else if (rateLimit) {
    reason = 'rate_limit';
    retryAtMs = time(rateLimit.retryAt) || time(rateLimit.timestamp) + settings.rateLimitCooldownMs;
    state = now < retryAtMs ? 'open' : 'half-open';
  } else if (consecutiveFailures >= settings.failureThreshold && last) {
    reason = 'consecutive_infrastructure_failures';
    retryAtMs = time(last.timestamp) + settings.failureCooldownMs;
    state = now < retryAtMs ? 'open' : 'half-open';
  }
  const latestControl = [...routeEvents].reverse().find(event => ['probe_lease', 'probe_cancel', 'outcome'].includes(event.type));
  const probeInFlight = latestControl?.type === 'probe_lease' && time(latestControl.expiresAt) > now;
  if (probeInFlight) state = 'half-open';
  const lastProbe = outcomes.findLast(event => event.probe === true);
  return {
    route: routeKey(provider, model), state, reason, consecutiveFailures,
    retryAt: retryAtMs ? iso(retryAtMs) : null,
    probeInFlight,
    canAttemptTask: state === 'closed',
    canProbe: state === 'closed' || (state === 'half-open' && !probeInFlight),
    canRecoveryProbe: !probeInFlight && (state === 'half-open' || reason === 'authentication' || reason === 'model_unavailable'),
    recoveryProbeRequired: reason === 'authentication' || reason === 'model_unavailable',
    lastCheckedAt: last?.timestamp ?? null,
    lastSuccessAt: outcomes.findLast(event => event.healthy)?.timestamp ?? null,
    lastProbe: lastProbe ? {
      checkedAt: lastProbe.timestamp, infrastructureHealthy: lastProbe.healthy, category: lastProbe.category,
      heartbeatPassed: lastProbe.heartbeatPassed, actualProvider: lastProbe.actualProvider,
      actualModel: lastProbe.actualModel, durationMs: lastProbe.durationMs, tokens: lastProbe.tokens,
    } : null,
  };
}

function makeStore({ filePath = null, clock = Date.now, ...overrides } = {}) {
  const settings = { ...DEFAULTS, ...overrides };
  let memory = [];
  let fd = null;
  let absolute = null;
  if (filePath) {
    absolute = resolve(filePath);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    fd = openSync(absolute, 'a', 0o600);
    try { chmodSync(absolute, 0o600); } catch { /* Windows uses inherited ACLs. */ }
  }
  const readEvents = () => {
    if (!absolute || !existsSync(absolute)) return [...memory];
    const text = readFileSync(absolute, 'utf8');
    if (!text.trim()) return [];
    return text.trimEnd().split(/\r?\n/).map((line, index) => {
      let event;
      try { event = JSON.parse(line); } catch { throw new Error(`provider circuit cache contains malformed JSONL at line ${index + 1}`); }
      if (!validEvent(event)) throw new Error(`provider circuit cache contains an invalid event at line ${index + 1}`);
      return event;
    });
  };
  const append = event => {
    if (fd === null) memory.push(event);
    else { appendFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8'); fsyncSync(fd); }
  };
  const current = (provider, model) => deriveState(readEvents(), provider, model, clock(), settings);
  return {
    enabled: true,
    settings: { ...settings },
    state: current,
    snapshot() {
      const events = readEvents();
      const routes = [...new Set(events.map(event => routeKey(event.provider, event.model)))];
      return Object.fromEntries(routes.map(key => {
        const split = key.indexOf('/');
        return [key, deriveState(events, key.slice(0, split), key.slice(split + 1), clock(), settings)];
      }));
    },
    assertTaskAllowed(provider, model) {
      const value = current(provider, model);
      if (value.state === 'closed') return value;
      const message = value.reason === 'model_unavailable' ? 'provider route is open because the model is unavailable; repair model access and request one explicit recovery probe' : value.reason === 'authentication'
        ? 'provider route is open because authentication failed; repair login and request one recovery probe'
        : value.state === 'open' ? `provider route is open until ${value.retryAt}` : 'provider route is half-open and requires a Tifereth recovery probe';
      const error = new Error(message); error.code = 'PROVIDER_CIRCUIT_OPEN'; error.providerCircuit = value; throw error;
    },
    beginProbe(provider, model, { recovery = false } = {}) {
      const value = current(provider, model);
      if (value.probeInFlight) throw new Error('a provider recovery probe is already in flight');
      if (value.state === 'open' && !['authentication','model_unavailable'].includes(value.reason)) throw new Error(`provider route is cooling down until ${value.retryAt}`);
      if (value.reason === 'model_unavailable' && !recovery) throw new Error('model availability recovery probe requires explicit recovery=true after access repair');
      if (value.reason === 'authentication' && !recovery) throw new Error('authentication recovery probe requires explicit recovery=true after login repair');
      if (value.state === 'closed') return null;
      const leaseId = randomUUID();
      append({ version: 1, type: 'probe_lease', timestamp: iso(clock()), provider, model, leaseId, expiresAt: iso(clock() + settings.halfOpenLeaseMs) });
      return leaseId;
    },
    cancelProbe(provider, model, leaseId) {
      if (leaseId) append({ version: 1, type: 'probe_cancel', timestamp: iso(clock()), provider, model, leaseId });
      return current(provider, model);
    },
    record({ provider, model, healthy, category, probe = false, heartbeatPassed, actualProvider, actualModel, durationMs = 0, usage, retryAfterMs: retryDelay }) {
      const now = clock();
      append({
        version: 1, type: 'outcome', timestamp: iso(now), provider, model,
        healthy: healthy === true, category, probe: probe === true,
        heartbeatPassed: heartbeatPassed === true, actualProvider, actualModel,
        durationMs: Math.max(0, Math.round(Number(durationMs) || 0)), tokens: summarizeUsage(usage),
        retryAt: category === 'rate_limit' ? iso(now + (Number.isFinite(retryDelay) && retryDelay > 0 ? retryDelay : settings.rateLimitCooldownMs)) : undefined,
      });
      return current(provider, model);
    },
    close() { if (fd !== null) { closeSync(fd); fd = null; } },
  };
}

export function createProviderCircuitState(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('providerCircuitFile must be a non-empty path');
  return makeStore({ ...options, filePath });
}

export function createMemoryProviderCircuitState(options = {}) { return makeStore(options); }
