/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { NativeEngine } = require('../../src/main/services/quant/native-engine');
function fixture(t, respond, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-native-controller-')),
    binary = path.join(directory, 'fixture-binary');
  fs.writeFileSync(binary, 'fixture');
  let child,
    spawns = 0;
  const engine = new NativeEngine({
    directory,
    binaryPath: binary,
    ...options,
    spawnImpl: (_binary, _args, spawnOptions) => {
      spawns++;
      assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.cwd, directory);
      assert.deepEqual(
        Object.keys(spawnOptions.env).filter(
          (k) => !['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'CIBYP_ENGINE_TOKEN'].includes(k),
        ),
        [],
      );
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      const alive = setInterval(() => {}, 1000);
      child.kill = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 1;
        clearInterval(alive);
        child.emit('exit', 1);
        child.emit('close', 1);
      };
      child.stdin = new Writable({
        write(bytes, _encoding, done) {
          const request = JSON.parse(bytes);
          let result;
          if (request.method === 'hello') {
            assert.match(request.params.token, /^[a-f\d]{64}$/);
            result = {
              ok: true,
              result: {
                protocol: 1,
                version: 'fixture',
                mode: 'paper',
                liveExecution: false,
                pid: 1,
              },
            };
          } else if (request.method === 'shutdown')
            result = { ok: true, result: { stopped: true } };
          else result = respond(request);
          queueMicrotask(() => {
            if (result) child.stdout.write(JSON.stringify({ id: request.id, ...result }) + '\n');
            if (request.method === 'shutdown') child.kill();
          });
          done();
        },
      });
      return child;
    },
  });
  t.after(async () => {
    await engine.stop();
    engine.dispose();
    child?.kill();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { engine, child: () => child, spawns: () => spawns };
}
test('a storage commit failure is an unknown mutation outcome and remains observable without retrying', async (t) => {
  let attempts = 0;
  const { engine } = fixture(t, () => {
    attempts++;
    return { ok: false, error: { code: 'DURABLE_COMMIT_FAILED' } };
  });
  await engine.start();
  await assert.rejects(engine.call('order.submit', { id: 'one' }), /NATIVE_OUTCOME_UNKNOWN/);
  assert.equal(attempts, 1);
  assert.equal(engine.inspect().lastError, 'NATIVE_STORAGE_FAULT');
});
test('concurrent native starts own one process even when an observer throws', async (t) => {
  const { engine, spawns } = fixture(t, () => ({ ok: true, result: {} }), {
    publish: () => {
      throw Error('Disconnected view');
    },
  });
  const [first, second] = await Promise.all([engine.start(), engine.start()]);
  assert.equal(spawns(), 1);
  assert.equal(first.pid, second.pid);
  assert.equal(engine.state, 'connected');
});
test('native request timeout kills only its owned process and never resends the financial command', async (t) => {
  let attempts = 0;
  const { engine, child } = fixture(
    t,
    () => {
      attempts++;
    },
    { timeout: 30 },
  );
  await engine.start();
  await assert.rejects(engine.call('order.submit', { id: 'one' }), /NATIVE_OUTCOME_UNKNOWN/);
  assert.equal(attempts, 1);
  assert.equal(engine.state, 'failed');
  assert.notEqual(child().exitCode, null);
});
