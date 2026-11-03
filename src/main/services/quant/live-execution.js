/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// One controller per shared backend, independent of chat/renderer lifetimes.
// The native outbox allocates input; WalletService remains signing authority.
const { createHash, randomUUID } = require('node:crypto');
const { parseUnits, formatUnits, Interface } = require('ethers');
const { CHAINS } = require('./market-data');
const { executeBaseSwap, deployments } = require('./base-swap');
const fail = (code) => {
  throw Error(code);
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const owner = (id) => 'workspace:' + id;
const code = (error) =>
  /^[A-Z][A-Z_0-9]{1,79}$/.test(error?.message || '')
    ? error.message
    : 'EXECUTION_RECONCILE_REQUIRED';
const terminalUnsent = (record) =>
  (!record.hash && ['failed', 'denied', 'expired', 'cancelled'].includes(record.status)) ||
  record.submissionMayHaveOccurred === false;
const erc20 = new Interface(['function approve(address,uint256) returns(bool)']);
function configOf(workspace) {
  const market = workspace.market;
  if (!['base', 'base-sepolia'].includes(market.venue)) fail('EXECUTION_BASE_REQUIRED');
  return {
    venue: market.venue,
    rpcUrl: market.rpcUrl || '',
    poolFee: market.poolFee ?? 500,
    ...(market.pool ? { pool: market.pool } : {}),
  };
}
function page(input) {
  const offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    fail('INVALID_PAGINATION');
  return { offset, limit };
}
class LiveExecution {
  constructor(service) {
    this.service = service;
    this.active = new Map();
    this.activated = new Set();
    this.nextCheck = new Map();
    this.errors = new Map();
    this.queue = Promise.resolve();
    this.owners = new Map();
    this.authorityEpoch = 0;
    this.runEpochs = new Map();
    this.disposed = false;
    this.cursor = 0;
  }
  nativeChanged(event) {
    if (this.service.native.state !== 'connected' || event.faulted) {
      this.abortAll('WALLET_EXECUTION_ENGINE_UNAVAILABLE');
      return;
    }
    this.wake();
  }
  wake() {
    if (this.disposed || this.timer || this.service.native.state !== 'connected') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump()
        .catch((error) => {
          this.lastError = code(error);
        })
        .finally(() => {
          if (!this.disposed && this.service.native.state === 'connected') this.wake();
        });
    }, 500);
    this.timer.unref?.();
  }
  abortAll(reason = 'WALLET_EXECUTION_STOPPED') {
    this.authorityEpoch++;
    this.activated.clear();
    for (const value of this.active.values()) value.controller.abort(Error(reason));
  }
  emergencyHalt() {
    this.abortAll('WALLET_EMERGENCY_STOPPED');
    if (this.service.native.state !== 'connected') return Promise.resolve();
    return this.service.native.execution('hold', {}).catch((error) => {
      this.lastError = 'WALLET_EMERGENCY_NATIVE_PAUSE_FAILED';
      this.changed();
      throw error;
    });
  }
  abortRun(id) {
    this.runEpochs.set(id, (this.runEpochs.get(id) || 0) + 1);
    this.activated.delete(id);
    for (const value of this.active.values())
      if (value.run === id) value.controller.abort(Error('WALLET_EXECUTION_STOPPED'));
  }
  changed(workspaceId) {
    try {
      this.service.publish({ type: 'quant-live-execution-changed', id: workspaceId });
    } catch {
      /* Observers do not own execution. */
    }
  }
  wallet() {
    return this.service.getWallet?.() || fail('LIVE_SIGNER_NOT_IMPLEMENTED');
  }
  async native() {
    await this.service.native.start();
    if (this.service.native.handshake?.executionOutbox !== 2) fail('EXECUTION_PROTOCOL_REQUIRED');
    return this.service.native;
  }
  async get(workspaceId, runId) {
    const run = await this.service.native.execution('get', { id: runId });
    if (run.plan.owner !== owner(workspaceId)) fail('EXECUTION_SCOPE_MISMATCH');
    this.owners.set(run.plan.id, workspaceId);
    return run;
  }
  request(action, input, context = {}) {
    if (
      action === 'stop' &&
      this.owners.get(input.runId) === input.id &&
      (!context.agentContext ||
        (context.agentContext.nodes.length === 1 && context.agentContext.workspaceId === input.id))
    )
      this.abortRun(input.runId);
    if (['create', 'start'].includes(action)) {
      const task = this.queue.then(() => this.execute(action, input, context));
      this.queue = task.catch(() => {});
      return task;
    }
    // Stop must not wait behind an approval/signature or an ordinary operation.
    return this.execute(action, input, context);
  }
  async execute(action, input = {}, context = {}) {
    const workspace = this.service.workspace(input.id),
      native = await this.native();
    if (context.agentContext) {
      require('../wallet/agent-scopes').validateContext(context.agentContext);
      if (context.agentContext.workspaceId !== workspace.id) fail('WALLET_AGENT_SCOPE_FORBIDDEN');
    }
    if (action === 'list') {
      const result = await native.execution('list', { owner: owner(workspace.id), ...page(input) });
      if (context.agentContext?.nodes.length > 1) {
        const items = [];
        for (const run of result.items)
          if (await this.agentAccess(run, context.agentContext)) items.push(run);
        return {
          ...result,
          items,
          total: null,
          scopeFiltered: true,
          lastError: this.lastError || null,
        };
      }
      return {
        ...result,
        lastError: this.lastError || null,
      };
    }
    if (action === 'create') {
      if (typeof input.operationId !== 'string' || !/^\w[\w:-]{0,127}$/.test(input.operationId))
        fail('NATIVE_OPERATION_ID_REQUIRED');
      if (
        !['buy', 'sell'].includes(input.side) ||
        typeof input.totalInput !== 'string' ||
        !/^\d{1,20}(?:\.\d{1,18})?$/.test(input.totalInput)
      )
        fail('INVALID_EXECUTION_PLAN');
      const config = configOf(workspace),
        wallet = this.wallet().wallet(input.walletId);
      let total, budget;
      try {
        total = parseUnits(input.totalInput, input.side === 'buy' ? 6 : 18);
        budget = parseUnits(input.maxEstimatedFeeEth ?? '0.01', 18);
      } catch {
        fail('INVALID_EXECUTION_PLAN');
      }
      if (total <= 0n || budget <= 0n || typeof (input.maxEstimatedFeeEth ?? '0.01') !== 'string')
        fail('INVALID_EXECUTION_PLAN');
      const agentScope = await this.wallet().agentScopes.binding(
        context.agentContext || require('../wallet/agent-scopes').rootContext(workspace.id),
        wallet.id,
        CHAINS[config.venue].id,
      );
      const result = await native.execution('create', {
        agent_scope: { id: agentScope.id, subject: agentScope.subject },
        template: 'base-twap-v1',
        id: 'execution:' + hash([owner(workspace.id), input.operationId]),
        owner: owner(workspace.id),
        wallet: wallet.id,
        chain_id: CHAINS[config.venue].id,
        side: input.side,
        total_input_atoms: String(total),
        slices: input.slices ?? 1,
        interval_ms: input.intervalMs ?? 60000,
        slippage_bps: input.slippageBps ?? 50,
        pool_fee: config.poolFee,
        config_hash: hash(config),
        max_fee_reserve_wei: String(budget),
      });
      this.changed(workspace.id);
      return result;
    }
    const run = await this.get(workspace.id, input.runId);
    if (context.agentContext && !(await this.agentAccess(run, context.agentContext)))
      fail('WALLET_AGENT_SCOPE_FORBIDDEN');
    if (action === 'get') {
      const records = this.wallet().state.intents.filter(
        (i) => i.execution?.planId === run.plan.id,
      );
      const estimate = records.reduce((sum, i) => sum + BigInt(i.feeReserveWei), 0n);
      return {
        run,
        feeUsage: {
          reservedEstimateWei: String(estimate),
          budgetWei: run.plan.max_fee_reserve_wei,
          chainEnforced: false,
        },
        lastError: this.errors.get(run.plan.id) || null,
      };
    }
    if (action === 'commands')
      return native.execution('commands', {
        id: run.plan.id,
        owner: owner(workspace.id),
        ...page(input),
      });
    if (action === 'stop') {
      this.abortRun(run.plan.id);
      const result = await native.execution('stop', { id: run.plan.id });
      this.changed(workspace.id);
      this.wake();
      return result;
    }
    if (action === 'start') {
      this.assertPlan(run);
      if (run.plan.agent_scope)
        await this.wallet().agentScopes.fromBinding(
          run.plan.agent_scope,
          run.plan.chain_id,
          workspace.id,
        );
      const wallet = this.wallet(),
        policy = wallet.policy(wallet.wallet(run.plan.wallet), configOf(workspace).venue);
      if (!wallet.isUnlocked(run.plan.wallet)) fail('WALLET_LOCKED');
      if (!policy) fail('EXECUTION_AUTONOMOUS_AUTH_REQUIRED');
      if (run.phase === 'running') {
        if (!this.activated.has(run.plan.id)) fail('EXECUTION_OWNER_REQUIRED');
        if (run.policy_id !== policy.id) fail('WALLET_AUTHORIZATION_CHANGED');
        return run;
      }
      const epoch = this.authorityEpoch,
        runEpoch = this.runEpochs.get(run.plan.id) || 0;
      const result = await native.execution('start', { id: run.plan.id, policy_id: policy.id });
      if (
        this.disposed ||
        epoch !== this.authorityEpoch ||
        runEpoch !== (this.runEpochs.get(run.plan.id) || 0)
      ) {
        try {
          await native.execution('stop', { id: run.plan.id });
        } catch {
          /* The stale callback never gains local authority. */
        }
        fail('WALLET_EXECUTION_STOPPED');
      }
      this.activated.add(run.plan.id);
      this.errors.delete(run.plan.id);
      this.wake();
      this.changed(workspace.id);
      return result;
    }
    if (action === 'reconcile') {
      const pending = (await native.execution('pending', { id: run.plan.id })).items[0];
      if (
        pending &&
        !this.active.has(pending.command.id) &&
        pending.command.lease?.startsWith('bridge:')
      )
        await this.reconcile(pending, false);
      return this.get(workspace.id, run.plan.id);
    }
    fail('UNKNOWN_EXECUTION_ACTION');
  }
  async agentAccess(run, context) {
    if (!run.plan.agent_scope) return context.nodes.length === 1;
    if (context.nodes.some((node) => !node.chains.includes(run.plan.chain_id))) return false;
    const actor = await this.wallet().agentScopes.ensure(context, run.plan.chain_id, true);
    const target = await this.wallet().agentScopes.get(run.plan.agent_scope.id);
    return target.path.includes(actor.binding.id);
  }
  workspace(run) {
    if (!run.plan.owner.startsWith('workspace:')) fail('EXECUTION_SCOPE_MISMATCH');
    return this.service.workspace(run.plan.owner.slice(10));
  }
  assertPlan(run) {
    const config = configOf(this.workspace(run));
    if (
      run.plan.template !== 'base-twap-v1' ||
      run.plan.chain_id !== CHAINS[config.venue].id ||
      run.plan.pool_fee !== config.poolFee ||
      run.plan.config_hash !== hash(config)
    )
      fail('WALLET_EXECUTION_CONFIG_CHANGED');
    if (!run.plan.max_fee_reserve_wei || !/^[1-9]\d{0,37}$/.test(run.plan.max_fee_reserve_wei))
      fail('WALLET_EXECUTION_FEE_BUDGET_REQUIRED');
    this.wallet().wallet(run.plan.wallet);
    return config;
  }
  guard(row, controller, pid) {
    if (this.disposed || controller.signal.aborted || !this.activated.has(row.run.plan.id))
      fail('WALLET_EXECUTION_STOPPED');
    if (
      this.service.native.state !== 'connected' ||
      this.service.native.child?.pid !== pid ||
      this.service.native.lastError === 'NATIVE_STORAGE_FAULT'
    )
      fail('WALLET_EXECUTION_ENGINE_UNAVAILABLE');
    const config = this.assertPlan(row.run),
      wallet = this.wallet();
    if (wallet.policy(wallet.wallet(row.run.plan.wallet), config.venue)?.id !== row.run.policy_id)
      fail('WALLET_AUTHORIZATION_CHANGED');
  }
  async pump() {
    if (this.pumping || this.disposed || this.service.native.state !== 'connected') return;
    this.pumping = true;
    try {
      const batch = await this.service.native.execution('pending', {
        offset: this.cursor,
        limit: 20,
      });
      this.cursor = batch.next ?? 0;
      for (const row of batch.items) {
        if (this.disposed) break;
        const id = row.command.id;
        if (this.active.has(id) || Date.now() < (this.nextCheck.get(id) || 0)) continue;
        this.nextCheck.set(id, Date.now() + 2000);
        if (row.dispatch_allowed && this.activated.has(row.run.plan.id)) {
          const controller = new AbortController(),
            value = { run: row.run.plan.id, controller };
          this.active.set(id, value);
          value.promise = this.dispatch(row, controller)
            .catch(async (error) => {
              this.errors.set(row.run.plan.id, code(error));
              await this.holdUnknown(row, error);
            })
            .finally(() => {
              if (this.active.get(id) === value) this.active.delete(id);
              this.changed(row.run.plan.owner.slice(10));
            });
        } else if (row.command.lease?.startsWith('bridge:')) {
          try {
            await this.reconcile(row, false);
          } catch (error) {
            this.errors.set(row.run.plan.id, code(error));
            await this.holdUnknown(row, error);
          }
        }
      }
      const pendingIds = new Set(batch.items.map((row) => row.command.id));
      if (batch.next === null && this.cursor === 0 && batch.total <= 20) {
        for (const id of this.nextCheck.keys()) if (!pendingIds.has(id)) this.nextCheck.delete(id);
      }
    } finally {
      this.pumping = false;
    }
  }
  async holdUnknown(row, error) {
    this.abortRun(row.run.plan.id);
    if (this.disposed || this.service.native.state !== 'connected' || !row.command.lease) return;
    let records = [];
    try {
      records = this.records(row);
    } catch {
      /* Preserve known native evidence when local scope is invalid. */
    }
    try {
      await this.service.native.execution('report', {
        command: row.command.id,
        lease: row.command.lease,
        stage: 'uncertain',
        reason: code(error),
        intent_ids: [...new Set([...row.command.intent_ids, ...records.map((i) => i.id)])],
        hashes: [
          ...new Set([...row.command.hashes, ...records.filter((i) => i.hash).map((i) => i.hash)]),
        ],
      });
    } catch {
      /* Unknown report acknowledgement is never retried as a payment. */
    }
  }
  async dispatch(row, controller) {
    const native = this.service.native,
      pid = native.child?.pid,
      lease = 'bridge:' + randomUUID();
    let claimed = false;
    try {
      this.guard(row, controller, pid);
      row.command = await native.execution('claim', { id: row.command.id, lease });
      claimed = true;
      this.guard(row, controller, pid);
      const config = this.assertPlan(row.run);
      await executeBaseSwap({
        market: this.service.market,
        walletService: this.wallet(),
        config,
        input: {
          walletId: row.run.plan.wallet,
          side: row.run.plan.side,
          amountIn: formatUnits(row.command.input_atoms, row.run.plan.side === 'buy' ? 6 : 18),
          slippageBps: row.run.plan.slippage_bps,
        },
        commandId: row.command.id,
        workspaceId: this.workspace(row.run).id,
        ...(row.run.plan.agent_scope ? { agentScopeBinding: row.run.plan.agent_scope } : {}),
        signal: controller.signal,
        expectedPolicyId: row.run.policy_id,
        execution: {
          planId: row.run.plan.id,
          commandId: row.command.id,
          scopeHash: hash(row.run.plan),
          feeBudgetWei: row.run.plan.max_fee_reserve_wei,
        },
        checkAuthority: () => this.guard(row, controller, pid),
      });
    } catch (error) {
      this.errors.set(row.run.plan.id, code(error));
      if (!claimed) {
        this.abortRun(row.run.plan.id);
        // A lost claim acknowledgement is not permission to retry the claim or send.
        try {
          await native.execution('stop', { id: row.run.plan.id });
        } catch {
          /* Durable claim is recovered as unknown. */
        }
        throw error;
      }
    }
    if (claimed) await this.reconcile(row, true);
  }
  records(row) {
    const wallet = this.wallet();
    const venue = Object.keys(CHAINS).find((key) => CHAINS[key].id === row.run.plan.chain_id);
    if (!venue) fail('EXECUTION_BASE_REQUIRED');
    const config = { venue };
    const records = wallet.state.intents.filter((i) =>
      [row.command.id + ':approve', row.command.id + ':swap'].includes(i.commandId),
    );
    for (const record of records) {
      const scope = record.execution;
      if (
        record.walletId !== row.run.plan.wallet ||
        record.chainId !== row.run.plan.chain_id ||
        record.workspaceId !== row.run.plan.owner.slice(10) ||
        scope?.planId !== row.run.plan.id ||
        scope.commandId !== row.command.id ||
        scope.scopeHash !== hash(row.run.plan) ||
        scope.feeBudgetWei !== row.run.plan.max_fee_reserve_wei
      )
        fail('EXECUTION_WALLET_SCOPE_MISMATCH');
      if (record.commandId.endsWith(':swap')) {
        const description = record.description;
        if (
          record.transaction.to.toLowerCase() !== deployments[config.venue].router ||
          description.kind !== 'uniswap-v3-swap' ||
          description.recipient.toLowerCase() !==
            wallet.wallet(row.run.plan.wallet).address.toLowerCase() ||
          description.poolFee !== row.run.plan.pool_fee ||
          description.tokenIn !== (row.run.plan.side === 'buy' ? 'USDC' : 'WETH') ||
          parseUnits(description.amountIn, row.run.plan.side === 'buy' ? 6 : 18) !==
            BigInt(row.command.input_atoms)
        )
          fail('EXECUTION_WALLET_SCOPE_MISMATCH');
      } else {
        const parsed = erc20.parseTransaction({ data: record.transaction.data });
        if (
          record.transaction.to.toLowerCase() !==
            (row.run.plan.side === 'buy' ? CHAINS[config.venue].usdc : CHAINS[config.venue].weth) ||
          parsed?.name !== 'approve' ||
          parsed.args[0].toLowerCase() !== deployments[config.venue].router ||
          parsed.args[1] !== BigInt(row.command.input_atoms)
        )
          fail('EXECUTION_WALLET_SCOPE_MISMATCH');
      }
    }
    return records;
  }
  async reconcile(row, owned) {
    if (this.disposed || this.service.native.state !== 'connected') return;
    // Reconciliation is permitted after revocation or lock. It never signs.
    const wallet = this.wallet();
    let records = this.records(row);
    for (const record of records) {
      if (
        (record.hash || record.status === 'signing-unknown') &&
        record.submissionMayHaveOccurred !== false &&
        record.status !== 'finalized' &&
        !(record.status === 'reverted' && record.confirmation === 'finalized')
      )
        await wallet.reconcile(record.id);
    }
    records = this.records(row);
    const swap = records.find((i) => i.commandId.endsWith(':swap'));
    let stage = 'uncertain',
      reason = this.errors.get(row.run.plan.id) || 'EXECUTION_RECONCILE_REQUIRED';
    if (swap?.status === 'finalized') {
      stage = 'finalized';
      reason = 'SWAP_FINALIZED';
    } else if (swap?.status === 'reverted' && swap.confirmation === 'finalized') {
      stage = 'reverted';
      reason = 'SWAP_REVERTED';
    } else if (swap && ['submitted', 'included', 'safe'].includes(swap.status)) {
      stage = swap.status;
      reason = 'AWAITING_FINALITY';
    } else if (records.every((i) => terminalUnsent(i))) {
      if (records.length || owned) {
        stage = 'unsent';
        reason = this.errors.get(row.run.plan.id) || 'NOT_DISPATCHED';
      }
    } else if (
      (!swap || terminalUnsent(swap)) &&
      records.every(
        (i) =>
          terminalUnsent(i) ||
          i.status === 'finalized' ||
          (i.status === 'reverted' && i.confirmation === 'finalized'),
      )
    ) {
      stage = 'aborted';
      reason = 'APPROVAL_SETTLED_SWAP_NOT_SENT';
    }
    if (stage === 'uncertain' || ['unsent', 'reverted', 'aborted'].includes(stage))
      this.abortRun(row.run.plan.id);
    if (stage === 'unsent' && row.command.hashes.length) stage = 'aborted';
    await this.service.native.execution('report', {
      command: row.command.id,
      lease: row.command.lease,
      stage,
      intent_ids: records.map((i) => i.id),
      hashes: records.filter((i) => i.hash).map((i) => i.hash),
      reason,
    });
    if (stage === 'finalized') {
      // A completion can remove authority, never recreate authority cleared by
      // a concurrent stop/pause/disconnect.
      const current = await this.service.native.execution('get', { id: row.run.plan.id });
      if (current.phase !== 'running') this.activated.delete(current.plan.id);
      this.errors.delete(row.run.plan.id);
    }
    this.changed(row.run.plan.owner.slice(10));
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.abortAll();
  }
}
module.exports = { LiveExecution, configOf };
