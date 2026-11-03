/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readDeviceCommand, isDraw } = require('../../src/main/services/firmware/device-protocol');
function fake(reply, { writeError, disconnect } = {}) {
  const instances = [];
  class Port extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.isOpen = false;
      instances.push(this);
    }
    open(callback) {
      this.isOpen = true;
      queueMicrotask(() => callback());
    }
    write(command, callback) {
      this.command = command;
      callback(writeError);
      if (writeError) return;
      queueMicrotask(() => {
        if (disconnect) this.emit('close');
        else for (const chunk of reply) this.emit('data', Buffer.from(chunk));
      });
    }
    close(callback) {
      this.isOpen = false;
      this.closed = true;
      callback();
    }
  }
  return { Port, instances };
}
test('TRNG serial parser skips boot/ready/INFO frames and accepts only a complete validated card', async () => {
  const f = fake([
    'boot log\n{"ready":true}\n{"protocol":2,"deviceId":"abc"}\n',
    '{"cardIndex":7,',
    '"isReversed":false,"name":"战车"}\n',
  ]);
  const result = await readDeviceCommand({
    path: 'fixture',
    command: 'DRAW',
    accept: isDraw,
    SerialPort: f.Port,
    settleMs: 0,
  });
  assert.equal(result.cardIndex, 7);
  assert.equal(result.isReversed, false);
  assert.equal(f.instances[0].command, 'DRAW\n');
  assert.equal(f.instances[0].closed, true);
  for (const bad of [
    null,
    {},
    { cardIndex: -1, isReversed: false },
    { cardIndex: 78, isReversed: false },
    { cardIndex: 1.5, isReversed: true },
    { cardIndex: 1, isReversed: 'false' },
  ])
    assert.equal(isDraw(bad), false);
});
test('TRNG serial operations reject oversized, disconnected, timed-out and device-error replies and close the port', async () => {
  for (const [reply, options, error] of [
    [['x'.repeat(17000)], {}, /FRAME_LIMIT/],
    [['{"error":"ENTROPY_UNAVAILABLE"}\n'], {}, /REJECTED/],
    [[], { disconnect: true }, /DISCONNECTED/],
    [[], { writeError: Error('write failed') }, /IO/],
    [['{"cardIndex":99,"isReversed":false}\n'], {}, /TIMEOUT/],
  ]) {
    const f = fake(reply, options);
    await assert.rejects(
      readDeviceCommand({
        path: 'fixture',
        command: 'DRAW',
        accept: isDraw,
        SerialPort: f.Port,
        settleMs: 0,
        timeoutMs: 30,
      }),
      error,
    );
    assert.equal(f.instances[0].closed, true);
  }
});
test('network TRNG validates HTTP status, bounds responses and never folds invalid card indices into the deck', async (t) => {
  const http = require('node:http'),
    { getTRNGFromNetwork } = require('../../src/main/tarot-tools');
  let status = 200,
    body = '{"cardIndex":7,"isReversed":false}';
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const read = () => getTRNGFromNetwork('127.0.0.1', server.address().port);
  assert.deepEqual(await read(), { cardIndex: 7, isReversed: false });
  status = 503;
  await assert.rejects(read());
  status = 200;
  for (const invalid of [
    '{"ready":true}',
    '{"cardIndex":78,"isReversed":false}',
    '{"cardIndex":0,"isReversed":"false"}',
    'x'.repeat(8193),
  ]) {
    body = invalid;
    await assert.rejects(read());
  }
});
