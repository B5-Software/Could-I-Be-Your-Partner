/* Full app startup with a temporary profile. No access to the user's credentials. */
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-desktop-smoke-'));
fs.mkdirSync(path.join(profile, 'data'), { recursive: true });
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    runtime: { location: 'host' },
    closeToTray: 'never',
    trayEnabled: false,
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
  }),
);

// A smoke check must not call external providers or download resources.
global.fetch = async () => {
  throw new Error('Network disabled in desktop smoke check');
};
const errors = [];
app.on('browser-window-created', (_event, window) => {
  window.on('show', () => window.hide());
  window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  window.webContents.on('render-process-gone', (_event, details) =>
    errors.push(`Renderer terminated: ${details.reason}`),
  );
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' && /Uncaught|Initialization failed/.test(event.message))
      errors.push(event.message);
  });
});

const timeout = setTimeout(
  () => finish(new Error('Renderer did not become ready within 45 seconds')),
  45000,
);
ipcMain.once('app:renderer-ready', (event) => {
  setTimeout(async () => {
    try {
      const state = await event.sender.executeJavaScript(`(async () => ({
        hasBridge: typeof window.api?.getSettings === 'function',
        settings: await window.api.getSettings(),
        title: document.title,
        hasChat: !!document.getElementById('chat-messages'),
        nodeProcess: typeof window.process,
      }))()`);
      assert.equal(state.hasBridge, true);
      assert.equal(state.nodeProcess, 'undefined');
      assert.equal(state.settings.runtime.location, 'host');
      assert.equal(event.sender.getLastWebPreferences().sandbox, true);
      assert.equal(event.sender.getLastWebPreferences().nodeIntegration, false);
      assert.equal(event.sender.getLastWebPreferences().contextIsolation, true);
      assert.equal(
        BrowserWindow.getAllWindows().some((window) => window.webContents === event.sender),
        true,
      );
      assert.deepEqual(errors, []);
      finish();
    } catch (error) {
      finish(error);
    }
  }, 500);
});

let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error('[desktop-smoke] FAIL:', error.stack, errors);
  else
    console.log('[desktop-smoke] PASS: full app boot, isolated IPC bridge and sandboxed renderer');
  // Keep failure evidence; successful profiles can be removed after Electron exits.
  console.log('[desktop-smoke] profile:', profile);
  app.exit(error ? 1 : 0);
}

try {
  require('../../src/main/main.js');
} catch (error) {
  finish(error);
}
