// Settings: server, playback, look, and the Home rows editor.
import { h, svg } from '../util.js';
import { state, savePrefs, defaultPrefs } from '../app.js';
import { QUALITY } from '../plex.js';
import { setAmbient } from '../ambient.js';
import { SORTS } from './library.js';

export async function renderSettings(main) {
  const { prefs, server, sections, plex } = state;
  setAmbient(null);

  const toggle = (key, label, help) => {
    const input = h('input', { type: 'checkbox', checked: !!prefs[key] });
    input.addEventListener('change', () => {
      prefs[key] = input.checked;
      savePrefs();
    });
    return h('label', { class: 'setting' }, input, h('span', {}, h('strong', {}, label), h('small', {}, help)));
  };

  const quality = h('select', { 'aria-label': 'Default quality' }, Object.entries(QUALITY).map(([k, q]) => h('option', { value: k, selected: prefs.quality === k }, q.label)));
  quality.addEventListener('change', () => {
    prefs.quality = quality.value;
    savePrefs();
  });

  const signOut = h('button', { class: 'button glass' }, 'Sign out');
  signOut.addEventListener('click', async () => {
    await window.marquee.auth.signOut();
    location.hash = '';
    location.reload();
  });

  const rowsList = h('ol', { class: 'row-editor' });
  function drawRows(focusIndex, focusDir) {
    rowsList.replaceChildren(
      ...prefs.rows.map((r, i) => {
        const vis = h('input', { type: 'checkbox', checked: r.visible, 'aria-label': `Show ${r.title}` });
        vis.addEventListener('change', () => {
          r.visible = vis.checked;
          vis.closest('li').classList.toggle('off', !r.visible);
          savePrefs();
        });
        const move = (d) => {
          const j = i + d;
          if (j < 0 || j >= prefs.rows.length) return;
          [prefs.rows[i], prefs.rows[j]] = [prefs.rows[j], prefs.rows[i]];
          savePrefs();
          drawRows(j, d < 0 ? 'up' : 'down');
        };
        const remove = () => {
          prefs.rows.splice(i, 1);
          savePrefs();
          drawRows();
        };
        return h(
          'li',
          { class: r.visible ? '' : 'off' },
          h('label', { class: 'row-name' }, vis, h('span', {}, h('strong', {}, r.title), h('small', {}, describeRow(r)))),
          h('button', { class: 'ctl', 'data-dir': 'up', 'aria-label': `Move ${r.title} up`, disabled: i === 0, onclick: () => move(-1) }, svg('up', 18)),
          h('button', { class: 'ctl', 'data-dir': 'down', 'aria-label': `Move ${r.title} down`, disabled: i === prefs.rows.length - 1, onclick: () => move(1) }, svg('down', 18)),
          r.id.startsWith('custom-') ? h('button', { class: 'ctl', 'aria-label': `Delete ${r.title}`, onclick: remove }, svg('trash', 18)) : h('span', { class: 'ctl-gap' }),
        );
      }),
    );
    if (focusIndex !== undefined) rowsList.children[focusIndex]?.querySelector(`[data-dir="${focusDir}"]:not([disabled])`)?.focus();
  }
  drawRows();

  const restore = h('button', { class: 'button glass' }, 'Restore default rows');
  restore.addEventListener('click', async () => {
    const hubs = await plex.hubs().catch(() => []);
    prefs.rows = defaultPrefs(sections, hubs).rows;
    await savePrefs();
    drawRows();
  });

  main.append(
    h(
      'div',
      { class: 'page settings' },
      h('header', { class: 'page-head' }, h('h1', {}, 'Settings')),
      h(
        'div',
        { class: 'settings-grid' },
        h(
          'section',
          { class: 'panel glass' },
          h('h2', {}, 'Server'),
          h('dl', { class: 'specs' }, h('dt', {}, 'Name'), h('dd', {}, server.name), h('dt', {}, 'Address'), h('dd', {}, server.uri)),
          h('div', { class: 'actions' }, signOut),
        ),
        h(
          'section',
          { class: 'panel glass' },
          h('h2', {}, 'Playback'),
          h(
            'label',
            { class: 'setting select' },
            h('span', {}, h('strong', {}, 'Default quality'), h('small', {}, 'Original copies the video when this computer can decode it. Lower settings make Plex convert the video.')),
            quality,
          ),
          toggle('autoplayNext', 'Play the next episode', 'Counts down at the credits, then starts the next episode.'),
          toggle('themeMusic', 'Theme music', 'Plays a show or movie theme quietly on its page.'),
        ),
        h(
          'section',
          { class: 'panel glass' },
          h('h2', {}, 'Look'),
          toggle('ambientOnHover', 'Light follows the pointer', 'The window background takes the colors of the title you point at.'),
        ),
      ),
      h(
        'section',
        { class: 'panel glass rows-panel' },
        h('h2', {}, 'Home rows'),
        h('p', { class: 'muted' }, 'Turn rows on or off and change their order. You can delete rows that you added.'),
        rowsList,
        h('div', { class: 'actions' }, restore),
        h('h3', {}, 'Add a row'),
        addRowForm(() => drawRows()),
      ),
    ),
  );
}

function describeRow(r) {
  const { sections } = state;
  if (r.type === 'continue') return 'Titles you started';
  if (r.type === 'hub') return 'Collection from Plex';
  const sec = sections.find((s) => s.key === String(r.section));
  const sort = SORTS[sec?.type || 'movie'].find(([v]) => v === r.sort)?.[1] || r.sort;
  return [sec?.title, sort, r.unwatched ? 'unwatched only' : null, r.genreTitle, r.decade ? `${r.decade}s` : null].filter(Boolean).join(', ');
}

function addRowForm(onAdded) {
  const { sections, plex, prefs } = state;
  const title = h('input', { type: 'text', placeholder: 'Row title', required: true, maxlength: 60 });
  const lib = h('select', {}, sections.map((s) => h('option', { value: s.key }, s.title)));
  const sort = h('select');
  const genre = h('select');
  const decade = h('select');
  const unwatched = h('input', { type: 'checkbox' });
  const msg = h('p', { class: 'muted', role: 'status' });

  async function fillOptions() {
    const sec = sections.find((s) => s.key === lib.value);
    if (!sec) return;
    sort.replaceChildren(...SORTS[sec.type].map(([v, l]) => h('option', { value: v }, l)));
    genre.replaceChildren(h('option', { value: '' }, 'Any genre'));
    decade.replaceChildren(h('option', { value: '' }, 'Any decade'));
    const [gs, ds] = await Promise.all([plex.genres(sec.key).catch(() => []), plex.decades(sec.key).catch(() => [])]);
    genre.append(...gs.map((g) => h('option', { value: g.key }, g.title)));
    decade.append(...ds.map((d) => h('option', { value: d.key }, d.title)));
  }
  lib.addEventListener('change', fillOptions);
  fillOptions();

  const form = h(
    'form',
    { class: 'add-row' },
    h('label', {}, h('span', {}, 'Title'), title),
    h('label', {}, h('span', {}, 'Library'), lib),
    h('label', {}, h('span', {}, 'Sort'), sort),
    h('label', {}, h('span', {}, 'Genre'), genre),
    h('label', {}, h('span', {}, 'Decade'), decade),
    h('label', { class: 'toggle' }, unwatched, h('span', {}, 'Unwatched only')),
    h('button', { class: 'button primary', type: 'submit' }, 'Add row'),
    msg,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = title.value.trim();
    if (!name) return;
    prefs.rows.push({
      id: `custom-${Date.now()}`,
      type: 'filter',
      title: name,
      section: lib.value,
      sort: sort.value,
      unwatched: unwatched.checked,
      genre: genre.value || undefined,
      genreTitle: genre.value ? genre.selectedOptions[0].textContent : undefined,
      decade: decade.value || undefined,
      visible: true,
    });
    await savePrefs();
    msg.textContent = `Added “${name}” to the end of Home.`;
    title.value = '';
    onAdded();
  });
  return form;
}
