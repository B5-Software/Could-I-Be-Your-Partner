/* SPDX-License-Identifier: GPL-3.0-or-later */
// Native TUI/WebUI owner -> GUI activation, restored hidden GUI and tray lifetime.
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
app.disableHardwareAcceleration();
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-desktop-activation-'));
app.setPath('userData', profile);
fs.mkdirSync(path.join(profile, 'data'));
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    runtime: { location: 'host' },
    trayEnabled: false,
    aiPersona: { name: 'Activation fixture' },
    updates: { autoCheckEnabled: false },
    notifications: { enabled: false },
    voice: { wakeEnabled: false },
    closeToTray: 'never',
  }),
);
process.argv.push('--cibyp-headless');
global.fetch = async () => {
  throw Error('No external network in activation test');
};
const trays = [];
let preloadGate,
  preloadChecked = false;
let failSettings = true;
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  register(channel, async (event, ...args) => {
    if (
      (channel === 'settings:get' ||
        (channel === 'backend:request' && args[0] === 'getSettings')) &&
      event.sender.getURL().includes('/index.html')
    ) {
      preloadGate ||= (async () => {
        await new Promise((resolve) => setTimeout(resolve, 6500));
        const loading = BrowserWindow.fromWebContents(event.sender);
        assert(!loading.isVisible(), 'Slow settings loading must never bypass Splash');
        assert(
          BrowserWindow.getAllWindows().some((window) =>
            window.webContents.getURL().includes('/splash.html'),
          ),
        );
        preloadChecked = true;
      })();
      await preloadGate;
      if (failSettings) throw new Error('Fixture settings initialization failed');
    }
    return handler(event, ...args);
  });
class TestTray extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    trays.push(this);
  }
  setToolTip() {}
  setContextMenu(menu) {
    this.menu = menu;
  }
  destroy() {
    this.destroyed = true;
  }
}
const Module = require('node:module'),
  load = Module._load;
Module._load = function (request, ...args) {
  return request === 'electron'
    ? new Proxy(electron, { get: (target, name) => (name === 'Tray' ? TestTray : target[name]) })
    : load.call(this, request, ...args);
};
require('../../src/main/main');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw Error('Desktop activation timed out');
}
(async () => {
  const discovery = require('../../src/main/core/backend-discovery');
  await until(() => discovery.readBackend(profile));
  assert.equal(
    app.commandLine.hasSwitch('headless'),
    false,
    'Do not propagate the Chromium headless switch',
  );
  await until(() => trays.length === 1);
  assert.equal(
    BrowserWindow.getAllWindows().length,
    0,
    'Background owner creates no GUI initially',
  );
  assert.ok(trays[0].menu.items.some((item) => /退出|Quit|Beenden/.test(item.label)));
  const client = require('../../src/tui/backend-connect').clientFor(discovery.readBackend(profile));
  try {
    const originalPid = (await client.request('snapshot')).pid;
    const windows = [];
    let splashSeen = false;
    app.on('browser-window-created', (_event, window) => {
      window.setOpacity(0);
      window.setSkipTaskbar(true);
      windows.push(window);
      window.webContents.on('did-finish-load', () => {
        if (window.webContents.getURL().includes('/splash.html')) splashSeen = true;
      });
    });
    assert.equal((await client.request('desktop:open')).ok, true);
    const main = () =>
      windows.find(
        (window) => !window.isDestroyed() && window.webContents.getURL().includes('/index.html'),
      );
    const splash = () =>
      windows.find(
        (window) => !window.isDestroyed() && window.webContents.getURL().includes('/splash.html'),
      );
    await until(
      async () =>
        splash() &&
        splash().webContents.executeJavaScript('!document.getElementById("startupRetry").hidden'),
    );
    assert.equal(main().isVisible(), false, 'A failed preload keeps the main window hidden');
    assert.match(
      await splash().webContents.executeJavaScript(
        'document.getElementById("vmError").textContent',
      ),
      /Fixture settings initialization failed/,
    );
    failSettings = false;
    await splash().webContents.executeJavaScript('document.getElementById("startupRetry").click()');
    await until(() => main()?.isVisible());
    assert(preloadChecked, 'Settings readiness was tested beyond the previous forced-show timeout');
    assert.ok(splashSeen, 'GUI attachment retains Splash preload');
    assert.equal(await main().webContents.executeJavaScript('document.fonts.status'), 'loaded');
    assert.ok(
      await main().webContents.executeJavaScript(
        "!!window.__sessionManager.getActive('chat')?.agent?.backendKey",
      ),
      'Visible GUI has an attached chat view',
    );
    assert.equal(
      await main().webContents.executeJavaScript(
        "document.getElementById('agent-name-display').textContent",
      ),
      'Activation fixture',
    );
    main().hide();
    app.emit('second-instance', {}, ['cibyp', 'gui']);
    await until(() => main().isVisible());
    assert.equal(trays.length, 1, 'One owner, one tray across every frontend');
    assert.equal((await client.request('snapshot')).pid, originalPid);
    assert.equal(
      await main().webContents.executeJavaScript(
        '(async () => (await window.api.traySetEnabled(false)).settings.trayEnabled)()',
      ),
      true,
    );
    assert.equal(trays[0].destroyed, false);
    // Older, already-running TUI owners cannot remove their Chromium switch.
    // The launcher must attach a separate view with its own window lock instead.
    const metadataFile = discovery.fileFor(profile);
    const originalAddress = discovery.readBackend(profile);
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({ ...originalAddress, desktopCapable: undefined }),
    );
    const child = require('node:child_process').spawn(
      process.execPath,
      [path.resolve(__dirname, '../fixtures/frontend-client.cjs')],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          CIBYP_USER_DATA: profile,
          CIBYP_EXPECTED_BACKEND_PID: String(process.pid),
        },
      },
    );
    let childLog = '';
    child.stdout.on('data', (bytes) => {
      childLog += bytes;
    });
    child.stderr.on('data', (bytes) => {
      childLog += bytes;
    });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', (code) => reject(Error('Frontend exited: ' + code + '\n' + childLog)));
      });
      assert.equal(result.ok, true, result.error + '\n' + childLog);
      assert.equal(
        (await client.request('snapshot')).pid,
        originalPid,
        'Legacy attachment still shares the owner',
      );
      console.log('PASS legacy TUI owner -> separate configured GUI behind Splash');
    } finally {
      fs.writeFileSync(metadataFile, JSON.stringify(originalAddress));
      child.send('done');
    }
    console.log('PASS background owner -> Splash -> configured visible GUI, restore, shared tray');
  } finally {
    client.close();
  }
})().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
setTimeout(() => {
  console.error('Activation fixture timed out');
  app.exit(1);
}, 60000).unref();
