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
if(process.argv.includes('--help')) { if(mode!=='missing-help') console.log('--print --output-format --tools --strict-mcp-config --safe-mode --mcp-config --disallowedTools --permission-mode --no-session-persistence --model --effort'+(mode==='missing-schema-help'?'':' --json-schema')); process.exit(0); }
if(process.argv.includes('auth')) { if(mode==='logged-out') console.log('{"loggedIn":false}'); else if(mode==='malformed-status') console.log('{bad'); else console.log('{"loggedIn":true}'); process.exit(0); }
if(mode==='timeout') { setInterval(()=>{},1000); }
let input=''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) input+=c;
if(fs.readdirSync(process.cwd()).length!==0) process.exit(9);
fs.writeFileSync(${JSON.stringify(path.join(root, 'observed.json'))}, JSON.stringify({cwd:process.cwd(),input,args:process.argv.slice(2),benign:process.env.CLAUDE_REVIEW_BENIGN,secret:process.env.ANTHROPIC_API_KEY}));
if(mode==='auth') { console.error('401 not logged in fake-token'); process.exit(1); }
if(mode==='quota') { console.log(JSON.stringify({error:'quota exceeded; reset at 2025-06-12T12:30:00Z fake-token'})); process.exit(1); }
if(mode==='invalid') { console.log('{invalid'); process.exit(0); }
console.log(JSON.stringify(mode==='structured' ? {type:'result',subtype:'success',is_error:false,result:'',structured_output:{status:'completed',reviewDecision:'approve'},usage:{input_tokens:2}} : mode==='structured-missing' ? {type:'result',subtype:'success',is_error:false,result:'',usage:{input_tokens:2}} : mode==='structured-null' ? {type:'result',subtype:'success',is_error:false,result:'',structured_output:null,usage:{input_tokens:2}} : mode==='structured-array' ? {type:'result',subtype:'success',is_error:false,result:'',structured_output:[],usage:{input_tokens:2}} : {type:'result',subtype:'success',is_error:false,result:input,usage:{input_tokens:2}}));
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
  cliScript: f.script, timeoutMs: 120000, preflightBudgetMs: 60000, env: { ANTHROPIC_API_KEY: 'fake-token', aNtHrOpIc_AuTh_ToKeN: 'fake-token', ANTHROPIC_BASE_URL: 'https://fake.invalid', CLAUDE_CODE_FAKE: 'fake-token', CLAUDE_REVIEW_BENIGN: 'retained' },
  runProcessImpl: f.wrapped, ...options });

test('sanitizes protected environment names case-insensitively without mutating caller env', () => {
  const env = { ANTHROPIC_API_KEY: 'fake-token', anthropic_base_url: 'x', cLaUdE_cOdE_fake: 'secret', KEEP: 'ok' };
  assert.deepEqual(sanitizeClaudeReviewerEnv(env), { KEEP: 'ok' });
  assert.equal(env.ANTHROPIC_API_KEY, 'fake-token');
});

test('missing, blank and non-string compiled packets never launch a process', async t => {
  const f=fixture(t);
  let processes=0,models=0;
  for (const packet of [undefined,null,'',' \r\n\t',Buffer.from('text'),{}]) {
    const result=await invoke(f,{packet,runProcessImpl:async()=>{processes++;throw new Error('must not run');},onModelStart:()=>{models++;}});
    assert.equal(result.reason,'invalid_configuration');
    assert.equal(result.modelExecutionStarted,false);
  }
  assert.equal(processes,0);assert.equal(models,0);
  assert.equal(fs.existsSync(path.join(f.root,'observed.json')),false);
});

test('success uses strict no-tools argv, stdin-only packet, sanitized environment and removes empty cwd', async t => {
  const f = fixture(t), before = new Set(fs.readdirSync(os.tmpdir()));
  const result = await invoke(f);
  assert.deepEqual(result, { runtime: 'host-cli', modelExecutionStarted:true, status: 'completed', text: 'review packet only', usage: { input_tokens: 2 } });
  const observed = JSON.parse(fs.readFileSync(path.join(f.root, 'observed.json'), 'utf8'));
  assert.equal(observed.input, 'review packet only');
  assert.deepEqual(observed.args, ['--print','--output-format','json','--no-session-persistence','--model','sonnet','--effort','medium','--safe-mode','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disallowedTools','mcp__*','--permission-mode','dontAsk']);
  assert.equal(observed.benign, 'retained'); assert.equal(observed.secret, undefined);
  assert.equal(fs.existsSync(observed.cwd), false);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('pi-claude-review-') && !before.has(name)), []);
});

test('schema mode uses official structured output and fails closed on absent structured output', async t => {
  const schema={type:'object',properties:{status:{type:'string',pattern:/^done$/}}};
  const f=fixture(t,'structured');
  const result=await invoke(f,{resultSchema:schema});
  assert.equal(result.status,'completed');
  assert.equal(result.text,'KETHER_RESULT_JSON={"status":"completed","reviewDecision":"approve"}');
  const observed=JSON.parse(fs.readFileSync(path.join(f.root,'observed.json'),'utf8'));
  assert.deepEqual(observed.args.slice(-2),['--json-schema','{"type":"object","properties":{"status":{"type":"string","pattern":"^done$"}}}']);
  const unsupported=await invoke(fixture(t,'missing-schema-help'),{resultSchema:schema});
  assert.equal(unsupported.reason,'unsupported_cli');assert.equal(unsupported.modelExecutionStarted,false);
  for(const mode of ['structured-missing','structured-null','structured-array','invalid']) {
    const invalid=await invoke(fixture(t,mode),{resultSchema:schema});
    assert.equal(invalid.status,'failed');
  }
});

test('model-start callback follows preflight, runs once, and fails closed before invocation', async t => {
  const f=fixture(t), order=[];
  const result=await invoke(f,{onModelStart:async()=>{order.push('start');}});
  assert.deepEqual(order,['start']);assert.equal(result.modelExecutionStarted,true);
  const preflight=fixture(t,'logged-out'), calls=[];
  const rejected=await invoke(preflight,{onModelStart:()=>calls.push('start')});
  assert.equal(rejected.modelExecutionStarted,false);assert.deepEqual(calls,[]);
  const failed=await invoke(fixture(t),{onModelStart:async()=>{throw new Error('no admission');}});
  assert.equal(failed.modelExecutionStarted,false);assert.equal(failed.reason,'runner_error');
  const controller=new AbortController();controller.abort();
  let processStarts=0;
  const cancelled=await invoke(fixture(t),{signal:controller.signal,onModelStart:()=>calls.push('aborted-start'),runProcessImpl:async()=>{processStarts++;throw new Error('must not spawn');}});
  assert.equal(cancelled.reason,'cancelled');assert.equal(cancelled.modelExecutionStarted,false);assert.deepEqual(calls,[]);assert.equal(processStarts,0);
  const afterCallback=new AbortController();
  const stopped=await invoke(fixture(t),{signal:afterCallback.signal,onModelStart:()=>afterCallback.abort()});
  assert.equal(stopped.reason,'cancelled');assert.equal(stopped.modelExecutionStarted,false);
});

test('native invocation preserves supported medium/high/xhigh effort and records model start', async t => {
  for(const effort of ['medium','high','xhigh']) {
    const f=fixture(t), result=await invoke(f,{thinking:effort});
    assert.equal(result.modelExecutionStarted,true);
    const observed=JSON.parse(fs.readFileSync(path.join(f.root,'observed.json'),'utf8'));
    assert.equal(observed.args[observed.args.indexOf('--effort')+1],effort);
    assert.equal(observed.secret,undefined);
  }
  const preflight=fixture(t,'logged-out');
  assert.equal((await invoke(preflight,{thinking:'high'})).modelExecutionStarted,false);
  assert.equal((await invoke(fixture(t),{thinking:'low'})).reason,'invalid_configuration');
  assert.equal((await invoke(fixture(t),{thinking:'max'})).reason,'invalid_configuration');
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

test('preflight budgets default to 10 seconds, accept 60 seconds and remain capped by remaining time', async t => {
  const f = fixture(t);
  const base = { packet: 'packet', nodePath: process.execPath, cliScript: f.script, timeoutMs: 120000, env: {} };
  for (const [budget, expected] of [[undefined, 10000], [60000, 60000]]) {
    const seen = [];
    const result = await runClaudeReviewerCli({ ...base, nowImpl: () => 0, ...(budget === undefined ? {} : { preflightBudgetMs: budget }), runProcessImpl: async (_exe, args, opts) => {
      seen.push(opts.timeoutMs);
      return args.includes('--help') ? { exitCode: 0, stdout: '--print --output-format --tools --strict-mcp-config --safe-mode --mcp-config --disallowedTools --permission-mode --no-session-persistence --model --effort', stderr: '' } : { exitCode: 0, stdout: '{"loggedIn":false}', stderr: '' };
    }});
    assert.equal(result.reason, 'PI_AUTH_EXPIRED'); assert.deepEqual(seen, [expected, expected]);
  }
  let clock = 0;
  const capped = await runClaudeReviewerCli({ ...base, timeoutMs: 1, preflightBudgetMs: 60000, nowImpl: () => clock,
    runProcessImpl: async () => { clock = 1; return { exitCode: 0, stdout: '--print --output-format --tools --strict-mcp-config --safe-mode --mcp-config --disallowedTools --permission-mode --no-session-persistence --model --effort', stderr: '' }; } });
  assert.equal(capped.reason, 'preflight_timeout');
  let capClock = 0;
  const helpCapped = await runClaudeReviewerCli({ ...base, timeoutMs: 60000, preflightBudgetMs: 60000,
    nowImpl: () => capClock,
    runProcessImpl: async (_exe, args, opts) => {
      if (args.includes('--help')) { assert.equal(opts.timeoutMs, 60000); capClock = 1; return { exitCode: 0, stdout: '--print --output-format --tools --strict-mcp-config --safe-mode --mcp-config --disallowedTools --permission-mode --no-session-persistence --model --effort', stderr: '' }; }
      assert.equal(opts.timeoutMs, 59999);
      return { exitCode: 0, stdout: '{"loggedIn":false}', stderr: '' };
    } });
  assert.equal(helpCapped.reason, 'PI_AUTH_EXPIRED');
  let exhaustedClock = 0;
  const exhausted = await runClaudeReviewerCli({ ...base, timeoutMs: 1, preflightBudgetMs: 60000, nowImpl: () => exhaustedClock,
    runProcessImpl: async (_exe, args, opts) => { if (args.includes('--help')) { exhaustedClock = 1; return { exitCode: 0, stdout: '--print --output-format --tools --strict-mcp-config --safe-mode --mcp-config --disallowedTools --permission-mode --no-session-persistence --model --effort', stderr: '' }; } return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '' }; } });
  assert.equal(exhausted.reason, 'preflight_timeout');
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
