/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real renderer -> IPC -> CIBYP native Agent -> DSH provider. No network or private plugin dependency.
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-plugin-model-gui-'));
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
    automaticMemory: { enabled: false },
    decision: { enabled: false },
    llm: {
      provider: 'dsh:fixture',
      apiUrl: 'dsh-plugin://model',
      model: 'fixture-model',
      apiKey: '',
      streamResponses: true,
    },
  }),
);
const errors = [],
  requests = [];
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && /Uncaught|Initialization failed/.test(event.message))
      errors.push(event.message);
  });
});
require('../../src/main/net-proxy').install = () => {};
const realFetch = global.fetch;
global.fetch = (url, options) =>
  String(url).startsWith('http://127.0.0.1:')
    ? realFetch(url, options)
    : Promise.resolve(new Response('{}'));
require('undici').fetch = global.fetch;
const manager = require('../../src/main/ds-compat/plugin-manager');
const Original = manager.PluginManager;
manager.PluginManager = class FixtureManager extends Original {
  _public(record) {
    const value = super._public(record);
    return { ...value, config: {} };
  }
  init() {
    super.init();
    this.plugins.push({
      id: 'provider-fixture',
      name: 'cibyp-model-provider-fixture',
      version: '0.1.0',
      enabled: true,
      runtime: 'host',
      installDir: path.resolve(__dirname, '../fixtures/model-provider'),
      entry: path.resolve(__dirname, '../fixtures/model-provider/index.mjs'),
      config: {
        reply: 'Plugin provider GUI reply',
        onRequest: (request) => requests.push(request),
      },
    });
    return this;
  }
};
let finished = false;
const timeout = setTimeout(() => finish(new Error('Provider plugin GUI test timed out')), 45000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error('[model-provider-plugin] FAIL', error);
  else
    console.log(
      '[model-provider-plugin] PASS: plugin provider discovery, GUI/native Agent inference, subscription usage and screenshot',
    );
  app.exit(error ? 1 : 0);
}
ipcMain.once('app:renderer-ready', (event) =>
  setTimeout(async () => {
    try {
      await event.sender.executeJavaScript(`(async () => {
      const check = (v,m) => { if (!v) throw new Error(m); };
      const until = async fn => { const end=Date.now()+15000; while(!(await fn())) { if(Date.now()>end) throw new Error('Plugin GUI condition timed out'); await new Promise(r=>setTimeout(r,30)); } };
      await until(async()=> (await window.api.llmPluginProviders()).providers.some(p=>p.id==='dsh:fixture'));
      await window.navigatePage('settings'); window.activateSettingsTab('llm');
      document.getElementById('btn-pool-add').click();
      await until(()=>!document.getElementById('llm-pool-editor').classList.contains('hidden') && document.querySelector('#pool-edit-provider option[value="dsh:fixture"]'));
      const provider = document.getElementById('pool-edit-provider'); provider.value='dsh:fixture'; provider.dispatchEvent(new Event('change'));
      document.getElementById('btn-pool-edit-fetch').click();
      await until(()=>document.getElementById('pool-edit-model-select').options.length > 1);
      check(document.getElementById('pool-edit-url').closest('.setting-item').classList.contains('hidden'), 'Plugin provider must not request an API URL');
      document.getElementById('pool-edit-model').value='fixture-model'; document.getElementById('pool-edit-label').value='DSH provider plugin';
      document.getElementById('btn-pool-editor-save').click();
      await until(async()=> (await window.api.getSettings()).llm.pool.some(e=>e.provider==='dsh:fixture'));
      await window.navigatePage('chat'); const agent=window.__sessionManager.getActive('chat').agent;
      await agent.setMinimalMode(true); document.getElementById('chat-input').value='Use the optional DSH provider'; document.getElementById('btn-send').click();
      await until(()=>!agent.running && document.getElementById('chat-messages').textContent.includes('Plugin provider GUI reply'));
      const usage=await window.api.subscriptionUsage({provider:'dsh:fixture',includeWindows:true});
      check(usage.subscription && Math.abs(usage.windows[0].usedPercent-40)<0.01, 'Plugin subscription limits are not shared');
      await window.navigatePage('settings'); window.activateSettingsTab('llm'); document.getElementById('btn-pool-add').click();
      await until(()=>!document.getElementById('llm-pool-editor').classList.contains('hidden') && document.querySelector('#pool-edit-provider option[value="dsh:fixture"]'));
      document.getElementById('pool-edit-provider').value='dsh:fixture'; document.getElementById('pool-edit-provider').dispatchEvent(new Event('change')); document.getElementById('btn-pool-edit-fetch').click();
      await until(()=>document.getElementById('pool-edit-model-select').options.length>1);
      await new Promise(resolve=>setTimeout(resolve,650));
    })()`);
      assert.ok(requests.length > 0);
      assert.deepEqual(errors, []);
      const screenshot = path.resolve(
        __dirname,
        '../../.cache/screenshots/dsh-provider-model-pool.png',
      );
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      fs.writeFileSync(screenshot, (await event.sender.capturePage()).toPNG());
      finish();
    } catch (error) {
      finish(error);
    }
  }, 4000),
);
require('../../src/main/main.js');
