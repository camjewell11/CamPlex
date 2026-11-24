// Pop-up menus, dialogs, and short notices, plus the actions that card menus and the detail page
// share: mark watched, remove from Continue watching, add to a playlist, and the server tools.
import { h, svg } from './util.js';
import { state } from './app.js';

// ---------- notices ----------
let toastEl = null;
let toastTimer = null;
export function toast(text, { error = false } = {}) {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast glass', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.toggle('error', error);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), error ? 6000 : 3000);
}

// Runs an action and reports the result. Returns true when it worked.
async function attempt(done, fn) {
  try {
    await fn();
    if (done) toast(done);
    return true;
  } catch (e) {
    console.error(e);
    toast(`That didn't work: ${e.message}`, { error: true });
    return false;
  }
}

// ---------- menus ----------
let openMenu = null;
export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.cleanup();
  m.el.remove();
  m.returnFocus?.focus?.({ preventScroll: true });
}

// at: a pointer event (opens at the pointer) or an element (opens under it).
// items: { label, icon, run, disabled, checked } objects, '-' for a divider, or null.
export function showMenu(at, items, { label = 'Actions' } = {}) {
  closeMenu();
  const list = items.filter(Boolean);
  const el = h(
    'div',
    { class: 'menu glass', role: 'menu', 'aria-label': label },
    list.map((it) =>
      it === '-'
        ? h('hr')
        : h(
            'button',
            {
              role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
              'aria-checked': it.checked === undefined ? null : String(it.checked),
              disabled: !!it.disabled,
              onclick: async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const keep = it.keepOpen;
                if (!keep) closeMenu();
                await it.run?.(e);
              },
            },
            it.icon ? svg(it.icon, 16) : h('span', { class: 'icon' }),
            h('span', {}, it.label),
            it.checked ? svg('check', 14) : null,
          ),
    ),
  );
  document.body.append(el);
  const r = el.getBoundingClientRect();
  let x;
  let y;
  if (at instanceof Element) {
    const a = at.getBoundingClientRect();
    x = a.right - r.width;
    y = a.bottom + 6;
    if (y + r.height > innerHeight - 8) y = a.top - r.height - 6;
  } else {
    x = at.clientX;
    y = at.clientY;
    if (y + r.height > innerHeight - 8) y = at.clientY - r.height;
  }
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;

  const buttons = () => [...el.querySelectorAll('button:not([disabled])')];
  const onDown = (e) => {
    if (!el.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    const bs = buttons();
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus();
    } else if (e.key === 'Tab') closeMenu();
  };
  const onScroll = (e) => {
    if (!el.contains(e.target)) closeMenu();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('hashchange', closeMenu);
  openMenu = {
    el,
    returnFocus: at instanceof Element ? at : null,
    cleanup() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('hashchange', closeMenu);
    },
  };
  buttons()[0]?.focus({ preventScroll: true });
  return el;
}

// ---------- dialogs ----------
// body: nodes. actions: [{ label, primary, run }]; run returns false to keep the dialog open.
export function dialog(title, body, actions = [{ label: 'Close' }]) {
  const prev = document.activeElement;
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    prev?.focus?.({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const box = h(
    'div',
    { class: 'dialog glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'dialog-head' }, h('h2', {}, title), h('button', { class: 'ctl', 'aria-label': 'Close', onclick: close }, svg('close', 18))),
    h('div', { class: 'dialog-body' }, body),
    actions.length
      ? h(
          'div',
          { class: 'dialog-actions' },
          actions.map((a) =>
            h(
              'button',
              {
                class: `button ${a.primary ? 'primary' : 'glass'}`,
                onclick: async (e) => {
                  // currentTarget is null once the handler awaits, so keep the button.
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  const keep = a.run ? (await a.run()) === false : false;
                  btn.disabled = false;
                  if (!keep) close();
                },
              },
              a.label,
            ),
          ),
        )
      : null,
  );
  const back = h('div', { class: 'dialog-back', onpointerdown: (e) => e.target === back && close() }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  (box.querySelector('input, textarea, select') || box.querySelector('.dialog-actions button, .dialog-head button'))?.focus();
  return { close, box };
}

// ---------- shared title actions ----------
const isWatched = (item) => (item.type === 'show' || item.type === 'season' ? item.leafCount > 0 && item.viewedLeafCount === item.leafCount : !!item.viewCount && !item.viewOffset);
const watchable = (item) => ['movie', 'episode', 'show', 'season'].includes(item.type);

export function watchedItem(item, onChange) {
  if (!watchable(item)) return null;
  const watched = isWatched(item);
  const noun = item.type === 'show' ? 'show' : item.type === 'season' ? 'season' : '';
  return {
    label: watched ? `Mark${noun ? ` ${noun}` : ''} unwatched` : `Mark${noun ? ` ${noun}` : ''} watched`,
    icon: 'check',
    run: async () => {
      if (await attempt(watched ? 'Marked unwatched' : 'Marked watched', () => state.plex.markWatched(item.ratingKey, !watched))) onChange?.('watched');
    },
  };
}

export function continueItem(item, onChange) {
  return {
    label: 'Remove from Continue watching',
    icon: 'close',
    run: async () => {
      if (await attempt('Removed from Continue watching', () => state.plex.removeFromContinueWatching(item.ratingKey))) onChange?.('removed');
    },
  };
}

export function playlistItem(item) {
  if (!['movie', 'episode', 'show', 'season', 'clip'].includes(item.type)) return null;
  return {
    label: 'Add to playlist',
    icon: 'playlist',
    run: async (e) => {
      // A keyboard choice has no pointer position, so the submenu opens near the middle.
      const at = e?.clientX || e?.clientY ? { clientX: e.clientX, clientY: e.clientY } : { clientX: innerWidth / 2 - 120, clientY: innerHeight / 3 };
      let lists = [];
      try {
        lists = (await state.plex.playlists()).filter((p) => !p.smart);
      } catch (err) {
        return toast(`Plex didn't list the playlists: ${err.message}`, { error: true });
      }
      showMenu(
        at,
        [
          ...lists.map((p) => ({
            label: p.title,
            icon: 'playlist',
            run: async () => {
              let added = 1;
              // Plex skips a title that the playlist already holds and reports leafCountAdded 0.
              if (await attempt(null, async () => (added = (await state.plex.addToPlaylist(p.ratingKey, item.ratingKey)).leafCountAdded ?? 1))) toast(added ? `Added to ${p.title}` : `Already in ${p.title}`);
            },
          })),
          lists.length ? '-' : null,
          { label: 'New playlist', icon: 'plus', run: () => newPlaylist(item) },
        ],
        { label: 'Add to playlist' },
      );
    },
  };
}

function newPlaylist(item) {
  const name = h('input', { type: 'text', value: item.type === 'episode' ? item.grandparentTitle : item.title, 'aria-label': 'Playlist name' });
  dialog('New playlist', [h('label', { class: 'field' }, h('span', {}, 'Name'), name)], [
    { label: 'Cancel' },
    {
      label: 'Create',
      primary: true,
      run: async () => {
        const title = name.value.trim();
        if (!title) return false;
        return attempt(`Created ${title}`, () => state.plex.createPlaylist(title, item.ratingKey));
      },
    },
  ]);
  name.select();
}

// Server tools: refresh, analyze, fix match, and edit details.
export function serverItems(item, onChange) {
  const { plex } = state;
  const canMatch = item.type === 'movie' || item.type === 'show';
  return [
    { label: 'Refresh metadata', icon: 'refresh', run: () => attempt('Plex is refreshing the metadata', () => plex.refreshMetadata(item.ratingKey)) },
    ['movie', 'episode', 'show', 'season'].includes(item.type) ? { label: 'Analyze', icon: 'info', run: () => attempt('Plex is analyzing the files', () => plex.analyze(item.ratingKey)) } : null,
    canMatch ? { label: 'Fix match', icon: 'search', run: () => fixMatch(item, onChange) } : null,
    item.librarySectionID ? { label: 'Edit details', icon: 'edit', run: () => editDetails(item, onChange) } : null,
  ];
}

function fixMatch(item, onChange) {
  const { plex } = state;
  const title = h('input', { type: 'text', value: item.title, 'aria-label': 'Title' });
  const year = h('input', { type: 'number', value: item.year || '', 'aria-label': 'Year', min: 1880, max: 2100 });
  const results = h('div', { class: 'match-results' });
  const search = async () => {
    results.replaceChildren(h('p', { class: 'muted' }, 'Searching'));
    try {
      const list = await plex.matches(item.ratingKey, { title: title.value.trim(), year: year.value });
      if (!list.length) return results.replaceChildren(h('p', { class: 'muted' }, 'No matches. Change the title or the year, then search again.'));
      results.replaceChildren(
        ...list.slice(0, 12).map((r) =>
          h(
            'button',
            {
              class: `match${r.guid === item.guid ? ' current' : ''}`,
              onclick: async () => {
                if (await attempt(`Matched to ${r.name}${r.year ? ` (${r.year})` : ''}. Plex is updating the details.`, () => plex.applyMatch(item.ratingKey, r))) {
                  d.close();
                  onChange?.('matched');
                }
              },
            },
            r.thumb ? h('img', { src: r.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'noart' }),
            h('span', { class: 'match-text' }, h('strong', {}, r.name, r.year ? ` (${r.year})` : ''), r.guid === item.guid ? h('small', {}, 'Current match') : null, r.summary ? h('small', {}, r.summary) : null),
          ),
        ),
      );
    } catch (e) {
      results.replaceChildren(h('p', {}, `The search failed: ${e.message}`));
    }
  };
  const go = h('button', { class: 'button glass', onclick: search }, svg('search', 16), 'Search');
  for (const el of [title, year]) el.addEventListener('keydown', (e) => e.key === 'Enter' && search());
  const d = dialog('Fix match', [h('div', { class: 'match-form' }, h('label', { class: 'field grow' }, h('span', {}, 'Title'), title), h('label', { class: 'field year' }, h('span', {}, 'Year'), year), go), results], []);
  d.box.classList.add('wide');
  search();
}

function editDetails(item, onChange) {
  const { plex } = state;
  const fields = [
    ['title', 'Title', 'text'],
    ['titleSort', 'Sort title', 'text'],
    item.type === 'movie' || item.type === 'show' ? ['originalTitle', 'Original title', 'text'] : null,
    item.type !== 'season' ? ['originallyAvailableAt', item.type === 'movie' ? 'Release date' : 'Air date', 'date'] : null,
    item.type === 'movie' || item.type === 'show' ? ['contentRating', 'Content rating', 'text'] : null,
    item.type === 'movie' || item.type === 'show' ? ['studio', item.type === 'show' ? 'Network' : 'Studio', 'text'] : null,
    item.type === 'movie' ? ['tagline', 'Tagline', 'text'] : null,
    ['summary', 'Summary', 'textarea'],
  ].filter(Boolean);
  const inputs = {};
  const body = fields.map(([k, label, type]) => {
    const value = item[k] ?? '';
    inputs[k] = type === 'textarea' ? h('textarea', { rows: 6, 'aria-label': label }, value) : h('input', { type, value, 'aria-label': label });
    return h('label', { class: 'field' }, h('span', {}, label), inputs[k]);
  });
  body.push(h('p', { class: 'muted small' }, 'Plex locks each field you change, so a metadata refresh keeps your edit.'));
  const d = dialog('Edit details', body, [
    { label: 'Cancel' },
    {
      label: 'Save',
      primary: true,
      run: async () => {
        const changed = {};
        for (const [k] of fields) if (inputs[k].value !== String(item[k] ?? '')) changed[k] = inputs[k].value;
        if (!Object.keys(changed).length) return true;
        const ok = await attempt('Saved', () => plex.editFields(item, changed));
        if (ok) onChange?.('edited');
        return ok;
      },
    },
  ]);
  d.box.classList.add('wide');
}

// ---------- star rating ----------
// Five stars in half steps (Plex stores 0 to 10). Selecting the current rating clears it.
export function starRating(item) {
  const { plex } = state;
  let value = item.userRating || 0;
  const wrap = h('div', { class: 'stars', role: 'radiogroup', 'aria-label': 'Your rating' });
  const draw = (v) =>
    wrap.querySelectorAll('.star').forEach((s, i) => {
      const fill = Math.max(0, Math.min(2, v - i * 2));
      s.dataset.fill = fill === 2 ? 'full' : fill === 1 ? 'half' : 'none';
    });
  const set = async (v) => {
    const next = v === value ? 0 : v;
    const before = value;
    value = next;
    draw(value);
    wrap.title = value ? `Your rating: ${value / 2} of 5` : 'Not rated';
    try {
      await plex.rate(item.ratingKey, value || null);
      item.userRating = value || undefined;
    } catch (e) {
      value = before;
      draw(value);
      toast(`Plex didn't save the rating: ${e.message}`, { error: true });
    }
  };
  for (let i = 0; i < 5; i++) {
    // A dim star with a gold copy over it, clipped to the filled share.
    const star = h('span', { class: 'star' }, svg('star', 22), h('span', { class: 'star-fill' }, svg('star', 22)));
    // Each star has two halves: the left half sets a half star.
    const half = h('button', { class: 'half', 'aria-label': `${i + 0.5} stars`, onclick: () => set(i * 2 + 1), onmouseenter: () => draw(i * 2 + 1) });
    const full = h('button', { class: 'whole', 'aria-label': `${i + 1} star${i ? 's' : ''}`, onclick: () => set(i * 2 + 2), onmouseenter: () => draw(i * 2 + 2) });
    star.append(half, full);
    wrap.append(star);
  }
  wrap.addEventListener('mouseleave', () => draw(value));
  wrap.title = value ? `Your rating: ${value / 2} of 5` : 'Not rated';
  draw(value);
  return wrap;
}
