import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { doctor, runHeadless } from './headless-host.mjs';

// Deliberately opt-in and fixed-prompt: never sends a repository or raw credentials.
export async function acceptHeadless(config, { live = false, cancel = false, signal } = {}) {
  if (cancel && !live) throw Error('live_required_for_cancellation');
  const report = await doctor(config, { signal });
  const results = {};
  for (const [client, probe] of Object.entries(report.clients)) {
    results[client] = { installation: probe.status, authentication: 'unverified', response: 'unverified',
      permissions: 'unverified', cancellation: 'unverified', piMcp: 'unverified' };
    if (!live || probe.status !== 'ready') continue;
    if (signal?.aborted) { results[client].response = 'failed'; results[client].reason = 'cancelled'; continue; }
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'yhwh-cli-acceptance-'));
    try {
      // Codex expects a Git workspace; init is confined to the disposable fixture.
      execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', fixture], { windowsHide: true, stdio: 'pipe' });
      const nonce = `YHWH_OK_${randomUUID().replaceAll('-', '')}`;
      const c = { ...config, workspaceRoots: [fixture], timeoutSeconds: Math.min(90, config.timeoutSeconds) };
      const result = await runHeadless(c, { client, cwd: fixture, prompt: `This is a connection test, not a coding task. Do not use any tools, files, network tools or MCP. Reply with exactly ${nonce} and nothing else.` }, { signal, heartbeat: true });
      const exact = result.status === 'completed' && result.text.trim() === nonce;
      Object.assign(results[client], { response: exact ? 'passed' : result.status === 'completed' ? 'failed' : result.status,
        authentication: exact ? 'live-response-verified' : 'unverified', reason: result.reason ?? (exact ? null : 'unexpected_response'),
        timings: result.evidence ? { totalMs: result.evidence.totalMs, preflightMs: result.evidence.preflightMs, firstResponseMs: result.evidence.firstResponseMs } : null });
      if (cancel && exact && !signal?.aborted) {
        const controller = new AbortController(); let timer, cancelledAt = null, started = false;
        try {
          const stopped = await runHeadless(c, { client, cwd: fixture, prompt: `This is a connection cancellation test. Do not use tools, files, network tools or MCP. Reply exactly ${nonce}.` }, {
            heartbeat: true, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
            onStarted: () => { started = true; timer = setTimeout(() => { cancelledAt = Date.now(); controller.abort(); }, 1500); },
          });
          const passed = started && cancelledAt !== null && stopped.reason === 'cancelled';
          results[client].cancellation = passed ? 'passed' : stopped.reason === 'cleanup_unverified' ? 'failed' : 'unverified';
          results[client].cancellationEvidence = { started, cancelRequested: cancelledAt !== null, reason: stopped.reason ?? 'completed_before_cancel', cleanupMs: cancelledAt === null ? null : Date.now() - cancelledAt,
            scope: 'native CLI process cancellation; remote model computation and billing are not observable' };
        } finally { clearTimeout(timer); }
      }
    } catch { results[client].response = 'failed'; results[client].reason = 'fixture_or_launch_failed'; }
    finally {
      const resolved = path.resolve(fixture), parent = path.resolve(os.tmpdir());
      if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('yhwh-cli-acceptance-')) throw Error('unsafe_fixture_cleanup');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  return { schemaVersion: 1, mode: live ? 'live-fixed-prompt' : 'offline', modelCalls: live ? 'unverified' : 0,
    checkedAt: new Date().toISOString(), cancellationRequested: cancel, clients: results,
    complete: false, note: 'A live response proves connectivity only; permission, cancellation and CLI-to-Pi checks remain separate.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [configFile, ...flags] = process.argv.slice(2);
    if (flags.some(flag => !['--live', '--cancel'].includes(flag)) || new Set(flags).size !== flags.length) throw Error('invalid_option');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
    const controller = new AbortController();
    const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
    let result;
    try { result = await acceptHeadless(config, { live: flags.includes('--live'), cancel: flags.includes('--cancel'), signal: controller.signal }); }
    finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    console.log(JSON.stringify(result, null, 2));
    if (Object.values(result.clients).some(c => !['ready', 'disabled'].includes(c.installation) || (flags.includes('--live') && c.installation === 'ready' && (c.response !== 'passed' || (result.cancellationRequested && c.cancellation !== 'passed'))))) process.exitCode = 1;
  } catch { console.log(JSON.stringify({ status: 'failed', reason: 'acceptance_configuration_or_io_error' })); process.exitCode = 1; }
}
