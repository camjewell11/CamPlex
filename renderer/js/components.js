// Shared UI pieces: poster and landscape cards, scrolling rows.
import { h, svg, episodeCode, debounce } from './util.js';
import { state } from './app.js';
import { setAmbient, ambientOf } from './ambient.js';

const hoverAmbient = debounce((item) => {
  if (state.prefs?.ambientOnHover) setAmbient(ambientOf(item));
}, 220);

function focusHandlers(item) {
  const fn = () => hoverAmbient(item);
  return { onmouseenter: fn, onfocus: fn };
}

function progressBar(item) {
  if (!item.viewOffset || !item.duration) return null;
  const pct = Math.min(100, (item.viewOffset / item.duration) * 100);
  return h('div', { class: 'progress' }, h('span', { style: { width: `${pct}%` } }));
}

function badge(item) {
  if (item.type === 'show' || item.type === 'season') {
    const left = (item.leafCount || 0) - (item.viewedLeafCount || 0);
    if (left > 0) return h('span', { class: 'badge count', title: `${left} unwatched episodes` }, String(left));
    if (item.leafCount) return h('span', { class: 'badge done', title: 'Watched' }, svg('check', 14));
    return null;
  }
  if (item.viewCount && !item.viewOffset) return h('span', { class: 'badge done', title: 'Watched' }, svg('check', 14));
  return null;
}

export function posterCard(item) {
  const { plex } = state;
  const thumb = item.type === 'episode' ? item.grandparentThumb || item.parentThumb : item.thumb;
  const target = item.type === 'episode' ? item.ratingKey : item.ratingKey;
  return h(
    'a',
    { class: 'card poster', href: `#/item/${target}`, ...focusHandlers(item) },
    h(
      'div',
      { class: 'art' },
      thumb ? h('img', { src: plex.img(thumb, 320, 480), alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'noart' }, item.title),
      badge(item),
      progressBar(item),
    ),
    h('div', { class: 'caption' }, h('span', { class: 'name' }, item.type === 'episode' ? item.grandparentTitle : item.title), h('span', { class: 'sub' }, subline(item))),
  );
}

function subline(item) {
  if (item.type === 'episode') return `${episodeCode(item)} ${item.title}`;
  if (item.type === 'season') return item.leafCount ? `${item.leafCount} episodes` : '';
  if (item.type === 'show') return item.childCount ? `${item.year || ''}${item.year ? ', ' : ''}${item.childCount} season${item.childCount === 1 ? '' : 's'}` : String(item.year || '');
  return String(item.year || '');
}

// 16:9 card for continue watching, episodes, and extras. Selecting it starts playback.
export function landscapeCard(item, { playable = true, label } = {}) {
  const { plex } = state;
  const img = item.type === 'episode' || item.type === 'clip' ? item.thumb : item.art || item.thumb;
  const title = item.type === 'episode' ? item.grandparentTitle : item.title;
  const sub = label || (item.type === 'episode' ? `${episodeCode(item)} ${item.title}` : item.year ? String(item.year) : '');
  const href = playable ? `#/play/${item.ratingKey}${item.viewOffset ? '?resume=1' : ''}` : `#/item/${item.ratingKey}`;
  return h(
    'a',
    { class: 'card wide', href, ...focusHandlers(item) },
    h(
      'div',
      { class: 'art' },
      img ? h('img', { src: plex.img(img, 560, 315), alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'noart' }, title),
      playable ? h('span', { class: 'playhint glass' }, svg('play', 18)) : null,
      progressBar(item),
    ),
    h('div', { class: 'caption' }, h('span', { class: 'name' }, title), h('span', { class: 'sub' }, sub)),
  );
}

export function row(title, cards, { note } = {}) {
  const track = h('div', { class: 'track' }, cards);
  const scrollBy = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
  return h(
    'section',
    { class: 'row' },
    h('header', {}, h('h2', {}, title), note ? h('span', { class: 'note' }, note) : null),
    h(
      'div',
      { class: 'rail' },
      h('button', { class: 'nudge left glass', 'aria-label': 'Scroll left', onclick: () => scrollBy(-1) }, svg('arrowLeft', 20)),
      track,
      h('button', { class: 'nudge right glass', 'aria-label': 'Scroll right', onclick: () => scrollBy(1) }, svg('arrowRight', 20)),
    ),
  );
}

export function rowSkeleton(title) {
  return h(
    'section',
    { class: 'row loading' },
    h('header', {}, h('h2', {}, title)),
    h('div', { class: 'rail' }, h('div', { class: 'track' }, Array.from({ length: 8 }, () => h('div', { class: 'card poster ghost' }, h('div', { class: 'art' }))))),
  );
}

export function ratingsList(item) {
  const out = [];
  for (const r of item.Rating || []) {
    const src = r.image || '';
    if (src.startsWith('imdb')) out.push(['IMDb', r.value.toFixed(1)]);
    else if (src.includes('rottentomatoes') && r.type === 'critic') out.push(['Critics', `${Math.round(r.value * 10)}%`, src.endsWith('.rotten') ? 'rotten' : 'fresh']);
    else if (src.includes('rottentomatoes') && r.type === 'audience') out.push(['Audience', `${Math.round(r.value * 10)}%`, src.includes('spilled') ? 'spilled' : 'upright']);
    else if (src.startsWith('themoviedb')) out.push(['TMDB', `${Math.round(r.value * 10)}%`]);
  }
  if (!out.length && item.audienceRating) out.push(['Audience', item.audienceRating.toFixed(1)]);
  return out;
}
