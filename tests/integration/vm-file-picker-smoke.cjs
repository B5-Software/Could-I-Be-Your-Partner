const { app, ipcMain, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath(
  'userData',
  require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'cibyp-picker-'),
  ),
);
const { createVmFileDialog } = require('../../src/main/vm/vm-file-dialog');
const entries = new Map([
  ['/workspace', true],
  ['/workspace/guest.txt', false],
  ['/', true],
  ['/usr/bin', true],
  ['/usr/bin/bash', false],
]);
const service = {
  runtime: { location: 'vm', workspaceMode: 'isolated', vm: { workspaceMount: '/workspace' } },
  instance: {
    state: 'ready',
    exec: async (command) => {
      if (command.includes('mkdir')) entries.set('/workspace/新文件夹', true);
      return { ok: true, stdout: '', stderr: '' };
    },
    sftp: async () => ({
      stat: async (file) => {
        if (!entries.has(file)) throw new Error('ENOENT');
        return { isDirectory: () => entries.get(file), isFile: () => !entries.get(file) };
      },
      readdir: async (directory) =>
        [...entries]
          .filter(
            ([file]) =>
              file.startsWith(directory + '/') && !file.slice(directory.length + 1).includes('/'),
          )
          .map(([file, directory]) => ({
            filename: file.split('/').pop(),
            attrs: { isDirectory: () => directory, isFile: () => !directory },
          })),
    }),
  },
};

let timeout = setTimeout(() => {
  console.error('Picker test timed out');
  app.exit(1);
}, 20000);
async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > until) throw Error('Picker condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
app
  .whenReady()
  .then(async () => {
    const fixture = require('node:path').resolve('.cibyp-test-fixtures-vm-picker');
    require('node:fs').mkdirSync(fixture, { recursive: true });
    await require('esbuild').build({
      entryPoints: ['src/renderer/core/vm-file-dialog.ts'],
      outfile: fixture + '/picker.js',
      bundle: true,
      format: 'iife',
      globalName: 'Picker',
    });
    const cssLinks = ['theme', 'main', 'chat', 'settings', 'components', 'motion', 'focus']
      .map(
        (name) =>
          '<link rel="stylesheet" href="' +
          require('node:url').pathToFileURL(
            require('node:path').resolve('src/renderer/css/' + name + '.css'),
          ).href +
          '">',
      )
      .join('');
    require('node:fs').writeFileSync(
      fixture + '/host.html',
      '<!doctype html>' +
        cssLinks +
        '<button id="original">Original focus</button><script src="picker.js"></script><script>Picker.installVmFileDialog(window.api);</script>',
    );
    const template = require('node:fs')
      .readFileSync('src/renderer/pages/index.html', 'utf8')
      .match(/<template id="vm-file-dialog-template">([\s\S]*?)<\/template>/)[0];
    const pickerScript = require('node:url').pathToFileURL(
      require('node:path').resolve('src/renderer/js/vm-file-dialog.js'),
    ).href;
    require('node:fs').writeFileSync(
      fixture + '/host.html',
      '<!doctype html>' +
        cssLinks +
        '<button id="original">Original focus</button>' +
        template +
        '<script src="' +
        pickerScript +
        '"></script><script src="picker.js"></script><script>Picker.installVmFileDialog(window.api);document.getElementById("original").focus();</script>',
    );
    const host = new BrowserWindow({
      show: false,
      width: 1000,
      height: 740,
      webPreferences: {
        preload: require('node:path').resolve('src/preload/generated/preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const picker = createVmFileDialog({
      ipcMain,
      dialog: {
        showOpenDialog: () => {
          throw Error('Host picker must not open');
        },
      },
      getMainWindow: () => host,
      getVmService: () => service,
      getTheme: () => ({ mode: 'dark', accentColor: '#bf83ed', backgroundColor: '#202536' }),
    });
    await host.loadFile(fixture + '/host.html');
    const chosen = picker.showSaveDialog(host, { defaultPath: '/workspace/result.txt' });
    const evaluate = (script) =>
      host.webContents.executeJavaScript(
        '(()=>{const panel=document.querySelector("dialog");return (function(document){return ' +
          script +
          ';})({querySelector:selector=>panel.querySelector(selector),getElementById:id=>panel.querySelector("#"+id)});})()',
      );
    await waitFor(() =>
      evaluate(
        '!!document.querySelector("#entries")&&document.querySelector("#entries").textContent.includes("guest.txt")',
      ).catch(() => false),
    );
    assert.equal(
      BrowserWindow.getAllWindows().length,
      1,
      'Picker must remain inside the App, without creating any other native window',
    );
    assert(
      await host.webContents.executeJavaScript(
        'document.querySelector("dialog").matches(":modal")',
      ),
    );
    assert.equal(await evaluate('typeof window.process'), 'undefined');
    const bounds = await host.webContents.executeJavaScript(
      'document.querySelector("dialog").getBoundingClientRect().toJSON()',
    );
    assert(bounds.width > 600 && bounds.height > 400);
    for (const [width, height, immersive] of [
      [1500, 1000, false],
      [1500, 1000, true],
      [620, 480, true],
    ]) {
      host.setContentSize(width, height);
      await host.webContents.executeJavaScript(
        `document.body.classList.toggle('code-immersive', ${immersive})`,
      );
      await waitFor(async () => {
        const layout = await host.webContents.executeJavaScript(
          `({rect: document.querySelector('dialog').getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight})`,
        );
        return (
          Math.abs(layout.rect.x + layout.rect.width / 2 - layout.width / 2) < 1 &&
          Math.abs(layout.rect.y + layout.rect.height / 2 - layout.height / 2) < 1
        );
      });
    }
    host.setContentSize(1000, 740);
    const preview = require('node:path').resolve('.cibyp-test-fixtures-codeoss-preview');
    require('node:fs').mkdirSync(preview, { recursive: true });
    require('node:fs').writeFileSync(
      preview + '/file-picker.png',
      (
        await host.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG(),
    );
    await evaluate(
      '(document.getElementById("newFolder").click(),document.getElementById("folderName").value="新文件夹",document.getElementById("createFolder").click(),true)',
    );
    await waitFor(() => entries.has('/workspace/新文件夹'));
    await evaluate(
      '(document.getElementById("filename").value="result.txt",document.getElementById("choose").click(),true)',
    ).catch(() => {});
    assert.deepEqual(await chosen, { canceled: false, filePath: '/workspace/result.txt' });
    await waitFor(() => host.webContents.executeJavaScript('!document.querySelector("dialog")'));
    assert.equal(await host.webContents.executeJavaScript('document.activeElement.id'), 'original');
    const cancelled = picker.showOpenDialog(host, { properties: ['openFile'] });
    await waitFor(() => evaluate('!!document.getElementById("cancel")').catch(() => false));
    await evaluate('(document.getElementById("cancel").click(),true)').catch(() => {});
    assert.deepEqual(await cancelled, { canceled: true, filePaths: [] });
    await waitFor(() => host.webContents.executeJavaScript('!document.querySelector("dialog")'));
    service.runtime.location = 'host';
    const executable = picker.showOpenDialogInVM(host, {
      defaultPath: '/usr/bin',
      properties: ['openFile'],
    });
    await waitFor(() =>
      evaluate('document.getElementById("entries").textContent.includes("bash")').catch(
        () => false,
      ),
    );
    await evaluate(
      '(document.getElementById("filename").value="bash",document.getElementById("choose").click(),true)',
    ).catch(() => {});
    assert.deepEqual(await executable, { canceled: false, filePaths: ['/usr/bin/bash'] });
    clearTimeout(timeout);
    console.log(
      'PASS App modal VM picker: guest listing, folder creation, save, cancel and focus restoration',
    );
    app.exit(0);
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error(error.stack);
    app.exit(1);
  });
