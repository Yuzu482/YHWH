import {API_PROVIDERS} from '../controlled-provider.mjs';
import {normalizeScopedPath} from '../../extensions/write-scope-guard.js';


const FILE_TOOLS = new Set(['read', 'edit', 'write']);

// Correlate only unambiguous runtime start/end pairs. Arguments and paths never leave this helper.
export function accountRuntimeToolErrors(events) {
  const starts = new Map(), ends = new Map(), ambiguous = new Set();
  const errorEnds = events.filter(event => event?.type === 'tool_end' && event.isError === true);
  for (const event of events) {
    if (!['tool_start', 'tool_end'].includes(event?.type)) continue;
    const id = event.callId;
    if (typeof id !== 'string' || !id) continue;
    const map = event.type === 'tool_start' ? starts : ends;
    if (map.has(id)) ambiguous.add(id); else map.set(id, event);
  }
  const recoverable = [];
  for (const failedEnd of errorEnds) {
    const id = failedEnd.callId;
    const start = typeof id === 'string' ? starts.get(id) : null;
    if (!id || ambiguous.has(id) || ends.get(id) !== failedEnd || !start || events.indexOf(start) >= events.indexOf(failedEnd) || start.name !== failedEnd.name || !FILE_TOOLS.has(start.name)) {
      recoverable.push(null); continue;
    }
    let target;
    try { target = normalizeScopedPath(start.path).path; } catch { recoverable.push(null); continue; }
    recoverable.push({ id, name: start.name, target, end: failedEnd });
  }
  const recovered = new Set();
  for (let i = 0; i < recoverable.length; i++) {
    const failed = recoverable[i];
    if (!failed) continue;
    for (const [id, end] of ends) {
      const start = starts.get(id);
      if (ambiguous.has(id) || id === failed.id || !start || events.indexOf(start) >= events.indexOf(end) || start.name !== failed.name || end.name !== failed.name || end.isError !== false || !FILE_TOOLS.has(start.name)) continue;
      let target;
      try { target = normalizeScopedPath(start.path).path; } catch { continue; }
      if (events.indexOf(start) > events.indexOf(failed.end) && events.indexOf(end) > events.indexOf(failed.end) && target === failed.target) { recovered.add(i); break; }
    }
  }
  const fileToolErrors = recoverable.filter(Boolean).length;
  const recoveredFileToolErrors = recoverable.reduce((count, item, index) => count + (item && recovered.has(index) ? 1 : 0), 0);
  return {
    total: errorEnds.length,
    recoveredErrors: recovered.size,
    unrecoveredErrors: errorEnds.length - recovered.size,
    fileToolErrors,
    unrecoveredFileToolErrors: fileToolErrors - recoveredFileToolErrors,
  };
}
function canonicalResultJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalResultJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalResultJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function resultSubmissionFrom(events) {
  const matching = events.filter(event => event.type === 'result_submission');
  const successes = matching.filter(event => event.kind !== 'role-schema-rejection');
  const rejections = matching.filter(event => event.kind === 'role-schema-rejection' && event.validRejection === true);
  if (matching.length !== successes.length + rejections.length) return { ok: false, code: 'RESULT_SUBMISSION_MALFORMED' };
  if (successes.length !== 1) return { ok: false, code: successes.length ? 'RESULT_SUBMISSION_MULTIPLE' : 'RESULT_SUBMISSION_MISSING' };
  const matchingSuccess = successes[0];
  const canonicalText = matchingSuccess.canonicalText;
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

export function summarizeRuntimeResult(raw, request, events = []) {
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
  const messages = events.filter(event => event.type === 'message_end' && event.role === 'assistant');
  const last = messages.at(-1);
  const errors = messages.filter(message => ['error', 'aborted'].includes(message.stopReason)).map(message => message.errorMessage || message.stopReason);
  const toolRecovery = accountRuntimeToolErrors(events);
  const toolErrors = toolRecovery.total;
  const toolsUsed = events.filter(event => event.type === 'tool_start').map(event => event.name);
  const complete = events.some(event => event.type === 'end');
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

