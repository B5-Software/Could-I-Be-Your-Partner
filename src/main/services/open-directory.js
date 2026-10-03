/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs').promises;
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { hasGraphicalEnvironment } = require('../core/graphical-environment');

async function openDirectory(
  directory,
  {
    desktop = hasGraphicalEnvironment,
    run = promisify(execFile),
    platform = process.platform,
  } = {},
) {
  if (!(await desktop()))
    return { ok: false, code: 'NO_DESKTOP', error: 'No usable graphical desktop is available' };
  const target = path.resolve(directory);
  if (!(await fs.stat(target)).isDirectory())
    return { ok: false, error: 'Current workspace is not a directory' };
  if (platform === 'win32') {
    // Explorer commonly returns nonzero after handing a folder to an existing process.
    await run('explorer.exe', [target], { windowsHide: true }).catch((error) => {
      if (error.code === 'ENOENT') throw error;
    });
  } else
    await run(platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [target], { timeout: 10000 });
  return { ok: true, path: target };
}
module.exports = { openDirectory };
