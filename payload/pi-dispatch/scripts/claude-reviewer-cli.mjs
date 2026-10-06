import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters, invocation, parseResult } from './headless-adapters.mjs';
import { runProcess } from './headless-host.mjs';

const MAX_OUTPUT_BYTES = 512 * 1024;
const JOB_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const forbiddenEnvKey = key => /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_.*)$/i.test(key);

export function sanitizeClaudeReviewerEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('invalid_environment');
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    typeof key === 'string' && !forbiddenEnvKey(key) && typeof value === 'string'));
}

const existsFile = file => typeof file === 'string' && path.isAbsolute(file) &&
  !/\.(?:cmd|bat|ps1)$/i.test(file) && fs.existsSync(file) && fs.statSync(file).isFile();
const clean = fields => ({ runtime: 'host-cli', modelExecutionStarted: false, ...fields });

function hasStructuralEof(text) {
  const stack = [];
  let inString = false, escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return false;
    }
  }
  const trimmed = text.trimEnd();
  const last = trimmed.at(-1);
  return inString || (stack.length > 0 && (last === '"' || last === ':' || last === ',' || last === '{' || last === '['));
}

function classifyOutput(stderr, stdout = '') {
  let boundedJson = '';
  try {
    const parsed = JSON.parse(stdout);
    const errors = [parsed?.error, parsed?.message, parsed?.details?.error];
    boundedJson = errors.filter(value => typeof value === 'string').join(' ').slice(0, MAX_OUTPUT_BYTES);
  } catch { /* stdout is only considered when it is valid JSON */ }
  const text = `${stderr}\n${boundedJson}`;
  if (/\b401\b|not logged in|authentication required|unauthori[sz]ed|login required|token expired/i.test(text))
    return { reason: 'PI_AUTH_EXPIRED', guidance: 'Run /login manually in Claude Code, then retry.' };
  if (/rate.limit|too many requests|quota|usage.limit|overloaded/i.test(text)) {
    const match = text.match(/(?:reset(?:s|\s+at)?|retry(?:\s+after|\s+at)?)\s*[:=]?\s*((?:\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?)|(?:\d{1,2}:\d\d(?::\d\d)?(?:\s*[A-Z]{2,5})?))/i);
    return { reason: 'PI_QUOTA_LIMITED', ...(match ? { resetTime: match[1] } : {}) };
  }
  return null;
}

export async function runClaudeReviewerCli({ packet, nodePath, cliScript, timeoutMs, preflightBudgetMs = 10000, signal, env, thinking='medium', resultSchema, onModelStart, runProcessImpl = runProcess, cleanupImpl = fs.rmSync, nowImpl = Date.now } = {}) {
  let modelExecutionStarted = false;
  const output = fields => ({ ...clean(fields), modelExecutionStarted });
  if (signal?.aborted) return clean({ status: 'failed', reason: 'cancelled' });
  if (!['medium','high','xhigh'].includes(thinking) || typeof packet !== 'string' || !packet.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(preflightBudgetMs) || preflightBudgetMs < 1 ||
      !existsFile(nodePath) || !existsFile(cliScript) || !/\.[cm]?js$/i.test(cliScript))
    return clean({ status: 'failed', reason: 'invalid_configuration' });
  const safeEnv = sanitizeClaudeReviewerEnv(env === undefined ? process.env : env);
  let cwd;
  const startedAt = nowImpl();
  const remaining = () => Math.max(0, timeoutMs - (nowImpl() - startedAt));
  try {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-review-'));
    const execute = options => runProcessImpl(nodePath, options.args, {
      cwd, input: options.input, timeoutMs: options.timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, signal,
      processTreeMode: 'job-object', jobMemoryBytes: JOB_MEMORY_BYTES, env: safeEnv,
    });
    const helpBudget = Math.min(remaining(), preflightBudgetMs);
    if (!helpBudget) return clean({ status: 'failed', reason: 'preflight_timeout' });
    const help = await execute({ args: [cliScript, '--help'], input: '', timeoutMs: helpBudget });
    if (help.failure) return clean({ status: 'failed', reason: help.failure === 'timeout' ? 'preflight_timeout' : 'preflight_failed' });
    if (help.exitCode !== 0) return clean({ status: 'failed', reason: 'preflight_failed' });
    if (adapters.claude.requiredFlags.some(flag => !help.stdout.includes(flag)) || resultSchema && !help.stdout.includes('--json-schema')) return clean({ status: 'failed', reason: 'unsupported_cli' });
    if (fs.readdirSync(cwd).length !== 0) return clean({ status: 'failed', reason: 'temporary_directory_not_empty' });

    const statusBudget = Math.min(remaining(), preflightBudgetMs);
    if (!statusBudget) return clean({ status: 'failed', reason: 'preflight_timeout' });
    const auth = await execute({ args: [cliScript, 'auth', 'status', '--json'], input: '', timeoutMs: statusBudget });
    if (auth.failure) return clean({ status: 'failed', reason: auth.failure === 'timeout' ? 'preflight_timeout' : 'preflight_failed' });
    if (auth.exitCode !== 0) return clean({ status: 'failed', reason: 'preflight_failed' });
    let authStatus;
    try { authStatus = JSON.parse(auth.stdout); } catch { return clean({ status: 'failed', reason: 'preflight_failed' }); }
    if (typeof authStatus?.loggedIn !== 'boolean') return clean({ status: 'failed', reason: 'preflight_failed' });
    if (!authStatus.loggedIn) return clean({ status: 'failed', reason: 'PI_AUTH_EXPIRED', guidance: 'Run /login manually in Claude Code, then retry.' });
    if (signal?.aborted) return clean({ status: 'failed', reason: 'cancelled' });
    const schemaPacket = resultSchema
      ? `${packet}\n\nReturn concise schema-complete structured output only. Preserve every blocking finding and every required key. Do not echo supplied diffs. Do not return KETHER_RESULT_JSON as prose.`
      : packet;
    const call = invocation('claude', { model: 'sonnet', effort: thinking, policy: 'no-tools' }, schemaPacket);
    if (resultSchema) call.args.push('--json-schema', JSON.stringify(resultSchema, (_key, value) => value instanceof RegExp ? value.source : value));
    const callBudget = remaining();
    if (!callBudget) return clean({ status: 'failed', reason: 'execution_timeout' });
    if (typeof onModelStart === 'function') await onModelStart();
    if (signal?.aborted) return clean({ status: 'failed', reason: 'cancelled' });
    modelExecutionStarted = true;
    const result = await execute({ args: [cliScript, ...call.args], input: call.input, timeoutMs: callBudget });
    if (result.failure) return output({ status: 'failed', reason: result.failure === 'timeout' ? 'execution_timeout' : result.failure });
    if (result.exitCode !== 0) {
      const classified = classifyOutput(result.stderr || '', result.stdout || '');
      return output({ status: 'failed', ...(classified || { reason: 'cli_execution_failed' }) });
    }
    let parsed;
    try {
      parsed = parseResult('claude', result.stdout);
      if (resultSchema) {
        const wrapper = JSON.parse(result.stdout);
        const structured = wrapper?.structured_output;
        if (!structured || typeof structured !== 'object' || Array.isArray(structured)) throw new Error('missing_structured_output');
        parsed = { ...parsed, text: `KETHER_RESULT_JSON=${JSON.stringify(structured)}` };
      }
    }
    catch {
      let incomplete = false;
      try { JSON.parse(result.stdout); } catch (error) {
        incomplete = /unexpected end|end of json input|unterminated/i.test(error.message) || hasStructuralEof(result.stdout);
      }
      return output({ status: 'failed', reason: incomplete ? 'incomplete_output' : 'invalid_json' });
    }
    try { cleanupImpl(cwd, { recursive: true, force: true }); cwd = null; }
    catch { return output({ status: 'failed', reason: 'temporary_directory_cleanup_failed' }); }
    return output({ status: 'completed', text: parsed.text, usage: parsed.usage });
  } catch {
    return output({ status: 'failed', reason: 'runner_error' });
  } finally {
    if (cwd) { try { cleanupImpl(cwd, { recursive: true, force: true }); } catch { /* Never expose filesystem details. */ } }
  }
}
