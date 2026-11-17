// Library grid: sort, unwatched and genre filters, and pages that load as you scroll.
import { h } from '../util.js';
import { state } from '../app.js';
import { posterCard } from '../components.js';
import { setAmbient } from '../ambient.js';

export const SORTS = {
  movie: [
    ['titleSort', 'Title'],
    ['addedAt:desc', 'Recently added'],
    ['originallyAvailableAt:desc', 'Release date, newest first'],
    ['originallyAvailableAt', 'Release date, oldest first'],
    ['audienceRating:desc', 'Audience rating'],
    ['rating:desc', 'Critic rating'],
    ['lastViewedAt:desc', 'Recently watched'],
    ['duration', 'Shortest first'],
    ['random', 'Random'],
  ],
  show: [
    ['titleSort', 'Title'],
    ['episode.addedAt:desc', 'Newest episode'],
    ['addedAt:desc', 'Recently added show'],
    ['originallyAvailableAt:desc', 'First aired, newest first'],
    ['audienceRating:desc', 'Audience rating'],
    ['lastViewedAt:desc', 'Recently watched'],
    ['random', 'Random'],
  ],
};

const PAGE = 72;

export async function renderLibrary(main, { id, params }) {
  const { plex, sections } = state;
  const sec = sections.find((s) => s.key === id);
  if (!sec) throw new Error('This library no longer exists on the server.');
  setAmbient(null);

  const opts = {
    sort: params.get('sort') || 'titleSort',
    unwatched: params.get('unwatched') === '1',
    genre: params.get('genre') || '',
  };

  const sortSel = h('select', { 'aria-label': 'Sort by' }, SORTS[sec.type].map(([v, label]) => h('option', { value: v, selected: v === opts.sort }, label)));
  const unwatched = h('input', { type: 'checkbox', checked: opts.unwatched });
  const genreSel = h('select', { 'aria-label': 'Genre' }, h('option', { value: '' }, 'All genres'));
  const count = h('span', { class: 'muted count' });
  const grid = h('div', { class: 'grid' });
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });

  main.append(
    h(
      'div',
      { class: 'page library' },
      h(
        'header',
        { class: 'page-head' },
        h('div', {}, h('h1', {}, sec.title), count),
        h(
          'div',
          { class: 'filters glass' },
          h('label', {}, h('span', {}, 'Sort'), sortSel),
          h('label', {}, h('span', {}, 'Genre'), genreSel),
          h('label', { class: 'toggle' }, unwatched, h('span', {}, 'Unwatched only')),
        ),
      ),
      grid,
      sentinel,
    ),
  );

  plex
    .genres(sec.key)
    .then((gs) => {
      for (const g of gs) genreSel.append(h('option', { value: g.key, selected: g.key === opts.genre }, g.title));
    })
    .catch(() => {});

  let loaded = 0;
  let total = Infinity;
  let busy = false;
  let generation = 0;

  async function more() {
    if (busy || loaded >= total) return;
    busy = true;
    const gen = generation;
    const query = { sort: opts.sort, type: sec.type === 'show' ? 2 : 1 };
    if (opts.unwatched) query.unwatched = 1;
    if (opts.genre) query.genre = opts.genre;
    try {
      const { items, total: t } = await plex.list(sec.key, query, loaded, PAGE);
      if (gen !== generation) return;
      total = t;
      loaded += items.length;
      if (!items.length) total = loaded;
      grid.append(...items.map(posterCard));
      count.textContent = `${total} ${sec.type === 'show' ? 'shows' : 'movies'}`;
      if (!total) grid.replaceChildren(h('p', { class: 'muted' }, 'No titles match these filters.'));
    } catch (e) {
      grid.append(h('p', { class: 'muted' }, `More titles could not load: ${e.message}`));
      total = loaded;
    } finally {
      if (gen === generation) busy = false;
    }
    // Keep filling while the sentinel is still near the screen.
    if (gen === generation && loaded < total && sentinel.getBoundingClientRect().top < innerHeight + 800) more();
  }

  function reset() {
    generation += 1;
    loaded = 0;
    total = Infinity;
    busy = false;
    grid.replaceChildren();
    count.textContent = '';
    const q = new URLSearchParams();
    if (opts.sort !== 'titleSort') q.set('sort', opts.sort);
    if (opts.unwatched) q.set('unwatched', '1');
    if (opts.genre) q.set('genre', opts.genre);
    const qs = q.toString();
    history.replaceState(null, '', `#/library/${sec.key}${qs ? `?${qs}` : ''}`);
    more();
  }

  sortSel.onchange = () => {
    opts.sort = sortSel.value;
    reset();
  };
  genreSel.onchange = () => {
    opts.genre = genreSel.value;
    reset();
  };
  unwatched.onchange = () => {
    opts.unwatched = unwatched.checked;
    reset();
  };

  const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: '800px 0px' });
  io.observe(sentinel);
  more();
  return () => io.disconnect();
}
