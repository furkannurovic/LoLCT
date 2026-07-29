// preload.js — secure bridge between the renderer and the main process.
// contextIsolation stays ON; the renderer never touches Node or the network.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lol', {
  /** Read the stored, derived stats (champions + matches + summary). No network. */
  getStats: () => ipcRenderer.invoke('stats:get'),
  /** Get the tracked player { region, gameName, tagLine, iconDataUrl, hasRiotKey }. */
  getConfig: () => ipcRenderer.invoke('stats:get-config'),
  /** Update the tracked player + Riot key. */
  setConfig: (player) => ipcRenderer.invoke('stats:set-config', player),
  /** Validate a Riot key by resolving the current Riot ID. */
  testKey: (key) => ipcRenderer.invoke('stats:test-key', key),
  /** Run a live sync from the Riot API; resolves with fresh stats + a status report. */
  sync: () => ipcRenderer.invoke('stats:sync'),
  /** Open the folder holding the JSON database. */
  openDataFolder: () => ipcRenderer.invoke('stats:open-data-folder'),
  /** Open the Riot developer portal in the system browser. */
  openExternal: (url) => ipcRenderer.invoke('stats:open-external', url),
  /** Subscribe to sync progress lines. Returns an unsubscribe fn. */
  onProgress: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('stats:progress', listener);
    return () => ipcRenderer.removeListener('stats:progress', listener);
  },
});
