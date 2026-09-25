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

/**
 * 递归收集 app-parts 下的 .js 文件。
 * 目录与文件名均以 `<数字>-<功能名>` 开头，按「目录数字 → 目录名 → 文件数字 → 文件名」
 * 的自然顺序拼接；所有 part 共享同一个 appEntry 作用域，顺序即执行顺序。
 */
function collectParts(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectParts(path.join(dir, entry.name), rel));
    } else if (/\.js$/.test(entry.name)) {
      files.push(rel);
    }
  }
  return files;
}

function segmentNumber(seg) {
  const m = /^(\d+)/.exec(seg);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function compareSegments(a, b) {
  const na = segmentNumber(a);
  const nb = segmentNumber(b);
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}

function compareParts(a, b) {
  const pa = a.split('/');
  const pb = b.split('/');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const cmp = compareSegments(pa[i], pb[i]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

const files = collectParts(partsDir).sort(compareParts);

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
  ' * 生成文件：由 scripts/build-app-bundle.js 从 src/renderer/js/app-parts/**/*.js 拼接生成。',
  ' * 请勿直接编辑本文件，修改 app-parts 后运行 npm run build-app-bundle。',
  ' */',
  '',
  'export default (async function appEntry() {',
].join('\n');

const bundle = `${banner}\n${body}\n})();\n`;
fs.writeFileSync(outFile, bundle, 'utf-8');
console.log(`[build-app-bundle] 已从 ${files.length} 个模块生成 ESM ${path.basename(outFile)}`);

// 同步刷新 build-info.json（Splash 顶部 git 哈希；dev 与打包一致）
try {
  require('./build-info')();
} catch (e) {
  console.warn('[build-app-bundle] build-info 刷新失败:', e.message);
}
