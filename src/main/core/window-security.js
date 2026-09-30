/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

function createWindowSecurity({
  pagesDirectory,
  pageNames,
  preloadDirectory,
  platform = process.platform,
}) {
  const normalize = (file) =>
    platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const trustedPages = new Set(pageNames.map((name) => normalize(path.join(pagesDirectory, name))));
  function isTrustedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'file:' && trustedPages.has(normalize(fileURLToPath(url)));
    } catch {
      return false;
    }
  }
  function validateSender(event) {
    try {
      const frame = event.senderFrame;
      return (
        !!frame &&
        !event.sender.isDestroyed() &&
        frame === event.sender.mainFrame &&
        isTrustedUrl(frame.url)
      );
    } catch {
      return false;
    }
  }
  function protectWebContents(contents) {
    const preload = contents.getLastWebPreferences().preload;
    if (!preload) return;
    const relative = path.relative(preloadDirectory, preload);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  }
  return { isTrustedUrl, validateSender, protectWebContents };
}

module.exports = { createWindowSecurity };
