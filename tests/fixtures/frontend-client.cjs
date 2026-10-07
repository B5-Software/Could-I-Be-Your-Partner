/* SPDX-License-Identifier: GPL-3.0-or-later */
// Started only by the desktop activation fixture, never against the user profile.
const { app } = require('electron');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const windows = [];
let splashSeen = false;
app.on('browser-window-created', (_event, window) => {
  window.setOpacity(0);
  window.setSkipTaskbar(true);
  windows.push(window);
  window.webContents.on('did-finish-load', () => {
    if (window.webContents.getURL().includes('/splash.html')) splashSeen = true;
  });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('[frontend-renderer]', event.message);
  });
});
const fetch = global.fetch;
global.fetch = async (url, options) => {
  if (/^http:\/\/127\.0\.0\.1:/.test(String(url))) return fetch(url, options);
  throw Error('No external network in client fixture');
};
require('../../src/main/main');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const deadline = Date.now() + 18000;
  let main;
  while (Date.now() < deadline) {
    main = windows.find(
      (window) => !window.isDestroyed() && window.webContents.getURL().includes('/index.html'),
    );
    if (main?.isVisible()) break;
    await pause(100);
  }
  const splash = windows.find(
    (window) => !window.isDestroyed() && window.webContents.getURL().includes('/splash.html'),
  );
  const detail = splash
    ? await splash.webContents.executeJavaScript('document.getElementById("vmError").textContent')
    : '';
  if (main && !main.isVisible())
    console.error(
      'CLIENT_STATE',
      await main.webContents.executeJavaScript(
        'JSON.stringify({ ready: document.readyState, fonts: document.fonts.status, session: !!window.__sessionManager, persona: document.getElementById("agent-name-display")?.textContent })',
      ),
    );
  assert(main?.isVisible(), 'Legacy backend client must create a visible GUI: ' + detail);
  assert(splashSeen, 'Legacy attachment must preload behind Splash');
  assert(
    app.getPath('userData').endsWith('desktop-client'),
    'Client must not collide with the legacy owner lock',
  );
  const snapshot = await main.webContents.executeJavaScript(
    "window.api.backendRequest('snapshot')",
  );
  assert.equal(snapshot.pid, Number(process.env.CIBYP_EXPECTED_BACKEND_PID));
  assert.equal(
    await main.webContents.executeJavaScript(
      "document.getElementById('agent-name-display').textContent",
    ),
    'Activation fixture',
  );
  assert.ok(
    await main.webContents.executeJavaScript(
      "!!window.__sessionManager.getActive('chat')?.agent?.backendKey",
    ),
  );
  assert.equal(await main.webContents.executeJavaScript('document.fonts.status'), 'loaded');
  process.send({ ok: true });
})().catch((error) => process.send({ ok: false, error: error.message }));
process.on('message', (message) => {
  if (message === 'done') app.exit(0);
});
setTimeout(() => app.exit(1), 45000).unref();
