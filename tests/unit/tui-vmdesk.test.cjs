/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VmDesktopCompanion } = require('../../src/tui/vm-desktop');
const { copyText } = require('../../src/tui/clipboard');

function setup() {
  const children = [],
    calls = [],
    events = new Map();
  const companion = new VmDesktopCompanion({
    executable: '/electron',
    timeoutMs: 1000,
    invoke: async (...args) => {
      calls.push(args);
      return { ok: true, running: true };
    },
    subscribe: (channel, callback) => {
      events.set(channel, callback);
      return () => events.delete(channel);
    },
    spawnProcess: (executable, args, options) => {
      const child = Object.assign(new EventEmitter(), {
        connected: true,
        messages: [],
        send(message, callback) {
          child.messages.push(message);
          callback?.();
        },
        kill() {
          child.connected = false;
          child.emit('exit', 0);
        },
      });
      calls.push(['spawn', executable, args, options]);
      children.push(child);
      return child;
    },
  });
  return { companion, children, calls, events };
}

test('VM desktop opens one GUI companion, forwards only graphics capabilities, and reuses/reopens the window', async () => {
  const { companion, children, calls, events } = setup();
  const opened = companion.open({ mode: 'light' }, false);
  assert.equal(companion.open({}), opened, 'Concurrent opens use a single window');
  const child = children[0];
  assert.equal(child.messages[0].type, 'init');
  assert.deepEqual(calls[0][3].stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(calls[0][3].windowsHide, true);
  child.emit('message', { type: 'ready' });
  await opened;
  await companion.open({});
  assert.equal(children.length, 1);
  assert.equal(child.messages.at(-1).type, 'focus');
  child.emit('message', { type: 'request', id: 1, channel: 'vm:graphicsStart', args: [{}] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call[0] === 'vm:graphicsStart'));
  assert.equal(child.messages.at(-1).result.running, true);
  child.emit('message', { type: 'request', id: 2, channel: 'fs:deleteFile', args: ['/important'] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(child.messages.at(-1).error.includes('Unsupported'));
  assert.ok(!calls.some((call) => call[0] === 'fs:deleteFile'));
  events.get('vm:graphics-log')('starting');
  assert.equal(child.messages.at(-1).payload, 'starting');
  child.kill();
  assert.equal(events.size, 0);
  assert.equal(companion.child, null);
  const reopened = companion.open({});
  children[1].emit('message', { type: 'ready' });
  await reopened;
  companion.dispose();
  assert.equal(children[1].messages.at(-1).type, 'shutdown');
  children[1].kill();
});

test('failed desktop startup rejects and can be retried without leaked subscriptions', async () => {
  const { companion, children, events } = setup();
  const opened = companion.open({});
  children[0].emit('message', { type: 'failed', error: 'renderer failed' });
  await assert.rejects(opened, /renderer failed/);
  assert.equal(companion.child, null);
  assert.equal(events.size, 0);
  const next = companion.open({});
  children[1].emit('message', { type: 'ready' });
  await next;
  children[1].kill();
});

test('frontend clipboard copies Unicode through stdin and never invokes a text-built shell command', async () => {
  const calls = [];
  for (const platform of ['win32', 'darwin', 'linux']) {
    await copyText('中文\n`$()" emoji🙂', {
      platform,
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      spawnProcess: (command, args, options) => {
        const child = new EventEmitter();
        child.stdin = Object.assign(new EventEmitter(), {
          end: (text) => {
            calls.push({ command, args, options, text });
            queueMicrotask(() => child.emit('exit', 0));
          },
        });
        return child;
      },
    });
  }
  assert.deepEqual(
    calls.map((call) => call.command),
    ['powershell.exe', 'pbcopy', 'wl-copy'],
  );
  assert.ok(
    calls.every(
      (call) =>
        call.text.includes('中文') &&
        !call.args.some((arg) => arg.includes('emoji')) &&
        call.options.windowsHide,
    ),
  );
});
