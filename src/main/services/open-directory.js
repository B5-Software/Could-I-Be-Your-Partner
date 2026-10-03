/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs').promises;
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { hasGraphicalEnvironment } = require('../core/graphical-environment');

async function openDirectory(
  directory,
  {
    desktop = hasGraphicalEnvironment,
    run = promisify(execFile),
    spawnProcess = spawn,
    platform = process.platform,
  } = {},
) {
  if (!(await desktop()))
    return { ok: false, code: 'NO_DESKTOP', error: 'No usable graphical desktop is available' };
  const target = path.resolve(directory);
  if (!(await fs.stat(target)).isDirectory())
    return { ok: false, error: 'Current workspace is not a directory' };
  if (platform === 'win32') {
    // Explorer can stay alive indefinitely, or exit nonzero after handing off
    // to an existing process. Wait for launch, not exit, and show its window.
    await new Promise((resolve, reject) => {
      const child = spawnProcess('explorer.exe', [target], {
        windowsHide: false,
        detached: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  } else
    await run(platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [target], { timeout: 10000 });
  return { ok: true, path: target };
}
module.exports = { openDirectory };
