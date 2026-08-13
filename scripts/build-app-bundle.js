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
const body = chunks.join('\n').replace(/\n{3,}/g, '\n\n');

// app.js 以 ESM 形式生成：所有 part 共享 appEntry 的作用域（保留原拼接式共享状态），
// 同时获得模块级严格模式、可延迟执行等 ESM 特性。默认导出初始化 Promise，
// 供宿主页面 / 后续模块按需 await。
const banner = [
  '/*',
  ' * SPDX-License-Identifier: GPL-3.0-or-later',
  ' * Copyright (c) 2026 B5-Software',
  ' *',
  ' * This file is part of Could I Be Your Partner.',
  ' *',
  ' * 生成文件：由 scripts/build-app-bundle.js 从 src/renderer/js/app-parts/*.js 拼接生成。',
  ' * 请勿直接编辑本文件，修改 app-parts 后运行 npm run build-app-bundle。',
  ' */',
  '',
  'export default (async function appEntry() {',
].join('\n');

const bundle = `${banner}\n${body}\n})();\n`;
fs.writeFileSync(outFile, bundle, 'utf-8');
console.log(`[build-app-bundle] 已从 ${files.length} 个模块生成 ESM ${path.basename(outFile)}`);
