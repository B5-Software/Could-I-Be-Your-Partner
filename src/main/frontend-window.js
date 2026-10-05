/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// A pure Node owner already provides the Agent, VM and tools. Electron attaches
// a native window without constructing a second copy of those services.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
async function startFrontend(address) {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  const client = require('../tui/backend-connect').clientFor(address);
  const snapshot = await client.connect();
  if (snapshot.pid !== address.pid) throw new Error('The shared backend changed; restart the client');
  await app.whenReady();
  const pages = path.join(__dirname, '../renderer/pages');
  const preloads = path.join(__dirname, '../preload/generated');
  const security = require('./core/window-security').createWindowSecurity({ pagesDirectory: pages, pageNames: ['index.html', 'splash.html'], preloadDirectory: preloads });
  const window = new BrowserWindow({ width: 1280, height: 860, minWidth: 720, minHeight: 480, frame: false, show: false,
    webPreferences: { preload: path.join(preloads, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  security.protectWebContents(window.webContents);
  let splash, rendererReady = false, bootReady = snapshot.boot?.ready !== false;
  function showWhenReady() {
    if (!rendererReady || !bootReady || window.isDestroyed()) return;
    if (splash && !splash.isDestroyed()) splash.destroy();
    splash = null; window.show();
  }
  if (!bootReady) {
    splash = new BrowserWindow({ width: 420, height: 420, frame: false, show: false, resizable: false, transparent: true,
      webPreferences: { preload: path.join(preloads, 'splash-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    security.protectWebContents(splash.webContents);
    splash.once('ready-to-show', () => { if (splash && !splash.isDestroyed()) splash.show(); });
  }
  const send = (channel, payload) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
    if (splash && !splash.isDestroyed()) splash.webContents.send(channel, payload);
  };
  const picker = require('../shared/client-file-picker').createClientFilePicker((channel, ...args) => client.request('ipc:invoke', channel, ...args), send);
  const remote = require('./core/remote-backend').createRemoteBackend();
  client.onEvent(event => {
    if (remote.has(window.webContents)) return;
    if (event.channel) send(event.channel, event.payload);
    else if (event.type === 'snapshot') send('backend:reconnected', event.snapshot);
    else if (event.type === 'connection') send('backend:connection', event);
  });
  const bootTimer = setInterval(() => {
    if (bootReady) { clearInterval(bootTimer); return; }
    client.request('boot:state').then(state => { bootReady = !!state.ready; showWhenReady(); }).catch(client.onError);
  }, 400);
  bootTimer.unref();
  const source = fs.readFileSync(path.join(__dirname, '../preload/preload.js'), 'utf8');
  const channels = new Set([...source.matchAll(/ipcRenderer\.(?:invoke|send)\(['"]([^'"]+)['"]/g)].map(m => m[1]));
  async function local(event, channel, args) {
    if (channel === 'window:minimize') return window.minimize();
    if (channel === 'window:maximize') return window.isMaximized() ? window.unmaximize() : window.maximize();
    if (channel === 'window:close') return window.close();
    if (channel === 'window:isMaximized') return window.isMaximized();
    if (channel === 'app:renderer-ready') { rendererReady = true; showWhenReady(); return null; }
    if (channel === 'backend:remote-status') return remote.status(event.sender);
    if (channel === 'backend:remote-connect') return remote.connect(event.sender, args[0]);
    if (channel === 'backend:remote-disconnect') return remote.disconnect(event.sender);
    if (channel === 'codeoss:layout') return null;
    if (picker.handles(channel)) return picker.invoke(channel, ...args);
    if (channel === 'codeoss:open') {
      const result = await client.request('ipc:invoke', 'codeoss:open-web', ...args);
      return { ...result, webUrl: result.webUrl ? new URL(result.webUrl, client.url).href : undefined };
    }
    if (channel === 'backend:request') return client.request(...args);
    return client.request('ipc:invoke', channel, ...args);
  }
  for (const channel of channels) {
    const handler = remote.route(channel, (event, ...args) => local(event, channel, args));
    const valid = event => security.validateSender(event) && (event.sender === window.webContents || event.sender === splash?.webContents);
    ipcMain.handle(channel, (event, ...args) => { if (!valid(event)) throw Error('Unknown frontend'); return handler(event, ...args); });
    ipcMain.on(channel, (event, ...args) => { if (valid(event)) Promise.resolve(handler(event, ...args)).catch(client.onError); });
  }
  window.once('closed', () => { clearInterval(bootTimer); splash?.destroy(); picker.close(); remote.close(); client.close(); app.quit(); });
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); if (rendererReady && bootReady) window.show(); window.focus(); });
  if (splash) await splash.loadFile(path.join(pages, 'splash.html'));
  await window.loadFile(path.join(pages, 'index.html'));
  return window;
}
module.exports = { startFrontend };
