import {sanitizeResult} from './result-export.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { redactSensitiveText } from './audit-log.js';

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
  mkdirSync(outcomesRoot, { recursive: true, mode: 0o700 });
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

  function getOutcome(requestId) {
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
    prune,
    close() {},
  };
}
