/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { hasGraphicalEnvironment } = require('../main/core/graphical-environment');

function startTerminal(args, root) {
  process.argv = [process.execPath, path.join(root, 'bin/cibyp-tui.js'), ...args];
  require(path.join(root, 'bin/cibyp-tui.js'));
}

async function launch(
  mode,
  args,
  {
    resources,
    executable,
    graphical = hasGraphicalEnvironment,
    spawnProcess = spawn,
    startTui = startTerminal,
  } = {},
) {
  const root = path.resolve(__dirname, '../..');
  if (resources) {
    process.env.CIBYP_PACKAGED_RESOURCES = resources;
    process.env.CIBYP_ELECTRON_EXECUTABLE = executable;
    process.resourcesPath = resources;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(require('../../package.json').version.split('+')[0]);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`CIBYP

  cibyp               Start the graphical App; use TUI when no desktop is available
  cibyp-tui           Start the terminal interface
  cibyp-tui --mode=code --workspace=/path

GUI and TUI share settings and cannot run at the same time.
Use /help, /sessions and /workspace inside TUI.`);
    return;
  }
  if (
    mode === 'tui' ||
    args.includes('--tui') ||
    args.includes('--headless') ||
    !(await graphical())
  ) {
    startTui(args, root);
    return;
  }
  const target = executable || require('electron');
  await new Promise((resolve, reject) => {
    const keepMounted = !!process.env.APPIMAGE;
    const child = spawnProcess(target, resources ? args : [root, ...args], {
      detached: !keepMounted,
      stdio: keepMounted ? 'inherit' : 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    child.once('error', reject);
    if (keepMounted)
      child.once('exit', (code) => {
        process.exitCode = code || 0;
        resolve();
      });
    else
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
  });
}

module.exports = { launch };
