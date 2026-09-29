#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..', '..', '..');
const defaultBaselinePath = resolve(repositoryRoot, '.test', 'baseline-failures.json');

function normalizeTestFile(location) {
  if (!location) return 'unknown';
  const raw = location.replace(/:\d+:\d+$/, '');
  const rel = relative(repositoryRoot, resolve(raw));
  return rel ? rel.split('\\').join('/') : '.';
}

function parseLocation(block) {
  const entry = block.find((line) => /^\s*location:\s*/.test(line));
  if (!entry) return { file: 'unknown', line: null };
  const value = entry.replace(/^\s*location:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
  const match = value.match(/^(.*):(\d+):(\d+)$/);
  return match ? { file: normalizeTestFile(match[1]), line: Number(match[2]) } : { file: normalizeTestFile(value), line: null };
}

function conciseError(block) {
  const index = block.findIndex((entry) => /^\s*error:\s*/.test(entry));
  if (index < 0) return 'Test failed without an error summary.';
  const first = block[index].replace(/^\s*error:\s*/, '').trim();
  const candidates = first && !['|', '|-', '>', '>-'].includes(first) ? [first] : [];
  for (let cursor = index + 1; cursor < block.length; cursor += 1) {
    const entry = block[cursor];
    if (/^\s*(?:code|name|operator|stack|failureType|error):\s*/.test(entry)) break;
    const content = entry.replace(/^\s+/, '').trim();
    if (content && content !== '...' && content !== '|-' && content !== '|') { candidates.push(content); break; }
  }
  const summary = candidates.join(' ').replace(/\u001b\[[0-9;]*m/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[PATH]')
    .replace(/\\\\[^\\\s]+\\[^\\\s]+/g, '[PATH]')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^ ,;]+/gi, '$1=[REDACTED]');
  return (summary || 'Test failed without an error summary.').slice(0, 280);
}

export function parseTap(text) {
  if (typeof text !== 'string') throw new Error('Input is not a TAP log.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = lines.findIndex((line) => /^TAP version \d+\s*$/.test(line));
  if (header < 0) throw new Error('Input is not a TAP log (missing TAP version header).');
  // npm writes a short preamble before TAP. Nothing other than harmless npm headings may precede it.
  if (lines.slice(0, header).some((line) => line.trim() && !/^>/.test(line.trim()) && !/^npm\s/.test(line.trim()))) throw new Error('Unexpected content before TAP version header.');
  const points = [];
  const scopes = [{ indent: 0, points: [], plan: null }];
  const activeScopes = [scopes[0]];
  const stats = Object.create(null);
  const pointRe = /^(\s*)(not )?ok\s+(\d+)(?:\s+-\s+|\s+)(.*?)(?:\s+#\s*(SKIP|TODO)\b(?:.*))?\s*$/;
  const planRe = /^(\s*)1\.\.(\d+)(?:\s+#\s*(SKIP|TODO)\b.*)?\s*$/;
  for (let i = header + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*Bail out!/i.test(line)) throw new Error(`TAP bailout: ${line.trim()}`);
    const sm = line.match(/^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/i);
    if (sm) {
      const key = sm[1].toLowerCase();
      if (stats[key] !== undefined) throw new Error(`Duplicate TAP statistic: ${key}.`);
      stats[key] = Number(sm[2]);
      continue;
    }
    if (/^\s*not ok\b/.test(line) && !pointRe.test(line)) throw new Error(`Malformed TAP point: ${line.trim()}`);
    const plan = line.match(planRe);
    const point = line.match(pointRe);
    if (!plan && !point) continue;
    const indent = (plan ?? point)[1].length;
    while (activeScopes.length > 1 && indent < activeScopes.at(-1).indent) activeScopes.pop();
    let scope = activeScopes.at(-1);
    if (indent > scope.indent) {
      scope = { indent, points: [], plan: null };
      scopes.push(scope);
      activeScopes.push(scope);
    } else if (indent !== scope.indent) throw new Error('Malformed nested TAP indentation.');
    if (plan) {
      if (scope.plan !== null) throw new Error('Duplicate TAP plan in test scope.');
      scope.plan = Number(plan[2]);
      continue;
    }
    const number = Number(point[3]);
    if (number !== scope.points.length + 1) throw new Error(`TAP point sequence mismatch: expected ${scope.points.length + 1}, got ${number}.`);
    // Diagnostic YAML belongs only to this point; a sibling point starts a new block.
    const block = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*(?:not )?ok\b/.test(lines[j]) || /^\s*1\.\.\d+/.test(lines[j]) || /^#\s+(?:tests|pass|fail|cancelled|skipped|todo)\s+\d+\s*$/.test(lines[j])) break;
      block.push(lines[j]);
    }
    const name = point[4].trim();
    if (point[2] && !name) throw new Error(`Malformed TAP point: ${line.trim()}`);
    const failed = Boolean(point[2]) && !point[5];
    const source = parseLocation(block);
    const item = { id: '', name, file: source.file, line: source.line, failed, skipped: point[5] === 'SKIP', todo: point[5] === 'TODO', cancelled: /#\s*cancelled\b/i.test(line), suite: /^\s*type:\s*['"]?suite['"]?\s*$/m.test(block.join('\n')), ...(failed ? { errorSummary: conciseError(block) } : {}) };
    scope.points.push(item);
    points.push(item);
  }
  if (scopes[0].plan === null) throw new Error('TAP log must contain a root plan.');
  for (const scope of scopes) {
    if (scope.points.length && scope.plan === null) throw new Error('TAP test scope is missing a plan.');
    if (scope.plan !== null && scope.plan !== scope.points.length) throw new Error(`TAP plan mismatch: planned ${scope.plan}, parsed ${scope.points.length}.`);
  }
  for (const key of ['tests', 'pass', 'fail']) if (stats[key] === undefined) throw new Error(`TAP log is missing final ${key} statistic.`);
  const counted = points.filter((point) => !point.suite);
  const expected = {
    tests: counted.length,
    pass: counted.filter((point) => !point.failed && !point.skipped && !point.cancelled).length,
    fail: counted.filter((point) => point.failed && !point.todo && !point.skipped).length,
    cancelled: counted.filter((point) => point.cancelled).length,
    skipped: counted.filter((point) => point.skipped).length,
    todo: counted.filter((point) => point.todo).length,
  };
  for (const key of Object.keys(expected)) {
    if (stats[key] !== undefined && stats[key] !== expected[key]) throw new Error(`TAP ${key} count mismatch: summary reports ${stats[key]}, parsed ${expected[key]}.`);
  }
  if (stats.tests !== expected.tests || stats.pass !== expected.pass || stats.fail !== expected.fail) throw new Error('TAP statistics do not match parsed test points.');
  const ordinals = new Map();
  for (const item of points) {
    const key = `${item.file}::${item.name}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    item.id = `${key}::${ordinal}`;
    delete item.skipped; delete item.todo; delete item.cancelled; delete item.suite;
  }
  return { points, failures: points.filter((point) => point.failed) };
}

function readCommit(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unknown'; }
}

export function buildBaseline(parsed, { classification = 'B', commit = readCommit(repositoryRoot), sourceLog = 'unknown', createdAt = new Date().toISOString() } = {}) {
  if (classification !== 'A' && classification !== 'B') throw new Error('Classification must be A or B.');
  return { schemaVersion: 1, createdAt, commit, sourceLog: basename(sourceLog), failures: parsed.failures.map(({ id, name, file, line, errorSummary }) => ({ id, name, file, line, errorSummary, classification })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function compareBaseline(baseline, current) {
  if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.failures)) throw new Error('Baseline JSON must have schemaVersion 1 and a failures array.');
  const baselineById = new Map();
  for (const entry of baseline.failures) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.file !== 'string' || !entry.file.trim() || typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('Baseline entries require nonempty string id, file, and name fields.');
    if (entry.classification !== 'A' && entry.classification !== 'B') throw new Error(`Invalid classification for baseline entry ${entry.id}.`);
    if (baselineById.has(entry.id)) throw new Error(`Duplicate baseline id: ${entry.id}.`);
    baselineById.set(entry.id, entry);
  }
  const currentById = new Map(current.failures.map((failure) => [failure.id, failure]));
  return {
    newFailures: [...currentById.values()].filter((failure) => !baselineById.has(failure.id)).sort((a, b) => a.id.localeCompare(b.id)),
    fixed: [...baselineById.values()].filter((failure) => !currentById.has(failure.id)).sort((a, b) => a.id.localeCompare(b.id)),
    stillFailing: [...currentById.values()].filter((failure) => baselineById.has(failure.id)).map((failure) => ({ ...failure, classification: baselineById.get(failure.id).classification })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function parseArgs(argv) {
  const args = { baselinePath: defaultBaselinePath, classification: 'B' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--record' || arg === '--compare') {
      if (args.mode) throw new Error('Choose exactly one of --record or --compare.');
      args.mode = arg.slice(2); args.logPath = argv[++i];
      if (!args.logPath || args.logPath.startsWith('--')) throw new Error(`${arg} requires a log path.`);
    } else if (arg === '--baseline') {
      args.baselinePath = argv[++i]; if (!args.baselinePath || args.baselinePath.startsWith('--')) throw new Error('--baseline requires a JSON path.');
    } else if (arg === '--classification') {
      args.classification = argv[++i]; if (args.classification !== 'A' && args.classification !== 'B') throw new Error('--classification must be A or B.');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.mode || !args.logPath) throw new Error('Usage: test-baseline.mjs --record <log> [--classification A|B] [--baseline <json>] | --compare <log> [--baseline <json>]');
  if (args.mode === 'compare' && argv.includes('--classification')) throw new Error('--classification is only valid with --record.');
  return args;
}

function readTapFile(file) {
  const bytes = readFileSync(file);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le').replace(/^\uFEFF/, '');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    if (body.length % 2) throw new Error('Invalid UTF-16BE TAP log.');
    const swapped = Buffer.allocUnsafe(body.length);
    for (let i = 0; i < body.length; i += 2) { swapped[i] = body[i + 1]; swapped[i + 1] = body[i]; }
    return swapped.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

function writeBaseline(file, baseline) {
  const destination = resolve(file); mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' }); renameSync(temporary, destination); }
  finally { if (existsSync(temporary)) { try { unlinkSync(temporary); } catch { /* Preserve primary error. */ } } }
}
function printGroup(title, failures) { console.log(`${title} (${failures.length})`); for (const failure of failures) console.log(`  ${failure.id}${failure.classification ? ` [${failure.classification}]` : ''}`); }

export function runBaselineCommand(argv) {
  const options = parseArgs(argv);
  const parsed = parseTap(readTapFile(resolve(options.logPath)));
  if (options.mode === 'record') {
    const baseline = buildBaseline(parsed, { classification: options.classification, sourceLog: options.logPath });
    writeBaseline(options.baselinePath, baseline);
    console.log(`Recorded ${baseline.failures.length} baseline failures (${options.classification}) to ${options.baselinePath}.`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(resolve(options.baselinePath), 'utf8'));
  const comparison = compareBaseline(baseline, parsed);
  printGroup('New failures', comparison.newFailures); printGroup('Fixed', comparison.fixed); printGroup('Still failing', comparison.stillFailing);
  const unresolvedB = comparison.stillFailing.filter((failure) => failure.classification === 'B');
  if (unresolvedB.length) console.error(`Unresolved B-class baseline failures: ${unresolvedB.length}`);
  return comparison.newFailures.length || unresolvedB.length ? 1 : 0;
}

export function checkEntrypoint(invokedPath, modulePath = scriptPath) {
  const invoked = realpathSync(resolve(invokedPath));
  const module = realpathSync(resolve(modulePath));
  if (invoked !== module) throw new Error(`entrypoint mismatch: invoked ${invoked}, module ${module}.`);
  return true;
}
if (import.meta.main) {
  try {
    checkEntrypoint(process.argv[1]);
    process.exitCode = runBaselineCommand(process.argv.slice(2));
  } catch (error) { console.error(`test-baseline: ${error.message}`); process.exitCode = 2; }
}
