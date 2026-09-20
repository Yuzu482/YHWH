import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters, invocation, parseResult } from '../scripts/headless-adapters.mjs';
import { doctor, fingerprint, resolveWorkspace, runHeadless, runProcess, validateConfig } from '../scripts/headless-host.mjs';

function fixture(t, { behavior = 'success', client = 'codex' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yhwh-headless-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'cli.mjs');
  fs.writeFileSync(script, `
const args=process.argv.slice(2);
if(args.includes('--version')) console.log('fixture 1.0.0');
else if(args.includes('--help')) console.log(${JSON.stringify(Object.values(adapters).flatMap(a => a.requiredFlags).join(' '))});
else { let input=''; for await (const c of process.stdin) input+=c;
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
  assert.equal(result.failure, 'timeout');
  const pid = Number(result.stdout.trim());
  assert(Number.isInteger(pid) && pid > 0);
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, 'descendant must not remain after timeout');
});
