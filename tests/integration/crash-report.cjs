/* Real crash window, preload, diagnostics export and live appearance; isolated profile. */
const { app, BrowserWindow, dialog, shell, clipboard, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-crash-ui-'));
app.getVersion = () => require('../../package.json').version;
app.setPath('userData', profile);
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('documents', path.join(profile, 'documents'));
fs.mkdirSync(path.join(profile, 'data/crash'), { recursive: true });
const crashFile = path.join(profile, 'data/crash/crashes.json');
fs.writeFileSync(
  crashFile,
  JSON.stringify([
    {
      ts: Date.now(),
      source: 'uncaughtException',
      message: "Cannot read properties of null (reading 'preload') <img src=x onerror=alert(1)>",
      stack:
        'TypeError: Cannot read properties of null\n    at protectWebContents (window-security.js:38:53)\n'.repeat(
          14,
        ),
    },
  ]),
);
fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    notifications: { enabled: false },
    runtime: { location: 'host' },
    trayEnabled: false,
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    theme: { mode: 'light', accentColor: '#7377dc', backgroundColor: '#f5f7fc' },
  }),
);
global.fetch = async () => {
  throw Error('Network disabled in crash check');
};
const opened = [];
shell.openPath = async (directory) => {
  opened.push(directory);
  return '';
};
let save = 'cancel';
const output = path.join(profile, 'report.zip');
dialog.showSaveDialog = async () => {
  if (save === 'error') throw Error('Fixture export error');
  return save === 'cancel' ? { canceled: true } : { canceled: false, filePath: output };
};
app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
});
const timer = setTimeout(() => finish(Error('Crash UI timeout')), 30000);
async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('Crash UI condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
ipcMain.once('app:renderer-ready', async () => {
  try {
    let win;
    await waitFor(() => {
      win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/crash-report.html'),
      );
      return win;
    });
    const evaluate = (script) => win.webContents.executeJavaScript(script);
    await waitFor(() =>
      evaluate(
        `document.querySelector('main')?.getAttribute('aria-busy') === 'false' && document.documentElement.dataset.theme === 'light'`,
      ),
    );
    assert.equal(await evaluate(`document.querySelectorAll('details[open]').length`), 0);
    assert.equal(
      await evaluate(`document.querySelectorAll('main img').length`),
      0,
      'Exception text cannot inject markup',
    );
    assert.match(await evaluate(`document.getElementById('cr-cause').textContent`), /<img/);
    const previews = path.resolve(__dirname, '../../.cibyp-test-fixtures-crash-preview');
    fs.mkdirSync(previews, { recursive: true });
    fs.writeFileSync(
      path.join(previews, 'light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await evaluate(`document.getElementById('cr-copy').click()`);
    await waitFor(() => clipboard.readText().includes('protectWebContents'));
    assert.equal(JSON.parse(clipboard.readText()).records.length, 1);
    await evaluate(`document.getElementById('cr-export').click()`);
    await waitFor(() =>
      evaluate(`document.getElementById('cr-status').textContent.includes('取消')`),
    );
    save = 'error';
    await evaluate(`document.getElementById('cr-export').click()`);
    await waitFor(() =>
      evaluate(
        `document.getElementById('cr-status').dataset.error === 'true' && !document.getElementById('cr-export').disabled`,
      ),
    );
    save = 'save';
    await evaluate(`document.getElementById('cr-export').click()`);
    await waitFor(() => fs.existsSync(output));
    const zip = new (require('adm-zip'))(output);
    assert.equal(JSON.parse(zip.readAsText('report.json')).records.length, 1);
    assert(zip.getEntry('logs/main-tail.log'));
    await evaluate(
      `document.getElementById('cr-log-details').open = true; document.getElementById('cr-open-logs').click(); document.getElementById('cr-system-details').open = true; document.getElementById('cr-open-dir').click()`,
    );
    await waitFor(() => opened.length === 2);
    win.webContents.send('settings:changed', {
      theme: { mode: 'dark', accentColor: '#bf83ed', backgroundColor: '#202536' },
    });
    await waitFor(() =>
      evaluate(
        `document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#bf83ed'`,
      ),
    );
    await evaluate(
      `document.querySelectorAll('details').forEach(d => d.open = false); document.querySelector('main').scrollTop = 0`,
    );
    fs.writeFileSync(
      path.join(previews, 'dark.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    win.setSize(660, 540);
    await evaluate(`document.querySelectorAll('details').forEach(d => d.open = true)`);
    const overflow = await evaluate(
      `({body:document.body.scrollWidth > innerWidth, main:document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth + 2})`,
    );
    assert.deepEqual(overflow, { body: false, main: false });
    await evaluate(`document.getElementById('cr-continue').click()`);
    await waitFor(() => win.isDestroyed());
    assert.equal(
      JSON.parse(fs.readFileSync(crashFile)).length,
      1,
      'Continue preserves diagnostic records',
    );
    console.log(
      '[crash-report] PASS: collapsed details, safe text, copy/export/retry, live theme, narrow layout and preserved records. Previews:',
      previews,
    );
    finish();
  } catch (error) {
    finish(error);
  }
});
function finish(error) {
  clearTimeout(timer);
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
require('../../src/main/main');
