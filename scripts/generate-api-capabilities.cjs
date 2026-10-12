/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const channels = new Set();
for (const name of fs
  .readdirSync(path.join(root, 'src/preload'))
  .filter((v) => v === 'api-facade.js' || v.endsWith('-preload.js'))) {
  const source = fs.readFileSync(path.join(root, 'src/preload', name), 'utf8');
  for (const match of source.matchAll(/ipcRenderer\.(?:invoke|send)\(['"]([^'"]+)['"]/g))
    channels.add(match[1]);
}
const content = JSON.stringify([...channels].sort(), null, 2) + '\n';
const target = path.join(root, 'src/shared/ipc-capabilities.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== content)
    throw new Error('API capabilities changed; run node scripts/generate-api-capabilities.cjs');
} else fs.writeFileSync(target, content);
