import {createHash} from 'node:crypto';
import {sanitizeResult} from './result-export.js';

const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_COMMANDS = 32;
const MAX_COMMAND = 2048;
const MAX_OUTPUT = 4096;
const MAX_NAME = 128;

export class HostVerificationError extends Error {
  constructor(code, message = code) { super(message); this.name = 'HostVerificationError'; this.code = code; }
}
const fail = code => { throw new HostVerificationError(code); };
function boundedString(value, max, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0') || value.trim().length === 0) fail(code);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(sanitizeResult(value)))).digest('hex'); }

/** Canonical SHA-256 for sanitized JSON; shared ownership for pending, attestation and reference digests. */
export function hostRecordDigest(value) { return digest(value); }

/** Validate and freeze pending binding. requiredCheckNames are the exact explicitly-unrun host checks. */
export function createHostPending(input) {
  const requiredFields = ['requestId','artifactSha256','resultSha256','workspace','parentRunId','goal','phase','requiredCheckNames'];
  const allowedFields = [...requiredFields, 'contractTemplateSha256'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowedFields.includes(k)) || requiredFields.some(k => !Object.hasOwn(input, k))) fail('invalid_pending');
  if (!ID.test(input.requestId) || !HEX.test(input.artifactSha256) || !HEX.test(input.resultSha256)) fail('invalid_binding');
  boundedString(input.workspace, 4096, 'invalid_binding');
  if (input.parentRunId !== null) boundedString(input.parentRunId, 128, 'invalid_binding');
  boundedString(input.goal, 20000, 'invalid_binding');
  if (!Number.isSafeInteger(input.phase) || input.phase < 1) fail('invalid_binding');
  const names = input.requiredCheckNames;
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_COMMANDS) fail('invalid_required_checks');
  const seen = new Set();
  const requiredCheckNames = names.map(name => boundedString(name, MAX_NAME, 'invalid_check_name'));
  for (const name of requiredCheckNames) { if (seen.has(name)) fail('duplicate_check_name'); seen.add(name); }
  if (Object.hasOwn(input, 'contractTemplateSha256') && !HEX.test(input.contractTemplateSha256 ?? '')) fail('invalid_binding');
  const body = sanitizeResult({version: 1, requestId: input.requestId, artifactSha256: input.artifactSha256, resultSha256: input.resultSha256, workspace: input.workspace, parentRunId: input.parentRunId, goal: input.goal, phase: input.phase, requiredCheckNames, ...(input.contractTemplateSha256 ? {contractTemplateSha256:input.contractTemplateSha256} : {})});
  return Object.freeze({...body, pendingSha256: hostRecordDigest(body)});
}

/** Validate strict host facts, derive whole-record outcome, and bind to the immutable pending record. */
export function createHostAttestation(pending, submission, {timestamp} = {}) {
  if (!verifyHostPending(pending)) fail('tampered_pending');
  const fields = ['requestId','artifactSha256','commands'];
  if (!submission || typeof submission !== 'object' || Array.isArray(submission) || Object.keys(submission).some(k => !fields.includes(k)) || fields.some(k => !Object.hasOwn(submission, k))) fail('invalid_submission');
  if (submission.requestId !== pending.requestId || submission.artifactSha256 !== pending.artifactSha256) fail('binding_mismatch');
  const commands = submission.commands;
  if (!Array.isArray(commands) || commands.length !== pending.requiredCheckNames.length) fail('incomplete_checks');
  const byName = new Map();
  for (const item of commands) {
    const keys = ['checkName','command','exitCode','outputSummary'];
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(item, k))) fail('invalid_command_record');
    const checkName = boundedString(item.checkName, MAX_NAME, 'invalid_check_name');
    if (!pending.requiredCheckNames.includes(checkName) || byName.has(checkName)) fail('unknown_or_duplicate_check');
    boundedString(item.command, MAX_COMMAND, 'invalid_command');
    if (!Number.isInteger(item.exitCode) || item.exitCode < -2147483648 || item.exitCode > 4294967295) fail('invalid_exit_code');
    boundedString(item.outputSummary, MAX_OUTPUT, 'invalid_output_summary');
    byName.set(checkName, {checkName, command: item.command, exitCode: item.exitCode, outputSummary: item.outputSummary});
  }
  const ordered = pending.requiredCheckNames.map(name => { if (!byName.has(name)) fail('incomplete_checks'); return byName.get(name); });
  if (timestamp !== undefined && (!Number.isFinite(timestamp) || timestamp < 0)) fail('invalid_timestamp');
  const body = sanitizeResult({version: 1, requestId: pending.requestId, artifactSha256: pending.artifactSha256, resultSha256: pending.resultSha256, workspace: pending.workspace, parentRunId: pending.parentRunId, goal: pending.goal, phase: pending.phase, pendingSha256: pending.pendingSha256, commands: ordered, outcome: ordered.every(c => c.exitCode === 0) ? 'completed' : 'failed', ...(timestamp === undefined ? {} : {timestamp})});
  return Object.freeze({...body, recordSha256: hostRecordDigest(body)});
}

/** Integrity check for immutable pending documents. */
export function verifyHostPending(value) {
  if (!value || typeof value !== 'object' || !HEX.test(value.pendingSha256 ?? '')) return false;
  const {pendingSha256, ...body} = value;
  try { return hostRecordDigest(body) === pendingSha256 && createHostPending({requestId:body.requestId, artifactSha256:body.artifactSha256, resultSha256:body.resultSha256, workspace:body.workspace, parentRunId:body.parentRunId, goal:body.goal, phase:body.phase, requiredCheckNames:body.requiredCheckNames, ...(body.contractTemplateSha256?{contractTemplateSha256:body.contractTemplateSha256}:{})}).pendingSha256 === pendingSha256; } catch { return false; }
}

/** Integrity/binding check; whole-record outcome is authoritative, never an individual command. */
export function verifyHostAttestation(value, pending) {
  if (!verifyHostPending(pending) || !value || typeof value !== 'object' || !HEX.test(value.recordSha256 ?? '')) return false;
  const {recordSha256, ...body} = value;
  if (hostRecordDigest(body) !== recordSha256 || body.pendingSha256 !== pending.pendingSha256 || body.requestId !== pending.requestId || body.artifactSha256 !== pending.artifactSha256 || body.resultSha256 !== pending.resultSha256) return false;
  try {
    const rebuilt = createHostAttestation(pending, {requestId: body.requestId, artifactSha256: body.artifactSha256, commands: body.commands}, {timestamp: body.timestamp});
    return rebuilt.recordSha256 === recordSha256 && rebuilt.outcome === body.outcome;
  } catch { return false; }
}

/** Idempotency helper: compare normalized submitted facts, excluding server timestamp. */
export function hostSubmissionDigest(submission) { return hostRecordDigest(submission); }

/* Consumer API contract for next ledger batch:
 * registerHostPending(pending) -> immutable pending; parentRunId may be null for standalone writes,
 * goal is 1..20000 chars, workspace 1..4096 chars, phase is a positive safe-integer phaseIndex;
 * identical digest is idempotent, conflicts reject. Submission command-array order is significant
 * for idempotency (attestations themselves are reordered to requiredCheckNames).
 * recordHostVerification({requestId, artifactSha256, commands:[{checkName,command,exitCode,outputSummary}]}) -> attestation;
 * getHostVerification({requestId, artifactSha256, recordSha256}) -> verified record or null;
 * getEffectiveResult(requestId) / listHostPending({limit}) -> bounded ledger projections.
 * Pending should project as awaiting-host-verification, remain dependency-ineligible; only a
 * whole-record completed attestation permits completion. This module performs no I/O or execution.
 */
