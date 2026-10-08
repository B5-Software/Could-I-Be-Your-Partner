/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
// These packages drive an entire application, rather than extend a capability.
// Refuse before import: their module-level startup must never claim our process.
const APPLICATIONS =
  /^(?:@deepseek-ai\/)?(?:dsh-)?(?:app(?:-.*)?|agent-loop|launcher(?:-.*)?|(?:cc|acp|web|sdk)-app|cc-tui|tui|cli|host-frontend(?:-.*)?)$/;
async function entryRefusal(entry, meta = {}) {
  const names = [meta.name];
  let directory = path.dirname(path.resolve(entry));
  for (let depth = 0; depth < 8; depth++) {
    try {
      names.push(JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')).name);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const blocked = names.find((name) => typeof name === 'string' && APPLICATIONS.test(name));
  return blocked
    ? `CIBYP owns application startup and Agent driving; ${blocked} is an application entry, not a supported extension. Install its capability plugins separately.`
    : undefined;
}
module.exports = { entryRefusal };
