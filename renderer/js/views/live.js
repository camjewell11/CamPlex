// Live TV: a guide of what's on now and next on each channel, and a live player.
// Flow (probed 2026-11-24): POST /livetv/dvrs/<dvr>/channels/<channelIdentifier>/tune takes a
// tuner and returns a live session (/livetv/sessions/<uuid>). The transcoder then streams that
// session as DASH (a dynamic manifest), like a file. Stopping the transcode frees the tuner.
import { h, svg, uuid } from '../util.js';
import { state, endBackground } from '../app.js';
import { setAmbient } from '../ambient.js';

const HOURS = 3;
const timeText = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const showTitle = (p) => (p.type === 'episode' && p.grandparentTitle ? p.grandparentTitle : p.title);
const episodeTitle = (p) => (p.type === 'episode' && p.grandparentTitle && p.title !== p.grandparentTitle ? p.title : '');

// Sorts by channel number: 19.1, 19.2, 25.2, ...
const byNumber = (a, b) => {
  const [a1, a2 = 0] = String(a.vcn).split('.').map(Number);
  const [b1, b2 = 0] = String(b.vcn).split('.').map(Number);
  return a1 - b1 || a2 - b2;
};

async function loadChannels() {
  const { plex, dvr } = state;
  const now = Math.floor(Date.now() / 1000);
  const [channels, grid] = await Promise.all([plex.liveChannels(dvr), plex.liveGrid(dvr, now, now + HOURS * 3600).catch(() => [])]);
  // Programs per channel, in time order.
  const byChannel = new Map();
  for (const p of grid) {
    for (const m of p.Media || []) {
      if (!m.channelIdentifier) continue;
      const list = byChannel.get(m.channelIdentifier) || [];
      list.push({ ...p, beginsAt: m.beginsAt, endsAt: m.endsAt });
      byChannel.set(m.channelIdentifier, list);
    }
  }
  for (const list of byChannel.values()) list.sort((a, b) => a.beginsAt - b.beginsAt);
  return channels.sort(byNumber).map((c) => ({ ...c, programs: byChannel.get(c.id) || [] }));
}

export async function renderLiveGuide(main) {
  setAmbient(null);
  if (!state.dvr) {
    main.append(h('div', { class: 'notice glass' }, h('h2', {}, 'Live TV is not set up'), h('p', {}, 'This Plex server has no tuner (DVR).')));
    return;
  }
  const list = h('div', { class: 'guide' }, h('p', { class: 'muted' }, 'Loading the guide'));
  main.append(
    h(
      'div',
      { class: 'page live-page' },
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Live TV'), h('span', { class: 'muted count' }, state.dvr.lineupTitle || ''))),
      list,
    ),
  );
  const channels = await loadChannels();
  const now = Date.now() / 1000;
  list.replaceChildren(
    ...channels.map((c) => {
      const current = c.programs.find((p) => p.beginsAt <= now && p.endsAt > now);
      const next = c.programs.find((p) => p.beginsAt >= (current?.endsAt || now));
      const pct = current ? Math.min(100, Math.max(0, ((now - current.beginsAt) / (current.endsAt - current.beginsAt)) * 100)) : 0;
      return h(
        'a',
        { class: 'guide-row', href: `#/live/${c.vcn}`, title: `Watch ${c.title}` },
        h('span', { class: 'ch-logo' }, c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy' }) : null),
        h('span', { class: 'ch-name' }, h('strong', {}, c.vcn), h('small', {}, c.title || c.callSign)),
        h(
          'span',
          { class: 'ch-now' },
          current
            ? [
                h('strong', {}, showTitle(current)),
                h('small', {}, [episodeTitle(current), `${timeText(current.beginsAt)} to ${timeText(current.endsAt)}`].filter(Boolean).join(' · ')),
                h('span', { class: 'ch-progress' }, h('span', { style: { width: `${pct}%` } })),
              ]
            : h('small', { class: 'muted' }, 'No guide data'),
        ),
        h('span', { class: 'ch-next' }, next ? [h('small', {}, `Next at ${timeText(next.beginsAt)}`), h('span', {}, showTitle(next))] : null),
      );
    }),
  );
}

export async function renderLivePlayer(main, { id: vcn }) {
  const { plex, dvr } = state;
  endBackground();
  setAmbient(null);
  const video = h('video', { class: 'player-video', autoplay: true, controls: true });
  const title = h('strong', {}, `Channel ${vcn}`);
  const sub = h('small', {}, 'Tuning');
  const message = h('div', { class: 'live-message', hidden: true });
  const chButton = (dir, label, icon) => h('button', { class: 'ctl glass', 'aria-label': label, title: label, onclick: () => zap(dir) }, svg(icon, 20));
  const top = h(
    'div',
    { class: 'live-top' },
    h('a', { class: 'ctl glass', href: '#/live', 'aria-label': 'Back to the guide', title: 'Back to the guide' }, svg('arrowLeft', 20)),
    h('div', { class: 'live-title' }, title, sub),
    chButton(-1, 'Previous channel', 'down'),
    chButton(1, 'Next channel', 'up'),
  );
  const root = h('div', { class: 'player live-player' }, video, top, message);
  main.append(root);

  let dash = null;
  let session = '';
  let closed = false;
  let channels = [];

  function stop() {
    if (dash) {
      dash.reset();
      dash = null;
    }
    if (session) plex.stopTranscode(session);
    session = '';
    window.marquee.setActiveStream(null);
  }
  function zap(dir) {
    const i = channels.findIndex((c) => String(c.vcn) === vcn);
    if (i < 0 || !channels.length) return;
    location.hash = `#/live/${channels[(i + dir + channels.length) % channels.length].vcn}`;
  }
  const keys = (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'PageUp' || e.key === 'ArrowUp') zap(1);
    else if (e.key === 'PageDown' || e.key === 'ArrowDown') zap(-1);
    else if (e.key === 'Escape' || e.key === 'Backspace') location.hash = '#/live';
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', keys);

  try {
    channels = (await plex.liveChannels(dvr)).sort(byNumber);
    const ch = channels.find((c) => String(c.vcn) === vcn);
    if (!ch) throw new Error(`There is no channel ${vcn} in the lineup.`);
    title.textContent = `${ch.vcn} ${ch.title || ch.callSign}`;
    // The transcoder reads /livetv/sessions/<uuid>/<session>/index.m3u8, so the tune must carry the
    // same X-Plex-Session-Identifier as the transcode or start.mpd stalls on a 404.
    session = uuid();
    const live = await plex.tune(dvr, ch.id, session);
    if (closed) return stop();
    sub.textContent = [showTitle(live), episodeTitle(live)].filter(Boolean).join(' · ');
    // Plex refuses start.mpd for a session without a decision first (see player.js).
    await plex.liveDecision(live.key, session);
    if (closed) return stop();
    window.marquee.setActiveStream([plex.url('/video/:/transcode/universal/stop', { session })]);
    const dashjs = window.dashjs;
    dash = dashjs.MediaPlayer().create();
    dash.updateSettings({ debug: { logLevel: dashjs.Debug.LOG_LEVEL_WARNING }, streaming: { delay: { liveDelay: 6 } } });
    dash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
      const detail = String(e?.error?.message || '').split(/\s*https?:\/\//)[0].trim();
      console.error(`live dash error ${e?.error?.code}: ${detail}`);
      message.textContent = 'The live stream stopped. Go back to the guide and choose the channel again.';
      message.hidden = false;
    });
    dash.initialize(video, plex.liveManifestUrl(live.key, session), true);
  } catch (e) {
    message.textContent = e.message || String(e);
    message.hidden = false;
    sub.textContent = 'Could not tune';
  }

  return () => {
    closed = true;
    document.removeEventListener('keydown', keys);
    stop();
  };
}
