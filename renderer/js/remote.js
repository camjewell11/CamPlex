// Casting, both ways.
// - Receive: Plex Companion commands from other Plex apps act on the open player (see companion.js
//   in the main process), and the player's state goes back to them every second.
// - Send: "Play on" starts a title on another Plex player through the server, which forwards the
//   command to that player (X-Plex-Target-Client-Identifier).
import { h, svg } from './util.js';
import { state } from './app.js';
import { toast, showMenu } from './menu.js';
import { playTarget } from './actions.js';

// ---------- receive ----------
// The player that owns the Windows media controls also takes remote commands (see
// claimMediaSession in views/player.js).
let remote = null;
let owner = null;
export function setRemote(r, who) {
  remote = r;
  owner = who;
}
export function clearRemote(who) {
  if (owner === who) remote = owner = null;
}

let started = false;
export function initCompanion() {
  if (started) return;
  started = true;
  window.marquee.companion.onCommand((c) => handle(c).catch((e) => toast(`Remote command failed: ${e.message}`, { error: true })));
  setInterval(sendState, 1000);
}

async function sendState() {
  const { plex } = state;
  if (!remote || !plex) return window.marquee.companion.state({ state: 'stopped' });
  const s = remote.status();
  const u = new URL(plex.uri);
  window.marquee.companion.state({
    ...s,
    key: `/library/metadata/${s.ratingKey}`,
    machineIdentifier: await plex.machineId().catch(() => ''),
    address: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol.replace(':', ''),
  });
}

async function handle({ kind, name, params }) {
  if (kind === 'playback' && name === 'playMedia') return playMedia(params);
  if (kind === 'mirror' && name === 'details') {
    const rk = String(params.key || '').split('/').pop();
    if (rk) location.hash = `#/item/${rk}`;
    return;
  }
  if (kind === 'navigation') {
    if (name === 'back') history.back();
    else if (name === 'home') location.hash = '#/home';
    return;
  }
  if (kind !== 'playback' || !remote) return;
  const ms = Number(params.offset);
  switch (name) {
    case 'play':
      return remote.play();
    case 'pause':
      return remote.pause();
    case 'stop':
      return remote.stop();
    case 'seekTo':
      return Number.isFinite(ms) && remote.seekTo(ms / 1000);
    case 'stepForward':
      return remote.seekBy(30);
    case 'stepBack':
      return remote.seekBy(-15);
    case 'skipNext':
      return remote.next();
    case 'skipPrevious':
      return remote.prev();
    case 'setParameters':
      if (params.volume !== undefined) remote.setVolume(Math.max(0, Math.min(100, Number(params.volume))) / 100);
      return;
  }
}

// playMedia: key=/library/metadata/<id>, offset (ms), and containerKey=/playQueues/<id> when the
// sender built a play queue. Only titles on this app's server can play.
async function playMedia(params) {
  const { plex } = state;
  const mine = await plex.machineId();
  if (params.machineIdentifier && params.machineIdentifier !== mine) {
    toast('A remote asked to play a title from another server. Marquee plays only from its own server.', { error: true });
    return;
  }
  const rk = /\/library\/metadata\/(\d+)/.exec(params.key || '')?.[1];
  if (!rk) return;
  const q = [];
  const sec = Math.floor(Number(params.offset || 0) / 1000);
  if (sec > 0) q.push(`t=${sec}`);
  const pq = /\/playQueues\/(\d+)/.exec(params.containerKey || '')?.[1];
  if (pq) {
    const c = await plex.get(`/playQueues/${pq}`).catch(() => null);
    const list = c?.Metadata || [];
    const it = list.find((m) => m.playQueueItemID === c.playQueueSelectedItemID && String(m.ratingKey) === rk) || list.find((m) => String(m.ratingKey) === rk);
    if (it) q.push(`pq=${pq}`, `pqi=${it.playQueueItemID}`);
  }
  location.hash = `#/play/${rk}${q.length ? `?${q.join('&')}` : ''}`;
}

// ---------- send ----------
// The players the server knows about (found through GDM on this network), without Marquee itself.
async function players() {
  const c = await state.plex.get('/clients');
  return (c.Server || []).filter((p) => p.machineIdentifier !== state.plex.clientId && /player/.test(p.protocolCapabilities || 'playback'));
}

// Sends a Companion command to another player through the server.
async function command(target, path, params = {}) {
  const { plex } = state;
  const r = await window.marquee.request(plex.url(path, { ...params, commandID: ++commandID }), 'GET', target.machineIdentifier);
  if (r.status >= 400) throw new Error(`${target.name} did not accept the command (HTTP ${r.status}).`);
}
let commandID = 0;

export function playOnButton(item) {
  if (!['movie', 'episode', 'show', 'season'].includes(item.type)) return null;
  const btn = h('button', { class: 'button glass icon-only', 'aria-label': 'Play on another device', title: 'Play on' }, svg('cast', 18));
  btn.addEventListener('click', async () => {
    let list;
    try {
      list = await players();
    } catch (e) {
      return toast(`The server's player list did not load: ${e.message}`, { error: true });
    }
    if (!list.length) return toast('The server does not see any other Plex players on this network.');
    showMenu(btn, list.map((p) => ({ label: `${p.name}${p.product ? ` (${p.product})` : ''}`, icon: 'cast', run: () => playOn(p, item).catch((e) => toast(e.message, { error: true })) })), { label: 'Play on' });
  });
  return btn;
}

async function playOn(target, item) {
  const { plex } = state;
  const t = await playTarget(item);
  if (!t) return;
  const pq = await plex.createPlayQueue({ key: t.ratingKey });
  const u = new URL(plex.uri);
  await command(target, '/player/playback/playMedia', {
    key: `/library/metadata/${t.ratingKey}`,
    offset: t.viewOffset || 0,
    machineIdentifier: await plex.machineId(),
    address: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol.replace(':', ''),
    containerKey: `/playQueues/${pq.playQueueID}?own=1&window=200`,
    token: plex.token,
  });
  showCastBar(target, t);
}

// A small bar with pause, play, and stop for the player that the title went to.
let bar = null;
function showCastBar(target, item) {
  bar?.remove();
  const send = (cmd) => () => command(target, `/player/playback/${cmd}`, { type: 'video' }).catch((e) => toast(e.message, { error: true }));
  const close = () => {
    bar?.remove();
    bar = null;
  };
  bar = h(
    'div',
    { class: 'cast-bar glass', role: 'region', 'aria-label': 'Remote playback' },
    h('span', { class: 'who' }, h('small', {}, `Playing on ${target.name}`), h('strong', {}, item.title)),
    h('button', { class: 'ctl', 'aria-label': 'Play', title: 'Play', onclick: send('play') }, svg('play', 18)),
    h('button', { class: 'ctl', 'aria-label': 'Pause', title: 'Pause', onclick: send('pause') }, svg('pause', 18)),
    h('button', { class: 'ctl', 'aria-label': 'Stop', title: 'Stop', onclick: () => (send('stop')(), close()) }, svg('stop', 18)),
    h('button', { class: 'ctl', 'aria-label': 'Hide', title: 'Hide', onclick: close }, svg('close', 18)),
  );
  document.body.append(bar);
}
