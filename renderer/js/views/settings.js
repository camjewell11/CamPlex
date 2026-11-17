// Settings: server, playback, look, and the Home rows editor.
import { h, svg } from '../util.js';
import { state, savePrefs, defaultPrefs, DEFAULT_FEATURED } from '../app.js';
import { QUALITY } from '../plex.js';
import { setAmbient } from '../ambient.js';
import { SORTS } from './library.js';
import { WATCHING_DAYS, featuredCandidates } from './home.js';

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
      featuredPanel(),
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

// Genre lists for the featured carousel. A genre can be in one list at most, so choosing it in one
// list removes it from the other. Below them, shows the user is watching that the genres hide, each
// with a checkbox to feature it anyway.
function featuredPanel() {
  const { plex, sections, prefs } = state;
  const f = prefs.featured;
  const include = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show titles with any of these genres' });
  const exclude = h('div', { class: 'chips exclude', role: 'group', 'aria-label': 'Never show titles with these genres' });
  const hidden = h('ul', { class: 'hidden-shows' });
  let names = [];
  f.alwaysShow ||= [];

  let hiddenTimer;
  let hiddenRun = 0;
  function drawHidden() {
    clearTimeout(hiddenTimer);
    hiddenTimer = setTimeout(async () => {
      const run = ++hiddenRun;
      const shows = sections.filter((s) => s.type === 'show');
      const lists = await Promise.all(
        shows.map(async (s) => {
          const [all, kept] = await Promise.all([featuredCandidates(s, { genres: false }), featuredCandidates(s)]);
          const keep = new Set(kept.map((i) => i.ratingKey));
          return all.filter((i) => !keep.has(i.ratingKey) || f.alwaysShow.includes(i.ratingKey));
        }),
      ).catch(() => []);
      if (run !== hiddenRun) return;
      const items = lists.flat();
      hidden.replaceChildren(
        ...(items.length
          ? items.map((it) => {
              const box = h('input', { type: 'checkbox', checked: f.alwaysShow.includes(it.ratingKey) });
              box.addEventListener('change', () => {
                f.alwaysShow = box.checked ? [...new Set([...f.alwaysShow, it.ratingKey])] : f.alwaysShow.filter((k) => k !== it.ratingKey);
                savePrefs();
              });
              const genres = (it.Genre || []).map((g) => g.tag).join(', ');
              return h('li', {}, h('label', { class: 'setting' }, box, h('span', {}, h('strong', {}, it.title), h('small', {}, genres ? `Feature anyway (${genres})` : 'Feature anyway'))));
            })
          : [h('li', { class: 'muted' }, 'The genres hide none of the shows you are watching.')]),
      );
    }, 300);
  }

  function draw() {
    const chips = (list, other) =>
      names.map((name) => {
        const on = f[list].includes(name);
        return h(
          'button',
          {
            class: 'button chip',
            type: 'button',
            'aria-pressed': String(on),
            onclick: () => {
              f[list] = on ? f[list].filter((n) => n !== name) : [...f[list], name].sort();
              f[other] = f[other].filter((n) => n !== name);
              savePrefs();
              draw();
              drawHidden();
              (list === 'include' ? include : exclude).querySelector(`[data-name="${CSS.escape(name)}"]`)?.focus();
            },
            'data-name': name,
          },
          name,
        );
      });
    include.replaceChildren(...chips('include', 'exclude'));
    exclude.replaceChildren(...chips('exclude', 'include'));
  }

  Promise.all(sections.map((s) => plex.genres(s.key).catch(() => []))).then((lists) => {
    names = [...new Set([...lists.flat().map((g) => g.title), ...f.include, ...f.exclude])].sort((a, b) => a.localeCompare(b));
    draw();
  });
  drawHidden();

  const reset = h('button', { class: 'button glass', type: 'button' }, 'Restore default genres');
  reset.addEventListener('click', async () => {
    const { include, exclude } = structuredClone(DEFAULT_FEATURED);
    Object.assign(f, { include, exclude, rev: DEFAULT_FEATURED.rev });
    await savePrefs();
    draw();
    drawHidden();
  });

  return h(
    'section',
    { class: 'panel glass featured-panel' },
    h('h2', {}, 'Featured on Home'),
    h(
      'p',
      { class: 'muted' },
      `The carousel shows unwatched movies, newest first, and shows with an episode watched in the last ${WATCHING_DAYS} days. A title appears only when it has at least one genre from the first list and none from the second.`,
    ),
    h('h3', {}, 'Show titles with any of these genres'),
    include,
    h('h3', {}, 'Never show titles with these genres'),
    exclude,
    h('div', { class: 'actions' }, reset),
    h('h3', {}, 'Shows you are watching that these genres hide'),
    hidden,
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
