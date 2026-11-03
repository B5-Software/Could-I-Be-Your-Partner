/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Real native process, real WAL and wall-clock scheduling. No broker or network.
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { NativeEngine } = require('../../src/main/services/quant/native-engine');
const binary =
  process.env.CIBYP_QUANT_TEST_BINARY ||
  require('../../src/main/services/quant/native-binary').developmentBinary(
    path.resolve(__dirname, '../..'),
  );
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await pause(20);
  }
  throw Error('Native execution condition timed out');
}
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-outbox-process-')),
    events = [];
  const engine = new NativeEngine({
    directory,
    binaryPath: binary,
    publish: (event) => events.push(event),
    ...options,
  });
  t.after(async () => {
    if (engine.child) {
      const child = engine.child,
        exited = new Promise((r) => child.once('exit', r));
      await engine.stop();
      await exited;
    }
    engine.dispose();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-outbox-process-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await engine.start();
  return {
    engine,
    directory,
    events,
    call: (action, input = {}) => engine.execution(action, input),
  };
}
const definition = (id = 'twap:process') => ({
  template: 'base-twap-v1',
  id,
  owner: 'workspace:process',
  wallet: 'wallet:process',
  chain_id: 8453,
  side: 'buy',
  total_input_atoms: '10000001',
  slices: 2,
  interval_ms: 1000,
  slippage_bps: 50,
  pool_fee: 500,
  config_hash: 'b'.repeat(64),
});
function proof(command, stage) {
  return {
    command: command.id,
    lease: command.lease,
    stage,
    intent_ids: ['intent:' + command.ordinal],
    hashes: ['0x' + String(command.ordinal).padStart(64, '0')],
    reason: 'CHAIN_RESULT',
  };
}

test('global live hold pauses every execution plan durably without pausing PAPER or granting report access', async (t) => {
  const { engine, call } = await fixture(t);
  await engine.call('enable', {});
  await call('create', definition('live:first'));
  await call('create', { ...definition('live:second'), wallet: 'wallet:second' });
  await call('start', { id: 'live:first', policy_id: 'policy:one' });
  await call('start', { id: 'live:second', policy_id: 'policy:two' });
  const rows = await until(async () => {
    const page = await call('pending', { limit: 20 });
    return page.items.length === 2 ? page.items : null;
  });
  await call('claim', { id: rows[0].command.id, lease: 'lease:global-stop' });
  await assert.rejects(engine.call('execution.hold', {}), /METHOD_UNAVAILABLE/);
  await assert.rejects(call('hold', { reason: 'caller-chosen' }), /INVALID_EXECUTION_CONTROL/);
  await call('hold', {});
  for (const runId of ['live:first', 'live:second']) {
    const run = await call('get', { id: runId });
    assert.equal(run.phase, 'paused');
    assert.equal(run.reason, 'WALLET_EMERGENCY_STOPPED');
  }
  assert.equal((await engine.call('status')).ledger.enabled, true);
  const commands = (await call('commands', { id: rows[0].run.plan.id })).items;
  assert.equal(commands[0].stage, 'uncertain');
  const exited = new Promise((resolve) => engine.child.once('exit', resolve));
  await engine.stop();
  await exited;
  await engine.start();
  for (const runId of ['live:first', 'live:second'])
    assert.equal((await call('get', { id: runId })).phase, 'paused');
});
test(
  'native TWAP outbox schedules without chat, pins budget and finality, and preserves claimed work after a crash',
  { timeout: 20000 },
  async (t) => {
    const { engine, call, events } = await fixture(t);
    assert.equal(engine.handshake.liveExecution, false);
    assert.equal(engine.handshake.executionOutbox, 2);
    await call('create', definition());
    await call('start', { id: 'twap:process', policy_id: 'policy:process' });
    const getPending = async () => (await call('pending', { id: 'twap:process' })).items[0];
    const first = await until(getPending);
    assert.equal(first.dispatch_allowed, true);
    assert.equal(first.command.input_atoms, '5000001');
    assert.equal(first.run.plan.template, 'base-twap-v1');
    const claimed = await call('claim', { id: first.command.id, lease: 'lease:process' });
    await assert.rejects(
      call('claim', { id: first.command.id, lease: 'lease:other' }),
      /ALREADY_CLAIMED/,
    );
    const persisted = (await call('commands', { id: 'twap:process' })).items;
    assert.equal(persisted[0].stage, 'claimed');
    await call('report', proof(claimed, 'safe'));
    await pause(1100);
    assert.equal((await call('commands', { id: 'twap:process' })).total, 1);
    assert.equal((await call('get', { id: 'twap:process' })).completed_slices, 0);
    const at = Date.now();
    await call('report', proof(claimed, 'finalized'));
    await pause(200);
    await call('report', proof(claimed, 'finalized'));
    assert.equal((await call('commands', { id: 'twap:process' })).total, 1);
    const second = await until(async () => {
      const value = await getPending();
      return value?.command.ordinal === 2 && value;
    });
    assert.ok(Date.now() - at >= 950, 'The next slice must not be emitted as a catch-up burst');
    assert.equal(second.command.input_atoms, '5000000');
    const next = await call('claim', { id: second.command.id, lease: 'lease:second' });
    const child = engine.child,
      exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    await until(() => engine.state === 'failed');
    await engine.start();
    const recovered = await call('get', { id: 'twap:process' });
    assert.equal(recovered.phase, 'paused');
    const uncertain = await getPending();
    assert.equal(uncertain.command.stage, 'uncertain');
    assert.equal(uncertain.dispatch_allowed, false);
    assert.equal(uncertain.command.id, next.id);
    await assert.rejects(
      call('start', { id: 'twap:process', policy_id: 'policy:new' }),
      /CANNOT_START/,
    );
    await call('report', proof(next, 'finalized'));
    const done = await call('get', { id: 'twap:process' });
    assert.equal(done.phase, 'completed');
    assert.equal(done.allocated_input_atoms, '10000001');
    assert.equal((await call('commands', { id: 'twap:process' })).total, 2);
    assert.ok(events.some((event) => event.type === 'quant-native-execution-changed'));
  },
);
test('stopping a ready command is known unsent; stale claims, cross-project reads and generic fill injection are rejected', async (t) => {
  const { engine, call } = await fixture(t);
  await call('create', definition());
  await call('start', { id: 'twap:process', policy_id: 'policy:process' });
  const first = await until(async () => (await call('pending')).items[0]);
  await call('stop', { id: 'twap:process' });
  assert.equal((await call('commands', { id: 'twap:process' })).items[0].stage, 'unsent');
  await assert.rejects(call('claim', { id: first.command.id, lease: 'lease:late' }), /NOT_PENDING/);
  await assert.rejects(
    call('commands', { id: 'twap:process', owner: 'workspace:other' }),
    /SCOPE_MISMATCH/,
  );
  await assert.rejects(engine.call('execution.report', {}), /METHOD_UNAVAILABLE/);
  await assert.rejects(engine.call('execution.start', {}), /METHOD_UNAVAILABLE/);
  await assert.rejects(
    call('create', { ...definition(), total_input_atoms: '10000002' }),
    /PLAN_CONFLICT/,
  );
  await call('start', { id: 'twap:process', policy_id: 'policy:renewed' });
  const second = await until(async () => (await call('pending')).items[0]);
  assert.notEqual(second.command.id, first.command.id);
  assert.equal(second.command.ordinal, first.command.ordinal);
  const other = { ...definition('twap:other'), owner: 'workspace:other' };
  await call('create', other);
  await assert.rejects(call('start', { id: other.id, policy_id: 'policy:renewed' }), /WALLET_BUSY/);
  assert.equal((await call('list', { owner: 'workspace:other' })).total, 1);
});
test('global pause durably holds execution plans and enabling PAPER cannot resume them', async (t) => {
  const { engine, call } = await fixture(t);
  await call('create', definition());
  await call('start', { id: 'twap:process', policy_id: 'policy:process' });
  await until(async () => (await call('pending')).items[0]);
  await engine.call('pause', {});
  const paused = await call('get', { id: 'twap:process' });
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.reason, 'GLOBAL_PAUSED');
  assert.equal(paused.pending, null);
  await engine.call('enable', {});
  await pause(1100);
  assert.equal((await call('get', { id: 'twap:process' })).phase, 'paused');
  assert.equal((await call('commands', { id: 'twap:process' })).total, 1);
});
test('offline replay rejects wallet execution even when the internal wrapper is bypassed', async (t) => {
  const { engine, call } = await fixture(t, { replay: true });
  await assert.rejects(call('create', definition()), /REPLAY_EXECUTION_DISABLED/);
  await assert.rejects(
    engine.request('execution.create', definition()),
    /REPLAY_EXECUTION_DISABLED/,
  );
});
