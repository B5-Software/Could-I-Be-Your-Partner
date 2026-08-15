/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 生成 build-info.json（项目根）：{ gitHash, buildTime }
 * - git 可用时写入当前短哈希；否则 gitHash 为空字符串
 * - 打包入口（build.beforePack）与 dev 构建（build-app-bundle.js）都会调用，
 *   保证 dev / 打包两种环境的 Splash 顶部都能显示一致的 git 哈希
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const outFile = path.join(projectRoot, 'build-info.json');

function getGitShortHash() {
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return String(hash).trim();
  } catch {
    return '';
  }
}

function main() {
  const info = {
    gitHash: getGitShortHash(),
    buildTime: new Date().toISOString()
  };
  try {
    fs.writeFileSync(outFile, JSON.stringify(info, null, 2), 'utf-8');
    console.log(`[build-info] ${info.gitHash ? 'gitHash=' + info.gitHash : 'gitHash 不可用（无 git 环境）'} -> ${path.basename(outFile)}`);
  } catch (e) {
    console.warn('[build-info] 写入失败:', e.message);
  }
}

if (require.main === module) main();
module.exports = main;
