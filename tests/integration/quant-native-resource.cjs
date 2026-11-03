/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Real target executable from the installable resource, never a developer path.
// Private profiles and virtual orders only; no external network, model or funds.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { NativeEngine } = require('../../src/main/services/quant/native-engine');
const binary = require('../../src/main/services/quant/native-binary');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-managed-native-'));
const resources = path.join(root, 'resources'),
  oldResources = process.resourcesPath,
  oldOverride = process.env.CIBYP_QUANT_ENGINE_BIN;
let live, replay;
async function stop(engine) {
  if (!engine?.child) return;
  const child = engine.child,
    exited = new Promise((resolve) => child.once('exit', resolve));
  await engine.stop();
  await exited;
}
(async () => {
  try {
    const spec = binary.target(),
      resourceFlag = process.argv.indexOf('--resources'),
      source =
        resourceFlag >= 0
          ? path.resolve(process.argv[resourceFlag + 1] || '', 'quant-engine')
          : path.resolve(__dirname, '../../assets/quant-engine', spec.asset),
      destination = path.join(resources, 'quant-engine');
    fs.mkdirSync(destination, { recursive: true });
    for (const file of ['engine.gz', 'manifest.json', 'LICENSE'])
      fs.copyFileSync(path.join(source, file), path.join(destination, file));
    process.resourcesPath = resources;
    delete process.env.CIBYP_QUANT_ENGINE_BIN;
    live = new NativeEngine({ directory: path.join(root, 'ledger') });
    const prepared = live.resolve();
    assert.equal(prepared.development, false);
    assert.ok(prepared.binary.startsWith(root + path.sep));
    assert.equal(prepared.sha256, binary.decode(destination).manifest.sha256);
    const started = await live.start();
    assert.equal(started.development, false);
    assert.equal(started.version, binary.lock.engineVersion);
    assert.equal((await live.call('status')).mode, 'paper');
    const instrument = {
      id: 'fixture:ETH-USD',
      base: 'ETH',
      quote: 'USD',
      tick: '1',
      lot: '0.1',
      min_notional: '1',
      fee_bps: 10,
    };
    await live.call('instrument.register', instrument);
    const snapshot = {
      instrument: instrument.id,
      epoch: 'old',
      sequence: '1',
      bids: [['99', '1']],
      asks: [['101', '1']],
      source_time_ns: '1700000000000000000',
    };
    await assert.rejects(live.feed('market.snapshot', snapshot), /SOURCE_TIME_STALE/);
    await stop(live);
    fs.writeFileSync(prepared.binary, 'corrupted cache');
    assert.equal(live.resolve().sha256, prepared.sha256);
    assert.equal(binary.sha256(fs.readFileSync(prepared.binary)), prepared.sha256);
    replay = new NativeEngine({ directory: path.join(root, 'replay'), replay: true });
    const replayState = await replay.start();
    assert.equal(replayState.development, false);
    assert.equal(replayState.mode, 'replay');
    await replay.call('instrument.register', instrument);
    const result = await replay.replayStep({
      wall_ns: '1700000000000000000',
      mono_ns: '0',
      event: { method: 'market.snapshot', params: snapshot },
    });
    assert.equal(result.event.ok, true);
    assert.equal((await replay.call('status')).mode, 'replay');
    await stop(replay);
    const integration = require('node:child_process').spawnSync(
      process.execPath,
      [
        '--test',
        ...[
          'quant-native-engine.test.cjs',
          'quant-strategies.test.cjs',
          'quant-event-replay.test.cjs',
          'quant-native-safety.test.cjs',
          'quant-execution-outbox.test.cjs',
        ].map((file) => path.join(__dirname, file)),
      ],
      {
        stdio: 'inherit',
        windowsHide: true,
        timeout: 120000,
        env: {
          ...process.env,
          CIBYP_QUANT_TEST_BINARY: prepared.binary,
          CIBYP_QUANT_ENGINE_BIN: prepared.binary,
        },
      },
    );
    if (integration.error || integration.status !== 0)
      throw (
        integration.error ||
        Error('Managed native financial integration failed: ' + integration.status)
      );
    console.log(
      '[quant-native-resource] PASS: managed ' +
        spec.key +
        ' resource, architecture/hash verification, cache repair, live-clock protection, replay and owned shutdown',
    );
  } finally {
    await stop(live);
    await stop(replay);
    live?.dispose();
    replay?.dispose();
    if (oldResources === undefined) delete process.resourcesPath;
    else process.resourcesPath = oldResources;
    if (oldOverride !== undefined) process.env.CIBYP_QUANT_ENGINE_BIN = oldOverride;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cibyp-managed-native-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
