import {sanitizeResult} from './result-export.js';
import { createHash, randomUUID } from 'node:crypto';
import {validateRoleResult, resultDigest} from './role-contract.js';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { redactSensitiveText } from './audit-log.js';
import { createHostPending, createHostAttestation, verifyHostPending, verifyHostAttestation, hostRecordDigest, hostSubmissionDigest } from './host-verification.js';

export const REQUEST_LEDGER_VERSION = 1;
export const REQUEST_LEDGER_MAX_RESULT_BYTES = 32 * 1024 * 1024;
export const REQUEST_LEDGER_RETENTION_POLICY = Object.freeze({ completedDays: 14, criticalDays: 90, totalBytes: 512 * 1024 * 1024 });

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function requestDigest(operation, input) {
  const { requestId: _requestId, ...payload } = input || {};
  const canonical = JSON.stringify(canonicalize({ operation, input: payload }));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function entryKey(requestId) {
  return createHash('sha256').update(requestId, 'utf8').digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sanitizeForPersistence(value) {
  if (typeof value === 'string') return redactSensitiveText(value, { compact: false });
  if (Array.isArray(value)) return value.map(sanitizeForPersistence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential)$/i.test(key) ? '[REDACTED]' : sanitizeForPersistence(item)]));
  }
  return value;
}

function atomicWriteJson(path, value) {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body, 'utf8') > REQUEST_LEDGER_MAX_RESULT_BYTES) {
    throw new Error('request ledger result exceeds the persistent cache limit');
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { chmodSync(temp, 0o600); } catch { /* Windows ACLs are managed outside POSIX mode bits. */ }
  renameSync(temp, path);
}

export class RequestLedgerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RequestLedgerError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function createRequestLedger(directory, options = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('requestLedgerDir must be a non-empty path');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const outcomesRoot = join(root, 'outcomes');
  const hostRoot = join(root, 'host-verification');
  mkdirSync(outcomesRoot, { recursive: true, mode: 0o700 });
  mkdirSync(hostRoot, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* Windows ACLs are managed outside POSIX mode bits. */ }
  const inFlight = new Map();
  const retentionPolicy = { ...REQUEST_LEDGER_RETENTION_POLICY, ...(options.retention || {}) };

  const fileSize = path => { try { return statSync(path).size; } catch { return 0; } };
  const directorySize = path => readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const child = join(path, entry.name);
    return sum + (entry.isDirectory() ? directorySize(child) : fileSize(child));
  }, 0);
  const safeRemoveDirectory = path => {
    const absolute = resolve(path);
    if (!absolute.startsWith(`${root}${sep}`) || absolute === outcomesRoot) throw new Error('refusing to prune outside request ledger root');
    rmSync(absolute, { recursive: true, force: true });
  };

  function prune(now = Date.now()) {
    const entries = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const path = join(root, entry.name);
      const startPath = join(path, 'started.json');
      const finalPath = join(path, 'final.json');
      let record = null;
      try { record = readJson(existsSync(finalPath) ? finalPath : startPath); } catch { /* retain unreadable state as critical. */ }
      const critical = !existsSync(finalPath) || record?.state !== 'completed' || record?.result?.response?.ok === false;
      const timestamp = Date.parse(record?.completedAt || record?.startedAt || '') || statSync(path).mtimeMs;
      entries.push({ kind: 'directory', path, critical, timestamp, bytes: directorySize(path) });
    }
    for (const entry of readdirSync(outcomesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const path = join(outcomesRoot, entry.name);
      let record = null;
      try { record = readJson(path); } catch { /* retain unreadable state as critical. */ }
      entries.push({ kind: 'file', path, critical: record?.state !== 'completed', timestamp: Date.parse(record?.completedAt || '') || statSync(path).mtimeMs, bytes: fileSize(path) });
    }
    let deletedEntries = 0, deletedBytes = 0;
    const remove = item => {
      if (!existsSync(item.path)) return;
      if (item.kind === 'directory') safeRemoveDirectory(item.path); else unlinkSync(item.path);
      deletedEntries += 1; deletedBytes += item.bytes;
    };
    for (const item of entries) {
      const ageDays = (now - item.timestamp) / 86_400_000;
      if (ageDays >= (item.critical ? retentionPolicy.criticalDays : retentionPolicy.completedDays)) remove(item);
    }
    let retained = entries.filter(item => existsSync(item.path));
    let retainedBytes = retained.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of retained.filter(item => !item.critical).sort((a, b) => a.timestamp - b.timestamp)) {
      if (retainedBytes <= retentionPolicy.totalBytes) break;
      remove(item); retainedBytes -= item.bytes;
    }
    retained = entries.filter(item => existsSync(item.path));
    retainedBytes = retained.reduce((sum, item) => sum + item.bytes, 0);
    return { deletedEntries, deletedBytes, retainedEntries: retained.length, retainedBytes, capacityExceededByProtectedRecords: Math.max(0, retainedBytes - retentionPolicy.totalBytes) };
  }

  const startupRetention = prune();

  async function readExisting({ requestId, digest, key }) {
    const current = inFlight.get(key);
    if (current) {
      if (current.requestId !== requestId || current.digest !== digest) {
        throw new RequestLedgerError('idempotency_key_reused', 'requestId was already used for a different write request', { requestId, digest });
      }
      return { value: await current.promise, digest, disposition: 'replayed', source: 'in-flight' };
    }

    const entryDir = join(root, key);
    const startPath = join(entryDir, 'started.json');
    const finalPath = join(entryDir, 'final.json');
    let started = null;
    try { if (existsSync(startPath)) started = readJson(startPath); } catch { /* malformed state is handled as indeterminate below. */ }
    if (started && (started.requestId !== requestId || started.requestDigest !== digest)) {
      throw new RequestLedgerError('idempotency_key_reused', 'requestId was already used for a different write request', { requestId, digest });
    }
    if (existsSync(finalPath)) {
      let final;
      try { final = readJson(finalPath); }
      catch { throw new RequestLedgerError('idempotency_in_doubt', 'request ledger completion record is unreadable; automatic re-execution is blocked', { requestId, digest }); }
      if (final.requestId !== requestId || final.requestDigest !== digest) {
        throw new RequestLedgerError('idempotency_key_reused', 'requestId was already used for a different write request', { requestId, digest });
      }
      return { value: final.result, digest, disposition: 'replayed', source: 'persistent' };
    }
    throw new RequestLedgerError('idempotency_in_doubt', 'write request was previously started but has no durable completion record; automatic re-execution is blocked', { requestId, digest });
  }

  async function execute({ requestId, operation, input }, fn) {
    if (typeof requestId !== 'string' || !requestId) throw new Error('requestId is required for idempotent execution');
    if (typeof fn !== 'function') throw new Error('request ledger execute requires a function');
    const digest = requestDigest(operation, input);
    const key = entryKey(requestId);
    const entryDir = join(root, key);
    try {
      mkdirSync(entryDir, { mode: 0o700 });
      try { chmodSync(entryDir, 0o700); } catch { /* Windows ACLs are managed outside POSIX mode bits. */ }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return readExisting({ requestId, digest, key });
    }

    const started = {
      ledgerVersion: REQUEST_LEDGER_VERSION,
      state: 'started',
      requestId,
      operation,
      requestDigest: digest,
      ...(input?.access === 'workspace-write' && ['T0', 'T1', 'T2'].includes(input?.tier) ? { tier: input.tier } : {}),
      startedAt: new Date().toISOString(),
    };
    atomicWriteJson(join(entryDir, 'started.json'), started);
    const promise = Promise.resolve().then(fn).then(value => {
      atomicWriteJson(join(entryDir, 'final.json'), {
        ...started,
        state: 'completed',
        completedAt: new Date().toISOString(),
        result: sanitizeForPersistence(value),
      });
      return value;
    });
    inFlight.set(key, { requestId, digest, promise });
    try {
      return { value: await promise, digest, disposition: 'executed', source: 'live' };
    } finally {
      inFlight.delete(key);
    }
  }

  function recordOutcome(requestId, result) {
    if (typeof requestId !== 'string' || !requestId) return;
    const path = join(outcomesRoot, `${entryKey(requestId)}.json`);
    if (existsSync(path)) return;
    try {
      atomicWriteJson(path, {
        ledgerVersion: REQUEST_LEDGER_VERSION,
        requestId,
        state: result?.ok === true ? 'completed' : 'failed',
        ...(result?.ok===true && result.contract ? {contract:result.contract,...(result.contract.mode==='linked'?{handoffResult:sanitizeResult(result.structuredResult)}:{})}:{}),
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }

  function hostPaths(requestId) {
    const dir = join(hostRoot, entryKey(requestId));
    return {dir, pending: join(dir, 'pending.json'), original: join(dir, 'original.json'), attestation: join(dir, 'attestation.json')};
  }

  function loadHostPending(requestId) {
    const paths = hostPaths(requestId);
    if (!existsSync(paths.pending)) return null;
    try {
      const pending = readJson(paths.pending);
      return pending.requestId === requestId && verifyHostPending(pending) ? pending : null;
    } catch { return null; }
  }

  // Consumer API: registerHostPending(pending, {originalResult, contractTemplate}) stores the
  // immutable sanitized dispatch snapshot and trusted contract skeleton. recordHostVerification
  // accepts only {requestId,artifactSha256,commands:[{checkName,command,exitCode,outputSummary}]}.
  // getHostVerification(ref) requires {requestId,artifactSha256,recordSha256}; getEffectiveResult
  // is the awaiting/completed/failed projection; listHostPending({limit}) is restart visibility.
  function registerHostPending(input, {originalResult, contractTemplate} = {}) {
    if (!validHostTemplate(input, contractTemplate)) throw new RequestLedgerError('host_contract_template_invalid', 'eligible host verification requires a valid contract template');
    const templateSnapshot = sanitizeForPersistence(contractTemplate);
    const pending = createHostPending({...input, contractTemplateSha256:hostRecordDigest(templateSnapshot)});
    if (hostRecordDigest(originalResult) !== pending.resultSha256) throw new RequestLedgerError('host_result_binding_mismatch', 'original result does not match pending digest');
    const snapshot = sanitizeResult(originalResult);
    const paths = hostPaths(pending.requestId);
    if (existsSync(paths.pending)) {
      const prior = loadHostPending(pending.requestId);
      if (!prior || prior.pendingSha256 !== pending.pendingSha256) throw new RequestLedgerError('host_pending_conflict', 'host pending record conflicts or is tampered');
      try {
        const stored = readJson(paths.original);
        if (hostRecordDigest(stored.result) !== prior.resultSha256 || hostRecordDigest(stored.result) !== hostRecordDigest(snapshot)) throw new Error('binding');
      } catch { throw new RequestLedgerError('host_pending_conflict', 'original result conflicts or is tampered'); }
      return prior;
    }
    mkdirSync(paths.dir, {recursive:true, mode:0o700});
    atomicWriteJson(paths.original, {result:snapshot, contractTemplate:templateSnapshot});
    atomicWriteJson(paths.pending, pending);
    return pending;
  }

  function getHostVerification(ref) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 3 || Object.keys(ref).some(k => !['requestId','artifactSha256','recordSha256'].includes(k)) || typeof ref.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(ref.artifactSha256 ?? '') || !/^[a-f0-9]{64}$/.test(ref.recordSha256 ?? '')) return null;
    const pending = loadHostPending(ref.requestId);
    if (!pending || ref.artifactSha256 !== pending.artifactSha256) return null;
    try {
      const paths = hostPaths(ref.requestId), stored = readJson(paths.original);
      if (!stored || hostRecordDigest(stored.result) !== pending.resultSha256 || !validStoredTemplate(pending, stored.contractTemplate)) return null;
      const record = readJson(paths.attestation);
      return verifyHostAttestation(record, pending) && ref.recordSha256 === record.recordSha256 ? record : null;
    } catch { return null; }
  }

  function validateHostSource(paths, pending, {throwOnError = false} = {}) {
    let stored;
    try { stored = readJson(paths.original); }
    catch {
      if (throwOnError) throw new RequestLedgerError('host_original_integrity', 'stored original result is missing or unreadable');
      return null;
    }
    if (!stored || hostRecordDigest(stored.result) !== pending.resultSha256) {
      if (throwOnError) throw new RequestLedgerError('host_original_integrity', 'stored original result digest is invalid');
      return null;
    }
    if (!validStoredTemplate(pending, stored.contractTemplate)) {
      if (throwOnError) throw new RequestLedgerError('host_template_integrity', 'stored contract template binding is invalid');
      return null;
    }
    return stored;
  }

  function recordHostVerification(submission) {
    const pending = loadHostPending(submission?.requestId);
    if (!pending) throw new RequestLedgerError('host_not_pending', 'host verification request is not pending');
    const paths = hostPaths(submission.requestId);
    validateHostSource(paths, pending, {throwOnError:true});
    const normalizedRecord = createHostAttestation(pending, submission);
    const priorDigest = (() => { try { return readJson(paths.attestation).recordSha256; } catch { return null; } })();
    const prior = priorDigest ? getHostVerification({requestId:submission.requestId, artifactSha256:submission.artifactSha256, recordSha256:priorDigest}) : null;
    if (prior) {
      const normalized = {requestId:normalizedRecord.requestId,artifactSha256:normalizedRecord.artifactSha256,commands:normalizedRecord.commands};
      if (hostSubmissionDigest(normalized) !== hostSubmissionDigest({requestId:prior.requestId, artifactSha256:prior.artifactSha256, commands:prior.commands})) throw new RequestLedgerError('host_verification_conflict', 'host verification conflicts with durable record');
      return prior;
    }
    if (existsSync(paths.attestation)) throw new RequestLedgerError('host_verification_tampered', 'host verification record is invalid');
    const record = createHostAttestation(pending, submission, {timestamp:Date.now()});
    atomicWriteJson(paths.attestation, record);
    return record;
  }

  function getEffectiveResult(requestId) {
    const pending = loadHostPending(requestId);
    if (!pending) return null;
    const paths = hostPaths(requestId);
    try {
      const stored = validateHostSource(paths, pending);
      if (!stored) return null;
      const recordPath = paths.attestation;
      if (!existsSync(recordPath)) return {...stored.result, state:'awaiting-host-verification', ok:false, contract:undefined};
      let recordSha256; try { recordSha256 = readJson(recordPath).recordSha256; } catch { return null; }
      const record = getHostVerification({requestId, artifactSha256:pending.artifactSha256, recordSha256});
      if (!record) return null;
      if (record.outcome !== 'completed') return {...stored.result, state:'failed', ok:false, contract:undefined};
      const source = stored.result?.structuredResult ?? stored.result?.response ?? stored.result;
      const structuredResult = {...(source && typeof source === 'object' ? source : {}), status:'completed'};
      if (!validateRoleResult(structuredResult, 'Chesed').ok) return null;
      const contract = {...stored.contractTemplate, resultSha256:resultDigest(structuredResult)};
      const hostEvidence = record.commands.map(({checkName,command,exitCode,outputSummary})=>({checkName,command,exitCode,outputSummary}));
      return {...stored.result, state:'completed', ok:true, contract, structuredResult, hostEvidence};
    } catch { return null; }
  }

  function validHostTemplate(pending, template) {
    if (!template || typeof template !== 'object' || Array.isArray(template)) return false;
    const common = ['version','role','stage','mode','parentRunId','workspaceSha256','resultSha256'];
    const known = [...common,'handoffVersion','runAnchorSha256','phaseIndex'];
    const exactKnown = Object.keys(template).every(k => known.includes(k));
    const v1 = template.version === 1 && template.mode === 'linked' && Object.keys(template).every(k => common.includes(k));
    const standalone = template.version === 2 && template.mode === 'standalone' && exactKnown && template.handoffVersion === undefined && template.runAnchorSha256 === undefined && template.phaseIndex === undefined;
    const linkedV2 = template.version === 2 && template.mode === 'linked' && exactKnown && template.handoffVersion === 2 && Number.isSafeInteger(template.phaseIndex) && template.phaseIndex === pending.phase && /^[a-f0-9]{64}$/.test(template.runAnchorSha256 ?? '');
    return (v1 || standalone || linkedV2) && template.role === 'Chesed' && template.stage === 'implementing' && template.parentRunId === pending.parentRunId && template.workspaceSha256 === createHash('sha256').update(pending.workspace).digest('hex') && /^[a-f0-9]{64}$/.test(template.resultSha256 ?? '');
  }

  function validStoredTemplate(pending, template) {
    return !!pending.contractTemplateSha256 && validHostTemplate(pending, template) && hostRecordDigest(template) === pending.contractTemplateSha256;
  }

  function listHostPending({limit=100}={}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
    const result=[];
    for (const e of readdirSync(hostRoot,{withFileTypes:true})) {
      if (!e.isDirectory() || !/^[a-f0-9]{64}$/.test(e.name)) continue;
      try { const p=readJson(join(hostRoot,e.name,'pending.json')); if (p && verifyHostPending(p) && !existsSync(join(hostRoot,e.name,'attestation.json')) && result.length<limit) result.push(p); } catch { /* malformed entries are not exposed */ }
      if (result.length>=limit) break;
    }
    return result;
  }

  function getOutcome(requestId) {
    const effective = getEffectiveResult(requestId);
    if (effective) return effective.state === 'awaiting-host-verification' ? {state:effective.state} : {state:effective.state, ...(effective.contract?{contract:effective.contract,handoffResult:effective.structuredResult}:{})};
    if (existsSync(hostPaths(requestId).dir)) return {state:'indeterminate'};
    const path = join(outcomesRoot, `${entryKey(requestId)}.json`);
    if (!existsSync(path)) return { state: 'pending' };
    try {
      const value = readJson(path);
      if (value.requestId !== requestId) return { state: 'conflict' };
      return { state: value.state, completedAt: value.completedAt, ...(value.contract?{contract:value.contract,...(value.handoffResult?{handoffResult:value.handoffResult}:{})}:{}) };
    } catch { return { state: 'indeterminate' }; }
  }

  return {
    enabled: true,
    persistent: true,
    directory: root,
    retentionPolicy,
    startupRetention,
    execute,
    recordOutcome,
    getOutcome,
    registerHostPending,
    recordHostVerification,
    getHostVerification,
    getEffectiveResult,
    listHostPending,
    prune,
    close() {},
  };
}
