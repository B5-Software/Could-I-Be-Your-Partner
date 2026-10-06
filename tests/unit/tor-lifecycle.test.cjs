/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

test('Tor retains its bootstrap failure after cleanup and clears it on stop', async () => {
  const filename = path.resolve(__dirname, '../../src/main/services/tor-remote.js');
  const nativeRequire = createRequire(filename);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => queueMicrotask(() => child.emit('exit', null));
  const module = { exports: {} };
  // Isolate the actual lifecycle module from native processes and network I/O.
  // Short clocks exercise its stalled-bootstrap cleanup, rather than sleeping.
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module,
    process,
    require(name) {
      if (name === 'node:fs/promises')
        return {
          stat: async () => null,
          mkdir: async () => {},
          writeFile: async () => {},
        };
      if (name === 'node:child_process')
        return {
          spawn: () => {
            queueMicrotask(() =>
              child.stdout.emit('data', 'Bootstrapped 50%: Loading relay descriptors\n'),
            );
            return child;
          },
        };
      return nativeRequire(name);
    },
    setTimeout: (callback, delay) => setTimeout(callback, delay === 180000 ? 30 : 200),
    clearTimeout,
  });
  const tor = new module.exports.TorRemote({
    app: { getPath: () => '/fixture' },
    web: { running: true, port: 1234, config: { passwordHash: 'fixture' } },
    settings: () => ({}),
    publish: () => {},
    prepare: async () => '/fixture/runtime',
  });
  await tor.start();
  await tor.operation;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tor.status().phase, 'error');
  assert.match(tor.status().error, /bootstrap timed out/);
  assert.equal(tor.status().progress, 50);
  tor.stop();
  assert.equal(tor.status().error, '');
  assert.equal(tor.status().detail, '');
  assert.equal(tor.status().phase, 'stopped');
});
