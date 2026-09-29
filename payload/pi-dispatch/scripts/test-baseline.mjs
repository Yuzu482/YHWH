#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..', '..', '..');
const defaultBaselinePath = resolve(repositoryRoot, '.test', 'baseline-failures.json');

function normalizeTestFile(location) {
  if (!location) return 'unknown';
  const normalized = location.replaceAll('\\', '/').replace(/\/+/g, '/');
  const match = normalized.match(/(?:^|\/)((?:tests|scripts)\/[^:]+?):\d+:\d+$/);
  return match ? match[1].replace(/\/+/g, '/') : basename(normalized.replace(/:\d+:\d+$/, ''));
}

function parseLocation(block) {
  const line = block.find((entry) => /^\s*location:\s*/.test(entry));
  if (!line) return { file: 'unknown', line: null };
  const value = line.replace(/^\s*location:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
  const match = value.match(/^(.*):(\d+):(\d+)$/);
  if (!match) return { file: normalizeTestFile(value), line: null };
  return { file: normalizeTestFile(value), line: Number(match[2]) };
}

function conciseError(block) {
  const index = block.findIndex((entry) => /^\s*error:\s*/.test(entry));
  if (index < 0) return 'Test failed without an error summary.';
  const header = block[index].replace(/^\s*error:\s*/, '').trim();
  const candidates = header && !['|', '|-', '>', '>-'].includes(header) ? [header] : [];
  for (let cursor = index + 1; cursor < block.length; cursor += 1) {
    const entry = block[cursor];
    if (/^\s*(?:code|name|operator|stack|failureType|error):\s*/.test(entry)) break;
    const content = entry.replace(/^\s+/, '').trim();
    if (!content || content === '...' || content === '|-' || content === '|') continue;
    candidates.push(content);
    break;
  }
  const summary = candidates.join(' ').replace(/\u001b\[[0-9;]*m/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const redacted = summary
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[PATH]')
    .replace(/\\\\[^\\\s]+\\[^\\\s]+/g, '[PATH]')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^ ,;]+/gi, '$1=[REDACTED]');
  return (redacted || 'Test failed without an error summary.').slice(0, 280);
}

export function parseTap(text) {
  if (typeof text !== 'string' || !/^TAP version \d+\s*$/m.test(text)) {
    throw new Error('Input is not a TAP log (missing TAP version header).');
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const points = [];
  for (let index = 0; index < lines.length; index += 1) {
    const point = lines[index].match(/^(not )?ok\s+(\d+)(?:\s+-\s+|\s+)(.*?)(?:\s+#.*)?$/);
    if (!point) continue;
    const block = [];
    for (let cursor = index + 1; cursor < lines.length && !/^(?:not )?ok\s+\d+(?:\s+-\s+|\s+)/.test(lines[cursor]); cursor += 1) {
      block.push(lines[cursor]);
    }
    const failed = Boolean(point[1]);
    const { file, line } = failed ? parseLocation(block) : { file: 'unknown', line: null };
    const name = point[3].trim();
    points.push({
      id: `${file}::${name}`,
      name,
      file,
      line,
      failed,
      ...(failed ? { errorSummary: conciseError(block) } : {}),
    });
  }
  const summaryLine = lines.find((line) => /^#\s+fail\s+\d+\s*$/.test(line));
  const reportedFailures = summaryLine ? Number(summaryLine.match(/\d+/)[0]) : null;
  if (points.length === 0) throw new Error('TAP log contains no test points.');
  const failures = points.filter((point) => point.failed);
  if (reportedFailures !== null && reportedFailures !== failures.length) {
    throw new Error(`TAP failure count mismatch: summary reports ${reportedFailures}, parsed ${failures.length}.`);
  }
  return { points, failures };
}

function readCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

export function buildBaseline(parsed, { classification = 'B', commit = readCommit(repositoryRoot), sourceLog = 'unknown', createdAt = new Date().toISOString() } = {}) {
  if (!['A', 'B'].includes(classification)) throw new Error('Classification must be A or B.');
  return {
    schemaVersion: 1,
    createdAt,
    commit,
    sourceLog: basename(sourceLog),
    failures: parsed.failures.map(({ id, name, file, line, errorSummary }) => ({
      id,
      name,
      file,
      line,
      errorSummary,
      classification,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function compareBaseline(baseline, current) {
  if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.failures)) {
    throw new Error('Baseline JSON must have schemaVersion 1 and a failures array.');
  }
  const baselineById = new Map(baseline.failures.map((failure) => [failure.id, failure]));
  const currentById = new Map(current.failures.map((failure) => [failure.id, failure]));
  return {
    newFailures: [...currentById.values()].filter((failure) => !baselineById.has(failure.id)).sort((a, b) => a.id.localeCompare(b.id)),
    fixed: [...baselineById.values()].filter((failure) => !currentById.has(failure.id)).sort((a, b) => a.id.localeCompare(b.id)),
    stillFailing: [...currentById.values()].filter((failure) => baselineById.has(failure.id)).map((failure) => ({
      ...failure,
      classification: baselineById.get(failure.id).classification,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function parseArgs(argv) {
  const args = { baselinePath: defaultBaselinePath, classification: 'B' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--record' || argument === '--compare') {
      if (args.mode) throw new Error('Choose exactly one of --record or --compare.');
      args.mode = argument.slice(2);
      args.logPath = argv[++index];
      if (!args.logPath || args.logPath.startsWith('--')) throw new Error(`${argument} requires a log path.`);
    } else if (argument === '--baseline') {
      args.baselinePath = argv[++index];
      if (!args.baselinePath || args.baselinePath.startsWith('--')) throw new Error('--baseline requires a JSON path.');
    } else if (argument === '--classification') {
      args.classification = argv[++index];
      if (!['A', 'B'].includes(args.classification)) throw new Error('--classification must be A or B.');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!args.mode || !args.logPath) throw new Error('Usage: test-baseline.mjs --record <log> [--classification A|B] [--baseline <json>] | --compare <log> [--baseline <json>]');
  if (args.mode === 'compare' && argv.includes('--classification')) throw new Error('--classification is only valid with --record.');
  return args;
}

function writeBaseline(file, baseline) {
  const destination = resolve(file);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* Preserve the primary error. */ }
    }
  }
}

function printGroup(title, failures) {
  console.log(`${title} (${failures.length})`);
  for (const failure of failures) {
    const suffix = failure.classification ? ` [${failure.classification}]` : '';
    console.log(`  ${failure.id}${suffix}`);
  }
}

export function runBaselineCommand(argv) {
  const options = parseArgs(argv);
  const logPath = resolve(options.logPath);
  const parsed = parseTap(readFileSync(logPath, 'utf8'));
  if (options.mode === 'record') {
    const baseline = buildBaseline(parsed, { classification: options.classification, sourceLog: logPath });
    writeBaseline(options.baselinePath, baseline);
    console.log(`Recorded ${baseline.failures.length} baseline failures (${options.classification}) to ${options.baselinePath}.`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(resolve(options.baselinePath), 'utf8'));
  const comparison = compareBaseline(baseline, parsed);
  printGroup('New failures', comparison.newFailures);
  printGroup('Fixed', comparison.fixed);
  printGroup('Still failing', comparison.stillFailing);
  const unresolvedB = comparison.stillFailing.filter((failure) => failure.classification === 'B');
  if (unresolvedB.length) console.error(`Unresolved B-class baseline failures: ${unresolvedB.length}`);
  return comparison.newFailures.length || unresolvedB.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = runBaselineCommand(process.argv.slice(2));
  } catch (error) {
    console.error(`test-baseline: ${error.message}`);
    process.exitCode = 2;
  }
}
