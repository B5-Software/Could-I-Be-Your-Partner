/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * electron-builder afterPack 钩子：恢复构建入口（scripts/package.js）临时移出的内容，兜底防止遗留。
 */

'use strict';

module.exports = async function afterPack() {
  const path = require('path');
  const fs = require('fs');
  const root = path.resolve(__dirname, '..');
  const stash = path.join(path.dirname(root), '.cibyp-pack-hide');
  if (!fs.existsSync(stash)) return;
  for (const name of fs.readdirSync(stash)) {
    const rel = name.replace(/__/g, '/');
    const dst = path.join(root, rel);
    try {
      if (!fs.existsSync(dst)) {
        fs.renameSync(path.join(stash, name), dst);
        console.log('[after-pack] 恢复:', rel);
      }
    } catch { /* ignore */ }
  }
};
