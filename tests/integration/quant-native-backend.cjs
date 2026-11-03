/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// The same Node backend used by TUI/WebUI, from source or the shipped JS bundle.
// No network, model request, signer, credentials or real funds are involved.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-native-backend-'));
const entry = process.argv.includes('--bundled')
  ? path.resolve('dist/node-core/core.cjs')
  : require.resolve('../../src/agent/node-host');
let host, pid;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = () => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const call = (action, input = {}) =>
  host.dispatch({ method: 'quant:request', args: [action, input] });
async function open() {
  host = await require(entry).createNodeRuntime({
    dataDir: profile,
    workspaceRoot: path.join(profile, 'workspaces'),
    settings: {
      features: { quant: true },
      onboardingCompleted: true,
      language: 'en',
      runtime: { location: 'host' },
      automaticMemory: { enabled: false },
      decision: { enabled: false },
    },
  });
}
async function close() {
  if (host) {
    await host.close();
    host = null;
  }
  for (let i = 0; i < 200 && alive(); i++) await sleep(10);
  assert.equal(alive(), false, 'owned native process exits with its backend');
}
(async () => {
  try {
    await open();
    const project = await call('workspace.create', {
      name: 'Native backend fixture',
      venue: 'coinbase',
    });
    pid = (await call('native.start')).pid;
    assert.ok(pid);
    const created = await call('native.paper.create', {
      id: project.id,
      operationId: 'create',
      name: 'Shared virtual account',
      assets: { USD: '1000', ETH: '1' },
      maxOrderNotional: { USD: '500' },
      maxAssetPosition: { ETH: '5' },
    });
    await call('native.paper.enable', { id: project.id });
    const view = await call('native.paper.view', { id: project.id, kind: 'orders' });
    assert.equal(view.account.id, created.id);
    assert.equal(view.account.active, true);
    assert.equal(view.account.assets.USD.available, '1000');
    assert.equal(view.historyPage.total, 0);
    assert.equal((await call('native.start')).pid, pid, 'frontends reuse the owned process');
    const outbox = host.runtime.quantService.native;
    await outbox.execution('create', {
      template: 'base-twap-v1',
      id: 'backend:execution',
      owner: 'workspace:' + project.id,
      wallet: 'wallet:fixture',
      chain_id: 8453,
      side: 'buy',
      total_input_atoms: '10',
      slices: 2,
      interval_ms: 1000,
      slippage_bps: 50,
      pool_fee: 500,
      config_hash: 'c'.repeat(64),
    });
    await outbox.execution('start', { id: 'backend:execution', policy_id: 'policy:fixture' });
    let pending;
    for (let i = 0; i < 200 && !pending; i++) {
      pending = (await outbox.execution('pending', { id: 'backend:execution' })).items[0];
      if (!pending) await sleep(10);
    }
    assert.ok(pending);
    await outbox.execution('claim', { id: pending.command.id, lease: 'lease:backend' });
    await assert.rejects(call('native.execution.report', {}), /UNKNOWN_QUANT_ACTION/);
    await close();
    await open();
    pid = (await call('native.start')).pid;
    const restored = await call('native.paper.view', { id: project.id, kind: 'executions' });
    assert.equal(restored.account.id, created.id);
    assert.equal(restored.account.active, false);
    assert.equal(restored.account.assets.ETH.total, '1');
    const recovery = await host.runtime.quantService.native.execution('pending', {
      id: 'backend:execution',
    });
    assert.equal(recovery.items[0].run.phase, 'paused');
    assert.equal(recovery.items[0].command.stage, 'uncertain');
    assert.equal(recovery.items[0].command.id, pending.command.id);
    assert.equal(recovery.items[0].dispatch_allowed, false);
    await close();
    console.log(
      '[quant-native-backend] PASS: ' +
        (process.argv.includes('--bundled') ? 'bundled' : 'source') +
        ' shared Node backend, atomic paper views, persisted account binding, private execution outbox recovery and owned process cleanup',
    );
  } finally {
    await close();
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('cibyp-native-backend-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
