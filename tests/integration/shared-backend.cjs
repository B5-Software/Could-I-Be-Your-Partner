/* SPDX-License-Identifier: GPL-3.0-or-later */
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
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
const avatarFile = path.join(profile, 'avatar.png');
fs.copyFileSync(path.resolve(__dirname, '../../assets/icons/icon.png'), avatarFile);
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    aiPersona: { name: 'CIBYP', avatar: avatarFile },
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
    const compacting = String(options?.body || '').includes('压缩引擎');
    await new Promise((resolve) => setTimeout(resolve, compacting ? 1800 : 160));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Shared backend reply',
              reasoning_details: [
                {
                  type: 'reasoning.summary',
                  summary: 'Checked the project requirements before replying.',
                },
                { type: 'reasoning.encrypted', data: 'OPAQUE-NEVER-DISPLAY' },
              ],
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  if (/^http:\/\/127\.0\.0\.1:/.test(String(url))) return realFetch(url, options);
  throw new Error('External network disabled');
};
// Use the real updater and RPC/event flow with a harmless verified download.
const { AppUpdates } = require('../../src/main/services/app-updates');
// The integration fixture runs unpackaged Electron; exercise the installer UI
// using the release source while leaving development builds protected in production.
const installation = AppUpdates.prototype.installation;
AppUpdates.prototype.installation = function () {
  return { ...installation.call(this), source: 'release' };
};
// Electron test entrypoints report Electron's own version. Display the product
// version for this fixture, as the packaged entrypoint does in production.
const productVersion = require('../../package.json').version;
const updateStatus = AppUpdates.prototype.status;
AppUpdates.prototype.status = function () {
  return { ...updateStatus.call(this), currentVersion: productVersion };
};
const prepare = AppUpdates.prototype.prepare;
const updateBytes = Buffer.from('integration fixture, never executed');
let downloads = 0;
let fixtureUpdater;
AppUpdates.prototype.prepare = function () {
  fixtureUpdater = this;
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
    await until(
      () =>
        BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('/index.html')),
      'GUI created',
    );
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
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'webui-integration',
      },
    });
    await web.loadURL(status.url + '/login');
    const surfaceShots = path.resolve(__dirname, '../../.cache/screenshots/webui-fixes');
    fs.mkdirSync(surfaceShots, { recursive: true });
    async function snapshot() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await web.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          });
        } catch (error) {
          // Chromium may briefly have no compositing surface after navigation.
          if (!error.message.includes('UnknownVizError') || attempt === 2) throw error;
          await pause(300);
        }
      }
    }
    const capture = async (name) => {
      await web.webContents.executeJavaScript(
        'document.getAnimations().forEach(animation => { if (animation.playState === "running") animation.finish(); })',
      );
      fs.writeFileSync(path.join(surfaceShots, name + '.png'), (await snapshot()).toPNG());
    };
    await capture('login');
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
    for (const frontend of [gui, web]) {
      await until(
        () =>
          frontend.webContents.executeJavaScript(
            '!!document.querySelector(".reasoning-content")?.textContent.includes("Checked the project requirements")',
          ),
        'readable reasoning summary',
      );
      assert.match(
        await frontend.webContents.executeJavaScript(
          'document.querySelector(".reasoning-header").textContent',
        ),
        /推理摘要|Reasoning summary/,
      );
      assert.equal(
        await frontend.webContents.executeJavaScript(
          'document.body.textContent.includes("OPAQUE-NEVER-DISPLAY")',
        ),
        false,
      );
      assert.equal(
        await frontend.webContents.executeJavaScript(
          'document.querySelector(".reasoning-section").getBoundingClientRect().height > 0',
        ),
        true,
        'completed-only messages are visible',
      );
    }
    const publicMessages = (await client.request('getSessionDetails', key)).messages;
    assert.ok(publicMessages.some((message) => message.reasoningKind === 'summary'));
    assert.equal(
      JSON.stringify(publicMessages).includes('OPAQUE-NEVER-DISPLAY'),
      false,
      'mobile and other clients receive readable reasoning only',
    );
    await web.loadURL(web.webContents.getURL());
    await until(
      () =>
        web.webContents.executeJavaScript(
          '!!document.querySelector(".reasoning-content")?.textContent.includes("Checked the project requirements")',
        ),
      'summary survives frontend reconnect',
    );
    await web.webContents.executeJavaScript(
      'document.querySelector(".reasoning-section").classList.remove("collapsed")',
    );
    await pause(300);
    const screenshots = path.resolve(__dirname, '../../.cache/screenshots');
    fs.mkdirSync(screenshots, { recursive: true });
    fs.writeFileSync(
      path.join(screenshots, 'reasoning-summary-webui.png'),
      (await snapshot()).toPNG(),
    );
    const updateEvents = [];
    const unsubscribe = runtime.onEvent((event) => {
      if (event.type === 'update') updateEvents.push(event.state);
    });
    await Promise.all([
      runtime.api.updatesStart(),
      web.webContents.executeJavaScript(
        `(() => { const input=document.querySelector('#chat-input'); input.value='/update '; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`,
      ),
    ]);
    await until(
      () => web.webContents.executeJavaScript('!!document.querySelector(".app-update-notice")'),
      'browser update reminder',
    );
    await until(
      () => gui.webContents.executeJavaScript('!!document.querySelector(".app-update-notice")'),
      'GUI update reminder',
    );
    for (const frontend of [gui, web]) {
      await until(
        () =>
          frontend.webContents.executeJavaScript(
            '(() => { const card=document.querySelector(".app-update-notice").getBoundingClientRect(), input=document.querySelector(".chat-input-area").getBoundingClientRect(), chat=document.querySelector("#chat-messages").getBoundingClientRect();return card.bottom<=input.top-8 && card.left>=chat.left && card.right<=chat.right; })()',
          ),
        'update notice stays in chat above composer',
      );
    }
    await until(() => updateEvents.some((state) => state.phase === 'ready'), 'TUI update reminder');
    assert.equal(downloads, 1, 'all clients share one download');
    await web.webContents.executeJavaScript(
      "window.navigatePage('settings');window.activateSettingsTab('updates')",
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          "document.querySelector('#updates-install-source').textContent.includes('Release')",
        ),
      'installation source in update settings',
    );
    await until(
      () =>
        web.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('.settings-panel[data-tab="updates"]');
        const rect = panel.getBoundingClientRect();
        return panel.classList.contains('active') && !panel.inert && panel.getAttribute('aria-hidden') === 'false' && rect.width > 300 && rect.height > 200;
      })()`),
      'update panel is visible and interactive',
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        "document.querySelector('#btn-updates-install').hidden",
      ),
      false,
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        "document.querySelector('#setting-updates-download').checked",
      ),
      false,
      'background downloads are opt-in',
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        "document.querySelector('#updates-current-version').textContent",
      ),
      'v' + productVersion,
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        'getComputedStyle(document.querySelector(".app-update-notice")).display',
      ),
      'none',
      'settings use inline update controls instead of the chat reminder',
    );
    await pause(5500);
    await capture('updates-settings');
    const readyState = await runtime.api.updatesStatus();
    fixtureUpdater.change({
      ...readyState,
      phase: 'downloading',
      downloaded: 512,
      total: 1024,
    });
    await until(
      () =>
        web.webContents.executeJavaScript(
          "document.querySelector('#updates-download-progress').value===50 && !document.querySelector('#updates-download-progress').hidden",
        ),
      'shared download progress',
    );
    fixtureUpdater.change(readyState);
    await until(
      () =>
        web.webContents.executeJavaScript("!document.querySelector('#btn-updates-install').hidden"),
      'ready update actions',
    );
    await web.webContents.executeJavaScript("window.navigatePage('chat')");
    // Check real rendered layouts without starting an IDE or making model calls.
    const checkDock = async (label) =>
      until(
        () =>
          web.webContents.executeJavaScript(`(() => {
      const page=document.querySelector('#page-chat.active,#page-code.active,#page-babe.active');
      const chat=page.querySelector('#chat-messages,#code-chat-messages,#babe-chat-messages').getBoundingClientRect();
      const input=page.querySelector('.chat-input-area,.code-agent-composer,.babe-chat-input').getBoundingClientRect();
      const dock=document.querySelector('#chat-notice-dock').getBoundingClientRect();
      const card=document.querySelector('.app-update-notice').getBoundingClientRect();
      return card.width>0 && card.height>0 && dock.bottom<=input.top-8 && dock.left>=chat.left && dock.right<=chat.right && dock.top>=chat.top;
    })()`),
        label,
      );
    await web.webContents.executeJavaScript(
      "window.showToast('已准备好安装新版本','success',60000)",
    );
    await checkDock('stacked notices stay above composer');
    assert.equal(
      await web.webContents.executeJavaScript(
        `(() => { const a=document.querySelector('.toast-item').getBoundingClientRect(), b=document.querySelector('.app-update-notice').getBoundingClientRect();return a.bottom<=b.top; })()`,
      ),
      true,
      'toast and update card do not overlap',
    );
    const originalSize = web.getSize();
    web.setSize(640, 900);
    await checkDock('narrow chat dock');
    await web.webContents.executeJavaScript(
      "document.querySelector('#chat-input').style.height='160px'",
    );
    await checkDock('multiline composer dock');
    await web.webContents.executeJavaScript(
      "document.querySelector('#chat-input').style.height='';document.querySelector('#btn-todo-sidebar').click()",
    );
    await checkDock('Todo sidebar dock');
    await web.webContents.executeJavaScript("document.querySelector('#btn-todo-sidebar').click()");
    web.setSize(...originalSize);
    for (const mode of ['code', 'babe']) {
      await web.webContents.executeJavaScript(
        `document.querySelectorAll('.page.active').forEach(p=>p.classList.remove('active'));document.querySelector('#page-${mode}').classList.add('active')`,
      );
      await checkDock(mode + ' chat dock');
      if (mode === 'code') {
        await web.webContents.executeJavaScript(
          "document.body.classList.add('code-immersive');document.querySelector('#code-agent-panel').style.setProperty('--code-agent-width','320px')",
        );
        await checkDock('immersive resized Code sidebar dock');
        await capture('update-code');
        await web.webContents.executeJavaScript(
          "document.body.classList.remove('code-immersive');document.querySelector('#code-agent-panel').style.removeProperty('--code-agent-width')",
        );
      }
    }
    await web.webContents.executeJavaScript(
      "document.querySelectorAll('.page.active').forEach(p=>p.classList.remove('active'));document.querySelector('#page-chat').classList.add('active');document.querySelectorAll('.toast-item').forEach(n=>n.click())",
    );
    await checkDock('restored chat dock');
    await pause(500);
    assert.equal(
      await web.webContents.executeJavaScript(
        `(() => { const r=document.querySelector('.app-update-notice').getBoundingClientRect(); return r.width>0 && r.height>0 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })()`,
      ),
      true,
      'update reminder must be visibly inside the viewport',
    );
    fs.writeFileSync(path.join(screenshots, 'update-ready-webui.png'), (await snapshot()).toPNG());
    // Exercise the real owner, GUI and browser indicator with a delayed summary.
    const attachment = await client.request('uploadAttachment', key, {
      name: 'project-notes.md',
      type: 'text/markdown',
      data: Buffer.from('Attachment preview fixture').toString('base64'),
    });
    await runtime.sendMessage(key, 'Review the attached project notes.', [attachment]);
    await until(
      () =>
        web.webContents.executeJavaScript('!!document.querySelector(".message-attachment-card")'),
      'structured attachment card',
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        'document.querySelector(".message-attachment-card").textContent.includes("project-notes.md")',
      ),
      true,
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        'document.querySelector(".message-attachment-card").textContent.includes("/workspace")',
      ),
      false,
    );
    const owner = main.getAgentRuntime().sessions.get(key).agent;
    owner.contextManager.addUserMessage('Confirmed project requirement. '.repeat(1800), {
      displayContent: 'Earlier project requirements',
      attachments: [],
    });
    owner.contextManager.addAssistantMessage(
      'Keep the project constraints and the attachment path.',
    );
    owner.contextManager.addUserMessage('Continue implementing the current task.');
    const originalTranscript = JSON.stringify(owner.contextManager.getHistoryMessages());
    const compactEvents = [];
    const stopCompactEvents = runtime.onEvent((event) => {
      if (event.type === 'context-compaction') compactEvents.push(event.data);
    });
    const compacting = client.request('agentAction', key, 'compactNow', []);
    await until(
      () =>
        web.webContents.executeJavaScript(
          'document.querySelector("#chat-context-indicator-compaction")?.dataset.phase === "running"',
        ),
      'live browser compaction status',
    );
    await until(
      () =>
        gui.webContents.executeJavaScript(
          'document.querySelector("#chat-context-indicator-compaction")?.dataset.phase === "running"',
        ),
      'live GUI compaction status',
    );
    await pause(100);
    fs.writeFileSync(path.join(screenshots, 'context-compacting.png'), (await snapshot()).toPNG());
    assert.equal(
      (await client.request('sendMessage', key, 'Do not lose this message')).ok,
      false,
      'manual compaction cannot silently enqueue a message',
    );
    const compactResult = await compacting;
    assert.equal(compactResult.result.ok, true);
    await until(
      () =>
        web.webContents.executeJavaScript(
          'document.querySelector("#chat-context-indicator-compaction")?.dataset.phase === "done"',
        ),
      'completed browser compaction status',
    );
    assert.ok(compactEvents.some((state) => state.phase === 'running'));
    assert.equal(compactEvents.at(-1).phase, 'done');
    assert.ok(compactEvents.at(-1).afterTokens < compactEvents.at(-1).beforeTokens);
    assert.equal(JSON.stringify(owner.contextManager.getHistoryMessages()), originalTranscript);
    assert.equal(
      (await client.request('getSessionDetails', key)).messages.some(
        (m) => m.attachments?.[0]?.name === 'project-notes.md',
      ),
      true,
    );
    await pause(300);
    fs.writeFileSync(path.join(screenshots, 'context-compacted.png'), (await snapshot()).toPNG());
    stopCompactEvents();
    await runtime.saveSettings({ animations: false });
    await until(
      () =>
        web.webContents.executeJavaScript('document.documentElement.dataset.animations === "off"'),
      'global motion preference',
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        'document.body.animate([{opacity:0},{opacity:1}], {duration:900}).effect.getTiming().duration',
      ),
      0,
      'all Web Animations follow the global switch',
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          'document.querySelector("#chat-context-indicator-compaction")?.hidden',
        ),
      'completion indicator expires',
    );
    assert.equal((await runtime.api.updatesStatus()).phase, 'ready');
    const restored = new AppUpdates({ app, settings: () => ({}), publish() {} });
    await restored.restore();
    assert.equal(restored.status().phase, 'ready', 'verified download survives restart');
    unsubscribe();
    // Main services survive closing the GUI; the browser still sends a new turn.
    gui.destroy();
    // Exercise the actual browser controls after the desktop window is gone.
    // Terminal output must travel through the backend event bus, never a GUI sink.
    await web.webContents.executeJavaScript(
      'document.querySelector("#btn-chat-show-terminals").click();document.querySelector("#btn-terminal-new").click();',
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          '!!document.querySelector(".terminal-panel .xterm-helper-textarea")',
        ),
      'browser creates terminal',
    );
    await pause(800);
    await web.webContents.executeJavaScript(
      'document.querySelector(".terminal-panel .xterm-helper-textarea").focus()',
    );
    web.webContents.insertText('echo CIBYP_WEBUI_INPUT_OK');
    await pause(200);
    web.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    web.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until(async () => {
      const terminals = await runtime.api.listTerminals();
      const result = await runtime.api.getTerminalHistory(terminals.terminals[0]?.id);
      return /\r?\nCIBYP_WEBUI_INPUT_OK\r?\n/.test(result.history || '');
    }, 'browser input executes in real shell');
    await until(
      () =>
        web.webContents.executeJavaScript(
          'document.querySelector(".terminal-panel .xterm-screen").textContent.includes("CIBYP_WEBUI_INPUT_OK")',
        ),
      'browser receives live terminal output',
    );
    await capture('terminal');
    const terminalId = (await runtime.api.listTerminals()).terminals[0].id;
    await web.webContents.executeJavaScript(
      'document.querySelector("#btn-close-terminal-modal").click()',
    );
    await runtime.api.writeTerminal(terminalId, 'echo CIBYP_HIDDEN_OUTPUT_OK\r');
    await pause(500);
    await web.webContents.executeJavaScript(
      'document.querySelector("#btn-chat-show-terminals").click()',
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          'document.querySelector(".terminal-panel .xterm-screen").textContent.includes("CIBYP_HIDDEN_OUTPUT_OK")',
        ),
      'output survives closing terminal modal',
    );
    await runtime.api.writeTerminal(terminalId, 'exit\r');
    await until(async () => !(await runtime.api.listTerminals()).terminals.length, 'shell exits');
    await web.webContents.executeJavaScript(
      'document.querySelector("#btn-close-terminal-modal").click()',
    );
    const workspace = await web.webContents.executeJavaScript(
      'window.__sessionManager.getActive("chat").agent.workspacePath || window.api.workspaceGetBase()',
    );
    fs.mkdirSync(path.join(workspace, 'browser-subfolder'), { recursive: true });
    const downloadFile = path.join(workspace, 'browser-subfolder', 'webui-note.txt');
    fs.writeFileSync(downloadFile, 'Downloaded from the connected backend.');
    await web.webContents.executeJavaScript(
      'document.querySelector("#btn-open-workspace").click()',
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          '!![...document.querySelectorAll("dialog.workspace-browser[open] .workspace-browser-file")].find(row => row.textContent === "browser-subfolder")',
        ),
      'workspace button opens browser file list',
    );
    await web.webContents.executeJavaScript(
      '[...document.querySelectorAll(".workspace-browser-file")].find(row => row.textContent === "browser-subfolder").click()',
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          '!![...document.querySelectorAll(".workspace-browser-file")].find(row => row.textContent === "webui-note.txt")',
        ),
      'workspace folder navigation',
    );
    const fileResult = await web.webContents.executeJavaScript(
      `fetch('/api/files/download?' + new URLSearchParams({path:${JSON.stringify(downloadFile)}})).then(async r=>({status:r.status,text:await r.text()}))`,
    );
    assert.equal(fileResult.status, 200);
    assert.equal(fileResult.text, 'Downloaded from the connected backend.');
    assert.equal(
      (
        await realFetch(
          status.url + '/api/files/download?' + new URLSearchParams({ path: downloadFile }),
        )
      ).status,
      401,
    );
    await capture('workspace');
    web.show();
    web.focus();
    await web.webContents.executeJavaScript(
      'document.querySelector(".workspace-browser [data-close]").click();document.querySelector("#btn-chat-search").click();document.querySelector("#chat-search-input").focus()',
    );
    web.webContents.focus();
    await pause(120);
    const focus = await web.webContents.executeJavaScript(
      '(() => { const probe=document.createElement("i");probe.style.color="var(--accent)";document.body.append(probe);const result={input:getComputedStyle(document.querySelector("#chat-search-input")).outlineStyle,border:getComputedStyle(document.querySelector("#chat-search-input")).borderTopWidth,wrapper:getComputedStyle(document.querySelector(".chat-search-bar")).borderTopColor,accent:getComputedStyle(probe).color,focused:document.querySelector("#chat-search-input").matches(":focus"),enabled:document.documentElement.dataset.focusOutlines};probe.remove();return result;})()',
    );
    assert.equal(focus.input, 'none', 'search input has no inner focus outline');
    assert.equal(focus.border, '0px', 'search input has no inner border');
    assert.equal(
      focus.wrapper,
      focus.accent,
      'search outer boundary uses the current mode accent: ' + JSON.stringify(focus),
    );
    await capture('search');
    await web.webContents.executeJavaScript('document.querySelector("#chat-search-close").click()');
    assert.equal(
      await web.webContents.executeJavaScript(
        '[...document.querySelectorAll("img")].some(img=>img.src.includes("/api/avatar?") && img.complete && img.naturalWidth>0)',
      ),
      true,
      'configured local avatar loads in browser',
    );
    assert.equal(
      (await realFetch(status.url + '/api/avatar?source=' + encodeURIComponent(avatarFile))).status,
      401,
    );
    assert.equal(
      await web.webContents.executeJavaScript(
        `fetch('/api/avatar?source='+encodeURIComponent(${JSON.stringify(downloadFile)})).then(r=>r.status)`,
      ),
      404,
      'avatar endpoint cannot expose arbitrary backend files',
    );
    // Supply two harmless canvas camera streams, never access a real device.
    await web.webContents.executeJavaScript(`(() => {
      window.__cameraRequests=[];window.__stoppedCameraTracks=0;window.__cameraTimers=[];
      navigator.mediaDevices.enumerateDevices=async()=>[{kind:'videoinput',deviceId:'front',label:'Front camera'},{kind:'videoinput',deviceId:'rear',label:'Rear camera'}];
      navigator.mediaDevices.getUserMedia=async options=>{
        const id=options.video.deviceId?.exact||'front';window.__cameraRequests.push(id);
        const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;
        const draw=()=>{const ctx=canvas.getContext('2d');ctx.fillStyle='#192a45';ctx.fillRect(0,0,960,540);ctx.fillStyle='#83c9d8';ctx.font='32px sans-serif';ctx.fillText('Camera preview • '+id,290,275);};draw();
        const timer=setInterval(draw,80);window.__cameraTimers.push(timer);const stream=canvas.captureStream(12);
        const track=stream.getVideoTracks()[0],stop=track.stop.bind(track);track.getSettings=()=>({deviceId:id,facingMode:id==='front'?'user':'environment'});
        track.stop=()=>{window.__stoppedCameraTracks++;clearInterval(timer);stop();};return stream;
      };document.querySelector('#btn-camera').click();
    })()`);
    await until(
      () =>
        web.webContents.executeJavaScript(
          '!document.querySelector("#btn-capture-photo").disabled && document.querySelector("#camera-device").options.length===2',
        ),
      'browser camera preview',
    );
    await capture('camera');
    await web.webContents.executeJavaScript('document.querySelector("#btn-switch-camera").click()');
    await until(
      () =>
        web.webContents.executeJavaScript(
          'document.querySelector("#camera-device").value==="rear" && !document.querySelector("#btn-capture-photo").disabled',
        ),
      'camera switches devices',
    );
    await web.webContents.executeJavaScript('document.querySelector("#btn-capture-photo").click()');
    assert.equal(
      await web.webContents.executeJavaScript(
        '!document.querySelector("#camera-photo").hidden && window.__stoppedCameraTracks===2',
      ),
      true,
      'preview releases both live camera streams',
    );
    await capture('camera-photo');
    await web.webContents.executeJavaScript('document.querySelector("#btn-use-photo").click()');
    await until(
      () =>
        web.webContents.executeJavaScript(
          'document.querySelector("#camera-modal").classList.contains("hidden") && document.querySelector("#attachments-preview").textContent.includes("camera-")',
        ),
      'photo attaches through browser upload',
    );
    await web.webContents.executeJavaScript(
      'document.querySelector(".attachment-remove").click();window.__cameraTimers.forEach(clearInterval)',
    );
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
    const originalUser = owner.contextManager
      .getHistoryMessages()
      .find((m) => m.role === 'user' && m.metadata?.attachments?.length);
    assert.ok(originalUser?.metadata.messageId);
    await web.webContents.executeJavaScript(
      `window.confirmDialog = async () => true; document.querySelector('.message-attachment-card').closest('.message.user').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:250,clientY:230})); document.querySelector('.message-context-menu').lastElementChild.click();`,
    );
    await until(
      () =>
        !owner.contextManager
          .getHistoryMessages()
          .some((m) => m.metadata?.messageId === originalUser.metadata.messageId),
      'message deletion reaches backend history',
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          `!document.querySelector('#chat-messages').textContent.includes('Review the attached project notes.')`,
        ),
      'deletion replay',
    );
    assert.ok(
      owner.contextManager.messages.some((m) =>
        m.metadata?.compactedIds?.includes(originalUser.metadata.messageId),
      ),
      'existing checkpoint remains after deleting its original turn',
    );
    // Editors stay in the browser while CRUD and file bytes use the shared owner.
    const initialWindows = BrowserWindow.getAllWindows().length;
    const skill = await web.webContents.executeJavaScript(
      `window.api.createSkill({name:'Browser skill',description:'Browser CRUD fixture',prompt:'Return a fixture',type:'custom'})`,
    );
    await web.webContents.executeJavaScript(
      `window.api.openSkillEditor({id:${JSON.stringify(skill.id)}})`,
    );
    const frameReady = async (expression, label) =>
      until(
        () =>
          web.webContents.executeJavaScript(
            `(() => { const w=document.querySelector('.cibyp-browser-surface iframe')?.contentWindow;return !!w && (${expression}); })()`,
          ),
        label,
      );
    const inFrame = (code) =>
      web.webContents.executeJavaScript(
        `(async () => { const w=document.querySelector('.cibyp-browser-surface iframe').contentWindow;${code} })()`,
      );
    await frameReady(
      "w.document.querySelector('#skill-name')?.value==='Browser skill'",
      'browser skill editor loads',
    );
    await inFrame(
      "w.document.querySelector('#skill-description').value='Edited from the browser';w.document.querySelector('#btn-save').click()",
    );
    await until(
      async () =>
        (await client.request('ipc:invoke', 'skill-editor:getSkill', skill.id)).skill
          ?.description === 'Edited from the browser',
      'browser skill editor persists',
    );
    await capture('skill-editor');
    await inFrame('await w.skillEditorAPI.closeWindow()');
    await until(
      () => web.webContents.executeJavaScript("!document.querySelector('.cibyp-browser-surface')"),
      'skill editor closes',
    );
    await web.webContents.executeJavaScript("window.navigatePage('automation')");
    const automation = await web.webContents.executeJavaScript(
      `window.api.automationSave({name:'Browser automation',enabled:false,trigger:{type:'schedule',config:{cron:'0 0 * * *'}},dsl:'return "fixture"'})`,
    );
    assert.equal(automation.ok, true);
    await web.webContents.executeJavaScript(
      `window.api.openAutomationEditor(${JSON.stringify(automation.task.id)})`,
    );
    await frameReady(
      "w.document.querySelector('#ae-name')?.value==='Browser automation'",
      'browser automation editor loads',
    );
    await inFrame(
      "w.document.querySelector('#ae-name').value='Edited browser automation';w.document.querySelector('#btn-save').click()",
    );
    await until(
      async () =>
        (await client.request('ipc:invoke', 'automation:get', automation.task.id)).task?.name ===
        'Edited browser automation',
      'browser automation persists',
    );
    await until(
      () =>
        web.webContents.executeJavaScript(
          "document.querySelector('#automation-list').textContent.includes('Edited browser automation')",
        ),
      'automation list updates across editor boundary',
    );
    await capture('automation-editor');
    await inFrame('await w.automationEditorAPI.closeWindow()');
    await until(
      () => web.webContents.executeJavaScript("!document.querySelector('.cibyp-browser-surface')"),
      'automation editor closes',
    );
    await web.webContents.executeJavaScript('window.api.openCipypCad()');
    await frameReady("typeof w.cadGetProjectJSON==='function'", 'browser CAD loads');
    const cadFile = path.join(workspace, 'browser.cipyproj'),
      pngFile = path.join(workspace, 'browser.png');
    assert.equal(
      (await inFrame(`return await w.cadAPI.saveProject(${JSON.stringify(cadFile)})`)).ok,
      true,
    );
    assert.ok(JSON.parse(fs.readFileSync(cadFile, 'utf-8')));
    assert.equal(
      (await inFrame(`return await w.cadAPI.loadProject(${JSON.stringify(cadFile)})`)).ok,
      true,
    );
    assert.equal(
      (await inFrame(`return await w.cadAPI.exportImage(${JSON.stringify(pngFile)},'png')`)).ok,
      true,
    );
    assert.equal(fs.readFileSync(pngFile).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(
      (
        await inFrame(
          `return await w.cadAPI.saveProject(${JSON.stringify(path.join(workspace, 'missing', 'project'))})`,
        )
      ).ok,
      false,
      'browser CAD reports IO errors',
    );
    await capture('cad');
    await inFrame("await w.cadAPI.confirmClose('close')");
    await until(
      () => web.webContents.executeJavaScript("!document.querySelector('.cibyp-browser-surface')"),
      'CAD closes',
    );
    await web.webContents.executeJavaScript('window.api.openPcbEda()');
    await frameReady("typeof w.pcbGetProjectJSON==='function'", 'browser PCB loads');
    assert.equal(
      await inFrame('return typeof w.THREE?.WebGLRenderer'),
      'function',
      'PCB 3D dependency is available in the browser',
    );
    const pcbFile = path.join(workspace, 'browser.cipypcb');
    assert.equal(
      (await inFrame(`return await w.pcbAPI.saveProject(${JSON.stringify(pcbFile)},false)`)).ok,
      true,
    );
    assert.equal(
      (await inFrame(`return await w.pcbAPI.loadProject(${JSON.stringify(pcbFile)})`)).ok,
      true,
    );
    await capture('pcb');
    await inFrame("await w.pcbAPI.confirmClose('close')");
    await until(
      () => web.webContents.executeJavaScript("!document.querySelector('.cibyp-browser-surface')"),
      'PCB closes',
    );
    assert.equal(
      BrowserWindow.getAllWindows().length,
      initialWindows,
      'browser editors never create host windows',
    );
    await web.webContents.executeJavaScript("window.navigatePage('chat')");
    console.log(
      '[shared-backend] Shared runtime, update, file picker, real browser terminal, workspace downloads and single search focus boundary passed.',
    );
    console.log('[shared-backend] Browser errors:', errors);
    assert.deepEqual(errors, [], 'browser surfaces have no script or runtime errors');
    client.close();
    web.destroy();
    app.quit();
  } catch (error) {
    console.error('[shared-backend] FAIL', error.stack, errors);
    app.exit(1);
  }
})();
