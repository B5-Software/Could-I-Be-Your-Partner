/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Monaco/Code-OSS theme colors accept hex, including #RRGGBBAA, not CSS rgba().
const EditorColors = (() => {
  const byte = (value) =>
    Math.max(0, Math.min(255, Math.round(Number(value) || 0)))
      .toString(16)
      .padStart(2, '0');
  function hex(value, fallback = '#4f8cff') {
    const color = String(value || '').trim();
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) return color.toLowerCase();
    if (/^#[0-9a-f]{3,4}$/i.test(color))
      return (
        '#' +
        [...color.slice(1)]
          .map((c) => c + c)
          .join('')
          .toLowerCase()
      );
    const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (!rgb) return fallback;
    const alpha = rgb[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgb[4])));
    return '#' + rgb.slice(1, 4).map(byte).join('') + (alpha < 1 ? byte(alpha * 255) : '');
  }
  function withAlpha(value, opacity) {
    return hex(value).slice(0, 7) + byte(Math.max(0, Math.min(1, opacity)) * 255);
  }
  function selection(value, dark) {
    let accent = hex(value).slice(0, 7);
    const channels = [1, 3, 5].map((offset) => parseInt(accent.slice(offset, offset + 2), 16));
    // A neutral black/white accent needs a readable, subdued blue selection.
    if (Math.max(...channels) - Math.min(...channels) < 24) accent = dark ? '#8ab4f8' : '#6b91c9';
    return {
      'editor.selectionBackground': withAlpha(accent, dark ? 0.3 : 0.22),
      'editor.inactiveSelectionBackground': withAlpha(accent, dark ? 0.18 : 0.12),
      'editor.selectionHighlightBackground': withAlpha(accent, 0.1),
      'editor.wordHighlightBackground': withAlpha(accent, 0.1),
      'editor.wordHighlightStrongBackground': withAlpha(accent, 0.16),
    };
  }
  return { hex, withAlpha, selection };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = EditorColors;
else globalThis.EditorColors = EditorColors;
