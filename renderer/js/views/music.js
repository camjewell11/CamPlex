// Music and audiobook libraries: albums and artists, album pages with tracks or chapters, and
// artist pages. Playback happens in the audio bar (../audio.js).
import { h, svg, clock, duration } from '../util.js';
import { state } from '../app.js';
import { setAmbient } from '../ambient.js';
import { playAudio } from '../audio.js';
import { row } from '../components.js';

const PAGE = 72;
const ALBUM_SORTS = [
  ['titleSort', 'Title'],
  ['artist.titleSort,album.titleSort', 'Artist'],
  ['addedAt:desc', 'Recently added'],
  ['lastViewedAt:desc', 'Recently played'],
  ['year:desc', 'Year'],
];

export function squareCard(item) {
  const { plex } = state;
  const href = item.type === 'artist' ? `#/artist/${item.ratingKey}` : `#/album/${item.type === 'track' ? item.parentRatingKey : item.ratingKey}`;
  const thumb = item.thumb || item.parentThumb;
  const progress = item.type === 'track' && item.viewOffset && item.duration ? item.viewOffset / item.duration : 0;
  return h(
    'a',
    { class: 'card poster square', href },
    h(
      'div',
      { class: 'art' },
      thumb ? h('img', { src: plex.img(thumb, 320, 320), alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'noart' }, item.type === 'track' ? item.parentTitle : item.title),
      progress ? h('div', { class: 'progress' }, h('span', { style: { width: `${Math.round(progress * 100)}%` } })) : null,
    ),
    h('div', { class: 'caption' }, h('span', { class: 'name' }, item.type === 'track' ? item.parentTitle || item.title : item.title), h('span', { class: 'sub' }, item.type === 'artist' ? '' : item.type === 'track' ? `${clock((item.duration - item.viewOffset) / 1000)} left` : item.parentTitle || '')),
  );
}

export async function renderAudioLibrary(main, sec, params) {
  const { plex } = state;
  setAmbient(null);
  const view = params.get('view') === 'artists' ? 'artists' : 'albums';
  const isBooks = /book/i.test(sec.title) || /audnexus|audiobook/i.test(sec.agent || '');
  const sort = params.get('sort') || 'titleSort';
  const tabs = h(
    'div',
    { class: 'season-tabs library-tabs', role: 'tablist', 'aria-label': 'View' },
    h('a', { role: 'tab', href: `#/library/${sec.key}`, 'aria-selected': String(view === 'albums') }, isBooks ? 'Books' : 'Albums'),
    h('a', { role: 'tab', href: `#/library/${sec.key}?view=artists`, 'aria-selected': String(view === 'artists') }, isBooks ? 'Authors' : 'Artists'),
  );
  const sortSel = h('select', { 'aria-label': 'Sort by' }, ALBUM_SORTS.map(([v, label]) => h('option', { value: v, selected: v === sort }, label)));
  const count = h('span', { class: 'muted count' });
  const grid = h('div', { class: 'grid' });
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
  const listening = h('div', {});
  main.append(
    h(
      'div',
      { class: 'page library' },
      h(
        'header',
        { class: 'page-head' },
        h('div', {}, h('h1', {}, sec.title), count, tabs),
        view === 'albums' ? h('div', { class: 'filters glass' }, h('label', {}, h('span', {}, 'Sort'), sortSel)) : null,
      ),
      listening,
      grid,
      sentinel,
    ),
  );
  sortSel.onchange = () => (location.hash = `#/library/${sec.key}?sort=${encodeURIComponent(sortSel.value)}`);

  // Tracks with a saved position: books (or long tracks) in progress.
  if (view === 'albums') {
    plex
      .get(`/library/sections/${sec.key}/all`, { type: 10, 'viewOffset>>': 1, sort: 'lastViewedAt:desc', 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 20 })
      .then((c) => {
        const items = c.Metadata || [];
        if (items.length) listening.replaceChildren(row('Continue listening', items.map(squareCard)));
      })
      .catch(() => {});
  }

  let loaded = 0;
  let total = Infinity;
  let busy = false;
  async function more() {
    if (busy || loaded >= total) return;
    busy = true;
    try {
      const query = view === 'artists' ? { type: 8, sort: 'titleSort' } : { type: 9, sort };
      const c = await plex.get(`/library/sections/${sec.key}/all`, { ...query, 'X-Plex-Container-Start': loaded, 'X-Plex-Container-Size': PAGE });
      const items = c.Metadata || [];
      total = c.totalSize ?? c.size ?? 0;
      loaded += items.length;
      if (!items.length) total = loaded;
      grid.append(...items.map(squareCard));
      const noun = view === 'artists' ? (isBooks ? 'authors' : 'artists') : isBooks ? 'books' : 'albums';
      count.textContent = `${total} ${noun}`;
    } catch (e) {
      grid.append(h('p', { class: 'muted' }, `More titles could not load: ${e.message}`));
      total = loaded;
    } finally {
      busy = false;
    }
    if (loaded < total && sentinel.getBoundingClientRect().top < innerHeight + 800) more();
  }
  const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: '800px 0px' });
  io.observe(sentinel);
  more();
  return () => io.disconnect();
}

export async function renderArtist(main, { id }) {
  const { plex } = state;
  const [artist, albums] = await Promise.all([plex.metadata(id), plex.children(id)]);
  if (!artist) throw new Error('This artist is no longer on the server.');
  setAmbient(null);
  main.append(
    h(
      'div',
      { class: 'page library' },
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, artist.title), h('span', { class: 'muted count' }, `${albums.length} album${albums.length === 1 ? '' : 's'}`))),
      artist.summary ? h('p', { class: 'summary audio-summary' }, artist.summary) : null,
      h('div', { class: 'grid' }, albums.map(squareCard)),
    ),
  );
}

export async function renderAlbum(main, { id }) {
  const { plex } = state;
  const [album, tracks] = await Promise.all([plex.metadata(id), plex.children(id)]);
  if (!album) throw new Error('This album is no longer on the server.');
  setAmbient(null);
  const total = tracks.reduce((n, t) => n + (t.duration || 0), 0);
  // A one-file audiobook: list its chapters instead of a single track.
  let chapters = [];
  if (tracks.length === 1) {
    const full = await plex.metadata(tracks[0].ratingKey, { includeChapters: 1 }).catch(() => null);
    if (full) tracks[0] = { ...tracks[0], ...full };
    chapters = tracks[0].Chapter || [];
  }
  const resumeAt = tracks.findIndex((t) => t.viewOffset && t.viewOffset < t.duration - 30000);
  const playBtn = h(
    'button',
    { class: 'button primary', onclick: () => playAudio(tracks, Math.max(0, resumeAt)) },
    svg('play', 18),
    resumeAt >= 0 ? `Resume (${clock((tracks[resumeAt].duration - tracks[resumeAt].viewOffset) / 1000)} left)` : 'Play',
  );
  const fromStart = resumeAt >= 0 ? h('button', { class: 'button glass', onclick: () => playAudio(tracks, 0, { at: 0 }) }, 'Play from start') : null;
  const shuffle =
    tracks.length > 2
      ? h('button', { class: 'button glass', onclick: () => playAudio([...tracks].sort(() => Math.random() - 0.5), 0, { at: 0 }) }, svg('shuffle', 18), 'Shuffle')
      : null;
  const art = album.thumb;
  const rows = chapters.length
    ? chapters.map((c, i) =>
        h(
          'button',
          { class: 'trk', onclick: () => playAudio(tracks, 0, { at: c.startTimeOffset / 1000 }) },
          h('span', { class: 'n' }, String(i + 1)),
          h('span', { class: 't' }, c.tag || `Chapter ${i + 1}`),
          h('span', { class: 'd' }, clock((c.endTimeOffset - c.startTimeOffset) / 1000)),
        ),
      )
    : tracks.map((t, i) =>
        h(
          'button',
          { class: 'trk', onclick: () => playAudio(tracks, i, { at: 0 }) },
          h('span', { class: 'n' }, String(t.index || i + 1)),
          h('span', { class: 't' }, t.title, t.viewOffset ? h('small', { class: 'muted' }, ` ${clock(t.viewOffset / 1000)} played`) : null),
          h('span', { class: 'd' }, clock((t.duration || 0) / 1000)),
        ),
      );
  main.append(
    h(
      'div',
      { class: 'page album-page' },
      h(
        'header',
        { class: 'album-head' },
        h('div', { class: 'album-art' }, art ? h('img', { src: plex.img(art, 480, 480), alt: '' }) : svg('music', 64)),
        h(
          'div',
          { class: 'album-text' },
          h('h1', {}, album.title),
          album.parentTitle ? h('a', { class: 'album-artist', href: `#/artist/${album.parentRatingKey}` }, album.parentTitle) : null,
          h('div', { class: 'facts' }, [album.year, `${tracks.length} track${tracks.length === 1 ? '' : 's'}`, total ? duration(total) : null].filter(Boolean).map((f) => h('span', {}, String(f)))),
          album.summary ? h('p', { class: 'summary' }, album.summary) : null,
          h('div', { class: 'actions' }, playBtn, fromStart, shuffle),
        ),
      ),
      h('section', { class: 'tracklist glass' }, chapters.length ? h('h2', {}, 'Chapters') : null, rows),
    ),
  );
}
