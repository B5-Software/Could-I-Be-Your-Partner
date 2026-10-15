/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real GUI -> IPC -> account manager -> SDK adapter. Isolated fake login/provider.
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
app.disableHardwareAcceleration();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-claude-gui-'));
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
      provider: 'claude-subscription',
      apiUrl: 'claude-sdk://subscription',
      model: 'sonnet',
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
const service = require('../../src/main/services/claude-accounts');
const OriginalAccounts = service.ClaudeAccounts;
service.ClaudeAccounts = class FixtureClaudeAccounts extends OriginalAccounts {
  constructor(options) {
    super({
      ...options,
      executablePath: () => '/official-fixture/claude',
      spawnImpl: (_file, args, config) => {
        assert.equal(config.env.ANTHROPIC_API_KEY, undefined);
        assert.ok(config.cwd.startsWith(profile));
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => child.emit('close', 1);
        setTimeout(() => {
          if (args[1] === 'login')
            child.stdout.write('https://claude.ai/oauth/authorize?state=isolated-fixture\n');
          if (args[1] === 'status')
            child.stdout.write(
              JSON.stringify({
                loggedIn: true,
                authMethod: 'claude.ai',
                subscriptionType: 'pro',
                email: 'fixture@example.invalid',
              }),
            );
          child.emit('close', 0);
        }, 40);
        return child;
      },
      sdkLoader: async () => {
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        return {
          ...sdk,
          query: (config) => {
            assert.deepEqual(config.options.tools, []);
            assert.equal(config.options.env.ANTHROPIC_API_KEY, undefined);
            const iterator = (async function* () {
              const prompt = await config.prompt.next();
              requests.push(prompt.value.message);
              yield {
                type: 'rate_limit_event',
                rate_limit_info: {
                  status: 'allowed',
                  rateLimitType: 'five_hour',
                  utilization: 0.2,
                },
              };
              yield {
                type: 'stream_event',
                event: { delta: { type: 'text_delta', text: 'Claude subscription fixture reply' } },
              };
              yield {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: 'Claude subscription fixture reply' }],
                  usage: { input_tokens: 20, output_tokens: 5 },
                },
              };
            })();
            iterator.supportedModels = async () => [
              { value: 'sonnet', displayName: 'Claude Sonnet', description: 'Fixture model' },
            ];
            iterator.close = () => {};
            return iterator;
          },
        };
      },
    });
  }
};
let done = false;
const timeout = setTimeout(() => finish(new Error('Claude GUI integration timed out')), 45000);
function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timeout);
  if (error) console.error('[claude-subscription] FAIL:', error);
  else
    console.log(
      '[claude-subscription] PASS: GUI login, model pool, subscription inference/usage, reauthorization and isolated logout',
    );
  app.exit(error ? 1 : 0);
}
ipcMain.once('app:renderer-ready', (event) =>
  setTimeout(async () => {
    try {
      await event.sender.executeJavaScript(`(async () => {
      const check = (value, message) => { if (!value) throw new Error(message); };
      const until = async predicate => { const end = Date.now()+10000; while (!(await predicate())) { if (Date.now()>end) throw new Error('Claude UI operation timed out'); await new Promise(r=>setTimeout(r,30)); } };
      await window.navigatePage('settings'); window.activateSettingsTab('llm');
      document.getElementById('btn-claude-login').click();
      await until(async () => (await window.api.claudeStatus()).activeId);
      await until(() => document.getElementById('claude-model-select').options.length);
      check(document.getElementById('claude-account-select').selectedOptions[0].textContent.includes('pro'), 'Pro plan is not shown');
      document.getElementById('btn-claude-use').click();
      await until(async () => (await window.api.getSettings()).llm.pool.some(e=>e.provider==='claude-subscription'));
      const settings = await window.api.getSettings();
      check(settings.llm.provider === 'claude-subscription' && !settings.llm.apiKey, 'subscription default is incorrect');
      await window.navigatePage('chat');
      const agent = window.__sessionManager.getActive('chat').agent;
      await agent.setMinimalMode(true);
      document.getElementById('chat-input').value = 'Use my Claude subscription'; document.getElementById('btn-send').click();
      await until(() => !agent.running && document.getElementById('chat-messages').textContent.includes('Claude subscription fixture reply'));
      const usage = await window.api.subscriptionUsage({provider:'claude-subscription'});
      check(usage.subscription && usage.windows[0].usedPercent===20, 'SDK subscription usage was not shared');
      await window.navigatePage('settings'); window.activateSettingsTab('llm');
      const group = document.getElementById('claude-account-group'); group.scrollIntoView({block:'start'});
      const id = (await window.api.claudeStatus()).activeId;
      check((await window.api.claudeLogin(id)).ok, 'reauthorization failed');
      await until(async () => !(await window.api.claudeStatus()).pending);
    })()`);
      assert.ok(requests.length > 0);
      assert.deepEqual(errors, []);
      const directory = path.resolve('.cache/screenshots');
      fs.mkdirSync(directory, { recursive: true });
      const window = BrowserWindow.fromWebContents(event.sender);
      window.setSize(1440, 960);
      await new Promise((r) => setTimeout(r, 150));
      fs.writeFileSync(
        path.join(directory, 'claude-subscription-settings.png'),
        (await event.sender.capturePage(undefined, { stayHidden: true })).toPNG(),
      );
      const status = await event.sender.executeJavaScript('window.api.claudeStatus()');
      const logout = await event.sender.executeJavaScript(
        `window.api.claudeLogout(${JSON.stringify(status.activeId)})`,
      );
      assert.equal(logout.ok, true);
      assert.equal(
        (await event.sender.executeJavaScript('window.api.claudeStatus()')).accounts.length,
        0,
      );
      finish();
    } catch (error) {
      finish(error);
    }
  }, 200),
);
require('../../src/main/main.js');
