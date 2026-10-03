/* SPDX-License-Identifier: GPL-3.0-or-later */
// A real Electron companion, connected over the private parent IPC pipe to a
// disposable RFB server. No installed App profile, QEMU image or user VM touched.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { WebSocketServer } = require('ws');
const { spawn } = require('node:child_process');
const { installElectronShim } = require('../../src/tui/electron-shim');
const { VmDesktopCompanion } = require('../../src/tui/vm-desktop');
installElectronShim();

const subscribers = new Map(),
  requests = [],
  probes = new Map(),
  children = [];
let sequence = 0,
  running = false;
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
server.on('connection', (socket) => {
  let step = 0;
  socket.send(Buffer.from('RFB 003.008\n'));
  socket.on('message', (buffer) => {
    if (step === 0) {
      step++;
      socket.send(Buffer.from([1, 1]));
    } else if (step === 1) {
      step++;
      socket.send(Buffer.alloc(4));
    } else if (step === 2) {
      step++;
      const name = Buffer.from('CIBYP test VM'),
        init = Buffer.alloc(24);
      init.writeUInt16BE(320, 0);
      init.writeUInt16BE(200, 2);
      init[4] = 32;
      init[5] = 24;
      init[7] = 1;
      init.writeUInt16BE(255, 8);
      init.writeUInt16BE(255, 10);
      init.writeUInt16BE(255, 12);
      init[14] = 16;
      init[15] = 8;
      init.writeUInt32BE(name.length, 20);
      socket.send(Buffer.concat([init, name]));
    } else if (buffer[0] === 3) {
      const update = Buffer.alloc(16 + 320 * 200 * 4);
      update.writeUInt16BE(1, 2);
      update.writeUInt16BE(320, 8);
      update.writeUInt16BE(200, 10);
      update.fill(80, 16);
      socket.send(update);
    }
  });
});

const companion = new VmDesktopCompanion({
  entryPath: path.join(__dirname, '../fixtures/vm-desktop-host.cjs'),
  subscribe: (channel, callback) => {
    subscribers.set(channel, callback);
    return () => subscribers.delete(channel);
  },
  invoke: async (channel) => {
    requests.push(channel);
    if (channel === 'theme:get')
      return { theme: { mode: 'light', accentColor: '#5566cc' }, shouldUseDarkColors: false };
    if (channel === 'vm:graphicsStart') running = true;
    if (channel === 'vm:graphicsStop') {
      running = false;
      return { ok: true };
    }
    if (channel === 'vm:graphicsChromium') return { ok: true, cdpUrl: 'http://127.0.0.1:9222' };
    return {
      ok: true,
      running,
      vncHostPort: 5900,
      vncWsUrl: 'ws://127.0.0.1:' + server.address().port,
    };
  },
  spawnProcess: (...args) => {
    const child = spawn(...args);
    children.push(child);
    child.on('message', (message) => {
      if (message?.type !== 'fixture-result') return;
      const probe = probes.get(message.id);
      if (!probe) return;
      probes.delete(message.id);
      clearTimeout(probe.timer);
      message.error ? probe.reject(new Error(message.error)) : probe.resolve(message.result);
    });
    return child;
  },
});

function probe(command, extra) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      probes.delete(id);
      reject(new Error('Desktop probe timeout'));
    }, 10000);
    probes.set(id, { resolve, reject, timer });
    companion.child.send({ type: 'fixture', id, command, ...extra });
  });
}
async function waitFor(predicate) {
  const limit = Date.now() + 15000;
  while (Date.now() < limit) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Desktop condition timed out');
}
async function run() {
  await new Promise((resolve) => server.once('listening', resolve));
  // Exercise the production entry, not only the probe fixture. Electron does
  // not mark its entry as require.main, so a guarded entry can silently hang.
  const production = new VmDesktopCompanion({
    timeoutMs: 10000,
    subscribe: () => () => {},
    invoke: async () => ({ ok: false, error: 'Disposable test VM is not running' }),
    spawnProcess: (...args) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    },
  });
  assert.equal((await production.open({ mode: 'dark' }, true)).ok, true);
  production.dispose();
  await waitFor(() => !production.child);
  assert.equal((await companion.open({ mode: 'light', accentColor: '#5566cc' }, false)).ok, true);
  const connected = await waitFor(async () => {
    const result = await probe('snapshot');
    return result.page.connected && result;
  });
  assert.equal(connected.visible, true);
  assert.ok(connected.page.canvas, 'The actual noVNC canvas is rendered');
  assert.ok(
    requests.includes('vm:graphicsStart'),
    'Child starts the graphics of the parent-owned VM',
  );
  await companion.open({});
  assert.equal(children.length, 2, 'Repeated /vmdesk focuses the existing window');
  subscribers.get('theme:apply')({
    theme: { mode: 'dark', accentColor: '#22aabb' },
    shouldUseDarkColors: true,
  });
  await waitFor(async () => (await probe('snapshot')).page.accent.trim() === '#22aabb');
  const screenshot = path.join(os.tmpdir(), 'cibyp-tui-vmdesk-check.png');
  await probe('capture', { path: screenshot });
  assert.ok(fs.statSync(screenshot).size > 1000);
  await probe('chromium');
  await waitFor(() => requests.includes('vm:graphicsChromium'));
  await probe('stop');
  await waitFor(() => requests.includes('vm:graphicsStop'));
  await probe('close');
  await waitFor(() => !companion.child);
  assert.equal(subscribers.size, 0);
  await companion.open({ mode: 'light' }, false);
  assert.equal(children.length, 3, 'Closed desktop can be reopened');
  companion.dispose();
  await waitFor(() => !companion.child);
  console.log(
    '[tui-vmdesk] OK: window, noVNC, IPC controls, live theme, focus, reopen and shutdown',
  );
  console.log('[tui-vmdesk] Screenshot: ' + screenshot);
}
run()
  .then(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  })
  .catch((error) => {
    console.error(error);
    for (const child of children) child.kill();
    for (const socket of server.clients) socket.terminate();
    server.close();
    process.exitCode = 1;
  });
