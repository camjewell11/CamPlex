// Title page: backdrop, title plate, file details, seasons, cast, extras, and related titles.
import { h, svg, duration, bytes, dateText, relativeDate, episodeCode, uuid, libraryName } from '../util.js';
import { state } from '../app.js';
import { posterCard, landscapeCard, row, ratingsList } from '../components.js';
import { setAmbient, ambientOf } from '../ambient.js';
import { imageOf } from '../plex.js';
import { play, onDeckOf } from '../actions.js';

export async function renderDetail(main, { id, params }) {
  const { plex } = state;
  const item = await plex.metadata(id, { includeExtras: 1, includeRelated: 1, includeOnDeck: 1, includeMarkers: 1, includeChapters: 1 });
  if (!item) throw new Error('Plex has no title with this ID. It might have been removed from the library.');
  if (item.type === 'season') {
    location.replace(`#/item/${item.parentRatingKey}?season=${item.index}`);
    return;
  }
  const show = item.type === 'episode' ? await plex.metadata(item.grandparentRatingKey) : null;
  const look = show || item;
  setAmbient(ambientOf(look));

  const art = item.type === 'episode' ? item.art || show?.art : item.art;
  const page = h('div', { class: 'detail' });
  page.append(h('div', { class: 'detail-backdrop' }, art ? h('img', { src: plex.img(art, 1920, 1080), alt: '' }) : null));

  const audio = themeMusic(look);
  const top = h('section', { class: 'detail-top' }, plate(item, show, audio), item.Media ? fileInfo(item) : showInfo(item));
  page.append(top);

  if (item.type === 'show') page.append(await seasonsBlock(item, Number(params.get('season')) || null));
  if (item.type === 'episode') page.append(h('a', { class: 'button glass back-to-show', href: `#/item/${show.ratingKey}?season=${item.parentIndex}` }, svg('arrowLeft', 16), `All episodes of ${show.title}`));

  const cast = (item.Role || show?.Role || []).slice(0, 24);
  if (cast.length) page.append(row('Cast', cast.map(personCard)));

  const extras = item.Extras?.Metadata || [];
  if (extras.length) page.append(row('Trailers and extras', extras.map((x) => landscapeCard(x, { label: extraLabel(x) }))));

  for (const hub of item.Related?.Hub || []) {
    if (hub.Metadata?.length) page.append(row(hub.title, hub.Metadata.map(posterCard)));
  }

  main.append(page);
  return () => audio?.stop();
}

function plate(item, show, audio) {
  const { plex } = state;
  const look = show || item;
  const logo = imageOf(look, 'clearLogo');
  const facts = [];
  if (item.type === 'episode') facts.push(episodeCode(item), dateText(Date.parse(item.originallyAvailableAt) / 1000));
  else facts.push(item.year);
  facts.push(item.contentRating);
  if (item.duration && item.type !== 'show') facts.push(duration(item.duration));
  if (item.type === 'show') facts.push(`${item.childCount} season${item.childCount === 1 ? '' : 's'}`, `${item.leafCount} episodes`);
  const genres = (look.Genre || []).slice(0, 4).map((g) => g.tag).join(', ');
  const people = [];
  const dirs = (item.Director || []).map((d) => d.tag);
  const writers = (item.Writer || []).map((d) => d.tag);
  if (dirs.length) people.push(h('p', {}, h('span', { class: 'muted' }, dirs.length > 1 ? 'Directors ' : 'Director '), dirs.slice(0, 3).join(', ')));
  if (writers.length) people.push(h('p', {}, h('span', { class: 'muted' }, writers.length > 1 ? 'Writers ' : 'Writer '), writers.slice(0, 3).join(', ')));
  if (item.studio) people.push(h('p', {}, h('span', { class: 'muted' }, item.type === 'show' ? 'Network ' : 'Studio '), item.studio));

  const watched = item.type === 'show' ? item.viewedLeafCount === item.leafCount : !!item.viewCount;
  const resume = item.viewOffset ? item : onDeckOf(item);
  const playLabel = item.type === 'show' ? (resume ? `${resume.viewOffset ? 'Resume' : 'Play'} ${episodeCode(resume)}` : 'Play') : item.viewOffset ? `Resume from ${Math.floor(item.viewOffset / 60000)} min` : 'Play';

  const watchBtn = h('button', { class: 'button glass', 'aria-pressed': String(watched) }, svg('check', 16), watched ? 'Watched' : 'Mark watched');
  watchBtn.addEventListener('click', async () => {
    const now = watchBtn.getAttribute('aria-pressed') !== 'true';
    await plex.markWatched(item.ratingKey, now);
    watchBtn.setAttribute('aria-pressed', String(now));
    watchBtn.lastChild.textContent = now ? 'Watched' : 'Mark watched';
  });

  const trailer = item.primaryExtraKey ? item.primaryExtraKey.split('/').pop() : null;
  return h(
    'div',
    { class: 'plate glass' },
    item.type === 'episode' ? h('a', { class: 'kicker', href: `#/item/${show.ratingKey}` }, show.title) : null,
    item.type !== 'episode' && logo ? h('img', { class: 'logo', src: plex.img(logo, 900, 360, { format: 'png' }), alt: item.title }) : h('h1', { class: 'title' }, item.title),
    item.tagline ? h('p', { class: 'tagline' }, item.tagline) : null,
    h('div', { class: 'facts' }, facts.filter(Boolean).map((f) => h('span', {}, String(f))), genres ? h('span', {}, genres) : null),
    h('div', { class: 'ratings large' }, ratingsList(look).map(([k, v, kind]) => h('span', { class: `rating ${kind || ''}` }, h('b', {}, v), ` ${k}`))),
    item.summary ? h('p', { class: 'summary full' }, item.summary) : null,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'button primary', onclick: () => play(item) }, svg('play', 18), playLabel),
      item.viewOffset ? h('button', { class: 'button glass', onclick: () => play(item, { fromStart: true }) }, 'Play from start') : null,
      trailer ? h('a', { class: 'button glass', href: `#/play/${trailer}` }, 'Trailer') : null,
      watchBtn,
      audio ? audio.button : null,
    ),
    people.length ? h('div', { class: 'people' }, people) : null,
  );
}

function fileInfo(item) {
  const { plex } = state;
  const media = item.Media[0];
  const part = media.Part[0];
  const streams = part.Stream || [];
  const video = streams.find((s) => s.streamType === 1);
  const audios = streams.filter((s) => s.streamType === 2);
  const subs = streams.filter((s) => s.streamType === 3);
  const list = h('dl', { class: 'specs' });
  const add = (k, v) => v && list.append(h('dt', {}, k), h('dd', {}, v));
  add('Video', video ? video.extendedDisplayTitle || video.displayTitle : `${media.videoResolution} ${media.videoCodec}`);
  add('Audio', audios.length ? h('span', {}, audios.slice(0, 3).map((a) => h('span', { class: 'line' }, a.extendedDisplayTitle || a.displayTitle)), audios.length > 3 ? h('span', { class: 'line muted' }, `${audios.length - 3} more`) : null) : null);
  add('Subtitles', subs.length ? `${subs.length} track${subs.length === 1 ? '' : 's'}: ${[...new Set(subs.map((s) => s.language || s.displayTitle))].slice(0, 5).join(', ')}` : 'None');
  add('File', `${(media.container || '').toUpperCase()}, ${bytes(part.size)}, ${(media.bitrate / 1000).toFixed(1)} Mbps`);
  const playsAs = h('dd', { class: 'muted' }, 'Checking');
  list.append(h('dt', {}, 'Plays as'), playsAs);
  describeDecision(item).then((t) => (playsAs.textContent = t), () => (playsAs.textContent = 'Unknown'));

  const hist = h('div', { class: 'history' });
  loadHistory(item, hist);
  return h('aside', { class: 'fileinfo glass' }, h('h2', {}, 'About this file'), list, hist);
}

function showInfo(item) {
  const list = h('dl', { class: 'specs' });
  const add = (k, v) => v && list.append(h('dt', {}, k), h('dd', {}, v));
  add('Episodes', `${item.leafCount}, ${item.leafCount - (item.viewedLeafCount || 0)} unwatched`);
  add('First aired', item.originallyAvailableAt ? dateText(Date.parse(item.originallyAvailableAt) / 1000) : null);
  add('Added', item.addedAt ? relativeDate(item.addedAt) : null);
  add('Library', libraryName(item.librarySectionTitle));
  return h('aside', { class: 'fileinfo glass' }, h('h2', {}, 'About this show'), list);
}

async function describeDecision(item) {
  const { plex } = state;
  const session = uuid();
  try {
    const d = await plex.decision(item.ratingKey, session, { quality: state.prefs.quality });
    const streams = d.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream || [];
    const v = streams.find((s) => s.streamType === 1);
    const a = streams.find((s) => s.streamType === 2);
    const vText = v ? (v.decision === 'copy' ? `video copied (${v.codec.toUpperCase()})` : `video converted to ${v.codec.toUpperCase()}`) : '';
    const aText = a ? (a.decision === 'copy' ? 'audio copied' : `audio converted to ${a.codec === 'opus' ? 'Opus' : a.codec.toUpperCase()} ${a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : a.channels === 2 ? 'stereo' : `${a.channels} ch`}`) : '';
    const text = [vText, aText].filter(Boolean).join(', ');
    return text ? text[0].toUpperCase() + text.slice(1) : d.generalDecisionText || 'Unknown';
  } finally {
    plex.stopTranscode(session);
  }
}

async function loadHistory(item, el) {
  const { plex } = state;
  try {
    const [rows, names] = await Promise.all([plex.history(item.ratingKey), plex.accounts()]);
    if (!rows.length) {
      el.append(h('p', { class: 'muted' }, item.viewCount ? `Watched ${item.viewCount} time${item.viewCount === 1 ? '' : 's'}.` : 'Nobody has watched this yet.'));
      return;
    }
    el.append(
      h('h3', {}, 'Watch history'),
      h('ul', {}, rows.slice(0, 6).map((r) => h('li', {}, h('span', {}, names[r.accountID] || 'Someone'), h('span', { class: 'muted' }, relativeDate(r.viewedAt))))),
    );
  } catch {
    /* history is optional */
  }
}

async function seasonsBlock(show, wanted) {
  const { plex } = state;
  const seasons = (await plex.children(show.ratingKey)).sort((a, b) => (a.index || 0) - (b.index || 0));
  const regular = seasons.filter((s) => s.index > 0);
  const deckSeason = onDeckOf(show)?.parentIndex;
  let current = seasons.find((s) => s.index === wanted) || seasons.find((s) => s.index === deckSeason) || regular[0] || seasons[0];
  const tabs = h('div', { class: 'season-tabs', role: 'tablist' });
  const list = h('div', { class: 'episodes' });
  async function select(season) {
    current = season;
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.key === season.ratingKey)));
    list.replaceChildren(h('p', { class: 'muted' }, 'Loading episodes'));
    const eps = await plex.children(season.ratingKey);
    list.replaceChildren(...eps.map(episodeRow));
    history.replaceState(null, '', `#/item/${show.ratingKey}?season=${season.index}`);
  }
  for (const s of seasons) {
    tabs.append(h('button', { role: 'tab', 'data-key': s.ratingKey, onclick: () => select(s) }, s.index === 0 ? 'Specials' : `Season ${s.index}`));
  }
  if (current) select(current);
  return h('section', { class: 'seasons' }, tabs, list);
}

function episodeRow(ep) {
  const { plex } = state;
  const pct = ep.viewOffset && ep.duration ? (ep.viewOffset / ep.duration) * 100 : 0;
  return h(
    'a',
    { class: `episode ${ep.viewCount ? 'seen' : ''}`, href: `#/play/${ep.ratingKey}${ep.viewOffset ? '?resume=1' : ''}` },
    h(
      'div',
      { class: 'thumb' },
      ep.thumb ? h('img', { src: plex.img(ep.thumb, 400, 225), alt: '', loading: 'lazy' }) : null,
      h('span', { class: 'playhint glass' }, svg('play', 16)),
      pct ? h('div', { class: 'progress' }, h('span', { style: { width: `${pct}%` } })) : null,
    ),
    h(
      'div',
      { class: 'ep-text' },
      h('h3', {}, h('span', { class: 'num' }, String(ep.index)), ep.title, ep.viewCount ? h('span', { class: 'seen-mark', title: 'Watched' }, svg('check', 14)) : null),
      h('div', { class: 'facts small' }, h('span', {}, duration(ep.duration)), ep.originallyAvailableAt ? h('span', {}, dateText(Date.parse(ep.originallyAvailableAt) / 1000)) : null),
      ep.summary ? h('p', {}, ep.summary) : null,
    ),
    h(
      'button',
      {
        class: 'ep-more',
        'aria-label': `Details for ${ep.title}`,
        title: 'Details',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          location.hash = `#/item/${ep.ratingKey}`;
        },
      },
      svg('info', 18),
    ),
  );
}

function personCard(p) {
  const { plex } = state;
  return h(
    'div',
    { class: 'person' },
    h('div', { class: 'face' }, p.thumb ? h('img', { src: plex.img(p.thumb, 200, 200), alt: '', loading: 'lazy' }) : h('span', {}, initials(p.tag))),
    h('span', { class: 'name' }, p.tag),
    p.role ? h('span', { class: 'sub' }, p.role) : null,
  );
}
const initials = (n) => n.split(/\s+/).map((x) => x[0]).slice(0, 2).join('');

function extraLabel(x) {
  const kinds = { 1: 'Trailer', 2: 'Deleted scene', 3: 'Interview', 4: 'Music video', 5: 'Behind the scenes', 6: 'Scene', 7: 'Live music', 9: 'Featurette', 10: 'Short' };
  return [kinds[x.extraType] || 'Extra', x.duration ? duration(x.duration) : ''].filter(Boolean).join(', ');
}

// Theme music fades in under the page and stops when you leave it.
function themeMusic(look) {
  const { plex } = state;
  if (!look.theme) return null;
  const el = new Audio(plex.url(look.theme));
  el.volume = 0;
  let on = state.prefs.themeMusic;
  let fade;
  const ramp = (to) => {
    clearInterval(fade);
    fade = setInterval(() => {
      const v = el.volume + (to > el.volume ? 0.02 : -0.04);
      el.volume = Math.max(0, Math.min(to, v));
      if (Math.abs(el.volume - to) < 0.03) {
        el.volume = to;
        clearInterval(fade);
        if (to === 0) el.pause();
      }
    }, 80);
  };
  const button = h('button', { class: 'button glass icon-only', 'aria-label': 'Theme music', title: 'Theme music', 'aria-pressed': String(on) }, svg('music', 18));
  button.addEventListener('click', () => {
    on = !on;
    button.setAttribute('aria-pressed', String(on));
    if (on) el.play().then(() => ramp(0.3)).catch(() => {});
    else ramp(0);
  });
  if (on) el.play().then(() => ramp(0.3)).catch(() => {});
  return {
    button,
    stop() {
      clearInterval(fade);
      el.pause();
      el.src = '';
    },
  };
}
