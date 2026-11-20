// Playback targets shared by the hero, the detail page, and the player.
import { state } from './app.js';

// Plex returns OnDeck.Metadata as a single object, not an array.
export const onDeckOf = (item) => [].concat(item?.OnDeck?.Metadata || [])[0];

// A show or season plays its next unwatched episode; a movie or episode plays itself.
export async function playTarget(item) {
  const { plex } = state;
  if (item.type === 'movie' || item.type === 'episode' || item.type === 'clip') return item;
  if (item.type === 'show') {
    const full = await plex.metadata(item.ratingKey, { includeOnDeck: 1 });
    const deck = onDeckOf(full);
    if (deck) return deck;
    const seasons = (await plex.children(item.ratingKey)).filter((s) => s.index > 0);
    const first = seasons[0] || (await plex.children(item.ratingKey))[0];
    return first ? (await plex.children(first.ratingKey))[0] : null;
  }
  if (item.type === 'season') {
    const eps = await plex.children(item.ratingKey);
    return eps.find((e) => !e.viewCount) || eps[0];
  }
  return null;
}

export async function play(item, { fromStart = false } = {}) {
  const target = await playTarget(item);
  if (!target) return;
  const resume = !fromStart && target.viewOffset ? '?resume=1' : '';
  location.hash = `#/play/${target.ratingKey}${resume}`;
}

// Next episode in watch order, crossing into the next season when needed.
export async function nextEpisode(ep) {
  const { plex } = state;
  if (ep.type !== 'episode') return null;
  const eps = await plex.children(ep.parentRatingKey);
  const i = eps.findIndex((e) => e.ratingKey === ep.ratingKey);
  if (i >= 0 && i < eps.length - 1) return eps[i + 1];
  const seasons = (await plex.children(ep.grandparentRatingKey)).sort((a, b) => a.index - b.index);
  const si = seasons.findIndex((s) => s.ratingKey === ep.parentRatingKey);
  for (const s of seasons.slice(si + 1)) {
    const next = await plex.children(s.ratingKey);
    if (next.length) return next[0];
  }
  return null;
}

// Previous episode in watch order, crossing into the previous season when needed. Specials
// (season 0) come before season 1 in Plex's order, so they're skipped here.
export async function previousEpisode(ep) {
  const { plex } = state;
  if (ep.type !== 'episode') return null;
  const eps = await plex.children(ep.parentRatingKey);
  const i = eps.findIndex((e) => e.ratingKey === ep.ratingKey);
  if (i > 0) return eps[i - 1];
  const seasons = (await plex.children(ep.grandparentRatingKey)).sort((a, b) => a.index - b.index);
  const si = seasons.findIndex((s) => s.ratingKey === ep.parentRatingKey);
  for (const s of seasons.slice(0, Math.max(0, si)).reverse()) {
    if (s.index === 0 && ep.parentIndex > 0) break;
    const prev = await plex.children(s.ratingKey);
    if (prev.length) return prev[prev.length - 1];
  }
  return null;
}
