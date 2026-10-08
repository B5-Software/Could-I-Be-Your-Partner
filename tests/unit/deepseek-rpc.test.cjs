/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { PassThrough } = require('node:stream');
const { RpcPeer } = require('../../src/main/ds-compat/rpc-peer');
const { sdkFiles } = require('../../src/main/vm/plugin-sdk-files');

test('SDK ESM bridges support keyword exports and share the CommonJS identities', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-sdk-exports-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worker = path.join(directory, 'worker.cjs');
  const api = require('@deepseek-ai/schemastery');
  await fs.writeFile(
    worker,
    `module.exports.vmSdk={schemastery:require(${JSON.stringify(require.resolve('@deepseek-ai/schemastery'))})};`,
  );
  const files = sdkFiles(worker, 'schemastery', api);
  await fs.writeFile(path.join(directory, 'index.cjs'), files.commonjs);
  await fs.writeFile(path.join(directory, 'index.mjs'), files.esm);
  await fs.writeFile(
    path.join(directory, 'consumer.mjs'),
    "import schema,{const as constant} from './index.mjs';export {schema,constant};",
  );
  const consumer = await import(pathToFileURL(path.join(directory, 'consumer.mjs')).href);
  assert.equal(consumer.schema, api.default ?? api);
  assert.equal(consumer.constant, api.const);
  assert.equal(consumer.constant('fixture')('fixture'), 'fixture');
});

test(
  'resident RPC preserves event ordering and cancels calls waiting for synchronization',
  { timeout: 3000 },
  async (t) => {
    const toHost = new PassThrough(),
      toGuest = new PassThrough();
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    let synchronized = false;
    const guest = new RpcPeer(toGuest, toHost, {
      event: async (name) => {
        assert.equal(name, 'sync');
        await barrier;
        synchronized = true;
      },
      request: async (name) => {
        assert.equal(synchronized, true);
        calls.push(name);
        return name;
      },
    });
    const host = new RpcPeer(toHost, toGuest);
    t.after(() => {
      host.close();
      guest.close();
      toHost.destroy();
      toGuest.destroy();
    });
    host.emit('sync', {});
    const controller = new AbortController();
    const cancelled = host.ask('must-not-run', {}, { signal: controller.signal });
    controller.abort(new Error('Cancelled fixture'));
    await assert.rejects(cancelled, /Cancelled fixture/);
    release();
    assert.equal(await host.ask('after-sync', {}), 'after-sync');
    assert.deepEqual(calls, ['after-sync']);
  },
);
