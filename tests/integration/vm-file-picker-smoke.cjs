const { app, ipcMain, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { createVmFileDialog } = require('../../src/main/vm/vm-file-dialog');
const entries = new Map([
  ['/workspace', true],
  ['/workspace/guest.txt', false],
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
app.on('browser-window-created', (_event, window) => window.on('show', () => window.hide()));
let timeout = setTimeout(() => {
  console.error('Picker test timed out');
  app.exit(1);
}, 15000);
app
  .whenReady()
  .then(async () => {
    const picker = createVmFileDialog({
      ipcMain,
      BrowserWindow,
      dialog: {
        showOpenDialog: () => {
          throw new Error('Host picker must not open');
        },
      },
      getVmService: () => service,
      getTheme: () => ({ mode: 'dark', accentColor: '#bf83ed', backgroundColor: '#202536' }),
    });
    const chosen = picker.showSaveDialog(undefined, { defaultPath: '/workspace/result.txt' });
    const window = BrowserWindow.getAllWindows()[0];
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    for (let attempt = 0; attempt < 30; attempt++) {
      if (
        await window.webContents.executeJavaScript(
          "document.querySelector('#entries').textContent.includes('guest.txt')",
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.querySelector('#entries').textContent.includes('guest.txt')",
      ),
      true,
    );
    assert.equal(await window.webContents.executeJavaScript('typeof window.process'), 'undefined');
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
    await window.webContents.executeJavaScript(
      "document.getElementById('newFolder').click();document.getElementById('folderName').value='新文件夹';document.getElementById('createFolder').click();",
    );
    for (let attempt = 0; attempt < 30 && !entries.has('/workspace/新文件夹'); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(entries.has('/workspace/新文件夹'), true);
    await window.webContents
      .executeJavaScript(
        "document.getElementById('filename').value='result.txt';document.getElementById('choose').click();",
      )
      .catch(() => {});
    assert.deepEqual(await chosen, { canceled: false, filePath: '/workspace/result.txt' });
    clearTimeout(timeout);
    console.log(
      'PASS sandboxed VM file picker, guest directory listing, inline folder creation and save selection',
    );
    app.exit(0);
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error(error.stack);
    app.exit(1);
  });
