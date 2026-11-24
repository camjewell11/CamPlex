// Sign-in: links this app to a Plex account through plex.tv, then finds the server.
import { h } from '../util.js';

export function renderSignIn(el, onDone) {
  const status = h('p', { class: 'muted', role: 'status' }, 'Marquee opens plex.tv in your browser. Sign in there, and this window continues on its own.');
  const start = h('button', { class: 'button primary' }, 'Sign in with Plex');
  const cancel = h('button', { class: 'button glass', hidden: true }, 'Cancel');

  start.addEventListener('click', async () => {
    start.disabled = true;
    cancel.hidden = false;
    status.textContent = 'Waiting for you to approve Marquee on plex.tv.';
    try {
      const server = await window.marquee.auth.start();
      status.textContent = `Connected to ${server.name}.`;
      onDone(server);
    } catch (e) {
      status.textContent = e.message || String(e);
      start.disabled = false;
      cancel.hidden = true;
    }
  });
  cancel.addEventListener('click', async () => {
    await window.marquee.auth.cancel();
    status.textContent = 'Sign-in canceled.';
    start.disabled = false;
    cancel.hidden = true;
  });

  el.replaceChildren(
    h(
      'main',
      { class: 'signin' },
      h(
        'div',
        { class: 'signin-card glass' },
        h('span', { class: 'wordmark large' }, 'Marquee'),
        h('h1', {}, 'Your Plex library, in a new light'),
        h('p', {}, `Sign in with the Plex account that owns or shares your server. Marquee stores the sign-in on this computer, encrypted with your ${window.marquee.platform === 'darwin' ? 'macOS keychain' : 'Windows account'}.`),
        h('div', { class: 'actions' }, start, cancel),
        status,
      ),
    ),
  );
}
