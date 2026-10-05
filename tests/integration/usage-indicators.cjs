/* Real WebUI browser + authenticated WebSocket; no provider requests or user profile. */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebControlService } = require('../../src/main/web-control-service');
const { formatUsage } = require('../../src/shared/usage-indicator');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-usage-browser-')));
const service = new WebControlService();
let window;
const errors = [];

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function pushUsage(mode, usedPercent) {
  const data = {
    mode,
    subscription: true,
    selected: { period: 'weekly', label: 'Codex', usedPercent, resetsAt: Date.now() + 60000 },
  };
  service.pushSubscriptionUsage({ ...data, indicator: formatUsage(data, 'de') });
}

function mirrorBody() {
  service.pushMirrorUpdate({
    type: 'mirror_body',
    html: ['chat', 'code', 'babe']
      .map(
        (mode) =>
          `<div id="${mode}-budget-mini-bar" style="display:none"><span class="bmb-fill"></span><span class="bmb-cost">stale</span></div>`,
      )
      .join(''),
  });
}

async function run() {
  service.configure({ password: 'test-only-password' });
  service.config.port = 0;
  await service.start();
  for (const mode of ['chat', 'code', 'babe']) pushUsage(mode, 80);
  window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' && /Uncaught/.test(event.message)) errors.push(event.message);
  });
  await window.loadURL(`http://127.0.0.1:${service.server.address().port}/`);
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "document.getElementById('login-overlay').classList.contains('show')",
      ),
    'login',
  );
  await window.webContents.executeJavaScript(`
    document.getElementById('login-pw').value='test-only-password';
    document.getElementById('login-btn').click();
  `);
  await waitFor(() => service.wsClients.size === 1, 'authenticated client');
  // Quota arrives in init before the mirrored DOM exists. It must be replayed.
  mirrorBody();
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "document.getElementById('babe-budget-mini-bar')?.textContent.includes('20%')",
      ),
    'cached quota replay',
  );
  const first = await window.webContents.executeJavaScript(`
    ['chat','code','babe'].map(mode=>{
      const el=document.getElementById(mode+'-budget-mini-bar');
      return {text:el.textContent,fill:el.querySelector('.bmb-fill').style.width,level:el.dataset.level,title:el.title,display:el.style.display};
    })
  `);
  for (const bar of first) {
    assert.match(bar.text, /20% verbleibend/);
    assert.match(bar.title, /Zurücksetzung/);
    assert.equal(bar.fill, '80%');
    assert.equal(bar.level, 'warn');
    assert.equal(bar.display, '');
  }
  pushUsage('chat', 45);
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "document.getElementById('chat-budget-mini-bar').textContent.includes('55%')",
      ),
    'live refresh',
  );
  mirrorBody();
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "document.getElementById('chat-budget-mini-bar').querySelector('.bmb-fill').style.width==='45%'",
      ),
    'quota retained through DOM replacement',
  );
  // Browser reconnects must retain quota updates and the shared voice connection.
  for (const client of service.wsClients) client.close();
  await waitFor(() => service.wsClients.size === 0, 'disconnect');
  await waitFor(() => service.wsClients.size === 1, 'reconnect');
  service.setVoiceCapabilities({ ready: false, workerRunning: false });
  await waitFor(
    () =>
      window.webContents.executeJavaScript("document.getElementById('btn-webui-mic')?.disabled"),
    'voice events after reconnect',
  );
  pushUsage('code', 25);
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "document.getElementById('code-budget-mini-bar').textContent.includes('75%')",
      ),
    'quota refresh after reconnect',
  );
  assert.deepEqual(errors, []);
  console.log(
    '[usage-indicators] Authenticated quota replay, live updates, all modes and DOM replacement passed.',
  );
}

const timeout = setTimeout(() => finish(new Error('Usage browser check timed out')), 25000);
let finished = false;
async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error('[usage-indicators] FAILED:', error);
  window?.destroy();
  await service.stop();
  app.exit(error ? 1 : 0);
}
app
  .whenReady()
  .then(run)
  .then(() => finish(), finish);
