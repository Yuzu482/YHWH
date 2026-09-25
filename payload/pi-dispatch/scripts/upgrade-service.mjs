import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { planUpgrade, applyUpgrade } from './plugin-upgrade.mjs';

async function main() {
  const [sourceRoot, targetRoot, settingsFile, baseline, mode] = process.argv.slice(2);
  if (mode && mode !== '--apply') throw Error('invalid_option');
  const plan = planUpgrade({ sourceRoot, targetRoot, ...(baseline && baseline !== '-' ? { baselineRoot: baseline } : {}) });
  if (mode !== '--apply') { console.log(JSON.stringify(plan, null, 2)); return; }
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, ''));
  const uri = new URL(s.gatewayUrl);
  if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || uri.pathname !== '/' || uri.username || uri.password || uri.search || uri.hash ||
      fs.realpathSync(s.gatewayScript) !== fs.realpathSync(path.join(targetRoot, 'scripts/gateway.mjs')) || !path.isAbsolute(s.nodePath)) throw Error('invalid_runtime_settings');
  const token = fs.readFileSync(s.tokenFile, 'utf8').trim();
  let pid = null, child = null, ownsPause = false;
  async function request(route, method = 'GET') {
    const r = await fetch(new URL(route, uri), { method, headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(route.endsWith('/stop') ? 30000 : 3000) });
    if (!r.ok) throw Error('runtime_request_failed');
    return r.json();
  }
  const runtime = {
    pause: async () => {
      try {
        const r = await request('/admin/upgrade/pause', 'POST');
        ownsPause = r.ok === true;
        if (r.ok !== true || !Number.isInteger(r.pid) || r.pid <= 0 || r.pid === process.pid || process.platform !== 'win32') throw Error('invalid_runtime_identity');
        const verifier = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../install/Assert-GatewayProcess.ps1');
        execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', verifier, '-TargetPid', String(r.pid), '-Executable', fs.realpathSync(s.nodePath), '-GatewayScript', fs.realpathSync(s.gatewayScript)],
          { windowsHide: true, stdio: 'pipe', timeout: 10000 });
        pid = r.pid; return true;
      } catch {
        if (ownsPause) { try { if (await runtime.resume() !== true) throw Error(); } catch { throw Error('runtime_resume_failed'); } }
        return false;
      }
    },
    resume: async () => {
      if (!ownsPause) return false;
      const result = await request('/admin/upgrade/resume', 'POST');
      if (result.ok !== true) return false;
      ownsPause = false; return true;
    },
    stop: async () => {
      if (child?.pid) pid = child.pid;
      let aliveBefore = false;
      if (pid) { try { process.kill(pid, 0); aliveBefore = true; } catch (e) { if (e.code !== 'ESRCH') return false; } }
      if (aliveBefore) {
        try { const identity = await request('/admin/upgrade/status', 'POST'); if (identity.pid !== pid) return false; } catch { return false; }
        try { await request('/admin/upgrade/pause', 'POST'); } catch {} // Already paused is expected.
        try { const r = await request('/admin/upgrade/stop', 'POST'); if (!r.ok || !r.disposed || r.pid !== pid) return false; } catch { return false; }
      }
      for (let i = 0; i < 100; i++) {
        let alive = false;
        if (pid) { try { process.kill(pid, 0); alive = true; } catch (e) { if (e.code !== 'ESRCH') return false; } }
        try { await request('/healthz'); } catch { if (!alive) { child = null; pid = null; ownsPause = false; return true; } }
        await delay(100);
      }
      return false;
    },
    start: async () => {
      child = spawn(s.nodePath, [s.gatewayScript], { windowsHide: true, detached: true, shell: false, stdio: 'ignore',
        env: { ...process.env, PI_GATEWAY_CONFIG: s.gatewayConfig, PI_DISPATCH_SANDBOX: 'wsl2-bwrap', PI_SANDBOX_DISTRO: s.wslDistro } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    },
    health: async () => {
      for (let i = 0; i < 120; i++) {
        try {
          const identity = await request('/admin/upgrade/status', 'POST');
          if (identity.pid === child?.pid && identity.phase === 'running' && (await request('/healthz')).ok === true && (await request('/readyz')).ok === true && child.exitCode === null) return true;
        } catch {}
        if (child && child.exitCode !== null) return false;
        await delay(250);
      }
      return false;
    },
  };
  const result = await applyUpgrade(plan, runtime);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'completed') process.exitCode = 1;
}
main().catch(() => { console.log('{"status":"blocked","reason":"upgrade_preflight_or_runtime_failed"}'); process.exitCode = 1; });
