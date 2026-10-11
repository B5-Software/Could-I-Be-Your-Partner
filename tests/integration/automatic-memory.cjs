/* SPDX-License-Identifier: GPL-3.0-or-later */
// Isolated profile and deterministic transport: no real credentials or model costs.
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-memory-ui-'));
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
    automaticMemory: { enabled: true, capture: true },
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
    const extracting = body.messages?.[0]?.content?.startsWith('Extract durable user memories');
    const content = extracting
      ? JSON.stringify({
          upsert: [
            {
              key: 'answer-style',
              topic: '交流偏好',
              content: '用户喜欢简洁的中文回答，并希望先看到结论。',
              evidence: '我喜欢简洁的中文回答',
              category: 'preference',
              scope: 'global',
            },
          ],
          forget: [],
        })
      : '好的，我们继续。';
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
        "window.api.backendRequest('createSession', {mode:'chat',minimalMode:true})",
      );
      await js(
        `window.api.backendRequest('sendMessage', ${JSON.stringify(first.key)}, '我喜欢简洁的中文回答，先给结论，以后的对话也请这样。')`,
      );
      await until('(async()=> (await window.api.automaticMemoryList()).items.length === 1)()');
      assert.ok(
        requests.some((r) => r.messages?.[0]?.content?.startsWith('Extract durable user memories')),
      );
      const second = await js(
        "window.api.backendRequest('createSession', {mode:'chat',minimalMode:true})",
      );
      await js(
        `window.api.backendRequest('sendMessage', ${JSON.stringify(second.key)}, '帮我介绍一下上下文管理。')`,
      );
      assert.ok(
        requests
          .filter((r) => !r.messages?.[0]?.content?.startsWith('Extract'))
          .some((r) => /用户喜欢简洁的中文回答/.test(r.messages[0].content)),
      );
      const transcript = await js('window.api.historyList()');
      assert.ok(transcript.length >= 2);
      await js("window.navigatePage('settings');window.activateSettingsTab('automatic-memory')");
      await until("document.querySelectorAll('.automatic-memory-item').length === 1");
      assert.equal(
        await js("document.getElementById('setting-auto-memory-enabled').checked"),
        true,
      );
      await js(
        "document.querySelector('.automatic-memory-item .btn-icon').click();document.querySelector('.automatic-memory-item textarea').value='用户希望先看结论，再看简短说明。';document.querySelector('.automatic-memory-item .btn-primary').click()",
      );
      await until(
        "document.querySelector('.automatic-memory-item p')?.textContent.includes('简短说明')",
      );
      assert.equal((await js('window.api.automaticMemoryList()')).items[0].edited, true);
      const client = require('../../src/tui/backend-connect').clientFor(
        require('../../src/main/core/backend-discovery').readBackend(profile),
      );
      try {
        const shared = await client.request('ipc:invoke', 'automatic-memory:list');
        assert.equal(shared.items[0].content, '用户希望先看结论，再看简短说明。');
        const changed = await client.request('ipc:invoke', 'automatic-memory:edit', {
          id: shared.items[0].id,
          revision: shared.revision,
          content: '用户希望先看结论，再看简短说明，必要时附上例子。',
        });
        assert.equal(changed.ok, true);
        await until(
          "document.querySelector('.automatic-memory-item p')?.textContent.includes('附上例子')",
        );
      } finally {
        client.close();
      }
      assert.equal(
        await js(
          "(()=>{const r=document.querySelector('.automatic-memory-settings.active').getBoundingClientRect();return r.width>500 && r.right<=innerWidth})()",
        ),
        true,
      );
      const preview = path.resolve('.cache/screenshots');
      fs.mkdirSync(preview, { recursive: true });
      await until('(async()=> !(await window.api.automaticMemoryList()).busy)()');
      await delay(200);
      fs.writeFileSync(
        path.join(preview, 'automatic-memory-light.png'),
        (await wc.capturePage(undefined, { stayHidden: true })).toPNG(),
      );
      await js(
        "window.api.backendRequest('saveSettings', {theme:{mode:'dark',backgroundColor:'#1e2130'}})",
      );
      await delay(250);
      fs.writeFileSync(
        path.join(preview, 'automatic-memory-dark.png'),
        (await wc.capturePage(undefined, { stayHidden: true })).toPNG(),
      );
      await js("window.i18nSetLanguage('en')");
      await delay(100);
      assert.equal(
        await js(
          'document.querySelector(\'.settings-tab[data-tab="automatic-memory"]\').textContent.trim()',
        ),
        'Automatic memory',
      );
      await js("window.i18nSetLanguage('de')");
      await delay(100);
      assert.equal(
        await js(
          'document.querySelector(\'.settings-tab[data-tab="automatic-memory"]\').textContent.trim()',
        ),
        'Automatisches Gedächtnis',
      );
      await js("document.getElementById('setting-auto-memory-enabled').click()");
      await until('(async()=> (await window.api.getSettings()).automaticMemory.enabled===false)()');
      assert.equal(
        (await js("window.api.automaticMemoryRecall({mode:'chat',query:'回答'})")).content,
        '',
      );
      await js("document.getElementById('setting-auto-memory-enabled').click()");
      await until('(async()=> (await window.api.getSettings()).automaticMemory.enabled===true)()');
      const extractedBeforeHelper = requests.filter((r) =>
        r.messages?.[0]?.content?.startsWith('Extract durable'),
      ).length;
      const before = requests.length;
      const ephemeral = await js(
        "window.api.backendRequest('createSession', {mode:'chat',profile:'settings-assistant'})",
      );
      await js(
        `window.api.backendRequest('sendMessage', ${JSON.stringify(ephemeral.key)}, '请简单说明设置的作用。')`,
      );
      assert.ok(requests.length > before);
      await delay(1200);
      assert.equal(
        requests.filter((r) => r.messages?.[0]?.content?.startsWith('Extract durable')).length,
        extractedBeforeHelper,
      );
      assert.deepEqual(errors, []);
      console.log(
        '[automatic-memory] PASS: real host Agent extraction/recall, separate histories, GUI edit, shared settings and screenshots.',
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
