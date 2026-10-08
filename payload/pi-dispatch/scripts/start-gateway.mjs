import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const gatewayScript = fileURLToPath(new URL('./gateway.mjs', import.meta.url));
const canonical = p => fs.realpathSync(p).toLowerCase();
const plainFile = p => typeof p === 'string' && path.isAbsolute(p) &&
  fs.lstatSync(p).isFile() && !fs.lstatSync(p).isSymbolicLink() && fs.lstatSync(p).nlink === 1;
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
function fail(code) { throw Object.assign(new Error(code), {code}); }
function save(file, value) {
  const temporary = file + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
async function unusedPort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(Object.assign(new Error('port_unavailable'), {code: 'port_unavailable'})));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function reply(url, token, deadline, method = 'GET') {
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail('readiness_timeout');
  const response = await fetch(url, {method, redirect: 'error',
    headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(Math.min(1000, remaining))});
  if (!response.ok) fail('readiness_response');
  let text = '', bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 65536) fail('readiness_response');
    text += Buffer.from(chunk).toString('utf8');
  }
  return JSON.parse(text);
}

function isolatedWindowsStart(settingsFile, timeoutMs) {
  const started = Date.now();
  const launchId = randomUUID(), directory = path.dirname(settingsFile);
  const prefix = path.join(directory, 'gateway-launch-' + launchId);
  const recordPrefix = path.join(directory, 'gateway-start-' + launchId);
  const completionFile = recordPrefix + '.json';
  const outputFile = prefix + '.stdout.tmp', errorFile = prefix + '.stderr.tmp';
  const files = [];
  let actual;
  try {
    for (const file of [outputFile,errorFile]) {
      fs.closeSync(fs.openSync(file,'wx',0o600)); files.push(file);
    }
    const helper = fileURLToPath(new URL('./isolated-gateway-launch.ps1',import.meta.url));
    const powershell = path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    actual = spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{
      shell:false,windowsHide:true,input:JSON.stringify({nodePath:process.execPath,settingsFile,timeoutMs,outputFile,errorFile}),
      encoding:'utf8',maxBuffer:65536,timeout:timeoutMs+20000});
    if (actual.error || actual.signal || actual.status === null || fs.statSync(outputFile).size > 65536) fail('native_launcher_failed');
    const result = JSON.parse(fs.readFileSync(outputFile,'utf8'));
    if (actual.status !== result.exitCode || !['ready','failed'].includes(result.status) ||
        result.status === 'ready' && (result.exitCode !== 0 || !Number.isInteger(result.pid))) fail('native_launcher_failed');
    return {...result, nativeExitCode:actual.status, launcherElapsedMs:Date.now()-started};
  } catch {
    let previous;
    try {if(plainFile(completionFile)&&fs.statSync(completionFile).size<=65536)previous=readJson(completionFile);}catch{}
    const result={exitCode:1,status:'failed',failure:'native_launcher_failed',cleanupConfirmed:false,
      pid:Number.isInteger(previous?.pid)&&previous.pid>0?previous.pid:null,
      childExitCode:null,timedOut:actual?.error?.code==='ETIMEDOUT',recoveryRequired:true,
      completionFile,completionRecordExists:fs.existsSync(completionFile),
      stdoutLog:recordPrefix+'.stdout.log',stderrLog:recordPrefix+'.stderr.log',
      nativeExitCode:actual?.status??null,launcherElapsedMs:Date.now()-started,
      recoveryFile:recordPrefix+'.recovery.json'};
    // Preserve the inner record verbatim; unknown wrapper outcome is a separate record.
    try{save(result.recoveryFile,result);}catch{result.recoveryWriteFailed=true;}
    return result;
  } finally {
    for (const file of files) fs.unlinkSync(file);
  }
}

// Trusted host CLI only. Never expose executable, arguments or runtime selection to MCP requests.
export async function startGateway({settingsFile, timeoutMs = 30000}) {
  const started = Date.now();
  let child, childExit, spawned = false, childError, stdoutFd, stderrFd, record, recordFile;
  let validationStage = 'settings-file';
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) fail('invalid_timeout');
    if (!plainFile(settingsFile) || canonical(settingsFile) !== path.resolve(settingsFile).toLowerCase()) fail('invalid_settings');
    const settings = readJson(settingsFile), url = new URL(settings.gatewayUrl);
    validationStage = 'gateway-settings';
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' ||
        url.username || url.password || url.search || url.hash || !url.port ||
        Number(url.port) < 1024 || !plainFile(settings.gatewayScript) ||
        canonical(settings.gatewayScript) !== canonical(gatewayScript) ||
        !plainFile(settings.nodePath) || canonical(settings.nodePath) !== canonical(process.execPath) ||
        !plainFile(settings.gatewayConfig) || !plainFile(settings.tokenFile) ||
        typeof settings.wslDistro !== 'string' || !settings.wslDistro.trim()) fail('invalid_settings');
    validationStage = 'gateway-config';
    const config = readJson(settings.gatewayConfig), token = fs.readFileSync(settings.tokenFile, 'utf8').trim();
    if (config.host !== '127.0.0.1' || config.port !== Number(url.port) || !token) fail('invalid_settings');
    if (process.platform === 'win32' && process.env.PI_KETHER_ISOLATED_LAUNCH !== '1') {
      return isolatedWindowsStart(settingsFile, timeoutMs);
    }
    await unusedPort(config.port);
    validationStage = 'launch-id';
    const launchId = process.platform==='win32'&&process.env.PI_KETHER_ISOLATED_LAUNCH==='1' ? process.env.PI_KETHER_LAUNCH_ID : randomUUID();
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(launchId??''))fail('invalid_settings');
    const prefix = path.join(path.dirname(settingsFile), 'gateway-start-' + launchId);
    recordFile = prefix + '.json';
    if(fs.existsSync(recordFile))fail('gateway_launch_failed');
    record = {status: 'starting', startedAt: new Date(started).toISOString(), timeoutMs,
      pid: null, childExitCode: null, timedOut: false, stdoutLog: prefix + '.stdout.log',
      stderrLog: prefix + '.stderr.log', completionFile: recordFile};
    save(recordFile, record);
    stdoutFd = fs.openSync(record.stdoutLog, 'wx', 0o600);
    stderrFd = fs.openSync(record.stderrLog, 'wx', 0o600);
    child = spawn(process.execPath, [gatewayScript], {cwd: path.dirname(path.dirname(gatewayScript)),
      shell: false, windowsHide: true, detached: true, stdio: ['ignore', stdoutFd, stderrFd],
      env: {...process.env, PI_GATEWAY_CONFIG: settings.gatewayConfig,
        PI_DISPATCH_SANDBOX: 'wsl2-bwrap', PI_SANDBOX_DISTRO: settings.wslDistro}});
    childExit = new Promise(resolve => {
      child.once('error', error => { childError = error; resolve(); });
      child.once('exit', resolve);
    });
    await new Promise((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
    spawned = true; record.pid = child.pid;
    fs.closeSync(stdoutFd); stdoutFd = undefined;
    fs.closeSync(stderrFd); stderrFd = undefined;
    save(recordFile,record); // Persist the owned PID before readiness, for crash reconciliation.
    const deadline = started + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      if (childError || child.exitCode !== null || child.signalCode !== null) fail('gateway_exited');
      try {
        const health = await reply(new URL('/readyz', url), token, deadline);
        if (health.ok === true) {
          // Status is read-only; do not pause a service to discover its identity.
          const identity = await reply(new URL('/admin/upgrade/status', url), token, deadline, 'POST');
          if (identity.pid !== child.pid || identity.phase !== 'running') fail('gateway_identity_mismatch');
          if (child.exitCode !== null || child.signalCode !== null) fail('gateway_exited');
          ready = true; break;
        }
      } catch (error) {
        if (error.code === 'gateway_identity_mismatch' || error.code === 'gateway_exited') throw error;
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    if (!ready) fail('readiness_timeout');
    Object.assign(record, {status: 'ready', elapsedMs: Date.now() - started, finishedAt: new Date().toISOString()});
    save(recordFile, record); // Failure here still owns and terminates the new child.
    child.unref();
    return {exitCode: 0, ...record};
  } catch (error) {
    const knownCodes = new Set(['invalid_timeout','invalid_settings','port_unavailable',
      'gateway_exited','gateway_identity_mismatch','readiness_timeout']);
    const failure = knownCodes.has(error.code) ? error.code : 'gateway_launch_failed';
    let cleanupConfirmed = true;
    if (child && spawned && child.exitCode === null && child.signalCode === null && !childError) {
      try {
        child.kill(); // Use this live child handle, never a stale PID or unrelated listener.
        cleanupConfirmed = await Promise.race([childExit.then(() => true), delay(5000, undefined, {ref: false}).then(() => false)]);
      } catch { cleanupConfirmed = false; }
    }
    const result = {status: 'failed', failure: cleanupConfirmed ? failure : 'gateway_cleanup_unconfirmed',
      ...(failure === 'invalid_settings' ? {validationStage} : {}),
      timedOut: failure === 'readiness_timeout', childExitCode: child?.exitCode ?? null,
      childSignal: child?.signalCode ?? null, cleanupConfirmed,
      elapsedMs: Date.now() - started, finishedAt: new Date().toISOString()};
    if (record) {
      Object.assign(record, result);
      try { save(recordFile, record); } catch { record.completionWriteFailed = true; }
    }
    return {exitCode: 1, ...(record ?? {}), ...result};
  } finally {
    for (const fd of [stdoutFd, stderrFd]) if (fd !== undefined) fs.closeSync(fd);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    const {values} = parseArgs({strict: true, allowPositionals: false,
      options: {'settings-file': {type: 'string'}, 'timeout-ms': {type: 'string'}}});
    if (!values['settings-file'] || values['timeout-ms'] && !/^\d+$/.test(values['timeout-ms'])) throw Error();
    options = {settingsFile: values['settings-file'], timeoutMs: values['timeout-ms'] === undefined ? 30000 : Number(values['timeout-ms'])};
  } catch {
    console.error('Usage: node start-gateway.mjs --settings-file ABSOLUTE_JSON [--timeout-ms 1000..30000]');
    process.exitCode = 2;
  }
  if (options) {
    const result = await startGateway(options);
    console.log(JSON.stringify(result)); process.exitCode = result.exitCode;
  }
}
