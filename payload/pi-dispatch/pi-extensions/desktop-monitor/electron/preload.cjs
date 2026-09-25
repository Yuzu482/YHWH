const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('monitor', Object.freeze({
  onStatus(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('monitor:status', listener);
    return () => ipcRenderer.removeListener('monitor:status', listener);
  },
  readConfig() {
    return ipcRenderer.invoke('console:read-config');
  },
  saveConfig(settings, revision) {
    return ipcRenderer.invoke('console:save-config', settings, revision);
  }
}));
