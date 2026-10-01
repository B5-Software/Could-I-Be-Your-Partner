/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * electron-builder beforePack 钩子（模块式）。
 * electron-builder 26 起不再支持 shell 命令字符串形式的钩子，
 * 只接受可解析的模块路径（default export 或命名导出 beforePack）。
 * 职责：打包前刷新 build-info.json（git 哈希 + 构建时间）。
 */

'use strict';

const buildInfo = require('./build-info');

exports.beforePack = async (context) => {
  await require('./prepare-codeoss').prepareCodeOSS(
    context.electronPlatformName,
    require('builder-util').Arch[context.arch],
  );
  buildInfo();
  if (context.electronPlatformName === 'darwin') {
    require('./build-macos-computer').buildMacComputer(require('builder-util').Arch[context.arch]);
  }
  // Platform-level negative-only `files` creates another unrestricted matcher
  // in electron-builder. Keep native exclusions in the root allowlist instead.
  const platforms = ['win32', 'darwin', 'linux'];
  const prefix = '!node_modules/onnxruntime-node/bin/napi-v6/';
  const exclusions = platforms
    .filter((platform) => platform !== context.electronPlatformName)
    .map((platform) => `${prefix}${platform}/**`);
  for (const fileSet of context.packager.info.config.files || []) {
    if (typeof fileSet !== 'object' || fileSet.from) continue;
    const filters = Array.isArray(fileSet.filter) ? fileSet.filter : [fileSet.filter];
    // A process can package multiple platforms; replace the previous target's filters.
    fileSet.filter = [
      ...filters.filter((filter) => filter && !filter.startsWith(prefix)),
      ...exclusions,
    ];
  }
};
