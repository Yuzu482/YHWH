import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const hash = b => createHash('sha256').update(b).digest('hex');
const marker = '.yhwh-managed-files.json';
function readMarker(root) {
  const file = path.join(root, marker);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1024 * 1024) throw Error('invalid_baseline');
  return fs.readFileSync(file);
}
const excluded = p => p.split('/').some(s => ['node_modules', '.git', '.test', '.runtime', 'diagnostics', '__pycache__'].includes(s) || s.startsWith('.env') || s.includes('.local.') || /\.(log|bak|backup|pyc)$/.test(s) || /^(?:.*token|.*key).*\.txt$/i.test(s)) ||
  ['.mcp.json', marker, 'auth.json', 'provider-config.json', 'provider-credentials.json', 'anthropic-api-key.json'].includes(path.posix.basename(p));
function safe(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '.' || p === '..') || excluded(relative)) throw Error('unsafe_managed_path');
  const base = fs.realpathSync(root), full = path.resolve(base, relative);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current)) { const s = fs.lstatSync(current); if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink > 1))) throw Error('unsafe_managed_file'); }
  }
  return full;
}
function digest(root, p) { const f = safe(root, p); return fs.existsSync(f) ? hash(fs.readFileSync(f)) : null; }
export function inventory(root) {
  const result = {};
  function visit(dir, prefix = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = prefix + e.name;
      if (excluded(p)) continue;
      if (e.isSymbolicLink()) throw Error('unsafe_managed_file');
      if (e.isDirectory()) visit(path.join(dir, e.name), p + '/');
      else { if (Object.keys(result).length >= 4096 || fs.statSync(safe(root, p)).size > 16 * 1024 * 1024) throw Error('inventory_limit'); result[p] = digest(root, p); }
    }
  }
  visit(fs.realpathSync(root)); return result;
}
function atomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + `.upgrade-${randomUUID()}`;
  try { fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function recordInstallation(sourceRoot, targetRoot) {
  readMarker(targetRoot);
  const files = inventory(sourceRoot);
  for (const p of Object.keys(files)) if (digest(targetRoot, p) !== files[p]) throw Error('installation_source_mismatch');
  atomic(path.join(targetRoot, marker), JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n');
}
export function planUpgrade({ sourceRoot, targetRoot, baselineRoot }) {
  sourceRoot = fs.realpathSync(sourceRoot); targetRoot = fs.realpathSync(targetRoot);
  const inside = (a, b) => { const r = path.relative(a, b); return r === '' || (!path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep)); };
  if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) throw Error('overlapping_upgrade_roots');
  const next = inventory(sourceRoot);
  const baseline = baselineRoot ? inventory(baselineRoot) : JSON.parse(readMarker(targetRoot)?.toString() ?? 'null')?.files;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline) || Object.keys(baseline).length > 4096) throw Error('invalid_baseline');
  const actions = [], conflicts = [];
  for (const p of [...new Set([...Object.keys(next), ...Object.keys(baseline)])].sort()) {
    if (baseline[p] !== undefined && !/^[a-f0-9]{64}$/.test(baseline[p])) throw Error('invalid_baseline');
    const current = digest(targetRoot, p), before = baseline[p] ?? null, after = next[p] ?? null;
    if (current !== before && current !== after) conflicts.push(p);
    else if (current !== after) actions.push({ path: p, before: current, after });
  }
  // Dependency changes need a separately validated staged installation.
  const dependencyChange = actions.some(a => ['package.json', 'package-lock.json'].includes(a.path));
  // These files also have installed WSL copies; a host-only transaction cannot update them.
  const wslScripts = new Set(['validate-write-scope.mjs','snapshot-scope.py','lsp-result.mjs','prepare-credentials.mjs','direct-lsp-bootstrap.mjs','legacy-structural-bootstrap.mjs','multilspy-probe.py','secure-pi-bootstrap.mjs','editor-pi-bootstrap.mjs','lsp-sandbox-broker.mjs','csharp-probe-project.mjs','java-probe-launch.py','editor-rpc.mjs','accept-api-packet.mjs','controlled-provider.mjs','provider-transport.mjs','anthropic-api-credential.mjs']);
  const requiresFullInstall = actions.some(a => a.path.startsWith('sandbox/') || a.path.startsWith('extensions/') || (a.path.startsWith('scripts/') && wslScripts.has(path.posix.basename(a.path))));
  const plan = { schemaVersion: 1, sourceRoot, targetRoot, actions, conflicts, dependencyChange, requiresFullInstall,
    admissible: conflicts.length === 0 && !dependencyChange && !requiresFullInstall, files: next };
  return { ...plan, sha256: hash(JSON.stringify(plan)) };
}

export async function applyUpgrade(plan, runtime) {
  const { sha256, ...body } = plan;
  if (hash(JSON.stringify(body)) !== sha256 || !plan.admissible || plan.conflicts.length || plan.dependencyChange || plan.requiresFullInstall) throw Error('upgrade_plan_not_admissible');
  for (const name of ['pause', 'stop', 'start', 'health']) if (typeof runtime[name] !== 'function') throw Error('trusted_runtime_adapter_required');
  const parent = path.dirname(fs.realpathSync(plan.targetRoot));
  const lockFile = path.join(parent, '.yhwh-upgrade.lock');
  const lock = fs.openSync(lockFile, 'wx', 0o600);
  const backup = path.join(parent, `.yhwh-upgrade-${randomUUID()}`);
  let applied = [], stopped = false, paused = false, releaseLock = true;
  let oldMarker;
  function validateFiles() {
    for (const a of plan.actions) if (digest(plan.targetRoot, a.path) !== a.before || digest(plan.sourceRoot, a.path) !== a.after) throw Error('upgrade_plan_stale');
  }
  const journal = state => atomic(path.join(backup, 'journal.json'), JSON.stringify({ schemaVersion: 1, state, plan, applied }, null, 2));
  try {
    oldMarker = readMarker(plan.targetRoot);
    validateFiles();
    fs.mkdirSync(backup, { mode: 0o700 });
    for (const a of plan.actions) if (a.before !== null) {
      const dest = path.join(backup, 'files', a.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(safe(plan.targetRoot, a.path), dest);
      if (hash(fs.readFileSync(dest)) !== a.before) throw Error('backup_hash_mismatch');
    }
    if (oldMarker) fs.writeFileSync(path.join(backup, 'old-marker.json'), oldMarker, { mode: 0o600 });
    journal('prepared');
    if (await runtime.pause() !== true) return { status: 'blocked', reason: 'runtime_busy_or_unavailable' };
    paused = true;
    if (await runtime.stop() !== true) throw Error('runtime_stop_failed');
    stopped = true; validateFiles();
    journal('applying');
    for (const a of plan.actions) {
      if (digest(plan.targetRoot, a.path) !== a.before) throw Error('upgrade_plan_stale');
      // Journal intent before mutation so interrupted operations remain reviewable.
      applied.push(a.path); journal('applying');
      if (a.after === null) fs.unlinkSync(safe(plan.targetRoot, a.path));
      else atomic(safe(plan.targetRoot, a.path), fs.readFileSync(safe(plan.sourceRoot, a.path)));
    }
    for (const [p, expected] of Object.entries(plan.files)) if (digest(plan.targetRoot, p) !== expected) throw Error('upgrade_hash_mismatch');
    atomic(path.join(plan.targetRoot, marker), JSON.stringify({ schemaVersion: 1, files: plan.files }, null, 2) + '\n');
    journal('checking');
    await runtime.start();
    if (await runtime.health() !== true) throw Error('upgrade_health_failed');
    journal('completed');
    return { status: 'completed', changedFiles: applied, backup, planSha256: sha256 };
  } catch (error) {
    if (!stopped) {
      if (paused || error.message === 'runtime_resume_failed') {
        let resumed = false;
        try { resumed = await runtime.resume?.() === true; } catch {}
        if (!resumed) {
          releaseLock = false; journal('recovery-required');
          return { status: 'recovery-required', reason: 'runtime_resume_failed', backup };
        }
      }
      return { status: 'blocked', reason: error.message };
    }
    try {
      if (await runtime.stop() !== true) throw Error('rollback_stop_failed');
      for (const a of [...plan.actions].reverse().filter(a => applied.includes(a.path))) {
        const current = digest(plan.targetRoot, a.path);
        if (current !== a.after && current !== a.before) throw Error('rollback_conflict');
        if (a.before === null) { if (current !== null) fs.unlinkSync(safe(plan.targetRoot, a.path)); }
        else {
          const bytes = fs.readFileSync(path.join(backup, 'files', a.path));
          if (hash(bytes) !== a.before) throw Error('backup_hash_mismatch');
          atomic(safe(plan.targetRoot, a.path), bytes);
        }
      }
      const dest = path.join(plan.targetRoot, marker);
      if (oldMarker) atomic(dest, oldMarker); else if (fs.existsSync(dest)) fs.unlinkSync(dest);
      await runtime.start();
      if (await runtime.health() !== true) throw Error('rollback_health_failed');
      if (fs.existsSync(backup)) journal('rolled-back');
      return { status: 'rolled-back', reason: error.message, backup };
    } catch (rollbackError) {
      releaseLock = false;
      if (fs.existsSync(backup)) journal('recovery-required');
      return { status: 'recovery-required', reason: rollbackError.message, backup };
    }
  } finally {
    fs.closeSync(lock);
    // A recovery-required journal must be reconciled by an operator, not retried blindly.
    if (releaseLock) fs.unlinkSync(lockFile);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, sourceRoot, targetRoot, baselineRoot] = process.argv.slice(2);
    if (action === 'record') { recordInstallation(sourceRoot, targetRoot); console.log('{"status":"recorded"}'); }
    else if (action === 'plan') console.log(JSON.stringify(planUpgrade({ sourceRoot, targetRoot, baselineRoot }), null, 2));
    else throw Error('invalid_action');
  } catch { console.log('{"status":"blocked","reason":"upgrade_inventory_or_baseline_invalid"}'); process.exitCode = 1; }
}
