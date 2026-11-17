// Marquee main process: window, Plex sign-in, settings, and CORS for media.
const { app, BrowserWindow, ipcMain, protocol, net, session, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const VERSION = require('./package.json').version;
const ROOT = __dirname;
const args = process.argv.slice(1);
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
// Developer hooks (dev tools, screenshot mode, and the token from the environment) work only when
// the app runs from source, not in the installed build.
const DEV = !app.isPackaged && args.includes('--dev');
const SHOT = app.isPackaged ? null : argValue('shot'); // --shot=out.png --route=#/home --wait=6000 [--size=1600x1000] [--click=<selector>] [--scroll=<selector>]

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------- storage ----------
const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const secretFile = () => path.join(dataDir(), 'credentials.bin');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(s) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
function clientId() {
  const s = readSettings();
  if (!s.clientId) {
    s.clientId = crypto.randomUUID();
    writeSettings(s);
  }
  return s.clientId;
}
function readCredentials() {
  if (!app.isPackaged && process.env.MARQUEE_TOKEN && process.env.MARQUEE_SERVER) {
    return { serverToken: process.env.MARQUEE_TOKEN, server: { uri: process.env.MARQUEE_SERVER, name: 'Development server' } };
  }
  try {
    const buf = fs.readFileSync(secretFile());
    return JSON.parse(safeStorage.decryptString(buf));
  } catch {
    return null;
  }
}
function writeCredentials(c) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(secretFile(), safeStorage.encryptString(JSON.stringify(c)));
}

// ---------- plex.tv sign-in ----------
function plexHeaders(token) {
  const h = {
    Accept: 'application/json',
    'X-Plex-Product': 'Marquee',
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Platform': 'Windows',
    'X-Plex-Device': 'Windows',
    'X-Plex-Device-Name': `Marquee (${os.hostname()})`,
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

async function fetchJson(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await net.fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

let pinPoll = null;
async function startSignIn() {
  const pin = await fetchJson('https://plex.tv/api/v2/pins?strong=true', { method: 'POST', headers: plexHeaders() });
  const authUrl =
    'https://app.plex.tv/auth#?' +
    new URLSearchParams({ clientID: clientId(), code: pin.code, 'context[device][product]': 'Marquee' }).toString();
  await shell.openExternal(authUrl);
  const deadline = Date.now() + 5 * 60 * 1000;
  return new Promise((resolve, reject) => {
    clearInterval(pinPoll);
    pinPoll = setInterval(async () => {
      try {
        if (Date.now() > deadline) {
          clearInterval(pinPoll);
          return reject(new Error('Sign-in timed out after 5 minutes. Select Sign in with Plex to try again.'));
        }
        const p = await fetchJson(`https://plex.tv/api/v2/pins/${pin.id}`, { headers: plexHeaders() });
        if (p.authToken) {
          clearInterval(pinPoll);
          const server = await discoverServer(p.authToken);
          writeCredentials({ userToken: p.authToken, serverToken: server.accessToken, server: server.info });
          resolve(server.info);
        }
      } catch (e) {
        clearInterval(pinPoll);
        reject(e);
      }
    }, 2000);
  });
}

async function probe(uri, token) {
  try {
    const r = await fetchJson(`${uri}/identity`, { headers: plexHeaders(token) }, 4000);
    return r.MediaContainer?.machineIdentifier || null;
  } catch {
    return null;
  }
}

async function discoverServer(userToken) {
  const resources = await fetchJson('https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
    headers: plexHeaders(userToken),
  });
  const servers = resources.filter((r) => (r.provides || '').includes('server'));
  servers.sort((a, b) => Number(b.owned) - Number(a.owned));
  for (const s of servers) {
    const token = s.accessToken || userToken;
    // A server on this computer answers fastest over loopback.
    const localId = await probe('http://127.0.0.1:32400', token);
    if (localId && localId === s.clientIdentifier) {
      return { accessToken: token, info: { uri: 'http://127.0.0.1:32400', name: s.name, machineId: s.clientIdentifier } };
    }
    const conns = [...(s.connections || [])].sort((a, b) => Number(a.relay) - Number(b.relay) || Number(b.local) - Number(a.local));
    for (const c of conns) {
      if ((await probe(c.uri, token)) === s.clientIdentifier) {
        return { accessToken: token, info: { uri: c.uri, name: s.name, machineId: s.clientIdentifier } };
      }
    }
  }
  throw new Error('No reachable Plex server was found for this account.');
}

// ---------- window ----------
let win;
function createWindow() {
  const [w, h] = (argValue('size') || '1600x1000').split('x').map(Number);
  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 960,
    minHeight: 600,
    show: !SHOT,
    backgroundColor: '#05060a',
    title: 'Marquee',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#f2f4f8', height: 44 },
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: !SHOT },
  });
  win.setMenuBarVisibility(false);
  const route = argValue('route') || '';
  win.loadURL(`app://marquee/renderer/index.html${route}`);
  win.on('close', (e) => {
    if (!activeStream?.length) return;
    e.preventDefault();
    endActiveStream().finally(() => win.destroy());
  });
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  if (SHOT) {
    win.webContents.on('console-message', ({ level, message }) => {
      if (level === 'warning' || level === 'error') console.log(`[renderer] ${message}`);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // Report the player state; a capture of a hidden window omits the controls over playing video.
        const state = await win.webContents.executeJavaScript(
          "(() => { const v = document.querySelector('video'); if (!v) return ''; const s = document.querySelector('.skip'); return `time ${v.currentTime.toFixed(1)}, paused ${v.paused}, ready ${v.readyState}, size ${v.videoWidth}x${v.videoHeight}, skip ${s && !s.hidden ? s.textContent : 'hidden'}, tracks ${v.textTracks.length}`; })()",
        );
        if (state) console.log(`[shot] ${state}`);
        const hero = await win.webContents.executeJavaScript("[...document.querySelectorAll('.pager .dot')].map((d) => d.getAttribute('aria-label')).join(' | ')");
        if (hero) console.log(`[shot] featured: ${hero}`);
        // --click=<css selector> selects that element, waits, and reports where the app went.
        const clickOn = argValue('click');
        if (clickOn) {
          const ok = await win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(clickOn)}); if (!el) return false; el.click(); return true; })()`);
          await new Promise((r) => setTimeout(r, 3500));
          const where = await win.webContents.executeJavaScript('`${location.hash} (history ${history.length})`');
          console.log(`[shot] click ${ok ? 'done' : 'found nothing'}; now at ${where}`);
        }
        // --scroll=<css selector> brings that element into view before the capture.
        const scrollTo = argValue('scroll');
        if (scrollTo) {
          await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
          await new Promise((r) => setTimeout(r, 400));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(SHOT, img.toPNG());
        await endActiveStream();
        app.quit();
      }, Number(argValue('wait') || 6000));
    });
  }
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const full = path.normalize(path.join(ROOT, rel));
    const allowed = [path.join(ROOT, 'renderer')];
    if (!allowed.some((a) => full.startsWith(a + path.sep))) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(full).toString());
  });

  // Media segments and images come straight from the Plex server; allow the app origin to read them.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const creds = readCredentialsCached();
    const origin = creds?.server?.uri ? new URL(creds.server.uri).origin : null;
    if (origin && details.url.startsWith(origin)) {
      const headers = {};
      for (const [k, v] of Object.entries(details.responseHeaders || {})) {
        if (!k.toLowerCase().startsWith('access-control-')) headers[k] = v;
      }
      headers['Access-Control-Allow-Origin'] = ['*'];
      headers['Access-Control-Expose-Headers'] = ['*'];
      return cb({ responseHeaders: headers });
    }
    cb({});
  });

  ipcMain.handle('auth:status', () => {
    const c = readCredentialsCached();
    return c ? { signedIn: true, server: c.server, token: c.serverToken, clientId: clientId(), version: VERSION } : { signedIn: false, clientId: clientId(), version: VERSION };
  });
  ipcMain.handle('auth:start', async () => {
    const server = await startSignIn();
    credCache = undefined;
    return server;
  });
  ipcMain.handle('auth:cancel', () => clearInterval(pinPoll));
  ipcMain.handle('auth:signOut', () => {
    fs.rmSync(secretFile(), { force: true });
    credCache = undefined;
  });
  ipcMain.handle('settings:get', () => readSettings().prefs || null);
  ipcMain.handle('settings:set', (_e, prefs) => {
    const s = readSettings();
    s.prefs = prefs;
    writeSettings(s);
  });
  ipcMain.handle('plex:request', async (_e, { url, method = 'GET' }) => {
    const r = await net.fetch(url, { method, headers: { Accept: 'application/json' } });
    const text = await r.text();
    return { status: r.status, text };
  });
  ipcMain.on('player:active', (_e, urls) => {
    activeStream = Array.isArray(urls) ? urls.filter(isStreamEndUrl) : null;
  });
  ipcMain.handle('window:fullscreen', (_e, on) => {
    win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on);
    return win.isFullScreen();
  });
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });

  createWindow();
});

let credCache;

// The player registers the requests that end its stream. Closing the window skips the player's own
// cleanup, so the main process sends them; otherwise Plex keeps transcoding for minutes.
let activeStream = null;
function isStreamEndUrl(u) {
  try {
    const p = new URL(u).pathname;
    return p === '/:/timeline' || p === '/video/:/transcode/universal/stop';
  } catch {
    return false;
  }
}
async function endActiveStream() {
  const urls = activeStream || [];
  activeStream = null;
  await Promise.all(
    urls.map(async (u) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        await net.fetch(u, { signal: ctrl.signal });
      } catch {
        // The window still closes when the server can't be reached.
      } finally {
        clearTimeout(t);
      }
    }),
  );
}
function readCredentialsCached() {
  if (credCache === undefined) credCache = readCredentials();
  return credCache;
}

if (!SHOT && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
