// The window's ambient light: four corner colors that follow the title in focus.
const FALLBACK = { topLeft: '141a2e', topRight: '0b0f1c', bottomRight: '1b1430', bottomLeft: '0a1220' };
let current = '';

export function setAmbient(colors) {
  const c = colors && colors.topLeft ? colors : FALLBACK;
  const sig = `${c.topLeft}${c.topRight}${c.bottomRight}${c.bottomLeft}`;
  if (sig === current) return;
  current = sig;
  const root = document.documentElement.style;
  root.setProperty('--amb-tl', `#${c.topLeft}`);
  root.setProperty('--amb-tr', `#${c.topRight}`);
  root.setProperty('--amb-br', `#${c.bottomRight}`);
  root.setProperty('--amb-bl', `#${c.bottomLeft}`);
  root.setProperty('--accent', accentFrom(c));
}

export function ambientOf(item) {
  return item?.UltraBlurColors || null;
}

// Pick the most colorful corner and lift it into a readable accent.
function accentFrom(c) {
  const hsls = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].map(toHsl);
  hsls.sort((a, b) => b.s * (0.3 + b.l) - a.s * (0.3 + a.l));
  const { h, s } = hsls[0];
  const sat = Math.min(Math.max(s, 0.25), 0.75);
  return `hsl(${Math.round(h)} ${Math.round(sat * 100)}% 74%)`;
}
function toHsl(hex) {
  const n = parseInt(hex, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 220, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}
