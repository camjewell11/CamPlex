// Downloads: the original file, or an MP4 that the server converts first.
// Conversion uses the server's download queue (probed 2026-11-24, PMS 1.43.5):
//   POST /downloadQueue                      -> this client's queue (one per client identifier)
//   POST /downloadQueue/<q>/add?keys=...     -> queue item; the server converts it unthrottled
//   GET  /downloadQueue/<q>/items            -> status deciding, processing, available, or error
//   GET  /downloadQueue/<q>/item/<i>/media   -> the converted MP4
//   DELETE /downloadQueue/<q>/items/<i>      -> removes the item and stops its conversion
// The main process asks where to save and runs the download itself (main.js, setupDownloads).
import { h, svg, bytes } from './util.js';
import { state } from './app.js';
import { QUALITY } from './plex.js';
import { toast } from './menu.js';

const MP4_PROFILE = 'add-transcode-target(type=videoProfile&context=static&protocol=http&container=mp4&videoCodec=h264&audioCodec=aac&replace=true)';
const entries = []; // { key, title, phase, progress, received, total, id, queueItem, path }
let panel = null;
let queue = null;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.marquee.downloads.onUpdate((u) => {
    const e = entries.find((x) => x.id === u.id);
    if (!e) return;
    e.received = u.received;
    e.total = u.total;
    e.path = u.path;
    if (u.state === 'completed') e.phase = 'done';
    else if (u.state === 'cancelled') e.phase = 'canceled';
    else if (u.state === 'interrupted') e.phase = 'failed';
    else e.phase = 'downloading';
    if (e.phase === 'done') toast(`Downloaded ${e.title}`);
    if (e.phase === 'failed') toast(`The download of ${e.title} stopped.`, { error: true });
    if (e.queueItem && e.phase !== 'downloading') removeQueueItem(e);
    draw();
  });
}

// ---------- file names ----------
function baseName(file) {
  return String(file || '').split(/[\\/]/).pop();
}
function displayTitle(item) {
  if (item.type === 'episode') {
    const num = item.parentIndex != null && item.index != null ? ` - S${String(item.parentIndex).padStart(2, '0')}E${String(item.index).padStart(2, '0')}` : '';
    return `${item.grandparentTitle}${num} - ${item.title}`;
  }
  return item.year ? `${item.title} (${item.year})` : item.title;
}
function mediaOf(item) {
  const m = item.Media || [];
  return m[item.mediaIndex || 0] || m[0] || null;
}

// The menu items for a movie or an episode: the original file and two MP4 sizes.
export function downloadItems(item) {
  if (!['movie', 'episode'].includes(item.type)) return [];
  const media = mediaOf(item);
  const part = media?.Part?.[0];
  if (!part?.key) return [];
  const size = bytes(part.size);
  const kind = (media.container || baseName(part.file).split('.').pop() || '').toUpperCase();
  return [
    { label: `Download original (${[kind, size].filter(Boolean).join(', ')})`, icon: 'download', run: () => downloadOriginal(item) },
    { label: 'Download as MP4, 1080p', icon: 'download', run: () => downloadConverted(item, '1080') },
    { label: 'Download as MP4, 720p', icon: 'download', run: () => downloadConverted(item, '720') },
  ];
}

export async function downloadOriginal(item) {
  listen();
  const part = mediaOf(item)?.Part?.[0];
  const name = baseName(part.file) || `${displayTitle(item)}.${mediaOf(item)?.container || 'mkv'}`;
  const r = await window.marquee.downloads.choose(name);
  if (!r) return;
  const e = { key: `o${Date.now()}`, title: displayTitle(item), phase: 'downloading', progress: 0 };
  entries.unshift(e);
  draw();
  try {
    const s = await window.marquee.downloads.start(state.plex.url(part.key, { download: 1 }), r.path);
    Object.assign(e, s);
  } catch (err) {
    e.phase = 'failed';
    toast(`The download didn't start: ${err.message}`, { error: true });
  }
  draw();
}

async function queueId() {
  if (queue) return queue;
  const mc = await state.plex.post('/downloadQueue');
  const q = mc.DownloadQueue?.[0]?.id;
  if (!q) throw new Error('This Plex server has no download queue.');
  // Items left from an earlier run (the window closed mid-download) only hold server disk space.
  const left = (await state.plex.get(`/downloadQueue/${q}/items`)).DownloadQueueItem || [];
  if (left.length) await state.plex.del(`/downloadQueue/${q}/items/${left.map((i) => i.id).join(',')}`).catch(() => {});
  queue = q;
  return q;
}
function removeQueueItem(e) {
  const id = e.queueItem;
  e.queueItem = null;
  if (id && queue) state.plex.del(`/downloadQueue/${queue}/items/${id}`).catch(() => {});
}

export async function downloadConverted(item, quality) {
  listen();
  // Ask where to save first, so the user isn't asked minutes later when the conversion ends.
  const r = await window.marquee.downloads.choose(`${displayTitle(item)}.mp4`);
  if (!r) return;
  const q = QUALITY[quality];
  const e = { key: `c${Date.now()}`, title: displayTitle(item), phase: 'converting', progress: 0 };
  entries.unshift(e);
  draw();
  try {
    const qid = await queueId();
    const add = await state.plex.post(`/downloadQueue/${qid}/add`, {
      keys: `/library/metadata/${item.ratingKey}`,
      mediaIndex: item.mediaIndex || 0,
      videoBitrate: q.bitrate,
      videoResolution: q.resolution,
      subtitles: 'none',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Client-Profile-Extra': MP4_PROFILE,
    });
    e.queueItem = add.AddedQueueItems?.[0]?.id;
    if (!e.queueItem) throw new Error('The server did not accept the item.');
    for (;;) {
      await new Promise((res) => setTimeout(res, 2000));
      if (e.phase === 'canceled') return;
      const it = ((await state.plex.get(`/downloadQueue/${qid}/items`)).DownloadQueueItem || []).find((x) => x.id === e.queueItem);
      if (!it) throw new Error('The server dropped the conversion.');
      if (it.status === 'error') throw new Error(conversionError(it.error));
      if (it.status === 'available') break;
      e.progress = it.TranscodeSession?.progress || 0;
      draw();
    }
    e.phase = 'downloading';
    e.progress = 0;
    draw();
    const s = await window.marquee.downloads.start(state.plex.url(`/downloadQueue/${qid}/item/${e.queueItem}/media`), r.path);
    Object.assign(e, s);
  } catch (err) {
    if (e.phase === 'canceled') return;
    e.phase = 'failed';
    removeQueueItem(e);
    toast(`The conversion of ${e.title} failed: ${err.message}`, { error: true });
  }
  draw();
}
function conversionError(code) {
  if (code === 'sourceFileUnavailable') return 'the server could not read the file';
  if (code === 'decisionError') return 'the server could not plan the conversion';
  return code || 'unknown error';
}

function cancel(e) {
  if (e.phase === 'converting') {
    e.phase = 'canceled';
    removeQueueItem(e);
  } else if (e.phase === 'downloading' && e.id) window.marquee.downloads.cancel(e.id);
  draw();
}

// ---------- panel ----------
function statusText(e) {
  if (e.phase === 'converting') return `Converting on the server, ${Math.floor(e.progress)}%`;
  if (e.phase === 'downloading') return e.total ? `${bytes(e.received)} of ${bytes(e.total)}` : e.received ? bytes(e.received) : 'Starting';
  if (e.phase === 'done') return 'Downloaded';
  if (e.phase === 'canceled') return 'Canceled';
  return 'Failed';
}
function percent(e) {
  if (e.phase === 'converting') return e.progress;
  if (e.phase === 'downloading') return e.total ? (100 * e.received) / e.total : 0;
  return e.phase === 'done' ? 100 : 0;
}
function draw() {
  if (!panel) {
    panel = h('section', { class: 'downloads glass', 'aria-label': 'Downloads' });
    document.body.append(panel);
  }
  panel.hidden = !entries.length;
  panel.replaceChildren(
    h('header', {}, h('strong', {}, 'Downloads'), h('button', { class: 'ctl', 'aria-label': 'Close the downloads list', title: 'Close', onclick: clearFinished }, svg('close', 16))),
    ...entries.map((e) => {
      const active = e.phase === 'converting' || e.phase === 'downloading';
      return h(
        'div',
        { class: `dl-row ${e.phase}` },
        h('div', { class: 'dl-text' }, h('span', { class: 'dl-title', title: e.title }, e.title), h('small', {}, statusText(e))),
        active
          ? h('button', { class: 'ctl', 'aria-label': `Cancel ${e.title}`, title: 'Cancel', onclick: () => cancel(e) }, svg('close', 16))
          : e.phase === 'done'
            ? h('button', { class: 'ctl', 'aria-label': `Show ${e.title} in its folder`, title: 'Show in folder', onclick: () => window.marquee.downloads.show(e.id) }, svg('folder', 16))
            : null,
        h('div', { class: 'dl-bar' }, h('span', { style: `width:${percent(e).toFixed(1)}%` })),
      );
    }),
  );
}
// Close removes finished rows. Active downloads stay, so the list stays open while one runs.
function clearFinished() {
  for (let i = entries.length - 1; i >= 0; i--) if (!['converting', 'downloading'].includes(entries[i].phase)) entries.splice(i, 1);
  draw();
}
