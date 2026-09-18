import { freemem, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateKetherResult } from '../extensions/result-format-validator.js';

const args = new Set(process.argv.slice(2));
const smoke = args.has('--smoke');
if (!smoke && !args.has('--execute')) throw new Error('Real Pi calls are disabled by default; pass --execute for 50-100 tasks or --smoke for one task');
const requestedCount = Number(process.env.PI_LONG_RUN_COUNT || (smoke ? 1 : 50));
if (!Number.isInteger(requestedCount) || (smoke ? requestedCount !== 1 : requestedCount < 50 || requestedCount > 100)) throw new Error('PI_LONG_RUN_COUNT must be 50-100, or exactly 1 with --smoke');
const model = process.env.PI_LONG_RUN_MODEL || 'gpt-5.6-luna';
const thinking = process.env.PI_LONG_RUN_THINKING || 'max';
const cwd = process.env.PI_LONG_RUN_CWD || process.cwd();
const stateRoot = join(homedir(), '.local', 'state', 'pi-kether');
const auditFile = process.env.PI_GATEWAY_AUDIT_FILE || join(stateRoot, 'audit.jsonl');
const command = process.env.PI_LONG_RUN_COMMAND || process.execPath;
const commandArgs = process.env.PI_LONG_RUN_COMMAND ? [] : [fileURLToPath(new URL('./stdio-server.mjs', import.meta.url))];
const gatewayEnv = {
  ...process.env,
  PI_GATEWAY_ROOTS: JSON.stringify([cwd]),
  PI_GATEWAY_AUDIT_FILE: auditFile,
  PI_GATEWAY_PROVIDER_CIRCUIT_FILE: process.env.PI_GATEWAY_PROVIDER_CIRCUIT_FILE || join(stateRoot, 'provider-circuit.jsonl'),
  PI_GATEWAY_REQUEST_LEDGER_DIR: process.env.PI_GATEWAY_REQUEST_LEDGER_DIR || join(stateRoot, 'request-ledger'),
  PI_DISPATCH_SANDBOX: 'wsl2-bwrap',
  PI_SANDBOX_DISTRO: 'Ubuntu-24.04',
};

function powershellJson(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout.trim() || 'null'); } catch { return null; }
}

function sample(pid, completed) {
  const processMemory = powershellJson(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; $w=Get-Process -Name vmmemWSL -ErrorAction SilentlyContinue; @{gatewayRss=if($p){$p.WorkingSet64}else{0};vmmemWsl=($w|Measure-Object WorkingSet64 -Sum).Sum}|ConvertTo-Json -Compress`) || {};
  const residue = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '-u', 'root', '--', 'sh', '-c', "printf '%s %s' \"$(find /sys/fs/cgroup -maxdepth 1 -type d -name 'pi-kether-*' | wc -l)\" \"$(find /var/lib/pi-kether/jobs -mindepth 1 -maxdepth 1 -type d | wc -l)\""], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const [cgroups = null, jobDirs = null] = residue.stdout.trim().split(/\s+/).map(Number);
  return { completed, timestamp: new Date().toISOString(), hostFreeBytes: freemem(), gatewayRssBytes: processMemory.gatewayRss || 0, vmmemWslBytes: processMemory.vmmemWsl || 0, cgroups, jobDirs };
}

function auditRecords() {
  if (!existsSync(auditFile)) return [];
  const directory = dirname(auditFile);
  const prefix = `${auditFile.slice(directory.length + 1)}.`;
  const files = [auditFile, ...readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.jsonl')).map(name => join(directory, name))];
  return files.flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }));
}

const client = new Client({ name: 'pi-real-long-run', version: '1.0.0' });
const transport = new StdioClientTransport({ command, args: commandArgs, env: gatewayEnv, stderr: 'pipe' });
const results = [];
const samples = [];
let summary;
try {
  await client.connect(transport);
  samples.push(sample(transport.pid, 0));
  for (let index = 0; index < requestedCount; index += 1) {
    const slot = index % 10;
    const mode = smoke ? 'success' : slot === 0 ? 'timeout' : slot === 1 ? 'cancel' : slot === 2 ? 'format-error' : 'success';
    const requestId = `real-long-${Date.now()}-${index}`;
    const objective = mode === 'format-error'
      ? 'Deliberately return plain text without the required KETHER_RESULT_JSON prefix so the deterministic validator can reject it.'
      : `Return the integer ${index} in result and perform no tool calls.`;
    const request = {
      requestId, cwd, provider: 'openai-codex', model, thinking, access: 'none', resourceProfile: 'small', timeoutSeconds: mode === 'timeout' ? 1 : 45,
      task: { role: 'worker', objective, acceptance: ['Return a deterministic result without tools'], returnFields: ['status', 'result', 'evidence', 'uncertainty', 'errors'] },
    };
    const controller = new AbortController();
    const abortTimer = mode === 'cancel' ? setTimeout(() => controller.abort(), 500) : null;
    const started = Date.now();
    try {
      const response = await client.callTool({ name: 'dispatch_subagent', arguments: request }, undefined, { signal: controller.signal, timeout: 60_000, maxTotalTimeout: 60_000 });
      const value = JSON.parse(response.content[0].text);
      const injectedFormatRejection = mode === 'format-error' ? validateKetherResult('INTENTIONALLY_INVALID_FORMAT', request.task.returnFields).code : undefined;
      results.push({ requestId, mode, durationMs: Date.now() - started, transportError: false, isError: response.isError === true, ok: value.ok === true, provider: value.provider, model: value.model, formatValidation: value.formatValidation?.code, injectedFormatRejection });
    } catch (error) {
      results.push({ requestId, mode, durationMs: Date.now() - started, transportError: true, error: error.message });
    } finally { if (abortTimer) clearTimeout(abortTimer); }
    if ((index + 1) % 10 === 0 || index + 1 === requestedCount) samples.push(sample(transport.pid, index + 1));
  }
  const records = auditRecords();
  const byRequest = new Map(records.map(record => [record.requestId, record]));
  const mismatches = results.filter(result => {
    const audit = byRequest.get(result.requestId);
    if (!audit) return true;
    if (result.provider && audit.route?.actualProvider !== result.provider) return true;
    return !!result.model && audit.route?.actualModel !== result.model;
  }).map(result => result.requestId);
  const formatInjectionFailures = results.filter(result => result.mode === 'format-error' && result.injectedFormatRejection !== 'missing_prefix').map(result => result.requestId);
  summary = { ok: mismatches.length === 0 && formatInjectionFailures.length === 0, count: requestedCount, model, thinking, results, samples, auditRouteMismatches: mismatches, formatInjectionFailures };
  if (mismatches.length || formatInjectionFailures.length) process.exitCode = 1;
} finally {
  const gatewayPid = transport.pid || 0;
  await client.close().catch(() => {});
  await new Promise(resolveWait => setTimeout(resolveWait, 5000));
  samples.push(sample(gatewayPid, 'stopped+5s'));
}
console.log(JSON.stringify(summary, null, 2));
