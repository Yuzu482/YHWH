import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const AUDIT_VERSION = 1;
const MAX_FAILURE_LENGTH = 1000;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function ensureRequestId(value) {
  return value || `req-${randomUUID()}`;
}

export function redactSensitiveText(value, { compact = true } = {}) {
  if (value === undefined || value === null) return null;
  const redacted = String(value)
    .replace(/("(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|sess|pat|ghp|glpat)-[A-Za-z0-9._-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    // Start once per scheme-character run, not once per letter in long output.
    // Preserve numeric/punctuation prefixes that the old search skipped over.
    .replace(/(?<![a-z0-9+.-])([0-9+.-]*[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  return compact ? redacted.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_FAILURE_LENGTH) : redacted;
}

export function summarizeTaskEnvelope(task) {
  if (!task) return { present: false };
  const serialized = stableJson(task);
  const listCounts = {};
  for (const key of ['context', 'readScope', 'writeScope', 'forbidden', 'dependencies', 'acceptance', 'returnFields', 'assumptions']) {
    listCounts[key] = Array.isArray(task[key]) ? task[key].length : 0;
  }
  return {
    present: true,
    contractVersion:task.contractVersion,
    handoff:task.handoff?{stage:task.handoff.stage,inputCount:task.handoff.inputs.length}:undefined,
    sha256: sha256(serialized),
    bytes: Buffer.byteLength(serialized),
    role: /^[A-Za-z][A-Za-z0-9._ -]{0,63}$/.test(task.role || '') ? task.role : 'unknown',
    objectiveBytes: Buffer.byteLength(String(task.objective || '')),
    listCounts,
    ...(task.reviewPacket?{reviewPacket:{sha256:sha256(stableJson(task.reviewPacket)),bytes:Buffer.byteLength(stableJson(task.reviewPacket)),stage:task.reviewPacket.stage}}:{}),
  };
}

export function summarizePatch(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return { present: false, bytes: 0, fileCount: 0, additions: 0, deletions: 0 };
  const pathHashes = new Set();
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const path = line.slice(4).split('\t', 1)[0];
      if (path !== '/dev/null') pathHashes.add(sha256(path.replace(/^[ab]\//, '')));
    } else if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return {
    present: true,
    sha256: sha256(patch),
    bytes: Buffer.byteLength(patch),
    fileCount: pathHashes.size,
    pathHashes: [...pathHashes].sort(),
    additions,
    deletions,
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return { available: false };
  const inputTokens = finiteNumber(usage.inputTokens ?? usage.input);
  const outputTokens = finiteNumber(usage.outputTokens ?? usage.output);
  const cacheReadTokens = finiteNumber(usage.cacheReadTokens ?? usage.cacheRead);
  const cacheWriteTokens = finiteNumber(usage.cacheWriteTokens ?? usage.cacheWrite);
  const totalTokens = finiteNumber(usage.totalTokens) ?? (
    inputTokens !== undefined || outputTokens !== undefined || cacheReadTokens !== undefined || cacheWriteTokens !== undefined
      ? (inputTokens || 0) + (outputTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0)
      : undefined
  );
  if (totalTokens === undefined) return { available: false };
  return { available: true, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

function summarizeTools(result) {
  const counts = {};
  for (const name of Array.isArray(result?.toolsUsed) ? result.toolsUsed : []) {
    if (typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(name)) counts[name] = (counts[name] || 0) + 1;
  }
  return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), errors: finiteNumber(result?.toolErrors) || 0,
    recoveredErrors: finiteNumber(result?.recoveredErrors) || 0, unrecoveredErrors: finiteNumber(result?.unrecoveredErrors) ?? finiteNumber(result?.toolErrors) ?? 0 };
}

function summarizeFormatDiagnostic(validation) {
  if (validation?.code !== 'invalid_json') return undefined;
  const diagnostic = validation.diagnostic;
  if (!diagnostic || typeof diagnostic !== 'object') return undefined;
  const categories = new Set(['incomplete', 'trailing_data', 'syntax_error/unknown']);
  const payloadLength = finiteNumber(diagnostic.payloadLength);
  if (!categories.has(diagnostic.category) || typeof diagnostic.categoryIsHeuristic !== 'boolean'
      || !Number.isInteger(payloadLength) || payloadLength > 524288) return undefined;
  const summary = {
    code: 'invalid_json',
    category: diagnostic.category,
    categoryIsHeuristic: diagnostic.categoryIsHeuristic,
    payloadLength,
  };
  const offset = diagnostic.parseErrorOffset;
  if (Number.isInteger(offset) && offset >= 0 && offset <= payloadLength) summary.parseErrorOffset = offset;
  return summary;
}

function summarizeHostVerification(value) {
  if (!value || typeof value !== 'object') return undefined;
  const artifactSha256 = /^[a-f0-9]{64}$/.test(value.artifactSha256 ?? '') ? value.artifactSha256 : undefined;
  const recordSha256 = /^[a-f0-9]{64}$/.test(value.recordSha256 ?? '') ? value.recordSha256 : undefined;
  const checks = Array.isArray(value.checks) ? value.checks : Array.isArray(value.requiredCheckNames) ? value.requiredCheckNames : null;
  return {
    ...(typeof value.state === 'string' ? {state:value.state} : {}),
    ...(typeof value.outcome === 'string' ? {outcome:value.outcome} : {}),
    ...(artifactSha256 ? {artifactSha256} : {}),
    ...(recordSha256 ? {recordSha256} : {}),
    ...(checks ? {checkCount:checks.length, ...(Array.isArray(value.checks) ? {passedChecks:checks.filter(item=>item?.exitCode===0).length,failedChecks:checks.filter(item=>item?.exitCode!==0).length} : {})} : {}),
  };
}

function summarizeRuntimePreflight(value) {
  // Audit admission is intentionally independent of untrusted messages and counters.
  const warnings=Array.isArray(value?.warnings)?value.warnings:[];
  const codes=['script_without_real_run','output_without_parent_path','mixed_layers','missing_interface_contract','task_scope_broad','acceptance_not_observable','verification_owner_unspecified','invalid_complexity_assessment'].filter(code=>warnings.some(item=>item?.code===code));
  return {advisory:true,codes,counts:Object.fromEntries(codes.map(code=>[code,1]))};
}

const TIERS = new Set(['T0', 'T1', 'T2']);
const PROFILES = new Set(['standard', 'personal', 'critical']);
const THINKING = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const REVIEW_STAGES = new Set(['pre-review', 'post-review']);
function safeId(value) { return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined; }
function safeSha(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined; }
function safeTime(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return value;
}
function safeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
const SEMANTIC_RISK_KEYS = ['publicApiOrProtocol', 'dependencyOrLockfile', 'securityAuthOrCredentials', 'migration', 'irreversibleOrNoRollback'];
const MODEL_EXECUTION_FORBIDDEN = new Set(['probe_model', 'lsp_request', 'record_host_verification', 'replay', 'idempotency', 'retention_cleanup', 'task_accepted']);
function summarizeVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'artifactSha256,recordSha256,source,state'
      || value.state !== 'completed' || !['host', 'netzach'].includes(value.source)
      || !safeSha(value.artifactSha256) || !safeSha(value.recordSha256)) return undefined;
  return { state: value.state, source: value.source, artifactSha256: value.artifactSha256, recordSha256: value.recordSha256 };
}
function summarizeTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of ['parentRunId', 'implementationRequestIds']) {
    if (key === 'implementationRequestIds' && Array.isArray(value[key]) && value[key].length <= 32) {
      const ids = value[key].map(safeId);
      if (ids.every(Boolean)) out[key] = [...new Set(ids)];
    } else if (key === 'parentRunId') { const id = safeId(value[key]); if (id) out[key] = id; }
  }
  for (const key of ['workspaceSha256', 'runAnchorSha256']) { const hash = safeSha(value[key]); if (hash) out[key] = hash; }
  for (const [key, allowed] of [['declaredTier', TIERS], ['derivedTier',TIERS], ['baseTier', TIERS], ['tier', TIERS], ['riskProfile', PROFILES], ['thinking', THINKING], ['reviewStage', REVIEW_STAGES]]) if (allowed.has(value[key])) out[key] = value[key];
  for (const key of ['tierOverDeclared','tierReasonInvalid']) if(typeof value[key]==='boolean')out[key]=value[key];
  if(typeof value.tierReason==='string'&&value.tierReason.length<=400)out.tierReason=redactSensitiveText(value.tierReason);
  for (const key of ['submittedAt', 'startedAt', 'completedAt', 'acceptedAt']) { const time = safeTime(value[key]); if (time) out[key] = time; }
  if ((typeof value.modelExecution === 'boolean' || value.modelExecution === null) && (value._operation === 'dispatch_subagent' || !MODEL_EXECUTION_FORBIDDEN.has(value._operation))) out.modelExecution = value.modelExecution;
  if (typeof value.conditionalApproval === 'boolean') out.conditionalApproval = value.conditionalApproval;
  if (typeof value.taskAccepted === 'boolean') out.taskAccepted = value.taskAccepted;
  if (value.semanticRisks && typeof value.semanticRisks === 'object' && !Array.isArray(value.semanticRisks)
      && Object.keys(value.semanticRisks).length === SEMANTIC_RISK_KEYS.length
      && SEMANTIC_RISK_KEYS.every(key => typeof value.semanticRisks[key] === 'boolean')
      && Object.keys(value.semanticRisks).every(key => SEMANTIC_RISK_KEYS.includes(key))) {
    out.semanticRisks = Object.fromEntries(SEMANTIC_RISK_KEYS.map(key => [key, value.semanticRisks[key]]));
  }
  const verification = summarizeVerification(value.verification);
  if (verification) out.verification = verification;
  const counts = value.counts;
  if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
    const files = safeCount(counts.files), addedLines = safeCount(counts.addedLines), deletedLines = safeCount(counts.deletedLines), estimatedLines = safeCount(counts.estimatedLines);
    if ([files, addedLines, deletedLines, estimatedLines].every(item => item !== undefined) && addedLines + deletedLines <= Number.MAX_SAFE_INTEGER && estimatedLines === addedLines + deletedLines) out.counts = { files, addedLines, deletedLines, estimatedLines };
  }
  return out;
}

export function buildAuditRecord({ timestamp = new Date().toISOString(), requestId, operation, input, task, result, durationMs, failure, telemetry }) {
  const reason = failure ?? result?.failure ?? (result?.ok === false ? 'execution failed' : null);
  const hostTelemetry = summarizeTelemetry(telemetry ? { ...telemetry, _operation: operation } : null);
  if (MODEL_EXECUTION_FORBIDDEN.has(operation)) hostTelemetry.modelExecution = false;
  const parentRunId = hostTelemetry.parentRunId ?? safeId(input?.parentRunId) ?? safeId(result?.contract?.parentRunId);
  const formatDiagnostic = summarizeFormatDiagnostic(result?.formatValidation);
  const warningCodes=['execution-limitation-invalid'];
  const suppliedWarnings=Array.isArray(result?.roleValidation?.warnings)?result.roleValidation.warnings:[];
  const safeWarnings=suppliedWarnings.filter(code=>typeof code==='string'&&warningCodes.includes(code));
  const metadataWarningCodes=[...new Set(safeWarnings)];
  const metadataWarnings=metadataWarningCodes.length?{codes:metadataWarningCodes,count:safeWarnings.length}:undefined;
  const roleValidation=result?.roleValidation&&typeof result.roleValidation==='object'?{
    ...(typeof result.roleValidation.ok==='boolean'?{ok:result.roleValidation.ok}:{}),
    ...(Number.isSafeInteger(result.roleValidation.version)?{version:result.roleValidation.version}:{}),
    ...(typeof result.roleValidation.role==='string'&&/^[A-Za-z][A-Za-z0-9._ -]{0,63}$/.test(result.roleValidation.role)?{role:result.roleValidation.role}:{}),
    ...(typeof result.roleValidation.code==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(result.roleValidation.code)?{code:result.roleValidation.code}:{}),
    ...(safeWarnings.length?{warnings:safeWarnings}:{}),
  }:undefined;
  const hostVerification = summarizeHostVerification(result?.hostVerification ?? (operation==='record_host_verification' ? result : null));
  // Dispatch can return a completed operation while the task awaits host verification or has a valid review decision.
  const awaitingHost = result?.status === 'awaiting-host-verification' || result?.failure === 'awaiting-host-verification';
  const reviewDecision = result?.reviewValidation?.decision ?? result?.reviewDecision;
  const validReview = result?.reviewValidation?.ok === true && ['approve', 'request-changes', 'insufficient-materials'].includes(result.reviewValidation.decision);
  const validChangeRequest = result?.failure === 'review_changes_requested' && validReview && reviewDecision === 'request-changes';
  const operationOutcome = result?.ok === true && !reason || awaitingHost || validChangeRequest ? 'completed' : result || failure ? 'failed' : 'unknown';
  const taskState = operation === 'record_host_verification'
    ? result?.state ?? result?.status ?? result?.outcome
    : result?.status ?? result?.state ?? result?.outcome;
  const taskOutcome = awaitingHost || taskState === 'awaiting-host-verification'
    ? 'awaiting-host-verification'
    : validReview ? ({ approve: 'completed', 'request-changes': 'changes-requested', 'insufficient-materials': 'blocked' })[reviewDecision]
      : ['blocked', 'unverified'].includes(taskState) ? taskState
        : ['completed', 'failed', 'changes-requested'].includes(taskState) ? taskState
          : result?.ok === false ? 'failed' : result?.ok === true && !reason ? 'completed' : 'unknown';
  const acceptedEvent = operation === 'task_accepted' && hostTelemetry.taskAccepted === true && parentRunId
    && hostTelemetry.workspaceSha256 && hostTelemetry.runAnchorSha256 && hostTelemetry.acceptedAt
    && hostTelemetry.implementationRequestIds?.length;
  const acceptedVerification = acceptedEvent ? summarizeVerification(telemetry?.verification) : undefined;
  return {
    auditVersion: AUDIT_VERSION,
    ...(parentRunId ? { parentRunId } : {}),
    ...Object.fromEntries(Object.entries(hostTelemetry).filter(([key]) => key !== 'parentRunId' && key !== 'taskAccepted' && key !== 'acceptedAt' && key !== 'implementationRequestIds' && key !== 'verification')),
    ...(hostTelemetry.counts ? { counts: hostTelemetry.counts, files: hostTelemetry.counts.files, addedLines: hostTelemetry.counts.addedLines, deletedLines: hostTelemetry.counts.deletedLines, estimatedLines: hostTelemetry.counts.estimatedLines } : {}),
    ...(acceptedEvent ? { acceptedAt: hostTelemetry.acceptedAt, implementationRequestIds: hostTelemetry.implementationRequestIds, ...(acceptedVerification ? { verification: acceptedVerification } : {}) } : {}),
    timestamp,
    requestId: redactSensitiveText(ensureRequestId(requestId)),
    operation,
    access: input?.access,
    envelope: summarizeTaskEnvelope(task),
    ...(result?.preflight ? {preflight:summarizeRuntimePreflight(result.preflight)} : {}),
    route: {
      requestedProvider: input?.provider,
      requestedModel: input?.model,
      actualProvider: result?.provider,
      actualModel: result?.model,
    },
    phaseTimings: result?.phaseTimings,
    executionMode: result?.executionMode,
    // A configured backend is runtime evidence only after the process actually ran.
    runtime: result?.runtime ?? ((finiteNumber(result?.exitCode) !== undefined || finiteNumber(result?.phaseTimings?.processMs) > 0)
      ? result?.osSandbox ?? (operation === 'dispatch_subagent' ? result?.sandbox : undefined) : undefined),
    status: result?.status,
    lspStatus: operation==='lsp_request'?result?.status:undefined,
    failureCode: result?.failureCode,
    modelCalls: finiteNumber(result?.modelCalls),
    tools: summarizeTools(result),
    durationMs: Math.max(0, Math.round(finiteNumber(durationMs) || 0)),
    timings:result?.timings?{queueWaitMs:finiteNumber(result.timings.queueWaitMs),executionMs:finiteNumber(result.timings.executionMs)}:undefined,
    contract:result?.contract,
    ...(roleValidation?{roleValidation}:{}),
    ...(formatDiagnostic ? { formatDiagnostic } : {}),
    ...(metadataWarnings ? { metadataWarnings } : {}),
    ...(summarizeOutputLimit(result?.outputLimitObservation) ? {outputLimitObservation:summarizeOutputLimit(result.outputLimitObservation)} : {}),
    reviewDecision:result?.reviewValidation?.decision??result?.reviewDecision,
    ...(hostVerification ? {hostVerification} : {}),
    tokens: summarizeUsage(result?.usage),
    patch: summarizePatch(result?.patch),
    outcome: result?.status === 'awaiting-host-verification' ? 'awaiting-host-verification' : result?.ok === true && !reason ? 'completed' : 'failed',
    operationOutcome,
    taskOutcome,
    failureReason: reason ? redactSensitiveText(reason) : null,
  };
}

export function summarizeOutputLimit(value) {
  if(!value||!['patch','retained','wire','frame','pending','direct'].includes(value.bucket))return undefined;
  const out={bucket:value.bucket};
  for(const key of ['wireBytes','retainedBytes','patchBytes','frameBytes','pendingBytes','directBytes','limitBytes'])if(safeCount(value[key])!==undefined)out[key]=value[key];
  return out;
}

export const AUDIT_RETENTION_POLICY = Object.freeze({
  segmentBytes: 16 * 1024 * 1024,
  completedDays: 14,
  criticalDays: 90,
  totalBytes: 256 * 1024 * 1024,
  criticalTotalBytes: 256 * 1024 * 1024,
});

export function createAuditLogger(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('auditFile must be a non-empty path');
  const absolute = resolve(filePath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const policy = { ...AUDIT_RETENTION_POLICY, ...options };
  const criticalPath = `${absolute}.critical`;
  let sequence = 0;
  const openStream = path => {
    const fd = openSync(path, 'a', 0o600);
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed outside POSIX mode bits. */ }
    return { path, fd, bytes: existsSync(path) ? statSync(path).size : 0 };
  };
  let general = openStream(absolute);
  let critical = openStream(criticalPath);

  const rotatedFiles = path => {
    const prefix = `${basename(path)}.`;
    return readdirSync(dirname(path), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.startsWith(prefix) && /^\d{13}-\d+\.jsonl$/.test(entry.name.slice(prefix.length)))
      .map(entry => join(dirname(path), entry.name));
  };
  const pruneStream = (stream, maxAgeDays, maxBytes, now = Date.now()) => {
    const files = rotatedFiles(stream.path).map(path => ({ path, stat: statSync(path) })).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    let total = stream.bytes + files.reduce((sum, item) => sum + item.stat.size, 0);
    let deletedFiles = 0, deletedBytes = 0;
    for (const item of files) {
      if (now - item.stat.mtimeMs < maxAgeDays * 86_400_000 && total <= maxBytes) continue;
      unlinkSync(item.path);
      total -= item.stat.size;
      deletedFiles += 1;
      deletedBytes += item.stat.size;
    }
    return { deletedFiles, deletedBytes, retainedBytes: total };
  };
  const prune = () => {
    const completed = pruneStream(general, policy.completedDays, policy.totalBytes);
    const protectedRecords = pruneStream(critical, policy.criticalDays, policy.criticalTotalBytes);
    return { completed, protectedRecords };
  };
  const rotate = stream => {
    closeSync(stream.fd);
    const rotated = `${stream.path}.${Date.now()}-${sequence++}.jsonl`;
    renameSync(stream.path, rotated);
    return openStream(stream.path);
  };
  const append = (streamName, line) => {
    let stream = streamName === 'general' ? general : critical;
    if (stream.bytes > 0 && stream.bytes + Buffer.byteLength(line) > policy.segmentBytes) {
      stream = rotate(stream);
      if (streamName === 'general') general = stream; else critical = stream;
      prune();
    }
    appendFileSync(stream.fd, line, 'utf8');
    stream.bytes += Buffer.byteLength(line);
  };
  const startupRetention = prune();
  let closed = false;
  return {
    filePath: absolute,
    enabled: true,
    policy,
    startupRetention,
    record(value) {
      if (closed) throw new Error('audit logger is closed');
      const line = `${JSON.stringify(value)}\n`;
      append('general', line);
      if (value?.outcome === 'failed' || value?.taskOutcome === 'failed' || value?.access === 'workspace-write' || value?.operation === 'retention_cleanup') append('critical', line);
    },
    prune,
    close() {
      if (!closed) { closeSync(general.fd); closeSync(critical.fd); closed = true; }
    },
  };
}
