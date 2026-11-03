/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHash } = require('node:crypto');
const { PRODUCTS, amount, decimal } = require('./coinbase-stream');
const fail = (code) => {
  throw Error(code);
};
const key = (prefix, owner, operation) => {
  if (typeof operation !== 'string' || !/^\w[\w:-]{0,127}$/.test(operation))
    fail('NATIVE_OPERATION_ID_REQUIRED');
  return (
    prefix +
    ':' +
    createHash('sha256')
      .update(owner + '\0' + operation)
      .digest('hex')
  );
};
const positive = (v) => {
  const n = amount(v, true);
  return decimal(n);
};
function config(input = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          'quantity',
          'sides',
          'bidOffsetTicks',
          'askOffsetTicks',
          'repriceTicks',
          'refreshMs',
          'ttlMs',
          'minInventory',
          'maxInventory',
          'maxNotional',
          'maxFees',
          'maxDecisions',
        ].includes(k),
    )
  )
    fail('INVALID_STRATEGY');
  const integer = (name, fallback, min, max) => {
    const value = input[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_STRATEGY');
    return value;
  };
  const sides = input.sides ?? 'both';
  if (!['both', 'buy', 'sell'].includes(sides)) fail('INVALID_STRATEGY');
  return {
    quantity: positive(input.quantity ?? '0.001'),
    sides,
    bid_offset_ticks: integer('bidOffsetTicks', 0, 0, 100000),
    ask_offset_ticks: integer('askOffsetTicks', 0, 0, 100000),
    reprice_ticks: integer('repriceTicks', 1, 1, 100000),
    refresh_ms: integer('refreshMs', 1000, 100, 60000),
    ttl_ms: integer('ttlMs', 15000, 1000, 3600000),
    min_inventory: decimal(amount(input.minInventory ?? '0')),
    max_inventory: positive(input.maxInventory ?? '10'),
    max_notional: positive(input.maxNotional ?? '10000'),
    max_fees: positive(input.maxFees ?? '50'),
    max_decisions: integer('maxDecisions', 1000, 1, 100000),
  };
}
const page = (input) => {
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
};
class NativeStrategies {
  constructor(service) {
    this.service = service;
    this.queue = Promise.resolve();
  }
  changed(id) {
    try {
      this.service.publish({ type: 'quant-native-strategies-changed', id });
    } catch {
      /* Execution is independent of observers. */
    }
  }
  request(action, input) {
    if (['define', 'start', 'stop'].includes(action)) {
      const task = this.queue.then(() => this.execute(action, input));
      this.queue = task.catch(() => {});
      return task;
    }
    return this.execute(action, input);
  }
  async execute(action, input) {
    const service = this.service,
      w = service.workspace(input.id),
      owner = 'workspace:' + w.id,
      engine = service.native;
    if (action === 'view') {
      const offline = () => ({
        connected: false,
        definitionsPage: { items: [], total: null, next: null },
        selected: null,
        runsPage: { items: [], total: null, next: null },
        decisionsPage: { items: [], total: null, next: null },
      });
      if (engine.state !== 'connected') return offline();
      const offset = page(input).offset,
        decisionOffset = input.decisionOffset ?? 0;
      if (!Number.isSafeInteger(decisionOffset) || decisionOffset < 0) fail('INVALID_PAGINATION');
      try {
        return {
          ...(await engine.call('strategy.view', {
            owner,
            id: input.strategyId || null,
            offset,
            decision_offset: decisionOffset,
          })),
          connected: true,
        };
      } catch (error) {
        if (engine.state !== 'connected') return offline();
        throw error;
      }
    }
    if (action === 'list' && engine.state !== 'connected')
      return { connected: false, items: [], total: null, next: null };
    if (engine.state !== 'connected') fail('NATIVE_NOT_RUNNING');
    const get = async (id, revision) => {
      const value = await engine.call('strategy.get', { id, revision });
      if (value.definition.owner !== owner) fail('STRATEGY_SCOPE_MISMATCH');
      return value;
    };
    const run = async (runId) => {
      if (typeof runId !== 'string') fail('STRATEGY_RUN_REQUIRED');
      const page = await engine.call('strategy.runs', { owner, run: runId, limit: 1 });
      if (!page.items.length) fail('STRATEGY_SCOPE_MISMATCH');
      return page.items[0];
    };
    if (action === 'list')
      return {
        ...(await engine.call('strategy.list', { owner, ...page(input) })),
        connected: true,
      };
    if (action === 'get' || action === 'versions') {
      await get(input.strategyId, input.revision);
      return action === 'get'
        ? get(input.strategyId, input.revision)
        : engine.call('strategy.list', { owner, id: input.strategyId, ...page(input) });
    }
    if (action === 'runs')
      return engine.call('strategy.runs', {
        owner,
        ...page(input),
        ...(input.strategyId ? { id: input.strategyId } : {}),
        ...(input.runId ? { run: input.runId } : {}),
      });
    if (action === 'decisions') {
      await run(input.runId);
      return engine.call('strategy.decisions', { run: input.runId, ...page(input) });
    }
    if (action === 'define') {
      if (w.nativePaper?.pendingOrder) fail('NATIVE_RECONCILE_REQUIRED');
      const strategyId = input.strategyId ?? key('strategy', owner, input.operationId);
      if (input.strategyId) await get(strategyId);
      const revision = input.revision ?? 1;
      if (!Number.isInteger(revision) || revision < 1 || revision > 1000) fail('INVALID_STRATEGY');
      if (!PRODUCTS.includes(input.product)) fail('SOURCE_MARKET_INVALID');
      const source = service.nativeMarkets
        .inspect()
        .sources.find((s) => s.product === input.product);
      if (!source?.instrument) fail('SOURCE_NOT_STARTED');
      const account = input.accountId ?? w.nativePaper?.accountId;
      if (!account) fail('NATIVE_ACCOUNT_REQUIRED');
      await engine.call('account.get', { id: account });
      const name = String(input.name ?? '').trim();
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) fail('INVALID_STRATEGY');
      try {
        const result = await engine.call('strategy.define', {
          id: strategyId,
          owner,
          name,
          revision,
          account,
          instrument: source.instrument,
          maker: config(input.config),
        });
        this.changed(w.id);
        return result;
      } catch (error) {
        error.strategyId = strategyId;
        throw error;
      }
    }
    if (action === 'start') {
      if (w.nativePaper?.pendingOrder) fail('NATIVE_RECONCILE_REQUIRED');
      const mode = input.mode ?? 'paper';
      if (!['paper', 'shadow'].includes(mode)) fail('STRATEGY_LIVE_NOT_IMPLEMENTED');
      const runId = key('run', owner, input.operationId);
      const previous = await engine.call('strategy.runs', { owner, run: runId, limit: 1 });
      if (previous.items.length) {
        const old = previous.items[0];
        if (
          old.run.strategy !== input.strategyId ||
          old.run.mode !== mode ||
          (input.revision !== undefined && old.run.revision !== input.revision)
        )
          fail('STRATEGY_RUN_CONFLICT');
        return { ...old, duplicate: true };
      }
      const definition = (await get(input.strategyId, input.revision)).definition;
      try {
        const result = await engine.call('strategy.start', {
          id: definition.id,
          revision: definition.revision,
          mode,
          run_id: runId,
        });
        this.changed(w.id);
        return result;
      } catch (error) {
        error.runId = runId;
        error.strategyId = definition.id;
        throw error;
      }
    }
    if (action === 'stop') {
      await run(input.runId);
      const result = await engine.call('strategy.stop', {
        run_id: input.runId,
        cancel: input.cancelOrders !== false,
      });
      this.changed(w.id);
      return result;
    }
    fail('UNKNOWN_STRATEGY_ACTION');
  }
}
module.exports = { NativeStrategies, config };
