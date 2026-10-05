/* Actual desktop onboarding with an isolated profile and deterministic provider responses. */
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-onboarding-'));
const previews = process.env.CIBYP_UI_PREVIEW_DIR;
fs.mkdirSync(path.join(profile, 'data'));
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: false,
    runtime: { location: 'host' },
    trayEnabled: false,
    notifications: { enabled: false },
    closeToTray: 'never',
    voice: { wakeEnabled: false },
    updates: { autoCheckEnabled: false },
    language: 'zh-CN',
    theme: { mode: 'light', accentColor: '#4767d6' },
    llm: {
      provider: 'opencode-zen',
      model: '',
      zenApiKey: '',
      pool: [],
      autoOpencodeHeaders: false,
    },
  }),
);
const requests = [];
require('../../src/main/net-proxy').install = () => {};
const catalog = {
  opencode: {
    models: {
      'big-pickle': {
        name: 'Big Pickle',
        cost: { input: 0, output: 0 },
        limit: { context: 200000 },
      },
      'deepseek-v4-flash-free': {
        name: 'DeepSeek V4 Flash',
        cost: { input: 0, output: 0 },
        limit: { context: 1000000 },
      },
      'paid-model': { name: 'Paid Model', cost: { input: 1, output: 2 } },
    },
  },
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, options = {}) => {
  url = String(url);
  if (url === 'https://models.dev/api.json') return json(catalog);
  if (url.endsWith('/models') && url.startsWith('https://opencode.ai/')) {
    requests.push({ url, headers: options.headers });
    if (options.headers.Authorization === 'Bearer slow')
      await new Promise((resolve) => setTimeout(resolve, 500));
    return json({ data: Object.keys(catalog.opencode.models).map((id) => ({ id })) });
  }
  if (url.endsWith('/chat/completions') && url.startsWith('https://opencode.ai/')) {
    const body = JSON.parse(options.body);
    requests.push({ url, headers: options.headers, body });
    if (body.model === 'deepseek-v4-flash-free')
      return json({ error: { message: 'Model is unavailable.' } }, 400);
    if (
      !body.stream ||
      !['bash', 'edit', 'glob', 'grep', 'read'].every((name) =>
        body.tools?.some((tool) => tool.function.name === name),
      )
    )
      return json({ error: { message: 'Missing free-tier request shape' } }, 403);
    return new Response(
      'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }) +
        '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  throw new Error('Unmocked network request in onboarding check: ' + url);
};
const errors = [];
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  win.webContents.on('console-message', (event) => {
    if (
      event.level === 'error' &&
      /Uncaught|Initialization failed|\[navigation\] Failed/.test(event.message)
    )
      errors.push(event.message);
  });
});
const timeout = setTimeout(() => finish(new Error('Onboarding check timed out')), 45000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
ipcMain.once('app:renderer-ready', (event) => {
  setTimeout(async () => {
    const wc = event.sender;
    const win = BrowserWindow.fromWebContents(wc);
    const js = (code) => wc.executeJavaScript(code);
    async function waitFor(expression) {
      const deadline = Date.now() + 6000;
      while (!(await js(expression))) {
        if (Date.now() > deadline) throw new Error('Condition timed out: ' + expression);
        await delay(30);
      }
    }
    async function capture(name) {
      if (!previews) return;
      fs.mkdirSync(previews, { recursive: true });
      await delay(300);
      fs.writeFileSync(
        path.join(previews, name + '.png'),
        (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );
    }
    try {
      wc.setBackgroundThrottling(false);
      win.setMinimumSize(320, 320);
      win.setSize(1280, 900);
      await waitFor(
        "!document.getElementById('onboarding-modal').classList.contains('hidden') && !document.getElementById('ob-llm-model').disabled",
      );
      assert.equal(await js("document.getElementById('ob-llm-model').value"), 'big-pickle');
      assert.equal(await js("document.getElementById('ob-llm-model').options.length"), 2);
      const bounds = await js(
        `(() => {const r=document.querySelector('.onboarding-wizard').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight};})()`,
      );
      assert.ok(
        Math.abs(bounds.x - (bounds.vw - bounds.w) / 2) < 2 &&
          Math.abs(bounds.y - (bounds.vh - bounds.h) / 2) < 2,
        'wizard must be centered',
      );
      const footnote = await js(
        `(() => {const p=document.querySelector('.ob-footnote');const i=p.querySelector('i').getBoundingClientRect();const range=document.createRange();range.selectNodeContents(p.lastChild);const t=range.getBoundingClientRect();return {icon:i.y+i.height/2,text:t.y+t.height/2};})()`,
      );
      assert.ok(
        Math.abs(footnote.icon - footnote.text) <= 3,
        'settings icon and text must share a horizontal centerline',
      );
      await capture('onboarding-light');
      await js(
        "document.getElementById('ob-ai-name').value='Furina';document.getElementById('ob-btn-next').click();document.getElementById('ob-user-name').value='Traveler';document.getElementById('ob-btn-next').click();",
      );
      await capture('onboarding-models-light');
      await js(
        "document.getElementById('ob-llm-model').value='deepseek-v4-flash-free';document.getElementById('ob-llm-model').dispatchEvent(new Event('change'));document.getElementById('ob-btn-finish').click()",
      );
      await waitFor(
        "!document.getElementById('ob-btn-finish').disabled && document.getElementById('ob-llm-model').value==='big-pickle'",
      );
      assert.equal(
        await js("document.getElementById('onboarding-modal').classList.contains('hidden')"),
        false,
      );
      assert.equal(
        await js(
          "[...document.getElementById('ob-llm-model').options].some(o=>o.value==='deepseek-v4-flash-free')",
        ),
        false,
      );
      await js("document.getElementById('ob-btn-test').click()");
      await waitFor("document.getElementById('ob-connection-status').dataset.state==='success'");
      const probe = requests.find((request) => request.body);
      assert.equal(probe.headers.Authorization, 'Bearer public');
      assert.match(probe.headers['User-Agent'], /^opencode\//);
      assert.match(probe.headers['x-opencode-session'], /^ses_/);
      // A slow response from the previous provider/key cannot replace the latest list.
      await js(
        `(() => {const key=document.getElementById('ob-llm-zen-key');key.value='slow';key.dispatchEvent(new Event('change'));key.value='edited-key';key.dispatchEvent(new Event('change'));})()`,
      );
      await waitFor(
        "!document.getElementById('ob-llm-model').disabled && !document.getElementById('ob-btn-refresh-models').disabled",
      );
      await delay(600);
      assert.ok(
        requests.some((request) => request.headers.Authorization === 'Bearer edited-key'),
        'listing must use the edited key',
      );
      await js(
        "document.getElementById('ob-llm-zen-key').value='';document.getElementById('ob-free-only').click()",
      );
      assert.equal(await js("document.getElementById('ob-llm-model').options.length"), 2);
      await js(
        "document.getElementById('ob-free-only').click();window.api.setSettings({theme:{mode:'dark',accentColor:'#a79cf5',backgroundColor:'#181923'}})",
      );
      await capture('onboarding-models-dark');
      // Footer stays visible and only the content scrolls on a small display.
      win.setSize(550, 650);
      await delay(100);
      const small = await js(
        `(() => {const r=document.getElementById('ob-btn-finish').getBoundingClientRect();const c=document.querySelector('.ob-content');return {left:r.left,right:r.right,bottom:r.bottom,vw:innerWidth,vh:innerHeight,overflow:getComputedStyle(c).overflowY};})()`,
      );
      assert.ok(
        small.left >= 0 && small.right <= small.vw && small.bottom <= small.vh,
        'footer must remain in viewport',
      );
      assert.equal(small.overflow, 'auto');
      await capture('onboarding-narrow');
      win.setSize(1280, 900);
      await js("document.getElementById('ob-btn-finish').click()");
      await waitFor("document.getElementById('onboarding-modal').classList.contains('hidden')");
      const saved = await js('window.api.getSettings()');
      assert.equal(saved.onboardingCompleted, true);
      assert.equal(saved.aiPersona.name, 'Furina');
      assert.equal(saved.userProfile.name, 'Traveler');
      assert.equal(saved.llm.model, 'big-pickle');
      assert.equal(
        saved.llm.pool.find((entry) => entry.id === saved.llm.activeEntryId).providerLimits.context,
        200000,
      );
      assert.equal(saved.llm.zenApiKey, 'public');
      assert.equal(saved.llm.autoOpencodeHeaders, true);
      assert.equal(
        saved.llm.pool.find((entry) => entry.id === saved.llm.activeEntryId).model,
        saved.llm.model,
      );
      assert.deepEqual(errors, []);
      console.log(
        '[onboarding] PASS: free discovery, compatible probe, edited key, saving, theme, centered and narrow layouts.',
      );
      finish();
    } catch (error) {
      await capture('onboarding-failure');
      finish(error);
    }
  }, 400);
});
let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error('[onboarding] FAIL:', error.stack, errors);
  console.log('[onboarding] isolated profile:', profile);
  app.exit(error ? 1 : 0);
}
try {
  require('../../src/main/main.js');
} catch (error) {
  finish(error);
}
