/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAppPaths } = require('./electron-shim');
const { readBackend } = require('../main/core/backend-discovery');
const { BackendClient } = require('../shared/backend-client');

function clientFor(address) {
  return new BackendClient({
    ...address,
    socketFactory: (url, token) =>
      new (require('ws'))(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }),
    onError: (error) => console.error('[backend]', error.message),
  });
}
async function existingBackend(userData) {
  const address = readBackend(userData);
  if (!address) return null;
  const client = clientFor(address);
  try {
    const snapshot = await client.request('snapshot');
    return snapshot.pid === address.pid ? client : null;
  } catch {
    client.close();
    return null;
  }
}

async function ensureBackend(args = [], { spawnProcess = spawn } = {}) {
  const userData = createAppPaths().userData;
  const existing = await existingBackend(userData);
  if (existing) return existing;
  const root = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
  const log = fs.openSync(path.join(userData, 'logs/backend.log'), 'a');
  const graphical = await require('../main/core/graphical-environment').hasGraphicalEnvironment();
  const electron =
    process.env.CIBYP_ELECTRON_EXECUTABLE || (graphical ? require('electron') : null);
  const flags = ['--headless', '--backend-owner', ...args.filter((a) => a === '--web')];
  const executable = electron || process.execPath;
  const command = electron
    ? process.env.CIBYP_PACKAGED_RESOURCES
      ? flags
      : [root, ...flags]
    : [path.join(root, 'src/tui/node-entry.js'), ...flags];
  const child = spawnProcess(executable, command, {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      CIBYP_USER_DATA: userData,
      ELECTRON_RUN_AS_NODE: electron ? undefined : process.env.ELECTRON_RUN_AS_NODE,
    },
  });
  let failure;
  child.once('error', (error) => {
    failure = error;
  });
  child.once('exit', (code) => {
    if (code)
      failure = new Error(
        'Backend exited with code ' + code + '. See ' + path.join(userData, 'logs/backend.log'),
      );
  });
  child.unref();
  fs.closeSync(log);
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    if (failure) throw failure;
    const client = await existingBackend(userData);
    if (client) return client;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Backend startup timed out. See ' + path.join(userData, 'logs/backend.log'));
}

async function launchClient(args, webOnly = false) {
  const client = await ensureBackend(args);
  if (webOnly || args.includes('--headless')) {
    const result = await client.request('ipc:invoke', 'webControl:start');
    client.close();
    if (!result.ok) throw new Error(result.error);
    console.log('CIBYP WebUI: ' + result.url);
    return;
  }
  const runtime = await require('./backend-runtime').createBackendRuntime(client);
  if (args.includes('--web')) await client.request('ipc:invoke', 'webControl:start');
  // Importing the terminal view doesn't load main.js, the VM, LLM providers,
  // browser automation, or native desktop services a second time.
  return require('./launch').startTui({
    runtime,
    argv: [process.execPath, 'cibyp-tui', ...args],
    getBootState: () => runtime.boot,
    onExit: (code) => {
      runtime.dispose();
      process.exitCode = code || 0;
    },
  });
}
module.exports = { ensureBackend, launchClient, existingBackend, clientFor };
