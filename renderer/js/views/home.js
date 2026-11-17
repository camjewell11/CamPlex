// Home: a rotating hero for recent arrivals, then the rows configured in Settings.
import { h, svg, duration } from '../util.js';
import { state, errorPanel } from '../app.js';
import { posterCard, landscapeCard, row, rowSkeleton, ratingsList } from '../components.js';
import { setAmbient, ambientOf } from '../ambient.js';
import { imageOf } from '../plex.js';
import { play } from '../actions.js';
import { prefersReducedMotion } from '../util.js';

export async function renderHome(main) {
  const heroEl = h('section', { class: 'hero' });
  const rowsEl = h('div', { class: 'rows' });
  main.append(heroEl, rowsEl);

  const timers = [];
  const hero = await buildHero(heroEl, timers).catch((e) => {
    console.error(e);
    heroEl.remove();
    return null;
  });
  rowsEl.addEventListener('mouseleave', () => hero?.restoreAmbient());

  const rows = state.prefs.rows.filter((r) => r.visible);
  const slots = rows.map((r) => {
    const s = rowSkeleton(r.title);
    rowsEl.append(s);
    return s;
  });
  rows.forEach(async (r, i) => {
    try {
      const items = await resolveRow(r);
      if (!items.length) return slots[i].remove();
      const cards = r.type === 'continue' ? items.map((it) => landscapeCard(it)) : items.map(posterCard);
      slots[i].replaceWith(row(r.title, cards));
    } catch (e) {
      console.error(e);
      slots[i].replaceWith(h('section', { class: 'row' }, h('header', {}, h('h2', {}, r.title)), h('p', { class: 'muted' }, `This row could not load: ${e.message}`)));
    }
  });
  if (!rows.length) rowsEl.append(h('div', { class: 'notice glass' }, h('p', {}, 'Home has no rows turned on.'), h('a', { class: 'button', href: '#/settings' }, 'Choose rows in Settings')));

  return () => timers.forEach(clearInterval);
}

export async function resolveRow(r) {
  const { plex, sections } = state;
  if (r.type === 'continue') return plex.continueWatching();
  if (r.type === 'hub') return plex.hubItems(r.key, 30);
  if (r.type === 'filter') {
    const sec = sections.find((s) => s.key === String(r.section));
    if (!sec) throw new Error('Its library no longer exists.');
    const params = { sort: r.sort || 'addedAt:desc', type: sec.type === 'show' ? 2 : 1 };
    if (r.unwatched) params.unwatched = 1;
    if (r.genre) params.genre = r.genre;
    if (r.decade) params.decade = r.decade;
    const { items } = await plex.list(sec.key, params, 0, 30);
    return items;
  }
  return [];
}

async function buildHero(el, timers) {
  const { plex, sections } = state;
  const pools = await Promise.all(
    sections.map((s) =>
      plex
        .list(s.key, { sort: s.type === 'show' ? 'episode.addedAt:desc' : 'addedAt:desc', type: s.type === 'show' ? 2 : 1 }, 0, 16)
        .then((r) => r.items)
        .catch(() => []),
    ),
  );
  const candidates = pools.map((p) => p.filter((i) => i.art && imageOf(i, 'clearLogo')));
  const items = [];
  for (let i = 0; items.length < 6 && candidates.some((c) => c.length); i++) {
    const pool = candidates[i % candidates.length];
    if (pool.length) items.push(pool.shift());
  }
  if (!items.length) {
    el.remove();
    return null;
  }

  const backA = h('img', { class: 'backdrop show', alt: '' });
  const backB = h('img', { class: 'backdrop', alt: '' });
  const content = h('div', { class: 'hero-content' });
  const pager = h('div', { class: 'pager', role: 'tablist', 'aria-label': 'Featured titles' });
  el.append(h('div', { class: 'backdrops' }, backA, backB), h('div', { class: 'hero-shade' }), content, pager);

  let index = 0;
  let front = backA;
  const dots = items.map((it, i) =>
    h('button', { class: 'dot', role: 'tab', 'aria-label': it.title, onclick: () => show(i, true) }, h('span')),
  );
  pager.append(...dots);

  function show(i, user = false) {
    index = i;
    const it = items[i];
    const back = front === backA ? backB : backA;
    back.onload = () => {
      back.classList.add('show');
      front.classList.remove('show');
      front = back;
    };
    back.src = plex.img(it.art, 1920, 1080);
    dots.forEach((d, j) => d.setAttribute('aria-selected', String(j === i)));
    content.replaceChildren(heroText(it));
    setAmbient(ambientOf(it));
    if (user) restart();
  }

  let paused = false;
  el.addEventListener('mouseenter', () => (paused = true));
  el.addEventListener('mouseleave', () => (paused = false));
  let timer;
  function restart() {
    clearInterval(timer);
    if (prefersReducedMotion()) return;
    timer = setInterval(() => {
      if (!paused && !document.hidden) show((index + 1) % items.length);
    }, 9000);
    timers.push(timer);
  }
  show(0);
  restart();
  return { restoreAmbient: () => setAmbient(ambientOf(items[index])) };
}

function heroText(it) {
  const { plex } = state;
  const logo = imageOf(it, 'clearLogo');
  const facts = [it.year, it.contentRating, it.type === 'movie' ? duration(it.duration) : it.childCount ? `${it.childCount} season${it.childCount === 1 ? '' : 's'}` : null]
    .filter(Boolean)
    .map((f) => h('span', {}, String(f)));
  const genres = (it.Genre || []).slice(0, 3).map((g) => g.tag).join(', ');
  const resume = it.type === 'movie' && it.viewOffset;
  return h(
    'div',
    { class: 'hero-copy' },
    logo ? h('img', { class: 'logo', src: plex.img(logo, 900, 360, { format: 'png' }), alt: it.title }) : h('h1', { class: 'title' }, it.title),
    h('div', { class: 'facts' }, facts, genres ? h('span', {}, genres) : null),
    h('div', { class: 'ratings' }, ratingsList(it).map(([k, v, kind]) => h('span', { class: `rating ${kind || ''}` }, h('b', {}, v), ` ${k}`))),
    it.summary ? h('p', { class: 'summary' }, it.summary) : null,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'button primary', onclick: () => play(it) }, svg('play', 18), resume ? 'Resume' : 'Play'),
      h('a', { class: 'button glass', href: `#/item/${it.ratingKey}` }, 'Details'),
    ),
  );
}
