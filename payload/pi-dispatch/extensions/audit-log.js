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
  return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), errors: finiteNumber(result?.toolErrors) || 0 };
}

export function buildAuditRecord({ timestamp = new Date().toISOString(), requestId, operation, input, task, result, durationMs, failure }) {
  const reason = failure ?? result?.failure ?? (result?.ok === false ? 'execution failed' : null);
  return {
    auditVersion: AUDIT_VERSION,
    timestamp,
    requestId: redactSensitiveText(ensureRequestId(requestId)),
    operation,
    access: input?.access,
    envelope: summarizeTaskEnvelope(task),
    route: {
      requestedProvider: input?.provider,
      requestedModel: input?.model,
      actualProvider: result?.provider,
      actualModel: result?.model,
    },
    phaseTimings: result?.phaseTimings,
    executionMode: result?.executionMode,
    lspStatus: operation==='lsp_request'?result?.status:undefined,
    failureCode: result?.failureCode,
    modelCalls: finiteNumber(result?.modelCalls),
    tools: summarizeTools(result),
    durationMs: Math.max(0, Math.round(finiteNumber(durationMs) || 0)),
    timings:result?.timings?{queueWaitMs:finiteNumber(result.timings.queueWaitMs),executionMs:finiteNumber(result.timings.executionMs)}:undefined,
    contract:result?.contract,
    roleValidation:result?.roleValidation,
    reviewDecision:result?.reviewValidation?.decision??result?.reviewDecision,
    tokens: summarizeUsage(result?.usage),
    patch: summarizePatch(result?.patch),
    outcome: result?.ok === true && !reason ? 'completed' : 'failed',
    failureReason: reason ? redactSensitiveText(reason) : null,
  };
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
      if (value?.outcome === 'failed' || value?.access === 'workspace-write' || value?.operation === 'retention_cleanup') append('critical', line);
    },
    prune,
    close() {
      if (!closed) { closeSync(general.fd); closeSync(critical.fd); closed = true; }
    },
  };
}
