/* Real Electron app + complete Code-OSS runtime; no user profile or credentials. */
const { app, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('node:http');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-codeoss-'));
const workspace = path.join(profile, 'workspace');
const originalCwd = process.cwd();
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'sample.js'), 'console.log("CIBYP Code-OSS");\n');
fs.writeFileSync(path.join(workspace, '.cibyp-codeoss-test'), 'fixture');
fs.writeFileSync(path.join(workspace, '.cibyp-codeoss-ai'), 'fixture');
const projectAppearance = JSON.stringify({
  'workbench.colorTheme': 'Light Modern',
  'workbench.colorCustomizations': {
    'editor.background': '#ff0000',
    '[Dark Modern]': { 'editor.background': '#00ff00' },
  },
});
fs.mkdirSync(path.join(workspace, '.vscode'));
fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), projectAppearance);
spawnSync('git', ['init', workspace], { windowsHide: true });
fs.mkdirSync(path.join(profile, 'data'), { recursive: true });
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));
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
    terminal: {
      shell: 'custom',
      customShellPath: process.platform === 'win32' ? process.env.ComSpec : '/bin/sh',
      args: process.platform === 'win32' ? ['/D', '/Q'] : [],
    },
    codeMode: { lastWorkspace: workspace },
    theme: { mode: 'light', accentColor: '#725ce7', backgroundColor: '#f5f7fa' },
    aiPersona: {
      avatar:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAuQAAAAASUVORK5CYII=',
      avatarFrame: 'frame-001',
    },
    userProfile: {
      avatar:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAuQAAAAASUVORK5CYII=',
      avatarFrame: 'frame-002',
    },
  }),
);
const ideProfile = path.join(profile, 'data/codeoss');
fs.mkdirSync(path.join(ideProfile, 'User'), { recursive: true });
fs.cpSync(
  path.resolve(__dirname, '../fixtures/codeoss'),
  path.join(ideProfile, 'extensions/cibyp-test.integration-fixture-1.0.0'),
  { recursive: true },
);
fs.writeFileSync(
  path.join(ideProfile, 'User/settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': false,
    'window.titleBarStyle': 'custom',
    'window.menuBarVisibility': 'classic',
    'window.newWindowDimensions': 'maximized',
  }),
);
const modelRequests = [];
const mockModel = http.createServer(async (request, response) => {
  let raw = '';
  for await (const data of request) raw += data;
  const body = JSON.parse(raw);
  modelRequests.push(body);
  const toolResult = body.messages?.some((message) => message.role === 'tool');
  const tool = body.tools?.find((item) => item.function?.name === 'createFile');
  const message =
    tool && !toolResult
      ? {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'fixture-create',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({
                  path: path.join(workspace, 'agent-result.js'),
                  content: 'const throughAgent = true;\n',
                  encoding: 'utf-8',
                  eol: 'lf',
                }),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'CIBYP fixture completed.' };
  const data = {
    id: 'fixture-response',
    model: 'cibyp-fixture',
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = {
      ...message,
      tool_calls: message.tool_calls?.map((item, index) => ({ ...item, index })),
    };
    response.end(
      `data: ${JSON.stringify({ ...data, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...data, choices: [{ index: 0, delta: {}, finish_reason: data.choices[0].finish_reason }] })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  }
});
const modelReady = new Promise((resolve) => mockModel.listen(0, '127.0.0.1', resolve));
const realFetch = global.fetch;
global.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1' || Number(url.port) !== mockModel.address()?.port)
    throw new Error('External network disabled in Code-OSS smoke check');
  return realFetch(input, options);
};
app.on('will-quit', () => mockModel.close());
const errors = [];
process.on('uncaughtExceptionMonitor', (error) => errors.push(error.stack));
process.on('unhandledRejection', (error) => errors.push(error?.stack || String(error)));
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, details) => {
    if (/Uncaught (?:TypeError|ReferenceError|SyntaxError|Error)/.test(details.message))
      errors.push(details.message);
  });
});
app.on('browser-window-created', (_event, win) => {
  if (!process.argv.includes('--visible')) win.setOpacity(0);
  win.setSkipTaskbar(true);
});
const timeout = setTimeout(() => finish(new Error('Code-OSS desktop test timeout')), 90000);

ipcMain.once('app:renderer-ready', (event) => {
  setTimeout(async () => {
    try {
      const renderer = event.sender;
      const service = globalThis.__cibypWorkbenchHost;
      const runtime = process.argv
        .find((value) => value.startsWith('--runtime='))
        ?.slice('--runtime='.length);
      if (runtime) service.runtime = path.resolve(runtime);
      await modelReady;
      await renderer.executeJavaScript(
        `window.api.setSettings(${JSON.stringify({ llm: { apiUrl: `http://127.0.0.1:${mockModel.address().port}/v1/chat/completions`, apiKey: 'fixture-only', model: 'cibyp-fixture', maxRetries: 0 }, toolExposure: { mode: 'all' }, autoOptimizeToolSelection: false })})`,
      );
      const outerWindow = service.getMainWindow();
      const originalBounds = outerWindow.getBounds();
      const originalMaximized = outerWindow.isMaximized();
      await renderer.executeJavaScript('window.navigatePage("code")');
      await waitFor(() => service.activePeer(), 60000);
      assert.deepEqual(
        outerWindow.getBounds(),
        originalBounds,
        'Entering Code must preserve the outer App bounds',
      );
      assert.equal(
        outerWindow.isMaximized(),
        originalMaximized,
        'IDE maximized startup preference must not maximize CIBYP',
      );
      service.nativeCodeWindow.applyState({ mode: 0, width: 1600, height: 1000, x: 0, y: 0 });
      assert.deepEqual(outerWindow.getBounds(), originalBounds);
      console.log('[codeoss-desktop] Native CIBYP extension connected.');
      assert.equal(app.getPath('userData'), profile, 'Code-OSS must preserve the CIBYP profile');
      assert.equal(
        process.cwd(),
        originalCwd,
        'Code-OSS must preserve the CIBYP working directory',
      );
      assert.equal(service.target.path, workspace);
      const connected = service.activePeer();
      assert.equal((await service.open(workspace)).ok, true);
      assert.equal(
        service.activePeer(),
        connected,
        'Reopening the same canonical workspace must preserve the extension host',
      );
      assert.equal(service.view.webContents.getLastWebPreferences().sandbox, true);
      const body = await service.view.webContents.executeJavaScript('document.body.innerText');
      assert.match(body, /EXPLORER|资源管理器/i);
      assert.match(body, /sample.js/);
      assert(app.getAppMetrics().some((item) => item.name?.startsWith('extensionHost')));
      const state = await renderer.executeJavaScript(
        '({viewport: document.getElementById("codeoss-viewport").getBoundingClientRect().toJSON(), ai: document.getElementById("code-agent-panel").getBoundingClientRect().toJSON(), errors: window.__bootstrapError})',
      );
      assert(state.viewport.height > 300, 'Workbench must fill the Code page');
      assert(state.ai.width >= 300, 'CIBYP AI must be a visible sibling of the native IDE');
      assert.equal(state.viewport.right, state.ai.left, 'IDE must not cover the AI sidebar');
      await waitFor(() => fs.existsSync(path.join(workspace, 'fixture-result.json')), 60000);
      const fixture = JSON.parse(
        fs.readFileSync(path.join(workspace, 'fixture-result.json'), 'utf8'),
      );
      assert.equal(fixture.ok, true, fixture.error);
      console.log('[codeoss-desktop] fixture', fixture.passed);
      assert.equal(
        fs.readFileSync(path.join(workspace, 'agent-result.js'), 'utf8').trim(),
        'const throughAgent = true;',
      );
      assert(
        modelRequests.some((item) => item.messages?.some((message) => message.role === 'tool')),
        'Agent must receive and continue after a real tool result',
      );
      await require('./codeoss-agent-check.cjs')(
        renderer,
        service,
        modelRequests,
        workspace,
        waitFor,
      );
      service.view.webContents.debugger.attach('1.3');
      await service.view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
      await require('./codeoss-menus-check.cjs')(service, waitFor);
      await service.view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: false,
      });
      service.view.webContents.debugger.detach();
      await require('./codeoss-appearance-check.cjs')(renderer, service, waitFor);
      for (const [theme, systemMode] of [
        [{ mode: 'dark', accentColor: '#e3a3d4', backgroundColor: '#202536' }],
        [{ mode: 'light', accentColor: '#3b7c67', backgroundColor: '#faf7ed' }],
        [{ mode: 'system', accentColor: '#b085e7', backgroundColor: '#202536' }, 'dark'],
        [{ mode: 'system', accentColor: '#3b7c67', backgroundColor: '#faf7ed' }, 'light'],
      ]) {
        console.log(
          '[codeoss-desktop] theme check',
          theme.mode,
          systemMode || '',
          nativeTheme.themeSource,
        );
        if (systemMode) nativeTheme.themeSource = systemMode;
        const dark =
          theme.mode === 'dark' || (theme.mode === 'system' && nativeTheme.shouldUseDarkColors);
        await renderer.executeJavaScript(`window.api.setSettings(${JSON.stringify({ theme })})`);
        const expected = require('../../integrations/codeoss/theme.cjs').workbenchColors({
          theme,
          dark,
        });
        let lastAppearance;
        await waitFor(async () => {
          const actual = await service.view.webContents.executeJavaScript(
            '({dark: document.querySelector(".monaco-workbench").classList.contains("vs-dark"), background: getComputedStyle(document.querySelector(".monaco-workbench")).getPropertyValue("--vscode-editor-background").trim(), accent: getComputedStyle(document.querySelector(".monaco-workbench")).getPropertyValue("--vscode-focusBorder").trim()})',
          );
          lastAppearance = actual;
          return (
            actual.background.toLowerCase() === expected['editor.background'] &&
            actual.accent.toLowerCase() === expected.focusBorder &&
            actual.dark === dark
          );
        }, 15000).catch((error) => {
          console.error('[codeoss-desktop] theme mismatch', {
            theme,
            dark,
            actual: lastAppearance,
            source: nativeTheme.themeSource,
            systemDark: nativeTheme.shouldUseDarkColors,
          });
          throw error;
        });
        assert.equal(
          service.target.path,
          workspace,
          'Live theme changes must preserve the workspace',
        );
        service.getMainWindow().focus();
        renderer.focus();
        const expectedFocus = `rgb(${[1, 3, 5].map((offset) => parseInt(theme.accentColor.slice(offset, offset + 2), 16)).join(', ')})`;
        let focus;
        await waitFor(async () => {
          focus = await renderer.executeJavaScript(
            `(() => { const input=document.getElementById('code-chat-input'); input.focus(); return {border:getComputedStyle(input).borderColor,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), focused:document.activeElement===input}; })()`,
          );
          return (
            focus.focused &&
            focus.accent.toLowerCase() === theme.accentColor &&
            focus.border === expectedFocus
          );
        }).catch((error) => {
          console.error('[codeoss-desktop] Input focus state:', focus);
          throw error;
        });
        assert.equal(focus.border, expectedFocus, 'Chat focus border follows live accent changes');
        const selection = await service.view.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-editor-selectionBackground').trim()`,
        );
        assert.equal(
          require('../../src/shared/editor-colors').hex(selection),
          expected['editor.selectionBackground'].toLowerCase(),
        );
      }
      nativeTheme.themeSource = 'system';
      console.log(
        '[codeoss-desktop] Live dark/light, accent and background synchronization passed.',
      );
      assert.equal(
        fs.readFileSync(path.join(workspace, '.vscode/settings.json'), 'utf8'),
        projectAppearance,
        'CIBYP appearance must not rewrite project settings',
      );
      await service.request('ide.command', { command: 'workbench.action.terminal.toggleTerminal' });
      await waitFor(
        () => app.getAppMetrics().some((item) => item.name?.startsWith('ptyHost')),
        15000,
      );
      const terminalProbe = await service.request('ide.language', {
        action: 'command',
        command: 'cibypFixture.terminal',
        arguments: ['probe'],
      });
      const configuredShell =
        await require('../../src/main/core/terminal-shell').resolveTerminalShell(
          service.getSettings(),
          'host',
        );
      assert.equal(terminalProbe.result.shellPath, configuredShell.file);
      assert.deepEqual(terminalProbe.result.shellArgs, configuredShell.args);
      console.log(
        '[codeoss-desktop] Toolbar terminal uses the configured custom binary and arguments.',
      );
      await service.request('ide.command', { command: 'workbench.view.extensions' });
      await service.request('ide.command', { command: 'cibyp.agent.focus' });
      service.syncPersonalization();
      console.log(
        '[codeoss-desktop] layout',
        service.visible,
        service.bounds,
        await renderer.executeJavaScript(
          '({hidden: document.hidden, blockers: [...document.querySelectorAll(".modal-overlay, .modal, [role=dialog], .dock-panel")].filter(e => !e.classList.contains("hidden") && e.getAttribute("aria-hidden") !== "true" && e.getClientRects().length > 0).map(e => ({id:e.id, class:e.className, display:getComputedStyle(e).display}))})',
        ),
      );
      await waitFor(() => service.visible, 10000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const screenshot = await service.view.webContents.capturePage();
      const preview = path.resolve(__dirname, '../../.cibyp-test-fixtures-codeoss-preview');
      fs.mkdirSync(preview, { recursive: true });
      fs.writeFileSync(path.join(preview, 'workbench.png'), screenshot.toPNG());
      fs.writeFileSync(
        path.join(preview, 'app-ai.png'),
        (await service.getMainWindow().capturePage()).toPNG(),
      );
      await require('./codeoss-overlay-check.cjs')(renderer, service, preview, waitFor);
      const secondWorkspace = path.join(profile, 'second-workspace');
      const documents = await service.request('ide.language', {
        action: 'command',
        command: 'cibypFixture.documents',
      });
      assert(
        documents.result.every((document) => !document.dirty),
        'Appearance synchronization must never dirty IDE settings or editor documents',
      );
      fs.mkdirSync(secondWorkspace);
      fs.writeFileSync(path.join(secondWorkspace, 'second.js'), 'const second = true;\n');
      const secondResult = await service.open(secondWorkspace);
      assert.equal(secondResult.ok, true, secondResult.error);
      await waitFor(() => service.activePeer(), 30000);
      assert.equal(service.target.path, secondWorkspace);
      await waitFor(
        () =>
          renderer.executeJavaScript(
            `document.getElementById('code-workspace-path').textContent === ${JSON.stringify(secondWorkspace)}`,
          ),
        10000,
      );
      assert.match(
        await service.view.webContents.executeJavaScript('document.body.innerText'),
        /second.js/,
      );
      console.log('[codeoss-desktop] Workspace switch and extension reconnection passed.');
      const nativeWorkspace = path.join(profile, 'native-workspace');
      fs.mkdirSync(nativeWorkspace);
      fs.writeFileSync(path.join(nativeWorkspace, 'native.js'), 'const nativeOpen = true;\n');
      // Uses vscode.openFolder without updating CIBYP's service target first.
      await service.request('ide.openWorkspace', {
        uri: require('node:url').pathToFileURL(nativeWorkspace).href,
      });
      await waitFor(
        () =>
          service.target.path.toLowerCase() === nativeWorkspace.toLowerCase() &&
          service.activePeer(),
        30000,
      );
      await waitFor(
        async () =>
          (
            await renderer.executeJavaScript('window.api.getSettings()')
          ).codeMode.lastWorkspace.toLowerCase() === nativeWorkspace.toLowerCase(),
        10000,
      );
      const sessions = await service.handleExtensionRequest(service.activePeer(), {
        method: 'agent.sessions',
        params: {},
        id: 'native-workspace-check',
      });
      assert.equal(
        sessions.messages.length,
        0,
        'New native workspace must not inherit the previous Agent conversation',
      );
      console.log(
        '[codeoss-desktop] Native Open Folder adopts workspace and isolates Agent history.',
      );
      const oldView = service.view;
      service.embeddedWindow.close();
      await waitFor(() => !service.view, 15000);
      assert.equal(service.overlay.view, null, 'closing the IDE must release the overlay renderer');
      assert.equal((await service.open(nativeWorkspace)).ok, true);
      await waitFor(() => service.activePeer(), 30000).catch(async (error) => {
        console.error('[codeoss-desktop] reopen state', {
          state: service.state,
          id: service.embeddedWindow?.id,
          peers: [...service.peers].map((peer) => ({
            id: peer.windowId,
            workspace: peer.workspace,
          })),
          target: service.target,
          url: service.view?.webContents.getURL(),
          body: await service.view?.webContents.executeJavaScript('document.body.innerText'),
        });
        throw error;
      });
      assert.notEqual(
        service.view,
        oldView,
        'A closed native workbench can reopen in the same CIBYP window',
      );
      console.log('[codeoss-desktop] Native workbench close and reopen passed.');
      // Exercise the real upstream restart lifecycle without relaunching the test runner.
      // Only intercept the final Electron restart and quit effects.
      const lifecycle = service.nativeCodeWindow.lifecycleMainService;
      const originalQuit = lifecycle.quit;
      const originalRelaunch = app.relaunch;
      const originalOnce = app.once;
      let relaunchCallback, relaunched;
      try {
        lifecycle.quit = async () => false;
        app.relaunch = (options) => {
          relaunched = options;
        };
        app.once = function (name, listener) {
          if (name === 'quit') {
            relaunchCallback = listener;
            return this;
          }
          return originalOnce.call(this, name, listener);
        };
        await lifecycle.relaunch({ addArgs: ['--disable-extensions'] });
        assert(relaunchCallback, 'Code-OSS must register a restart after shutdown');
        relaunchCallback();
        assert.deepEqual(relaunched.args, [...process.argv.slice(1), '--disable-extensions']);
        assert(
          !relaunched.args.includes(service.profile),
          'IDE profile must never replace the Electron App entry',
        );
        assert(
          fs.existsSync(relaunched.args[0]),
          'Development restart must launch a real App entry',
        );
      } finally {
        lifecycle.quit = originalQuit;
        app.relaunch = originalRelaunch;
        app.once = originalOnce;
      }
      console.log('[codeoss-desktop] Outer bounds and actual upstream restart arguments passed.');
      console.log(
        '[codeoss-desktop] Complete workbench, extensions, terminal, independent CIBYP AI and menus passed.',
      );
      console.log('[codeoss-desktop] profile', profile);
      console.log('[codeoss-desktop] errors', errors);
      assert.equal(errors.length, 0);
      finish();
    } catch (error) {
      finish(error);
    }
  }, 500);
});

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function finish(error) {
  clearTimeout(timeout);
  if (error) console.error('[codeoss-desktop]', error);
  console.log('[codeoss-desktop] exit', error ? 1 : 0);
  if (error) app.exit(1);
  else app.quit();
}
app.on('quit', (_event, code) => console.log('[codeoss-desktop] Electron quit', code));
require('../../src/main/main.js');
