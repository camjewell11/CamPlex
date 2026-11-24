// The plex.tv watchlist, catalog (Discover) title pages, and the watchlist button for title pages.
// Catalog titles that the server has open the library page instead.
import { h, svg, duration } from '../util.js';
import { state } from '../app.js';
import { posterCard } from '../components.js';
import { setAmbient } from '../ambient.js';
import { toast } from '../menu.js';
import { discoverKey } from '../plex.js';

const PAGE = 60;

export async function renderWatchlist(main) {
  const { plex } = state;
  setAmbient(null);
  const count = h('span', { class: 'muted count' }, 'Loading');
  const grid = h('div', { class: 'grid' });
  main.append(
    h(
      'div',
      { class: 'page library' },
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Watchlist'), count)),
      grid,
    ),
  );
  const items = [];
  for (let start = 0; ; start += PAGE) {
    const { items: got, total } = await plex.watchlist(start, PAGE);
    items.push(...got);
    grid.append(...got.map(posterCard));
    count.textContent = `${total} title${total === 1 ? '' : 's'}`;
    if (!got.length || items.length >= total) break;
  }
  if (!items.length) grid.replaceWith(h('p', { class: 'muted' }, 'Your watchlist is empty. To add a title, open it and select Add to watchlist.'));
}

// #/discover/<catalog key>: the library page when the server has the title, otherwise a catalog page.
export async function renderDiscover(main, { id }) {
  const { plex } = state;
  const item = await plex.discoverItem(id);
  if (!item) throw new Error('Plex has no catalog title with this ID.');
  const local = await plex.localByGuid(item.guid).catch(() => null);
  if (local) {
    location.replace(`#/item/${local.ratingKey}`);
    return;
  }
  setAmbient(null);
  const facts = [item.year, item.contentRating, item.type === 'movie' && item.duration ? duration(item.duration) : null, item.type === 'show' ? 'Show' : null].filter(Boolean);
  const genres = (item.Genre || []).slice(0, 4).map((g) => g.tag).join(', ');
  const dirs = (item.Director || []).map((d) => d.tag);
  const cast = (item.Role || []).slice(0, 6).map((r) => r.tag);
  main.append(
    h(
      'div',
      { class: 'detail' },
      h('div', { class: 'detail-backdrop' }, item.art ? h('img', { src: plex.img(item.art, 1920, 1080), alt: '' }) : null),
      h(
        'section',
        { class: 'detail-top discover-top' },
        h(
          'div',
          { class: 'plate glass' },
          h('span', { class: 'kicker' }, 'Not in your libraries'),
          h('h1', { class: 'title' }, item.title),
          item.tagline ? h('p', { class: 'tagline' }, item.tagline) : null,
          h('div', { class: 'facts' }, facts.map((f) => h('span', {}, String(f))), genres ? h('span', {}, genres) : null),
          item.summary ? h('p', { class: 'summary full' }, item.summary) : null,
          h('div', { class: 'actions' }, watchlistButton(item, id)),
          dirs.length ? h('div', { class: 'people' }, h('p', {}, h('span', { class: 'muted' }, dirs.length > 1 ? 'Directors ' : 'Director '), dirs.slice(0, 3).join(', '))) : null,
          cast.length ? h('div', { class: 'people' }, h('p', {}, h('span', { class: 'muted' }, 'Starring '), cast.join(', '))) : null,
        ),
        item.thumb ? h('img', { class: 'discover-poster', src: plex.img(item.thumb, 400, 600), alt: '' }) : null,
      ),
    ),
  );
}

// Add to watchlist, or On watchlist (select to remove). `key` is the catalog key; for a library
// title it comes from the plex:// guid. Returns null for titles that Plex's catalog doesn't know.
export function watchlistButton(item, key = discoverKey(item)) {
  if (!key || (item.type !== 'movie' && item.type !== 'show')) return null;
  const { plex } = state;
  const btn = h('button', { class: 'button glass', 'aria-pressed': 'false', disabled: true }, svg('bookmark', 16), 'Watchlist');
  const show = (on) => {
    btn.setAttribute('aria-pressed', String(on));
    btn.lastChild.textContent = on ? 'On watchlist' : 'Add to watchlist';
    btn.title = on ? 'Remove from your Plex watchlist' : 'Add to your Plex watchlist';
  };
  plex
    .onWatchlist(key)
    .then((on) => {
      show(on);
      btn.disabled = false;
    })
    .catch(() => btn.remove());
  btn.addEventListener('click', async () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.disabled = true;
    try {
      await plex.setWatchlist(key, on);
      show(on);
      toast(on ? `Added ${item.title} to your watchlist` : `Removed ${item.title} from your watchlist`);
    } catch (e) {
      toast(`Plex didn't change the watchlist: ${e.message}`, { error: true });
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
