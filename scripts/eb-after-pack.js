/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * electron-builder afterPack 钩子：验证运行文件和安装包边界。
 */

'use strict';

module.exports = async function afterPack(context) {
  const fs = require('node:fs');
  const path = require('path');
  const asar = require('@electron/asar');
  const archive = path.join(context.packager.getResourcesDir(context.appOutDir), 'app.asar');
  const entries = new Set(asar.listPackage(archive).map((file) => file.split(path.sep).join('/')));
  const preloads = fs
    .readdirSync(path.join(__dirname, '../src/preload'))
    .filter((file) => file === 'preload.js' || file.endsWith('-preload.js'))
    .map((file) => `/src/preload/generated/${file}`);
  for (const required of [
    '/LICENSE',
    '/src/main/main.js',
    '/src/renderer/js/app.js',
    '/src/shared/generated/pricing.cjs',
    '/src/main/vm/generated/guest-tool-worker.cjs',
    ...preloads,
  ]) {
    if (!entries.has(required)) throw new Error(`Packaged runtime file missing: ${required}`);
  }
  if (
    context.electronPlatformName === 'darwin' &&
    !entries.has('/src/main/native/macos-computer/cibyp_computer.node')
  ) {
    throw new Error('Packaged macOS Computer Use native module missing');
  }
  const forbidden = [
    '/.git',
    '/tests',
    '/docs',
    '/vm-os',
    '/claude-code-ref',
    '/assets/voice-models',
    '/assets/geogebra-src',
    '/assets/aria2',
  ];
  for (const entry of entries) {
    if (forbidden.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`)))
      throw new Error(`Unexpected file in app package: ${entry}`);
  }
  console.log('[after-pack] Runtime files and package boundaries verified');
};
