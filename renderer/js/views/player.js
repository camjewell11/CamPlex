// Player: DASH stream from Plex, glass controls, markers, track menus, thumbnails, and up next.
import { h, svg, clock, episodeCode, uuid } from '../util.js';
import { state, savePrefs, playInBackground, endBackground } from '../app.js';
import { QUALITY } from '../plex.js';
import { nextEpisode, previousEpisode } from '../actions.js';
import { setAmbient, ambientOf } from '../ambient.js';
import { pageHref } from '../components.js';
import { loadBif } from '../bif.js';
import * as pip from '../pip.js';

const TEXT_SUBS = new Set(['srt', 'subrip', 'ass', 'ssa', 'webvtt', 'vtt', 'text']);
// The app shows a subtitle itself only when it's a separate text file that Plex can send whole.
// Plex can't send embedded tracks on their own, so for those it draws the subtitle into the video.
const shownByApp = (s) => !!s?.key && TEXT_SUBS.has(s.codec);
// Set when the previous or next episode replaces a full-screen player, so the window stays in full
// screen across the change instead of leaving and entering it again.
let carryFullscreen = false;

export async function renderPlayer(main, { id, params }) {
  const { plex, prefs } = state;
  const item = await plex.metadata(id, { includeMarkers: 1, includeChapters: 1 });
  if (!item?.Media?.length) throw new Error('This title has no playable file in Plex.');
  // A player started behind another page (the next episode in picture-in-picture) leaves that page's colors alone.
  if (!params.get('bg')) setAmbient(ambientOf(item));
  const part = item.Media[0].Part[0];
  const streams = part.Stream || [];
  const markers = item.Marker || [];
  const chapters = item.Chapter || [];
  const total = (item.duration || part.duration || 0) / 1000;

  // ---------- elements ----------
  const video = h('video', { class: 'player-video', autoplay: true, crossorigin: 'anonymous' });
  // The show or movie name opens its page. The link replaces the player in history, so Back from
  // that page doesn't start playback again.
  const nameText = item.type === 'episode' ? item.grandparentTitle : item.title;
  const name =
    item.type === 'episode' || item.type === 'movie'
      ? h('a', {
          class: 'p-name',
          href: pageHref(item),
          title: item.type === 'episode' ? `Open ${nameText}` : `Open ${nameText} details`,
          onclick: (e) => {
            e.preventDefault();
            location.replace(pageHref(item));
          },
        }, nameText)
      : h('strong', {}, nameText);
  const titleText = [name, item.type === 'episode' ? h('span', {}, `${episodeCode(item)} ${item.title}`) : item.year ? h('span', {}, String(item.year)) : null];
  const backBtn = h('button', { class: 'ctl glass', 'aria-label': 'Back', title: 'Back (Esc)', onclick: () => back() }, svg('arrowLeft', 20));
  const top = h('div', { class: 'p-top' }, backBtn, h('div', { class: 'p-title' }, titleText));

  const playBtn = h('button', { class: 'ctl big', 'aria-label': 'Play or pause', title: 'Play or pause (Space)' }, svg('pause', 26));
  const backTen = h('button', { class: 'ctl', 'aria-label': 'Back 10 seconds', title: 'Back 10 seconds (Left arrow)' }, svg('back10', 22));
  const fwdTen = h('button', { class: 'ctl', 'aria-label': 'Forward 10 seconds', title: 'Forward 10 seconds (Right arrow)' }, svg('fwd10', 22));
  const isEpisode = item.type === 'episode';
  const prevBtn = isEpisode ? h('button', { class: 'ctl', 'aria-label': 'Previous episode', title: 'Previous episode (Shift+B)', disabled: true }, svg('prev', 20)) : null;
  const nextBtn = isEpisode ? h('button', { class: 'ctl', 'aria-label': 'Next episode', title: 'Next episode (N)', disabled: true }, svg('next', 20)) : null;
  const stopBtn = h('button', { class: 'ctl', 'aria-label': 'Stop', title: isEpisode ? 'Stop and open the episode details (X)' : 'Stop and open the details (X)' }, svg('stop', 18));
  const muteBtn = h('button', { class: 'ctl', 'aria-label': 'Mute', title: 'Mute (M)' }, svg('volume', 20));
  const vol = h('input', { class: 'vol', type: 'range', min: 0, max: 1, step: 0.02, value: Number(localStorage.getItem('volume') ?? 1), 'aria-label': 'Volume' });
  const timeEl = h('span', { class: 'time' }, `0:00 / ${clock(total)}`);
  const tracksBtn = h('button', { class: 'ctl', 'aria-label': 'Audio, subtitles, and quality', title: 'Audio, subtitles, and quality (C)' }, svg('tracks', 20));
  const infoBtn = h('button', { class: 'ctl', 'aria-label': 'Playback details', title: 'Playback details (I)' }, svg('info', 20));
  const fullBtn = h('button', { class: 'ctl', 'aria-label': 'Full screen', title: 'Full screen (F)' }, svg('full', 20));
  const pipBtn = h('button', { class: 'ctl', 'aria-label': 'Picture-in-picture', title: 'Picture-in-picture (P)' }, svg('pip', 20));
  // Firefox-style toggle on the right edge of the video; it opens out to show its label on hover.
  const pipEdge = h('button', { class: 'pip-toggle glass', 'aria-label': 'Picture-in-picture', title: 'Picture-in-picture (P)' }, svg('pip', 18), h('span', { class: 'pip-label' }, 'Picture-in-picture'));
  const pipNote = h(
    'div',
    { class: 'p-pipnote', hidden: true },
    svg('pip', 44),
    h('strong', {}, 'Playing in picture-in-picture'),
    h('button', { class: 'button glass', onclick: () => returnFromPip() }, svg('unpip', 16), 'Bring it back'),
  );

  const played = h('div', { class: 's-played' });
  const buffered = h('div', { class: 's-buffered' });
  const knob = h('div', { class: 's-knob' });
  const preview = h('div', { class: 's-preview glass' }, h('img', { alt: '' }), h('span'));
  const scrub = h('div', { class: 'scrub', role: 'slider', tabindex: 0, 'aria-label': 'Seek', 'aria-valuemin': 0, 'aria-valuemax': Math.round(total) }, h('div', { class: 's-track' }, buffered, played), knob, preview);
  for (const m of markers) {
    if (!total) break;
    const left = (m.startTimeOffset / 1000 / total) * 100;
    const width = ((m.endTimeOffset - m.startTimeOffset) / 1000 / total) * 100;
    scrub.querySelector('.s-track').append(h('span', { class: `s-marker ${m.type}`, style: { left: `${left}%`, width: `${width}%` }, title: m.type === 'intro' ? 'Intro' : 'Credits' }));
  }
  for (const c of chapters.slice(1)) {
    if (total) scrub.querySelector('.s-track').append(h('span', { class: 's-chapter', style: { left: `${(c.startTimeOffset / 1000 / total) * 100}%` } }));
  }

  const bar = h(
    'div',
    { class: 'p-bar glass' },
    scrub,
    // Three groups, so the transport buttons sit in the middle of the bar whatever the sides hold.
    h(
      'div',
      { class: 'p-buttons' },
      h('div', { class: 'pb-side' }, stopBtn, muteBtn, vol, timeEl),
      h('div', { class: 'pb-center' }, prevBtn, backTen, playBtn, fwdTen, nextBtn),
      h('div', { class: 'pb-side end' }, tracksBtn, infoBtn, pipBtn, fullBtn),
    ),
  );
  const skipBtn = h('button', { class: 'skip glass', hidden: true });
  const panel = h('div', { class: 'p-panel glass', hidden: true });
  const stats = h('div', { class: 'p-stats glass', hidden: true });
  const upNext = h('div', { class: 'upnext glass', hidden: true });
  const flash = h('div', { class: 'p-flash' });
  const message = h('div', { class: 'p-message glass', hidden: true });
  const loading = h('div', { class: 'p-loading' }, h('span'));
  // Mini player: after Back, the video keeps playing docked in the corner of the window while the
  // user browses, as in Plex. Clicking the video brings the full player back.
  let inMini = false;
  const miniPlay = h('button', { class: 'ctl', 'aria-label': 'Play or pause', title: 'Play or pause' }, svg('pause', 22));
  const miniProg = h('div', { class: 'm-prog' }, h('span'));
  const mini = h(
    'div',
    { class: 'p-mini', onclick: (e) => e.target === mini && expandMini() },
    h('button', { class: 'ctl m-close', 'aria-label': 'Close', title: 'Stop and close', onclick: () => closeMini() }, svg('close', 18)),
    h(
      'div',
      { class: 'm-buttons' },
      h('button', { class: 'ctl', 'aria-label': 'Expand', title: 'Back to the full player', onclick: () => expandMini() }, svg('full', 20)),
      miniPlay,
      h('button', { class: 'ctl', 'aria-label': 'Picture-in-picture', title: 'Picture-in-picture', onclick: () => popOutMini() }, svg('pip', 20)),
    ),
    h('div', { class: 'm-title' }, nameText),
    miniProg,
  );
  const root = h('div', { class: 'player' }, video, pipNote, loading, flash, top, pipEdge, skipBtn, upNext, panel, stats, message, bar, mini);
  main.append(root);

  // ---------- stream ----------
  let session = uuid();
  let burn = false;
  let dash = null;
  let decisionText = '';
  let subTrackEl = null;
  const dashjs = window.dashjs;

  // Plex ends a transcode after 180 seconds without segment requests. The pause heartbeat below
  // pings it, but a sleeping computer or a network drop can still end it, and then every segment
  // request gets a 404 (dash.js download errors 25 to 28). Start a new transcode at the same
  // position instead of failing, at most once a minute.
  const DOWNLOAD_ERRORS = new Set([25, 26, 27, 28]);
  let lastRestart = 0;

  function start(atSec, { paused = false } = {}) {
    if (dash) {
      dash.reset();
      plex.stopTranscode(session);
      session = uuid();
    }
    loading.hidden = false;
    message.hidden = true;
    const opts = { burn, quality: prefs.quality };
    const url = plex.manifestUrl(item.ratingKey, session, opts);
    const player = dashjs.MediaPlayer().create();
    dash = player;
    dash.updateSettings({
      debug: { logLevel: dashjs.Debug.LOG_LEVEL_WARNING },
      streaming: { buffer: { bufferTimeAtTopQuality: 30, bufferToKeep: 30 }, abr: { autoSwitchBitrate: { video: false } } },
    });
    dash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
      if (player !== dash) return;
      const code = e?.error?.code;
      if (DOWNLOAD_ERRORS.has(code) && Date.now() - lastRestart > 60000) {
        lastRestart = Date.now();
        console.warn(`dash error ${code}: starting a new transcode at ${video.currentTime.toFixed(1)} s`);
        const at = video.currentTime;
        const wasPaused = video.paused;
        setTimeout(() => player === dash && start(at, { paused: wasPaused }));
        return;
      }
      // dash.js puts the request URL, which carries the Plex token, into the message. Keep only the text before it.
      const detail = String(e?.error?.message || '').split(/\s*https?:\/\//)[0].trim();
      console.error(`dash error ${code}: ${detail}`);
      showMessage(
        'Plex could not stream this file.',
        `${code ? `Player error ${code}${detail ? ` (${detail})` : ''}. ` : ''}Open the track menu and choose a lower quality to make Plex convert the video.`,
      );
    });
    window.marquee.setActiveStream(plex.streamEndUrls(item, (atSec || 0) * 1000, session));
    // Ask for the decision on this session first, as Plex Web does. Without it, Plex can refuse
    // start.mpd with HTTP 400 ("session lacking decision"), for example right after a restart.
    plex
      .decision(item.ratingKey, session, opts)
      .then((d) => {
        const s = d.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream || [];
        decisionText = s
          .filter((x) => x.streamType < 3)
          .map((x) => `${x.streamType === 1 ? 'Video' : 'Audio'}: ${x.decision === 'copy' ? 'copied' : 'converted'} as ${x.codec.toUpperCase()}${x.channels ? ` ${x.channels} ch` : ''}`)
          .join('\n');
      })
      .catch(() => {})
      .finally(() => {
        if (player === dash) player.initialize(video, atSec > 1 ? `${url}#t=${Math.floor(atSec)}` : url, !paused);
      });
  }

  function showMessage(title, detail) {
    loading.hidden = true;
    message.replaceChildren(h('h2', {}, title), h('p', {}, detail), h('button', { class: 'button glass', onclick: () => (message.hidden = true) }, 'Dismiss'));
    message.hidden = false;
  }

  const resumeAt = params.get('resume') && item.viewOffset ? item.viewOffset / 1000 : Number(params.get('t') || 0);
  // Restore the subtitle that Plex has selected for this file.
  const initialSub = streams.find((s) => s.streamType === 3 && s.selected);
  if (initialSub && !shownByApp(initialSub)) burn = true;
  start(resumeAt);
  if (shownByApp(initialSub)) loadTextSubtitle(initialSub).then((v) => (v ? addTextTrack(v, initialSub) : null));
  video.volume = Number(vol.value);
  video.muted = localStorage.getItem('muted') === '1';

  // ---------- controls ----------
  const toggle = () => (video.paused ? video.play() : video.pause());
  const seekTo = (t) => {
    video.currentTime = Math.max(0, Math.min(total - 1, t));
    poke();
  };
  playBtn.onclick = toggle;
  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', () => window.marquee.fullscreen());
  backTen.onclick = () => seekTo(video.currentTime - 10);
  stopBtn.onclick = () => stop();
  if (prevBtn) prevBtn.onclick = () => prev && goTo(prev);
  if (nextBtn) nextBtn.onclick = () => next && goNext();
  fwdTen.onclick = () => seekTo(video.currentTime + 10);
  muteBtn.onclick = () => {
    video.muted = !video.muted;
  };
  vol.oninput = () => {
    video.volume = Number(vol.value);
    video.muted = video.volume === 0;
    localStorage.setItem('volume', vol.value);
  };
  fullBtn.onclick = () => window.marquee.fullscreen();
  pipBtn.onclick = () => togglePip();
  pipEdge.onclick = () => togglePip();
  // A window already in app-wide full screen stays that way when playback ends.
  const startedFull = document.body.classList.contains('fullscreen') && !carryFullscreen;
  let isFull = carryFullscreen || startedFull;
  const offFullscreen = window.marquee.onFullscreen((on) => {
    isFull = on;
    fullBtn.replaceChildren(svg(on ? 'exitfull' : 'full', 20));
  });
  // Start in full screen when the setting asks for it, or keep it from the episode before. A player
  // started behind another page or in picture-in-picture leaves the window alone.
  if (isFull) fullBtn.replaceChildren(svg('exitfull', 20));
  else if (prefs.fullscreenPlayer && !params.get('bg') && !params.get('pip')) window.marquee.fullscreen(true);
  carryFullscreen = false;
  tracksBtn.onclick = () => {
    stats.hidden = true;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) buildPanel();
  };
  infoBtn.onclick = () => {
    panel.hidden = true;
    stats.hidden = !stats.hidden;
  };

  video.addEventListener('play', () => {
    playBtn.replaceChildren(svg('pause', 26));
    miniPlay.replaceChildren(svg('pause', 22));
    report('playing');
    pulse('play');
  });
  video.addEventListener('pause', () => {
    playBtn.replaceChildren(svg('play', 26));
    miniPlay.replaceChildren(svg('play', 22));
    report('paused');
    pulse('pause');
    poke();
  });
  video.addEventListener('waiting', () => (loading.hidden = false));
  video.addEventListener('playing', () => (loading.hidden = true));
  video.addEventListener('canplay', () => (loading.hidden = true));
  video.addEventListener('volumechange', () => {
    muteBtn.replaceChildren(svg(video.muted || video.volume === 0 ? 'mute' : 'volume', 20));
    vol.value = video.muted ? 0 : video.volume;
    localStorage.setItem('muted', video.muted ? '1' : '0');
  });
  video.addEventListener('timeupdate', tick);
  video.addEventListener('ended', onEnded);

  function pulse(kind) {
    flash.replaceChildren(svg(kind, 40));
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');
  }

  // Scrubbing with hover thumbnails from Plex's preview index, when the server has one.
  let bif = null;
  if (part.indexes) loadBif(plex, part.id).then((b) => (bif = b)).catch(() => {});
  let dragging = false;
  const posFrom = (e) => {
    const r = scrub.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  scrub.addEventListener('pointermove', (e) => {
    const p = posFrom(e);
    const t = p * total;
    preview.style.left = `${p * 100}%`;
    preview.querySelector('span').textContent = chapterAt(t) ? `${clock(t)}  ${chapterAt(t)}` : clock(t);
    const img = preview.querySelector('img');
    const src = bif?.frameAt(t);
    img.hidden = !src;
    if (src && img.src !== src) img.src = src;
    preview.classList.add('show');
    if (dragging) played.style.width = `${p * 100}%`;
  });
  scrub.addEventListener('pointerleave', () => preview.classList.remove('show'));
  scrub.addEventListener('pointerdown', (e) => {
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
  });
  scrub.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    seekTo(posFrom(e) * total);
  });
  scrub.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.stopPropagation();
      seekTo(video.currentTime + (e.key === 'ArrowLeft' ? -10 : 10));
    }
  });
  const chapterAt = (t) => chapters.find((c) => t * 1000 >= c.startTimeOffset && t * 1000 < c.endTimeOffset)?.tag || '';

  // ---------- markers and up next ----------
  let next = null;
  let prev = null;
  // Look up the neighbors now, so the previous and next buttons work from the start.
  if (isEpisode) {
    nextEpisode(item).then((n) => { next = n; nextBtn.disabled = !n; if (n) nextBtn.title = `Next episode: ${episodeCode(n)} ${n.title} (N)`; }).catch(() => {});
    previousEpisode(item).then((p) => { prev = p; prevBtn.disabled = !p; if (p) prevBtn.title = `Previous episode: ${episodeCode(p)} ${p.title} (Shift+B)`; }).catch(() => {});
  }
  let upNextDismissed = false;
  let countdown = null;
  const credits = markers.find((m) => m.type === 'credits' && m.final) || markers.filter((m) => m.type === 'credits').pop();

  function tick() {
    const t = video.currentTime;
    if (!dragging) played.style.width = `${total ? (t / total) * 100 : 0}%`;
    knob.style.left = played.style.width;
    if (inMini) miniProg.firstChild.style.width = `${total ? (t / total) * 100 : 0}%`;
    timeEl.textContent = `${clock(t)} / ${clock(total)}`;
    scrub.setAttribute('aria-valuenow', Math.round(t));
    if (video.buffered.length) buffered.style.width = `${(video.buffered.end(video.buffered.length - 1) / total) * 100}%`;

    const m = markers.find((x) => t * 1000 >= x.startTimeOffset && t * 1000 < x.endTimeOffset - 1000);
    if (m && !(m.type === 'credits' && !upNext.hidden)) {
      skipBtn.textContent = m.type === 'intro' ? 'Skip intro' : 'Skip credits';
      skipBtn.onclick = () => seekTo(m.endTimeOffset / 1000);
      skipBtn.hidden = false;
    } else skipBtn.hidden = true;

    const creditsStart = credits ? credits.startTimeOffset / 1000 : total - 30;
    if (next && prefs.autoplayNext && !upNextDismissed && t >= creditsStart && upNext.hidden) showUpNext();
    if (stats.hidden === false) renderStats();
  }

  function showUpNext() {
    let left = 15;
    const counter = h('span', { class: 'count' }, `Plays in ${left} seconds`);
    upNext.replaceChildren(
      h('div', { class: 'un-thumb' }, next.thumb ? h('img', { src: plex.img(next.thumb, 400, 225), alt: '' }) : null),
      h(
        'div',
        { class: 'un-text' },
        h('span', { class: 'muted' }, 'Up next'),
        h('strong', {}, `${episodeCode(next)} ${next.title}`),
        counter,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'button primary', onclick: goNext }, svg('play', 16), 'Play now'),
          h(
            'button',
            {
              class: 'button glass',
              onclick: () => {
                upNextDismissed = true;
                upNext.hidden = true;
                clearInterval(countdown);
              },
            },
            'Keep watching',
          ),
        ),
      ),
    );
    upNext.hidden = false;
    clearInterval(countdown);
    countdown = setInterval(() => {
      if (video.paused) return;
      left -= 1;
      counter.textContent = `Plays in ${left} second${left === 1 ? '' : 's'}`;
      if (left <= 0) goNext();
    }, 1000);
  }
  function goNext() {
    clearInterval(countdown);
    if (next) goTo(next);
  }
  // In picture-in-picture the other episode plays in the same window. When the user has moved on
  // to another page, it starts there without leaving that page.
  function goTo(ep) {
    clearInterval(countdown);
    if (parked) playInBackground(ep.ratingKey, inMini ? 'mini' : 'pip');
    else {
      if (inPip) pip.hold();
      else carryFullscreen = isFull;
      location.replace(`#/play/${ep.ratingKey}${inPip ? '?pip=1' : ''}`);
    }
  }
  // Stop: end playback and show this episode's or movie's page in place of the player, so Back
  // doesn't start it again. The route change stops the stream and saves the position.
  function stop() {
    video.pause();
    if (inPip) returnFromPip();
    if (item.type === 'episode' || item.type === 'movie') location.replace(`#/item/${item.ratingKey}`);
    else leave();
  }
  async function onEnded() {
    report('stopped');
    if (item.type === 'episode' && prefs.autoplayNext) {
      if (!next) next = await nextEpisode(item).catch(() => null);
      if (next) return goNext();
    }
    if (parked) {
      pip.close();
      endBackground();
    } else leave();
  }

  // ---------- tracks panel ----------
  function buildPanel() {
    const audios = streams.filter((s) => s.streamType === 2);
    const subs = streams.filter((s) => s.streamType === 3);
    const selAudio = audios.find((s) => s.selected) || audios[0];
    const selSub = subs.find((s) => s.selected);
    const group = (title, opts) => h('fieldset', {}, h('legend', {}, title), opts);
    const opt = (name, label, checked, onpick, note) =>
      h(
        'label',
        { class: 'opt' },
        h('input', { type: 'radio', name, checked, onchange: onpick }),
        h('span', {}, label, note ? h('small', {}, note) : null),
      );
    panel.replaceChildren(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Playback'), h('button', { class: 'ctl', 'aria-label': 'Close', onclick: () => (panel.hidden = true) }, svg('close', 18))),
      h(
        'div',
        { class: 'panel-cols' },
        group('Audio', audios.map((a) => opt('aud', a.extendedDisplayTitle || a.displayTitle, a === selAudio, () => chooseAudio(a)))),
        group('Subtitles', [
          opt('sub', 'Off', !selSub, () => chooseSub(null)),
          ...subs.map((s) => opt('sub', s.extendedDisplayTitle || s.displayTitle, s === selSub, () => chooseSub(s), shownByApp(s) ? null : 'Plex draws these into the video, so it converts the video')),
        ]),
        group(
          'Quality',
          Object.entries(QUALITY).map(([k, q]) => opt('q', q.label, prefs.quality === k, () => chooseQuality(k), k === 'original' ? 'Video copied when this app can play it' : 'Plex converts the video')),
        ),
      ),
    );
  }

  async function chooseAudio(a) {
    streams.filter((s) => s.streamType === 2).forEach((s) => (s.selected = s === a));
    await plex.selectStreams(part.id, { audioStreamID: a.id });
    start(video.currentTime);
  }
  async function chooseQuality(k) {
    prefs.quality = k;
    await savePrefs();
    start(video.currentTime);
  }
  async function chooseSub(s) {
    streams.filter((x) => x.streamType === 3).forEach((x) => (x.selected = x === s));
    await plex.selectStreams(part.id, { subtitleStreamID: s ? s.id : 0 });
    removeTextTrack();
    const wasBurn = burn;
    burn = false;
    if (shownByApp(s)) {
      const vtt = await loadTextSubtitle(s);
      if (vtt) addTextTrack(vtt, s);
      else burn = true;
    } else if (s) burn = true;
    if (burn || wasBurn) start(video.currentTime);
    if (!panel.hidden) buildPanel();
  }
  async function loadTextSubtitle(s) {
    try {
      const r = await window.marquee.request(plex.url(s.key));
      if (r.status < 400 && r.text) return toVtt(r.text, s.codec);
    } catch (e) {
      console.error(e);
    }
    return null;
  }
  function addTextTrack(vtt, s) {
    const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    subTrackEl = h('track', { kind: 'subtitles', src: url, srclang: s.languageCode || 'und', label: s.displayTitle, default: true });
    video.append(subTrackEl);
    subTrackEl.track.mode = 'showing';
  }
  function removeTextTrack() {
    if (subTrackEl) {
      URL.revokeObjectURL(subTrackEl.src);
      subTrackEl.remove();
      subTrackEl = null;
    }
  }

  function renderStats() {
    const q = video.getVideoPlaybackQuality?.();
    const ahead = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
    stats.replaceChildren(
      h('h2', {}, 'Playback details'),
      h('pre', {}, [
        decisionText || 'Stream decision loading',
        `Resolution: ${video.videoWidth}x${video.videoHeight}`,
        `Buffered ahead: ${ahead.toFixed(0)} s`,
        q ? `Dropped frames: ${q.droppedVideoFrames} of ${q.totalVideoFrames}` : '',
        `Quality setting: ${QUALITY[prefs.quality]?.label}`,
        burn ? 'Subtitles: burned in by Plex' : subTrackEl ? 'Subtitles: shown by this app' : 'Subtitles: off',
      ].filter(Boolean).join('\n')),
    );
  }

  // ---------- reporting to Plex ----------
  function report(st) {
    plex.timeline(item, st, video.currentTime * 1000, session);
    window.marquee.setActiveStream(st === 'stopped' ? null : plex.streamEndUrls(item, video.currentTime * 1000, session));
  }
  // While paused, report the pause and ping the transcode, as Plex Web does, so Plex keeps it.
  const heartbeat = setInterval(() => {
    if (!video.paused) return report('playing');
    report('paused');
    plex.pingTranscode(session);
  }, 10000);

  // ---------- picture-in-picture ----------
  // inPip: the video shows in the PiP window. parked: the user has left this page, and the app keeps
  // the player in a hidden host so playback continues (see app.js).
  let inPip = false;
  let parked = false;
  const pipSource = {
    video,
    total,
    title: nameText,
    subtitle: item.type === 'episode' ? `${episodeCode(item)} ${item.title}` : item.year ? String(item.year) : '',
    toggle,
    seek: (t) => seekTo(t),
    skip: () => (skipBtn.hidden ? null : { label: skipBtn.textContent, run: () => skipBtn.click() }),
    onReturn: () => returnFromPip(),
    onClose: () => closedPip(),
  };
  function setPip(on) {
    inPip = on;
    root.classList.toggle('in-pip', on);
    pipNote.hidden = !on;
    pipBtn.replaceChildren(svg(on ? 'unpip' : 'pip', 20));
    pipBtn.title = on ? 'Back from picture-in-picture (P)' : 'Picture-in-picture (P)';
  }
  function enterPip() {
    if (inPip || !pip.enter(pipSource)) return;
    panel.hidden = true;
    stats.hidden = true;
    window.marquee.fullscreen(false);
    setPip(true);
  }
  function returnFromPip() {
    if (!inPip) return;
    setPip(false);
    pip.release(pipSource);
    window.marquee.pip.focusMain();
    if (parked) location.hash = `#/play/${item.ratingKey}`;
  }
  // The PiP window closed with its close button: pause, as Firefox does. A player that the user
  // already left has nothing to return to, so it stops.
  function closedPip() {
    setPip(false);
    video.pause();
    if (parked) endBackground();
  }
  function togglePip() {
    if (inPip) returnFromPip();
    else enterPip();
  }

  // ---------- mini player ----------
  // Trailers and clips have no details page to browse, so Back ends them as before.
  const canMini = item.type === 'episode' || item.type === 'movie';
  function setMini(on) {
    inMini = on;
    root.classList.toggle('mini', on);
    if (on) {
      panel.hidden = true;
      stats.hidden = true;
      upNext.hidden = true;
      tick();
    }
  }
  // Back: dock the video in the corner and go to the page before. A full screen that the player
  // started ends here; one the user turned on for the whole app stays.
  function toMini() {
    if (isFull && !startedFull) window.marquee.fullscreen(false);
    setMini(true);
    leave();
  }
  function back() {
    if (canMini && !inPip && message.hidden) toMini();
    else leave();
  }
  function expandMini() {
    location.hash = `#/play/${item.ratingKey}`;
  }
  function closeMini() {
    video.pause();
    setMini(false);
    endBackground();
  }
  // From the mini player to the floating window. The player stays parked out of sight.
  function popOutMini() {
    setMini(false);
    enterPip();
    if (!inPip) setMini(true);
  }
  if (params.get('mini')) setMini(true);
  // The previous episode was in picture-in-picture, so this one continues there.
  if (params.get('pip') && pip.isOpen() && pip.attach(pipSource)) setPip(true);

  // ---------- idle hiding and keys ----------
  let idle;
  function poke() {
    root.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (!video.paused && panel.hidden && stats.hidden && !root.matches(':has(.p-bar:hover)')) root.classList.add('idle');
    }, 1500);
  }
  root.addEventListener('mousemove', poke);
  poke();

  function onKey(e) {
    if (parked) return;
    if (e.key === ']' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      togglePip();
      return;
    }
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'radio') return;
    const k = e.key.toLowerCase();
    const handled = {
      ' ': toggle,
      k: toggle,
      arrowleft: () => seekTo(video.currentTime - 10),
      arrowright: () => seekTo(video.currentTime + 10),
      j: () => seekTo(video.currentTime - 30),
      l: () => seekTo(video.currentTime + 30),
      arrowup: () => ((video.volume = Math.min(1, video.volume + 0.05)), (vol.value = video.volume)),
      arrowdown: () => ((video.volume = Math.max(0, video.volume - 0.05)), (vol.value = video.volume)),
      m: () => (video.muted = !video.muted),
      f: () => window.marquee.fullscreen(),
      c: () => tracksBtn.click(),
      i: () => infoBtn.click(),
      s: () => !skipBtn.hidden && skipBtn.click(),
      n: () => (e.shiftKey ? null : next && goNext()),
      b: () => (e.shiftKey && prev ? goTo(prev) : null),
      x: () => stop(),
      p: () => togglePip(),
      escape: () => {
        if (!panel.hidden || !stats.hidden) {
          panel.hidden = true;
          stats.hidden = true;
        } else if (document.fullscreenElement || window.innerHeight === screen.height) window.marquee.fullscreen(false);
        else back();
      },
    }[k];
    if (handled) {
      e.preventDefault();
      handled();
      poke();
    }
  }
  document.addEventListener('keydown', onKey);

  function leave() {
    if (history.length > 1) history.back();
    else location.hash = `#/item/${item.type === 'episode' ? item.grandparentRatingKey : item.ratingKey}`;
  }

  const cleanup = () => {
    if (inPip) {
      inPip = false;
      pip.release(pipSource);
    }
    document.removeEventListener('keydown', onKey);
    offFullscreen();
    clearInterval(heartbeat);
    clearInterval(countdown);
    clearTimeout(idle);
    report('stopped');
    plex.stopTranscode(session);
    dash?.reset();
    dash = null;
    removeTextTrack();
    bif?.dispose();
    // A parked player (mini or picture-in-picture) no longer owns the window's full screen.
    if (!carryFullscreen && !startedFull && !parked) window.marquee.fullscreen(false);
  };
  // The router keeps a player in picture-in-picture alive when the user goes to another page.
  cleanup.keepAlive = () => inPip || inMini;
  cleanup.park = (on) => {
    parked = on;
    if (!on) {
      setMini(false);
      poke();
    }
  };
  cleanup.ratingKey = String(item.ratingKey);
  cleanup.root = root;
  return cleanup;
}

// Convert SRT or ASS text to WebVTT. ASS styling is dropped; line breaks are kept.
function toVtt(text, codec) {
  const t = text.replace(/^﻿/, '').replace(/\r/g, '');
  if (/^WEBVTT/.test(t)) return t;
  if (codec === 'ass' || codec === 'ssa' || /^\[Script Info\]/m.test(t)) return assToVtt(t);
  return 'WEBVTT\n\n' + t.replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2');
}

function assToVtt(t) {
  const lines = t.split('\n');
  const formatLine = lines.find((l) => /^Format:/.test(l) && /\bStart\b/.test(l) && /\bText\b/.test(l));
  const fields = (formatLine || 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')
    .slice(7)
    .split(',')
    .map((f) => f.trim());
  const iStart = fields.indexOf('Start');
  const iEnd = fields.indexOf('End');
  const iText = fields.indexOf('Text');
  const stamp = (x) => {
    const [hr, m, sec] = x.trim().split(':');
    const [whole, frac = '0'] = sec.split('.');
    return `${hr.padStart(2, '0')}:${m.padStart(2, '0')}:${whole.padStart(2, '0')}.${frac.padEnd(3, '0').slice(0, 3)}`;
  };
  const cues = [];
  for (const l of lines) {
    if (!l.startsWith('Dialogue:')) continue;
    const parts = l.slice(9).split(',');
    const text = parts
      .slice(iText)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    if (!text) continue;
    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    cues.push([stamp(parts[iStart]), stamp(parts[iEnd]), safe]);
  }
  cues.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return 'WEBVTT\n\n' + cues.map(([a, b, x]) => `${a} --> ${b}\n${x}`).join('\n\n') + '\n';
}
