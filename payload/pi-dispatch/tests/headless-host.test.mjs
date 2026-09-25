import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adapters, invocation, parseResult } from '../scripts/headless-adapters.mjs';
import { doctor, fingerprint, resolveWorkspace, runHeadless, runProcess, validateConfig, createHeadlessSession, classifyFailure, runHeadlessBatch } from '../scripts/headless-host.mjs';
import { acceptHeadless } from '../scripts/headless-acceptance.mjs';

let previousWorkerEnforcement;
test.beforeEach(() => {
  previousWorkerEnforcement = process.env.YHWH_WORKER_ENFORCEMENT;
  process.env.YHWH_WORKER_ENFORCEMENT = 'off';
});
test.afterEach(() => {
  if (previousWorkerEnforcement === undefined) delete process.env.YHWH_WORKER_ENFORCEMENT;
  else process.env.YHWH_WORKER_ENFORCEMENT = previousWorkerEnforcement;
});

function fixture(t, { behavior = 'success', client = 'codex', delayMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yhwh-headless-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'cli.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.log'))}, (args.includes('--version')?'version':args.includes('--help')?'help':'run')+'\\n');
if(args.includes('--version')) console.log('fixture 1.0.0');
else if(args.includes('--help')) console.log(${JSON.stringify(Object.values(adapters).flatMap(a => a.requiredFlags).join(' '))});
else { let input=''; for await (const c of process.stdin) input+=c;
const lock=${JSON.stringify(path.join(root, 'active.lock'))};fs.writeFileSync(lock,'active',{flag:'wx'});
await new Promise(r=>setTimeout(r,${delayMs}));fs.unlinkSync(lock);
if(${JSON.stringify(behavior)}==='exit') process.exit(7);
if(${JSON.stringify(behavior)}==='denied') console.error('tool soft-denied: requires approval');
if(${JSON.stringify(client)}==='codex') {
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));
} else if(${JSON.stringify(client)}==='claude') console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:input}));
else console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:JSON.parse(input).message.content}}));
}
`);
  const config = { schemaVersion: 1, workspaceRoots: [root], timeoutSeconds: 5, maxOutputBytes: 65536,
    clients: { [client]: { enabled: true, executable: process.execPath, nodeScript: script, expectedVersion: 'fixture 1.0.0', model: 'fixture-model', policy: adapters[client].policies[0], ...(client === 'antigravity' ? { acceptNativePermissions: true } : {}) } } };
  return { root, script, config, request: { client, cwd: root, prompt: '你好 $(untrusted); `literal`\nsecond line' } };
}

for (const client of Object.keys(adapters)) test(`${client}: probe, stdin roundtrip, terminal result and provenance`, async t => {
  const f = fixture(t, { client });
  const check = await doctor(f.config);
  assert.equal(check.clients[client].status, 'ready'); assert.equal(check.modelCalls, 0);
  assert.equal(check.clients[client].authenticated, 'unverified');
  const result = await runHeadless(f.config, f.request);
  assert.equal(result.status, 'completed'); assert(result.text.endsWith(`User task:\n${f.request.prompt}`));
  assert(result.text.startsWith('YHWH primary workflow contract'));
  assert.equal(result.evidence.acceptance, 'requires-primary-review');
  assert.equal(result.evidence.adapterSha256, fingerprint().sha256);
  const call = invocation(client, f.config.clients[client], f.request.prompt);
  assert(!call.args.some(a => a.includes('untrusted')));
  assert(!call.args.some(a => /dangerously|bypassPermissions/.test(a)));
});

test('default configuration is inert and does not run any CLI', async () => {
  const config = JSON.parse(fs.readFileSync(new URL('../workflow/headless.example.json', import.meta.url)));
  const result = await doctor(config);
  assert(Object.values(result.clients).every(c => c.status === 'disabled'));
});
test('fail closed on drift, disabled client, unknown fields and unsupported native permissions', async t => {
  const f = fixture(t);
  f.config.clients.codex.expectedVersion = 'fixture 2.0.0';
  assert.equal((await runHeadless(f.config, f.request)).reason, 'version_mismatch');
  f.config.clients.codex.enabled = false;
  await assert.rejects(runHeadless(f.config, f.request), /client_disabled/);
  assert.throws(() => validateConfig({ ...f.config, env: {} }), /invalid_configuration/);
  const g = fixture(t, { client: 'antigravity' });
  g.config.clients.antigravity.acceptNativePermissions = false;
  assert.throws(() => validateConfig(g.config), /native_permissions/);
  g.config.clients.antigravity.policy = 'read-only';
  assert.throws(() => validateConfig(g.config), /invalid_configuration/);
});
test('workspace escape, shell shims, arbitrary flags and oversized prompt are rejected', async t => {
  const f = fixture(t);
  assert.throws(() => resolveWorkspace(f.config, path.dirname(f.root)), /workspace_not_allowed/);
  await assert.rejects(runHeadless(f.config, { ...f.request, args: ['--unsafe'] }), /invalid_configuration/);
  await assert.rejects(runHeadless(f.config, { ...f.request, prompt: 'x'.repeat(200001) }), /invalid_prompt/);
  f.config.clients.codex.executable = path.join(f.root, 'shim.cmd');
  assert.throws(() => validateConfig(f.config), /invalid_configuration/);
});
test('zero exit with a denied tool remains unverified; nonzero exit is failure', async t => {
  for (const behavior of ['denied', 'exit']) {
    const f = fixture(t, { behavior });
    assert.equal((await runHeadless(f.config, f.request)).status, behavior === 'denied' ? 'unverified' : 'failed');
  }
});
test('protocol parsing rejects partial output, multiple terminals and false success', () => {
  for (const [client, output] of [
    ['codex', '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}'],
    ['codex', '{"type":"turn.failed"}\n{"type":"turn.completed"}'],
    ['claude', '{"type":"result","subtype":"success","is_error":true,"result":"oops"}'],
    ['antigravity', '{"event":"result","result":{"status":"WAITING","response":"pending"}}'],
    ['antigravity', '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'],
    ['claude', 'not-json'],
  ]) assert.throws(() => parseResult(client, output), /invalid_cli_result/);
});
test('bounded process handles missing executable, timeout, cancellation and oversized output', async t => {
  const f = fixture(t);
  const opts = { cwd: f.root, timeoutMs: 150, maxOutputBytes: 1024 };
  assert.equal((await runProcess(path.join(f.root, 'missing.exe'), [], opts)).failure, 'spawn_failed');
  assert.equal((await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], opts)).failure, 'timeout');
  assert.equal((await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048));setInterval(()=>{},1000)'], { ...opts, timeoutMs: 3000 })).failure, 'output_limit');
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...opts, timeoutMs: 3000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await pending).failure, 'cancelled');
});
test('implementation fingerprint detects changed or missing installed files', t => {
  const f = fixture(t);
  for (const [relative] of Object.entries(fingerprint().files)) {
    const dest = path.join(f.root, relative); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(new URL(`../${relative}`, import.meta.url), dest);
  }
  assert.deepEqual(fingerprint(f.root), fingerprint());
  fs.appendFileSync(path.join(f.root, 'scripts/headless-adapters.mjs'), '\n// changed\n');
  assert.notEqual(fingerprint(f.root).sha256, fingerprint().sha256);
  fs.unlinkSync(path.join(f.root, 'scripts/headless-host.mjs'));
  assert.throws(() => fingerprint(f.root));
});

test('timeout terminates a spawned descendant as well as its parent', async t => {
  const f = fixture(t);
  const code = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});console.log(c.pid);setInterval(()=>{},1000)';
  const result = await runProcess(process.execPath, ['-e', code], { cwd: f.root, timeoutMs: 1500, maxOutputBytes: 1024 });
  const pid = Number(result.stdout.trim());
  t.after(() => { if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid); } catch {} } });
  assert.equal(result.failure, 'timeout');
  assert(Number.isInteger(pid) && pid > 0);
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, 'descendant must not remain after timeout');
});

test('session cache preserves exact-version checks and progress contains metadata only', async t => {
  const f = fixture(t), session = createHeadlessSession(), events = [];
  const first = await session.run(f.config, f.request, { onProgress: e => events.push(e) });
  const second = await session.run(f.config, f.request);
  assert.equal(first.evidence.helpCacheHit, false); assert.equal(second.evidence.helpCacheHit, true);
  assert(first.evidence.totalMs >= first.evidence.durationMs);
  assert(first.evidence.firstResponseMs >= 0); assert.equal(first.evidence.eventCount, 2);
  assert.deepEqual(Object.keys(events.find(e => e.type === 'response')).sort(), ['elapsedMs', 'eventCount', 'type']);
  assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.phase), ['preflight', 'version', 'help', 'fingerprint', 'running']);
  assert.doesNotMatch(JSON.stringify(events), /untrusted|literal|User task/);
  fs.appendFileSync(f.script, '\n// changed implementation');
  assert.equal((await session.run(f.config, f.request)).evidence.helpCacheHit, false);
  fs.writeFileSync(f.script, fs.readFileSync(f.script, 'utf8').replace('fixture 1.0.0', 'fixture 2.0.0'));
  assert.equal((await session.run(f.config, f.request)).reason, 'version_mismatch');
});

test('warm calls avoid file reads but still recheck versions; clear and TTL force fresh probes', async t => {
  const f = fixture(t), session = createHeadlessSession();
  const first = await session.run(f.config, f.request), second = await session.run(f.config, f.request);
  assert(first.evidence.digestCache.bytesRead >= fs.statSync(process.execPath).size);
  assert.equal(first.evidence.digestCache.hits, 0);
  assert.equal(second.evidence.digestCache.bytesRead, 0);
  assert.equal(second.evidence.digestCache.hits, 10);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'calls.log'), 'utf8').trim().split('\n'), ['version','help','run','version','run']);
  session.clear();
  const fresh = await session.run(f.config, f.request);
  assert.equal(fresh.evidence.helpCacheHit, false); assert(fresh.evidence.digestCache.bytesRead > 0);
  const helpCache = new Map(), digestCache = new Map();
  await doctor(f.config, { helpCache, digestCache });
  for (const entry of [...helpCache.values(), ...digestCache.values()]) entry.at -= 60001;
  const expired = await doctor(f.config, { helpCache, digestCache });
  assert.equal(expired.clients.codex.helpCacheHit, false); assert.equal(expired.digestCache.hits, 0);
  const before = expired.clients.codex.scriptSha256;
  const oldStat = fs.statSync(f.script);
  fs.writeFileSync(f.script, fs.readFileSync(f.script, 'utf8').replace('active', 'ACTIVE'));
  fs.utimesSync(f.script, oldStat.atime, oldStat.mtime);
  const changed = await doctor(f.config, { helpCache, digestCache });
  assert.notEqual(changed.clients.codex.scriptSha256, before);
  assert.equal(changed.clients.codex.helpCacheHit, false, 'restored mtime must not hide a content change');
});

test('session serializes concurrent admission, snapshots inputs, and blocks after failure', async t => {
  const f = fixture(t, { delayMs: 300 }), session = createHeadlessSession();
  const first = session.run(f.config, f.request), second = session.run(f.config, f.request);
  f.request.prompt = 'mutated later'; f.config.clients.codex.model = 'changed-model';
  const results = await Promise.all([first, second]);
  assert(results.every(r => r.status === 'completed'), JSON.stringify(results));
  assert(results.every(r => r.evidence.requestedModel === 'fixture-model' && !r.text.includes('mutated later')));
  assert(results[1].evidence.queueMs >= 300);
  const g = fixture(t, { behavior: 'exit' }), stopped = createHeadlessSession();
  const failed = await Promise.all([stopped.run(g.config, g.request), stopped.run(g.config, g.request)]);
  assert.equal(failed[0].status, 'failed'); assert.equal(failed[1].reason, 'previous_call_failed');
  assert.equal(fs.readFileSync(path.join(g.root, 'calls.log'), 'utf8').split('run').length - 1, 1);
});

test('whole batch validation prevents all execution when a later request is invalid', async t => {
  const f = fixture(t);
  await assert.rejects(runHeadlessBatch(f.config, [f.request, { ...f.request, cwd: path.dirname(f.root) }]), /workspace_not_allowed/);
  assert.equal(fs.existsSync(path.join(f.root, 'calls.log')), false);
});

test('batch events arrive before completion, heartbeat during silence, and summarize actual savings', async t => {
  const f = fixture(t, { delayMs: 1250 }), events = [];
  const result = await runHeadlessBatch(f.config, [f.request, f.request], { onEvent: e => {
    events.push(e);
    if (e.type === 'waiting' && e.phase === 'running') assert(fs.existsSync(path.join(f.root, 'active.lock')));
    if (e.type === 'request-result' && e.index === 0) {
      assert.equal(fs.readFileSync(path.join(f.root, 'calls.log'), 'utf8').split('run').length - 1, 1, 'first result must precede second invocation');
    }
  } });
  assert.equal(result.status, 'completed'); assert.equal(result.notRun, 0);
  assert(events.some(e => e.type === 'waiting' && e.phase === 'running'));
  assert(events.every(e => e.count === 2 && e.batchElapsedMs >= 0));
  assert.equal(result.summary.helpCacheHits, 1); assert.equal(result.summary.digestCacheHits, 10);
  assert.equal(result.summary.digestBytesRead, result.results[0].evidence.digestCache.bytesRead);
  assert.doesNotMatch(JSON.stringify(events.filter(e => e.type !== 'request-result')), /untrusted|User task|literal/);
});

test('batch stops on cancellation or observer failure without starting later requests', async t => {
  const f = fixture(t), controller = new AbortController();
  const cancelled = await runHeadlessBatch(f.config, [f.request, f.request], { signal: controller.signal,
    onEvent: e => { if (e.type === 'request-result') controller.abort(); } });
  assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.notRun, 1);
  const events = [];
  const failed = await runHeadlessBatch(f.config, [f.request, f.request], { onEvent: e => {
    events.push(e); if (e.type === 'phase') throw new Error('private-secret');
  } });
  assert.equal(failed.reason, 'progress_handler_failed'); assert.equal(failed.notRun, 1);
  assert.doesNotMatch(JSON.stringify(failed), /private-secret/);
});

test('progress recognizes a final result without a newline and ignores null events', async t => {
  const f = fixture(t, { client: 'claude' });
  fs.writeFileSync(f.script, fs.readFileSync(f.script, 'utf8')
    .replace("else if(\"claude\"==='claude') console.log", "else if(\"claude\"==='claude') process.stdout.write"));
  const r = await runHeadless(f.config, f.request);
  assert.equal(r.status, 'completed'); assert.equal(r.evidence.eventCount, 1); assert(r.evidence.firstResponseMs !== null);
  const g = fixture(t);
  fs.writeFileSync(g.script, fs.readFileSync(g.script, 'utf8').replace("if(\"codex\"==='codex') {", "if(\"codex\"==='codex') { console.log('null');"));
  const progress = [];
  const invalid = await runHeadless(g.config, g.request, { onProgress: e => progress.push(e) });
  assert.equal(invalid.reason, 'invalid_cli_result');
  assert.notEqual(invalid.reason, 'progress_handler_failed');
});

test('batch-events CLI streams NDJSON and finishes with the same complete batch report', async t => {
  const f = fixture(t, { delayMs: 250 });
  const config = path.join(f.root, 'config.json'), requests = path.join(f.root, 'requests.json');
  fs.writeFileSync(config, JSON.stringify(f.config)); fs.writeFileSync(requests, JSON.stringify([f.request, f.request]));
  const chunks = [];
  const output = await runProcess(process.execPath, [fileURLToPath(new URL('../scripts/headless-host.mjs', import.meta.url)), 'batch-events', config, requests], {
    cwd: f.root, timeoutMs: 15000, maxOutputBytes: 1024 * 1024, onStdout: chunk => chunks.push(chunk.toString())
  });
  assert.equal(output.exitCode, 0); assert.equal(output.failure, null); assert(chunks.length > 2);
  const events = output.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'batch-start'); assert.equal(events.at(-1).type, 'result');
  assert.deepEqual(events.filter(e => e.type === 'request-result').map(e => e.index), [0,1]);
  assert.equal(events.at(-1).result.status, 'completed'); assert.equal(events.at(-1).result.summary.helpCacheHits, 1);
});

test('offline acceptance stays model-free and failures are sanitized', async t => {
  const f = fixture(t);
  const report = await acceptHeadless(f.config);
  assert.equal(report.modelCalls, 0); assert.equal(report.complete, false);
  assert.equal(report.clients.codex.response, 'unverified');
  assert.equal(classifyFailure('Invalid API key secret-value'), 'authentication_required');
  assert.equal(classifyFailure('rate limit secret-value'), 'rate_limited');
  assert.equal(classifyFailure('unknown secret-value'), 'cli_exit_nonzero');
});

test('Windows Job Object preserves stdin/argv and kills descendants after normal parent exit', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), arg = '中文 "quoted" trailing\\', input = 'stdin 中文\n';
  const options = { cwd: f.root, timeoutMs: 15000, maxOutputBytes: 65536, processTreeMode: 'job-object' };
  const echo = await runProcess(process.execPath, ['-e', 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.stringify({arg:process.argv[1],s})))', arg], { ...options, input });
  assert.equal(echo.failure, null); assert.equal(echo.exitCode, 0, echo.stderr);
  assert.deepEqual(JSON.parse(echo.stdout), { arg, s: input });
  const code = 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});console.log(c.pid);c.unref()';
  const r = await runProcess(process.execPath, ['-e', code], options);
  const pid = Number(r.stdout.trim());
  t.after(() => { if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid); } catch {} } });
  assert.equal(r.exitCode, 0, r.stderr); assert(pid > 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('batch stops at the first failure and leaves remaining requests unstarted', t => {
  const f = fixture(t, { behavior: 'exit' });
  const config = path.join(f.root, 'config.json'), requests = path.join(f.root, 'requests.json');
  fs.writeFileSync(config, JSON.stringify(f.config)); fs.writeFileSync(requests, JSON.stringify([f.request, f.request]));
  let output;
  try { execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/headless-host.mjs', import.meta.url)), 'batch', config, requests], { encoding: 'utf8', windowsHide: true }); }
  catch (e) { assert.equal(e.status, 1); output = e.stdout; }
  const result = JSON.parse(output); assert.equal(result.results.length, 1); assert.equal(result.notRun, 1);
});

test('Windows Job Object cleans its child after the Node runner is abruptly killed', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), pidFile = path.join(f.root, 'child.pid'), runnerFile = path.join(f.root, 'runner.mjs');
  const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  fs.writeFileSync(runnerFile, `import {runProcess} from ${JSON.stringify(new URL('../scripts/headless-host.mjs', import.meta.url).href)};await runProcess(process.execPath,['-e',${JSON.stringify(code)}],{cwd:${JSON.stringify(f.root)},timeoutMs:20000,maxOutputBytes:1024,processTreeMode:'job-object'});`);
  const runner = spawn(process.execPath, [runnerFile], { stdio: 'ignore', windowsHide: true }); let pid;
  t.after(() => { try { runner.kill(); } catch {} if (pid) { try { process.kill(pid); } catch {} } });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 100));
  assert(fs.existsSync(pidFile)); pid = Number(fs.readFileSync(pidFile, 'utf8')); assert(pid > 0);
  runner.kill(); let alive = true;
  for (let i = 0; i < 50 && alive; i++) { await new Promise(r => setTimeout(r, 100)); try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; } }
  assert.equal(alive, false);
});

test('Windows Job Object cancellation closes the job and removes a live descendant', {skip:process.platform!=='win32'},async t=>{
 const f=fixture(t),controller=new AbortController();let pid;
 t.after(()=>{if(pid){try{process.kill(pid)}catch{}}});
 const code='const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});console.log(c.pid);setInterval(()=>{},1000)';
 let output='';
 const result=await runProcess(process.execPath,['-e',code],{cwd:f.root,timeoutMs:15000,maxOutputBytes:1024,processTreeMode:'job-object',signal:controller.signal,onStdout:chunk=>{output+=chunk;if(output.includes('\n')){pid=Number(output.trim());controller.abort()}}});
 assert.equal(result.failure,'cancelled');assert(pid>0);
 await new Promise(r=>setTimeout(r,300));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
