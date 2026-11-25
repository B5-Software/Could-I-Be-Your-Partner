/* SPDX-License-Identifier: GPL-3.0-or-later */
// End-to-end verification for active session switching mid-stream, Quant live SSE streaming,
// V1 message-manager icon styling, Ctrl+K focus ring without inscribed rectangle, and switches.
const { app, ipcMain, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
require('../../src/main/services/codeoss-service').CodeOSSService.prototype.open = async function (
  directory,
) {
  return { ok: true, path: directory, location: 'host' };
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-stream-ui-verify-'));
for (const name of ['data', 'documents', 'workspace']) fs.mkdirSync(path.join(profile, name));
const presented = path.join(profile, 'workspace', 'test-report.txt');
fs.writeFileSync(presented, 'File presentation fixture');
const chatWorkspace = path.join(profile, 'Custom Chat Workspace');
fs.mkdirSync(chatWorkspace);
const composerWorkspace = path.join(profile, 'Composer Workspace');
fs.mkdirSync(composerWorkspace);
let pickedChatWorkspace = chatWorkspace;
const savedImage = path.join(profile, 'saved-image.png');
const fixtureImage =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl8sAAAAASUVORK5CYII=';
const showSaveDialog = dialog.showSaveDialog.bind(dialog);
dialog.showSaveDialog = (parent, options) =>
  options.title === '保存图片'
    ? Promise.resolve({ canceled: false, filePath: savedImage })
    : showSaveDialog(parent, options);
const showOpenDialog = dialog.showOpenDialog.bind(dialog);
dialog.showOpenDialog = (parent, options) =>
  options.title === '选择 Chat 工作目录'
    ? Promise.resolve({ canceled: false, filePaths: [pickedChatWorkspace] })
    : showOpenDialog(parent, options);
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    features: { quant: true },
    language: 'zh-CN',
    runtime: { location: 'host' },
    trayEnabled: false,
    closeToTray: 'never',
    notifications: { enabled: false },
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    automaticMemory: { enabled: false },
    decision: { enabled: false },
    tarotVisible: false,
    animations: false,
    modalAnimations: false,
    theme: { frontend: 'v1', mode: 'light', accentColor: '#e91e8c', backgroundColor: '#ffffff' },
    llm: {
      provider: 'openai-compat',
      apiUrl: 'http://stream-fixture.local/v1',
      apiKey: 'fixture',
      model: 'StreamFixture',
      streamResponses: true,
    },
  }),
);

// Controllable SSE stream queue for Chat & Quant live streaming assertions
const pendingStreams = [];
function createControlledSseResponse() {
  const encoder = new TextEncoder();
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  const handle = {
    push(delta) {
      const payload = JSON.stringify({ choices: [{ delta }] });
      controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
    },
    finish() {
      const payload = JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 18, completion_tokens: 12, total_tokens: 30 },
      });
      controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  };
  pendingStreams.push(handle);
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

require('../../src/main/net-proxy').install = () => {};
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url).includes('stream-fixture.local')) {
    let isStream = false;
    try {
      const parsed = JSON.parse(String(options?.body || '{}'));
      isStream = parsed.stream === true;
    } catch {
      isStream = false;
    }
    if (!isStream) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const response = createControlledSseResponse();
    // Auto-complete any extra follow-up turn beyond the 2 manually controlled streams (Chat + Quant)
    if (pendingStreams.length > 2) {
      const extra = pendingStreams[pendingStreams.length - 1];
      setTimeout(() => {
        try {
          extra.finish();
        } catch {
          /* ignore */
        }
      }, 20);
    }
    return response;
  }
  if (/^http:\/\/127\.0\.0\.1:/.test(String(url))) return realFetch(url, options);
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
};
require('undici').fetch = global.fetch;

const errors = [];
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && /Uncaught|Initialization failed/.test(event.message))
      errors.push(event.message);
  });
});

let finished = false;
const timeout = setTimeout(
  () => finish(new Error('session-and-ui-fixes verification timed out')),
  120000,
);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  for (const h of pendingStreams) {
    try {
      h.finish();
    } catch {
      /* already closed */
    }
  }
  if (error) console.error('[session-and-ui-fixes] FAIL', error);
  else console.log('[session-and-ui-fixes] PASS');
  app.exit(error ? 1 : 0);
}

async function until(check, message, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const helpers = `
  const check = (v, m) => { if (!v) throw new Error(m); };
  const until = async (fn, m = 'Condition timed out') => { const end = Date.now() + 20000; while (!(await fn())) { if (Date.now() > end) throw new Error(m); await new Promise(r => setTimeout(r, 40)); } };
  const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
`;

ipcMain.once('app:renderer-ready', (event) =>
  setTimeout(async () => {
    const contents = event.sender;
    const win = BrowserWindow.fromWebContents(contents);
    const savePreview = async (name) => {
      const dest = path.resolve(__dirname, '../../.cache/previews/' + name + '.png');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, (await win.capturePage()).toPNG());
    };
    try {
      win.setContentSize(1440, 920);
      await contents.executeJavaScript(`(async () => { ${helpers}
        await until(() => window.CibypFrontendShell && window.__sessionManager && window.CibypQuant && window.CibypSuperAgent);
        await paint();
      })()`);

      // 1. V1 message-manager button uses FontAwesome solid icon matching neighbors
      await contents.executeJavaScript(`(async () => { ${helpers}
        check(document.documentElement.dataset.frontend === 'v1', 'Expected V1 initial mode');
        const btn = document.querySelector('.chat-actions .message-manager-trigger');
        check(btn, 'Missing message-manager button');
        const fa = btn.querySelector('.v2-original-icon');
        const svg = btn.querySelector('.v2-icon');
        check(fa && fa.classList.contains('fa-comment-dots'), 'Missing FontAwesome icon on message-manager');
        check(getComputedStyle(fa).display !== 'none', 'FontAwesome icon should be visible in V1');
        check(svg && getComputedStyle(svg).display === 'none', 'V2 SVG icon should be hidden in V1');
        await paint();
      })()`);
      await savePreview('verify-v1-toolbar');

      // 2. Chat active session switching mid-stream (SSE)
      await contents.executeJavaScript(`(async () => { ${helpers}
        window.__s1 = window.__sessionManager.getActive('chat');
        await window.__s1.agent.setMinimalMode(true);
        const input = document.getElementById('chat-input');
        input.value = 'Verify active stream switch restore';
        document.getElementById('btn-send').click();
      })()`);
      await until(() => pendingStreams.length >= 1, 'Chat SSE stream did not start');
      const chatStream = pendingStreams[0];
      chatStream.push({ reasoning_content: 'Planning answer...' });
      chatStream.push({ content: 'Chunk-1 ' });
      chatStream.push({
        reasoning_content: Array.from(
          { length: 70 },
          (_, index) => '\n\nReasoning line ' + index,
        ).join(''),
      });
      await contents.executeJavaScript(`(async () => { ${helpers}
        const scroller = document.getElementById('chat-messages');
        await until(() => scroller.querySelector('.reasoning-content')?.textContent.includes('Reasoning line 69'));
        const reasoning = scroller.querySelector('.reasoning-content');
        check(reasoning.scrollHeight > reasoning.clientHeight, 'Reasoning fixture must be scrollable');
        const spacer = document.createElement('div');
        spacer.id = 'reasoning-scroll-fixture';
        spacer.style.flex = '0 0 1250px';
        scroller.prepend(spacer);
        window.forceScrollToBottom(scroller);
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -22, bubbles: true }));
        scroller.scrollTop -= 22;
        window.__transcriptScroll = scroller.scrollTop;
        reasoning.scrollTop = 30;
        window.__reasoningScroll = reasoning.scrollTop;
      })()`);
      chatStream.push({ reasoning_content: '\n\nReasoning continued' });
      await contents.executeJavaScript(`(async () => { ${helpers}
        const reasoning = document.querySelector('#chat-messages .reasoning-content');
        await until(() => reasoning.textContent.includes('Reasoning continued'));
        check(Math.abs(reasoning.scrollTop - window.__reasoningScroll) < 2, 'Streaming reasoning changed the scroll position from ' + window.__reasoningScroll + ' to ' + reasoning.scrollTop);
        const scroller = document.getElementById('chat-messages');
        check(Math.abs(scroller.scrollTop - window.__transcriptScroll) < 2, 'Streaming reasoning pulled the transcript back to the bottom');
        document.getElementById('reasoning-scroll-fixture').remove();
      })()`);

      await contents.executeJavaScript(`(async () => { ${helpers}
        await until(() => document.getElementById('chat-messages').textContent.includes('Chunk-1'), 'Initial stream chunk did not appear');
        // Switch away to a brand new Session 2 while Session 1 is actively streaming
        const beforeCount = window.__sessionManager.list('chat').length;
        document.getElementById('btn-new-chat').click();
        await until(() => window.__sessionManager.list('chat').length === beforeCount + 1, 'Did not create Session 2');
        window.__s2 = window.__sessionManager.getActive('chat');
        check(window.__s2.key !== window.__s1.key, 'Did not switch to Session 2');
        check(!document.getElementById('chat-messages').textContent.includes('Chunk-1'), 'Session 1 stream leaked into Session 2');
      })()`);

      // Emit a chunk while Session 1 is in background!
      chatStream.push({ content: 'Chunk-2 ' });
      chatStream.push({ content: 'Chunk-2 ' });
      await new Promise((r) => setTimeout(r, 120));

      // Switch back to Session 1 mid-stream via real session tab click and verify full live restoration
      await contents.executeJavaScript(`(async () => { ${helpers}
        const tab = document.querySelector('#chat-session-tabs .session-tab[data-session-key="' + window.__s1.key + '"]');
        check(tab, 'Missing Session 1 tab');
        tab.click();
        await until(() => window.__sessionManager.getActive('chat').key === window.__s1.key, 'Did not switch back to Session 1');
        await until(() => document.getElementById('chat-messages').textContent.includes('Chunk-2 Chunk-2'), 'Restored active stream lost a repeated delta');
        check(document.getElementById('chat-messages').textContent.includes('Chunk-1'), 'Restored active stream missing initial chunk');
        check(document.querySelectorAll('#chat-messages .message.user').length === 1, 'User message duplicated after switching back');
        check(!document.querySelector('#chat-messages .welcome-message'), 'Welcome message wrongly shown on active stream');
      })()`);

      // Emit final chunk while viewing Session 1 and close SSE
      chatStream.push({ content: 'Chunk-3!' });
      chatStream.finish();
      await contents.executeJavaScript(`(async () => { ${helpers}
        await until(() => !window.__s1.agent.running, 'Chat session 1 did not finish');
        await until(() => document.getElementById('chat-messages').textContent.includes('Chunk-3!'), 'Final chunk missing after restore');
        check(document.querySelectorAll('#chat-messages .message.user').length === 1, 'User message count mismatch after completion');
        const assistantMsgs = [...document.querySelectorAll('#chat-messages .message.assistant:not(.thinking-indicator)')];
        check(assistantMsgs.length === 1, 'Expected 1 assistant message, got ' + assistantMsgs.length);
        check(assistantMsgs[0].textContent.includes('Chunk-1 Chunk-2 Chunk-2 Chunk-3!'), 'Final assistant text mismatch: ' + assistantMsgs[0].textContent);
        const rail = document.getElementById('chat-messages').previousElementSibling;
        await until(() => rail.querySelector('.request-jump-stop'));
        const jump = rail.querySelector('.request-jump-stop');
        jump.dispatchEvent(new PointerEvent('pointerenter'));
        check(!rail.querySelector('.request-jump-preview').hidden && rail.querySelector('.request-jump-preview').textContent.includes('Verify active stream switch restore'), 'Request preview is missing');
        jump.click();
        check(jump.getAttribute('aria-current') === 'true' && rail.querySelector('.request-jump-preview').hidden, 'Request marker did not activate');
        window.__s1.agent.onMessage('error', 'Fixture request failure');
        check(document.getElementById('toast-container').textContent.includes('Fixture request failure'), 'Request failure did not use a toast');
        check(!document.getElementById('chat-messages').textContent.includes('Fixture request failure'), 'A transient failure was inserted into the chat');
      })()`);
      console.log('[session-and-ui-fixes] 1/5 Active session mid-stream switch & restore passed');

      await contents.executeJavaScript(`(async () => { ${helpers}
        document.getElementById('btn-choose-chat-workspace').click();
        await until(() => window.__s1.agent.workspacePath === ${JSON.stringify(chatWorkspace)}, 'The active Chat did not adopt its selected workspace');
        check(window.__s2.agent.workspacePath !== window.__s1.agent.workspacePath, 'Chat workspace leaked into another session');
        const saved = await window.api.historyGet(window.__s1.agent.conversationId);
        check(saved.workspacePath === ${JSON.stringify(chatWorkspace)}, 'Chat workspace was not persisted to history');
        check(saved.workspaceExplicit, 'Workspace selection was not marked explicit');
      })()`);

      // 3. Switch to V2: verify V2 icon swap + Ctrl+K focus ring without inscribed rectangle
      await contents.executeJavaScript(`(async () => { ${helpers}
        const s = await window.api.getSettings();
        await window.api.setSettings({ theme: { ...s.theme, frontend: 'v2' } });
        await until(() => document.documentElement.dataset.frontend === 'v2');
        const btn = document.querySelector('.chat-actions .message-manager-trigger');
        check(getComputedStyle(btn.querySelector('.v2-original-icon')).display === 'none', 'V1 icon leaked into V2');
        check(getComputedStyle(btn.querySelector('.v2-icon')).display !== 'none', 'V2 SVG icon hidden in V2');
        const input = {
          title: 'Structured summary',
          columns: ['Name', 'Score'],
          rows: [['<img src=x onerror=alert(1)>', 5], ['Second', 2]],
          chartColumn: 1,
        };
        window.__s1.agent.onToolCall('presentInteractive', input, 'calling', null, 'interactive-fixture');
        window.__s1.agent.onToolCall('presentInteractive', input, 'done', { ok: true, presentation: 'interactive-table' }, 'interactive-fixture');
        const call = document.querySelector('[data-tool-call-id="interactive-fixture"]');
        const args = call.querySelector('.tool-call-args');
        check(getComputedStyle(args).display === 'none', 'Professional tool call opens expanded');
        call.querySelector('.tool-call-disclosure').click();
        check(getComputedStyle(args).display !== 'none', 'Professional tool call did not expand');
        const widget = document.querySelector('.interactive-content').shadowRoot;
        check(widget.querySelectorAll('tbody tr').length === 2 && !widget.querySelector('img'), 'Widget did not render literal content safely');
        const filter = widget.querySelector('input');
        filter.value = 'Second';
        filter.dispatchEvent(new Event('input'));
        check(widget.querySelectorAll('tbody tr').length === 1, 'Widget filter did not update');
        for (const [id, ok] of [['tools-success', true], ['tools-failed', false]]) {
          window.__s1.agent.onToolCall('readFile', { path: id }, 'calling', null, id);
          window.__s1.agent.onToolCall('readFile', { path: id }, 'done', { ok }, id);
        }
        await until(() => document.querySelector('#chat-messages .tool-call-group')?.textContent.includes('2'));
        const group = document.querySelector('#chat-messages .tool-call-group');
        const first = group.nextElementSibling;
        check(group.textContent.includes('1 个成功，1 个失败'), 'Incorrect tool group totals');
        check(getComputedStyle(first).display === 'none', 'Tool group should start collapsed');
        group.click();
        check(getComputedStyle(first).display !== 'none', 'Tool group did not reveal its tool calls');
        check(parseFloat(getComputedStyle(first.querySelector('.tool-call-disclosure')).borderRadius) > 0, 'Tool disclosure highlight has square corners');
        document.getElementById('v2-cmd-trigger').click();
        await until(() => document.querySelector('.v2-cmd-dialog[open]'));
        const cmdInput = document.querySelector('.v2-cmd-input');
        const cmdDialog = document.querySelector('.v2-cmd-dialog');
        cmdInput.focus();
        await paint();
        check(getComputedStyle(cmdInput).outlineStyle === 'none', 'Ctrl+K input drew an inscribed rectangle outline');
        check(getComputedStyle(cmdInput).boxShadow === 'none', 'Ctrl+K input drew an inner box-shadow');
        check(getComputedStyle(cmdDialog).boxShadow !== 'none', 'Ctrl+K outer dialog missing focus emphasis');
      })()`);
      await savePreview('verify-v2-cmd-focus');
      await contents.executeJavaScript(`document.querySelector('.v2-cmd-dialog').close();`);
      console.log('[session-and-ui-fixes] 2/5 V1/V2 icon & Ctrl+K focus emphasis passed');

      pickedChatWorkspace = composerWorkspace;
      await contents.executeJavaScript(`(async () => { ${helpers}
        const button = document.querySelector('.chat-input-area .v2-composer-workspace');
        button.click();
        await until(() => window.__s1.agent.workspacePath === ${JSON.stringify(composerWorkspace)}, 'Professional composer did not change the workspace');
        await until(() => button.textContent.includes('Composer Workspace'), 'Professional composer kept the old directory label');
      })()`);

      await contents.executeJavaScript(`(async () => { ${helpers}
        window.__s1.agent.onToolCall('generateImage', {}, 'calling', null, 'save-image-fixture');
        window.__s1.agent.onToolCall('generateImage', {}, 'done', { ok: true, url: ${JSON.stringify(fixtureImage)} }, 'save-image-fixture');
        document.querySelector('.chat-image-toolbar [data-act="download"]').click();
        await until(() => document.getElementById('toast-container').textContent.includes('图片已保存到'));
        check(!document.getElementById('chat-messages').textContent.includes('图片已保存到'), 'Image save inserted a chat entry');
      })()`);
      assert.deepEqual(
        fs.readFileSync(savedImage),
        Buffer.from(fixtureImage.split(',')[1], 'base64'),
      );

      await contents.executeJavaScript(`(async () => { ${helpers}
        const request = (...args) => window.api.backendRequest('history:manage', ...args);
        const { rows } = await request('list');
        check(rows.some(row => row.mode === 'chat'), 'History management did not list the completed chat');
        const chosen = rows.find(row => row.mode === 'chat');
        const { text } = await request('backup', { rows: [chosen], password: 'fixture-password' });
        check(JSON.parse(text).format === 'cibyp-conversations-encrypted', 'Encrypted archive was not sealed');
        const { restored, failed } = await request('restore', { text, password: 'fixture-password' });
        check(restored.length === 1 && failed.length === 0 && restored[0].id !== chosen.id, 'Backup was not restored to a new conversation');
        const { deleted } = await request('delete', { rows: restored });
        check(deleted[0].ok, 'Batch deletion did not remove the restored copy');
        const entropy = (...args) => window.api.backendRequest('entropy:request', ...args);
        await entropy('save', { pools: [{ id: 'on-host', name: 'OS fixture' }], activePoolId: 'on-host' });
        const { sources } = await entropy('test', { id: 'on-host' });
        check(sources.length === 1 && sources[0].kind === 'os' && sources[0].status === 'used', 'Native entropy pool sampling failed');
        await entropy('save', { pools: [], activePoolId: '' });
        await window.__s1.agent.setMinimalMode(false);
        const file = await window.__s1.agent.executeTool('presentFile', {
          path: ${JSON.stringify(presented)}, title: 'Presented report'
        });
        check(file.ok, 'Agent file presentation failed: ' + JSON.stringify(file));
        const catalog = await window.api.backendRequest('artifacts:list', { query: 'Presented report' });
        check(catalog.items.length === 1 && catalog.items[0].filename === 'test-report.txt', 'Presented file missing from artifact catalog');
        const files = await window.api.localSearch(${JSON.stringify(path.dirname(presented))}, 'test-report.*');
        check(files.ok && files.results.length === 1, 'Isolated file lookup failed: ' + JSON.stringify(files));
        window.navigatePage('settings');
        await until(() => document.getElementById('page-settings').classList.contains('active'), 'Settings did not open');
        document.querySelector('.settings-tab[data-tab="artifacts"]').click();
        await until(() => document.querySelector('#settings-presented-artifacts li')?.textContent.includes('Presented report'), 'Artifact was not shown in settings');
        document.querySelector('.settings-tab[data-tab="history-management"]').click();
        await until(() => document.querySelector('#settings-history-management li'), 'History manager did not render conversations');
        document.querySelector('.settings-tab[data-tab="entropy"]').click();
        await paint();
        await until(() => !document.querySelector('[data-pool-new]').disabled, 'Entropy settings did not load');
        document.querySelector('[data-pool-new]').click();
        const poolForm = document.querySelector('[data-pool-form]');
        poolForm.elements.poolName.value = 'Fixture pool';
        poolForm.elements.active.checked = true;
        poolForm.requestSubmit();
        await until(() => document.querySelector('#entropy-pool-select option')?.textContent === 'Fixture pool', 'Entropy pool editor did not save');
        poolForm.querySelector('[data-pool-test]').click();
        await until(() => document.querySelector('.entropy-pool-sources li[data-used="true"]'), 'Entropy pool test did not render source status');
      })()`);

      // 4. SuperAgent switches & Code workspace selector
      await contents.executeJavaScript(`(async () => { ${helpers}
        window.navigatePage('superagent');
        await until(() => document.querySelector('#page-superagent .super-composer'));
        await until(() => document.querySelectorAll('#page-superagent [data-preferences] input[type="checkbox"]').length >= 3);
        const switches = [...document.querySelectorAll('#page-superagent [data-preferences] input[type="checkbox"]')];
        for (const el of switches) {
          const after = getComputedStyle(el, '::after');
          const trackW = el.getBoundingClientRect().width;
          const left = parseFloat(after.left);
          const width = parseFloat(after.width);
          check(after.transform === 'none', 'Switch thumb has stray transform: ' + after.transform);
          check(left >= 0 && left + width <= trackW - 1, 'Switch thumb outside track: ' + JSON.stringify({ left, width, trackW }));
        }
        const modeSelect = document.querySelector('#page-superagent .super-composer select[name="mode"]');
        modeSelect.value = 'code';
        modeSelect.dispatchEvent(new Event('change'));
        await paint();
        check(!document.querySelector('#page-superagent [data-workspace-bar]').hidden, 'SuperAgent Code workspace bar did not show');
      })()`);
      await savePreview('verify-superagent-code');
      console.log('[session-and-ui-fixes] 3/5 SuperAgent switches & Code workspace bar passed');

      // 5. Quant chat live SSE streaming (reasoning + markdown rendered BEFORE stream finishes)
      await contents.executeJavaScript(`(async () => { ${helpers}
        window.navigatePage('quant');
        await until(() => document.getElementById('page-quant').classList.contains('active'));
        const ws = await window.api.backendRequest('quant:request', 'workspace.create', {
          name: 'Stream Check',
          market: { venue: 'coinbase', product: 'BTC-USD', interval: 3600 },
        });
        await window.CibypQuant.open();
        await until(() => document.querySelector('#page-quant [data-chat-input]'));
        const qInput = document.querySelector('#page-quant [data-chat-input]');
        qInput.value = 'Stream a quick signal check';
        document.querySelector('#page-quant [data-chat-form]').requestSubmit();
      })()`);
      await until(() => pendingStreams.length >= 2, 'Quant chat SSE stream did not start');
      const quantStream = pendingStreams[1];
      quantStream.push({ reasoning_content: 'Checking orderbook momentum...' });
      quantStream.push({ content: '**Alpha** signal ' });

      await contents.executeJavaScript(`(async () => { ${helpers}
        await until(() => {
          const el = document.querySelector('#page-quant .quant-stream');
          return el && el.textContent.includes('Alpha') && el.querySelector('strong');
        }, 'Quant chat did not render live streaming markdown before stream end');
        const reasoningEl = document.querySelector('#page-quant .quant-stream .quant-reasoning');
        check(reasoningEl && !reasoningEl.hidden && reasoningEl.textContent.includes('Checking orderbook momentum'), 'Quant reasoning stream missing');
        check(document.querySelector('#page-quant [data-chat-working]').hidden, 'Quant working placeholder still visible while streaming tokens');
      })()`);
      // Wait past the old 120ms debounce window to confirm duplicate stream-chunk events do NOT wipe stream!
      await new Promise((r) => setTimeout(r, 250));
      await contents.executeJavaScript(`(async () => { ${helpers}
        const el = document.querySelector('#page-quant .quant-stream');
        check(el && el.textContent.includes('Alpha'), 'Quant stream was wiped during streaming!');
      })()`);

      quantStream.push({ content: 'confirmed.' });
      quantStream.finish();
      await contents.executeJavaScript(`(async () => { ${helpers}
        await until(() => {
          const text = document.querySelector('#page-quant [data-chat-messages]').textContent;
          return text.includes('Alpha signal confirmed.') && !document.querySelector('#page-quant .quant-stream .streaming-cursor');
        }, 'Quant final streamed message did not settle');
      })()`);
      console.log('[session-and-ui-fixes] 4/5 Quant live SSE streaming passed');

      assert.deepEqual(errors, [], 'Uncaught renderer errors: ' + errors.join('; '));
      console.log('[session-and-ui-fixes] 5/5 Zero renderer errors');
      finish();
    } catch (error) {
      finish(error);
    }
  }, 500),
);

require('../../src/main/main');
