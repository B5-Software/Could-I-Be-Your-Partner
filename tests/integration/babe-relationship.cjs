/* SPDX-License-Identifier: GPL-3.0-or-later */
// Isolated profile and deterministic transport: no real credentials or model costs.
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-babe-ui-'));
fs.mkdirSync(path.join(profile, 'data'));
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    language: 'zh-CN',
    runtime: { location: 'host' },
    trayEnabled: false,
    closeToTray: 'never',
    animations: false,
    notifications: { enabled: false },
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    theme: { mode: 'light', accentColor: '#536bb5' },
    automaticMemory: { enabled: false, capture: false },
    babe: {
      name: '小芙',
      interests: '喜欢散步和推理小说',
      relationship: { enabled: true, pace: 'natural', start: 'gradual', showMetrics: true },
    },
    llm: {
      provider: 'openai-compat',
      apiUrl: 'http://memory.fixture/v1',
      model: 'fixture',
      apiKey: 'fixture',
      pool: [],
      streamResponses: false,
      maxRetries: 1,
    },
  }),
);
require('../../src/main/net-proxy').install = () => {};
const requests = [];
const errors = [];
const localFetch = global.fetch;
const fakeFetch = async (url, options = {}) => {
  if (String(url).startsWith('http://127.0.0.1:')) return localFetch(url, options);
  if (String(url).startsWith('http://memory.fixture/')) {
    const body = JSON.parse(options.body);
    requests.push(body);
    const content =
      '记住了。下次想散步时，我们就聊聊海边的风，再挑一本喜欢的小说。' +
      '<cibyp-relationship>{"kind":"connection","evidence":"我喜欢海边散步","memory":{"kind":"preference","content":"用户喜欢海边散步，想一起聊推理小说。"}}</cibyp-relationship>';
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  if (String(url).endsWith('/models')) return new Response('{"data":[{"id":"fixture"}]}');
  if (String(url).includes('models.dev')) return new Response('{}');
  throw new Error('External network disabled for memory fixture');
};
global.fetch = fakeFetch;
require('undici').fetch = fakeFetch;
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && /Uncaught|Initialization failed/.test(event.message))
      errors.push(event.message);
  });
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => finish(new Error('Memory integration timed out')), 45000);

ipcMain.once('app:renderer-ready', (event) =>
  setTimeout(async () => {
    const wc = event.sender;
    const js = (code) => wc.executeJavaScript(code);
    const until = async (code) => {
      const end = Date.now() + 10000;
      while (!(await js(code))) {
        if (Date.now() > end) throw new Error('Timed out: ' + code);
        await delay(40);
      }
    };
    try {
      BrowserWindow.fromWebContents(wc).setSize(1440, 980);
      const first = await js(
        "window.api.backendRequest('initialize',{mode:'babe',key:'babe-fixture-one'})",
      );
      await js(
        "window.api.backendRequest('sendMessage','babe-fixture-one','我喜欢海边散步，也喜欢看推理小说。')",
      );
      const state = await js('window.api.babeRelationshipGet()');
      assert.equal(state.memories.length, 1);
      assert.ok(state.metrics.affection > 30);
      const view = await js("window.api.backendRequest('getView','babe-fixture-one')");
      assert.ok(!JSON.stringify(view.messages).includes('cibyp-relationship'));
      assert.ok(!JSON.stringify(view.workingMessages).includes('跨会话关系的最新事实'));
      const history = await js('window.api.babeHistoryList()');
      assert.ok(history.length);
      await js("window.api.backendRequest('initialize',{mode:'babe',key:'babe-fixture-two'})");
      const next = await js("window.api.backendRequest('getView','babe-fixture-two')");
      assert.equal(next.stats.relationship.metrics.affection, state.metrics.affection);
      await js(
        `window.api.backendRequest('openHistory','babe-fixture-two',${JSON.stringify(first.session.conversationId)})`,
      );
      assert.equal(
        (await js('window.api.babeRelationshipGet()')).metrics.affection,
        state.metrics.affection,
      );
      await js("document.querySelector('.mode-btn[data-mode=babe]').click()");
      await until("document.getElementById('page-babe').classList.contains('active')");
      await js("document.getElementById('btn-babe-relationship').click()");
      await until(
        "document.querySelectorAll('#babe-relationship-detail .babe-relationship-memory').length===1",
      );
      const preview = path.resolve('.cache/screenshots');
      fs.mkdirSync(preview, { recursive: true });
      await delay(100);
      const bounds = await js(
        "(()=>{const a=document.getElementById('babe-relationship-panel').getBoundingClientRect(),b=document.getElementById('babe-chat-input').getBoundingClientRect();return {bottom:a.bottom,input:b.top,width:a.width,height:a.height}})()",
      );
      assert.ok(bounds.height > 100 && bounds.bottom <= bounds.input && bounds.width > 500);
      const accent = await js(
        "getComputedStyle(document.querySelector('.babe-relationship-summary > i')).color",
      );
      assert.equal(accent, 'rgb(83, 107, 181)');
      fs.writeFileSync(
        path.join(preview, 'babe-relationship-light.png'),
        (await wc.capturePage(undefined, { stayHidden: true })).toPNG(),
      );
      await js("window.navigatePage('settings');window.activateSettingsTab('babe')");
      await until(
        "document.querySelectorAll('#setting-babe-relationship-detail .babe-relationship-memory').length===1",
      );
      await js("document.getElementById('setting-babe-relationship-enabled').click()");
      await until('(async()=>!(await window.api.getSettings()).babe.relationship.enabled)()');
      await js("document.getElementById('setting-babe-relationship-enabled').click()");
      await until('(async()=>(await window.api.getSettings()).babe.relationship.enabled)()');
      for (const [lang, expected] of [
        ['en', 'Relationship growth'],
        ['de', 'Beziehungsentwicklung'],
      ]) {
        await js(`window.i18nSetLanguage('${lang}')`);
        await delay(60);
        assert.equal(
          await js(
            "document.querySelector('label[for=setting-babe-relationship-enabled]').textContent",
          ),
          expected,
        );
      }
      await js(
        "window.i18nSetLanguage('zh-CN');window.api.backendRequest('saveSettings',{theme:{mode:'dark',backgroundColor:'#1e2130'}})",
      );
      await delay(200);
      fs.writeFileSync(
        path.join(preview, 'babe-relationship-settings-dark.png'),
        (await wc.capturePage(undefined, { stayHidden: true })).toPNG(),
      );
      assert.deepEqual(errors, []);
      const beforeChild = (await js('window.api.babeRelationshipGet()')).metrics;
      const child = await js(
        "window.api.nativeSubagentStart('babe-fixture-one',{task:'Report a brief finding',tools:['calculator']})",
      );
      assert.equal(child.ok, true, child.error);
      assert.match(child.subAgentId, /^native-sub-/);
      assert.ok(
        requests.some((r) => r.messages?.[0]?.content.includes('You are a CIBYP subagent')),
      );
      assert.ok(
        requests.some(
          (r) =>
            r.messages?.[0]?.content.includes('You are a CIBYP subagent') &&
            r.tools?.some((t) => t.function.name === 'sendAgentMessage'),
        ),
      );
      assert.deepEqual((await js('window.api.babeRelationshipGet()')).metrics, beforeChild);
      console.log(
        '[babe] PASS: real host Agent, shared relationship across new/old chats, hidden protocol, settings/i18n and themed screenshots.',
      );
      finish();
    } catch (error) {
      finish(error);
    }
  }, 250),
);
function finish(error) {
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}
require('../../src/main/main');
