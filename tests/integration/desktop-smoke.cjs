/* Full app startup with a temporary profile. No access to the user's credentials. */
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-desktop-smoke-'));
fs.mkdirSync(path.join(profile, 'data'), { recursive: true });
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    runtime: { location: 'host' },
    closeToTray: 'never',
    trayEnabled: false,
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
  }),
);

// A smoke check must not call external providers or download resources.
global.fetch = async () => {
  throw new Error('Network disabled in desktop smoke check');
};
const errors = [];
let startupNavigationChecked = false;
// Pause the settings request used by Agent.init after navigation listeners exist.
// This reproduces fast clicks during a slow startup, rather than testing only
// pages after renderer-ready has already initialized every lexical variable.
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  originalHandle(channel, async (event, ...args) => {
    if (
      channel === 'settings:get' &&
      !startupNavigationChecked &&
      event.sender.getURL().endsWith('/index.html')
    ) {
      const hasNavigation = await event.sender.executeJavaScript(
        "typeof window.navigatePage === 'function'",
      );
      if (hasNavigation) {
        startupNavigationChecked = true;
        try {
          await event.sender.executeJavaScript(`(() => {
          window.navigatePage('settings');
          window.navigatePage('history');
          window.navigatePage('tools');
          document.querySelector('.tools-mode-btn[data-tool-mode="code"]').click();
          document.querySelector('.mode-btn[data-mode="babe"]').click();
          document.querySelector('.mode-btn[data-mode="chat"]').click();
        })()`);
          await new Promise((resolve) => setTimeout(resolve, 150));
          assert.deepEqual(errors, [], 'early navigation must wait for initialization');
        } catch (error) {
          finish(error);
        }
      }
    }
    return handler(event, ...args);
  });
process.on('uncaughtExceptionMonitor', (error) => errors.push(`Main exception: ${error.message}`));
app.on('browser-window-created', (_event, window) => {
  if (process.env.CIBYP_UI_PREVIEW_DIR) {
    // A transparent test window lets Windows paint Chromium for native screenshots.
    window.setOpacity(0);
    window.setSkipTaskbar(true);
  } else window.on('show', () => window.hide());
  window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  window.webContents.on('render-process-gone', (_event, details) =>
    errors.push(`Renderer terminated: ${details.reason}`),
  );
  window.webContents.on('console-message', (event) => {
    if (
      event.level === 'error' &&
      /Uncaught|Initialization failed|\[navigation\] Failed/.test(event.message)
    )
      errors.push(event.message);
  });
});

const timeout = setTimeout(
  () => finish(new Error('Renderer did not become ready within 45 seconds')),
  45000,
);
ipcMain.once('app:renderer-ready', (event) => {
  setTimeout(async () => {
    try {
      assert.equal(startupNavigationChecked, true, 'slow startup regression must execute');
      console.log(
        '[desktop-smoke] Queued navigation and mode switches during slow initialization passed.',
      );
      await event.sender.executeJavaScript(`(async () => {
        const deadline = Date.now() + 5000;
        while (!document.getElementById('llm-custom-headers')?.children.length ||
          !document.getElementById('history-list')?.dataset.hlAttached ||
          !document.querySelector('#page-tools [data-computer-recheck]')) {
          if (Date.now() > deadline) throw new Error('Queued startup pages did not hydrate: ' + JSON.stringify({headers: document.getElementById('llm-custom-headers')?.children.length, history: document.getElementById('history-list')?.dataset.hlAttached, tools: !!document.querySelector('#page-tools [data-computer-recheck]')}));
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      })()`);
      const state = await event.sender.executeJavaScript(`(async () => ({
        hasBridge: typeof window.api?.getSettings === 'function',
        settings: await window.api.getSettings(),
        title: document.title,
        hasChat: !!document.getElementById('chat-messages'),
        nodeProcess: typeof window.process,
      }))()`);
      assert.equal(state.hasBridge, true);
      assert.equal(state.nodeProcess, 'undefined');
      assert.equal(state.settings.runtime.location, 'host');
      assert.equal(event.sender.getLastWebPreferences().sandbox, true);
      assert.equal(event.sender.getLastWebPreferences().nodeIntegration, false);
      assert.equal(event.sender.getLastWebPreferences().contextIsolation, true);
      assert.equal(
        BrowserWindow.getAllWindows().some((window) => window.webContents === event.sender),
        true,
      );
      event.sender.setBackgroundThrottling(false);
      // Control the system preference for layout interpolation as well as motion checks.
      event.sender.debugger.attach('1.3');
      await event.sender.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
      const tools = await require('./renderer-tool-check.cjs')(event.sender);
      console.log('[desktop-smoke] Tool discovery and permissions:', tools);
      const workspace = await require('./renderer-workspace-check.cjs')(event.sender);
      console.log('[desktop-smoke] Workspace interactions:', workspace);
      const settingsCheck = await require('./renderer-settings-check.cjs')(event.sender);
      console.log('[desktop-smoke] Settings interactions:', settingsCheck);
      // Hosted Windows runners can default to reduced motion. Exercise both
      // system preferences explicitly instead of depending on this machine's UI.
      const motion = await require('./renderer-motion-check.cjs')(event.sender);
      console.log('[desktop-smoke] Motion policy:', motion);
      event.sender.debugger.detach();
      // DevTools created from the native menu can initially have null web preferences.
      const devToolsOpened = new Promise((resolve) =>
        event.sender.once('devtools-opened', resolve),
      );
      event.sender.openDevTools({ mode: 'detach', activate: false });
      await devToolsOpened;
      event.sender.closeDevTools();
      event.sender.debugger.attach('1.3');
      await event.sender.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      const reduced = await event.sender.executeJavaScript(`(() => {
        document.documentElement.dataset.animations = 'on';
        document.getElementById('btn-todo-sidebar').click();
        document.getElementById('btn-close-todo').click();
        const modal = document.getElementById('message-modal');
        modal.classList.remove('hidden');
        window.fadeOutHide(modal);
        return document.getElementById('todo-panel').classList.contains('hidden') && modal.classList.contains('hidden');
      })()`);
      assert.equal(reduced, true, 'system reduced-motion preference closes without animation');
      event.sender.debugger.detach();
      if (process.env.CIBYP_UI_PREVIEW_DIR) {
        const directory = path.resolve(process.env.CIBYP_UI_PREVIEW_DIR);
        fs.mkdirSync(directory, { recursive: true });
        await event.sender.executeJavaScript(`(() => {
          const active = window.__sessionManager.getActive('chat').agent;
          active.conversationTitle = '校园项目 · 今天的小目标';
          active.handleTodo({ operations: [
            { action: 'add', text: '查阅 OpenCode 的上下文更新设计' },
            { action: 'add', text: '恢复 Todo 侧栏与会话状态' },
            { action: 'add', text: '统一侧边栏动画与键盘交互' },
            { action: 'add', text: '完成回归检查并提交代码' },
            { action: 'toggle', id: active.todoIdCounter + 1 }
          ] });
          document.documentElement.dataset.animations = 'off';
          document.getElementById('btn-todo-sidebar').click();
        })()`);
        for (const mode of ['light', 'dark']) {
          const applied = await event.sender.executeJavaScript(`(async () => {
            const settings = await window.api.getSettings();
            const theme = { ...settings.theme, mode: '${mode}', accentColor: '#7377dc', backgroundColor: '${mode === 'dark' ? '#171b2b' : '#f5f7fc'}' };
            await window.api.setSettings({ ...settings, theme });
            ThemeManager.apply(theme);
            await new Promise(resolve => setTimeout(resolve, 200));
            return { mode: document.documentElement.dataset.theme, background: getComputedStyle(document.getElementById('todo-panel')).backgroundColor };
          })()`);
          assert.equal(applied.mode, mode);
          assert.equal(
            applied.background,
            mode === 'dark' ? 'rgb(43, 47, 63)' : 'rgb(235, 237, 242)',
          );
          for (const tab of ['overview', 'context', 'budget', 'theme', 'security']) {
            await event.sender.executeJavaScript(`(async () => {
              await window.navigatePage('settings');
              document.getElementById('btn-close-todo').click();
              document.querySelectorAll('#toast-container .toast-item').forEach(toast => toast.click());
              window.activateSettingsTab('${tab}');
              document.querySelector('.settings-panel.active').scrollTop = 0;
              document.querySelectorAll('.settings-advanced').forEach(details => details.open = false);
              await new Promise(resolve => setTimeout(resolve, 350));
            })()`);
            fs.writeFileSync(
              path.join(directory, `settings-${tab}-${mode}.png`),
              (
                await event.sender.capturePage(undefined, { stayHidden: true, stayAwake: true })
              ).toPNG(),
            );
          }
          await event.sender.executeJavaScript(`(async () => {
            window.navigatePage('chat');
            document.getElementById('btn-todo-sidebar').click();
            await new Promise(resolve => setTimeout(resolve, 200));
          })()`);
          fs.writeFileSync(
            path.join(directory, `todo-${mode}.png`),
            (
              await event.sender.capturePage(undefined, { stayHidden: true, stayAwake: true })
            ).toPNG(),
          );
        }
        const previewWindow = BrowserWindow.fromWebContents(event.sender);
        const originalSize = previewWindow.getSize();
        previewWindow.setSize(850, 700);
        await event.sender.executeJavaScript(`(async () => {
          await window.navigatePage('settings');
          window.activateSettingsTab('context');
          document.getElementById('btn-close-todo').click();
          document.querySelector('.settings-panel.active').scrollTop = 0;
          await new Promise(resolve => setTimeout(resolve, 350));
          const panel = document.querySelector('.settings-panel.active');
          if (panel.scrollWidth > panel.clientWidth + 2) throw new Error('narrow settings overflow horizontally');
        })()`);
        fs.writeFileSync(
          path.join(directory, 'settings-context-narrow.png'),
          (
            await event.sender.capturePage(undefined, { stayHidden: true, stayAwake: true })
          ).toPNG(),
        );
        previewWindow.setSize(...originalSize);
        console.log('[desktop-smoke] UI previews:', directory);
      }
      assert.deepEqual(errors, []);
      finish();
    } catch (error) {
      finish(error);
    }
  }, 500);
});

let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error('[desktop-smoke] FAIL:', error.stack, errors);
  else
    console.log('[desktop-smoke] PASS: full app boot, isolated IPC bridge and sandboxed renderer');
  // Keep failure evidence; successful profiles can be removed after Electron exits.
  console.log('[desktop-smoke] profile:', profile);
  app.exit(error ? 1 : 0);
}

try {
  require('../../src/main/main.js');
} catch (error) {
  finish(error);
}
