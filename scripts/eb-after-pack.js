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
  const codeoss = path.join(context.packager.getResourcesDir(context.appOutDir), 'codeoss/app');
  const lock = require('../integrations/codeoss/runtime-lock.json');
  for (const file of [
    'out/main.js',
    'out/vs/workbench/workbench.desktop.main.js',
    'product.json',
    'extensions/cibyp-workbench/dist/extension.cjs',
    'extensions/git/package.json',
    'node_modules.asar',
  ]) {
    if (!fs.existsSync(path.join(codeoss, file)))
      throw new Error(`Packaged Code-OSS file missing: ${file}`);
  }
  const marker = JSON.parse(fs.readFileSync(path.join(codeoss, 'cibyp-runtime.json'), 'utf8'));
  if (
    marker.commit !== lock.commit ||
    marker.platform !== context.electronPlatformName ||
    marker.arch !== require('builder-util').Arch[context.arch]
  )
    throw new Error('Packaged Code-OSS target or version does not match the host');
  const product = JSON.parse(fs.readFileSync(path.join(codeoss, 'product.json'), 'utf8'));
  const checksum = require('node:crypto')
    .createHash('sha256')
    .update(fs.readFileSync(path.join(codeoss, 'out/vs/workbench/workbench.desktop.main.js')))
    .digest('base64')
    .replace(/=+$/, '');
  if (product.checksums['vs/workbench/workbench.desktop.main.js'] !== checksum)
    throw new Error('Packaged Code-OSS integrity metadata does not match its patched workbench');
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
