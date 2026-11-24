// Audio bar: music and audiobooks keep playing at the bottom of the window while the user moves
// between pages. Files play directly when Chromium can decode them; otherwise Plex converts them
// to MP3. Progress goes to Plex every 10 seconds, so audiobooks resume where they stopped.
import { h, svg, clock, uuid } from './util.js';
import { state } from './app.js';
import { toast } from './menu.js';

const SPEEDS = [0.75, 1, 1.15, 1.25, 1.5, 1.75, 2];
const TYPES = { mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };

let bar = null;
let audio = null;
let ui = {};
let queue = [];
let index = 0;
let track = null;
let chapters = [];
let session = '';
let lastReport = 0;
// A converted stream starts at `base` seconds; audio.currentTime counts from there.
let base = 0;
let converted = false;

const pos = () => base + (audio?.currentTime || 0);
const durationSec = () => (track?.duration || 0) / 1000;

// tracks: Plex track metadata (with Media). start: index in tracks. at: seconds into that track
// (null resumes from the saved position).
export async function playAudio(tracks, start = 0, { at = null } = {}) {
  if (!tracks.length) return;
  ensureBar();
  if (track) report('stopped');
  queue = tracks;
  await load(start, at);
}

export const audioTrack = () => track;

async function load(i, at = null) {
  const { plex } = state;
  index = i;
  track = queue[i];
  session = uuid();
  chapters = [];
  // Album lists don't always carry Media or chapters, so read the full item.
  if (!track.Media?.length || durationSec() > 20 * 60) {
    const full = await plex.metadata(track.ratingKey, { includeChapters: 1 }).catch(() => null);
    if (full) track = queue[i] = { ...track, ...full };
  }
  chapters = track.Chapter || [];
  const from = at ?? (track.viewOffset && track.viewOffset < track.duration - 30000 ? track.viewOffset / 1000 : 0);
  setSource(from);
  draw();
  audio.play().catch((e) => e.name !== 'AbortError' && toast(`This track did not start: ${e.message}`, { error: true }));
}

function setSource(from, convert = false) {
  const { plex } = state;
  const part = track.Media?.[0]?.Part?.[0];
  const ext = (part?.container || track.Media?.[0]?.container || '').toLowerCase();
  const direct = !convert && part && TYPES[ext] && audio.canPlayType(TYPES[ext]) !== '';
  converted = !direct;
  if (direct) {
    base = 0;
    audio.src = plex.url(part.key);
    audio.addEventListener('loadedmetadata', () => (audio.currentTime = from), { once: true });
  } else {
    base = from;
    audio.src = plex.url('/music/:/transcode/universal/start.mp3', {
      path: track.key,
      mediaIndex: 0,
      partIndex: 0,
      protocol: 'http',
      offset: Math.floor(from),
      directPlay: 0,
      directStream: 0,
      session,
      'X-Plex-Session-Identifier': session,
    });
  }
}

function seekTo(sec) {
  const to = Math.max(0, Math.min(durationSec() - 1, sec));
  if (!converted) audio.currentTime = to;
  else {
    // A converted stream can't seek far; start a new conversion at that point.
    state.plex.get('/transcode/universal/stop', { session }).catch(() => {});
    session = uuid();
    const playing = !audio.paused;
    setSource(to, true);
    if (playing) audio.play().catch(() => {});
  }
  tick();
}

function report(st) {
  if (!track) return;
  lastReport = Date.now();
  state.plex.timeline(track, st, pos() * 1000, session);
}

function next() {
  if (index + 1 < queue.length) load(index + 1, 0);
}
function prev() {
  if (pos() > 5 || index === 0) return seekTo(0);
  load(index - 1, 0);
}
const chapterAt = (sec) => chapters.findLast?.((c) => c.startTimeOffset / 1000 <= sec + 0.5) || null;
function prevChapter() {
  const c = chapterAt(pos());
  const i = c ? chapters.indexOf(c) : -1;
  if (c && pos() - c.startTimeOffset / 1000 > 5) return seekTo(c.startTimeOffset / 1000);
  if (i > 0) seekTo(chapters[i - 1].startTimeOffset / 1000);
  else prev();
}
function nextChapter() {
  const c = chapterAt(pos());
  const n = chapters[(c ? chapters.indexOf(c) : -1) + 1];
  if (n) seekTo(n.startTimeOffset / 1000);
  else next();
}

export function closeAudio() {
  if (!bar) return;
  report('stopped');
  if (converted) state.plex.get('/transcode/universal/stop', { session }).catch(() => {});
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  bar.remove();
  bar = audio = track = null;
  queue = [];
  document.body.classList.remove('has-audio');
}

function ensureBar() {
  if (bar) return;
  audio = new Audio();
  audio.preload = 'auto';
  audio.volume = Number(localStorage.getItem('audioVolume') ?? 1);
  audio.playbackRate = Number(localStorage.getItem('audioSpeed') ?? 1);
  const btn = (icon, label, fn, size = 18) => h('button', { class: 'ctl', 'aria-label': label, title: label, onclick: fn }, svg(icon, size));
  ui.art = h('div', { class: 'ab-art' });
  ui.title = h('strong', {});
  ui.sub = h('small', {});
  ui.play = btn('play', 'Play', () => (audio.paused ? audio.play() : audio.pause()), 22);
  ui.seek = h('input', { type: 'range', class: 'ab-seek', min: 0, max: 1000, value: 0, 'aria-label': 'Position' });
  ui.time = h('span', { class: 'ab-time' });
  ui.speed = h('select', { class: 'ab-speed', 'aria-label': 'Speed', title: 'Speed' }, SPEEDS.map((s) => h('option', { value: s, selected: s === audio.playbackRate }, `${s}x`)));
  ui.vol = h('input', { type: 'range', class: 'vol', min: 0, max: 1, step: 0.02, value: audio.volume, 'aria-label': 'Volume' });
  ui.seek.oninput = () => {
    ui.dragging = true;
    ui.time.textContent = `${clock((ui.seek.value / 1000) * durationSec())} / ${clock(durationSec())}`;
  };
  ui.seek.onchange = () => {
    ui.dragging = false;
    seekTo((ui.seek.value / 1000) * durationSec());
  };
  ui.speed.onchange = () => {
    audio.playbackRate = Number(ui.speed.value);
    localStorage.setItem('audioSpeed', ui.speed.value);
  };
  ui.vol.oninput = () => {
    audio.volume = Number(ui.vol.value);
    localStorage.setItem('audioVolume', ui.vol.value);
  };
  bar = h(
    'div',
    { class: 'audio-bar glass', role: 'region', 'aria-label': 'Audio player' },
    h('a', { class: 'ab-info', href: '#' }, ui.art, h('span', { class: 'ab-text' }, ui.title, ui.sub)),
    h(
      'div',
      { class: 'ab-mid' },
      h(
        'div',
        { class: 'ab-buttons' },
        btn('prev', 'Previous', () => (chapters.length ? prevChapter() : prev())),
        h('button', { class: 'ctl', 'aria-label': 'Back 15 seconds', title: 'Back 15 seconds', onclick: () => seekTo(pos() - 15) }, '-15'),
        ui.play,
        h('button', { class: 'ctl', 'aria-label': 'Forward 30 seconds', title: 'Forward 30 seconds', onclick: () => seekTo(pos() + 30) }, '+30'),
        btn('next', 'Next', () => (chapters.length ? nextChapter() : next())),
      ),
      h('div', { class: 'ab-line' }, ui.seek, ui.time),
    ),
    h('div', { class: 'ab-side' }, ui.speed, svg('volume', 18), ui.vol, btn('close', 'Close the audio player', closeAudio)),
  );
  document.body.append(bar, audio);
  audio.hidden = true;
  document.body.classList.add('has-audio');

  audio.addEventListener('timeupdate', () => {
    if (!audio) return; // closeAudio() already ran
    tick();
    if (!audio.paused && Date.now() - lastReport > 10000) report('playing');
  });
  audio.addEventListener('play', () => {
    ui.play.replaceChildren(svg('pause', 22));
    ui.play.setAttribute('aria-label', 'Pause');
    report('playing');
    mediaSession();
  });
  audio.addEventListener('pause', () => {
    ui.play.replaceChildren(svg('play', 22));
    ui.play.setAttribute('aria-label', 'Play');
    report('paused');
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
  });
  audio.addEventListener('ended', () => {
    report('stopped');
    if (index + 1 < queue.length) load(index + 1, 0);
  });
  audio.addEventListener('error', () => {
    // A direct file that Chromium can't decode after all: let Plex convert it.
    if (!converted && track) {
      setSource(pos(), true);
      return audio.play().catch(() => {});
    }
    toast('This track could not play.', { error: true });
  });
}

// A video takes over: pause the audio. Registered once, not per bar.
window.addEventListener('hashchange', () => {
  if (/^#\/(play|live\/)/.test(location.hash) && audio && !audio.paused) audio.pause();
});

function draw() {
  const { plex } = state;
  const art = track.thumb || track.parentThumb || track.grandparentThumb;
  ui.art.replaceChildren(art ? h('img', { src: plex.img(art, 96, 96), alt: '' }) : svg('music', 22));
  ui.title.textContent = track.title;
  ui.sub.textContent = [track.grandparentTitle, track.parentTitle !== track.title ? track.parentTitle : null].filter(Boolean).join(' - ');
  bar.querySelector('.ab-info').href = `#/album/${track.parentRatingKey}`;
  tick();
}

function tick() {
  if (!track || ui.dragging) return;
  const t = pos();
  const d = durationSec();
  ui.seek.value = d ? Math.round((t / d) * 1000) : 0;
  const c = chapterAt(t);
  ui.time.textContent = `${clock(t)} / ${clock(d)}${c ? ` · ${c.tag}` : ''}`;
  if (navigator.mediaSession && d && !audio.paused) {
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: audio.playbackRate });
    } catch {}
  }
}

function mediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const { plex } = state;
  const art = track.thumb || track.parentThumb;
  try {
    ms.metadata = new MediaMetadata({ title: track.title, artist: track.grandparentTitle || '', album: track.parentTitle || '', artwork: art ? [{ src: plex.img(art, 512, 512), sizes: '512x512', type: 'image/jpeg' }] : [] });
  } catch {}
  ms.playbackState = 'playing';
  const set = (a, fn) => {
    try {
      ms.setActionHandler(a, fn);
    } catch {}
  };
  set('play', () => audio.play());
  set('pause', () => audio.pause());
  set('stop', closeAudio);
  set('seekbackward', () => seekTo(pos() - 15));
  set('seekforward', () => seekTo(pos() + 30));
  set('seekto', (d) => seekTo(d.seekTime));
  set('previoustrack', () => (chapters.length ? prevChapter() : prev()));
  set('nexttrack', () => (chapters.length ? nextChapter() : next()));
}
