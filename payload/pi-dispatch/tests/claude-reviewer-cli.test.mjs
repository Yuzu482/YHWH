import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/headless-host.mjs';
import { runClaudeReviewerCli, sanitizeClaudeReviewerEnv } from '../scripts/claude-reviewer-cli.mjs';

function fixture(t, mode = 'success') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-review-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'claude.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
const mode=${JSON.stringify(mode)};
if(process.argv.includes('--help')) { if(mode!=='missing-help') console.log('--print --output-format --tools --strict-mcp-config --safe-mode --mcp-config --disallowedTools --permission-mode --no-session-persistence --model --effort'); process.exit(0); }
if(process.argv.includes('auth')) { if(mode==='logged-out') console.log('{"loggedIn":false}'); else if(mode==='malformed-status') console.log('{bad'); else console.log('{"loggedIn":true}'); process.exit(0); }
if(mode==='timeout') { setInterval(()=>{},1000); }
let input=''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) input+=c;
if(fs.readdirSync(process.cwd()).length!==0) process.exit(9);
fs.writeFileSync(${JSON.stringify(path.join(root, 'observed.json'))}, JSON.stringify({cwd:process.cwd(),input,args:process.argv.slice(2),benign:process.env.CLAUDE_REVIEW_BENIGN,secret:process.env.ANTHROPIC_API_KEY}));
if(mode==='auth') { console.error('401 not logged in fake-token'); process.exit(1); }
if(mode==='quota') { console.log(JSON.stringify({error:'quota exceeded; reset at 2025-06-12T12:30:00Z fake-token'})); process.exit(1); }
if(mode==='invalid') { console.log('{invalid'); process.exit(0); }
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:input,usage:{input_tokens:2}}));
`);
  const wrapped = async (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.equal(options.processTreeMode, 'job-object');
    assert.equal(options.jobMemoryBytes, 2 * 1024 * 1024 * 1024);
    assert.equal(options.maxOutputBytes, 512 * 1024);
    // Exercise the real process runner portably; Windows executes the requested Job Object configuration.
    const actual = process.platform === 'win32' ? options : { ...options, processTreeMode: 'native', jobMemoryBytes: undefined };
    return runProcess(executable, args, actual);
  };
  return { root, script, wrapped };
}
const invoke = (f, options = {}) => runClaudeReviewerCli({ packet: 'review packet only', nodePath: process.execPath,
  cliScript: f.script, timeoutMs: 30000, env: { ANTHROPIC_API_KEY: 'fake-token', aNtHrOpIc_AuTh_ToKeN: 'fake-token', ANTHROPIC_BASE_URL: 'https://fake.invalid', CLAUDE_CODE_FAKE: 'fake-token', CLAUDE_REVIEW_BENIGN: 'retained' },
  runProcessImpl: f.wrapped, ...options });

test('sanitizes protected environment names case-insensitively without mutating caller env', () => {
  const env = { ANTHROPIC_API_KEY: 'fake-token', anthropic_base_url: 'x', cLaUdE_cOdE_fake: 'secret', KEEP: 'ok' };
  assert.deepEqual(sanitizeClaudeReviewerEnv(env), { KEEP: 'ok' });
  assert.equal(env.ANTHROPIC_API_KEY, 'fake-token');
});

test('success uses strict no-tools argv, stdin-only packet, sanitized environment and removes empty cwd', async t => {
  const f = fixture(t), before = new Set(fs.readdirSync(os.tmpdir()));
  const result = await invoke(f);
  assert.deepEqual(result, { runtime: 'host-cli', status: 'completed', text: 'review packet only', usage: { input_tokens: 2 } });
  const observed = JSON.parse(fs.readFileSync(path.join(f.root, 'observed.json'), 'utf8'));
  assert.equal(observed.input, 'review packet only');
  assert.deepEqual(observed.args, ['--print','--output-format','json','--no-session-persistence','--model','sonnet','--effort','max','--safe-mode','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disallowedTools','mcp__*','--permission-mode','dontAsk']);
  assert.equal(observed.benign, 'retained'); assert.equal(observed.secret, undefined);
  assert.equal(fs.existsSync(observed.cwd), false);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('pi-claude-review-') && !before.has(name)), []);
});

test('fails closed when temporary directory cleanup fails', async t => {
  const f = fixture(t);
  const result = await invoke(f, { cleanupImpl: () => { throw new Error('private filesystem detail'); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'temporary_directory_cleanup_failed');
  assert.doesNotMatch(JSON.stringify(result), /private filesystem detail/);
});

test('fails closed when the official help flags are incomplete', async t => {
  const f = fixture(t, 'missing-help'), result = await invoke(f);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'unsupported_cli'); assert.equal(result.runtime, 'host-cli');
  assert.equal(fs.existsSync(path.join(f.root, 'observed.json')), false);
});

test('classifies auth and quota failures without returning stderr or fake credentials', async t => {
  const auth = await invoke(fixture(t, 'auth'));
  assert.equal(auth.reason, 'PI_AUTH_EXPIRED'); assert.match(auth.guidance, /\/login/);
  const quota = await invoke(fixture(t, 'quota'));
  assert.equal(quota.reason, 'PI_QUOTA_LIMITED'); assert.equal(quota.resetTime, '2025-06-12T12:30:00Z');
  assert.doesNotMatch(JSON.stringify([auth, quota]), /fake-token|not logged in|rate limit/);
});

test('auth preflight fails logged-out and uncertain states before model invocation', async t => {
  const loggedOut = fixture(t, 'logged-out');
  const auth = await invoke(loggedOut);
  assert.equal(auth.reason, 'PI_AUTH_EXPIRED'); assert.match(auth.guidance, /\/login/);
  assert.equal(fs.existsSync(path.join(loggedOut.root, 'observed.json')), false);
  const malformed = fixture(t, 'malformed-status');
  assert.equal((await invoke(malformed)).reason, 'preflight_failed');
  assert.equal(fs.existsSync(path.join(malformed.root, 'observed.json')), false);
});

test('timeout and malformed JSON are distinct sanitized failures', async t => {
  const timeoutFixture = fixture(t);
  const timeout = await invoke(timeoutFixture, {
    runProcessImpl: async (executable, args, options) => {
      if (args.includes('--help')) return { exitCode: 0, stdout: '--print --output-format --tools --strict-mcp-config --safe-mode --mcp-config --disallowedTools --permission-mode --no-session-persistence --model --effort', stderr: '' };
      if (args.includes('auth')) return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '' };
      return { failure: 'timeout' };
    },
  });
  assert.equal(timeout.reason, 'execution_timeout');
  const invalid = await invoke(fixture(t, 'invalid'));
  assert.equal(invalid.reason, 'invalid_json');
  const f = fixture(t, 'invalid');
  const original = f.wrapped;
  f.wrapped = async (...args) => { const r = await original(...args); if (args[1].includes('--print')) r.stdout = '{"type":"result"'; return r; };
  assert.equal((await invoke(f)).reason, 'incomplete_output');
});
