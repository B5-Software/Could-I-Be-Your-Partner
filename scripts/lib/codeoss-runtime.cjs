/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

function verifyCodeOSSDependencies(directory) {
  const archive = path.join(directory, 'node_modules.asar');
  const modules = path.join(directory, 'node_modules');
  let count = 0;
  for (const entry of asar.listPackage(archive)) {
    const relative = entry.slice(1);
    const info = asar.statFile(archive, relative);
    if ('files' in info) continue;
    const target = path.resolve(modules, relative);
    const child = path.relative(modules, target);
    if (!child || child === '..' || child.startsWith('..' + path.sep) || path.isAbsolute(child))
      throw new Error('Unsafe Code-OSS dependency path');
    const file = fs.statSync(target, { throwIfNoEntry: false });
    // Platform signing can grow an unpacked native binary after ASAR creation.
    const expectedSize = info.unpacked
      ? fs.statSync(path.join(archive + '.unpacked', relative)).size
      : info.size;
    if (!file?.isFile() || file.size !== expectedSize)
      throw new Error(`Code-OSS dependency missing or incomplete: node_modules/${relative}`);
    count++;
  }
  return count;
}

function materializeCodeOSSDependencies(directory) {
  // Electron's CJS resolver understands node_modules.asar. Native ESM package
  // resolution does not, so a standalone installation needs physical modules.
  asar.extractAll(path.join(directory, 'node_modules.asar'), path.join(directory, 'node_modules'));
  return verifyCodeOSSDependencies(directory);
}

module.exports = { materializeCodeOSSDependencies, verifyCodeOSSDependencies };
