/* Real renderer + IPC + Agent loop, without credentials or paid requests. */
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-settings-assistant-'));
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
    notifications: { enabled: false },
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    theme: { mode: 'light', accentColor: '#4767d6' },
    llm: {
      provider: 'opencode-zen',
      model: 'big-pickle',
      apiKey: 'public',
      zenApiKey: 'public',
      pool: [],
      autoOpencodeHeaders: false,
    },
    user: { name: 'Private identity' },
    email: { enabled: false, pass: 'PRIVATE-SECRET' },
    language: 'zh-CN',
  }),
);
require('../../src/main/net-proxy').install = () => {};
let chatRequests = 0;
const errors = [];
global.fetch = async (url, options = {}) => {
  url = String(url);
  if (url === 'https://models.dev/api.json')
    return new Response(
      JSON.stringify({
        opencode: {
          models: { 'big-pickle': { cost: { input: 0, output: 0 }, limit: { context: 200000 } } },
        },
      }),
    );
  if (url.endsWith('/chat/completions')) {
    chatRequests++;
    const body = JSON.parse(options.body);
    assert.ok(!JSON.stringify(body).includes('Private identity'));
    assert.ok(!JSON.stringify(body).includes('PRIVATE-SECRET'));
    const toolReturned = body.messages.some((message) => message.role === 'tool');
    const delta = toolReturned
      ? { content: '已将强调色改为蓝色。' }
      : {
          tool_calls: [
            {
              index: 0,
              id: 'test-settings-change',
              type: 'function',
              function: {
                name: 'settings_patch',
                arguments: JSON.stringify({
                  changes: [{ path: 'theme.accentColor', value: '#3355aa' }],
                }),
              },
            },
          ],
        };
    return new Response(
      'data: ' +
        JSON.stringify({
          choices: [{ delta, finish_reason: toolReturned ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }) +
        '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (url.endsWith('/models')) return new Response('{"data":[{"id":"big-pickle"}]}');
  throw new Error('Unmocked network request');
};
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.webContents.on('console-message', (event) => {
    if (
      event.level === 'error' &&
      /Uncaught|Initialization failed|navigation.*Failed/.test(event.message)
    )
      errors.push(event.message);
  });
  win.webContents.on('preload-error', (_e, _file, error) => errors.push(error.message));
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => finish(new Error('Settings assistant timed out')), 45000);
ipcMain.once('app:renderer-ready', (event) => {
  setTimeout(async () => {
    const wc = event.sender;
    const js = (code) => wc.executeJavaScript(code);
    async function waitFor(code) {
      const until = Date.now() + 10000;
      while (!(await js(code))) {
        if (Date.now() > until) throw new Error('Condition timed out: ' + code);
        await delay(40);
      }
    }
    try {
      await js("window.navigatePage('settings');window.activateSettingsTab('theme');");
      await waitFor("document.getElementById('setting-accent-color').value === '#4767d6'");
      await js("document.querySelector('#page-settings .page-header-actions > button').click()");
      await delay(300);
      const bounds = await js(
        "(()=>{const a=document.querySelector('.settings-shell').getBoundingClientRect();const b=document.querySelector('.settings-assistant').getBoundingClientRect();return {mainLeft:a.left,mainRight:a.right,panelLeft:b.left,panelRight:b.right}})()",
      );
      assert.ok(bounds.panelLeft >= bounds.mainRight - 1);
      await js(
        "document.querySelector('.settings-assistant textarea').value='把强调色修改为 #3355aa';document.querySelector('.settings-assistant form').requestSubmit()",
      );
      await waitFor(
        "document.getElementById('setting-accent-color').value === '#3355aa' && !document.querySelector('.settings-assistant [type=submit]').disabled",
      );
      assert.ok(chatRequests >= 2);
      assert.equal(
        (await js("window.api.settingsAssistantPatch([{path:'llm.apiKey',value:'bad'}])")).ok,
        false,
      );
      const before = await js('window.api.historyList()');
      assert.ok(!JSON.stringify(before).includes('把强调色'));
      if (process.env.CIBYP_UI_PREVIEW_DIR) {
        fs.mkdirSync(process.env.CIBYP_UI_PREVIEW_DIR, { recursive: true });
        await delay(300);
        fs.writeFileSync(
          path.join(process.env.CIBYP_UI_PREVIEW_DIR, 'settings-assistant.png'),
          (await wc.capturePage(undefined, { stayHidden: true })).toPNG(),
        );
      }
      await js("document.querySelector('.settings-assistant header button').click()");
      assert.equal(
        await js("document.querySelector('.settings-assistant [role=log]').children.length === 0"),
        true,
      );
      assert.deepEqual(errors, []);
      console.log(
        '[settings-assistant] PASS: real Agent tool loop, safe patch, appearance refresh, privacy, no history and close cleanup.',
      );
      finish();
    } catch (error) {
      finish(error);
    }
  }, 300);
});
function finish(error) {
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}
require('../../src/main/main');
