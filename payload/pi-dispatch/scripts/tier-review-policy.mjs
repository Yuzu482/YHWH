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
const GRANT_KEYS = ['id', 'authorizationReference', 'workspaceSha256', 'runAnchorSha256', 'parentRunId', 'tier', 'phaseIndex', 'totalCap', 'stageCap'];
export function validateReviewQuotaExceptions(value = []) {
  if (!Array.isArray(value) || value.length > 16) throw new TypeError('Invalid reviewQuotaExceptions');
  const grants = value.map(grant => {
    if (!exact(grant, GRANT_KEYS) || typeof grant.id !== 'string' || !ID.test(grant.id) ||
        typeof grant.authorizationReference !== 'string' || !grant.authorizationReference.trim() || grant.authorizationReference.length > 256 ||
        !HEX.test(grant.workspaceSha256) || !HEX.test(grant.runAnchorSha256) || !ID.test(grant.parentRunId) ||
        grant.tier !== 'T2' || grant.phaseIndex !== 2 ||
        !((grant.totalCap === 6 && grant.stageCap === 3) || (grant.totalCap === 8 && grant.stageCap === 5) || (grant.totalCap === 11 && grant.stageCap === 8) || (grant.totalCap === 13 && grant.stageCap === 9) || (grant.totalCap === 14 && grant.stageCap === 10) || (grant.totalCap === 15 && grant.stageCap === 11) || (grant.totalCap === 16 && grant.stageCap === 12) || (grant.totalCap === 17 && grant.stageCap === 13)) ||
        (grant.totalCap > 6 && (grant.id !== 'infalsus-card-lab-phase2-20261012' ||
          grant.workspaceSha256 !== '3149a065938db19874bfdbcce8d6de2ca9c27645fa38f353cbd5c8245691d149' ||
          grant.runAnchorSha256 !== 'b991be558d49d9847f0eb12560d2cd2f1873b1f69146678a9e13b06d1286b062' ||
          grant.parentRunId !== 'infalsus-card-lab-20261012' ||
          (grant.totalCap === 14 && grant.authorizationReference !== 'user-approval:quota14:4ae04ff18684e8ceab91d19b96296c43dc6e6bb64338ab2fc0ee7551249495d1') ||
          (grant.totalCap === 15 && grant.authorizationReference !== 'user-approval:quota15:6a003ad97028b560f2c4fe0073f0115d60b6ad4d91625e72776cfe9d00eefff9') ||
          (grant.totalCap === 16 && grant.authorizationReference !== 'user-approval:quota16:b26b7a24e8d70f34812fc74524620c4bbd66beb9012aa661c8a15c50496c7120') ||
          (grant.totalCap === 17 && grant.authorizationReference !== 'user-approval:quota17:a8e306108b7fdd6762f9ab6c67f46a303e50bc425f214e5971ed120668aaf99d')))) throw new TypeError('Invalid reviewQuotaExceptions entry');
    return Object.freeze({ ...grant });
  });
  for (let i = 0; i < grants.length; i++) for (let j = i + 1; j < grants.length; j++) {
    if (grants[i].id === grants[j].id || (grants[i].workspaceSha256 === grants[j].workspaceSha256 && grants[i].runAnchorSha256 === grants[j].runAnchorSha256 && grants[i].parentRunId === grants[j].parentRunId && grants[i].phaseIndex === grants[j].phaseIndex)) throw new TypeError('Duplicate review quota exception');
  }
  return Object.freeze(grants);
}
export function effectiveReviewQuota(grants, identity, candidate) {
  const grant = grants.find(item => item.workspaceSha256 === identity.workspaceSha256 && item.runAnchorSha256 === identity.runAnchorSha256 &&
    item.parentRunId === candidate.parentRunId && item.phaseIndex === candidate.phaseIndex && item.tier === identity.tier && identity.tier === 'T2');
  if (!grant) return LIMITS[identity.tier];
  if (grant.totalCap > 6 && !STAGES.has(candidate.stage)) throw new TypeError('Review quota stage is required for extended grants');
  return Object.freeze({ ...LIMITS.T2, ...([16, 17].includes(grant.totalCap) ? { time: 1800000 } : {}), total: grant.totalCap,
    stage: [13, 14, 15, 16, 17].includes(grant.totalCap) && candidate.stage === 'pre-review' ? 4 : grant.totalCap > 6 && candidate.stage === 'post-review' ? grant.stageCap : 3,
    sharedExtensions: grant.totalCap - 4, grantId: grant.id, authorizationReference: grant.authorizationReference,
    parentRunId: grant.parentRunId, totalCap: grant.totalCap, stageCap: grant.stageCap });
}
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

function validateState(data, key, identity, grants = []) {
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
  const extensionAttempts = [];
  const phaseStageExtensions = new Set();
  let wholeGoalCount = 0;
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
      const priorStageCount = stageCounts[attempt.stage];
      stageCounts[attempt.stage]++;
      wholeGoalCount++;
      const base = LIMITS[data.identity.tier].base;
      const rule = effectiveReviewQuota(grants, data.identity, attempt);
      if ((stageCounts[attempt.stage] > base) !== attempt.extension || stageCounts[attempt.stage] > rule.stage) invalid('Review extension flags disagree with stage attempt counts');
      if (attempt.extension) {
        const authorized = rule.grantId !== undefined && attempt.phaseIndex === 2 && attempt.parentRunId === rule.parentRunId &&
          (attempt.stage === 'pre-review' ? priorStageCount === 2 || ([13, 14, 15, 16, 17].includes(rule.totalCap) && priorStageCount === 3) : priorStageCount >= 2 && priorStageCount < rule.stage);
        extensionAttempts.push({ authorized, totalCap: rule.total, grantId: rule.grantId });
        if (authorized) {
          const slot = `${attempt.stage}:${attempt.phaseIndex}:${wholeGoalCount}`;
          if (phaseStageExtensions.has(slot)) invalid('Duplicate authorized review extension slot');
          phaseStageExtensions.add(slot);
        }
      }
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
  const hasAuthorizedExtension = extensionAttempts.some(item => item.authorized);
  const mixedUnauthorized = extensionAttempts.some(item => !item.authorized);
  const authorizedTotalCap = Math.max(LIMITS[data.identity.tier].total, ...extensionAttempts.filter(item => item.authorized).map(item => item.totalCap));
  const authorizedExtensionCap = authorizedTotalCap - 4;
  const extendedGrant = grants.find(grant => grant.totalCap > 6 && grant.workspaceSha256 === identity.workspaceSha256 && grant.runAnchorSha256 === identity.runAnchorSha256);
  const postStageCap = extendedGrant?.stageCap ?? LIMITS[data.identity.tier].stage;
  if (!same(requests, data.requests) || time !== data.timeUsedMs || extensions > (hasAuthorizedExtension && !mixedUnauthorized ? authorizedExtensionCap : 1) ||
      (extensions > 1 && (!hasAuthorizedExtension || mixedUnauthorized)) || (extensions > 0) !== data.extensionUsed ||
      (data.identity.tier === 'T1' && stageCounts['pre-review'] !== 0) || stageCounts['pre-review'] > ([13, 14, 15, 16, 17].includes(extendedGrant?.totalCap) ? 4 : LIMITS[data.identity.tier].stage) || stageCounts['post-review'] > postStageCap ||
      stageCounts['pre-review'] + stageCounts['post-review'] > (hasAuthorizedExtension && !mixedUnauthorized ? authorizedTotalCap : LIMITS[data.identity.tier].total)) invalid('Review state derived indexes or counters disagree');
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

function loadState(directory, key, identity, grants = []) {
  const path = join(directory, `${key}.json`);
  let data;
  let changed = false;
  if (existsSync(path)) {
    try { data = JSON.parse(readFileSync(path, 'utf8')); }
    catch { invalid('Corrupt review state'); }
    changed = migrateCurrentState(data, key, identity);
  } else data = initial(key, identity);
  changed = migrateLegacy(data, directory, identity) || changed;
  validateState(data, key, identity, grants);
  if (changed) sync(path, `${JSON.stringify(data)}\n`);
  return { data, path };
}

const EVIDENCE_RECONSIDERATION = Object.freeze({
  requestId:'card-lab-final-range-3-evidence-reconsideration-normalized-20261013',
  originalZeroLaunchRequestId:'card-lab-final-range-3-evidence-reconsideration-20261013',
  previousReviewRequestId:'card-lab-final-range-3-20261013',
  blockerKey:'72e17cb44d20fc848f4ab8e5d07ad9b29bc432feab9ab06a113e51c00e8d9fd4',
  path:'tests/native-planner.test.mjs',
  materialDigest:'4604e730441c9262d2724f84110353ee11704f50cb77572b2e608c94e86b528a',
  previousMaterialDigest:'5c420fd5b0707e63808164e0ca404554fc8ebe79ee2bfcab414b179df5f9f34f',
  artifactDigest:'cdd8518a02743d344645709600c8c6bce7564e2258d9a596b7b1f69c450e2184',
  hostRecordDigest:'873748be9c0e59041e1cba540cadb464bc43591b8ca1dbf510f9284eac00d706',
  reportSha256:'31c4f85c6f4af9a83f4c3a464009511fa867eb83b78cef581f6179d08eef18ac',
  authorizationSha256:'user-approval:quota14:4ae04ff18684e8ceab91d19b96296c43dc6e6bb64338ab2fc0ee7551249495d1',
  parentRunId:'infalsus-card-lab-20261012',
});

function evidenceReconsiderationEligible(data, input, limits) {
  // The rejected original ID had no quota reservation. Any historical attempt makes this exact successor ineligible.
  if (data.attempts.some(attempt => attempt.requestId === EVIDENCE_RECONSIDERATION.originalZeroLaunchRequestId)) return false;
  if (input.requestId !== EVIDENCE_RECONSIDERATION.requestId || input.stage !== 'post-review' || input.phaseIndex !== 2 ||
      input.parentRunId !== EVIDENCE_RECONSIDERATION.parentRunId || limits.totalCap !== 14 ||
      limits.authorizationReference !== EVIDENCE_RECONSIDERATION.authorizationSha256 ||
      input.materialDigest !== EVIDENCE_RECONSIDERATION.materialDigest ||
      input.artifactDigest !== EVIDENCE_RECONSIDERATION.artifactDigest || input.hostRecordDigest !== EVIDENCE_RECONSIDERATION.hostRecordDigest ||
      !input.progress || input.progress.previousReviewRequestId !== EVIDENCE_RECONSIDERATION.previousReviewRequestId) return false;
  const history = data.attempts.filter(attempt => attempt.stage === 'post-review' && attempt.phaseIndex === 2 &&
    attempt.parentRunId === EVIDENCE_RECONSIDERATION.parentRunId && attempt.status !== 'released');
  const previousAttempt = history.at(-1);
  const prior = data.decisions[EVIDENCE_RECONSIDERATION.previousReviewRequestId];
  if (!previousAttempt || previousAttempt.requestId !== EVIDENCE_RECONSIDERATION.previousReviewRequestId || previousAttempt.status !== 'finished' ||
      previousAttempt.materialDigest !== EVIDENCE_RECONSIDERATION.previousMaterialDigest ||
      previousAttempt.artifactDigest !== EVIDENCE_RECONSIDERATION.artifactDigest || previousAttempt.hostRecordDigest !== EVIDENCE_RECONSIDERATION.hostRecordDigest ||
      !prior || prior.stage !== 'post-review' || prior.phaseIndex !== 2 || prior.materialDigest !== EVIDENCE_RECONSIDERATION.previousMaterialDigest ||
      prior.artifactDigest !== EVIDENCE_RECONSIDERATION.artifactDigest || prior.hostRecordDigest !== EVIDENCE_RECONSIDERATION.hostRecordDigest ||
      prior.decision.reviewDecision !== 'request-changes') return false;
  const blockers = reviewBlockers(prior.decision);
  if (blockers.length !== 1 || blockers[0].key !== EVIDENCE_RECONSIDERATION.blockerKey ||
      blockers[0].paths.length !== 1 || blockers[0].paths[0] !== EVIDENCE_RECONSIDERATION.path) return false;
  const sections = input.materialSections;
  if (!sections || !sections.requirements || !sections.changes ||
      sections.requirements === previousAttempt.materialSections.requirements) return false;
  const progress = input.progress;
  if (progress.closures.length !== 1) return false;
  const closure = progress.closures[0];
  return closure.key === EVIDENCE_RECONSIDERATION.blockerKey && closure.paths.length === 1 &&
    closure.paths[0] === EVIDENCE_RECONSIDERATION.path && closure.evidence.includes(EVIDENCE_RECONSIDERATION.reportSha256);
}

const QUOTA15 = Object.freeze({
  authorizationReference:'user-approval:quota15:6a003ad97028b560f2c4fe0073f0115d60b6ad4d91625e72776cfe9d00eefff9',
  workspaceSha256:'3149a065938db19874bfdbcce8d6de2ca9c27645fa38f353cbd5c8245691d149',
  runAnchorSha256:'b991be558d49d9847f0eb12560d2cd2f1873b1f69146678a9e13b06d1286b062', parentRunId:'infalsus-card-lab-20261012',
  first13AttemptsSha256:'e55bc497cf035cf482ca2cd61d46621aebffc79a4225759fec0e8e0d8d63efa0',
  first13DecisionsSha256:'03f6b01140dc4a9ff4193f2a1a47b007e8a2e3ff80b05d338736000f67a8817c', reportSha256:'8057236fc37780e35489e3420cec7fd6dec8950d6e11b68a427dbd186604dcec',
  range5:{requestId:'card-lab-final-range-5-material-reconsideration-20261014',materialDigest:'ab927d179bb3d4eabfd05b544a7e33d235bc2041bf9a203c68aaebb65edf3887',artifactDigest:'be00d50cbcff3d58faf3ea0a6c025b2d31d9782d94a35a138866a1412fd00dff',hostRecordDigest:'446ccd9bbaa37ab8e0fdacf7f2a6e6ad27e63c69249a8fab5c2c5dc195fcc2bb',previous:'card-lab-final-range-5-20261013',previousMaterialDigest:'46994ecc3e5b3c12654d6bdd469b5abc0c28dd9178db965da6e051b3a0e78c58',sections:{requirements:'fd4338db5ba3ac6da6de6feca4a8abfca2fc71984bcbc44dcd83a3d7ead72969',changes:'9bcae0fdb7383a3cb227e830c13bbb4e52c6dc42cc60139c41c68741b6dcc71e'}},
  range6:{requestId:'card-lab-final-range-6-20261013',materialDigest:'f21670d3bb5c8fb8e1eb7c6c25f9c8eae126eb867481e61f7b5d3dc66821e680',artifactDigest:'8513feb97c9ce4b3bbe94b0221e1a66a384184e9838f9604f031b8c32291fae4',hostRecordDigest:'23650f00b33b6509c03b6f320863d03526db7f7513a03b0efafb52b6ed00f460',sections:{requirements:'dde9d93daaee2ac0cbcdd952e9c77d449868f1a5e4f0e3c771bcde1c5eb96f31',changes:'8caf60450c0cdebadca255ac37ce73acedea3e065f078e6a4daae8ee6e6ffa79'}},
  blockers:['1d71a3caf3534adfeddbe06d200fd6828bab4a37a93f344dc55714e0cff5b6b2','49475515cd6895cf3eb2a48939da51bca92c0312c0a7d03ed303724dde5f3686','5edc6b370e4e38418abe80a48ca3ec650b96ab0fee8566379a4eccb96f3343dd','5fa45d7d7851b980c4256eb509d41e9355ac4cfdfecb13d2b8ba397235c6ef78','61ab752db23346f74352c61dc7c395f234043ffc8470dfd7ba0c15e43b5fd2f7','6b240d3e5b74ae1108cb0bb3b7e21b9ceb53d6b2cdb9a1418c730f38b9930fd5','75dfc6d0f41da5538cb2a6ea2f018c0ae9ec17d836ff6de067be1b1c897589a4']
});
function quota15Prefix(data) {
  return data.attempts.length >= 13 && data.attempts.slice(0,13).every(row => row.status !== 'released') &&
    hash(JSON.stringify(data.attempts.slice(0,13))) === QUOTA15.first13AttemptsSha256 &&
    hash(JSON.stringify(data.attempts.slice(0,13).map(row => [row.requestId,data.decisions[row.requestId]]))) === QUOTA15.first13DecisionsSha256;
}
function quota15Identity(input, limits) {
  return limits.totalCap === 15 && limits.authorizationReference === QUOTA15.authorizationReference && input.workspaceSha256 === QUOTA15.workspaceSha256 &&
    input.runAnchorSha256 === QUOTA15.runAnchorSha256 && input.parentRunId === QUOTA15.parentRunId && input.phaseIndex === 2 && input.stage === 'post-review';
}
function quota15SectionsMatch(actual, expected) {
  return actual && actual.requirements === expected.requirements && actual.changes === expected.changes;
}
function quota15Range5Eligible(data,input,limits) {
  const pin=QUOTA15.range5;
  if (!quota15Identity(input,limits) || !quota15Prefix(data) || data.attempts.length!==13 || data.attempts.filter(row=>row.status!=='released').length!==13 ||
      input.requestId!==pin.requestId || input.materialDigest!==pin.materialDigest || input.artifactDigest!==pin.artifactDigest || input.hostRecordDigest!==pin.hostRecordDigest ||
      input.progress?.previousReviewRequestId!==pin.previous || !quota15SectionsMatch(input.materialSections,pin.sections)) return false;
  const previous=data.attempts[12], prior=data.decisions[pin.previous];
  if (previous.requestId!==pin.previous || previous.status!=='finished' || previous.materialDigest!==pin.previousMaterialDigest || previous.artifactDigest!==input.artifactDigest ||
      previous.hostRecordDigest!==input.hostRecordDigest || !prior || prior.stage!=='post-review' || prior.phaseIndex!==2 || prior.materialDigest!==pin.previousMaterialDigest ||
      prior.artifactDigest!==input.artifactDigest || prior.hostRecordDigest!==input.hostRecordDigest || prior.decision.reviewDecision!=='insufficient-materials') return false;
  const blockers=reviewBlockers(prior.decision), paths=[['cancel/continue.'],[],[],[],['dist/index.html','import/commit'],[],['5/6','dist/app.mjs','progress/import/commit','source/test/tool/doc']];
  if (blockers.length!==7 || !same(blockers.map(item=>[item.key,item.paths]),QUOTA15.blockers.map((key,i)=>[key,paths[i]]))) return false;
  const closures=input.progress.closures;
  const expected=QUOTA15.blockers.map((key,i)=>[key,[1,2,3,5].includes(i)?['materials/range5']:paths[i],QUOTA15.reportSha256]);
  return closures.length===7 && same(closures.map(({key,paths,evidence})=>[key,paths,evidence]).sort(([a],[b])=>a.localeCompare(b)),expected.sort(([a],[b])=>a.localeCompare(b)));
}
function quota15Range6Eligible(data,input,limits) {
  const pin=QUOTA15.range6;
  if (!quota15Identity(input,limits) || !quota15Prefix(data) || data.attempts.length!==14 || data.attempts.filter(row=>row.status!=='released').length!==14 ||
      input.requestId!==pin.requestId || input.materialDigest!==pin.materialDigest || input.artifactDigest!==pin.artifactDigest || input.hostRecordDigest!==pin.hostRecordDigest || !quota15SectionsMatch(input.materialSections,pin.sections)) return false;
  const retry=data.attempts[13], prior=retry && data.decisions[retry.requestId];
  return retry.requestId===QUOTA15.range5.requestId && retry.stage==='post-review' && retry.phaseIndex===2 && retry.parentRunId===QUOTA15.parentRunId &&
    retry.status==='finished' && retry.progressVerified && retry.materialDigest===QUOTA15.range5.materialDigest && retry.artifactDigest===QUOTA15.range5.artifactDigest &&
    retry.hostRecordDigest===QUOTA15.range5.hostRecordDigest && prior?.stage==='post-review' && prior.phaseIndex===2 && prior.materialDigest===QUOTA15.range5.materialDigest &&
    prior.artifactDigest===QUOTA15.range5.artifactDigest && prior.hostRecordDigest===QUOTA15.range5.hostRecordDigest && ['approve','conditional-approve'].includes(prior.decision.reviewDecision);
}

const QUOTA16 = Object.freeze({
  authorizationReference:'user-approval:quota16:b26b7a24e8d70f34812fc74524620c4bbd66beb9012aa661c8a15c50496c7120',
  workspaceSha256:'3149a065938db19874bfdbcce8d6de2ca9c27645fa38f353cbd5c8245691d149',
  runAnchorSha256:'b991be558d49d9847f0eb12560d2cd2f1873b1f69146678a9e13b06d1286b062', parentRunId:'infalsus-card-lab-20261012',
  first14AttemptsSha256:'d70bb74ea953bccb7caeaec1bbc9a68421f08ce87e3c715ab39f5f8807e80c95',
  first14DecisionsSha256:'3334332ecd09229a8f07c5c36112a77e209086a88cb7f79ab61a62c088bb6d2c',
  timeoutRequestId:'card-lab-final-range-5-material-reconsideration-20261014',
  range5:{requestId:'card-lab-final-range-5-material-timeout-recovery-20261014',materialDigest:'ab927d179bb3d4eabfd05b544a7e33d235bc2041bf9a203c68aaebb65edf3887',artifactDigest:'be00d50cbcff3d58faf3ea0a6c025b2d31d9782d94a35a138866a1412fd00dff',hostRecordDigest:'446ccd9bbaa37ab8e0fdacf7f2a6e6ad27e63c69249a8fab5c2c5dc195fcc2bb',previous:'card-lab-final-range-5-20261013',sections:{requirements:'fd4338db5ba3ac6da6de6feca4a8abfca2fc71984bcbc44dcd83a3d7ead72969',changes:'9bcae0fdb7383a3cb227e830c13bbb4e52c6dc42cc60139c41c68741b6dcc71e'}},
  range6:{requestId:'card-lab-final-range-6-20261013',materialDigest:'f21670d3bb5c8fb8e1eb7c6c25f9c8eae126eb867481e61f7b5d3dc66821e680',artifactDigest:'8513feb97c9ce4b3bbe94b0221e1a66a384184e9838f9604f031b8c32291fae4',hostRecordDigest:'23650f00b33b6509c03b6f320863d03526db7f7513a03b0efafb52b6ed00f460',sections:{requirements:'dde9d93daaee2ac0cbcdd952e9c77d449868f1a5e4f0e3c771bcde1c5eb96f31',changes:'8caf60450c0cdebadca255ac37ce73acedea3e065f078e6a4daae8ee6e6ffa79'}},
  reportSha256:'8057236fc37780e35489e3420cec7fd6dec8950d6e11b68a427dbd186604dcec'
});
const QUOTA17 = Object.freeze({
  authorizationReference:'user-approval:quota17:a8e306108b7fdd6762f9ab6c67f46a303e50bc425f214e5971ed120668aaf99d',
  workspaceSha256:'3149a065938db19874bfdbcce8d6de2ca9c27645fa38f353cbd5c8245691d149',
  runAnchorSha256:'b991be558d49d9847f0eb12560d2cd2f1873b1f69146678a9e13b06d1286b062', parentRunId:'infalsus-card-lab-20261012',
  first16AttemptsSha256:'78daf3670fcf0cd5498a67a35cb4b233e36a594e9a57d8538fa5cacba23d6561',
  first16DecisionsSha256:'66b7b9c961944812687a859401fd7c32e3aa315b0d770eb99618461b75543063',
  previous:'card-lab-final-range-6-20261013', requestId:'card-lab-final-range-6-material-reconsideration-20261014',
  previousMaterialDigest:'f21670d3bb5c8fb8e1eb7c6c25f9c8eae126eb867481e61f7b5d3dc66821e680',
  materialDigest:'cf222cdbea3f4d9fcb3eb3df7a42ff578192eeed0a2e272d8254b89a2fdede8a',
  artifactDigest:'8513feb97c9ce4b3bbe94b0221e1a66a384184e9838f9604f031b8c32291fae4',
  hostRecordDigest:'23650f00b33b6509c03b6f320863d03526db7f7513a03b0efafb52b6ed00f460',
  sections:{requirements:'aff602a91426e3a8c14a23f3372c1b4c3c5f116800f3019aeaacf6ae737322a7',changes:'e44a45ecace60beee09a6f52123e18c8e5b917541cf6fee007761c465b95f88b'},
  reportSha256:'8cc5b79656932534c0d16a100c60790818ec2077aafb10e0874cecf512bd8647',
  blockers:['3cfc9bbfac23e7d21a8ec4d89c2fc9e2f4fe41d5ec401827001bb9d69c1c2759','3f622ba4f06cd738b4f043517947c0fed873669e1e1b4730b415c13bbbdb1e3e','665885e2c16b9d50215552b2ce9718747d0ac7215ca87c57992101ed636b4f77','6b38b7a61f6435b3a925f1f04e9614f4dd32d43c6fc2e4f0895b0cf96dd3f70e','fb476455718937fd9e3dbdf1c4f84817b1a273598f27045d31ca6393d958ea08']
});
function quota17Prefix(data) {
  const attempts=data.attempts.slice(0,16);
  return hash(JSON.stringify(attempts))===QUOTA17.first16AttemptsSha256 &&
    hash(JSON.stringify(attempts.map(row=>[row.requestId,data.decisions[row.requestId]])))===QUOTA17.first16DecisionsSha256;
}
function quota17Identity(input,limits) {
  return limits.totalCap===17 && limits.authorizationReference===QUOTA17.authorizationReference && input.workspaceSha256===QUOTA17.workspaceSha256 &&
    input.runAnchorSha256===QUOTA17.runAnchorSha256 && input.parentRunId===QUOTA17.parentRunId && input.phaseIndex===2 && input.stage==='post-review';
}
function quota17Eligible(data,input,limits) {
  if(!quota17Identity(input,limits))return false;
  if(data.attempts.length!==16)return false;
  if(data.attempts.some(row=>row.status==='released'))return false;
  if(!quota17Prefix(data))return false;
  if(input.requestId!==QUOTA17.requestId)return false;
  const pin=QUOTA17,previous=data.attempts[15],prior=data.decisions[pin.previous];
  if(input.materialDigest!==pin.materialDigest||input.artifactDigest!==pin.artifactDigest||input.hostRecordDigest!==pin.hostRecordDigest||
    !quota15SectionsMatch(input.materialSections,pin.sections)||input.progress?.previousReviewRequestId!==pin.previous||
    data.attempts.slice(0,16).some(row=>row.stage==='post-review'&&row.materialDigest===input.materialDigest))return false;
  if(previous.requestId!==pin.previous||previous.stage!=='post-review'||previous.phaseIndex!==2||previous.parentRunId!==pin.parentRunId||previous.status!=='finished'||
    !previous.started||!previous.timeKnown||previous.outcome!=='execution-finished'||previous.materialDigest!==pin.previousMaterialDigest||
    previous.artifactDigest!==pin.artifactDigest||previous.hostRecordDigest!==pin.hostRecordDigest||
    !prior||prior.stage!=='post-review'||prior.phaseIndex!==2||prior.materialDigest!==pin.previousMaterialDigest||prior.artifactDigest!==pin.artifactDigest||
    prior.hostRecordDigest!==pin.hostRecordDigest||prior.decision.reviewDecision!=='insufficient-materials')return false;
  const blockers=reviewBlockers(prior.decision),paths={'665885e2c16b9d50215552b2ce9718747d0ac7215ca87c57992101ed636b4f77':['import/commit','tools/compile-rules.mjs']};
  if(blockers.length!==5||!same(blockers.map(item=>[item.key,item.paths]),pin.blockers.map(key=>[key,paths[key]||[]])))return false;
  const closures=input.progress.closures,expected=pin.blockers.map(key=>[key,paths[key]||['materials/range6'],pin.reportSha256]);
  return closures.length===5&&same(closures.map(({key,paths,evidence})=>[key,paths,evidence]).sort(([a],[b])=>a.localeCompare(b)),expected.sort(([a],[b])=>a.localeCompare(b)));
}

function quota16Prefix(data) {
  return data.attempts.length >= 14 && data.attempts.slice(0,14).every(row=>row.status!=='released') &&
    hash(JSON.stringify(data.attempts.slice(0,14)))===QUOTA16.first14AttemptsSha256 &&
    hash(JSON.stringify(data.attempts.slice(0,14).map(row=>[row.requestId,data.decisions[row.requestId]])))===QUOTA16.first14DecisionsSha256;
}
function quota16Identity(input,limits) {
  return limits.totalCap===16 && limits.authorizationReference===QUOTA16.authorizationReference && input.workspaceSha256===QUOTA16.workspaceSha256 &&
    input.runAnchorSha256===QUOTA16.runAnchorSha256 && input.parentRunId===QUOTA16.parentRunId && input.phaseIndex===2 && input.stage==='post-review';
}
function quota16Range5Eligible(data,input,limits) {
  const pin=QUOTA16.range5, timeout=data.attempts[13], prior=data.decisions[pin.previous];
  if (!quota16Identity(input,limits)||!quota16Prefix(data)||data.attempts.length!==14||data.attempts.filter(row=>row.status!=='released').length!==14||
      input.requestId!==pin.requestId||input.materialDigest!==pin.materialDigest||input.artifactDigest!==pin.artifactDigest||input.hostRecordDigest!==pin.hostRecordDigest||
      input.progress?.previousReviewRequestId!==pin.previous||!quota15SectionsMatch(input.materialSections,pin.sections)||!timeout||timeout.requestId!==QUOTA16.timeoutRequestId||
      timeout.stage!=='post-review'||timeout.phaseIndex!==2||timeout.parentRunId!==QUOTA16.parentRunId||timeout.status!=='finished'||!timeout.started||!timeout.timeKnown||
      timeout.outcome!=='execution-finished'||timeout.reservedMs!==140000||timeout.elapsedMs!==136302||!timeout.progressVerified||data.decisions[timeout.requestId]||
      !prior||prior.stage!=='post-review'||prior.phaseIndex!==2||prior.materialDigest!==QUOTA15.range5.previousMaterialDigest||prior.artifactDigest!==QUOTA15.range5.artifactDigest||
      prior.hostRecordDigest!==QUOTA15.range5.hostRecordDigest||prior.decision.reviewDecision!=='insufficient-materials') return false;
  const blockers=reviewBlockers(prior.decision), paths=[['cancel/continue.'],[],[],[],['dist/index.html','import/commit'],[],['5/6','dist/app.mjs','progress/import/commit','source/test/tool/doc']];
  if(blockers.length!==7||!same(blockers.map(item=>[item.key,item.paths]),QUOTA15.blockers.map((key,i)=>[key,paths[i]])))return false;
  const closures=input.progress.closures, expected=QUOTA15.blockers.map((key,i)=>[key,[1,2,3,5].includes(i)?['materials/range5']:paths[i],QUOTA16.reportSha256]);
  return closures.length===7&&same(closures.map(({key,paths,evidence})=>[key,paths,evidence]).sort(([a],[b])=>a.localeCompare(b)),expected.sort(([a],[b])=>a.localeCompare(b)));
}
function quota16Range6Eligible(data,input,limits) {
  const pin=QUOTA16.range6;
  if(!quota16Identity(input,limits)||!quota16Prefix(data)||data.attempts.length!==15||data.attempts.filter(row=>row.status!=='released').length!==15||
    input.requestId!==pin.requestId||input.materialDigest!==pin.materialDigest||input.artifactDigest!==pin.artifactDigest||input.hostRecordDigest!==pin.hostRecordDigest||!quota15SectionsMatch(input.materialSections,pin.sections))return false;
  const recovery=data.attempts[14],decision=recovery&&data.decisions[recovery.requestId];
  return recovery.requestId===QUOTA16.range5.requestId&&recovery.stage==='post-review'&&recovery.phaseIndex===2&&recovery.parentRunId===QUOTA16.parentRunId&&
    recovery.status==='finished'&&recovery.started&&recovery.timeKnown&&recovery.progressVerified&&recovery.materialDigest===QUOTA16.range5.materialDigest&&
    recovery.artifactDigest===QUOTA16.range5.artifactDigest&&recovery.hostRecordDigest===QUOTA16.range5.hostRecordDigest&&decision?.stage==='post-review'&&decision.phaseIndex===2&&
    decision.materialDigest===QUOTA16.range5.materialDigest&&decision.artifactDigest===QUOTA16.range5.artifactDigest&&decision.hostRecordDigest===QUOTA16.range5.hostRecordDigest&&
    ['approve','conditional-approve'].includes(decision.decision.reviewDecision);
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

function actionableFailure(decision) {
  if (!decision || !['request-changes', 'insufficient-materials'].includes(decision.reviewDecision)) return false;
  const blockers = reviewBlockers(decision);
  return blockers.length > 0 && blockers.every(blocker => blocker.paths.length > 0);
}

function recoverablePostHistory(data, history, currentVerified) {
  for (let index = 0; index < history.length; index++) {
    const attempt = history[index];
    const decision = data.decisions[attempt.requestId]?.decision;
    if (['approve', 'conditional-approve'].includes(decision?.reviewDecision)) continue;
    if (!actionableFailure(decision)) return false;
    const next = history[index + 1];
    if (!next) return index === history.length - 1 && currentVerified;
    if (!next.progressVerified || !['approve', 'conditional-approve'].includes(data.decisions[next.requestId]?.decision?.reviewDecision)) return false;
    index++;
  }
  return true;
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
    parentRunId: attempt.parentRunId, stage: attempt.stage, phaseIndex: attempt.phaseIndex, tier: data.identity.tier, replayed, timeoutSeconds });
}

export function createReviewAttemptLedger(directory, options = {}) {
  const grants = validateReviewQuotaExceptions(options.reviewQuotaExceptions ?? []);
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Object.freeze({
    reserve(input) {
      validate(input);
      const identity = { workspaceSha256: input.workspaceSha256, runAnchorSha256: input.runAnchorSha256, tier: input.tier };
      const key = hash(JSON.stringify({ workspaceSha256: input.workspaceSha256, runAnchorSha256: input.runAnchorSha256 }));
      return lock(dir, () => {
        bindParent(dir, input);
        const { data, path } = loadState(dir, key, identity, grants);
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

        const phase = input.phaseIndex || 1;
        const stageUsed = data.attempts.filter(attempt => attempt.status !== 'released' && attempt.stage === input.stage).length;
        const candidate = { stage: input.stage, phaseIndex: phase, parentRunId: input.parentRunId ?? null };
        const limits = effectiveReviewQuota(grants, identity, candidate);
        const quota15Range5 = quota15Range5Eligible(data, input, limits);
        const quota15Range6 = quota15Range6Eligible(data, input, limits);
        const quota16Range5 = quota16Range5Eligible(data,input,limits);
        const quota16Range6 = quota16Range6Eligible(data,input,limits);
        if (limits.totalCap === 17 && !quota17Eligible(data,input,limits)) throw new ReviewAttemptError(LIMIT, 'Quota17 admits only the pinned final material reconsideration');
        if (limits.totalCap === 16 && !quota16Range5 && !quota16Range6) throw new ReviewAttemptError(LIMIT, 'Quota16 admits only the pinned timeout recovery followed by original range6');
        if (limits.totalCap === 15 && !quota15Range5 && !quota15Range6) throw new ReviewAttemptError(LIMIT, 'Quota15 admits only the pinned range5 reconsideration followed by original range6');
        const consumed = data.attempts.filter(attempt => attempt.status !== 'released');
        const approved = Object.values(data.decisions).some(decision => decision.stage === input.stage && decision.phaseIndex === phase &&
          ['approve', 'conditional-approve'].includes(decision.decision.reviewDecision));
        const sameApprovedContent = approved && data.attempts.some(attempt => attempt.stage === input.stage && attempt.phaseIndex === phase &&
          attempt.status === 'finished' && ['approve', 'conditional-approve'].includes(data.decisions[attempt.requestId]?.decision.reviewDecision) &&
          (input.stage === 'post-review' ? input.artifactDigest != null && attempt.artifactDigest === input.artifactDigest :
            attempt.materialDigest === (input.materialDigest || null)));
        if (sameApprovedContent) throw new ReviewAttemptError(LIMIT, 'Review already approved for unchanged material/artifact');
        if (stalled(data, input)) throw new ReviewAttemptError(LIMIT, 'Review retries stopped after consecutive non-progress blocker sets');

        const evidenceOnlyReconsideration = input.stage === 'post-review' && evidenceReconsiderationEligible(data, input, limits);
        const quota17Material = limits.totalCap === 17 && quota17Eligible(data,input,limits);
        const verified = progressEligible(data, input) || evidenceOnlyReconsideration || quota15Range5 || quota16Range5 || quota17Material;
        const extendedGrant = limits.grantId !== undefined && limits.totalCap > 6;
        const phasePostHistory = consumed.filter(attempt => attempt.stage === 'post-review' && attempt.phaseIndex === phase && attempt.parentRunId === candidate.parentRunId);
        const postHistoryApproved = phasePostHistory.every(attempt => ['approve', 'conditional-approve'].includes(data.decisions[attempt.requestId]?.decision.reviewDecision));
        const postRecoveryAllowed = quota15Range5 || quota15Range6 || quota16Range5 || quota16Range6 || quota17Material || ([13, 14].includes(limits.totalCap) && recoverablePostHistory(data, phasePostHistory, verified));
        const postDigestsDistinct = evidenceOnlyReconsideration || quota15Range5 || quota16Range5 || quota17Material || ['materialDigest', 'artifactDigest', 'hostRecordDigest'].every(key => input[key] &&
          phasePostHistory.every(attempt => attempt[key] !== input[key]));
        const authorizedPost = extendedGrant && input.stage === 'post-review' && phase === 2 && candidate.parentRunId === limits.parentRunId;
        if (authorizedPost && (!input.materialDigest || !input.artifactDigest || !input.hostRecordDigest || !(postHistoryApproved || postRecoveryAllowed) || !postDigestsDistinct)) {
          throw new ReviewAttemptError(LIMIT, 'Authorized post-review requires approved prior reviews and distinct complete host evidence');
        }
        const priorAuthorizedExtension = data.attempts.some(attempt => attempt.status !== 'released' && attempt.extension &&
          attempt.stage === input.stage && attempt.phaseIndex === phase && attempt.parentRunId === candidate.parentRunId);
        const latestPhasePost = [...phasePostHistory].at(-1);
        const latestPostDecision = latestPhasePost && data.decisions[latestPhasePost.requestId]?.decision;
        const latestPhasePre = [...consumed].reverse().find(attempt => attempt.stage === 'pre-review' && attempt.phaseIndex === phase);
        const sectionsChanged = latestPhasePre && input.materialSections && Object.keys(input.materialSections).some(name =>
          latestPhasePre.materialSections[name] !== input.materialSections[name]);
        const recoverablePre = [13, 14].includes(limits.totalCap) && input.stage === 'pre-review' && phase === 2 && stageUsed === 3 &&
          latestPhasePost?.status === 'finished' && actionableFailure(latestPostDecision) && input.materialDigest &&
          input.materialDigest !== latestPhasePre?.materialDigest && sectionsChanged;
        const authorizedPreSlot = limits.grantId !== undefined && input.stage === 'pre-review' && phase === 2 &&
          (([13, 14].includes(limits.totalCap) && stageUsed === 3 && recoverablePre) || (!approved && stageUsed === 2 && !priorAuthorizedExtension));
        const authorizedGenericSlot = limits.grantId !== undefined && !extendedGrant && !approved && stageUsed === 2 && !priorAuthorizedExtension;
        const authorizedPostSlot = authorizedPost && stageUsed >= 2 && stageUsed < limits.stage && (postHistoryApproved || postRecoveryAllowed) && postDigestsDistinct;
        const authorizedSlot = authorizedPreSlot || authorizedGenericSlot || authorizedPostSlot;
        const ordinaryExtension = !approved && stageUsed >= limits.base && verified && !data.extensionUsed;
        const extension = authorizedSlot || ordinaryExtension;
        const hasNonTupleExtension = data.attempts.some(attempt => attempt.status !== 'released' && attempt.extension && !effectiveReviewQuota(grants, identity, attempt).grantId);
        const mixedWouldExceed = (consumed.length + 1 > LIMITS[input.tier].total || (extension && data.extensionUsed)) && (!authorizedSlot || hasNonTupleExtension);
        if (mixedWouldExceed || consumed.length >= limits.total || stageUsed >= limits.stage || (stageUsed >= limits.base && !extension)) {
          throw new ReviewAttemptError(LIMIT, `Review quota exhausted (${input.tier} ${input.stage}: base ${limits.base}, extension ${data.extensionUsed ? 'used' : 'unavailable'}, stage ${limits.stage}, total ${limits.total})`,
            { tier: input.tier, stage: input.stage, used: consumed.length, stageUsed, base: limits.base, remainingBase: Math.max(0, limits.base - stageUsed), sharedExtraRemaining: Math.max(0, (limits.sharedExtensions ?? 1) - consumed.filter(attempt => attempt.extension).length), stageCap: limits.stage, remainingStage: Math.max(0, limits.stage - stageUsed), totalCap: limits.total, remainingTotal: Math.max(0, limits.total - consumed.length), extensionUsed: data.extensionUsed, extensionEligible: extension, extensionEligibilityReason: authorizedSlot ? 'authorized phase continuation' : data.extensionUsed ? 'shared extension consumed' : 'trusted relevant progress and matching host proof required', nextAction: 'review trusted blocker progress and policy gates before retrying' });
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
        validateState(data, key, identity, grants);
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
        if (!started && attempt.extension) data.extensionUsed = data.attempts.some(item => item.attemptId !== attempt.attemptId && item.extension && item.status !== 'released');
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
        const { data } = loadState(dir, key, { workspaceSha256: input.workspaceSha256, runAnchorSha256: input.runAnchorSha256, tier: input.tier }, grants);
        return JSON.parse(JSON.stringify(data));
      });
    },
    _update(ticket, callback) {
      if (!ticket || ticket.replayed || !HEX.test(ticket.key || '') || !ID.test(ticket.requestId || '') || !ID.test(ticket.attemptId || '')) invalid('Invalid review ticket');
      return lock(dir, () => {
        const identity = { workspaceSha256: ticket.workspaceSha256, runAnchorSha256: ticket.runAnchorSha256, tier: ticket.tier };
        const { data, path } = loadState(dir, ticket.key, identity, grants);
        const attempt = data.attempts.find(item => item.attemptId === ticket.attemptId && item.requestId === ticket.requestId);
        if (!attempt) invalid('Unknown review ticket');
        callback(attempt, data);
        validateState(data, ticket.key, identity, grants);
        sync(path, `${JSON.stringify(data)}\n`);
        return { attemptId: attempt.attemptId, status: attempt.status, started: attempt.started, outcome: attempt.outcome };
      });
    },
  });
}
