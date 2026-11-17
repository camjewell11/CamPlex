// Picture-in-picture, after Firefox's design: the player's own <video> keeps playing in the main
// window, and a frameless, always-on-top window shows a mirror of its frames (captureStream) with
// controls on hover. Moving the element itself to another window makes Chromium reload it, which
// breaks the DASH stream, so the stream never moves.
//
// A player describes itself with a source:
//   { video, total, title, subtitle, toggle(), seek(sec), skip() -> { label, run } | null,
//     onReturn(), onClose() }
// onReturn runs for the return button; onClose runs for the close button or when the user closes
// the window. Swapping players (the next episode) without closing the window: hold(), release the
// old source, then attach() the new one.
import { h, svg, clock } from './util.js';

let child = null; // the PiP Window
let ui = null;
let src = null;
let holding = false;
let unbind = null;
let offClosed = null;
let offFull = null;
let fullscreen = false;

export const isOpen = () => !!child && !child.closed;

// Opens the window for a source. Call it from a user action: window.open needs one.
export function enter(source) {
  if (isOpen()) {
    attach(source);
    return true;
  }
  const v = source.video;
  const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
  fullscreen = false;
  child = window.open('about:blank', 'marquee-pip', `popup,aspect=${aspect.toFixed(4)}`);
  if (!child) return false;
  build();
  offClosed = window.marquee.pip.on('closed', onWindowClosed);
  offFull = window.marquee.pip.on('fullscreen', (on) => {
    fullscreen = on;
    ui?.full.replaceChildren(svg(on ? 'exitfull' : 'full', 18));
  });
  attach(source);
  return true;
}

// Keeps the window open while one player hands over to the next.
export function hold() {
  if (isOpen()) holding = true;
}

export function attach(source) {
  if (!isOpen()) return false;
  holding = false;
  if (src && src !== source) detach();
  src = source;
  bind();
  return true;
}

// A player calls this when it stops or returns to the full window. The window closes unless
// hold() came first.
export function release(source) {
  if (src !== source) return;
  detach();
  if (holding) ui?.root.classList.add('loading');
  else closeWindow();
}

export function close() {
  holding = false;
  detach();
  closeWindow();
}

function detach() {
  unbind?.();
  unbind = null;
  src = null;
  if (ui) ui.mirror.srcObject = null;
}

function closeWindow() {
  const w = child;
  child = null;
  ui = null;
  offClosed?.();
  offFull?.();
  offClosed = offFull = null;
  if (w && !w.closed) w.close();
}

// The user closed the window from the taskbar or with Alt+F4.
function onWindowClosed() {
  if (!child) return;
  const s = src;
  child = null;
  ui = null;
  holding = false;
  offClosed?.();
  offFull?.();
  offClosed = offFull = null;
  unbind?.();
  unbind = null;
  src = null;
  s?.onClose();
}

// ---------- window contents ----------
function build() {
  const doc = child.document;
  doc.title = 'Marquee - Picture-in-picture';
  for (const href of ['vendor/font/standard.css', 'pip.css']) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(href, location.href).href;
    doc.head.append(link);
  }
  const mirror = h('video', { class: 'pip-video', autoplay: true });
  mirror.muted = true;
  const cue = h('div', { class: 'pip-cue' });
  const name = h('strong');
  const sub = h('span');
  const btn = (icon, label, onclick, cls = 'pbtn') => h('button', { class: cls, 'aria-label': label, title: label, onclick }, svg(icon, cls.includes('big') ? 22 : 18));
  const back = btn('unpip', 'Back to the player', () => src?.onReturn());
  const shut = btn('close', 'Close', () => {
    const s = src;
    close();
    s?.onClose();
  });
  const top = h('div', { class: 'pip-top' }, h('div', { class: 'pip-title' }, name, sub), back, shut);

  const play = btn('pause', 'Play or pause (Space)', () => src?.toggle(), 'pbtn big');
  const rew = btn('back10', 'Back 10 seconds', () => src && src.seek(src.video.currentTime - 10));
  const fwd = btn('fwd10', 'Forward 10 seconds', () => src && src.seek(src.video.currentTime + 10));
  const mute = btn('volume', 'Mute (M)', () => src && (src.video.muted = !src.video.muted));
  const vol = h('input', { class: 'pip-vol', type: 'range', min: 0, max: 1, step: 0.02, 'aria-label': 'Volume' });
  vol.oninput = () => {
    if (!src) return;
    src.video.volume = Number(vol.value);
    src.video.muted = src.video.volume === 0;
    localStorage.setItem('volume', vol.value);
  };
  const time = h('span', { class: 'pip-time' });
  const full = btn('full', 'Full screen (F)', () => window.marquee.pip.fullscreen());

  const played = h('div', { class: 'pip-played' });
  const buf = h('div', { class: 'pip-buf' });
  const scrub = h('div', { class: 'pip-scrub', role: 'slider', 'aria-label': 'Seek' }, h('div', { class: 'pip-track' }, buf, played));
  let scrubbing = false;
  const frac = (e) => {
    const r = scrub.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  scrub.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    scrub.setPointerCapture(e.pointerId);
    played.style.width = `${frac(e) * 100}%`;
  });
  scrub.addEventListener('pointermove', (e) => scrubbing && (played.style.width = `${frac(e) * 100}%`));
  scrub.addEventListener('pointerup', (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    if (src) src.seek(frac(e) * src.total);
  });

  const bar = h('div', { class: 'pip-bar' }, scrub, h('div', { class: 'pip-row' }, rew, play, fwd, mute, vol, time, h('span', { class: 'spacer' }), full));
  const skip = h('button', { class: 'pip-skip', hidden: true });
  const spinner = h('div', { class: 'pip-loading' }, h('span'));
  const root = h('div', { class: 'pip' }, mirror, cue, spinner, top, skip, bar);
  doc.body.append(root);
  ui = { root, mirror, cue, name, sub, play, mute, vol, time, played, buf, skip, full, scrubbing: () => scrubbing };

  // Controls show while the pointer is over the window, as in Firefox.
  let idle;
  const show = () => {
    root.classList.add('show');
    clearTimeout(idle);
    idle = setTimeout(() => !root.matches(':has(.pip-bar:hover, .pip-top:hover)') && root.classList.remove('show'), 2500);
  };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerleave', () => {
    clearTimeout(idle);
    if (!scrubbing) root.classList.remove('show');
  });

  // Drag the window from anywhere outside the controls. A press without movement plays or pauses;
  // a double press toggles full screen.
  let drag = null;
  let clickTimer;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, .pip-scrub')) return;
    drag = { sx: e.screenX, sy: e.screenY, wx: child.screenX, wy: child.screenY, moved: false };
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.sx;
    const dy = e.screenY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) window.marquee.pip.move(drag.wx + dx, drag.wy + dy);
  });
  root.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => src?.toggle(), 230);
    }
  });
  root.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, .pip-scrub')) return;
    clearTimeout(clickTimer);
    window.marquee.pip.fullscreen();
  });

  doc.addEventListener('keydown', (e) => {
    if (!src) return;
    const v = src.video;
    const k = e.key.toLowerCase();
    const act = {
      ' ': () => src.toggle(),
      k: () => src.toggle(),
      arrowleft: () => src.seek(v.currentTime - 10),
      arrowright: () => src.seek(v.currentTime + 10),
      arrowup: () => (v.volume = Math.min(1, v.volume + 0.05)),
      arrowdown: () => (v.volume = Math.max(0, v.volume - 0.05)),
      m: () => (v.muted = !v.muted),
      f: () => window.marquee.pip.fullscreen(),
      s: () => src.skip()?.run(),
      escape: () => fullscreen && window.marquee.pip.fullscreen(),
    }[k];
    if (k === 'w' && e.ctrlKey) {
      e.preventDefault();
      shut.click();
      return;
    }
    if (act) {
      e.preventDefault();
      act();
      show();
    }
  });
}

// ---------- following the source video ----------
function bind() {
  const v = src.video;
  const ctrl = new AbortController();
  const on = (target, ev, fn) => target.addEventListener(ev, fn, { signal: ctrl.signal });
  ui.root.classList.remove('loading');
  ui.name.textContent = src.title || '';
  ui.sub.textContent = src.subtitle || '';
  child.document.title = `${src.title || 'Marquee'} - Picture-in-picture`;

  const connect = () => {
    ui.mirror.srcObject = v.captureStream();
    ui.mirror.play().catch(() => {});
    if (v.videoWidth && v.videoHeight) window.marquee.pip.aspect(v.videoWidth / v.videoHeight);
  };
  const playState = () => ui.play.replaceChildren(svg(v.paused ? 'play' : 'pause', 22));
  const volState = () => {
    ui.mute.replaceChildren(svg(v.muted || v.volume === 0 ? 'mute' : 'volume', 18));
    ui.vol.value = v.muted ? 0 : v.volume;
  };
  const tick = () => {
    const t = v.currentTime;
    if (!ui.scrubbing()) ui.played.style.width = `${src.total ? (t / src.total) * 100 : 0}%`;
    if (v.buffered.length && src.total) ui.buf.style.width = `${(v.buffered.end(v.buffered.length - 1) / src.total) * 100}%`;
    ui.time.textContent = `${clock(t)} / ${clock(src.total)}`;
    const s = src.skip();
    ui.skip.hidden = !s;
    if (s) {
      ui.skip.textContent = s.label;
      ui.skip.onclick = s.run;
    }
  };
  // Subtitles that the app shows itself are a <track> on the source, which captureStream doesn't
  // carry. Copy the active cues as text.
  const cues = () => {
    const lines = [...v.textTracks].filter((t) => t.mode === 'showing').flatMap((t) => [...(t.activeCues || [])].map((c) => c.text.replace(/<[^>]+>/g, '')));
    ui.cue.replaceChildren(...lines.map((l) => h('span', {}, l)));
  };
  const watchTrack = (t) => on(t, 'cuechange', cues);
  [...v.textTracks].forEach(watchTrack);
  on(v.textTracks, 'addtrack', (e) => watchTrack(e.track));
  on(v.textTracks, 'change', cues);
  on(v.textTracks, 'removetrack', cues);

  // A quality or track change reloads the source, which gives captureStream new tracks.
  on(v, 'loadedmetadata', connect);
  on(v, 'resize', () => v.videoWidth && window.marquee.pip.aspect(v.videoWidth / v.videoHeight));
  on(v, 'play', playState);
  on(v, 'pause', playState);
  on(v, 'volumechange', volState);
  on(v, 'timeupdate', tick);
  on(v, 'waiting', () => ui.root.classList.add('loading'));
  on(v, 'playing', () => ui.root.classList.remove('loading'));
  on(v, 'canplay', () => ui.root.classList.remove('loading'));
  if (v.readyState >= 1) connect();
  playState();
  volState();
  tick();
  cues();
  unbind = () => ctrl.abort();
}
