/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * electron-builder 打包入口（build / build:win / build:mac / build:linux / dist / build-no-tarot*）：
 *   1. 刷新 build-info.json（Splash 顶部 git 哈希，与 dev 一致）
 *   2. 若 git 可用，把版本号改写为 semver build metadata：
 *        1.7.0-alpha.32 -> 1.7.0-alpha.32+9f7f7fb
 *      通过 electron-builder 的 extraMetadata 注入打包产物内的 package.json，
 *      安装后 app.getVersion() 即返回带 hash 的版本（About / 更新检测可见）。
 *      仓库内 package.json 保持干净，dev 模式（npm start）不受影响。
 *   3. 透传其余参数并启动 electron-builder
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

require('./build-info')();

const projectRoot = path.resolve(__dirname, '..');

function getGitHash() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(projectRoot, 'build-info.json'), 'utf-8'));
    return String(info.gitHash || '').trim();
  } catch {
    return '';
  }
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  const gitHash = getGitHash();
  const ebArgs = process.argv.slice(2);

  if (gitHash) {
    const version = `${pkg.version}+${gitHash}`;
    console.log(`[package] 版本号注入 build metadata: ${pkg.version} -> ${version}`);
    ebArgs.push(`--config.extraMetadata.version=${version}`);
  } else {
    console.log('[package] git 不可用，保持原版本号:', pkg.version);
  }

  // 直接调用本地 electron-builder CLI（跨平台，避免 Windows 下 spawn .cmd 的 EINVAL 问题）
  const cli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
  const args = [cli, ...ebArgs];
  console.log(`[package] 执行: ${process.execPath} ${args.join(' ')}`);

  const child = spawn(process.execPath, args, { cwd: projectRoot, stdio: 'inherit', shell: false });
  child.on('error', (err) => {
    console.error('[package] 启动 electron-builder 失败:', err.message);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
}

main();
