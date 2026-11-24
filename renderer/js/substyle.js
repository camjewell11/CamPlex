// Subtitle look for the subtitles that the app draws (::cue on the player video and the PiP text).
// Settings > Subtitles changes prefs.subtitleStyle; applySubtitleStyle() writes one <style> element.
export const SUB_SIZES = { small: ['Small', 0.8], medium: ['Medium', 1.05], large: ['Large', 1.35], huge: ['Extra large', 1.7] };
export const SUB_COLORS = { white: ['White', '#ffffff'], yellow: ['Yellow', '#ffe14d'], cyan: ['Cyan', '#7fe7ff'] };
export const SUB_BACKS = {
  shade: ['Dark box', 'rgb(0 0 0 / 0.55)', 'none'],
  solid: ['Black box', '#000', 'none'],
  outline: ['Outline only', 'transparent', '0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000'],
};
export const DEFAULT_SUB_STYLE = { size: 'medium', color: 'white', background: 'shade' };

export function subtitleCss(style = DEFAULT_SUB_STYLE) {
  const size = (SUB_SIZES[style.size] || SUB_SIZES.medium)[1];
  const color = (SUB_COLORS[style.color] || SUB_COLORS.white)[1];
  const [, bg, shadow] = SUB_BACKS[style.background] || SUB_BACKS.shade;
  return `.player-video::cue { font-family: var(--font); font-weight: 500; font-size: ${size}em; color: ${color}; background: ${bg}; text-shadow: ${shadow}; }`;
}

export function applySubtitleStyle(style) {
  let el = document.getElementById('sub-style');
  if (!el) {
    el = document.createElement('style');
    el.id = 'sub-style';
    document.head.append(el);
  }
  el.textContent = subtitleCss(style);
}
