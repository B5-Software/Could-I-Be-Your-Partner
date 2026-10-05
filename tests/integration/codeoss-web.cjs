/* SPDX-License-Identifier: GPL-3.0-or-later */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { CodeOSSService } = require('../../src/main/services/codeoss-service');
const { CodeOSSWebService } = require('../../src/main/services/codeoss-web');
const errors = [];
const settings = {
  runtime: { location: 'host' },
  theme: { mode: 'light', backgroundColor: '#f6f6fc', accentColor: '#5965c8' },
};
let bridge, webService, server, window;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 600; i++) {
    if (await fn()) return;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
(async () => {
  try {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-codeoss-web-'));
    const workspace = path.join(directory, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(
      path.join(workspace, 'example.js'),
      'export function greet(name) { return "Hello " + name; }\ngreet("CIBYP");\n',
    );
    bridge = new CodeOSSService({
      getMainWindow: () => null,
      getSettings: () => settings,
      getVmService: () => ({ runtime: { location: 'host' } }),
      dataDirectory: directory,
      publishEvent: () => {},
    });
    webService = new CodeOSSWebService({
      bridge,
      dataDirectory: directory,
      getVmService: () => null,
    });
    // Optional preverified official archive keeps local regression runs offline.
    if (process.env.CIBYP_TEST_CODEOSS_ARCHIVE) {
      const key = process.platform + '-' + (process.platform === 'win32' ? 'x64' : process.arch);
      const archive = process.env.CIBYP_TEST_CODEOSS_ARCHIVE;
      assert.equal(
        await require('../../packages/npm/lib/runtime.cjs').checksum(archive),
        require('../../integrations/codeoss/runtime-lock.json').web[key].sha256,
      );
      webService.archive = async () => archive;
    }
    await app.whenReady();
    const opened = await webService.open(workspace);
    server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<html><body style="margin:0"><iframe style="width:100vw;height:100vh;border:0" src="' +
            opened.webUrl +
            '"></iframe></body></html>',
        );
      } else webService.proxy(req, res);
    });
    server.on('upgrade', (req, socket, head) => webService.upgrade(req, socket, head));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    window = new BrowserWindow({
      width: 1360,
      height: 900,
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) errors.push(message);
    });
    await window.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await until(
      () =>
        window.webContents.executeJavaScript(
          '!!document.querySelector("iframe").contentDocument?.querySelector(".monaco-workbench")',
        ),
      'embedded workbench',
    );
    console.log('[codeoss-web] Workbench loaded');
    await until(() => bridge.activePeer(), 'CIBYP extension host');
    const context = await bridge.request('ide.context', {});
    assert.ok(
      context.workspace?.some((folder) => folder.path.toLowerCase() === workspace.toLowerCase()),
    );
    const document = await bridge.request('ide.readDocument', {
      path: path.join(workspace, 'example.js'),
      location: 'host',
    });
    assert.ok(document.result.content.includes('function greet'));
    await bridge.request('ide.openFile', {
      path: path.join(workspace, 'example.js'),
      location: 'host',
    });
    await until(
      () =>
        window.webContents.executeJavaScript(
          '!!document.querySelector("iframe").contentDocument?.querySelector(".monaco-editor .view-lines")',
        ),
      'opened editor',
    );
    const symbols = await bridge.request('ide.language', { action: 'symbols', path: 'example.js' });
    assert.equal(symbols.ok, true);
    await bridge.request('ide.command', { command: 'workbench.action.terminal.toggleTerminal' });
    await until(
      () =>
        window.webContents.executeJavaScript(
          '!!document.querySelector("iframe").contentDocument?.querySelector(".terminal")',
        ),
      'terminal',
    );
    await pause(2000);
    await fs.mkdir(path.resolve('.cache/screenshots'), { recursive: true });
    await fs.writeFile(
      path.resolve('.cache/screenshots/codeoss-web.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert.equal(
      errors.filter((e) => /Cannot find|Uncaught|extension.*failed/i.test(e)).length,
      0,
      errors.join('\n'),
    );
    console.log(
      '[codeoss-web] Embedded workbench, extension bridge, editor and terminal passed.',
      errors,
    );
    window.destroy();
    await webService.stop();
    bridge.dispose();
    server.close();
    app.quit();
  } catch (error) {
    console.error('[codeoss-web] FAIL', error.stack, errors);
    if (window) {
      await fs.mkdir(path.resolve('.cache/screenshots'), { recursive: true });
      await fs.writeFile(
        path.resolve('.cache/screenshots/codeoss-web-failure.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.error(
        '[codeoss-web] BODY',
        await window.webContents.executeJavaScript(
          'document.querySelector("iframe").contentDocument?.body.innerText',
        ),
      );
      console.error(
        '[codeoss-web] PEERS',
        JSON.stringify({
          target: bridge.target,
          peers: [...bridge.peers].map((peer) => ({
            id: peer.windowId,
            workspace: peer.workspace,
          })),
        }),
      );
      for (const operation of webService.servers.values())
        console.error('[codeoss-web] SERVER', (await operation).output);
    }
    window?.destroy();
    await webService?.stop();
    bridge?.dispose();
    server?.close();
    app.exit(1);
  }
})();
