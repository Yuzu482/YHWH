import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordInstallation, planUpgrade, applyUpgrade } from '../scripts/plugin-upgrade.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yhwh-upgrade-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('yhwh-upgrade-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source'), targetRoot = path.join(root, 'installed');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(targetRoot);
  const put = (r, p, s) => { fs.mkdirSync(path.dirname(path.join(r, p)), { recursive: true }); fs.writeFileSync(path.join(r, p), s); };
  for (const r of [sourceRoot, targetRoot]) { put(r, 'scripts/main.mjs', 'old'); put(r, 'package.json', '{}'); put(r, 'removed.txt', 'remove me'); }
  recordInstallation(sourceRoot, targetRoot);
  put(targetRoot, '.mcp.json', 'local auth'); put(targetRoot, 'workflow/headless.local.json', 'local config');
  put(sourceRoot, 'scripts/main.mjs', 'new'); put(sourceRoot, 'added.txt', 'added'); fs.unlinkSync(path.join(sourceRoot, 'removed.txt'));
  const calls = [], runtime = Object.fromEntries(['pause', 'resume', 'stop', 'start', 'health'].map(n => [n, async () => { calls.push(n); return true; }]));
  return { root, sourceRoot, targetRoot, put, runtime, calls, plan: () => planUpgrade({ sourceRoot, targetRoot }) };
}

test('upgrade verifies managed bytes, adds/deletes files and preserves local auth', async t => {
  const f = fixture(t), p = f.plan();
  assert.equal(p.admissible, true); assert.equal(p.actions.length, 3);
  const r = await applyUpgrade(p, f.runtime);
  assert.equal(r.status, 'completed'); assert.deepEqual(f.calls, ['pause', 'stop', 'start', 'health']);
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'scripts/main.mjs'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'removed.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.targetRoot, '.mcp.json'), 'utf8'), 'local auth');
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'workflow/headless.local.json'), 'utf8'), 'local config');
  assert.equal(fs.existsSync(path.join(r.backup, 'files/.mcp.json')), false);
  assert.equal(f.plan().actions.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.yhwh-upgrade.lock')), false);
});
test('failed health restores old files and baseline before restarting old runtime', async t => {
  const f = fixture(t); let healthCalls = 0;
  f.runtime.health = async () => ++healthCalls > 1;
  const r = await applyUpgrade(f.plan(), f.runtime);
  assert.equal(r.status, 'rolled-back'); assert.equal(r.reason, 'upgrade_health_failed');
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'scripts/main.mjs'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'added.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'removed.txt'), 'utf8'), 'remove me');
  assert.equal(f.plan().actions.length, 3);
});
test('busy service, modified install, dependency change and tampered plan are rejected', async t => {
  const f = fixture(t); f.runtime.pause = async () => false;
  assert.equal((await applyUpgrade(f.plan(), f.runtime)).status, 'blocked'); assert.equal(f.calls.length, 0);
  f.put(f.targetRoot, 'scripts/main.mjs', 'user edit');
  assert.deepEqual(f.plan().conflicts, ['scripts/main.mjs']);
  await assert.rejects(applyUpgrade(f.plan(), f.runtime), /not_admissible/);
  f.put(f.targetRoot, 'scripts/main.mjs', 'old'); f.put(f.sourceRoot, 'package.json', '{"version":"2"}');
  assert.equal(f.plan().dependencyChange, true);
  const p = f.plan(); p.admissible = true;
  await assert.rejects(applyUpgrade(p, f.runtime), /not_admissible/);
});
test('source change between plan and apply cannot replace installation', async t => {
  const f = fixture(t), p = f.plan(); f.put(f.sourceRoot, 'added.txt', 'changed after review');
  const r = await applyUpgrade(p, f.runtime);
  assert.equal(r.status, 'blocked'); assert.equal(r.reason, 'upgrade_plan_stale'); assert.equal(f.calls.length, 0);
});
test('files with WSL copies require a full installation instead of host-only update', t => {
  const f = fixture(t); f.put(f.sourceRoot, 'scripts/multilspy-probe.py', '# changed probe');
  assert.equal(f.plan().requiresFullInstall, true); assert.equal(f.plan().admissible, false);
});
test('concurrent edit during health failure is preserved and recovery lock retained', async t => {
  const f = fixture(t); f.runtime.health = async () => { f.put(f.targetRoot, 'scripts/main.mjs', 'concurrent edit'); return false; };
  const r = await applyUpgrade(f.plan(), f.runtime);
  assert.equal(r.status, 'recovery-required'); assert.equal(r.reason, 'rollback_conflict');
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'scripts/main.mjs'), 'utf8'), 'concurrent edit');
  assert.equal(fs.existsSync(path.join(f.root, '.yhwh-upgrade.lock')), true);
});
test('unsafe baseline paths and overlapping roots fail before mutation', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.targetRoot, '.yhwh-managed-files.json'), JSON.stringify({ files: { '../escape': 'a'.repeat(64) } }));
  assert.throws(f.plan, /unsafe_managed_path/);
  assert.throws(() => planUpgrade({ sourceRoot: f.sourceRoot, targetRoot: f.sourceRoot }), /overlapping/);
});

test('backup and journal exist before stop; failed resume retains recovery evidence', async t => {
  const f=fixture(t);
  f.runtime.stop=async()=>{
    const name=fs.readdirSync(f.root).find(p=>p.startsWith('.yhwh-upgrade-'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,name,'journal.json'))).state,'prepared');
    assert.equal(fs.readFileSync(path.join(f.root,name,'files/scripts/main.mjs'),'utf8'),'old');
    return false;
  };
  f.runtime.resume=async()=>{throw Error('cannot resume')};
  const result=await applyUpgrade(f.plan(),f.runtime);
  assert.equal(result.status,'recovery-required');assert.equal(result.reason,'runtime_resume_failed');
  assert(fs.existsSync(path.join(f.root,'.yhwh-upgrade.lock')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup,'journal.json'))).state,'recovery-required');
});
