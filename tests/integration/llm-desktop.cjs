/* Real sandboxed GUI -> host IPC -> local HTTP fixtures. No user login or paid inference. */
const { app, ipcMain, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-llm-desktop-'));
app.setPath('userData', profile);
fs.mkdirSync(path.join(profile, 'data'));
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('documents', path.join(profile, 'documents'));
const requests = [];
let server;
const failures = [];
app.on('browser-window-created', (_, window) => {
  window.setBackgroundThrottling?.(false);
  window.setOpacity(0);
  window.setSkipTaskbar(true);
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' && /Uncaught|Initialization failed/.test(event.message))
      failures.push(event.message);
  });
});
const opened = [];
shell.openExternal = async (url) => {
  opened.push(url);
};
const { ChatGPTAccounts } = require('../../src/main/services/chatgpt-accounts');
ChatGPTAccounts.prototype.status = async () => ({
  ok: true,
  activeId: 'fixture',
  pending: null,
  accounts: [{ id: 'fixture', label: 'Fixture account', signedIn: true, planEnabled: true }],
});
ChatGPTAccounts.prototype.lease = async () => ({
  id: 'fixture',
  token: 'fixture-access',
  signal: new AbortController().signal,
  release() {},
});
ChatGPTAccounts.prototype.limits = async () => ({
  ok: true,
  unavailable: true,
  message: 'This login provides no readable subscription limits; view and manage usage in ChatGPT',
});
let done = false;
const timeout = setTimeout(() => finish(new Error('GUI inference regression timed out')), 60000);
function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timeout);
  server?.closeAllConnections();
  server?.close();
  if (error) console.error('[llm-desktop] FAIL:', error);
  else
    console.log(
      '[llm-desktop] PASS: GUI send, JSON/SSE providers, subscription completion, host links and clear model controls',
    );
  console.log('[llm-desktop] isolated profile:', profile);
  app.exit(error ? 1 : 0);
}
ipcMain.once('app:renderer-ready', (event) => {
  setTimeout(async () => {
    try {
      const result = await event.sender.executeJavaScript(`(async () => {
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const normal = await window.api.chatLLMStream([{role:'user',content:'fixture'}], {requestId:'json-fixture', provider:'openai-compat',apiUrl:'http://127.0.0.1:${server.address().port}/v1/chat/completions', model:'fixture-model'});
        check(normal.ok && normal.data.choices[0].message.content === 'GUI fixture reply', 'JSON streaming fallback did not return a reply');
        const subscription = await window.api.chatLLM([{role:'user',content:'fixture'}], {provider:'chatgpt-codex', model:'fixture-model'});
        check(subscription.ok && subscription.data.choices[0].message.content === 'Subscription fixture reply', 'subscription SSE was not aggregated');
        const free = await window.api.chatLLM([{role:'user',content:'fixture'}], {provider:'opencode-zen',apiKey:'',model:'fixture-free'});
        check(free.ok && free.data.choices[0].message.content === 'Free fixture reply', 'anonymous free-model call was rejected');
        await window.navigatePage('chat');
        const agent = window.__sessionManager.getActive('chat').agent;
        await agent.setMinimalMode(true);
        document.getElementById('chat-input').value = 'GUI fixture question';
        document.getElementById('btn-send').click();
        for (let n=0; n<400; n++) {
          if (document.getElementById('chat-messages').textContent.includes('GUI fixture reply') && !agent.running) break;
          if (n === 399) throw new Error('GUI send produced no visible assistant reply: ' + document.getElementById('chat-messages').textContent);
          await new Promise(resolve => setTimeout(resolve,25));
        }
        const visible = document.getElementById('chat-messages').textContent;
        check(visible.includes('GUI fixture question') && visible.includes('GUI fixture reply'), 'visible user/assistant message missing');
        await window.navigatePage('settings');
        window.activateSettingsTab('llm');
        check(document.querySelector('.settings-panel[data-tab=llm] > .settings-group').id === 'llm-pool-group', 'model pool must come first');
        check(document.querySelector('label[for=chatgpt-model-select]').textContent.includes('添加到模型池'), 'subscription selector purpose is unclear');
        const host = await window.api.openHostBrowser('https://chatgpt.com/settings/usage');
        check(host.ok && host.location === 'host', 'account links must open the host browser');
        check(!(await window.api.openHostBrowser('file:///sensitive')).ok, 'host browser must reject non-web URLs');
        return { visible, normal:normal.ok, subscription:subscription.ok, free:free.ok };
      })()`);
      assert.equal(result.normal && result.subscription && result.free, true);
      assert.equal(
        requests.some((request) => request.path === '/json'),
        true,
      );
      assert.equal(
        requests.some(
          (request) =>
            request.path === '/subscription' &&
            request.body.stream === true &&
            request.body.store === false &&
            request.auth === 'Bearer fixture-access',
        ),
        true,
      );
      assert.deepEqual(opened, ['https://chatgpt.com/settings/usage']);
      assert.deepEqual(failures, []);
      if (process.env.CIBYP_UI_PREVIEW_DIR) {
        const directory = path.resolve(process.env.CIBYP_UI_PREVIEW_DIR);
        fs.mkdirSync(directory, { recursive: true });
        await event.sender.executeJavaScript(
          `(async()=>{document.documentElement.dataset.theme='light';await window.navigatePage('settings');window.activateSettingsTab('llm');await new Promise(resolve=>setTimeout(resolve,300));})()`,
        );
        fs.writeFileSync(
          path.join(directory, 'models-settings.png'),
          (
            await event.sender.capturePage(undefined, { stayHidden: true, stayAwake: true })
          ).toPNG(),
        );
      }
      assert.ok(BrowserWindow.fromWebContents(event.sender));
      finish();
    } catch (error) {
      finish(error);
    }
  }, 500);
});
(async () => {
  server = require('node:http').createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    requests.push({ path: request.url, body, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/subscription')
      response.end(
        'event: response.completed\r\ndata:' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Subscription fixture reply' }],
                },
              ],
              usage: { input_tokens: 20, output_tokens: 5 },
            },
          }) +
          '\r\n\r\n',
      );
    else if (request.url === '/free')
      response.end(
        'data:' +
          JSON.stringify({
            choices: [{ delta: { content: 'Free fixture reply' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }) +
          '\r\n\r\n',
      );
    else
      response.end(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: 'GUI fixture reply' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
      );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const realFetch = global.fetch;
  const fakeFetch = (url, options) => {
    const value = String(url);
    if (value.includes('models.dev')) return Promise.resolve(new Response('{}'));
    if (value === 'https://api.openai.com/v1/models')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list' }],
          }),
        ),
      );
    if (value === 'https://api.openai.com/v1/responses')
      return realFetch(`http://127.0.0.1:${server.address().port}/subscription`, options);
    if (value.startsWith('https://opencode.ai/') && value.includes('/chat/completions'))
      return realFetch(`http://127.0.0.1:${server.address().port}/free`, options);
    if (value.startsWith(`http://127.0.0.1:${server.address().port}/`))
      return realFetch(`http://127.0.0.1:${server.address().port}/json`, options);
    throw new Error('External network disabled in LLM desktop regression');
  };
  global.fetch = fakeFetch;
  require('undici').fetch = fakeFetch;
  fs.writeFileSync(
    path.join(profile, 'data/settings.json'),
    JSON.stringify({
      onboardingCompleted: true,
      notifications: { enabled: false },
      runtime: { location: 'host' },
      closeToTray: 'never',
      trayEnabled: false,
      updates: { autoCheckEnabled: false },
      voice: { wakeEnabled: false },
      proxy: { mode: 'none' },
      llm: {
        provider: 'openai-compat',
        apiUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        model: 'fixture-model',
        apiKey: '',
        pool: [],
        streamResponses: true,
        maxRetries: 1,
        timeoutMs: 1000,
      },
      decision: { enabled: false },
    }),
  );
  require('../../src/main/main.js');
})().catch(finish);
