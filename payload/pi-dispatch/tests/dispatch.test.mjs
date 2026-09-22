import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPiArgs, childEnvironment, validateKetherInvocation, validateRequest, runProcess, summarize, findPiEntry } from '../scripts/dispatch.mjs';
import ketherEnvelopeExtension, { compileKetherTask, validateKetherTask } from '../extensions/kether-envelope.js';
import writeScopeGuard, { compileWriteScope, isAllowedPath, normalizeScopedPath, validateUnifiedPatch } from '../extensions/write-scope-guard.js';
import authScrubExtension from '../extensions/auth-scrub.js';
import { publicResourceProfiles, resolveResourceLimits } from '../extensions/resource-limits.js';

const cwd = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(cwd, 'fixture.mjs');
const base = { target: 'model', cwd, provider: 'openai-codex', model: 'gpt-5.6-luna', prompt: '中文 " & $(unsafe)\n/command @file --option' };
const semanticTask = { role: 'Malkuth', objective: 'Inspect the current route.', readScope: ['scripts/dispatch.mjs'], forbidden: ['Do not modify files'], acceptance: ['Report observed provider and model'] };
const validate = (value, allowWrite = false) => validateRequest(value, allowWrite, cwd);

test('validation is strict and writing is opt-in', () => {
  assert.equal(validate(base).access, 'none');
  assert.equal(validate(base).resourceLimits.profile, 'standard');
  assert.equal(validate(base).thinking, 'medium');
  assert.throws(() => validate({ ...base, access: 'workspace-write' }), /allow-write/);
  assert.equal(validate({ ...base, access: 'workspace-write' }, true).access, 'workspace-write');
  assert.throws(() => validate({ target: 'codex-cli', cwd, prompt: 'blocked' }), /route is disabled/);
  assert.throws(() => validate({ ...base, provider: 'unknown-provider' }), /allowlist/);
  assert.throws(() => validate({ ...base, model: 'unknown-model' }), /allowlist/);
  assert.throws(() => validateRequest({ ...base, cwd: dirname(cwd) }, false, cwd), /launch directory/);
  for (const extra of [{ target: 'bad' }, { timeoutSeconds: 0 }, { cwd: '.' }, { provider: '--flag' }, { prompt: '' }, { arbitraryArgs: [] }, { model: undefined }]) assert.throws(() => validate({ ...base, ...extra }));
});
test('resource profiles are fixed and callers can only shorten runtime', () => {
  assert.deepEqual(Object.keys(publicResourceProfiles()), ['small', 'standard', 'large']);
  assert.equal(resolveResourceLimits('small').memoryBytes, 1024 * 1024 * 1024);
  assert.equal(resolveResourceLimits('standard', 30).timeoutSeconds, 30);
  assert.equal(resolveResourceLimits('standard', 999).timeoutSeconds, 300);
  assert.equal(resolveResourceLimits('large').pidsMax, 256);
  assert.throws(() => resolveResourceLimits('custom'), /resourceProfile/);
  assert.throws(() => validate({ ...base, memoryBytes: 1 }), /Unknown request key/);
});
test('non-review roles reject alternate providers', () => {
  for (const [provider,model] of [['pi-claude-code-provider','sonnet'],['opencode-go','deepseek-v4-pro']]) {
    assert.throws(() => validateKetherInvocation({cwd,provider,model,access:'read',task:semanticTask},false,cwd), /allowlist|requires provider/);
  }
});
test('Kether invocation compiles a fixed openai-codex envelope without duplicate route fields', () => {
  const invocation = validateKetherInvocation({ cwd, access: 'read', task: semanticTask }, false, cwd);
  assert.equal(invocation.request.target, 'model');
  assert.equal(invocation.request.provider, 'openai-codex');
  assert.equal(invocation.request.model, 'gpt-5.6-luna');
  assert.equal(invocation.request.thinking, 'medium');
  assert.equal(buildPiArgs(invocation.request, 'wsl2').at(buildPiArgs(invocation.request, 'wsl2').indexOf('--thinking') + 1), 'medium');
  for (const thinking of ['low', 'medium', 'high', 'max']) {
    assert.equal(validateKetherInvocation({ cwd, access: 'read', thinking, task: semanticTask }, false, cwd).request.thinking, thinking);
  }
  assert.match(compileKetherTask(invocation.task), /TASK_PACKET_JSON=/);
  assert.match(compileKetherTask(invocation.task), /KETHER_RESULT_JSON=/);
  assert.equal(validate({ ...base, provider: 'anthropic', model: 'claude-sonnet-5' }).thinking, 'max');
  assert.throws(() => validateKetherInvocation({ cwd, access: 'read', provider: 'other', task: semanticTask }, false, cwd), /allowlist/);
  assert.throws(() => validateKetherInvocation({ cwd, access: 'none', task: semanticTask }, false, cwd), /none access/);
  assert.throws(() => validateKetherInvocation({ cwd, access: 'read', task: { ...semanticTask, writeScope: ['x'] } }, false, cwd), /read access/);
  assert.throws(() => validateKetherInvocation({ cwd, access: 'workspace-write', task: semanticTask }, true, cwd), /explicit writeScope/);
  assert.throws(() => validateKetherInvocation({ cwd, access: 'workspace-write', task: { ...semanticTask, writeScope: ['../outside'] } }, true, cwd), /traversal/);
  assert.throws(() => validateKetherInvocation({ cwd, access: 'workspace-write', task: { ...semanticTask, writeScope: ['src/*'] } }, true, cwd), /terminal \/\*\*/);
  assert.throws(() => validateKetherTask({ ...semanticTask, returnFields: ['status', 'status'] }), /duplicates/);
  assert.throws(() => validateKetherTask({ ...semanticTask, returnFields: ['bad-field'] }), /Invalid returnFields/);
});

test('write scope normalizes exact files and explicit directory trees', () => {
  const scope = compileWriteScope(['src/index.ts', 'diagnostics/**']);
  assert.equal(normalizeScopedPath('src\\index.ts').path, 'src/index.ts');
  assert.equal(isAllowedPath('src/index.ts', scope), true);
  assert.equal(isAllowedPath('src/index.ts.bak', scope), false);
  assert.equal(isAllowedPath('diagnostics/nested/result.json', scope), true);
  assert.equal(isAllowedPath('diagnostic/result.json', scope), false);
  for (const bad of ['/absolute', 'C:\\absolute', '../escape', '.git/config', 'src//file', 'src/file:stream']) assert.throws(() => normalizeScopedPath(bad));
});

test('write scope extension blocks out-of-scope and shell writes before execution', async () => {
  let toolHandler;
  const previous = process.env.PI_WRITE_SCOPE_FILE;
  const scopeFile = resolve(cwd, 'write-scope.fixture.json');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(scopeFile, JSON.stringify(['allowed.txt', 'nested/**']));
  process.env.PI_WRITE_SCOPE_FILE = scopeFile;
  try {
    writeScopeGuard({ on(name, handler) { if (name === 'tool_call') toolHandler = handler; } });
    const ctx = { cwd };
    assert.equal(await toolHandler({ toolName: 'write', input: { path: 'allowed.txt' } }, ctx), undefined);
    assert.equal(await toolHandler({ toolName: 'edit', input: { path: 'nested/file.txt' } }, ctx), undefined);
    assert.match((await toolHandler({ toolName: 'write', input: { path: 'other.txt' } }, ctx)).reason, /outside writeScope/);
    assert.match((await toolHandler({ toolName: 'bash', input: { command: 'touch allowed.txt' } }, ctx)).reason, /Shell tools/);
    assert.match((await toolHandler({ toolName: 'code_rewrite', input: { dry_run: false } }, ctx)).reason, /path must be a string/);
  } finally {
    if (previous === undefined) delete process.env.PI_WRITE_SCOPE_FILE; else process.env.PI_WRITE_SCOPE_FILE = previous;
    unlinkSync(scopeFile);
  }
});

test('sandbox credentials are scrubbed only after the full agent run settles', async () => {
  let eventName;
  let handler;
  const previous = process.env.PI_SANDBOX_AUTH_PATH;
  const authFile = resolve(cwd, 'auth-scrub.fixture.json');
  const { writeFileSync, existsSync, unlinkSync } = await import('node:fs');
  writeFileSync(authFile, '{}');
  process.env.PI_SANDBOX_AUTH_PATH = authFile;
  try {
    authScrubExtension({ on(name, callback) { eventName = name; handler = callback; } });
    assert.equal(eventName, 'agent_settled');
    assert.equal(existsSync(authFile), true);
    await handler();
    assert.equal(existsSync(authFile), false);
    assert.equal(process.env.PI_SANDBOX_AUTH_PATH, undefined);
  } finally {
    if (existsSync(authFile)) unlinkSync(authFile);
    if (previous === undefined) delete process.env.PI_SANDBOX_AUTH_PATH; else process.env.PI_SANDBOX_AUTH_PATH = previous;
  }
});

test('post-execution patch validation rejects out-of-scope and malformed changes', () => {
  const base = '/jobs/1/baseline';
  const work = '/jobs/1/workspace';
  const allowed = `diff -ruN ${base}/allowed.txt ${work}/allowed.txt\n--- ${base}/allowed.txt\t1970-01-01\n+++ ${work}/allowed.txt\t2026-01-01\n@@ -0,0 +1 @@\n+OK\n`;
  assert.deepEqual(validateUnifiedPatch(allowed, ['allowed.txt'], base, work), ['allowed.txt']);
  const outside = allowed.replaceAll('allowed.txt', 'outside.txt');
  assert.throws(() => validateUnifiedPatch(outside, ['allowed.txt'], base, work), /outside writeScope/);
  assert.throws(() => validateUnifiedPatch('binary change without headers', ['allowed.txt'], base, work), /verifiable/);
});
test('Kether task schema rejects transport fields and extension injects the compiled task', async () => {
  assert.throws(() => validateKetherTask({ ...semanticTask, provider: 'openai-codex' }), /Unknown task key/);
  let command;
  let injected;
  ketherEnvelopeExtension({
    registerCommand(name, definition) { command = { name, definition }; },
    sendUserMessage(message) { injected = message; },
  });
  assert.equal(command.name, 'kether-task');
  const encoded = Buffer.from(JSON.stringify(semanticTask)).toString('base64url');
  await command.definition.handler(`b64:${encoded}`, { model: { provider: 'openai-codex', id: 'gpt-5.6-luna' }, isIdle: () => true, ui: { notify() {} } });
  assert.match(injected, /Malkuth/);
  assert.match(injected, /Inspect the current route/);
  injected = undefined;
  let notice;
  await command.definition.handler(`b64:${encoded}`, { model: { provider: 'anthropic', id: 'claude' }, isIdle: () => true, ui: { notify(message, level) { notice = { message, level }; } } });
  assert.equal(injected, undefined);
  assert.equal(notice.level, 'error');
  assert.match(notice.message, /provider\/model/);
});
test('model allowlists and exact provider/model routing', (t) => {
  const previousUserProfile = process.env.USERPROFILE;
  const temporaryUserProfile = mkdtempSync(resolve(tmpdir(), 'pi-lsp-routing-'));
  const inertExtensionEntry = resolve(
    temporaryUserProfile,
    '.pi',
    'agent',
    'npm',
    'node_modules',
    'pi-lsp-extension',
    'src',
    'index.ts',
  );
  mkdirSync(dirname(inertExtensionEntry), { recursive: true });
  writeFileSync(inertExtensionEntry, '');
  process.env.USERPROFILE = temporaryUserProfile;
  t.after(() => {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    rmSync(temporaryUserProfile, { recursive: true, force: true });
  });
  const args = buildPiArgs(validate(base));
  assert.ok(args.includes('--no-tools'));
  assert.ok(args.includes('--no-context-files'));
  assert.ok(args.includes('--no-approve'));
  assert.equal(args[args.indexOf('--model') + 1], base.model);
  const readList = buildPiArgs(validate({ ...base, access: 'read' })).at(-1).split(',');
  assert.ok(readList.includes('lsp_diagnostics'));
  assert.ok(readList.includes('ast_search'));
  assert.ok(!readList.includes('code_rewrite'));
  const writeList = buildPiArgs(validate({ ...base, access: 'workspace-write' }, true)).at(-1).split(',');
  assert.ok(writeList.includes('code_rewrite'));
  assert.ok(!writeList.includes('bash'));
  assert.ok(!writeList.includes('powershell'));
  assert.ok(args.includes('--no-extensions'));
  assert.ok(!buildPiArgs(validate(base)).includes('--extension'));
  assert.ok(buildPiArgs(validate({ ...base, access: 'read' })).includes('--extension'));
  const wslArgs = buildPiArgs(validate({ ...base, access: 'workspace-write' }, true), 'wsl2');
  assert.ok(wslArgs.includes('/opt/pi-kether/extensions/auth-scrub.js'));
  assert.equal(new Set(wslArgs).has('/opt/pi-kether/node_modules/pi-lsp-extension/src/index.ts'), false);
  assert.deepEqual(new Set(wslArgs.at(-1).split(',')), new Set(['read', 'grep', 'find', 'ls', 'edit', 'write', 'yhwh_lsp_diagnostics', 'yhwh_lsp_hover', 'yhwh_lsp_definition', 'yhwh_lsp_references', 'yhwh_lsp_symbols', 'yhwh_lsp_completions', 'yhwh_lsp_code_actions']));
  assert.ok(wslArgs.includes('/opt/pi-kether/extensions/write-scope-guard.js'));
  assert.ok(!wslArgs.at(-1).split(',').includes('powershell'));
});
test('gateway credentials are not inherited by Pi children', () => {
  const env = childEnvironment({ PATH: 'ok', PI_GATEWAY_TOKEN: 'secret', PI_GATEWAY_CONFIG: 'secret-path', MCP_GATEWAY_KEY: 'secret', OPENCODE_API_KEY: 'provider-auth' });
  assert.equal(env.PATH, 'ok');
  assert.equal(env.OPENCODE_API_KEY, undefined); // API credentials now enter through the selected FD3 packet only.
  assert.equal(env.PI_GATEWAY_TOKEN, undefined);
  assert.equal(env.PI_GATEWAY_CONFIG, undefined);
  assert.equal(env.MCP_GATEWAY_KEY, undefined);
});
test('stdin and argv preserve Unicode and shell metacharacters as data', async () => {
  const result = await runProcess(fixture, ['literal & echo NO', '中文'], { cwd, input: base.prompt });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { input: base.prompt, args: ['literal & echo NO', '中文'] });
});
test('timeout returns failure', async () => {
  const result = await runProcess(fixture, ['hang'], { cwd, timeoutSeconds: 1 });
  assert.equal(result.failure, 'timeout');
});
test('abort returns cancelled', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const result = await runProcess(fixture, ['hang'], { cwd, signal: controller.signal });
  clearTimeout(timer);
  assert.equal(result.failure, 'cancelled');
});
test('output limit is bounded', async () => {
  const result = await runProcess(fixture, ['flood'], { cwd, maxOutputBytes: 64 * 1024 });
  assert.equal(result.failure, 'output-limit');
  assert.ok(result.stdout.length <= 64 * 1024);
});
test('Pi semantic failure is detected even with exit code zero', () => {
  const raw = { exitCode: 0, stderr: '', stdout: JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: base.provider, model: base.model, stopReason: 'error', errorMessage: 'auth failed', content: [] } }) + '\n' + JSON.stringify({ type: 'agent_end' }) };
  assert.equal(summarize(raw, base).ok, false);
  assert.match(summarize(raw, base).failure, /auth failed/);
  assert.equal(summarize({ ...raw, stdout: '' }, base).ok, false);
});
test('successful Pi response parsed without treating warnings as JSON', () => {
  const raw = { exitCode: 0, stderr: 'warning', stdout: 'not json\n' + JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: base.provider, model: base.model, stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] } }) + '\n' + JSON.stringify({ type: 'agent_end' }) };
  assert.equal(summarize(raw, base).ok, true);
  assert.equal(summarize(raw, base).text, 'OK');
  assert.equal(summarize(raw, base).provider, 'openai-codex');
  assert.deepEqual(summarize(raw, base).toolsUsed, []);
});
test('tool execution names are exposed for caller verification', () => {
  const raw = { exitCode: 0, stderr: '', stdout: JSON.stringify({ type: 'tool_execution_start', toolName: 'lsp_symbols' }) + '\n' + JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: base.provider, model: base.model, stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] } }) + '\n' + JSON.stringify({ type: 'agent_end' }) };
  assert.deepEqual(summarize(raw, base).toolsUsed, ['lsp_symbols']);
});
test('spawn failure reported', async () => {
  const result = await runProcess(fixture, [], { cwd: resolve(cwd, 'missing-directory') });
  assert.ok(result.failure);
});
test('bad Pi entrypoint override rejected', () => {
  assert.throws(() => findPiEntry({ PI_DISPATCH_PI_ENTRY: 'pi.cmd' }));
});
test('installed Pi entrypoint resolves', (t) => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'pi-lsp-entry-'));
  const absolutePath = resolve(temporaryDirectory, 'cli.js');
  const missingPath = resolve(temporaryDirectory, 'missing-cli.js');
  writeFileSync(absolutePath, '');
  t.after(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  assert.equal(
    findPiEntry({ PI_DISPATCH_PI_ENTRY: absolutePath }),
    realpathSync(absolutePath),
  );
  assert.throws(() => {
    findPiEntry({ PI_DISPATCH_PI_ENTRY: missingPath });
  });
});
