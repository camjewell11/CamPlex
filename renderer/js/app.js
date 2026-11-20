// App shell: sign-in gate, navigation, routing, and preferences.
import { Plex } from './plex.js';
import { h, svg } from './util.js';
import { setAmbient } from './ambient.js';
import { renderSignIn } from './views/signin.js';
import { renderHome } from './views/home.js';
import { renderLibrary } from './views/library.js';
import { renderDetail } from './views/detail.js';
import { renderPlayer } from './views/player.js';
import { renderSettings } from './views/settings.js';
import { renderSearch } from './views/search.js';
import * as pip from './pip.js';

export const state = { plex: null, sections: [], prefs: null, server: null };

export async function savePrefs() {
  await window.marquee.settings.set(state.prefs);
}

// Genres for the featured carousel on Home. A title must have at least one genre from include and
// none from exclude. These are Plex genre names, so one list works for every library. alwaysShow
// holds ratingKeys of shows the user features whatever their genres. rev counts the changes to
// these defaults that upgradeFeatured() applies to saved settings.
export const DEFAULT_FEATURED = {
  rev: 2,
  include: ['Action', 'Action/Adventure', 'Adventure', 'Crime', 'Drama', 'Fantasy', 'Mystery', 'Sci-Fi & Fantasy', 'Science Fiction', 'Suspense', 'Thriller', 'War', 'War & Politics', 'Western'],
  exclude: ['Children', 'Family', 'Food', 'Game Show', 'Home and Garden', 'Horror', 'Kids', 'Musical', 'Reality', 'Romance', 'Soap', 'Talk', 'Talk Show', 'Travel'],
  alwaysShow: [],
};

// Brings featured settings saved by an older version up to date. Each step changes only the genres
// that the matching change to the defaults touched, so the user's own edits stay.
function upgradeFeatured(f) {
  const move = (name, to) => {
    const from = to === 'include' ? 'exclude' : 'include';
    f[from] = f[from].filter((n) => n !== name);
    if (!f[to].includes(name)) f[to] = [...f[to], name].sort();
  };
  let changed = false;
  if ((f.rev || 1) < 2) {
    f.exclude = f.exclude.filter((n) => n !== 'Documentary');
    move('Fantasy', 'include');
    move('Horror', 'exclude');
    f.alwaysShow ||= [];
    f.rev = 2;
    changed = true;
  }
  return changed;
}

export function defaultPrefs(sections, hubs) {
  const rows = [{ id: 'continue', type: 'continue', title: 'Continue watching', visible: true }];
  for (const s of sections) {
    rows.push({
      id: `recent-${s.key}`,
      type: 'filter',
      title: s.type === 'show' ? `New episodes in ${s.title}` : `Recently added to ${s.title}`,
      section: s.key,
      sort: s.type === 'show' ? 'episode.addedAt:desc' : 'addedAt:desc',
      unwatched: false,
      visible: true,
    });
  }
  for (const hub of hubs.filter((x) => x.context === 'hub.custom.collection')) {
    const sec = sections.find((s) => hub.hubIdentifier?.startsWith(`custom.collection.${s.key}.`));
    rows.push({ id: `hub-${hub.hubIdentifier}`, type: 'hub', title: sec ? `${hub.title} in ${sec.title}` : hub.title, key: hub.key, visible: true });
  }
  const movies = sections.find((s) => s.type === 'movie');
  if (movies) {
    rows.push({ id: 'custom-toprated', type: 'filter', title: 'Highly rated, not yet watched', section: movies.key, sort: 'audienceRating:desc', unwatched: true, visible: true });
    rows.push({ id: 'custom-random', type: 'filter', title: 'Something different tonight', section: movies.key, sort: 'random', unwatched: true, visible: true });
  }
  return { themeMusic: true, autoplayNext: true, fullscreenPlayer: false, ambientOnHover: true, quality: 'original', featured: structuredClone(DEFAULT_FEATURED), rows };
}

const ROUTES = [
  [/^#\/home$/, () => renderHome],
  [/^#\/library\/(\w+)$/, () => renderLibrary],
  [/^#\/item\/(\w+)$/, () => renderDetail],
  [/^#\/play\/(\w+)$/, () => renderPlayer],
  [/^#\/settings$/, () => renderSettings],
  [/^#\/search$/, () => renderSearch],
];

let cleanup = null;
let navEl, mainEl;

// ---------- background player ----------
// A player in picture-in-picture keeps playing when the user goes to another page. The router
// moves its elements into a hidden host (a <video> removed from the page would pause) and keeps
// its cleanup here until the user returns to it, closes the PiP window, or plays something else.
let parked = null;
let bgHost = null;
const host = () => {
  if (!bgHost) {
    bgHost = h('div', { class: 'bg-player', 'aria-hidden': 'true' });
    document.body.append(bgHost);
  }
  return bgHost;
};
// moveBefore keeps a playing video's state; append is the fallback for older Chromium.
const moveInto = (parent, el) => (parent.moveBefore ? parent.moveBefore(el, null) : parent.append(el));
function runCleanup(c) {
  try {
    c();
  } catch (e) {
    console.error(e);
  }
}

export function endBackground() {
  const c = parked;
  parked = null;
  if (!c) return;
  runCleanup(c);
  c.root.remove();
}

// Plays the next episode in the PiP window while the user stays on another page.
export async function playInBackground(id) {
  pip.hold();
  endBackground();
  try {
    const c = await renderPlayer(host(), { id, params: new URLSearchParams('pip=1&bg=1') });
    if (!c.keepAlive()) {
      runCleanup(c);
      c.root.remove();
      pip.close();
      return;
    }
    c.park(true);
    parked = c;
  } catch (e) {
    console.error(e);
    pip.close();
  }
}

async function route() {
  const [hashPath, query = ''] = (location.hash || '#/home').split('?');
  const params = new URLSearchParams(query);
  const match = ROUTES.find(([re]) => re.test(hashPath));
  const id = match ? hashPath.match(match[0])[1] : null;
  const isPlayer = !!match && hashPath.startsWith('#/play');
  if (cleanup) {
    const c = cleanup;
    cleanup = null;
    if (c.keepAlive?.() && !isPlayer) {
      endBackground();
      c.park(true);
      moveInto(host(), c.root);
      parked = c;
    } else runCleanup(c);
  }
  if (!match) {
    location.hash = '#/home';
    return;
  }
  document.body.classList.toggle('playing', isPlayer);
  updateNav(hashPath);
  if (isPlayer && parked) {
    if (parked.ratingKey === id) {
      // Back to the player that's running in picture-in-picture.
      mainEl.replaceChildren();
      moveInto(mainEl, parked.root);
      cleanup = parked;
      parked = null;
      cleanup.park(false);
      return;
    }
    if (params.get('pip')) pip.hold();
    endBackground();
  }
  mainEl.replaceChildren();
  mainEl.scrollTop = 0;
  window.scrollTo(0, 0);
  const view = match[1]();
  try {
    cleanup = (await view(mainEl, { id, params })) || null;
  } catch (e) {
    console.error(e);
    mainEl.replaceChildren(errorPanel(e));
  }
}

export function errorPanel(e) {
  return h(
    'div',
    { class: 'notice glass' },
    h('h2', {}, 'This page could not load'),
    h('p', {}, e.message || String(e)),
    h('p', { class: 'muted' }, 'Check that Plex Media Server is running, then reload with Ctrl+R.'),
  );
}

function buildNav() {
  const links = state.sections.map((s) => h('a', { href: `#/library/${s.key}`, 'data-route': `#/library/${s.key}` }, s.title));
  const input = h('input', { type: 'search', placeholder: 'Search movies and shows', 'aria-label': 'Search' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) location.hash = `#/search?q=${encodeURIComponent(input.value.trim())}`;
  });
  navEl = h(
    'nav',
    { class: 'topnav' },
    h(
      'div',
      { class: 'navbar glass' },
      h('a', { class: 'wordmark', href: '#/home' }, 'Marquee'),
      h('a', { href: '#/home', 'data-route': '#/home' }, 'Home'),
      links,
      h('label', { class: 'search' }, svg('search', 16), input),
      h('a', { class: 'iconlink', href: '#/settings', 'data-route': '#/settings', 'aria-label': 'Settings', title: 'Settings' }, svg('settings', 18)),
    ),
  );
  return navEl;
}
function updateNav(hashPath) {
  navEl?.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === hashPath));
}

async function boot() {
  setAmbient(null);
  const app = document.getElementById('app');
  const status = await window.marquee.auth.status();
  if (!status.signedIn) {
    renderSignIn(app, () => location.reload());
    return;
  }
  state.server = status.server;
  state.plex = new Plex({ uri: status.server.uri, token: status.token, clientId: status.clientId, version: status.version });
  try {
    state.sections = await state.plex.sections();
  } catch (e) {
    app.replaceChildren(h('main', { class: 'main' }, errorPanel(e)));
    return;
  }
  state.prefs = await window.marquee.settings.get();
  if (!state.prefs) {
    const hubs = await state.plex.hubs().catch(() => []);
    state.prefs = defaultPrefs(state.sections, hubs);
    await savePrefs();
  } else {
    // Rows generated before library names were cleaned up still carry the "V3" suffix.
    for (const r of state.prefs.rows || []) {
      if (!r.id.startsWith('custom-')) r.title = r.title.replace(/\s+V\d+\b/g, '');
    }
    // Settings saved before the featured genre filter existed.
    if (!state.prefs.featured) {
      state.prefs.featured = structuredClone(DEFAULT_FEATURED);
      await savePrefs();
    } else if (upgradeFeatured(state.prefs.featured)) {
      await savePrefs();
    }
  }
  mainEl = h('main', { class: 'main', id: 'main' });
  app.replaceChildren(buildNav(), mainEl);
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/home';
  else route();
}

boot();
