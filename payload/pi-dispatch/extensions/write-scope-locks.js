import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function normalizeScope(cwd, value) {
  const tree = value.endsWith('/**') || value.endsWith('\\**');
  const raw = tree ? value.slice(0, -3) : value;
  const path = resolve(cwd, raw).toLowerCase();
  const rel = relative(cwd, path);
  if (isAbsolute(value) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('write lock scope is outside cwd');
  return { path, tree };
}

export function scopesOverlap(left, right) {
  const contains = (directory, candidate) => candidate === directory || candidate.startsWith(`${directory}${sep}`);
  if (!left.tree && !right.tree) return left.path === right.path;
  if (left.tree && right.tree) return contains(left.path, right.path) || contains(right.path, left.path);
  return left.tree ? contains(left.path, right.path) : contains(right.path, left.path);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function createWriteScopeLockManager(directory) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const mutex = join(root, '.mutex');

  function takeMutex() {
    try { mkdirSync(mutex); return true; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(mutex).mtimeMs > 10_000) { rmdirSync(mutex); mkdirSync(mutex); return true; }
      } catch { /* Another process owns or repaired it. */ }
      return false;
    }
  }

  function releaseMutex() { try { rmdirSync(mutex); } catch { /* Best effort; stale mutex recovery is bounded above. */ } }

  function tryAcquire({ requestId, cwd, writeScope, timeoutSeconds }) {
    if (!takeMutex()) return null;
    try {
      const scopes = writeScope.map(value => normalizeScope(cwd, value));
      for (const name of readdirSync(root).filter(name => name.endsWith('.json'))) {
        const path = join(root, name);
        let active;
        try { active = JSON.parse(readFileSync(path, 'utf8')); }
        catch { return null; }
        if (active.expiresAt < Date.now() || !processAlive(active.pid)) { try { unlinkSync(path); } catch {} continue; }
        if (active.scopes.some(left => scopes.some(right => scopesOverlap(left, right)))) return null;
      }
      const token = `${process.pid}-${randomUUID()}`;
      const path = join(root, `${token}.json`);
      writeFileSync(path, `${JSON.stringify({ requestId, pid: process.pid, acquiredAt: Date.now(), expiresAt: Date.now() + timeoutSeconds * 1000 + 60_000, scopes })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { token, path };
    } finally { releaseMutex(); }
  }

  function release(lock) {
    if (!lock?.path || !existsSync(lock.path)) return;
    try { unlinkSync(lock.path); } catch { /* Expiry and PID cleanup provide fail-safe recovery. */ }
  }

  return { enabled: true, persistent: true, root, tryAcquire, release };
}
