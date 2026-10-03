const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { registerVmFileManager } = require('../../src/main/services/vm-file-manager');
app.disableHardwareAcceleration();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-files-window-'));
app.setPath('userData', profile);
const host = path.join(profile, 'host');
fs.mkdirSync(host);
fs.mkdirSync(path.join(host, 'folder'));
fs.writeFileSync(path.join(host, 'hello.txt'), 'test');
const stat = (directory) => ({
  isDirectory: () => directory,
  isFile: () => !directory,
  isSymbolicLink: () => false,
  size: directory ? 0 : 4,
  mtime: 1,
});
const service = {
  workspaceRoot: host,
  runtime: { vm: { workspaceMount: '/vm' } },
  instance: {
    state: 'ready',
    sftp: async () => ({
      readdir: async (dir) =>
        dir === '/vm'
          ? [{ filename: 'project', attrs: stat(true) }]
          : [{ filename: 'readme.txt', attrs: stat(false) }],
    }),
  },
};
const handlers = new Map();
const facade = {
  handle(channel, handler) {
    handlers.set(channel, handler);
    ipcMain.handle(channel, handler);
  },
};
const settings = {
  language: 'en',
  theme: { mode: 'light', accentColor: '#568bff', backgroundColor: '#f3f6fb' },
};
const errors = [];
const timeout = setTimeout(() => {
  console.error('VM file manager test timed out');
  app.exit(1);
}, 15000);
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('Window condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
app
  .whenReady()
  .then(async () => {
    registerVmFileManager({
      ipcMain: facade,
      BrowserWindow: class {
        constructor(options) {
          assert.equal(options.frame, false);
          assert.equal(options.webPreferences.sandbox, true);
          const win = new BrowserWindow({
            ...options,
            webPreferences: { ...options.webPreferences, offscreen: true },
          });
          win.show = () => {};
          win.webContents.on('console-message', (_event, details) => {
            if (details.level === 'error') errors.push(details.message);
          });
          return win;
        }
      },
      vmService: service,
      getSettings: () => settings,
      systemDark: () => false,
    });
    handlers.get('vm-files:open')();
    const win = BrowserWindow.getAllWindows()[0],
      evaluate = (script) => win.webContents.executeJavaScript(script);
    await until(() =>
      evaluate(
        'document.querySelectorAll("[data-side=host] .file").length === 2 && document.querySelectorAll("[data-side=vm] .file").length === 1',
      ),
    );
    assert.equal(
      await evaluate('document.querySelector(".titlebar strong").textContent'),
      'VM File Manager',
    );
    assert.equal(
      (
        await handlers.get('vm-files:list')(
          { sender: {}, senderFrame: null },
          { side: 'host', path: host },
        )
      ).ok,
      false,
    );
    await evaluate(
      `(() => { const row = document.querySelector('[data-side=vm] .file'); row.click(); if (!row.isConnected) throw Error('Click replaced the double-click target'); row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); })()`,
    );
    await until(() =>
      evaluate('document.querySelector("[data-side=vm] .path").value === "/vm/project"'),
    );
    await evaluate('document.querySelector("[data-side=vm] [data-action=parent]").click()');
    await until(() => evaluate('document.querySelector("[data-side=vm] .path").value === "/vm"'));
    const output = path.resolve('.cache/ci-fix/alpha19-preview');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, 'vm-files-light.png'),
      (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
    );
    win.webContents.send('theme:apply', {
      theme: { mode: 'dark', accentColor: '#bc83ef', backgroundColor: '#191b24' },
    });
    await until(() =>
      evaluate('document.documentElement.style.getPropertyValue("--accent") === "#bc83ef"'),
    );
    await evaluate('document.querySelector("#upload").focus()');
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector("#upload")).outlineColor'),
      'rgb(188, 131, 239)',
    );
    fs.writeFileSync(
      path.join(output, 'vm-files-dark.png'),
      (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
    );
    for (const [language, title] of [
      ['de', 'VM-Dateimanager'],
      ['zh-CN', '虚拟机文件管理器'],
      ['en', 'VM File Manager'],
    ]) {
      win.webContents.send('settings:changed', { language });
      await until(() =>
        evaluate('document.querySelector(".titlebar strong").textContent').then(
          (value) => value === title,
        ),
      );
    }
    await evaluate('document.querySelector("[data-side=host] [data-action=mkdir]").click()');
    const center = await evaluate(
      `(() => { const r=document.querySelector('dialog').getBoundingClientRect(); return { x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight }; })()`,
    );
    assert.ok(Math.abs(center.x - center.w / 2) < 2 && Math.abs(center.y - center.h / 2) < 2);
    assert.deepEqual(errors, []);
    win.destroy();
    clearTimeout(timeout);
    console.log(
      JSON.stringify({
        ok: true,
        checks: [
          'sandboxed frameless window',
          'directory navigation',
          'live theme and accent',
          'language switching',
          'centered dialog',
          'scoped IPC',
        ],
        screenshots: output,
      }),
    );
    app.exit(0);
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  });
