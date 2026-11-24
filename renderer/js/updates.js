// Automatic updates: the main process checks the latest GitHub release (main.js, setupUpdates).
// This module offers the update and shows its progress, and builds the Settings panel.
import { h } from './util.js';
import { state, savePrefs } from './app.js';
import { dialog, toast } from './menu.js';

export function initUpdates() {
  window.marquee.updates.on('available', (r) => offer(r));
  window.marquee.updates.on('progress', (p) => {
    if (p.installing) toast('Installing the update. Marquee restarts in a moment.');
    else if (p.total) toast(`Downloading the update, ${Math.floor((100 * p.received) / p.total)}%`);
  });
}

function offer(r) {
  const notes = r.notes ? h('p', { class: 'update-notes' }, r.notes) : null;
  dialog(
    `Marquee ${r.latest} is available`,
    [h('p', {}, `You have version ${r.current}. Installing closes Marquee, updates it, and opens it again.`), notes],
    [{ label: 'Later' }, { label: 'Install and restart', primary: true, run: install }],
  );
}

async function install() {
  try {
    await window.marquee.updates.install();
  } catch (e) {
    toast(`The update didn't install: ${e.message}`, { error: true });
  }
}

// Settings: the version, a Check now button, and the start-up check toggle (on by default).
export function updatesPanel() {
  const { prefs } = state;
  const status = h('small', {}, '');
  const check = h('button', { class: 'button glass' }, 'Check for updates');
  check.addEventListener('click', async () => {
    check.disabled = true;
    status.textContent = 'Checking';
    try {
      const r = await window.marquee.updates.check();
      if (r.available) {
        status.textContent = `Version ${r.latest} is available.`;
        offer(r);
      } else status.textContent = r.latest ? `Marquee is up to date (latest release ${r.latest}).` : 'There are no releases yet.';
    } catch (e) {
      status.textContent = `The check failed: ${e.message}`;
    }
    check.disabled = false;
  });
  const auto = h('input', { type: 'checkbox', checked: prefs.autoUpdateCheck !== false });
  auto.addEventListener('change', () => {
    prefs.autoUpdateCheck = auto.checked;
    savePrefs();
  });
  return h(
    'section',
    { class: 'panel glass' },
    h('h2', {}, 'Updates'),
    h('dl', { class: 'specs' }, h('dt', {}, 'Version'), h('dd', {}, state.version || '')),
    h('label', { class: 'setting' }, auto, h('span', {}, h('strong', {}, 'Check for updates at start'), h('small', {}, 'Marquee looks for a newer release on GitHub each time it opens.'))),
    h('div', { class: 'actions' }, check, status),
  );
}
