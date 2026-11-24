// Collections and playlists: a list of playlists, and one page for a collection or a playlist
// with Play and Shuffle (both start a Plex play queue).
import { h, svg, duration } from '../util.js';
import { state } from '../app.js';
import { posterCard } from '../components.js';
import { setAmbient } from '../ambient.js';
import { startQueue } from '../actions.js';
import { dialog, toast } from '../menu.js';

const PAGE = 72;

export async function renderPlaylists(main) {
  const { plex } = state;
  setAmbient(null);
  const lists = await plex.playlists();
  main.append(
    h(
      'div',
      { class: 'page library' },
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Playlists'), h('span', { class: 'muted count' }, `${lists.length} video playlist${lists.length === 1 ? '' : 's'}`))),
      lists.length
        ? h('div', { class: 'grid' }, lists.map(posterCard))
        : h('p', { class: 'muted' }, 'You have no video playlists. To make one, open a title\'s More menu and select Add to playlist.'),
    ),
  );
}

// kind: 'collection' or 'playlist'.
export function collectionView(kind) {
  return (main, ctx) => renderCollection(main, ctx, kind);
}

async function renderCollection(main, { id }, kind) {
  const { plex } = state;
  setAmbient(null);
  const isPlaylist = kind === 'playlist';
  const info = isPlaylist ? (await plex.get(`/playlists/${id}`)).Metadata?.[0] : await plex.metadata(id);
  if (!info) throw new Error(`Plex has no ${kind} with this ID. It might have been deleted.`);
  const path = isPlaylist ? `/playlists/${id}/items` : `/library/collections/${id}/children`;
  const queue = (shuffle) => () =>
    startQueue(isPlaylist ? { playlistID: id, shuffle } : { key: path, shuffle }).catch((e) => toast(`Plex didn't start the play queue: ${e.message}`, { error: true }));

  const count = h('span', { class: 'muted count' });
  const grid = h('div', { class: 'grid' });
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
  const facts = [isPlaylist && info.smart ? 'Smart playlist' : null, !isPlaylist && info.smart === '1' ? 'Smart collection' : null, info.duration ? duration(info.duration) : null].filter(Boolean);
  main.append(
    h(
      'div',
      { class: 'page library collection' },
      h(
        'header',
        { class: 'page-head' },
        h(
          'div',
          { class: 'collection-head' },
          h('span', { class: 'muted small' }, isPlaylist ? 'Playlist' : 'Collection'),
          h('h1', {}, info.title),
          count,
          facts.length ? h('span', { class: 'muted small' }, facts.join(', ')) : null,
          info.summary ? h('p', { class: 'collection-summary' }, info.summary) : null,
        ),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'button primary', onclick: queue(false) }, svg('play', 16), 'Play'),
          h('button', { class: 'button glass', onclick: queue(true) }, svg('shuffle', 16), 'Shuffle'),
          isPlaylist && !info.smart ? h('button', { class: 'button glass', onclick: () => deletePlaylist(info) }, 'Delete playlist') : null,
        ),
      ),
      grid,
      sentinel,
    ),
  );

  let loaded = 0;
  let total = Infinity;
  let busy = false;
  async function more() {
    if (busy || loaded >= total) return;
    busy = true;
    try {
      const c = await plex.get(path, { 'X-Plex-Container-Start': loaded, 'X-Plex-Container-Size': PAGE });
      const items = c.Metadata || [];
      total = c.totalSize ?? c.leafCount ?? c.size ?? 0;
      loaded += items.length;
      if (!items.length) total = loaded;
      grid.append(...items.map(posterCard));
      count.textContent = `${total} ${total === 1 ? 'title' : 'titles'}`;
      if (!total) grid.replaceChildren(h('p', { class: 'muted' }, `This ${kind} is empty.`));
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

function deletePlaylist(info) {
  dialog(
    'Delete playlist',
    [h('p', {}, `Delete the playlist "${info.title}"? The titles in it stay in your library.`)],
    [
      { label: 'Cancel' },
      {
        label: 'Delete',
        primary: true,
        run: async () => {
          try {
            await state.plex.del(`/playlists/${info.ratingKey}`);
            toast(`Deleted ${info.title}`);
            location.replace('#/playlists');
          } catch (e) {
            toast(`Plex didn't delete the playlist: ${e.message}`, { error: true });
            return false;
          }
        },
      },
    ],
  );
}
