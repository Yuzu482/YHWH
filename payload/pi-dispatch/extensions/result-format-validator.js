import {createHash} from 'node:crypto';

export const RESULT_PREFIX = 'KETHER_RESULT_JSON=';
export const RESULT_STATUSES = Object.freeze(['completed', 'failed', 'blocked', 'unverified']);

const HOST_EXECUTION_REASON = /(?:\bnot\s+run\b|\bunrun\b|\bnot\s+executed\b|\bunavailable\b).*(?:host|execution|command|test|build|install|check|verification)|(?:host|execution|command|test|build|install|check|verification).*(?:\bnot\s+run\b|\bunrun\b|\bnot\s+executed\b|\bunavailable\b)|host\s+(?:is\s+)?assigned\s+to\s+(?:execute|run|verify)/i;
const EXECUTION_LIMITATION = /(?:\bnot\s+available\b|\bcannot\s+execute\b|\bnot\s+executable\b|未执行|不可用|无法执行)/i;
const EXECUTION_CONTEXT = /\b(?:test|command|build|install|check|verification|execution)\b|测试|命令|构建|检查|验证/i;

function isHostExecutionReason(evidence) {
  return HOST_EXECUTION_REASON.test(evidence) ||
    (EXECUTION_LIMITATION.test(evidence) && EXECUTION_CONTEXT.test(evidence));
}
const FILE_TOOL_ERROR = /(?:\b(?:read|edit|write)\b.*\b(?:error|fail(?:ed|ure)?|reject(?:ed)?|denied)\b|\b(?:error|fail(?:ed|ure)?|reject(?:ed)?|denied)\b.*\b(?:read|edit|write)\b)/i;
const SHA256 = /^[a-f0-9]{64}$/;
const EXECUTION_LIMITATION_KEYS = ['executor', 'reason'];

function hasValidExecutionLimitation(check, value) {
  if (!Object.hasOwn(check, 'executionLimitation')) return true;
  const limitation = check.executionLimitation;
  return value.status === 'completed' && value.errors.length === 0 && check.outcome === 'unverified' &&
    limitation !== null && typeof limitation === 'object' && !Array.isArray(limitation) &&
    Object.keys(limitation).length === EXECUTION_LIMITATION_KEYS.length &&
    EXECUTION_LIMITATION_KEYS.every(key => Object.hasOwn(limitation, key)) &&
    limitation.executor === 'host' && limitation.reason === 'worker-execution-unavailable';
}
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_HOST_CHECKS = 32;

function rejectedHostVerificationCandidate() { return {eligible: false, requiredCheckNames: []}; }

function exactUniqueStrings(value, {max = 256} = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return false;
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 4096 || item.includes('\0') || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function sameStringSet(left, right) {
  return exactUniqueStrings(left) && exactUniqueStrings(right) &&
    left.length === right.length && [...left].sort().every((item, index) => item === [...right].sort()[index]);
}

/**
 * Qualify a worker patch only when its validated result explicitly names checks
 * that could not run in the worker environment. patchProof must be created by
 * the gateway only after trustedPatchProof succeeds; it is not task/model input.
 */
export function evaluateHostVerificationCandidate({task, access, raw, value, patchProof, forceHost = false} = {}) {
  const denied = rejectedHostVerificationCandidate();
  if (!task || task.role !== 'Chesed' || access !== 'workspace-write' ||
      typeof task.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(task.requestId)) return denied;
  if (typeof forceHost !== 'boolean' || !raw || !value || !['completed', 'unverified', 'blocked'].includes(value.status)) return denied;
  if (typeof value.result !== 'string' || !value.result.trim() || !Array.isArray(value.evidence) ||
      value.evidence.length === 0 || value.evidence.some(item => typeof item !== 'string' || !item.trim()) ||
      !exactUniqueStrings(value.changedFiles) || !Array.isArray(value.errors) ||
      value.errors.some(item => typeof item !== 'string' || !item.trim()) ||
      !Array.isArray(value.assumptions) || value.assumptions.some(item => typeof item !== 'string') ||
      !Array.isArray(value.uncertainty) || value.uncertainty.some(item => typeof item !== 'string')) return denied;

  const checks = value.deliverable?.checks;
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > MAX_HOST_CHECKS) return denied;
  const names = new Set();
  const requiredCheckNames = [];
  for (const check of checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check) ||
        !hasValidExecutionLimitation(check, value) ||
        typeof check.name !== 'string' || !check.name.trim() || check.name.length > 128 || names.has(check.name) ||
        typeof check.evidence !== 'string' || !check.evidence.trim()) return denied;
    names.add(check.name);
    if (check.outcome === 'failed' || !['passed', 'unverified'].includes(check.outcome)) return denied;
    const typedHostLimitation = Object.hasOwn(check, 'executionLimitation');
    if (forceHost) {
      if (check.outcome === 'unverified' && !typedHostLimitation && !isHostExecutionReason(check.evidence)) return denied;
      requiredCheckNames.push(check.name);
    } else if (check.outcome === 'unverified') {
      if (!typedHostLimitation && !isHostExecutionReason(check.evidence)) return denied;
      requiredCheckNames.push(check.name);
    }
  }
  if (!requiredCheckNames.length || (forceHost && requiredCheckNames.length !== checks.length) || (forceHost && value.status !== 'completed' && !checks.some(check => check.outcome === 'unverified' && isHostExecutionReason(check.evidence)))) return denied;

  const requestId = task.requestId;
  const validation = raw.patchValidation;
  if (raw.requestId !== requestId || !validation || validation.ok !== true || validation.requestId !== requestId ||
      !patchProof || patchProof.trusted !== true || patchProof.requestId !== requestId ||
      patchProof.jobId !== validation.jobId || !UUID_V4.test(validation.jobId ?? '') ||
      !SHA256.test(validation.patchSha256 ?? '') || !SHA256.test(validation.scopeSha256 ?? '') ||
      patchProof.patchSha256 !== validation.patchSha256 || patchProof.scopeSha256 !== validation.scopeSha256 ||
      !sameStringSet(patchProof.changedFiles, validation.changedFiles) ||
      !sameStringSet(value.changedFiles, validation.changedFiles) ||
      typeof raw.patch !== 'string' || !raw.patch.trim() ||
      createHash('sha256').update(raw.patch, 'utf8').digest('hex') !== validation.patchSha256) return denied;

  if (raw.exitCode !== 0 || raw.failureCode || raw.routeMismatch === true || raw.authFailure === true ||
      raw.providerFailure === true || raw.transportError === true || raw.timeout === true || raw.agentError === true ||
      raw.truncated === true || raw.outputTruncated === true || raw.textTruncated === true ||
      raw.cleanupError === true || raw.cleanup?.ok === false) return denied;
  if (typeof raw.provider !== 'string' || !raw.provider || raw.provider !== raw.requestedProvider ||
      typeof raw.model !== 'string' || !raw.model || raw.model !== raw.requestedModel ||
      (task.provider !== undefined && task.provider !== raw.requestedProvider) ||
      (task.model !== undefined && task.model !== raw.requestedModel)) return denied;

  const usesWsl = raw.osSandbox === 'wsl2-bwrap' || raw.sandbox?.backend === 'wsl2-bwrap' ||
    (typeof raw.sandbox === 'string' && /wsl/i.test(raw.sandbox));
  if (usesWsl && raw.cleanup?.ok !== true) return denied;

  const recoverableFileFailure = raw.recoverableToolFailure === true && raw.recoverableFileToolFailure === true &&
    Number.isInteger(raw.toolErrors) && raw.toolErrors > 0 && Number.isInteger(raw.unrecoveredErrors) &&
    raw.unrecoveredErrors > 0 && raw.unrecoveredFileToolErrors === raw.unrecoveredErrors &&
    Number.isInteger(raw.fileToolErrors) && raw.fileToolErrors === raw.unrecoveredFileToolErrors &&
    (!raw.failure || raw.failure === 'Tool execution failed') && !raw.failureCode;
  if (raw.ok !== true && !recoverableFileFailure) return denied;
  if (raw.failure && !(recoverableFileFailure && raw.failure === 'Tool execution failed')) return denied;
  if (value.errors.length > 0) {
    if (!recoverableFileFailure || value.errors.length !== raw.unrecoveredFileToolErrors ||
        value.errors.some(error => typeof error !== 'string' || !FILE_TOOL_ERROR.test(error))) return denied;
  }

  return {eligible: true, requiredCheckNames};
}

const MAX_RESULT_BYTES = 512 * 1024;
const MAX_DEPTH = 12;
const MAX_NODES = 4096;
const MAX_STRING_LENGTH = 256 * 1024;

function invalid(code, message, expectedFields) {
  return { ok: false, code, message, expectedFields: [...expectedFields] };
}

function validateShape(value, expectedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('root_not_object', 'result payload must be a JSON object', expectedFields);
  const actual = Object.keys(value);
  const missing = expectedFields.filter(field => !Object.hasOwn(value, field));
  const extra = actual.filter(field => !expectedFields.includes(field));
  if (missing.length || extra.length || actual.length !== expectedFields.length) {
    return invalid('field_mismatch', `result fields must match returnFields exactly; missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`, expectedFields);
  }
  if (Object.hasOwn(value, 'status') && !RESULT_STATUSES.includes(value.status)) {
    return invalid('invalid_status', `status must be one of ${RESULT_STATUSES.join(', ')}`, expectedFields);
  }
  let nodes = 0;
  const visit = (node, depth) => {
    nodes++;
    if (nodes > MAX_NODES) throw new Error(`result exceeds ${MAX_NODES} JSON nodes`);
    if (depth > MAX_DEPTH) throw new Error(`result exceeds maximum depth ${MAX_DEPTH}`);
    if (typeof node === 'string' && node.length > MAX_STRING_LENGTH) throw new Error(`result string exceeds ${MAX_STRING_LENGTH} characters`);
    if (Array.isArray(node)) for (const item of node) visit(item, depth + 1);
    else if (node && typeof node === 'object') for (const item of Object.values(node)) visit(item, depth + 1);
  };
  try { visit(value, 0); } catch (error) { return invalid('complexity_limit', error.message, expectedFields); }
  return { ok: true, code: 'valid', expectedFields: [...expectedFields], value };
}

export function validateKetherResult(text, expectedFields) {
  if (!Array.isArray(expectedFields) || expectedFields.length === 0) throw new Error('expectedFields must be a non-empty array');
  if (typeof text !== 'string' || !text.trim()) return invalid('empty_output', 'agent output is empty', expectedFields);
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_RESULT_BYTES) return invalid('result_too_large', `formatted result exceeds ${MAX_RESULT_BYTES} bytes`, expectedFields);
  if (!trimmed.startsWith(RESULT_PREFIX)) return invalid('missing_prefix', `agent output must start with ${RESULT_PREFIX}`, expectedFields);
  const payload = trimmed.slice(RESULT_PREFIX.length);
  let value;
  try { value = JSON.parse(payload); } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const offsetMatch = message.match(/\bposition (\d+)\b/i);
    const offset = offsetMatch ? Number(offsetMatch[1]) : null;
    let category = 'syntax_error/unknown';
    if (offset !== null && offset >= payload.length) category = 'incomplete';
    else if (/unexpected end|unterminated|end of JSON input/i.test(message)) category = 'incomplete';
    else if (offset !== null && /unexpected non-whitespace character/i.test(message)) category = 'trailing_data';
    return {
      ...invalid('invalid_json', 'result payload is not valid JSON', expectedFields),
      diagnostic: { category, categoryIsHeuristic: true, payloadLength: payload.length, parseErrorOffset: offset },
    };
  }
  return validateShape(value, expectedFields);
}

export function recoverPrefacedKetherResult(text, expectedFields) {
  if (typeof text !== 'string' || !text) return null;
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) return null;
  const newline = text.indexOf('\n');
  if (newline === -1) return null;
  let preface = text.slice(0, newline);
  if (preface.endsWith('\r')) preface = preface.slice(0, -1);
  if (!preface || Buffer.byteLength(preface, 'utf8') > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(preface)) return null;
  const envelope = text.slice(newline + 1);
  if (!envelope.startsWith(RESULT_PREFIX)) return null;
  if (text.indexOf(RESULT_PREFIX) !== text.lastIndexOf(RESULT_PREFIX)) return null;
  let validation;
  try { validation = validateKetherResult(envelope, expectedFields); } catch { return null; }
  if (!validation.ok) return null;
  return { canonicalText: RESULT_PREFIX + JSON.stringify(validation.value), validation };
}

export function publicFormatValidation(value) {
  const result = { ok: value.ok, code: value.code, message: value.message, expectedFields: value.expectedFields };
  if (value.code === 'invalid_json' && value.diagnostic) result.diagnostic = { ...value.diagnostic };
  return result;
}
