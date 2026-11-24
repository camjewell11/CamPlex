// Home: a rotating hero of unwatched movies and shows in progress, filtered by genre, then the rows configured in Settings.
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
      const cards = r.type === 'continue' ? items.map((it) => landscapeCard(it, { inContinue: true })) : items.map(posterCard);
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

// A show counts as "currently watching" when it has unwatched episodes and the user watched one of
// its episodes within this many days.
export const WATCHING_DAYS = 90;

// Featured candidates for one library: unwatched movies, newest first, or shows the user is
// watching, most recently watched first. With genres on, Plex applies the genre filter itself,
// because list responses carry only the first two genres of each title.
export async function featuredCandidates(section, { genres = true } = {}) {
  const { plex, prefs } = state;
  const { include, exclude } = prefs.featured;
  const params =
    section.type === 'show'
      ? { type: 2, unwatchedLeaves: 1, 'lastViewedAt>>': `-${WATCHING_DAYS}d`, sort: 'lastViewedAt:desc' }
      : { type: 1, unwatched: 1, sort: 'addedAt:desc' };
  if (genres && (include.length || exclude.length)) {
    const all = await plex.genres(section.key);
    const ids = (names) => all.filter((g) => names.includes(g.title)).map((g) => g.key).join(',');
    if (include.length) {
      params.genre = ids(include);
      if (!params.genre) return [];
    }
    if (exclude.length) params['genre!'] = ids(exclude) || undefined;
  }
  const { items } = await plex.list(section.key, params, 0, section.type === 'show' ? 40 : 16);
  // Marking episodes unwatched leaves the show's lastViewedAt set, so also require a watched episode.
  return section.type === 'show' ? items.filter((i) => i.viewedLeafCount > 0) : items;
}

// The genre-filtered titles, plus shows the user chose to feature whatever their genres.
async function featuredPool(section) {
  const items = await featuredCandidates(section);
  const always = state.prefs.featured.alwaysShow || [];
  if (section.type !== 'show' || !always.length) return items;
  const extra = (await featuredCandidates(section, { genres: false })).filter((i) => always.includes(i.ratingKey));
  const seen = new Set(items.map((i) => i.ratingKey));
  return [...items, ...extra.filter((i) => !seen.has(i.ratingKey))].sort((a, b) => (b.lastViewedAt || 0) - (a.lastViewedAt || 0));
}

async function buildHero(el, timers) {
  const { plex, sections } = state;
  const pools = await Promise.all(sections.map((s) => featuredPool(s).catch(() => [])));
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
