/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { createHash } = require('node:crypto');
const { LiveExecution, configOf } = require('../../src/main/services/quant/live-execution');
test('quant child plan pages do not expose sibling or legacy root plans and cannot operate them by ID', async (t) => {
  const { rootContext, deriveChild } = require('../../src/main/services/wallet/agent-scopes');
  const context = deriveChild(rootContext('workspace'), 'native-sub-child'),
    runs = ['own', 'descendant', 'sibling', 'legacy'].map((id) => ({
      plan: {
        id,
        owner: 'workspace:workspace',
        chain_id: 8453,
        ...(id === 'legacy' ? {} : { agent_scope: { id, subject: id } }),
      },
    }));
  const scopes = {
    ensure: async () => ({ binding: { id: 'child' } }),
    get: async (id) => ({ path: id === 'sibling' ? ['sibling', 'root'] : [id, 'child', 'root'] }),
  };
  const service = {
    workspace: () => ({ id: 'workspace' }),
    native: {
      handshake: { executionOutbox: 2 },
      start: async () => {},
      execution: async (action, p) =>
        action === 'list'
          ? { items: runs, total: 4, next: 20 }
          : runs.find((r) => r.plan.id === p.id),
    },
    getWallet: () => ({ agentScopes: scopes }),
  };
  const controller = new LiveExecution(service);
  t.after(() => controller.dispose());
  const page = await controller.request('list', { id: 'workspace' }, { agentContext: context });
  assert.deepEqual(
    page.items.map((r) => r.plan.id),
    ['own', 'descendant'],
  );
  assert.equal(page.total, null);
  assert.equal(page.next, 20);
  for (const runId of ['sibling', 'legacy'])
    await assert.rejects(
      controller.request('get', { id: 'workspace', runId }, { agentContext: context }),
      /FORBIDDEN/,
    );
  controller.owners.set('sibling', 'workspace');
  controller.activated.add('sibling');
  await assert.rejects(
    controller.request('stop', { id: 'workspace', runId: 'sibling' }, { agentContext: context }),
    /FORBIDDEN/,
  );
  assert.equal(
    controller.activated.has('sibling'),
    true,
    'A forbidden child stop must not abort another branch before authorization',
  );
  await assert.rejects(
    controller.request('list', { id: 'workspace' }, { agentContext: rootContext('foreign') }),
    /FORBIDDEN/,
  );
});
for (const kind of ['stop', 'pause'])
  test(
    'a delayed start acknowledgement cannot restore execution authority after ' + kind,
    async (t) => {
      const workspace = { id: 'workspace', market: { venue: 'base', poolFee: 500, rpcUrl: '' } };
      const plan = {
        id: 'execution:race',
        owner: 'workspace:workspace',
        wallet: 'wallet',
        template: 'base-twap-v1',
        chain_id: 8453,
        pool_fee: 500,
        max_fee_reserve_wei: '10000000000000000',
        config_hash: createHash('sha256')
          .update(JSON.stringify(configOf(workspace)))
          .digest('hex'),
      };
      const run = { plan, phase: 'paused' };
      let ready, release;
      const started = new Promise((r) => {
          ready = r;
        }),
        gate = new Promise((r) => {
          release = r;
        });
      const native = {
        state: 'connected',
        handshake: { executionOutbox: 2 },
        async start() {},
        async execution(action) {
          if (action === 'get') return structuredClone(run);
          if (action === 'start') {
            run.phase = 'running';
            const value = structuredClone(run);
            ready();
            await gate;
            return value;
          }
          if (action === 'stop') {
            run.phase = 'stopped';
            return structuredClone(run);
          }
          assert.fail('Unexpected ' + action);
        },
      };
      const service = {
        native,
        workspace: () => workspace,
        publish: () => {},
        getWallet: () => ({
          wallet: () => ({ id: 'wallet' }),
          isUnlocked: () => true,
          policy: () => ({ id: 'grant' }),
        }),
      };
      const controller = new LiveExecution(service);
      t.after(() => controller.dispose());
      const starting = controller.request('start', { id: workspace.id, runId: plan.id });
      await started;
      if (kind === 'stop') await controller.request('stop', { id: workspace.id, runId: plan.id });
      else controller.abortAll();
      release();
      await assert.rejects(starting, /WALLET_EXECUTION_STOPPED/);
      assert.equal(controller.activated.size, 0);
      assert.equal(run.phase, 'stopped');
    },
  );
