/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 打包前置资源准备（跨平台）：
 *   1. aria2 二进制（scripts/download-aria2.js --all，已存在即跳过）
 *   2. Font Awesome / Tesseract OCR / Three.js / IME 词库
 *      （scripts/fetch-assets.sh 或 fetch-assets.ps1，--skip-geogebra）
 *
 * GeoGebra 离线包与 UI 字体由 scripts/download-voice-models.js 负责，
 * fetch-assets 中重叠的 GeoGebra 部分跳过，避免重复下载。
 *
 * 这些资源均被 .gitignore 忽略（不在版本库），新克隆/CI 构建必须显式准备，
 * 否则 electron-builder 会因 extraResources（aria2）缺失而失败，
 * OCR / 图标 / IME / PCB3D 等功能静默缺失。
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');

function run(cmd, args) {
  console.log(`[prepare-build-assets] 执行: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: projectRoot, shell: false });
  if (r.error) {
    console.error(`[prepare-build-assets] 启动失败: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[prepare-build-assets] 退出码 ${r.status}（${cmd}）`);
    process.exit(r.status === null ? 1 : r.status);
  }
}

console.log('[prepare-build-assets] 开始准备打包资源...');

// 1. aria2 二进制（全部平台；extraResources 引用 assets/aria2/${os}-${arch}，缺失会打包失败）。
//    --all 模式单平台失败仅警告不退出（download-aria2.js 内已含 3 次下载重试）
run(process.execPath, [path.join(__dirname, 'download-aria2.js'), '--all']);

// 2. fetch-assets：Font Awesome / OCR / Three.js / IME 词库（GeoGebra 由 download-voice-models 负责）
if (process.platform === 'win32') {
  run('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'fetch-assets.ps1'),
    '-SkipGeoGebra',
  ]);
} else {
  run('bash', [path.join(__dirname, 'fetch-assets.sh'), '--skip-geogebra']);
}

console.log('[prepare-build-assets] 全部资源就绪');