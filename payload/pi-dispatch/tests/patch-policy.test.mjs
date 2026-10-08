import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequestLedger } from '../extensions/request-ledger.js';
import { hostRecordDigest } from '../extensions/host-verification.js';
import { checkPatchBytes, ISSUED_BLOCK, TOKEN_INVALID, PATCH_INVALID, PATCH_POLICY } from '../scripts/patch-policy.mjs';
import { stripPatch } from '../scripts/wsl-sandbox.mjs';
import { exportResult, sanitizeCapturedResult, sanitizeResult } from '../extensions/result-export.js';
import { summarize } from '../scripts/dispatch.mjs';

const issued = 'unit/' + '+sample%81';
const neutral = Buffer.from('\ufeffdiff --git a/file b/file\r\n--- a/file\r\n+++ b/file\r\n context\r\n+multibyte: café and replacement �\r\n', 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('preserves exact patch bytes and hashes those bytes', () => {
  const original = Buffer.from(neutral);
  const result = checkPatchBytes(original, issued);
  assert.equal(result.ok, true);
  assert.equal(result.patchPolicy, PATCH_POLICY);
  assert.equal(result.patchSha256, sha(original));
  assert.equal(result.patchBytes, original.length);
  assert.deepEqual(original, neutral);
});

test('blocks each pinned token representation throughout realistic patch lines', () => {
  const encoded = encodeURIComponent(issued);
  const forms = [issued, Buffer.from(issued).toString('base64'), encoded, encoded.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase())];
  for (const form of new Set(forms)) {
    const bytes = Buffer.from(`diff --git a/file b/file\n index path context\n+${form}\n`);
    const result = checkPatchBytes(bytes, issued);
    assert.deepEqual(result, { ok: false, code: ISSUED_BLOCK });
  }
});

test('API selected credential fields are the only secret needles', () => {
  const selected = { anthropicApi: { ['api' + 'Key']: issued }, model: 'sample-model', baseURL: 'https://example.invalid' };
  const packetValues = Buffer.from(`${selected.model} ${selected.baseURL}`);
  assert.equal(checkPatchBytes(packetValues, selected.anthropicApi['api' + 'Key']).ok, true);
  assert.deepEqual(checkPatchBytes(Buffer.from(`+${issued}`), selected.anthropicApi['api' + 'Key']), { ok: false, code: ISSUED_BLOCK });
});

test('invalid token inputs fail safely; ordinary packet values do not match', () => {
  for (const value of ['', undefined, null, 42, 'has space', 'nul\u0000x', '\ud800']) {
    assert.deepEqual(checkPatchBytes(neutral, value), { ok: false, code: TOKEN_INVALID });
  }
  assert.equal(checkPatchBytes(Buffer.from('https://example.invalid model-name'), issued).ok, true);
});

test('accepts a valid BOM and legitimate replacement character unchanged', () => {
  const bytes = Buffer.from('\ufeff+legitimate �\r\n', 'utf8');
  const result = checkPatchBytes(bytes, issued);
  assert.equal(result.ok, true);
  assert.equal(result.patchSha256, sha(bytes));
  assert.equal(result.patchBytes, bytes.length);
});

test('invalid UTF-8 and oversize patches fail without mutation', () => {
  assert.deepEqual(checkPatchBytes(Buffer.from([0xff]), issued), { ok: false, code: PATCH_INVALID });
  assert.deepEqual(checkPatchBytes(Buffer.alloc(4 * 1024 * 1024 + 1), issued), { ok: false, code: PATCH_INVALID });
  const started = Date.now();
  const bounded = checkPatchBytes(Buffer.alloc(4 * 1024 * 1024, 0x61), issued);
  assert.equal(bounded.ok, true);
  assert.ok(Date.now() - started < 3000, '4 MiB scan should remain bounded');
});

test('generic pattern marks warning only without changing patch bytes', () => {
  const bytes = Buffer.from('diff --git a/file b/file\n+sampleText = value\n');
  const result = checkPatchBytes(bytes, issued);
  assert.equal(result.ok, true);
  assert.equal(result.secretLikeContent, false);
  const constructed = 'Bear' + 'er' + ' ' + '$' + '{token}';
  const flagged = Buffer.from(`+${constructed}`);
  const warning = checkPatchBytes(flagged, issued);
  assert.equal(warning.ok, true);
  assert.equal(warning.secretLikeContent, true);
  assert.deepEqual(flagged, Buffer.from(`+${constructed}`));
  const summary = summarize({ stdout: '', stderr: '', exitCode: 0, patch: flagged.toString(), patchPolicy: PATCH_POLICY, secretLikeContent: warning.secretLikeContent }, { target: 'synthetic', provider: 'synthetic', model: 'synthetic' });
  assert.equal(summary.secretLikeContent, true);
  assert.equal(summary.patchConfirmationRequired, true);
  assert.equal(summary.patch, flagged.toString());
});

test('importing the helper never reads stdin or hangs', () => {
  const script = fileURLToPath(new URL('../scripts/patch-policy.mjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(new URL('../scripts/patch-policy.mjs', import.meta.url).href)})`], { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
  assert.ok(script.endsWith('patch-policy.mjs'));
});

test('production root functions block issued forms and emit verified bytes under real WSL', t => {
  const rootPath = fileURLToPath(new URL('../sandbox/pi-kether-sandbox', import.meta.url));
  const rootSource = readFileSync(rootPath, 'utf8');
  const helperSource = readFileSync(fileURLToPath(new URL('../scripts/patch-policy.mjs', import.meta.url)), 'utf8');
  const auditSource = readFileSync(fileURLToPath(new URL('../extensions/audit-log.js', import.meta.url)), 'utf8');
  const artifactSource = readFileSync(fileURLToPath(new URL('../scripts/artifact-apply.mjs', import.meta.url)), 'utf8');
  const guardSource = readFileSync(fileURLToPath(new URL('../extensions/write-scope-guard.js', import.meta.url)), 'utf8');
  const names = ['select_native_issued_token', 'select_api_issued_token', 'emit_checked_patch'];
  const functions = names.map(name => {
    const match = rootSource.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
    assert.ok(match, `production function ${name} exists`);
    return match[0];
  }).join('\n').replaceAll('/opt/pi-kether/scripts/patch-policy.mjs', 'POLICY_HELPER_PATH');
  let command;
  if (process.platform === 'win32') {
    const probe = spawnSync('wsl.exe', ['--status'], { encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0) return t.skip('WSL unavailable on Windows host; real-WSL behavioral harness not executed');
    command = ['wsl.exe', ['-d', process.env.PI_TEST_WSL_DISTRO || 'Ubuntu-24.04', '-u', 'root', '--cd', '/', '--exec', '/opt/node/bin/node', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module']];
  } else {
    command = [process.execPath, ['--input-type=module']];
  }
  const token = 'synthetic/' + '0123456789abcdef';
  const input = Buffer.from(JSON.stringify({ functions, helperSource, auditSource, artifactSource, guardSource, token })).toString('base64');
  const child = String.raw`
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
const data=JSON.parse(Buffer.from('DATA_LITERAL','base64').toString('utf8'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-root-policy-'));
try {
  fs.mkdirSync(path.join(dir,'scripts'));fs.mkdirSync(path.join(dir,'extensions'));
  const helper=path.join(dir,'scripts','patch-policy.mjs');
  fs.writeFileSync(helper,data.helperSource);fs.writeFileSync(path.join(dir,'extensions','audit-log.js'),data.auditSource);
  fs.writeFileSync(path.join(dir,'scripts','artifact-apply.mjs'),data.artifactSource);fs.writeFileSync(path.join(dir,'extensions','write-scope-guard.js'),data.guardSource);
  const baseline=path.join(dir,'baseline'),workspace=path.join(dir,'workspace');
  fs.mkdirSync(baseline);fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(baseline,'x'),'old\r\n');fs.writeFileSync(path.join(workspace,'x'),'safe café\r\n');
  const funcs=data.functions.replaceAll('POLICY_HELPER_PATH',helper);
  const token=data.token, forms=[token,Buffer.from(token).toString('base64'),encodeURIComponent(token),encodeURIComponent(token).replace(/%[0-9A-F]{2}/g,m=>m.toLowerCase())];
  const execute=(patch,name,chosen=token)=>{
    const patchPath=path.join(dir,name);fs.writeFileSync(patchPath,patch);
    const shell=funcs+'\nissued='+Buffer.from(chosen).toString('base64')+'; issued=$(printf %s "$issued" | base64 -d); emit_checked_patch "$issued" '+JSON.stringify(patchPath)+' '+JSON.stringify(baseline)+' '+JSON.stringify(workspace);
    return cp.spawnSync('bash',['-c',shell],{encoding:'utf8',timeout:10000});
  };
  const blocked=forms.map((form,i)=>{
    const run=execute(Buffer.from('diff --git a/x b/x\n+context '+form+'\n'),'blocked-'+i);
    return {status:run.status,stdout:run.stdout,stderr:run.stderr};
  });
  const difference=cp.spawnSync('diff',['-ruN',baseline,workspace]);
  if(difference.status!==1)throw new Error('real GNU diff must capture changed file');
  const good=difference.stdout;
  const success=execute(good,'success');
  const invalid=execute(good,'invalid','');
  const native=path.join(dir,'native.json');fs.writeFileSync(native,JSON.stringify({openaiAccess:{['access'+'Token']:token},model:'test'}));
  const api=JSON.stringify({controlledApi:{['api'+'Key']:token},model:'test'});
  const apiB64=Buffer.from(api).toString('base64');
  const selectorShell=funcs+'\nnative=$(select_native_issued_token '+JSON.stringify(native)+'); api=$(printf %s '+apiB64+' | base64 -d | select_api_issued_token); printf "%s\n%s" "$native" "$api"';
  const malformed=cp.spawnSync('bash',['-c',funcs+'\nprintf %s invalid | select_api_issued_token'],{encoding:'utf8',timeout:10000});
  const selected=cp.spawnSync('bash',['-c',selectorShell],{encoding:'utf8',timeout:10000});
  process.stdout.write(JSON.stringify({blocked,invalid:{status:invalid.status,stdout:invalid.stdout,stderr:invalid.stderr},success:{status:success.status,stdout:success.stdout,stderr:success.stderr},bytes:good.toString('base64'),hash:crypto.createHash('sha256').update(good).digest('hex'),size:good.length,selected:{status:selected.status,stdout:selected.stdout,stderr:selected.stderr},malformed:{status:malformed.status,stdout:malformed.stdout,stderr:malformed.stderr}}));
} finally {fs.rmSync(dir,{recursive:true,force:true});}
`;
  const program = child.replace('DATA_LITERAL', input);
  const result = spawnSync(command[0], command[1], { input: program, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  for (const blocked of observed.blocked) {
    assert.equal(blocked.status, 4);
    assert.equal(blocked.stdout, '');
    assert.equal(blocked.stderr, `\n${ISSUED_BLOCK}\n`);
  }
  assert.equal(observed.invalid.status, 4);
  assert.equal(observed.invalid.stdout, '');
  assert.equal(observed.invalid.stderr, `\n${TOKEN_INVALID}\n`);
  assert.equal(observed.success.status, 0, observed.success.stderr);
  assert.match(observed.success.stdout, /^\nPI_SANDBOX_PATCH_B64=/);
  assert.match(observed.success.stdout, /\nPI_SANDBOX_PATCH_META=\{[^\n]+\}\n$/);
  const emitted = observed.success.stdout.match(/PI_SANDBOX_PATCH_B64=([^\n]*)/)[1];
  assert.equal(emitted, observed.bytes);
  const metadata = JSON.parse(observed.success.stdout.match(/PI_SANDBOX_PATCH_META=(\{[^\n]+\})/)[1]);
  assert.equal(observed.success.stdout, `\nPI_SANDBOX_PATCH_B64=${observed.bytes}\nPI_SANDBOX_PATCH_META=${JSON.stringify(metadata)}\n`);
  assert.equal(metadata.patchSha256, observed.hash);
  assert.equal(metadata.patchBytes, observed.size);
  assert.deepEqual(metadata.fileStates,[{path:'x',before:true,after:true}]);
  assert.equal(observed.selected.status, 0, observed.selected.stderr);
  assert.deepEqual(observed.selected.stdout.trim().split('\n'), [token, token]);
  assert.notEqual(observed.malformed.status, 0);
  assert.equal(observed.malformed.stdout, '');
  assert.equal(observed.malformed.stderr, '');
});

test('stripPatch rejects malformed base64, metadata, and invalid UTF-8 while preserving folded CRLF and empty bytes', () => {
  const valid = Buffer.from('diff --git a/x b/x\r\n+café\r\n', 'utf8');
  const metadata = bytes => JSON.stringify(checkPatchBytes(bytes, issued));
  for (const encoded of ['QQ', 'Q!Q=', 'QR==']) {
    assert.throws(() => stripPatch(`\nPI_SANDBOX_PATCH_B64=${encoded}\nPI_SANDBOX_PATCH_META=${metadata(Buffer.from('A'))}\n`));
  }
  const wrongHash = { ...checkPatchBytes(valid, issued), patchSha256: '0'.repeat(64) };
  assert.throws(() => stripPatch(`\nPI_SANDBOX_PATCH_B64=${valid.toString('base64')}\nPI_SANDBOX_PATCH_META=${JSON.stringify(wrongHash)}\n`));
  const wrongLength = { ...checkPatchBytes(valid, issued), patchBytes: valid.length + 1 };
  assert.throws(() => stripPatch(`\nPI_SANDBOX_PATCH_B64=${valid.toString('base64')}\nPI_SANDBOX_PATCH_META=${JSON.stringify(wrongLength)}\n`));
  const invalidUtf8 = Buffer.from([0xff]);
  const invalidMeta = { ...checkPatchBytes(valid, issued), patchSha256: sha(invalidUtf8), patchBytes: invalidUtf8.length };
  assert.throws(() => stripPatch(`\nPI_SANDBOX_PATCH_B64=${invalidUtf8.toString('base64')}\nPI_SANDBOX_PATCH_META=${JSON.stringify(invalidMeta)}\n`));
  const encoded = valid.toString('base64');
  const folded = stripPatch(`before\nPI_SANDBOX_PATCH_B64=${encoded.slice(0, 8)}\r\n${encoded.slice(8)}\nPI_SANDBOX_PATCH_META=${metadata(valid)}\n`);
  assert.deepEqual(Buffer.from(folded.patch), valid);
  const empty = Buffer.alloc(0);
  const emptyResult = stripPatch(`\nPI_SANDBOX_PATCH_B64=\nPI_SANDBOX_PATCH_META=${metadata(empty)}\n`);
  assert.equal(emptyResult.patch, '');
  assert.equal(emptyResult.patchSha256, sha(empty));
});

test('host capture validates metadata and preserves BOM, CRLF, multibyte, and replacement bytes', () => {
  const bytes = Buffer.from('\ufeffdiff --git a/x b/x\r\n+café and �\r\n', 'utf8');
  const checked = checkPatchBytes(bytes, issued);
  const stdout = `worker output\nPI_SANDBOX_PATCH_B64=${bytes.toString('base64')}\nPI_SANDBOX_PATCH_META=${JSON.stringify(checked)}\n`;
  const captured = stripPatch(stdout);
  assert.equal(captured.patch, bytes.toString('utf8'));
  assert.deepEqual(Buffer.from(captured.patch, 'utf8'), bytes);
  assert.equal(captured.patchSha256, sha(bytes));
  assert.equal(captured.patchBytes, bytes.length);
  assert.equal(captured.secretLikeContent, false);
  assert.throws(() => stripPatch(`\nPI_SANDBOX_PATCH_B64=QQ==\nPI_SANDBOX_PATCH_META=${JSON.stringify({...checked,patchBytes:999})}\n`));
});

test('summarize drops every hostile field for all issued token encodings', async () => {
  const encoded = encodeURIComponent(issued);
  const forms = [issued, Buffer.from(issued).toString('base64'), encoded, encoded.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase())];
  const request = { target: 'synthetic', provider: 'synthetic', model: 'synthetic' };
  for (const needle of new Set(forms)) {
    const hostile = `hostile ${needle}`;
    const result = summarize({ failureCode: ISSUED_BLOCK, stdout: hostile, stderr: hostile, exitCode: 0, patch: hostile, cleanup: { error: hostile, stderr: hostile }, error: hostile }, request);
    assert.deepEqual(result, { target: request.target, requestedProvider: request.provider, requestedModel: request.model, ok: false, failureCode: ISSUED_BLOCK, failure: ISSUED_BLOCK, exitCode: 0, cleanup: {} });
    const dir = mkdtempSync(join(tmpdir(), 'hostile-ledger-'));
    try {
      const ledger = createRequestLedger(dir);
      const input = { requestId: `hostile-${forms.indexOf(needle)}`, operation: 'dispatch_subagent', input: { target: 'synthetic' } };
      await ledger.execute(input, async () => result);
      const finalPath = join(dir, sha(Buffer.from(input.requestId)), 'final.json');
      const persisted = readFileSync(finalPath, 'utf8');
      const exported = JSON.stringify(exportResult(JSON.parse(persisted).result).result);
      assert.equal(persisted.includes(needle), false);
      assert.equal(exported.includes(needle), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('blocked code discards streams and export preserves only tagged direct patch bytes', () => {
  const needle = Buffer.from(issued).toString('base64');
  const blocked = stripPatch(`synthetic ${needle}`, `\n${ISSUED_BLOCK}\n`);
  assert.deepEqual(blocked, { stdout: '', stderr: '', failure: ISSUED_BLOCK });
  const constructed = 'Bear' + 'er' + ' ' + '$' + '{token}';
  const patch = `\ufeffdiff --git a/x b/x\r\n+café and �\r\n+${constructed}`;
  const tagged = exportResult({ patch, patchPolicy: PATCH_POLICY, patchSha256: sha(Buffer.from(patch)), secretLikeContent: true }).result;
  assert.equal(tagged.patch, patch);
  assert.equal(tagged.patchSha256, sha(Buffer.from(patch)));
  const legacy = exportResult({ patch, finalText: patch }).result;
  assert.notEqual(legacy.patch, patch);
  assert.equal(legacy.finalText.includes(constructed), false);
  assert.equal(legacy.patchPolicy, undefined);
  assert.equal(Object.hasOwn(legacy, 'secretLikeContent'), false);
  const forged = exportResult({ nested: { patch, patchPolicy: PATCH_POLICY }, response: { response: { patch }, structuredResult: { patch }, result: { patch }, evidence: [patch], log: patch, error: patch } }).result;
  assert.notEqual(forged.nested.patch, patch);
  assert.notEqual(forged.response.response.patch, patch);
  assert.notEqual(forged.response.structuredResult.patch, patch);
  assert.notEqual(forged.response.result.patch, patch);
  assert.equal(forged.response.evidence[0].includes(constructed), false);
  assert.equal(forged.response.log.includes(constructed), false);
  assert.equal(forged.response.error.includes(constructed), false);
  assert.equal(exportResult({ result: 'no patch' }).result.patchPolicy, undefined);
  assert.deepEqual(legacy, sanitizeResult({ patch, finalText: patch }));
});

test('ledger persistence and export retain tagged raw patch and do not rewrite legacy records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-ledger-'));
  try {
    const ledger = createRequestLedger(dir);
    const patch = '\ufeffdiff --git a/x b/x\r\n+café and �';
    const digest = sha(Buffer.from(patch));
    const input = { requestId: 'tagged-patch-record', access: 'workspace-write', task: { role: 'worker', objective: 'synthetic' } };
    const captured = { response: { ok: true, patch, patchPolicy: PATCH_POLICY, patchSha256: digest, patchBytes: Buffer.byteLength(patch), secretLikeContent: true } };
    await ledger.execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => captured);
    const entry = join(dir, sha(Buffer.from(input.requestId)));
    const finalPath = join(entry, 'final.json');
    const stored = JSON.parse(readFileSync(finalPath, 'utf8')).result.response;
    assert.equal(stored.patch, patch);
    assert.deepEqual(Buffer.from(stored.patch), Buffer.from(patch));
    assert.equal(stored.patchSha256, sha(Buffer.from(stored.patch)));
    const exported = exportResult((await ledger.execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => assert.fail('must replay'))).value).result;
    assert.equal(exported.response.patch, patch);

    const legacyInput = { ...input, requestId: 'legacy-patch-record' };
    await ledger.execute({ requestId: legacyInput.requestId, operation: 'dispatch_subagent', input: legacyInput }, async () => ({ response: { ok: true, patch } }));
    const legacyPath = join(dir, sha(Buffer.from(legacyInput.requestId)), 'final.json');
    const before = readFileSync(legacyPath);
    const replay = await createRequestLedger(dir).execute({ requestId: legacyInput.requestId, operation: 'dispatch_subagent', input: legacyInput }, async () => assert.fail('must replay'));
    assert.equal(replay.value.response.patch, patch);
    assert.equal(exportResult(replay.value).result.response.patchPolicy, 'legacy');
    assert.deepEqual(readFileSync(legacyPath), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persisted legacy reads preserve root and direct-response patch bytes without rewriting disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-patch-reads-'));
  try {
    const ledger = createRequestLedger(dir);
    const input = { requestId: 'legacy-exact-read', access: 'workspace-write', task: { role: 'worker', objective: 'synthetic' } };
    await ledger.execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => ({ response: { ok: true } }));
    const finalPath = join(dir, sha(Buffer.from(input.requestId)), 'final.json');
    const record = JSON.parse(readFileSync(finalPath, 'utf8'));
    const constructed = 'Bear' + 'er' + ' ' + '$' + '{token}';
    const rootPatch = `diff --git a/root b/root\r\n+${constructed}`;
    const responsePatch = `diff --git a/response b/response\r\n+${constructed}`;
    record.result = { patch: rootPatch, finalText: constructed, response: { patch: responsePatch, log: constructed } };
    writeFileSync(finalPath, `${JSON.stringify(record)}\n`);
    const onDisk = readFileSync(finalPath);
    const diskHash = sha(onDisk);
    for (let read = 0; read < 2; read += 1) {
      const replay = await createRequestLedger(dir).execute({ requestId: input.requestId, operation: 'dispatch_subagent', input }, async () => assert.fail('must replay'));
      assert.equal(replay.value.patch, rootPatch);
      assert.equal(replay.value.patchPolicy, 'legacy');
      assert.equal(Object.hasOwn(replay.value, 'secretLikeContent'), false);
      assert.equal(replay.value.response.patch, responsePatch);
      assert.equal(replay.value.response.patchPolicy, 'legacy');
      assert.equal(replay.value.response.log.includes(constructed), false);
      const exported = exportResult(replay.value).result;
      assert.equal(exported.patch, rootPatch);
      assert.equal(exported.response.patch, responsePatch);
      assert.equal(exported.finalText.includes(constructed), false);
      assert.equal(sha(readFileSync(finalPath)), diskHash);
    }
    const forgedInput = { requestId: 'fresh-forged-legacy', access: 'workspace-write', task: { role: 'worker', objective: 'synthetic' } };
    await ledger.execute({ requestId: forgedInput.requestId, operation: 'dispatch_subagent', input: forgedInput }, async () => ({ patch: rootPatch, patchPolicy: 'legacy' }));
    const forgedPath = join(dir, sha(Buffer.from(forgedInput.requestId)), 'final.json');
    const forgedStored = JSON.parse(readFileSync(forgedPath, 'utf8')).result;
    assert.notEqual(forgedStored.patch, rootPatch);
    assert.equal(forgedStored.patchPolicy, 'legacy');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('capture sanitizes fresh root and direct-response patches despite forged legacy labels', () => {
  const constructed = 'Bear' + 'er' + ' ' + '$' + '{token}';
  const captured = sanitizeCapturedResult({
    patch: constructed, patchPolicy: 'legacy',
    response: { patch: constructed, patchPolicy: 'legacy', structuredResult: { patch: constructed, patchPolicy: 'legacy' }, response: { patch: constructed, patchPolicy: 'issued-credential-v1' } },
  }, { mode: 'capture' });
  assert.notEqual(captured.patch, constructed);
  assert.notEqual(captured.response.patch, constructed);
  assert.notEqual(captured.response.structuredResult.patch, constructed);
  assert.notEqual(captured.response.response.patch, constructed);
});

test('stored no-patch records discard stale legacy labels and scan flags at root and response', () => {
  const constructed = 'Bear' + 'er' + ' ' + '$' + '{token}';
  const stored = sanitizeCapturedResult({
    patchPolicy: 'legacy', secretLikeContent: true,
    response: { patchPolicy: 'legacy', secretLikeContent: true, log: constructed },
  }, { mode: 'stored' });
  assert.equal(stored.patchPolicy, undefined);
  assert.equal(stored.secretLikeContent, undefined);
  assert.equal(stored.response.patchPolicy, undefined);
  assert.equal(stored.response.secretLikeContent, undefined);
  assert.equal(stored.response.log.includes(constructed), false);
});

test('effective host projections preserve stored root and response patch bytes without disk rewrites', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-legacy-projections-'));
  try {
    const constructed = 'Bear' + 'er' + ' ' + '$' + '{token}';
    const rootPatch = `diff --git a/root b/root\r\n+${constructed}`;
    const responsePatch = `diff --git a/response b/response\r\n+${constructed}`;
    const workspace = '/synthetic/workspace';
    const contractTemplate = { version: 2, role: 'Chesed', stage: 'implementing', mode: 'standalone', parentRunId: null, workspaceSha256: sha(Buffer.from(workspace)), resultSha256: 'a'.repeat(64) };
    const structuredResult = { status: 'completed', result: 'synthetic result', evidence: ['synthetic evidence'], changedFiles: [], assumptions: [], uncertainty: [], errors: [], nextAction: 'none', deliverable: { summary: 'synthetic', changes: [], checks: [] } };
    for (const [suffix, exitCode, expectedState] of [['passed', 0, 'completed'], ['failed', 1, 'failed']]) {
      const ledger = createRequestLedger(dir);
      const requestId = `legacy-host-${suffix}`;
      const originalResult = { patch: rootPatch, response: { patch: responsePatch, log: constructed }, structuredResult };
      const input = { requestId, access: 'workspace-write', task: { role: 'worker', objective: 'synthetic' } };
      await ledger.execute({ requestId, operation: 'dispatch_subagent', input }, async () => originalResult);
      ledger.recordOutcome(requestId, { ok: true });
      const pending = { requestId, artifactSha256: 'b'.repeat(64), resultSha256: hostRecordDigest(originalResult), workspace, parentRunId: null, goal: 'synthetic projection fixture', phase: 1, requiredCheckNames: ['synthetic-check'] };
      ledger.registerHostPending(pending, { originalResult, contractTemplate });
      const hostDir = join(dir, 'host-verification', sha(Buffer.from(requestId)));
      const originalPath = join(hostDir, 'original.json');
      const originalRecord = JSON.parse(readFileSync(originalPath, 'utf8'));
      originalRecord.result.patch = rootPatch;
      originalRecord.result.response.patch = responsePatch;
      writeFileSync(originalPath, `${JSON.stringify(originalRecord)}\n`);
      const paths = [originalPath, join(dir, sha(Buffer.from(requestId)), 'final.json'), join(dir, 'outcomes', `${sha(Buffer.from(requestId))}.json`)];
      const diskBefore = paths.map(path => readFileSync(path));
      const assertProjection = state => {
        const value = ledger.getEffectiveResult(requestId);
        assert.equal(value.state, state);
        assert.equal(value.patch, rootPatch);
        assert.equal(value.patchPolicy, 'legacy');
        assert.equal(value.secretLikeContent, undefined);
        assert.equal(value.response.patch, responsePatch);
        assert.equal(value.response.patchPolicy, 'legacy');
        assert.equal(value.response.secretLikeContent, undefined);
        assert.equal(value.response.log.includes(constructed), false);
        const exported = exportResult(value).result;
        assert.equal(exported.patch, rootPatch);
        assert.equal(exported.response.patch, responsePatch);
        assert.equal(exported.response.log.includes(constructed), false);
        assert.deepEqual(paths.map(path => readFileSync(path)), diskBefore);
      };
      assertProjection('awaiting-host-verification');
      ledger.recordHostVerification({ requestId, artifactSha256: pending.artifactSha256, commands: [{ checkName: 'synthetic-check', command: 'synthetic fixture', exitCode, outputSummary: 'synthetic output' }] });
      assertProjection(expectedState);
      assertProjection(expectedState);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new flagged root and response patches survive capture, all persisted projections, and export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flagged-patch-projections-'));
  try {
    const constructed = 'Bear' + 'er' + ' ' + '$' + '{token}';
    const rootPatch = `diff --git a/root b/root\r\n+${constructed}`;
    const responsePatch = `diff --git a/response b/response\r\n+${constructed}`;
    const patchInfo = patch => ({
      patch,
      patchPolicy: PATCH_POLICY,
      patchSha256: sha(Buffer.from(patch)),
      patchBytes: Buffer.byteLength(patch),
      secretLikeContent: true,
      patchConfirmationRequired: true,
    });
    const structuredResult = {
      status: 'completed', result: 'synthetic result', evidence: ['synthetic evidence'],
      changedFiles: [], assumptions: [], uncertainty: [], errors: [], nextAction: 'none',
      deliverable: { summary: 'synthetic', changes: [], checks: [] },
    };
    const originalResult = { ...patchInfo(rootPatch), response: { ...patchInfo(responsePatch) }, structuredResult };
    const requestId = 'new-flagged-patch-projections';
    const input = { requestId, access: 'workspace-write', task: { role: 'worker', objective: 'synthetic' } };
    const ledger = createRequestLedger(dir);
    await ledger.execute({ requestId, operation: 'dispatch_subagent', input }, async () => originalResult);
    const entry = join(dir, sha(Buffer.from(requestId)));
    const finalPath = join(entry, 'final.json');
    const stored = JSON.parse(readFileSync(finalPath, 'utf8')).result;
    assert.equal(stored.patch, rootPatch);
    assert.equal(stored.response.patch, responsePatch);
    const assertPatch = (value, where) => {
      for (const [record, expected] of [[value, rootPatch], [value.response, responsePatch]]) {
        assert.equal(record.patch, expected, `${where}: exact patch text`);
        assert.equal(record.patchPolicy, PATCH_POLICY, `${where}: policy`);
        assert.equal(record.secretLikeContent, true, `${where}: warning flag`);
        assert.equal(typeof record.secretLikeContent, 'boolean');
        assert.equal(record.patchConfirmationRequired, true, `${where}: confirmation flag`);
        assert.equal(typeof record.patchConfirmationRequired, 'boolean');
        assert.equal(record.patchSha256, sha(Buffer.from(expected)), `${where}: byte-bound hash`);
        assert.equal(record.patchBytes, Buffer.byteLength(expected), `${where}: byte length`);
        assert.deepEqual(Buffer.from(record.patch, 'utf8'), Buffer.from(expected, 'utf8'));
      }
    };
    assertPatch(stored, 'captured final.json');
    const replay = await createRequestLedger(dir).execute({ requestId, operation: 'dispatch_subagent', input }, async () => assert.fail('must replay'));
    assertPatch(replay.value, 'persistent replay');
    assertPatch(exportResult(replay.value).result, 'export');

    const workspace = '/synthetic/workspace';
    const contractTemplate = { version: 2, role: 'Chesed', stage: 'implementing', mode: 'standalone', parentRunId: null, workspaceSha256: sha(Buffer.from(workspace)), resultSha256: 'a'.repeat(64) };
    const assertEffective = (requestId, state, where) => {
      const value = ledger.getEffectiveResult(requestId);
      assert.equal(value.state, state);
      assertPatch(value, where);
      assertPatch(exportResult(value).result, `${where} export`);
    };
    const pending = { requestId, artifactSha256: 'b'.repeat(64), resultSha256: hostRecordDigest(originalResult), workspace, parentRunId: null, goal: 'synthetic projection fixture', phase: 1, requiredCheckNames: ['synthetic-check'] };
    ledger.registerHostPending(pending, { originalResult, contractTemplate });
    assertEffective(requestId, 'awaiting-host-verification', 'awaiting persisted projection');
    for (const [suffix, exitCode, state] of [['failed', 1, 'failed'], ['completed', 0, 'completed']]) {
      const checkedId = `${requestId}-${suffix}`;
      const checkedLedger = createRequestLedger(dir);
      await checkedLedger.execute({ requestId: checkedId, operation: 'dispatch_subagent', input: { ...input, requestId: checkedId } }, async () => originalResult);
      checkedLedger.recordOutcome(checkedId, { ok: true });
      const checkedPending = { ...pending, requestId: checkedId };
      checkedLedger.registerHostPending(checkedPending, { originalResult, contractTemplate });
      checkedLedger.recordHostVerification({ requestId: checkedId, artifactSha256: checkedPending.artifactSha256, commands: [{ checkName: 'synthetic-check', command: 'synthetic fixture only', exitCode, outputSummary: 'synthetic fixture only' }] });
      assertEffective(checkedId, state, `${state} persisted projection`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('host-pending capture persists tagged exact patch bytes and hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-host-pending-'));
  try {
    const ledger = createRequestLedger(dir);
    const patch = '\ufeffdiff --git a/x b/x\r\n+café and �';
    const originalResult = { response: { ok: true, patch, patchPolicy: PATCH_POLICY, patchSha256: sha(Buffer.from(patch)), patchBytes: Buffer.byteLength(patch), secretLikeContent: false } };
    const requestId = 'host-patch-bytes';
    const workspace = '/workspace';
    const contractTemplate = { version: 2, role: 'Chesed', stage: 'implementing', mode: 'standalone', parentRunId: null, workspaceSha256: sha(Buffer.from(workspace)), resultSha256: 'a'.repeat(64) };
    const pending = { requestId, artifactSha256: 'b'.repeat(64), resultSha256: hostRecordDigest(originalResult), workspace, parentRunId: null, goal: 'verify bytes', phase: 1, requiredCheckNames: ['tests'] };
    ledger.registerHostPending(pending, { originalResult, contractTemplate });
    const originalPath = join(dir, 'host-verification', sha(Buffer.from(requestId)), 'original.json');
    const stored = JSON.parse(readFileSync(originalPath, 'utf8')).result.response;
    assert.equal(stored.patch, patch);
    assert.equal(stored.patchSha256, sha(Buffer.from(stored.patch)));
    assert.equal(stored.patchBytes, Buffer.byteLength(stored.patch));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI blocked response exposes only the fixed code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  try {
    const patchPath = join(dir, 'patch.diff');
    writeFileSync(patchPath, Buffer.from(`+${issued}`));
    const script = fileURLToPath(new URL('../scripts/patch-policy.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, patchPath], { input: issued, encoding: 'utf8' });
    assert.equal(run.status, 4);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, ISSUED_BLOCK);
    for (const needle of [issued, Buffer.from(issued).toString('base64'), encodeURIComponent(issued)]) {
      assert.equal(run.stdout.includes(needle), false);
      assert.equal(run.stderr.includes(needle), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
