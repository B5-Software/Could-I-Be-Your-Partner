/* SPDX-License-Identifier: GPL-3.0-or-later */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-shared-backend-'));
fs.mkdirSync(path.join(profile, 'data'));
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    runtime: { location: 'host' },
    trayEnabled: false,
    closeToTray: 'never',
    notifications: { enabled: false },
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    llm: {
      provider: 'openai-compat',
      apiUrl: 'http://stub.local/v1',
      apiKey: 'test',
      model: 'test',
      streamResponses: false,
      maxContextLength: 32768,
      maxResponseTokens: 1024,
    },
  }),
);
process.env.CIBYP_WEB_PASSWORD = 'shared-backend-test';
process.argv.push('--web');
let calls = 0;
const realFetch = global.fetch;
require('undici').fetch = async (url, options) => {
  if (String(url).includes('stub.local')) {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 160));
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        choices: [
          {
            message: { role: 'assistant', content: 'Shared backend reply' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      text: async () => '',
    };
  }
  if (/^http:\/\/127\.0\.0\.1:/.test(String(url))) return realFetch(url, options);
  throw new Error('External network disabled');
};
// Use the real updater and RPC/event flow with a harmless verified download.
const { AppUpdates } = require('../../src/main/services/app-updates');
const prepare = AppUpdates.prototype.prepare;
const updateBytes = Buffer.from('integration fixture, never executed');
let downloads = 0;
AppUpdates.prototype.prepare = function () {
  this.json = async () => [
    {
      tag_name: 'v999.0.0',
      assets: [
        {
          name: 'Could I Be Your Partner Setup 999.0.0-x64.exe',
          size: updateBytes.length,
          digest: 'sha256:' + crypto.createHash('sha256').update(updateBytes).digest('hex'),
          browser_download_url:
            'https://github.com/B5-Software/Could-I-Be-Your-Partner/releases/download/v999.0.0/update.exe',
        },
      ],
    },
  ];
  this.platform = 'win32';
  this.arch = 'x64';
  this.download = async (_asset, file, options) => {
    downloads++;
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(file, updateBytes);
    options.onProgress({
      downloaded: updateBytes.length,
      total: updateBytes.length,
      verified: true,
    });
  };
  return prepare.call(this);
};
const main = require('../../src/main/main');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });
});
(async () => {
  try {
    await app.whenReady();
    await until(() => main.getBackend(), 'backend');
    const local = require('../../src/main/core/backend-discovery').readBackend(profile);
    const { clientFor } = require('../../src/tui/backend-connect');
    const client = clientFor(local);
    const runtime = await require('../../src/tui/backend-runtime').createBackendRuntime(client);
    const gui = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith('/index.html'),
    );
    await until(
      () => gui?.webContents.executeJavaScript('!!window.__sessionManager?.list("chat").length'),
      'GUI ready',
    );
    const key = await gui.webContents.executeJavaScript(
      'window.__sessionManager.getActive("chat").agent.backendKey',
    );
    assert.ok(runtime.getSession(key));
    const status = await client.request('ipc:invoke', 'webControl:getStatus');
    assert.equal(status.backendPid, process.pid);
    assert.ok(status.running);
    const web = new BrowserWindow({
      show: false,
      width: 1440,
      height: 980,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'webui-integration',
      },
    });
    await web.loadURL(status.url + '/login');
    await web.webContents.executeJavaScript(
      `document.querySelector('#password').value='shared-backend-test';document.querySelector('form').requestSubmit();`,
    );
    await until(() => web.webContents.getURL().includes('/index.html'), 'WebUI navigation');
    await until(
      () => web.webContents.executeJavaScript('!!window.__sessionManager?.list("chat").length'),
      'WebUI ready',
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        'window.__sessionManager.getActive("chat").agent.backendKey',
      ),
      key,
    );
    const settings = await runtime.saveSettings({
      theme: { mode: 'light', accentColor: '#4455cc', backgroundColor: '#f5f5fa' },
    });
    assert.equal(settings.theme.accentColor, '#4455cc');
    assert.equal(
      (await web.webContents.executeJavaScript('window.api.getSettings()')).theme.accentColor,
      '#4455cc',
    );
    await runtime.sendMessage(key, 'Hello from the TUI client');
    await until(
      () =>
        web.webContents.executeJavaScript(
          'document.querySelector("#chat-messages").textContent.includes("Shared backend reply")',
        ),
      'WebUI message',
    );
    assert.ok(
      (
        await gui.webContents.executeJavaScript(
          'window.__sessionManager.getActive("chat").agent.contextManager.getHistoryMessages()',
        )
      ).some((m) => m.content === 'Shared backend reply'),
    );
    const updateEvents = [];
    const unsubscribe = runtime.onEvent((event) => {
      if (event.type === 'update') updateEvents.push(event.state);
    });
    await Promise.all([
      runtime.api.updatesStart(),
      web.webContents.executeJavaScript('window.api.updatesStart()'),
    ]);
    await until(
      () => web.webContents.executeJavaScript('!!document.querySelector(".app-update-notice")'),
      'browser update reminder',
    );
    await until(
      () => gui.webContents.executeJavaScript('!!document.querySelector(".app-update-notice")'),
      'GUI update reminder',
    );
    await until(() => updateEvents.some((state) => state.phase === 'ready'), 'TUI update reminder');
    assert.equal(downloads, 1, 'all clients share one download');
    const screenshots = path.resolve(__dirname, '../../.cache/screenshots');
    fs.mkdirSync(screenshots, { recursive: true });
    await pause(500);
    assert.equal(
      await web.webContents.executeJavaScript(
        `(() => { const r=document.querySelector('.app-update-notice').getBoundingClientRect(); return r.width>0 && r.height>0 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })()`,
      ),
      true,
      'update reminder must be visibly inside the viewport',
    );
    fs.writeFileSync(
      path.join(screenshots, 'update-ready-webui.png'),
      (await web.webContents.capturePage()).toPNG(),
    );
    assert.equal((await runtime.api.updatesStatus()).phase, 'ready');
    const restored = new AppUpdates({ app, settings: () => ({}), publish() {} });
    await restored.restore();
    assert.equal(restored.status().phase, 'ready', 'verified download survives restart');
    unsubscribe();
    // Main services survive closing the GUI; the browser still sends a new turn.
    gui.destroy();
    await web.webContents.executeJavaScript(
      `document.querySelector('#chat-input').value='Continue without GUI';document.querySelector('#btn-send').click();`,
    );
    await until(() => runtime.getSession(key)?.busy, 'browser turn');
    await until(() => !runtime.getSession(key)?.busy, 'browser completed');
    assert.equal(main.getAgentRuntime().sessions.size, 1);
    assert.ok(calls >= 2);
    const selectedFile = path.join(profile, 'documents', 'selected.txt');
    fs.writeFileSync(selectedFile, 'selected by browser');
    const count = BrowserWindow.getAllWindows().length;
    await web.webContents.executeJavaScript(
      `window.__pickerPromise = window.api.openFileDialog({defaultPath:${JSON.stringify(path.dirname(selectedFile))},properties:['openFile']}); void 0;`,
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          '!!document.querySelector("dialog.vm-file-dialog-modal[open]")',
        ),
      'client-owned picker',
    );
    const bounds = await web.webContents.executeJavaScript(
      `(() => { const r=document.querySelector('dialog.vm-file-dialog-modal').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight}; })()`,
    );
    assert.ok(
      Math.abs(bounds.x + bounds.w / 2 - bounds.vw / 2) < 2,
      'picker horizontally centered',
    );
    assert.ok(Math.abs(bounds.y + bounds.h / 2 - bounds.vh / 2) < 2, 'picker vertically centered');
    await web.webContents.executeJavaScript(
      `document.querySelector('dialog #filename').value='selected.txt';document.querySelector('dialog #choose').click();`,
    );
    const selected = await web.webContents.executeJavaScript('window.__pickerPromise');
    assert.equal(selected.ok, true);
    assert.equal(path.resolve(selected.paths[0]), selectedFile);
    assert.equal(
      BrowserWindow.getAllWindows().length,
      count,
      'picker does not create a native window',
    );
    console.log(
      '[shared-backend] Shared runtime, one verified update and client-owned centered file picker passed.',
    );
    console.log('[shared-backend] Browser errors:', errors);
    client.close();
    web.destroy();
    app.quit();
  } catch (error) {
    console.error('[shared-backend] FAIL', error.stack, errors);
    app.exit(1);
  }
})();
