/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

// 3D ANSI Shadow block art shared by the GUI startup console and TUI views.
// Full 3D (40 cols) for standard terminals; compact 3D (28 cols) for narrow panes.
const BRAND_3D_FULL = [
  ' ██████╗ ██╗ ██████╗  ██╗   ██╗ ██████╗ ',
  '██╔════╝ ██║ ██╔══██╗ ╚██╗ ██╔╝ ██╔══██╗',
  '██║      ██║ ██████╔╝  ╚████╔╝  ██████╔╝',
  '██║      ██║ ██╔══██╗   ╚██╔╝   ██╔═══╝ ',
  '╚██████╗ ██║ ██████╔╝    ██║    ██║     ',
  ' ╚═════╝ ╚═╝ ╚═════╝     ╚═╝    ╚═╝     ',
];

const BRAND_3D_COMPACT = [
  ' ████╗██╗████╗ ██╗ ██╗████╗ ',
  '██╔══╝██║██╔██╗╚████╔╝██╔██╗',
  '██║   ██║████╔╝ ╚██╔╝ ████╔╝',
  '██║   ██║██╔██╗  ██║  ██╔═╝ ',
  '╚████╗██║████╔╝  ██║  ██║   ',
  ' ╚═══╝╚═╝╚═══╝   ╚═╝  ╚═╝   ',
];

const FULL_WIDTH = Math.max(...BRAND_3D_FULL.map((line) => line.length));
const COMPACT_WIDTH = Math.max(...BRAND_3D_COMPACT.map((line) => line.length));

// Cool cobalt-steel gradient readable on both dark and light terminal backgrounds.
const FACE_RGB = [
  '\x1b[1;38;2;56;189;248m',
  '\x1b[1;38;2;45;164;245m',
  '\x1b[1;38;2;37;138;235m',
  '\x1b[1;38;2;49;114;226m',
  '\x1b[1;38;2;67;92;214m',
  '\x1b[1;38;2;79;70;229m',
];
const SHADOW_ANSI = '\x1b[38;2;100;116;139m';
const RESET = '\x1b[0m';

function brandLines(width = 80, compact = false) {
  if (compact || width < COMPACT_WIDTH) {
    return [width >= 9 ? 'C I B Y P' : 'CIBYP'.slice(0, Math.max(0, width))];
  }
  if (width < FULL_WIDTH) {
    return BRAND_3D_COMPACT.slice();
  }
  return BRAND_3D_FULL.slice();
}

function style3DLine(line, rowIndex, faceCode, shadowCode) {
  const face = faceCode || FACE_RGB[rowIndex % FACE_RGB.length];
  const shadow = shadowCode || SHADOW_ANSI;
  let out = '';
  let mode = 0; // 0: none, 1: face, 2: shadow
  for (const ch of line) {
    const next = ch === '█' ? 1 : ch === ' ' ? 0 : 2;
    if (next !== mode) {
      if (mode !== 0) out += RESET;
      if (next === 1) out += face;
      else if (next === 2) out += shadow;
      mode = next;
    }
    out += ch;
  }
  if (mode !== 0) out += RESET;
  return out;
}

function printStartupBrand(stdout = process.stdout) {
  const lines = brandLines(stdout.columns || 80);
  const useColor = Boolean(stdout && stdout.isTTY && !process.env.NO_COLOR);
  const rendered = useColor ? lines.map((line, i) => style3DLine(line, i)) : lines;
  stdout.write('\n' + rendered.join('\n') + '\n\n');
}

module.exports = { brandLines, printStartupBrand, style3DLine };
