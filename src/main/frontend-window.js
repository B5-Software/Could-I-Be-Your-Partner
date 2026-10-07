/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Attach to a pure Node or legacy owner without duplicating the Agent or VM.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
async function startFrontend(address) {
  // Legacy Electron TUI owners used Chromium's --headless switch. Attach a
  // window in a separate client profile instead of asking that process to show
  // an invisible native window. Agent services and VM still belong to the owner.
  if (address.native) {
    const profile = path.join(app.getPath('userData'), 'desktop-client');
    fs.mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile);
  }
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  const client = require('../tui/backend-connect').clientFor(address);
  const snapshot = await client.connect();
  if (snapshot.pid !== address.pid) throw new Error('The shared backend changed; restart the client');
  const settings = await client.request('getSettings');
  await app.whenReady();
  const pages = path.join(__dirname, '../renderer/pages');
  const preloads = path.join(__dirname, '../preload/generated');
  const security = require('./core/window-security').createWindowSecurity({ pagesDirectory: pages, pageNames: ['index.html', 'splash.html'], preloadDirectory: preloads });
  const window = new BrowserWindow({ width: 1280, height: 860, minWidth: 720, minHeight: 480, frame: false, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(preloads, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  security.protectWebContents(window.webContents);
  let splash, rendererReady = false, bootReady = snapshot.boot?.ready !== false;
  let startupTimer;
  const reportStartupFailure = message => {
    if (!rendererReady && splash && !splash.isDestroyed()) splash.webContents.send('app:startup-failed', { message });
  };
  const armStartupTimer = () => {
    clearTimeout(startupTimer);
    startupTimer = setTimeout(() => reportStartupFailure('The application did not finish loading. Retry initialization or close the window.'), 30000);
  };
  function showWhenReady() {
    if (!rendererReady || !bootReady || window.isDestroyed()) return;
    clearTimeout(startupTimer);
    if (splash && !splash.isDestroyed()) splash.destroy();
    splash = null; window.show();
  }
  {
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
  const source = ['preload.js', 'splash-preload.js'].map(file => fs.readFileSync(path.join(__dirname, '../preload', file), 'utf8')).join('\n');
  const channels = new Set([...source.matchAll(/ipcRenderer\.(?:invoke|send)\(['"]([^'"]+)['"]/g)].map(m => m[1]));
  const invokeChannels = new Set([...source.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map(m => m[1]));
  async function local(event, channel, args) {
    if (channel === 'window:minimize') return window.minimize();
    if (channel === 'window:maximize') return window.isMaximized() ? window.unmaximize() : window.maximize();
    if (channel === 'window:close') return window.close();
    if (channel === 'window:isMaximized') return window.isMaximized();
    if (channel === 'app:renderer-ready') { rendererReady = true; showWhenReady(); return null; }
    if (channel === 'app:renderer-failed') { reportStartupFailure(String(args[0]).slice(0, 4000)); return null; }
    if (channel === 'app:startup-retry') { rendererReady = false; armStartupTimer(); window.reload(); return { ok: true }; }
    if (channel === 'app:startup-close') { window.destroy(); return { ok: true }; }
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
    return client.request(invokeChannels.has(channel) ? 'ipc:invoke' : 'ipc:send', channel, ...args);
  }
  for (const channel of channels) {
    const handler = remote.route(channel, (event, ...args) => local(event, channel, args), { send: !invokeChannels.has(channel) });
    const valid = event => security.validateSender(event) && (event.sender === window.webContents || event.sender === splash?.webContents);
    ipcMain.handle(channel, (event, ...args) => { if (!valid(event)) throw Error('Unknown frontend'); return handler(event, ...args); });
    ipcMain.on(channel, (event, ...args) => { if (valid(event)) Promise.resolve(handler(event, ...args)).catch(client.onError); });
  }
  window.once('closed', () => { clearInterval(bootTimer); clearTimeout(startupTimer); splash?.destroy(); picker.close(); remote.close(); client.close(); app.quit(); });
  app.on('second-instance', () => { if (rendererReady && bootReady) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } else { splash?.show(); splash?.focus(); } });
  if (splash) {
    const theme = settings.theme || {};
    const dark = theme.mode === 'dark' || (theme.mode !== 'light' && require('electron').nativeTheme.shouldUseDarkColors);
    const accent = /^#[\da-f]{6}$/i.test(theme.accentColor || '') ? theme.accentColor : '#4f8cff';
    const bg = /^#[\da-f]{6}$/i.test(theme.backgroundColor || '') ? theme.backgroundColor : dark ? '#17181d' : '#f5f7fa';
    await splash.loadFile(path.join(pages, 'splash.html'), { query: { dark: dark ? '1' : '0', accent: accent.slice(1), bg: bg.slice(1), language: settings.language || 'zh', version: app.getVersion() } });
    splash.webContents.send('vm:init', { vmMode: !bootReady });
  }
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) reportStartupFailure(description); });
  window.webContents.on('render-process-gone', (_event, detail) => reportStartupFailure(detail.reason));
  armStartupTimer();
  await window.loadFile(path.join(pages, 'index.html'));
  return window;
}
module.exports = { startFrontend };
