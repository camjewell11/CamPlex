// DOM and formatting helpers.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svg(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}
const ICONS = {
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
  pause: '<path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor"/>',
  prev: '<path d="M5 5h2.5v14H5zm3.5 7L19 5v14z" fill="currentColor"/>',
  next: '<path d="M16.5 5H19v14h-2.5zM5 5l10.5 7L5 19z" fill="currentColor"/>',
  stop: '<path d="M6 6h12v12H6z" fill="currentColor"/>',
  back10: '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor"/><text x="12" y="16.2" font-size="6.5" text-anchor="middle" fill="currentColor" font-family="sans-serif" font-weight="700">10</text>',
  fwd10: '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z" fill="currentColor"/><text x="12" y="16.2" font-size="6.5" text-anchor="middle" fill="currentColor" font-family="sans-serif" font-weight="700">10</text>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9zm11.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM13 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" fill="currentColor"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z" fill="currentColor"/>',
  full: '<path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z" fill="currentColor"/>',
  exitfull: '<path d="M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z" fill="currentColor"/>',
  tracks: '<path d="M3 5h18v14H3zm2 2v10h14V7zm2 6h4v2H7zm6 0h4v2h-4zm-6-3h10v2H7z" fill="currentColor"/>',
  pip: '<path d="M2 4h20v16H2zm2 2v12h16V6z" fill="currentColor"/><path d="M12 11h7v6h-7z" fill="currentColor"/>',
  unpip: '<path d="M2 4h20v16H2zm2 2v12h16V6z" fill="currentColor"/><path d="M7 8h6v2h-2.6l4.3 4.3-1.4 1.4L9 11.4V14H7z" fill="currentColor"/>',
  info: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z" fill="currentColor"/>',
  arrowLeft: '<path d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z" fill="currentColor"/>',
  arrowRight: '<path d="m8.6 5.4 1.4-1.4 8 8-8 8-1.4-1.4 6.6-6.6z" fill="currentColor"/>',
  search: '<path d="M10 3a7 7 0 1 0 4.2 12.6l5.1 5.1 1.4-1.4-5.1-5.1A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" fill="currentColor"/>',
  settings: '<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" fill="currentColor" transform="translate(-1 0)"/>',
  check: '<path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4z" fill="currentColor"/>',
  music: '<path d="M9 18a3 3 0 1 1-2-2.8V5l12-2v12a3 3 0 1 1-2-2.8V7.4L9 8.8z" fill="currentColor"/>',
  close: '<path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z" fill="currentColor"/>',
  up: '<path d="m12 7-6 6 1.4 1.4 4.6-4.6 4.6 4.6L18 13z" fill="currentColor"/>',
  down: '<path d="m12 17 6-6-1.4-1.4-4.6 4.6-4.6-4.6L6 11z" fill="currentColor"/>',
  more: '<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>',
  star: '<path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" fill="currentColor"/>',
  playlist: '<path d="M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm14-5v-.01L21 14l-4 3z" fill="currentColor"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" fill="currentColor"/>',
  refresh: '<path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z" fill="currentColor"/>',
  edit: '<path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8zm15.7-7.6a1 1 0 0 0 0-1.4L17.8 6.3a1 1 0 0 0-1.4 0l-1.5 1.5 2.8 2.8z" fill="currentColor"/>',
  shuffle: '<path d="M14.5 4H20v5.5l-2-2-3.6 3.6-1.4-1.4L16.6 6zM4 5.4 5.4 4 20 18.6 18.6 20zM20 14.5V20h-5.5l2-2-2.5-2.5 1.4-1.4 2.5 2.5z" fill="currentColor"/>',
  cast: '<path d="M2 17.5V20h2.5A2.5 2.5 0 0 0 2 17.5zm0-3.5v2a4 4 0 0 1 4 4h2a6 6 0 0 0-6-6zm0-3.5v2A7.5 7.5 0 0 1 9.5 20h2A9.5 9.5 0 0 0 2 10.5zM3 4h18v16h-7v-2h5V6H5v2H3z" fill="currentColor"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z" fill="currentColor"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z" fill="currentColor"/>',
  download: '<path d="M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3zM5 18h14v2H5z" fill="currentColor"/>',
  folder: '<path d="M3 5h7l2 2h9v12H3zm2 4v8h14V9z" fill="currentColor"/>',
};

export function duration(ms) {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}
export function clock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const hr = Math.floor(sec / 3600);
  return hr ? `${hr}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function bytes(n) {
  if (!n) return '';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`;
}
export function dateText(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
export function relativeDate(sec) {
  const days = Math.floor((Date.now() / 1000 - sec) / 86400);
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return dateText(sec);
}
export function episodeCode(item) {
  if (item.parentIndex === undefined || item.index === undefined) return '';
  return `S${String(item.parentIndex).padStart(2, '0')}E${String(item.index).padStart(2, '0')}`;
}
export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
export function uuid() {
  return crypto.randomUUID();
}
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Library names on this server carry a version suffix ("Movies V3"); it means nothing to a viewer.
export function libraryName(title) {
  return title ? title.replace(/\s+V\d+$/, '') : title;
}
