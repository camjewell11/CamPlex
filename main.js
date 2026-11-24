// Marquee main process: window, Plex sign-in, settings, and CORS for media.
const { app, BrowserWindow, ipcMain, protocol, net, session, shell, safeStorage, screen, powerSaveBlocker, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Companion } = require('./companion');

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
const SHOT = app.isPackaged ? null : argValue('shot'); // --shot=out.png --route=#/home --wait=6000 [--size=1600x1000] [--click=<selector>] [--eval=<file>] [--scroll=<selector>]

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------- storage ----------
const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const secretFile = () => path.join(dataDir(), 'credentials.bin');

// Window buttons drawn over the app's own top bar (see the full-screen handlers in createWindow).
const TITLE_BAR = { color: '#00000000', symbolColor: '#f2f4f8', height: 44 };

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
// In development, a Home user switch lasts until the app quits (see switchHomeUser).
let devCreds = null;
function readCredentials() {
  if (!app.isPackaged && process.env.MARQUEE_TOKEN && process.env.MARQUEE_SERVER) {
    if (devCreds) return devCreds;
    return {
      userToken: process.env.MARQUEE_TOKEN,
      serverToken: process.env.MARQUEE_TOKEN,
      server: { uri: process.env.MARQUEE_SERVER, name: 'Development server' },
    };
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

// preferId: after a Home user switch, keep the same server when the new user can reach it.
async function discoverServer(userToken, preferId) {
  const resources = await fetchJson('https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
    headers: plexHeaders(userToken),
  });
  const servers = resources.filter((r) => (r.provides || '').includes('server'));
  servers.sort((a, b) => Number(b.clientIdentifier === preferId) - Number(a.clientIdentifier === preferId) || Number(b.owned) - Number(a.owned));
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

// ---------- plex.tv for the signed-in user (watchlist, Discover, Plex Home) ----------
// The renderer holds only the server token. These requests carry the user's plex.tv token, so
// they go only to Plex's own hosts.
const PLEX_TV_HOSTS = new Set(['plex.tv', 'clients.plex.tv', 'discover.provider.plex.tv', 'metadata.provider.plex.tv']);
async function plexTv(url, method = 'GET') {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !PLEX_TV_HOSTS.has(u.hostname)) throw new Error('Only plex.tv addresses are allowed.');
  const c = readCredentialsCached();
  if (!c?.userToken) return { status: 401, text: '' };
  const r = await net.fetch(u.toString(), { method, headers: plexHeaders(c.userToken) });
  return { status: r.status, text: await r.text() };
}

async function homeUsers() {
  const c = readCredentialsCached();
  if (!c?.userToken) return { users: [], current: null };
  const [home, me] = await Promise.all([
    fetchJson('https://clients.plex.tv/api/v2/home/users', { headers: plexHeaders(c.userToken) }),
    fetchJson('https://clients.plex.tv/api/v2/user', { headers: plexHeaders(c.userToken) }),
  ]);
  const users = (home.users || []).map((u) => ({ uuid: u.uuid, title: u.title, thumb: u.thumb, admin: !!u.admin, protected: !!u.protected, restricted: !!u.restricted }));
  return { users, current: me.uuid };
}

// Switch to another Plex Home user. plex.tv returns that user's token; the server access token
// then comes from that user's resources, as at sign-in.
async function switchHomeUser(uuid, pin) {
  const c = readCredentialsCached();
  if (!c?.userToken) throw new Error('Sign in first.');
  const q = new URLSearchParams(pin ? { pin } : {}).toString();
  const r = await net.fetch(`https://clients.plex.tv/api/v2/home/users/${encodeURIComponent(uuid)}/switch${q ? `?${q}` : ''}`, {
    method: 'POST',
    headers: plexHeaders(c.userToken),
  });
  if (r.status === 401 || r.status === 403) throw new Error(pin ? 'That PIN is not correct.' : 'This user needs a PIN.');
  if (!r.ok) throw new Error(`plex.tv returned HTTP ${r.status}.`);
  const u = await r.json();
  const server = await discoverServer(u.authToken, c.server?.machineId);
  const next = { ...c, userToken: u.authToken, serverToken: server.accessToken, server: server.info };
  if (!app.isPackaged && process.env.MARQUEE_TOKEN && process.env.MARQUEE_SERVER) devCreds = next;
  else writeCredentials(next);
  credCache = undefined;
  return { title: u.title };
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
    icon: path.join(ROOT, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: !SHOT },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ frameName, features }) => {
    if (frameName !== 'marquee-pip') return { action: 'deny' };
    const aspect = Number(/aspect=([\d.]+)/.exec(features)?.[1]) || 16 / 9;
    return { action: 'allow', overrideBrowserWindowOptions: pipOptions(aspect) };
  });
  win.webContents.on('did-create-window', (child, { frameName }) => {
    if (frameName === 'marquee-pip') setupPip(child);
  });
  win.on('closed', () => {
    if (pipWin && !pipWin.isDestroyed()) pipWin.destroy();
  });
  const route = argValue('route') || '';
  win.loadURL(`app://marquee/renderer/index.html${route}`);
  win.on('close', (e) => {
    if (!activeStream?.length) return;
    e.preventDefault();
    endActiveStream().finally(() => win.destroy());
  });
  // Windows keeps the minimize, maximize, and close buttons over a full-screen window. Shrink the
  // overlay to nothing (Electron keeps 1 px) with clear symbols while in full screen, and restore it after.
  win.on('enter-full-screen', () => {
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: '#00000000', height: 0 });
    win.webContents.send('fullscreen', true);
  });
  win.on('leave-full-screen', () => {
    win.setTitleBarOverlay(TITLE_BAR);
    win.webContents.send('fullscreen', false);
  });
  // F11 puts the whole app in full screen from any page, even while a text box has focus.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.alt && !input.control && !input.meta) {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
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
        // --eval=<file> runs that script in the page (as a user gesture) and prints what it returns.
        const evalFile = argValue('eval');
        if (evalFile) {
          const out = await win.webContents.executeJavaScript(fs.readFileSync(evalFile, 'utf8'), true).catch((e) => `error: ${e.message}`);
          console.log(`[shot] eval: ${typeof out === 'string' ? out : JSON.stringify(out)}`);
          console.log(`[shot] keep awake: ${awakeId !== null && powerSaveBlocker.isStarted(awakeId)}`);
        }
        // --scroll=<css selector> brings that element into view before the capture.
        const scrollTo = argValue('scroll');
        if (scrollTo) {
          await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
          await new Promise((r) => setTimeout(r, 400));
        }
        // A failed capture (for example, UnknownVizError) must still end the stream, or Plex keeps
        // the transcode and any live TV tuner.
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(SHOT, img.toPNG());
          // A PiP window that is still open gets its own capture next to the main one (<name>-pip.png).
          if (pipAlive()) {
            const pipImg = await pipWin.webContents.capturePage();
            fs.writeFileSync(SHOT.replace(/(\.png)?$/i, '-pip.png'), pipImg.toPNG());
          }
        } catch (e) {
          console.log(`[shot] capture failed: ${e.message}`);
        } finally {
          await endActiveStream();
          app.quit();
        }
      }, Number(argValue('wait') || 6000));
    });
  }
}

// ---------- picture-in-picture ----------
// The PiP window is a frameless, always-on-top child that the player opens with window.open. The
// player mirrors its video into it (captureStream), so the stream itself never moves. Its width and
// position persist in settings.json as pipBounds; the height follows the video's aspect ratio.
let pipWin = null;
let pipAspect = 16 / 9;
const PIP_MIN_W = 240;

function pipOptions(aspect) {
  pipAspect = aspect;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const saved = readSettings().pipBounds;
  let width = Math.round(Math.min(640, Math.max(320, area.width / 4)));
  let x = area.x + area.width - width - 16;
  let y = null;
  if (saved && saved.width >= PIP_MIN_W) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x + 40 < a.x + a.width && saved.x + saved.width - 40 > a.x && saved.y >= a.y - 10 && saved.y + 40 < a.y + a.height;
    });
    if (onScreen) ({ width, x, y } = saved);
  }
  const height = Math.round(width / aspect);
  if (y === null) y = area.y + area.height - height - 16;
  return {
    x,
    y,
    width,
    height,
    minWidth: PIP_MIN_W,
    minHeight: Math.round(PIP_MIN_W / aspect),
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: true,
    skipTaskbar: false,
    title: 'Marquee - Picture-in-picture',
    icon: path.join(ROOT, 'build', 'icon.png'),
    backgroundColor: '#000000',
    show: !SHOT,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  };
}

function setupPip(child) {
  pipWin = child;
  child.setMenuBarVisibility(false);
  child.setAlwaysOnTop(true, 'floating');
  child.setAspectRatio(pipAspect);
  // Keep the main page "visible" while it's minimized, so Chromium doesn't suspend the video that
  // feeds the mirror or slow the player's timers.
  win.webContents.setBackgroundThrottling(false);
  const save = () => {
    if (child.isDestroyed() || child.isFullScreen()) return;
    const b = child.getBounds();
    const s = readSettings();
    s.pipBounds = { x: b.x, y: b.y, width: b.width };
    writeSettings(s);
  };
  let saveTimer;
  const later = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  };
  child.on('moved', later);
  child.on('resized', later);
  child.on('enter-full-screen', () => win.webContents.send('pip:fullscreen', true));
  child.on('leave-full-screen', () => win.webContents.send('pip:fullscreen', false));
  child.on('closed', () => {
    clearTimeout(saveTimer);
    pipWin = null;
    if (!win.isDestroyed()) {
      win.webContents.setBackgroundThrottling(!SHOT);
      win.webContents.send('pip:closed');
    }
  });
}
const pipAlive = () => pipWin && !pipWin.isDestroyed();

// Match the AUMID on the installer's shortcuts (build.appId), so Windows shows the Marquee icon
// on the taskbar and groups the window with its pinned shortcut.
if (process.platform === 'win32') app.setAppUserModelId('com.camjewell.marquee');

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
  ipcMain.handle('plextv:request', (_e, { url, method }) => plexTv(url, method));
  ipcMain.handle('home:users', () => homeUsers());
  ipcMain.handle('home:switch', (_e, { uuid, pin }) => switchHomeUser(uuid, pin));
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
  ipcMain.handle('plex:request', async (_e, { url, method = 'GET', target }) => {
    const headers = { Accept: 'application/json' };
    // Commands for another player go through the server, which forwards them to that player.
    if (target) headers['X-Plex-Target-Client-Identifier'] = String(target);
    const r = await net.fetch(url, { method, headers });
    const text = await r.text();
    return { status: r.status, text };
  });
  ipcMain.on('player:active', (_e, urls) => {
    activeStream = Array.isArray(urls) ? urls.filter(isStreamEndUrl) : null;
  });
  // Keep the display awake while video plays (the player turns it on at play and off at pause).
  ipcMain.on('power:keepAwake', (_e, on) => keepAwake(!!on));
  ipcMain.handle('window:fullscreen', (_e, on) => {
    win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on);
    return win.isFullScreen();
  });
  ipcMain.on('pip:aspect', (_e, ratio) => {
    if (!pipAlive() || !(ratio > 0.2 && ratio < 5)) return;
    pipAspect = ratio;
    pipWin.setAspectRatio(ratio);
    pipWin.setMinimumSize(PIP_MIN_W, Math.round(PIP_MIN_W / ratio));
    if (!pipWin.isFullScreen()) {
      const b = pipWin.getBounds();
      const height = Math.round(b.width / ratio);
      // Grow or shrink from the bottom edge, so a window docked at the bottom stays there.
      pipWin.setBounds({ x: b.x, y: b.y + b.height - height, width: b.width, height });
    }
  });
  ipcMain.on('pip:move', (_e, x, y) => {
    if (pipAlive() && !pipWin.isFullScreen()) pipWin.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.handle('pip:fullscreen', () => {
    if (pipAlive()) pipWin.setFullScreen(!pipWin.isFullScreen());
  });
  ipcMain.on('pip:focusMain', () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  setupDownloads();
  setupUpdates();

  createWindow();
});

// ---------- automatic updates ----------
// Reads the latest GitHub release of camjewell11/CamPlex. When its tag (v0.3.1) is newer than this
// build and it has the NSIS installer as an asset, the renderer offers to install it. Install
// downloads the installer to the temp folder, checks its size and SHA-256 digest, runs it silently
// (/S keeps the install folder; --force-run starts Marquee again), and quits.
const RELEASES_API = 'https://api.github.com/repos/camjewell11/CamPlex/releases/latest';
const UPDATE_CHECK_DELAY = 15 * 1000;
let updateInfo = null;
let updateBusy = false;
function versionParts(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
}
function isNewer(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
// Returns { current, latest, available, notes, page }. latest is null when no release exists.
async function checkForUpdate() {
  const r = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Marquee' } });
  if (r.status === 404) {
    updateInfo = null;
    return { current: VERSION, latest: null, available: false };
  }
  if (!r.ok) throw new Error(`GitHub returned HTTP ${r.status}.`);
  const j = await r.json();
  const latest = String(j.tag_name || '').replace(/^v/i, '');
  // GitHub replaces the spaces in "Marquee Setup 0.3.0.exe" with dots.
  const asset = (j.assets || []).find((a) => /^Marquee[ .-]Setup[ .-][\d.]+\.exe$/i.test(a.name));
  const available = !!asset && isNewer(latest, VERSION);
  updateInfo = available
    ? { version: latest, url: asset.browser_download_url, size: asset.size, digest: /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '')?.[1] || null }
    : null;
  return { current: VERSION, latest, available, notes: String(j.body || '').slice(0, 2000), page: j.html_url };
}
function sendUpdate(channel, v) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, v);
}
async function installUpdate() {
  if (!app.isPackaged) throw new Error('Updates install only in the installed app.');
  if (!updateInfo) throw new Error('There is no update to install.');
  if (updateBusy) return;
  updateBusy = true;
  const { version, url, size, digest } = updateInfo;
  const file = path.join(app.getPath('temp'), `Marquee-Setup-${version}.exe`);
  try {
    const r = await net.fetch(url, { headers: { 'User-Agent': 'Marquee' } });
    if (!r.ok) throw new Error(`GitHub returned HTTP ${r.status} for the installer.`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let received = 0;
    let last = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await new Promise((res) => out.once('drain', res));
      if (Date.now() - last > 250) {
        last = Date.now();
        sendUpdate('update:progress', { received, total: size });
      }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (size && received !== size) throw new Error('The installer download is incomplete.');
    if (digest && hash.digest('hex') !== digest.toLowerCase()) throw new Error('The installer does not match the release checksum.');
    sendUpdate('update:progress', { received, total: size, installing: true });
    require('child_process').spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    // Closing the window sends the stream-end requests first (see win.on('close')).
    setTimeout(() => app.quit(), 500);
  } catch (e) {
    fs.rmSync(file, { force: true });
    updateBusy = false;
    throw e;
  }
}
function setupUpdates() {
  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:install', () => installUpdate());
  // The installed app checks once, shortly after start. MARQUEE_UPDATE_CHECK=1 makes a source
  // run check too (it reports, but can't install).
  const auto = app.isPackaged ? readSettings().prefs?.autoUpdateCheck !== false : process.env.MARQUEE_UPDATE_CHECK === '1';
  if (!auto) return;
  setTimeout(async () => {
    try {
      const r = await checkForUpdate();
      if (r.available) sendUpdate('update:available', r);
    } catch {
      // No network or GitHub is down: try again next start.
    }
  }, UPDATE_CHECK_DELAY);
}

// ---------- downloads ----------
// The renderer asks for a file from the Plex server (the original part, or a converted MP4 from
// the server's download queue). The main process asks where to save it, downloads it with
// Chromium's download manager, and reports progress on 'download:update'.
const downloads = new Map(); // id -> { item, name, path }
const pendingSaves = new Map(); // url -> { id, path, name }
const chosenPaths = new Set(); // save paths the user picked, each usable once
let downloadSeq = 0;
function safeFileName(name) {
  const clean = String(name || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return clean.slice(0, 180) || 'download';
}
function fromServer(url) {
  const c = readCredentialsCached();
  try {
    return !!c?.server?.uri && new URL(url).origin === new URL(c.server.uri).origin;
  } catch {
    return false;
  }
}
function sendDownload(id, extra) {
  const d = downloads.get(id);
  if (!win || win.isDestroyed() || !d) return;
  win.webContents.send('download:update', { id, name: d.name, path: d.path, ...extra });
}
function setupDownloads() {
  session.defaultSession.on('will-download', (_e, item) => {
    const chain = item.getURLChain();
    const url = chain.find((u) => pendingSaves.has(u));
    const p = url && pendingSaves.get(url);
    if (!p) return; // Not ours: Chromium asks where to save it.
    pendingSaves.delete(url);
    item.setSavePath(p.path);
    const d = { item, name: p.name, path: p.path };
    downloads.set(p.id, d);
    item.on('updated', (_ev, st) => sendDownload(p.id, { state: st === 'interrupted' ? 'interrupted' : 'progressing', received: item.getReceivedBytes(), total: item.getTotalBytes() }));
    item.once('done', (_ev, st) => {
      sendDownload(p.id, { state: st, received: item.getReceivedBytes(), total: item.getTotalBytes() });
      d.item = null;
    });
  });
  // Asks where to save. Returns { path }, or null when the user closes the dialog. A conversion
  // asks first and starts the download minutes later, so the two are separate calls.
  ipcMain.handle('download:choose', async (_e, name) => {
    const fileName = safeFileName(name);
    let target;
    // From source, MARQUEE_DOWNLOAD_DIR skips the save dialog so tests can run unattended.
    const testDir = !app.isPackaged && process.env.MARQUEE_DOWNLOAD_DIR;
    if (testDir) target = path.join(testDir, fileName);
    else {
      const r = await dialog.showSaveDialog(win, { title: 'Save download', defaultPath: path.join(app.getPath('downloads'), fileName) });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    chosenPaths.add(target);
    return { path: target };
  });
  // Starts a download to a path from download:choose. Returns { id, name, path }.
  ipcMain.handle('download:start', (_e, { url, path: target }) => {
    if (!fromServer(url)) throw new Error('Downloads must come from the Plex server.');
    if (!chosenPaths.delete(target)) throw new Error('Choose where to save the file first.');
    const id = ++downloadSeq;
    pendingSaves.set(url, { id, path: target, name: path.basename(target) });
    win.webContents.downloadURL(url);
    return { id, name: path.basename(target), path: target };
  });
  ipcMain.handle('download:cancel', (_e, id) => downloads.get(id)?.item?.cancel());
  ipcMain.handle('download:show', (_e, id) => {
    const d = downloads.get(id);
    if (d && fs.existsSync(d.path)) shell.showItemInFolder(d.path);
  });
}

let credCache;

// ---------- Plex Companion player (casting to Marquee) ----------
// Off by default, because a server that listens on the network can raise a Windows Firewall
// prompt. From source it binds to 127.0.0.1 only, and MARQUEE_COMPANION=1 turns it on.
let companion = null;
async function setCompanion(on) {
  if (!on) {
    const c = companion;
    companion = null;
    await c?.stop();
    return { on: false };
  }
  if (companion) return { on: true, port: companion.port };
  const c = new Companion({
    clientId: clientId(),
    name: `Marquee (${os.hostname()})`,
    version: VERSION,
    host: app.isPackaged ? '0.0.0.0' : '127.0.0.1',
    log: (m) => SHOT && console.log(`[companion] ${m}`),
    onCommand: (kind, name, params) => {
      if (!win || win.isDestroyed()) return false;
      if (kind === 'playback' && name === 'playMedia' && win.isMinimized()) win.restore();
      win.webContents.send('companion:command', { kind, name, params });
      return true;
    },
  });
  try {
    const port = await c.start();
    companion = c;
    return { on: true, port };
  } catch (e) {
    await c.stop().catch(() => {});
    return { on: false, error: e.message };
  }
}
app.whenReady().then(() => {
  ipcMain.handle('companion:enable', (_e, on) => setCompanion(!!on));
  ipcMain.on('companion:state', (_e, s) => companion?.setState(s));
  const devOn = !app.isPackaged && process.env.MARQUEE_COMPANION === '1';
  if (devOn || readSettings().prefs?.companion) setCompanion(true);
});
app.on('will-quit', () => {
  companion?.stop();
});

let awakeId = null;
function keepAwake(on) {
  if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && awakeId !== null) {
    powerSaveBlocker.stop(awakeId);
    awakeId = null;
  }
}

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
