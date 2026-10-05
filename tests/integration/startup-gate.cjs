/* Real App boot: preload UI first, initialize the Agent only after runtime selection. */
const electron = require('electron');
const { app, ipcMain, BrowserWindow } = electron;
const { EventEmitter } = require('node:events');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const order = process.argv.includes('--host-fallback')
  ? 'host-fallback'
  : process.argv.includes('--renderer-first')
    ? 'ui-first'
    : 'vm-first';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-startup-'));
fs.mkdirSync(path.join(profile, 'data'));
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    notifications: { enabled: false },
    runtime: { location: 'vm' },
    trayEnabled: true,
    closeToTray: 'never',
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
  }),
);
global.fetch = async () => {
  throw Error('No external network in startup check');
};
let releaseVM,
  vmReady = false,
  rendererReady = false,
  checkedEarly = false,
  workspaceCalls = 0;
const trays = [];
// Observe tray timing without creating a real icon in the user's system tray.
class TestTray extends EventEmitter {
  constructor() {
    super();
    assert(main().isVisible(), 'Tray must wait for the main window startup gate');
    assert(
      !BrowserWindow.getAllWindows().some((win) =>
        win.webContents.getURL().includes('/splash.html'),
      ),
      'Tray must wait for Splash to close',
    );
    this.destroyed = false;
    trays.push(this);
  }
  setToolTip() {}
  setContextMenu() {}
  destroy() {
    this.destroyed = true;
  }
}
const Module = require('node:module');
const originalLoad = Module._load;
const fixtureElectron = new Proxy(
  {},
  { get: (_target, name) => (name === 'Tray' ? TestTray : electron[name]) },
);
Module._load = function (request, ...args) {
  return request === 'electron' ? fixtureElectron : originalLoad.call(this, request, ...args);
};
const { VmService } = require('../../src/main/vm/vm-service');
// The real gate uses saved VM settings. These fixture file operations use host
// storage so boot sequencing can be verified independently of a QEMU image.
const runtime = Object.getOwnPropertyDescriptor(VmService.prototype, 'runtime').get;
Object.defineProperty(VmService.prototype, 'runtime', {
  get() {
    return { ...runtime.call(this), location: 'host' };
  },
});
VmService.prototype.start = async function () {
  if (order !== 'vm-first')
    await new Promise((resolve) => {
      releaseVM = resolve;
    });
  vmReady = true;
  this.emit('ready');
  return { ok: true };
};
const main = () =>
  BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('/index.html'));
const original = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  original(channel, async (event, ...args) => {
    if (channel === 'workspace:create') workspaceCalls++;
    if (channel === 'app:startup-runtime') {
      assert(!main().isVisible());
      assert(!rendererReady);
      assert.equal(workspaceCalls, 0, 'No guest workspace initialization before VM readiness');
      assert.equal(trays.length, 0, 'Startup must not create a tray');
      await event.sender.executeJavaScript(`(async () => {
        await window.api.traySetEnabled(false);
        await window.api.traySetEnabled(true);
        await window.api.trayShowWindow();
      })()`);
      assert(!main().isVisible(), 'Tray settings and restore cannot bypass startup');
      assert.equal(trays.length, 0, 'Enabling the tray during startup must be deferred');
      checkedEarly = true;
      const result = handler(event, ...args);
      if (order === 'ui-first') {
        assert(!vmReady);
        setTimeout(releaseVM, 250);
      }
      if (order === 'host-fallback') {
        assert(!vmReady);
        const splash = BrowserWindow.getAllWindows().find((win) =>
          win.webContents.getURL().includes('/splash.html'),
        );
        await splash.webContents.executeJavaScript('window.vmSplash.emergencyHostMode()');
      }
      return result;
    }
    return handler(event, ...args);
  });
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
});
const timer = setTimeout(() => finish(new Error('Startup gate timeout')), 20000);
ipcMain.once('app:renderer-ready', async (event) => {
  try {
    rendererReady = true;
    assert(checkedEarly);
    for (let i = 0; i < 100 && !main()?.isVisible(); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert(main().isVisible());
    for (let i = 0; i < 100 && !trays.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(trays.length, 1, 'Startup must create exactly one tray after Splash');
    await event.sender.executeJavaScript('window.api.traySetEnabled(false)');
    assert(trays[0].destroyed, 'Disabling the tray must destroy the icon');
    await event.sender.executeJavaScript('window.api.traySetEnabled(true)');
    await event.sender.executeJavaScript('window.api.traySetEnabled(true)');
    assert.equal(trays.length, 2, 'Enabling the tray must not create duplicate icons');
    const workspace = await event.sender.executeJavaScript('window.api.workspaceCreate()');
    assert.equal(workspace.ok, true, 'Workspace operations are available after the startup gate');
    assert(workspaceCalls > 0);
    if (order === 'host-fallback') {
      assert(!vmReady, 'Host startup must not wait for pending VM boot');
      assert.equal(
        (await event.sender.executeJavaScript('window.api.runtime.getLocation()')).location,
        'host',
      );
      releaseVM();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert(vmReady);
      assert.equal(
        (await event.sender.executeJavaScript('window.api.getSettings()')).runtime.location,
        'vm',
        'Host fallback must preserve the saved startup preference',
      );
      assert.equal(
        await event.sender.executeJavaScript(
          "window.__sessionManager.getActive('chat').agent.settings.runtime.location",
        ),
        'host',
        'Agent must use the effective host runtime even after late VM readiness',
      );
    } else assert(vmReady);
    assert.equal(await event.sender.executeJavaScript('document.fonts.status'), 'loaded');
    console.log(
      '[startup-gate] PASS:',
      order,
      'preloaded UI and correct runtime before Agent initialization',
    );
    finish();
  } catch (error) {
    finish(error);
  }
});
function finish(error) {
  clearTimeout(timer);
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
require('../../src/main/main');
