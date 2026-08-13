/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const fs = require('fs');
const path = require('path');

const partsDir = path.join(__dirname, '../src/renderer/js/app-parts');
const outFile = path.join(__dirname, '../src/renderer/js/app.js');

const files = fs.readdirSync(partsDir)
  .filter(f => /\.js$/.test(f))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.error('[build-app-bundle] app-parts 目录为空');
  process.exit(1);
}

const chunks = files.map(file => fs.readFileSync(path.join(partsDir, file), 'utf-8'));
const bundle = chunks.join('\n').replace(/\n{3,}/g, '\n\n');
fs.writeFileSync(outFile, bundle, 'utf-8');
console.log(`[build-app-bundle] 已从 ${files.length} 个模块生成 ${path.basename(outFile)}`);
