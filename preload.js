const { contextBridge, ipcRenderer } = require('electron');

// macOS keeps its window buttons at the top left; styles.css clears room for them under html.mac.
if (process.platform === 'darwin') window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('mac'));

contextBridge.exposeInMainWorld('marquee', {
  platform: process.platform,
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
  request: (url, method, target) => ipcRenderer.invoke('plex:request', { url, method, target }),
  // Plex Companion: other Plex apps control this player (casting to Marquee).
  companion: {
    enable: (on) => ipcRenderer.invoke('companion:enable', on),
    state: (s) => ipcRenderer.send('companion:state', s),
    onCommand: (cb) => {
      const listener = (_e, v) => cb(v);
      ipcRenderer.on('companion:command', listener);
      return () => ipcRenderer.removeListener('companion:command', listener);
    },
  },
  // plex.tv requests with the user's account token (watchlist, Discover, and Plex Home).
  plexTv: (url, method) => ipcRenderer.invoke('plextv:request', { url, method }),
  home: {
    users: () => ipcRenderer.invoke('home:users'),
    switchTo: (uuid, pin) => ipcRenderer.invoke('home:switch', { uuid, pin }),
  },
  fullscreen: (on) => ipcRenderer.invoke('window:fullscreen', on),
  onFullscreen: (cb) => {
    const listener = (_e, v) => cb(v);
    ipcRenderer.on('fullscreen', listener);
    return () => ipcRenderer.removeListener('fullscreen', listener);
  },
  // The requests that end the current stream, so the main process can send them if the window closes.
  setActiveStream: (urls) => ipcRenderer.send('player:active', urls),
  keepAwake: (on) => ipcRenderer.send('power:keepAwake', on),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    on: (event, cb) => {
      const channel = `update:${event}`;
      const listener = (_e, v) => cb(v);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
  downloads: {
    choose: (name) => ipcRenderer.invoke('download:choose', name),
    start: (url, path) => ipcRenderer.invoke('download:start', { url, path }),
    cancel: (id) => ipcRenderer.invoke('download:cancel', id),
    show: (id) => ipcRenderer.invoke('download:show', id),
    onUpdate: (cb) => {
      const listener = (_e, v) => cb(v);
      ipcRenderer.on('download:update', listener);
      return () => ipcRenderer.removeListener('download:update', listener);
    },
  },
  pip: {
    aspect: (ratio) => ipcRenderer.send('pip:aspect', ratio),
    move: (x, y) => ipcRenderer.send('pip:move', x, y),
    fullscreen: () => ipcRenderer.invoke('pip:fullscreen'),
    focusMain: () => ipcRenderer.send('pip:focusMain'),
    on: (event, cb) => {
      const channel = `pip:${event}`;
      const listener = (_e, v) => cb(v);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
});
