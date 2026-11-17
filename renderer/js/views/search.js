// Search results for movies, shows, and episodes.
import { h } from '../util.js';
import { state } from '../app.js';
import { posterCard, landscapeCard } from '../components.js';

export async function renderSearch(main, { params }) {
  const q = (params.get('q') || '').trim();
  const input = document.querySelector('.search input');
  if (input && input.value !== q) input.value = q;
  const page = h('div', { class: 'page' }, h('header', { class: 'page-head' }, h('h1', {}, q ? `Results for \u201c${q}\u201d` : 'Search')));
  main.append(page);
  if (!q) {
    page.append(h('p', { class: 'muted' }, 'Type a title in the search box, then press Enter.'));
    return;
  }
  const status = h('p', { class: 'muted' }, 'Searching');
  page.append(status);
  const hubs = await state.plex.search(q);
  status.remove();
  if (!hubs.length) {
    page.append(h('div', { class: 'notice glass' }, h('p', {}, `Nothing in your libraries matches \u201c${q}.\u201d`)));
    return;
  }
  const names = { movie: 'Movies', show: 'Shows', episode: 'Episodes' };
  for (const hub of hubs) {
    const wide = hub.type === 'episode';
    page.append(
      h(
        'section',
        { class: 'result-group' },
        h('h2', {}, names[hub.type] || hub.title),
        h('div', { class: wide ? 'grid wide' : 'grid' }, hub.Metadata.map((m) => (wide ? landscapeCard(m) : posterCard(m)))),
      ),
    );
  }
}
