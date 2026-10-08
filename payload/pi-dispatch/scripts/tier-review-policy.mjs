import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class ReviewAttemptError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReviewAttemptError';
    this.code = code;
    Object.assign(this, details);
  }
}

const INVALID = 'PI_REVIEW_ATTEMPTS_INVALID';
const LIMIT = 'PI_REVIEW_LIMIT_EXCEEDED';
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const REVIEW_QUOTA_POLICY = Object.freeze({
  version: 2,
  T1: Object.freeze({ base: 1, total: 2, stage: 2, time: 600000 }),
  T2: Object.freeze({ base: 2, total: 5, stage: 3, time: 1200000, sharedExtensions: 1 }),
});
const LIMITS = REVIEW_QUOTA_POLICY;
const STAGES = new Set(['pre-review', 'post-review']);
const FINDING_SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const UNKNOWN_EXECUTION_MS = 900000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameMap = (a, b) => same(Object.entries(a).sort(([left], [right]) => left.localeCompare(right)), Object.entries(b).sort(([left], [right]) => left.localeCompare(right)));
const invalid = message => { throw new ReviewAttemptError(INVALID, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value).replace(/:\d+(?::\d+)?\b/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function validateProgress(progress) {
  if (!exact(progress, ['closures', 'previousReviewRequestId', 'version']) || progress.version !== 1 ||
      !ID.test(progress.previousReviewRequestId) || !Array.isArray(progress.closures) || progress.closures.length > 256) {
    invalid('Invalid REVIEW_PROGRESS_JSON');
  }
  const closureKeys = new Set();
  for (const closure of progress.closures) {
    if (!exact(closure, ['evidence', 'key', 'paths']) || !HEX.test(closure.key) || closureKeys.has(closure.key) ||
        !Array.isArray(closure.paths) || closure.paths.length < 1 || closure.paths.length > 256 ||
        typeof closure.evidence !== 'string' || !closure.evidence.trim() || closure.evidence.length > 8000 ||
        closure.paths.some(path => typeof path !== 'string' || !path.trim() || path.length > 512 || path.startsWith('/') || path.split('/').includes('..'))) {
      invalid('Invalid REVIEW_PROGRESS_JSON');
    }
    closureKeys.add(closure.key);
  }
}

function validate(input) {
  const allowed = ['workspaceSha256', 'runAnchorSha256', 'stage', 'tier', 'requestId', 'parentRunId', 'phaseIndex',
    'timeoutSeconds', 'materialDigest', 'artifactDigest', 'hostRecordDigest', 'changedPaths', 'progress', 'materialSections'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) ||
      !HEX.test(input.workspaceSha256) || !HEX.test(input.runAnchorSha256) || !STAGES.has(input.stage) ||
      !ID.test(input.requestId) || !LIMITS[input.tier] || (input.tier === 'T1' && input.stage !== 'post-review')) {
    invalid('Invalid review attempt input');
  }
  if ((input.parentRunId != null && (typeof input.parentRunId !== 'string' || !ID.test(input.parentRunId))) ||
      (input.phaseIndex !== undefined && (!Number.isSafeInteger(input.phaseIndex) || input.phaseIndex < 1)) ||
      (input.timeoutSeconds !== undefined && (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 900))) {
    invalid('Invalid review attempt policy fields');
  }
  for (const key of ['materialDigest', 'artifactDigest', 'hostRecordDigest']) {
    if (input[key] !== undefined && !HEX.test(input[key])) invalid(`Invalid ${key}`);
  }
  if (input.changedPaths !== undefined && (!Array.isArray(input.changedPaths) || input.changedPaths.length > 256 ||
      input.changedPaths.some(path => typeof path !== 'string' || !path.trim() || path.length > 512 || path.startsWith('/') || path.split('/').includes('..')))) {
    invalid('Invalid changed paths');
  }
  if (input.materialSections !== undefined) {
    const sections = input.materialSections;
    if (!sections || typeof sections !== 'object' || Array.isArray(sections) || Object.keys(sections).length > 256) invalid('Invalid material sections');
    for (const [name, digest] of Object.entries(sections)) {
      if (!name.trim() || name.length > 512 || name.startsWith('/') || name.split('/').includes('..') || !HEX.test(digest)) invalid('Invalid material sections');
    }
  }
  if (input.progress !== undefined) validateProgress(input.progress);
}

function sync(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    try {
      descriptor = openSync(resolve(path, '..'), 'r');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    } catch { /* Directory fsync is not available on every supported host. */ }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { rmSync(temporary); } catch { /* The rename already consumed it. */ }
  }
}

function lock(directory, callback) {
  const lockPath = join(directory, '.review-attempts.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { mkdirSync(lockPath, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') invalid('Review ledger lock corrupt');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (!acquired) invalid('Review ledger locked or corrupt');
  try { return callback(); }
  finally {
    try { rmSync(lockPath, { recursive: true }); }
    catch { invalid('Unable to release review ledger lock'); }
  }
}

function initial(key, identity) {
  return { version: 2, key, identity, attempts: [], requests: {}, decisions: {}, timeUsedMs: 0, extensionUsed: false };
}

function bindParent(directory, input) {
  if (input.parentRunId == null) return;
  const path = join(directory, '.review-parent-aliases.json');
  let aliases = {};
  if (existsSync(path)) {
    try { aliases = JSON.parse(readFileSync(path, 'utf8')); }
    catch { invalid('Corrupt parent alias state'); }
    if (!aliases || Array.isArray(aliases) || typeof aliases !== 'object' ||
        Object.entries(aliases).some(([key, value]) => !HEX.test(key) || !HEX.test(value))) invalid('Invalid parent alias state');
  }
  const alias = hash(`${input.workspaceSha256}:${input.parentRunId}`);
  if (aliases[alias] && aliases[alias] !== input.runAnchorSha256) invalid('Parent run alias conflicts with existing anchor');
  if (!aliases[alias]) {
    aliases[alias] = input.runAnchorSha256;
    sync(path, `${JSON.stringify(aliases)}\n`);
  }
}

function extractCitations(text) {
  const citations = new Set();
  const paths = String(text).match(/\b[\w.-]+\/[\w./-]+(?::\d+(?::\d+)?)?/g) || [];
  for (const path of paths) citations.add(normalize(path));
  const sections = /\bsection\s+(?:["'`]([^"'`\n]{1,120})["'`]|([A-Za-z0-9_.-]+))/gi;
  for (const match of String(text).matchAll(sections)) {
    const section = normalize(match[1] || match[2]);
    if (section) citations.add(section);
  }
  return [...citations].sort();
}

function actionableFindings(decision) {
  const changes = ['request-changes', 'insufficient-materials'].includes(decision?.reviewDecision);
  return (decision?.findings || []).filter(finding => finding.blocking === true ||
    (finding.blocking === undefined && changes));
}

export function reviewBlockers(decision) {
  const blockers = [];
  for (const finding of actionableFindings(decision)) {
    const severity = normalize(finding.severity);
    const description = normalize(finding.description);
    const paths = extractCitations(`${finding.description} ${finding.evidence}`);
    blockers.push({ key: hash(JSON.stringify([severity, description, paths])), paths });
  }
  for (const missing of decision?.missingMaterials || []) {
    const value = normalize(missing);
    blockers.push({ key: hash(`missing:${value}`), paths: extractCitations(missing) });
  }
  const unique = new Map(blockers.map(blocker => [blocker.key, blocker]));
  return [...unique.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function validateDecision(decision) {
  if (!exact(decision, ['reviewDecision', 'findings', 'missingMaterials']) ||
      !['approve', 'conditional-approve', 'request-changes', 'reject', 'insufficient-materials'].includes(decision.reviewDecision) ||
      !Array.isArray(decision.findings) || decision.findings.length > 256 ||
      !Array.isArray(decision.missingMaterials) || decision.missingMaterials.length > 256) {
    invalid('Decision must be validated before persistence');
  }
  for (const finding of decision.findings) {
    const keys = Object.keys(finding || {}).sort();
    const permitted = ['blocking', 'description', 'evidence', 'severity'];
    if (!finding || typeof finding !== 'object' || Array.isArray(finding) ||
        !['description,evidence,severity', 'blocking,description,evidence,severity'].includes(keys.join(',')) ||
        !FINDING_SEVERITIES.has(finding.severity) || typeof finding.description !== 'string' || !finding.description.trim() || finding.description.length > 8000 ||
        typeof finding.evidence !== 'string' || finding.evidence.length > 8000 ||
        (own(finding, 'blocking') && typeof finding.blocking !== 'boolean')) invalid('Invalid review finding');
  }
  if (decision.missingMaterials.some(item => typeof item !== 'string' || !item.trim() || item.length > 8000)) invalid('Invalid missing materials');
  if (decision.reviewDecision === 'insufficient-materials' && decision.missingMaterials.length === 0) invalid('Insufficient-materials decision requires missing items');
  if (decision.reviewDecision !== 'insufficient-materials' && decision.missingMaterials.length) invalid('Only insufficient-materials decisions may contain missing items');
  if (['approve', 'conditional-approve'].includes(decision.reviewDecision) && decision.findings.some(finding => finding.blocking === true)) invalid('Approval cannot contain blockers');
}

function migrateCurrentState(data, key, identity) {
  if (!exact(data, ['version', 'key', 'identity', 'attempts', 'requests', 'decisions', 'timeUsedMs', 'extensionUsed']) ||
      !Array.isArray(data.attempts)) invalid('Invalid review state');
  let changed = false;
  for (const attempt of data.attempts) {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) invalid('Invalid review attempt record');
    const legacyKeys = ['attemptId', 'requestId', 'stage', 'phaseIndex', 'parentRunId', 'materialDigest', 'artifactDigest', 'hostRecordDigest',
      'status', 'started', 'outcome', 'reservedMs', 'elapsedMs', 'extension', 'timeKnown'];
    const currentKeys = [...legacyKeys, 'materialSections', 'progressVerified', 'legacyImportDigest'];
    if (!exact(attempt, legacyKeys) && !exact(attempt, currentKeys)) invalid('Invalid review attempt record');
    for (const [name, value] of Object.entries({ materialSections: {}, progressVerified: false, legacyImportDigest: null })) {
      if (!own(attempt, name)) { attempt[name] = value; changed = true; }
    }
  }
  if (data.version !== 2 || data.key !== key || !exact(data.identity, ['workspaceSha256', 'runAnchorSha256', 'tier']) || !same(data.identity, identity)) invalid('Invalid review state');
  return changed;
}

function validateState(data, key, identity) {
  if (!exact(data, ['version', 'key', 'identity', 'attempts', 'requests', 'decisions', 'timeUsedMs', 'extensionUsed']) ||
      data.version !== 2 || data.key !== key || !exact(data.identity, ['workspaceSha256', 'runAnchorSha256', 'tier']) || !same(data.identity, identity) ||
      !Array.isArray(data.attempts) || !data.requests || Array.isArray(data.requests) || typeof data.requests !== 'object' ||
      !data.decisions || Array.isArray(data.decisions) || typeof data.decisions !== 'object' ||
      !Number.isSafeInteger(data.timeUsedMs) || data.timeUsedMs < 0 || typeof data.extensionUsed !== 'boolean') invalid('Invalid review state');
  const attemptIds = new Set();
  const requests = {};
  let time = 0;
  let extensions = 0;
  const stageCounts = { 'pre-review': 0, 'post-review': 0 };
  for (const attempt of data.attempts) {
    if (!exact(attempt, ['attemptId', 'requestId', 'stage', 'phaseIndex', 'parentRunId', 'materialDigest', 'artifactDigest', 'hostRecordDigest',
      'status', 'started', 'outcome', 'reservedMs', 'elapsedMs', 'extension', 'timeKnown', 'materialSections', 'progressVerified', 'legacyImportDigest']) ||
        !ID.test(attempt.attemptId) || !ID.test(attempt.requestId) || !STAGES.has(attempt.stage) ||
        !Number.isSafeInteger(attempt.phaseIndex) || attempt.phaseIndex < 1 ||
        (attempt.parentRunId !== null && !ID.test(attempt.parentRunId)) ||
        !['reserved', 'started', 'finished', 'released'].includes(attempt.status) ||
        typeof attempt.started !== 'boolean' || typeof attempt.timeKnown !== 'boolean' || typeof attempt.extension !== 'boolean' ||
        typeof attempt.progressVerified !== 'boolean' || !Number.isSafeInteger(attempt.reservedMs) || attempt.reservedMs < 0 ||
        (attempt.elapsedMs !== null && (!Number.isSafeInteger(attempt.elapsedMs) || attempt.elapsedMs < 0)) ||
        (attempt.materialDigest !== null && !HEX.test(attempt.materialDigest)) ||
        (attempt.artifactDigest !== null && !HEX.test(attempt.artifactDigest)) ||
        (attempt.hostRecordDigest !== null && !HEX.test(attempt.hostRecordDigest)) ||
        (attempt.outcome !== null && (typeof attempt.outcome !== 'string' || !attempt.outcome || attempt.outcome.length > 128)) ||
        (attempt.legacyImportDigest !== null && !HEX.test(attempt.legacyImportDigest)) ||
        !attempt.materialSections || typeof attempt.materialSections !== 'object' || Array.isArray(attempt.materialSections) ||
        Object.entries(attempt.materialSections).some(([name, digest]) => !name || name.length > 512 || !HEX.test(digest)) ||
        attemptIds.has(attempt.attemptId) || own(requests, attempt.requestId)) invalid('Invalid review attempt record');
    attemptIds.add(attempt.attemptId);
    requests[attempt.requestId] = attempt.attemptId;
    if (attempt.status !== 'released') {
      stageCounts[attempt.stage]++;
      const base = LIMITS[data.identity.tier].base;
      if ((stageCounts[attempt.stage] > base) !== attempt.extension || stageCounts[attempt.stage] > base + 1) invalid('Review extension flags disagree with stage attempt counts');
    }
    if (attempt.status === 'reserved' || attempt.status === 'started') {
      time += attempt.reservedMs;
      if ((attempt.status === 'reserved' && (attempt.started || attempt.elapsedMs !== null || attempt.outcome !== null)) ||
          (attempt.status === 'started' && (!attempt.started || attempt.elapsedMs !== null || attempt.outcome !== null))) invalid('Inconsistent pending review attempt lifecycle');
    } else if (attempt.status === 'finished') {
      if (!attempt.started || attempt.elapsedMs === null || attempt.outcome === null) invalid('Inconsistent finished review attempt lifecycle');
      time += attempt.elapsedMs;
    } else if (attempt.started || attempt.elapsedMs !== 0 || attempt.outcome === null || attempt.timeKnown) {
      invalid('Inconsistent released review attempt lifecycle');
    }
    if (attempt.extension && attempt.status !== 'released') extensions++;
  }
  if (!same(requests, data.requests) || time !== data.timeUsedMs || extensions > 1 || (extensions > 0) !== data.extensionUsed ||
      (data.identity.tier === 'T1' && stageCounts['pre-review'] !== 0) || stageCounts['pre-review'] > LIMITS[data.identity.tier].stage || stageCounts['post-review'] > LIMITS[data.identity.tier].stage ||
      stageCounts['pre-review'] + stageCounts['post-review'] > LIMITS[data.identity.tier].total) invalid('Review state derived indexes or counters disagree');
  if (Object.keys(data.decisions).some(request => !ID.test(request) || !own(data.requests, request))) invalid('Invalid persisted decision index');
  for (const [request, value] of Object.entries(data.decisions)) {
    const attempt = data.attempts.find(item => item.requestId === request);
    try { validateDecision(value?.decision); } catch { invalid('Invalid persisted review decision'); }
    if (!exact(value, ['stage', 'phaseIndex', 'materialDigest', 'artifactDigest', 'hostRecordDigest', 'decision']) || !attempt || attempt.status !== 'finished' ||
        value.stage !== attempt.stage || value.phaseIndex !== attempt.phaseIndex || value.materialDigest !== attempt.materialDigest ||
        value.artifactDigest !== attempt.artifactDigest || value.hostRecordDigest !== attempt.hostRecordDigest) invalid('Invalid persisted review decision');
  }
}

function migrateLegacy(data, directory, identity) {
  let changed = false;
  for (const stage of STAGES) {
    const legacyKey = hash(JSON.stringify({ workspaceSha256: identity.workspaceSha256, runAnchorSha256: identity.runAnchorSha256, stage }));
    const legacyPath = join(directory, `${legacyKey}.json`);
    if (!existsSync(legacyPath)) continue;
    let old;
    try { old = JSON.parse(readFileSync(legacyPath, 'utf8')); }
    catch { invalid('Corrupt legacy review state'); }
    if (!exact(old, ['attempts', 'identity', 'key', 'requests', 'version']) || old.version !== 1 || old.key !== legacyKey ||
        !exact(old.identity, ['runAnchorSha256', 'stage', 'tier', 'workspaceSha256']) ||
        old.identity.workspaceSha256 !== identity.workspaceSha256 || old.identity.runAnchorSha256 !== identity.runAnchorSha256 ||
        old.identity.tier !== identity.tier || old.identity.stage !== stage || !Array.isArray(old.attempts) ||
        !old.requests || Array.isArray(old.requests) || typeof old.requests !== 'object') invalid('Invalid legacy review state');
    const legacyRequests = {};
    const legacyIds = new Set();
    let consumed = 0;
    for (const attempt of old.attempts) {
      if (!exact(attempt, ['attemptId', 'outcome', 'requestId', 'started', 'status']) || !ID.test(attempt.attemptId) || !ID.test(attempt.requestId) ||
          !['reserved', 'started', 'finished', 'released'].includes(attempt.status) || typeof attempt.started !== 'boolean' ||
          (attempt.outcome !== null && (typeof attempt.outcome !== 'string' || attempt.outcome.length > 128)) || legacyIds.has(attempt.attemptId) || own(legacyRequests, attempt.requestId) ||
          (attempt.status === 'reserved' && (attempt.started || attempt.outcome !== null)) ||
          (attempt.status === 'started' && (!attempt.started || attempt.outcome !== null)) ||
          (attempt.status === 'finished' && (!attempt.started || !attempt.outcome)) ||
          (attempt.status === 'released' && (attempt.started || !attempt.outcome))) invalid('Unsafe legacy attempt');
      legacyIds.add(attempt.attemptId);
      legacyRequests[attempt.requestId] = attempt.attemptId;
      if (attempt.status === 'reserved' || attempt.status === 'started') invalid(`Legacy pending attempt ${attempt.attemptId} requires operator reconciliation`);
      if (attempt.status !== 'released') consumed++;
    }
    if (!same(legacyRequests, old.requests) || consumed > LIMITS[identity.tier].stage || (identity.tier === 'T1' && stage === 'pre-review' && consumed > 0)) invalid('Legacy request index or stage cap disagrees');

    for (const oldAttempt of old.attempts) {
      const digest = hash(JSON.stringify(oldAttempt));
      const existingId = data.requests[oldAttempt.requestId];
      if (existingId) {
        const existing = data.attempts.find(attempt => attempt.attemptId === existingId);
        const matches = existing && existing.attemptId === oldAttempt.attemptId && existing.stage === stage &&
          existing.requestId === oldAttempt.requestId && existing.started === oldAttempt.started && existing.outcome === oldAttempt.outcome &&
          existing.status === oldAttempt.status && existing.phaseIndex === 1 && existing.parentRunId === null &&
          existing.materialDigest === null && existing.artifactDigest === null && existing.hostRecordDigest === null;
        if (!matches || (existing.legacyImportDigest && existing.legacyImportDigest !== digest)) invalid('Conflicting or mutated legacy attempt');
        if (existing.legacyImportDigest === null) { existing.legacyImportDigest = digest; changed = true; }
        continue;
      }
      if (legacyIds.has(oldAttempt.attemptId) && data.attempts.some(attempt => attempt.attemptId === oldAttempt.attemptId)) invalid('Conflicting legacy attempt ID');
      const elapsed = oldAttempt.started ? UNKNOWN_EXECUTION_MS : 0;
      data.attempts.push({
        attemptId: oldAttempt.attemptId, requestId: oldAttempt.requestId, stage, phaseIndex: 1, parentRunId: null,
        materialDigest: null, artifactDigest: null, hostRecordDigest: null, status: oldAttempt.status,
        started: oldAttempt.started, outcome: oldAttempt.outcome, reservedMs: 0, elapsedMs: elapsed,
        extension: false, timeKnown: false, materialSections: {}, progressVerified: false, legacyImportDigest: digest,
      });
      data.requests[oldAttempt.requestId] = oldAttempt.attemptId;
      data.timeUsedMs += elapsed;
      changed = true;
    }
  }
  return changed;
}

function loadState(directory, key, identity) {
  const path = join(directory, `${key}.json`);
  let data;
  let changed = false;
  if (existsSync(path)) {
    try { data = JSON.parse(readFileSync(path, 'utf8')); }
    catch { invalid('Corrupt review state'); }
    changed = migrateCurrentState(data, key, identity);
  } else data = initial(key, identity);
  changed = migrateLegacy(data, directory, identity) || changed;
  validateState(data, key, identity);
  if (changed) sync(path, `${JSON.stringify(data)}\n`);
  return { data, path };
}

function progressEligible(data, input) {
  const progress = input.progress;
  if (!progress || !input.materialDigest) return false;
  const phase = input.phaseIndex || 1;
  const priorAttempt = [...data.attempts].reverse().find(attempt => attempt.stage === input.stage && attempt.phaseIndex === phase && attempt.status !== 'released');
  if (!priorAttempt || priorAttempt.requestId !== progress.previousReviewRequestId || priorAttempt.status !== 'finished') return false;
  const prior = data.decisions[progress.previousReviewRequestId];
  if (!prior || prior.stage !== input.stage || prior.phaseIndex !== phase || prior.materialDigest === input.materialDigest ||
      !['request-changes', 'insufficient-materials'].includes(prior.decision.reviewDecision)) return false;
  if (input.stage === 'post-review' && (!input.artifactDigest || input.artifactDigest === prior.artifactDigest ||
      !input.hostRecordDigest || input.hostRecordDigest === prior.hostRecordDigest)) return false;

  let actualChanges;
  if (input.stage === 'pre-review') {
    if (!Object.keys(priorAttempt.materialSections).length || !input.materialSections || !Object.keys(input.materialSections).length) return false;
    const keys = new Set([...Object.keys(priorAttempt.materialSections), ...Object.keys(input.materialSections)]);
    actualChanges = new Set([...keys].filter(key => priorAttempt.materialSections[key] !== input.materialSections[key]).map(normalize));
    if (!actualChanges.size) return false;
  } else {
    if (!Array.isArray(input.changedPaths) || !input.changedPaths.length) return false;
    actualChanges = new Set(input.changedPaths.map(normalize));
  }

  const required = reviewBlockers(prior.decision);
  if (!required.length || required.some(blocker => blocker.paths.length === 0)) return false;
  const closures = new Map();
  for (const closure of progress.closures) {
    if (closures.has(closure.key)) return false;
    const paths = closure.paths.map(normalize);
    if (paths.some(path => !actualChanges.has(path))) return false;
    closures.set(closure.key, { paths, evidence: closure.evidence.trim() });
  }
  if (closures.size !== required.length) return false;
  return required.every(blocker => {
    const closure = closures.get(blocker.key);
    return closure && closure.paths.length > 0 && closure.paths.every(path => actualChanges.has(path)) && blocker.paths.some(path => closure.paths.includes(path));
  });
}

function stalled(data, input) {
  const phase = input.phaseIndex || 1;
  const history = data.attempts.filter(attempt => attempt.stage === input.stage && attempt.phaseIndex === phase && attempt.status !== 'released');
  if (history.length < 2) return false;
  const previousAttempt = history.at(-2);
  const latestAttempt = history.at(-1);
  const previous = data.decisions[previousAttempt.requestId];
  const latest = data.decisions[latestAttempt.requestId];
  if (!previous || !latest || !['request-changes', 'insufficient-materials'].includes(previous.decision.reviewDecision) ||
      !['request-changes', 'insufficient-materials'].includes(latest.decision.reviewDecision) || latestAttempt.progressVerified) return false;
  const olderKeys = new Set(reviewBlockers(previous.decision).map(blocker => blocker.key));
  const latestKeys = new Set(reviewBlockers(latest.decision).map(blocker => blocker.key));
  return olderKeys.size > 0 && [...olderKeys].every(key => latestKeys.has(key));
}

function makeTicket(attempt, data, replayed, timeoutSeconds) {
  return Object.freeze({ attemptId: attempt.attemptId, requestId: attempt.requestId, key: data.key, ...data.identity,
    parentRunId: attempt.parentRunId, stage: attempt.stage, tier: data.identity.tier, replayed, timeoutSeconds });
}

export function createReviewAttemptLedger(directory) {
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Object.freeze({
    reserve(input) {
      validate(input);
      const identity = { workspaceSha256: input.workspaceSha256, runAnchorSha256: input.runAnchorSha256, tier: input.tier };
      const key = hash(JSON.stringify({ workspaceSha256: input.workspaceSha256, runAnchorSha256: input.runAnchorSha256 }));
      return lock(dir, () => {
        bindParent(dir, input);
        const { data, path } = loadState(dir, key, identity);
        const priorId = data.requests[input.requestId];
        if (priorId) {
          const old = data.attempts.find(attempt => attempt.attemptId === priorId);
          const sections = input.materialSections || {};
          if (!old || old.stage !== input.stage || old.phaseIndex !== (input.phaseIndex || 1) || old.parentRunId !== (input.parentRunId ?? null) ||
              old.materialDigest !== (input.materialDigest || null) || old.artifactDigest !== (input.artifactDigest || null) ||
              old.hostRecordDigest !== (input.hostRecordDigest || null) || !sameMap(old.materialSections, sections)) invalid('Request replay changed stage or material identity');
          return makeTicket(old, data, true, Math.floor(old.reservedMs / 1000));
        }
        const pending = data.attempts.find(attempt => attempt.status === 'reserved' || attempt.status === 'started');
        if (pending) invalid(`Pending review attempt ${pending.attemptId} requires operator reconciliation`);

        const limits = LIMITS[input.tier];
        const consumed = data.attempts.filter(attempt => attempt.status !== 'released');
        const stageUsed = consumed.filter(attempt => attempt.stage === input.stage).length;
        const phase = input.phaseIndex || 1;
        const approved = Object.values(data.decisions).some(decision => decision.stage === input.stage && decision.phaseIndex === phase &&
          ['approve', 'conditional-approve'].includes(decision.decision.reviewDecision));
        const sameApprovedContent = approved && data.attempts.some(attempt => attempt.stage === input.stage && attempt.phaseIndex === phase &&
          attempt.status === 'finished' && ['approve', 'conditional-approve'].includes(data.decisions[attempt.requestId]?.decision.reviewDecision) &&
          (input.stage === 'post-review' ? input.artifactDigest != null && attempt.artifactDigest === input.artifactDigest :
            attempt.materialDigest === (input.materialDigest || null)));
        if (sameApprovedContent) throw new ReviewAttemptError(LIMIT, 'Review already approved for unchanged material/artifact');
        if (stalled(data, input)) throw new ReviewAttemptError(LIMIT, 'Review retries stopped after consecutive non-progress blocker sets');

        const verified = progressEligible(data, input);
        const extension = !approved && stageUsed >= limits.base && verified;
        if (consumed.length >= limits.total || stageUsed >= limits.stage || (stageUsed >= limits.base && (!extension || data.extensionUsed))) {
          throw new ReviewAttemptError(LIMIT, `Review quota exhausted (${input.tier} ${input.stage}: base ${limits.base}, extension ${data.extensionUsed ? 'used' : 'unavailable'}, stage ${limits.stage}, total ${limits.total})`,
            { tier: input.tier, stage: input.stage, used: consumed.length, stageUsed, base: limits.base, remainingBase: Math.max(0, limits.base - stageUsed), sharedExtraRemaining: Math.max(0, (limits.sharedExtensions ?? 1) - (data.extensionUsed ? 1 : 0)), stageCap: limits.stage, remainingStage: Math.max(0, limits.stage - stageUsed), totalCap: limits.total, remainingTotal: Math.max(0, limits.total - consumed.length), extensionUsed: data.extensionUsed, extensionEligible: extension, extensionEligibilityReason: data.extensionUsed ? 'shared extension consumed' : 'trusted relevant progress and matching host proof required', nextAction: 'review trusted blocker progress and policy gates before retrying' });
        }
        const remaining = Math.max(0, limits.time - data.timeUsedMs);
        const timeoutSeconds = Math.min(input.timeoutSeconds ?? 900, 900, Math.floor(remaining / 1000));
        if (timeoutSeconds < 1) throw new ReviewAttemptError(LIMIT, `Review time budget exhausted; remainingMs=${remaining}`, { remainingMs: remaining });
        const attempt = {
          attemptId: randomUUID(), requestId: input.requestId, stage: input.stage, phaseIndex: phase,
          parentRunId: input.parentRunId ?? null, materialDigest: input.materialDigest || null,
          artifactDigest: input.artifactDigest || null, hostRecordDigest: input.hostRecordDigest || null,
          status: 'reserved', started: false, outcome: null, reservedMs: timeoutSeconds * 1000,
          elapsedMs: null, extension, timeKnown: false, materialSections: input.materialSections || {}, progressVerified: verified, legacyImportDigest: null,
        };
        data.attempts.push(attempt);
        data.requests[input.requestId] = attempt.attemptId;
        data.timeUsedMs += attempt.reservedMs;
        if (extension) data.extensionUsed = true;
        validateState(data, key, identity);
        sync(path, `${JSON.stringify(data)}\n`);
        return makeTicket(attempt, data, false, timeoutSeconds);
      });
    },
    markStarted(ticket) {
      if (ticket?.replayed) invalid('Replay cannot launch');
      return this._update(ticket, attempt => {
        if (attempt.status !== 'reserved') invalid('Ticket is not startable');
        attempt.status = 'started';
        attempt.started = true;
        attempt.timeKnown = false;
      });
    },
    finish(ticket, { started, outcome, executionMs, executionKnown = true } = {}) {
      if (typeof started !== 'boolean' || typeof outcome !== 'string' || !outcome || outcome.length > 128 || typeof executionKnown !== 'boolean' ||
          (started && executionKnown && (!Number.isSafeInteger(executionMs) || executionMs < 0)) ||
          (started && !executionKnown && executionMs !== undefined) || (!started && executionMs !== undefined)) invalid('Invalid finish data');
      return this._update(ticket, (attempt, data) => {
        const charged = started ? (executionKnown ? executionMs : attempt.reservedMs) : 0;
        if (attempt.status === 'finished' || attempt.status === 'released') {
          if (attempt.started === started && attempt.outcome === outcome && attempt.elapsedMs === charged && attempt.timeKnown === (started && executionKnown)) return;
          invalid('Conflicting finish');
        }
        if (attempt.started !== started) invalid('Review start state mismatch');
        attempt.status = started ? 'finished' : 'released';
        attempt.outcome = outcome;
        attempt.elapsedMs = charged;
        attempt.timeKnown = started && executionKnown;
        data.timeUsedMs += charged - attempt.reservedMs;
        if (!started && attempt.extension) data.extensionUsed = false;
      });
    },
    recordDecision(ticket, decision) {
      validateDecision(decision);
      return this._update(ticket, (attempt, data) => {
        if (attempt.status !== 'finished') invalid('Decision requires finished execution');
        const value = { stage: attempt.stage, phaseIndex: attempt.phaseIndex, materialDigest: attempt.materialDigest,
          artifactDigest: attempt.artifactDigest, hostRecordDigest: attempt.hostRecordDigest, decision: JSON.parse(JSON.stringify(decision)) };
        if (data.decisions[ticket.requestId] && !same(data.decisions[ticket.requestId], value)) invalid('Conflicting persisted decision');
        data.decisions[ticket.requestId] = value;
      });
    },
    snapshot(input) {
      validate(input);
      const key = hash(JSON.stringify({ workspaceSha256: input.workspaceSha256, runAnchorSha256: input.runAnchorSha256 }));
      return lock(dir, () => {
        const { data } = loadState(dir, key, { workspaceSha256: input.workspaceSha256, runAnchorSha256: input.runAnchorSha256, tier: input.tier });
        return JSON.parse(JSON.stringify(data));
      });
    },
    _update(ticket, callback) {
      if (!ticket || ticket.replayed || !HEX.test(ticket.key || '') || !ID.test(ticket.requestId || '') || !ID.test(ticket.attemptId || '')) invalid('Invalid review ticket');
      return lock(dir, () => {
        const identity = { workspaceSha256: ticket.workspaceSha256, runAnchorSha256: ticket.runAnchorSha256, tier: ticket.tier };
        const { data, path } = loadState(dir, ticket.key, identity);
        const attempt = data.attempts.find(item => item.attemptId === ticket.attemptId && item.requestId === ticket.requestId);
        if (!attempt) invalid('Unknown review ticket');
        callback(attempt, data);
        validateState(data, ticket.key, identity);
        sync(path, `${JSON.stringify(data)}\n`);
        return { attemptId: attempt.attemptId, status: attempt.status, started: attempt.started, outcome: attempt.outcome };
      });
    },
  });
}
