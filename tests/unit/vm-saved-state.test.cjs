/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { QmpClient } = require('../../src/main/vm/qmp-client');
const { VmSavedState, compatibility, TAG } = require('../../src/main/vm/vm-saved-state');
const { VmInstance } = require('../../src/main/vm/vm-instance');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-state-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const instance = new EventEmitter();
  instance.dir = dir;
  instance.overlayPath = path.join(dir, 'overlay.qcow2');
  fs.writeFileSync(instance.overlayPath, 'disk-data');
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(Buffer.from(value).toString('base64')),
    decryptString: (value) => Buffer.from(value.toString(), 'base64').toString(),
  };
  const state = new VmSavedState(instance, storage);
  return { dir, instance, state, storage };
}

test('saved state is published after disk exit, keeps its key protected, and is consumed once', (t) => {
  const { state } = fixture(t);
  const key = 'PRIVATE KEY fixture-not-a-real-key';
  state.publish('signature', state.sealKey(key), 1234);
  assert.ok(!fs.readFileSync(state.file, 'utf8').includes(key));
  assert.equal(state.consume('signature').privateKey, key);
  assert.equal(state.consume('signature'), null);
  assert.ok(!fs.existsSync(state.file));
});

test('configuration changes, modified disks, corrupt keys and unavailable vaults invalidate RAM state', (t) => {
  const { state, storage, instance } = fixture(t);
  const save = () => state.publish('a', state.sealKey('PRIVATE KEY test'), 1234);
  save();
  assert.equal(state.consume('different configuration'), null);
  save();
  fs.appendFileSync(instance.overlayPath, 'new disk data');
  assert.equal(state.consume('a'), null);
  save();
  storage.decryptString = () => {
    throw new Error('Account vault unavailable');
  };
  assert.equal(state.consume('a'), null);
  save();
  storage.getSelectedStorageBackend = () => 'basic_text';
  assert.equal(state.available, false);
  assert.equal(state.consume('a'), null);
  assert.throws(() => state.sealKey('PRIVATE KEY'), /unavailable/);
  assert.ok(!fs.existsSync(state.file));
});

test('compatibility binds VM hardware, image/kernel/runtime versions without binding ephemeral ports', (t) => {
  const { instance } = fixture(t);
  instance.config = { smp: 2, memMB: 2048, netMode: 'nat' };
  instance.opts = {
    imagePath: instance.overlayPath,
    kernelPath: instance.overlayPath,
    initrdPath: instance.overlayPath,
  };
  instance.accel = { backend: 'tcg' };
  const qemu = { exe: instance.overlayPath };
  const signature = compatibility(instance, qemu, 'QEMU 11');
  instance.ports = { ssh: 123, serial: 456 };
  assert.equal(compatibility(instance, qemu, 'QEMU 11'), signature);
  assert.notEqual(compatibility(instance, qemu, 'QEMU 12'), signature);
  instance.config.memMB = 4096;
  assert.notEqual(compatibility(instance, qemu, 'QEMU 11'), signature);
});

function qmp(t, respond) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.on('data', (data) => {
    const request = JSON.parse(data);
    const result = request.execute === 'qmp_capabilities' ? { return: {} } : respond(request);
    if (result !== undefined) input.write(JSON.stringify({ id: request.id, ...result }) + '\r\n');
  });
  const client = new QmpClient(input, output);
  input.write('{"Q');
  input.write('MP":{"version":{}}}\r\n');
  t.after(() => {
    client.close();
    input.destroy();
    output.destroy();
  });
  return { client, input };
}

test('QMP handles fragmented greetings, interleaved events and explicit command failures', async (t) => {
  const { client, input } = qmp(t, (request) =>
    request.execute === 'fail'
      ? { error: { class: 'GenericError', desc: 'Migration blocked by device' } }
      : { return: { status: 'paused' } },
  );
  input.write('{"event":"STOP"}\r\n');
  assert.deepEqual(await client.command('query-status'), { status: 'paused' });
  await assert.rejects(client.command('fail'), /Migration blocked/);
});

test('QMP snapshot waits for job completion and propagates concluded errors', async (t) => {
  let polls = 0;
  let jobId;
  let fail = false;
  const { client } = qmp(t, (request) => {
    if (request.execute === 'query-block')
      return {
        return: [{ inserted: { 'node-name': 'disk', ro: false, image: { format: 'qcow2' } } }],
      };
    if (request.execute === 'snapshot-save') {
      jobId = request.arguments['job-id'];
      return { return: {} };
    }
    if (request.execute === 'query-jobs')
      return {
        return: [
          {
            id: jobId,
            status: ++polls > 1 ? 'concluded' : 'running',
            ...(fail ? { error: 'Disk full' } : {}),
          },
        ],
      };
    return { return: {} };
  });
  await client.snapshot('save', TAG);
  assert.ok(polls >= 2, 'Initial command reply cannot be mistaken for a completed snapshot');
  fail = true;
  await assert.rejects(client.snapshot('save', TAG), /Disk full/);
});

test('QMP timeouts and channel closure settle pending requests', async (t) => {
  const { client, input } = qmp(t, () => undefined);
  await assert.rejects(client.command('never-reply', {}, 10), /timed out/);
  const pending = client.command('interrupted');
  input.end();
  await assert.rejects(pending, /closed/);
});

test('force stop discards saved-state metadata and never publishes a RAM snapshot', async (t) => {
  const { dir, state } = fixture(t);
  state.publish('signature', state.sealKey('PRIVATE KEY test'), 1234);
  const instance = new VmInstance({ assetsDir: dir });
  instance.dir = dir;
  instance._savedState = state;
  instance.child = { pid: 1 };
  instance.exit = { code: 0 };
  instance.state = 'ready';
  await instance.stop({ force: true });
  assert.equal(fs.existsSync(state.file), false);
  assert.equal(instance.child, null);
  assert.equal(instance.state, 'idle');
});
