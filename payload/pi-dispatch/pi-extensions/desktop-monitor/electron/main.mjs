import { app, BrowserWindow, utilityProcess, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, saveConfig } from './config-store.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const feedPath = resolve(here, '..', 'feed.mjs');
const configPath = resolve(process.env.PI_GATEWAY_CONFIG || join(homedir(), '.local', 'state', 'pi-kether', 'gateway-silent.json'));
let windowRef;
let feed;
let closing = false;
let lastSnapshot = { ok: false, message: '正在连接' };
const safeSnapshot = value => {
  if (!value || typeof value !== 'object') return { ok: false, message: '监控数据无效' };
  if (value.ok !== true) return { ok: false, message: '网关暂不可用，正在重连' };
  const text = v => String(v ?? '').slice(0, 160);
  return {
    ok: true, instance: text(value.instance), active: Math.max(0, Number(value.active) || 0),
    queued: Math.max(0, Number(value.queued) || 0), rssMiB: Math.max(0, Number(value.rssMiB) || 0),
    updatedAt: text(value.updatedAt), tasks: Array.isArray(value.tasks) ? value.tasks.slice(0, 50).map(t => ({
      requestId: text(t.requestId), role: text(t.role), state: text(t.state), route: text(t.route), seconds: Math.max(0, Number(t.seconds) || 0)
    })) : []
  };
};
function publish(value) {
  lastSnapshot = safeSnapshot(value);
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('monitor:status', lastSnapshot);
}
function startFeed() {
  feed = utilityProcess.fork(feedPath, [configPath], { stdio: 'pipe' });
  let buffer = '';
  feed.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 1024 * 1024) buffer = '';
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { publish(JSON.parse(line)); } catch { publish({ ok: false }); }
    }
  });
  feed.on('exit', () => {
    if (closing) return;
    publish({ ok: false });
    setTimeout(() => { if (!closing && app.isReady()) startFeed(); }, 2000);
  });
}
function isTrustedMainFrame(event) {
  if (!windowRef || windowRef.isDestroyed() || event.sender !== windowRef.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || frame.parent !== null) return false;
  try { return fileURLToPath(frame.url) === join(here, 'index.html'); } catch { return false; }
}
function safeConfigError(error) {
  const code = ['CONFIG_INVALID', 'CONFIG_STALE', 'CONFIG_IO'].includes(error?.code) ? error.code : 'CONFIG_IO';
  return { ok: false, code };
}
ipcMain.handle('console:read-config', async event => {
  if (!isTrustedMainFrame(event)) return { ok: false, code: 'CONFIG_INVALID' };
  try { return { ok: true, ...(await readConfig(configPath)) }; } catch (error) { return safeConfigError(error); }
});
ipcMain.handle('console:save-config', async (event, settings, revision) => {
  if (!isTrustedMainFrame(event)) return { ok: false, code: 'CONFIG_INVALID' };
  try { return { ok: true, ...(await saveConfig(configPath, settings, revision)) }; } catch (error) { return safeConfigError(error); }
});
function createWindow() {
  windowRef = new BrowserWindow({ width: 860, height: 680, minWidth: 560, minHeight: 440,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  windowRef.webContents.on('will-navigate', e => e.preventDefault());
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.on('did-finish-load', () => publish(lastSnapshot));
  windowRef.loadFile(join(here, 'index.html'));
  windowRef.on('closed', () => { windowRef = undefined; });
}
app.whenReady().then(() => { createWindow(); startFeed(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { closing = true; feed?.kill(); });
