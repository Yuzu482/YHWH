import { createHash } from 'node:crypto';

const fail = message => { throw new TypeError(message); };

function boundedString(value, name, max, { min = 1 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.trim() !== value) fail(`${name} must be a trimmed string of ${min}-${max} characters`);
  return value;
}
function list(value, name, min, max, itemMax) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${name} must contain ${min}-${max} items`);
  return value.map((item, i) => boundedString(item, `${name}[${i}]`, itemMax));
}
function absoluteCwd(value) {
  boundedString(value, 'cwd', 32768);
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+(?:[\\].*)?$/.test(value) || value.startsWith('/')) return value;
  fail('cwd must be an absolute Windows or POSIX path');
}
function scopePath(path) {
  boundedString(path, 'scope path', 1024);
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || /[*?\[\]{}]/.test(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('scope paths must be exact repository-relative paths without traversal or globs');
  return path;
}
function overlaps(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function planCooperativeRun(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('spec must be an object');
  const cwd = absoluteCwd(spec.cwd);
  const thinking = spec.thinking === undefined ? 'medium' : spec.thinking;
  if (thinking !== 'low' && thinking !== 'medium') fail('thinking must be low or medium');
  const parentRunId = boundedString(spec.parentRunId, 'parentRunId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parentRunId)) fail('invalid parentRunId');
  const runGoal = boundedString(spec.runGoal, 'runGoal', 600);
  const runAcceptance = list(spec.runAcceptance, 'runAcceptance', 1, 3, 240);
  if (!Array.isArray(spec.units) || spec.units.length < 2 || spec.units.length > 4) fail('units must contain 2-4 items');
  const ids = new Set(), allWrites = [];
  const units = spec.units.map((unit, index) => {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) fail(`units[${index}] must be an object`);
    const id = boundedString(unit.id, `units[${index}].id`, 64);
    const normalizedId = id.toLowerCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || ids.has(normalizedId)) fail('unit ids must be unique ASCII identifiers (case-insensitive)');
    ids.add(normalizedId);
    const objective = boundedString(unit.objective, `units[${index}].objective`, 600);
    const acceptance = list(unit.acceptance, `units[${index}].acceptance`, 1, 3, 240);
    const context = unit.context === undefined ? [] : list(unit.context, `units[${index}].context`, 0, 3, 400);
    if (unit.readScope !== undefined && !Array.isArray(unit.readScope)) fail(`units[${index}].readScope must be an array`);
    if (unit.writeScope !== undefined && !Array.isArray(unit.writeScope)) fail(`units[${index}].writeScope must be an array`);
    const readScope = unit.readScope === undefined ? [] : unit.readScope.map(scopePath);
    const writeScope = unit.writeScope === undefined ? [] : unit.writeScope.map(scopePath);
    if (readScope.length > 4 || writeScope.length > 2) fail('scope list exceeds its item limit');
    for (const path of writeScope) {
      if (allWrites.some(previous => overlaps(path, previous))) fail('writeScope paths overlap across units');
      allWrites.push(path);
    }
    return { id, objective, acceptance, context, readScope, writeScope };
  });
  const runAnchor = `cooperative-${createHash('sha256').update(JSON.stringify({ cwd, parentRunId, runGoal, runAcceptance, units, thinking })).digest('hex').slice(0, 24)}`;
  const requests = units.map(unit => {
    const task = {
      role: 'Chesed',
      objective: `${unit.id}: ${unit.objective}`,
      context: [...unit.context, `Shared run goal: ${runGoal}`, ...runAcceptance.map(item => `Shared acceptance: ${item}`), `Run anchor: ${runAnchor}`],
      acceptance: unit.acceptance,
      readScope: unit.readScope,
      writeScope: unit.writeScope,
    };
    const request = {
      requestId: `cooperative-${createHash('sha256').update(`${runAnchor}\0${unit.id}`).digest('hex').slice(0, 32)}`,
      parentRunId,
      provider: 'openai-codex', model: 'gpt-6-luna', thinking, resourceProfile: 'small', timeoutSeconds: 120,
      cwd, access: unit.writeScope.length ? 'workspace-write' : 'read', task,
    };
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 8192) fail('emitted request exceeds 8 KiB');
    Object.freeze(task.context);
    Object.freeze(task.acceptance);
    Object.freeze(task.readScope);
    Object.freeze(task.writeScope);
    Object.freeze(task);
    return Object.freeze(request);
  });
  return Object.freeze({ runAnchor, thinking, requests: Object.freeze(requests) });
}
