/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Launch the actual packaged executable with a private profile, never the user's
// running instance. CDP is temporary, loopback-only, and closed with this process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-packaged-gui-'));
const executable = path.resolve(
  process.argv[2] || '.cache/release-startup-smoke/win-unpacked/Could I Be Your Partner.exe',
);
let child,
  socket,
  logs = '',
  splashSeen = false;
async function main() {
  fs.mkdirSync(path.join(profile, 'data'));
  fs.mkdirSync(path.join(profile, 'documents'));
  fs.writeFileSync(
    path.join(profile, 'data/settings.json'),
    JSON.stringify({
      onboardingCompleted: true,
      runtime: { location: 'host' },
      notifications: { enabled: false },
      updates: { autoCheckEnabled: false },
      voice: { wakeEnabled: false },
      trayEnabled: false,
      closeToTray: 'never',
      automation: { http: { port: 0 } },
    }),
  );
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  child = spawn(
    executable,
    ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'],
    {
      windowsHide: true,
      env: {
        ...childEnvironment,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        CIBYP_USER_DATA: profile,
        CIBYP_DOCUMENTS: path.join(profile, 'documents'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.on('error', (error) => {
    logs += error.stack;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      logs = (logs + bytes).slice(-256000);
    });
  const deadline = Date.now() + 60000;
  let page;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'Packaged app exited during startup: ' + logs.slice(-6000));
    try {
      const targets = await fetch('http://127.0.0.1:' + port + '/json/list', {
        signal: AbortSignal.timeout(1000),
      }).then((r) => r.json());
      splashSeen ||= targets.some((t) => t.url.includes('/splash.html'));
      page = targets.find(
        (t) => t.type === 'page' && t.url.includes('/src/renderer/pages/index.html'),
      );
      if (page) break;
    } catch {
      /* The debugging endpoint is not ready yet. */
    }
    await pause(50);
  }
  assert.ok(page, 'No packaged main renderer: ' + logs.slice(-6000));
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const response = JSON.parse(event.data);
    if (response.id) {
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('CDP timeout: ' + method));
        }, 10000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        result.error ? reject(Error(result.error.message)) : resolve(result.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  let state;
  while (Date.now() < deadline) {
    state = await evaluate(`(async()=>{
      if(typeof window.api?.backendRequest!=='function'||!document.querySelector('#chat-messages'))return null;
      const boot=await window.api.backendRequest('boot:state');
      return {boot,sessions:await window.api.backendRequest('listSessions'),title:document.title};
    })()`);
    const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json());
    if (
      state?.boot?.ready &&
      state.sessions?.length &&
      !targets.some((t) => t.url.includes('/splash.html'))
    )
      break;
    await pause(100);
  }
  assert.ok(state?.boot?.ready, 'Packaged runtime never became ready');
  assert.ok(state.sessions.length, 'Packaged Agent was not initialized');
  assert.ok(splashSeen, 'Splash must remain part of packaged GUI startup');
  const features = await evaluate("window.api.backendRequest('snapshot').then(s => s.features)");
  assert.equal(features.quant, false, 'Packaged GUI starts with quant disabled');
  const quantError = await evaluate(
    "window.api.backendRequest('quant:request','native.start').then(() => null, error => error.message)",
  );
  assert.match(quantError, /QUANT_DISABLED/);
  const superAgent = await evaluate("window.api.backendRequest('superagent:request','status')");
  assert.equal(superAgent.paused, false, 'Packaged backend can open a fresh SuperAgent store');
  const windows = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json());
  assert.ok(
    !windows.some((t) => t.url.includes('/splash.html')),
    'Splash must finish before main UI is ready',
  );
  assert.doesNotMatch(logs, /Cannot find module|ERR_MODULE_NOT_FOUND|PACKAGED_RUNTIME_ESCAPE/);
  console.log(
    '[packaged-startup] PASS: actual executable, Splash, main renderer, preload bridge, Agent session, SuperAgent and default quant gate',
  );
  try {
    await evaluate("window.api.backendRequest('backend:shutdown')");
  } catch {
    /* Shutdown closes CDP. */
  }
}
main()
  .catch((error) => {
    console.error(error.stack, logs.slice(-5000));
    process.exitCode = 1;
  })
  .finally(async () => {
    socket?.close();
    if (child && child.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(4000)]);
      if (child.exitCode === null) child.kill();
    }
    // Never recursively remove anything other than this test's checked temp folder.
    if (
      path.dirname(profile) !== path.resolve(os.tmpdir()) ||
      !path.basename(profile).startsWith('cibyp-packaged-gui-')
    )
      throw Error('Unsafe profile path');
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* Keep a locked fixture for diagnosis. */
    }
  });
