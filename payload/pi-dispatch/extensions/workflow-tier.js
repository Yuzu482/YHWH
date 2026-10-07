import { decodePatchHeader } from '../scripts/artifact-apply.mjs';
import { normalizeScopedPath } from './write-scope-guard.js';
const RISK_KEYS = ['publicApiOrProtocol', 'dependencyOrLockfile', 'securityAuthOrCredentials', 'migration', 'irreversibleOrNoRollback'];
const DECLARATION_KEYS = RISK_KEYS;
const TIERS = ['T0', 'T1', 'T2'];

function invalid(message) { throw Object.assign(new Error(message), { code: 'WORKFLOW_TIER_INVALID' }); }
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validFiles(files) {
  return Array.isArray(files) && files.length > 0
    && files.every(file => { try { return normalizeScopedPath(file).path === file; } catch { return false; } })
    && new Set(files).size === files.length;
}
function validWriteScope(scope) {
  return Array.isArray(scope) && scope.length > 0
    && scope.every(path => { try { const item = normalizeScopedPath(path, { scope: true }); return `${item.path}${item.tree ? '/**' : ''}` === path; } catch { return false; } })
    && new Set(scope).size === scope.length;
}
function validateDeclaration(declaration) {
  if (!exactKeys(declaration, DECLARATION_KEYS)) invalid('Invalid workflow tier declaration keys');
  if (RISK_KEYS.some(key => typeof declaration[key] !== 'boolean')) invalid('Risk flags must be booleans');
}
function testDocFixture(path) {
  if (/(?:^|\/)(?:tests?|__tests__|docs?|fixtures?)(?:\/|$)/i.test(path)) return true;
  const name = path.split('/').at(-1);
  if (/^(?:README|CHANGELOG|LICENSE)(?:\.(?:txt|md|mdx|rst|adoc|tex))?$/i.test(name)) return true;
  if (/\.(?:md|mdx|rst|adoc|tex)$/i.test(name)) return true;
  return /\.(?:test|spec)\.(?:js|mjs|cjs|jsx|ts|tsx|py)$/i.test(name);
}
function parseRange(text) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
  if (!match) return null;
  return { oldExpected: match[2] === undefined ? 1 : Number(match[2]), newExpected: match[4] === undefined ? 1 : Number(match[4]), old: 0, current: 0, added: 0, deleted: 0 };
}
function patchPath(text) {
  let path;
  try {path = decodePatchHeader(text);} catch {invalid('Invalid quoted patch path');}
  if (path === '/dev/null') return path;
  path = path.replace(/\\/g, '/');
  const rooted = path.match(/^\/var\/lib\/pi-kether\/jobs\/[0-9a-f-]{36}\/(?:baseline|workspace)\/(.+)$/i);
  if (rooted) path = rooted[1];
  else if (/^(?:a|b|old|new)\//.test(path)) path = path.slice(path.indexOf('/') + 1);
  try {if (normalizeScopedPath(path).path !== path) invalid('Unsafe unified patch path');} catch {invalid('Unsafe unified patch path');}
  return path;
}

// Strictly count unified-diff hunk bodies; metadata never contributes to line totals.
export function parseUnifiedPatch(patch) {
  if (typeof patch !== 'string' || !patch.length || patch.includes('\0')) invalid('Patch is empty or unavailable');
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let section = null, hunk = null, sawHeader = false;
  const finishHunkIfComplete = () => {
    if (hunk && hunk.old === hunk.oldExpected && hunk.current === hunk.newExpected) hunk = null;
  };
  const closeHunk = () => {
    if (hunk && (hunk.old !== hunk.oldExpected || hunk.current !== hunk.newExpected)) invalid('Malformed unified patch hunk counts');
    hunk = null;
  };
  const closeSection = () => {
    closeHunk();
    if (section) {
      if (!section.before || !section.after || !section.hunks || section.addedLines + section.deletedLines === 0) invalid('Incomplete or unchanged unified patch section');
      sections.push(section);
    }
    section = null; sawHeader = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === lines.length - 1 && line === '') continue;
    finishHunkIfComplete();
    if (!hunk && (line.startsWith('diff --git ') || /^diff -ruN\s/.test(line))) {
      closeSection(); section = { before:null, after:null, hunks:0, addedLines:0, deletedLines:0 }; continue;
    }
    if (!hunk && (line.startsWith('Binary files ') || line === 'GIT binary patch' || /^rename (?:from|to) /.test(line) || /^copy (?:from|to) /.test(line))) invalid('Binary and rename/copy patches are unverifiable');
    if (!hunk && line.startsWith('--- ')) {
      if (section?.before && section.hunks) { closeSection(); }
      if (!section) section = { before:null, after:null, hunks:0, addedLines:0, deletedLines:0 };
      if (section.before) invalid('Duplicate unified patch header');
      section.before = patchPath(line.slice(4)); continue;
    }
    if (!hunk && line.startsWith('+++ ')) {
      if (!section || !section.before || section.after) invalid('Malformed unified patch header');
      section.after = patchPath(line.slice(4));
      if (section.before !== '/dev/null' && section.after !== '/dev/null' && section.before !== section.after) invalid('Cross-path rename is unverifiable');
      if (section.before === '/dev/null' && section.after === '/dev/null') invalid('Invalid null-path patch');
      sawHeader = true; continue;
    }
    if (!hunk && line.startsWith('@@')) {
      if (!section || !sawHeader) invalid('Hunk lacks paired file headers');
      hunk = parseRange(line); if (!hunk) invalid('Malformed unified patch hunk header');
      if (![hunk.oldExpected,hunk.newExpected].every(Number.isSafeInteger)) invalid('Unsafe unified patch hunk count');
      section.hunks++; continue;
    }
    if (!hunk) {
      if (line === '\\ No newline at end of file') continue;
      if (/^(?:index |new file mode |deleted file mode |old mode |new mode |similarity index |--- |\+\+\+ |diff --git |diff -ruN )/.test(line)) continue;
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) invalid('Unexpected unified patch content outside a hunk');
      if (sawHeader && line) invalid('Unexpected unified patch metadata');
      continue;
    }
    if (line === '\\ No newline at end of file') continue;
    if (line.startsWith('+')) { hunk.added++; hunk.current++; section.addedLines++; }
    else if (line.startsWith('-')) { hunk.old++; section.deletedLines++; }
    else if (line.startsWith(' ')) { hunk.old++; hunk.current++; }
    else invalid('Malformed unified patch hunk body');
    if (hunk.old > hunk.oldExpected || hunk.current > hunk.newExpected) invalid('Malformed unified patch hunk counts');
  }
  closeSection();
  if (!sections.length || new Set(sections.map(s => s.after === '/dev/null' ? s.before : s.after)).size !== sections.length) invalid('Empty or duplicate-file patch');
  return sections.map(s => ({ files:[s.after === '/dev/null' ? s.before : s.after], addedLines:s.addedLines, deletedLines:s.deletedLines }));
}

export function classifyWorkflowTier({ files, addedLines, deletedLines, declaration, riskProfile = 'standard', sharedPath = false }) {
  if (!validFiles(files) || !Number.isSafeInteger(addedLines) || addedLines < 0 || !Number.isSafeInteger(deletedLines) || deletedLines < 0) invalid('Actual patch files and line counts are required');
  validateDeclaration(declaration);
  if (!['standard', 'personal', 'critical'].includes(riskProfile)) invalid('Unknown risk profile');
  const semanticRisk = RISK_KEYS.some(key => declaration[key]);
  const exempt = !semanticRisk && files.every(testDocFixture);
  const lines = addedLines + deletedLines;
  if (!Number.isSafeInteger(lines)) invalid('Unsafe unified patch line total');
  const base = semanticRisk ? 'T2' : (!exempt && (files.length > 3 || lines > 100 || sharedPath) ? 'T1' : 'T0');
  const effective = riskProfile === 'critical' ? (base === 'T0' ? 'T1' : base)
    : riskProfile === 'personal' ? (base === 'T2' ? 'T1' : base) : base;
  return { base, effective, riskProfile, files: files.length, addedLines, deletedLines, estimatedLines: lines, exempt };
}

export function validateWorkflowTier(declaration) {
  validateDeclaration(declaration);
  const level = RISK_KEYS.some(key => declaration[key]) ? 'T2' : 'T0';
  return { level, requiresPreReview: level === 'T2', requiresPostReview: level !== 'T0' };
}

export function validateDeclaredWorkflowTier(declaration, declaredLevel, writeScope) {
  if (!TIERS.includes(declaredLevel)) invalid('Unknown declared workflow tier');
  const required = validateWorkflowTier(declaration);
  if (!validWriteScope(writeScope)) invalid('Invocation writeScope must contain exact, unique relative paths or directory trees');
  if (TIERS.indexOf(declaredLevel) < TIERS.indexOf(required.level)) invalid(`Declared tier ${declaredLevel} is below minimum tier ${required.level}`);
  return { declaredLevel, minimumLevel: required.level, level: declaredLevel,
    requiresPreReview: declaredLevel === 'T2', requiresPostReview: declaredLevel !== 'T0' };
}
