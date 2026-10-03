/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

// Shared by the GUI startup console and the TUI welcome/VM boot views.
const ASCII_ART = String.raw`  ____ ___ ____ __   ______
 / ___|_ _| __ )\ \ / /  _ \
| |    | ||  _ \ \ V /| |_) |
| |___ | || |_) | | | |  __/
 \____|___|____/  |_| |_|`.split('\n');

function brandLines(width = 80, compact = false) {
  if (compact || width < Math.max(...ASCII_ART.map((line) => line.length))) {
    return [width >= 9 ? 'C I B Y P' : 'CIBYP'.slice(0, Math.max(0, width))];
  }
  return ASCII_ART.slice();
}

function printStartupBrand(stdout = process.stdout) {
  stdout.write('\n' + brandLines(stdout.columns || 80).join('\n') + '\n\n');
}

module.exports = { brandLines, printStartupBrand };
