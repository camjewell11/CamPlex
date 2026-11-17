const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('marquee', {
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    start: () => ipcRenderer.invoke('auth:start'),
    cancel: () => ipcRenderer.invoke('auth:cancel'),
    signOut: () => ipcRenderer.invoke('auth:signOut'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (prefs) => ipcRenderer.invoke('settings:set', prefs),
  },
  request: (url, method) => ipcRenderer.invoke('plex:request', { url, method }),
  fullscreen: (on) => ipcRenderer.invoke('window:fullscreen', on),
  onFullscreen: (cb) => {
    const listener = (_e, v) => cb(v);
    ipcRenderer.on('fullscreen', listener);
    return () => ipcRenderer.removeListener('fullscreen', listener);
  },
  // The requests that end the current stream, so the main process can send them if the window closes.
  setActiveStream: (urls) => ipcRenderer.send('player:active', urls),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
});
