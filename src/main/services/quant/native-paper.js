/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHash } = require('node:crypto');
const { PRODUCTS, amount, decimal } = require('./coinbase-stream');
const fail = (code) => {
  throw Error(code);
};
const token = (value) => typeof value === 'string' && /^[\w:-]{1,128}$/.test(value);
const identity = (project, operation) => {
  if (!token(operation)) fail('NATIVE_OPERATION_ID_REQUIRED');
  return (
    'paper:' +
    createHash('sha256')
      .update(project + '\0' + operation)
      .digest('hex')
  );
};
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
const value = (text, positive = false) => {
  if (typeof text !== 'string') fail('AMOUNT_STRING_REQUIRED');
  const n = amount(text);
  if (n < 0n || (positive && n === 0n)) fail('INVALID_AMOUNT');
  return decimal(n);
};
const assets = (input, positive) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 16)
    fail('INVALID_ASSETS');
  const output = Object.create(null);
  for (const [asset, total] of Object.entries(input)) {
    if (!['USD', 'ETH', 'BTC', 'SOL'].includes(asset)) fail('ASSET_UNAVAILABLE');
    output[asset] = value(total, positive);
  }
  return output;
};
class NativePaper {
  constructor(service) {
    this.service = service;
    this.queue = Promise.resolve();
  }
  changed(id, safety = false, affectedAccount) {
    try {
      const workspaces = this.service.state?.workspaces || [];
      const account =
        affectedAccount || workspaces.find((w) => w.id === id)?.nativePaper?.accountId;
      const affected = new Set([
        id,
        ...workspaces
          .filter((w) => account && w.nativePaper?.accountId === account)
          .map((w) => w.id),
      ]);
      for (const target of affected) {
        this.service.publish({ type: 'quant-native-paper-changed', id: target });
        if (safety) this.service.publish({ type: 'quant-native-strategies-changed', id: target });
      }
    } catch {
      /* Observers cannot change an acknowledged ledger command. */
    }
  }
  request(action, input) {
    // A delayed normal request must not keep an emergency stop in its queue.
    if (action === 'halt') return this.execute(action, input);
    if (
      [
        'create',
        'bind',
        'enable',
        'pause',
        'submit',
        'cancel',
        'reconcile',
        'halt',
        'reset-halt',
      ].includes(action)
    ) {
      const task = this.queue.then(() => this.execute(action, input));
      this.queue = task.catch(() => {});
      return task;
    }
    return this.execute(action, input);
  }
  async execute(action, input) {
    const service = this.service,
      w = service.workspace(input.id),
      id = w.id,
      engine = service.native;
    const clearPending = () =>
      service.mutate((state) => {
        delete service.workspace(id, state).nativePaper.pendingOrder;
        return { ok: true };
      });
    if (action === 'view' || action === 'status') {
      const offline = () => ({
        connected: false,
        engineState: engine.state,
        accountId: w.nativePaper?.accountId ?? null,
        account: null,
        pendingOrder: w.nativePaper?.pendingOrder ?? null,
        sources: service.nativeMarkets.inspect().sources,
        accountsPage: null,
        historyPage: null,
      });
      if (engine.state !== 'connected') return offline();
      let account,
        data = {};
      try {
        if (action === 'view') {
          if (!['orders', 'executions'].includes(input.kind ?? 'orders'))
            fail('INVALID_HISTORY_KIND');
          const accountOffset = input.accountOffset ?? 0;
          if (!Number.isSafeInteger(accountOffset) || accountOffset < 0) fail('INVALID_PAGINATION');
          data = await engine.call('portfolio.view', {
            account: w.nativePaper?.accountId ?? null,
            strategy: 'workspace:' + id,
            kind: input.kind ?? 'orders',
            ...page(input),
            account_offset: accountOffset,
          });
          account = data.account;
        } else
          account = w.nativePaper?.accountId
            ? await engine.call('account.get', { id: w.nativePaper.accountId })
            : null;
      } catch (error) {
        if (engine.state !== 'connected') return offline();
        throw error;
      }
      return {
        ...data,
        connected: true,
        engineState: engine.state,
        accountId: account?.id ?? null,
        account,
        pendingOrder: w.nativePaper?.pendingOrder ?? null,
        sources: service.nativeMarkets.inspect().sources,
        model: 'conservative-l2-fifo',
        latencyMs: 500,
        liveExecution: false,
      };
    }
    if (engine.state !== 'connected') fail('NATIVE_NOT_RUNNING');
    if (action === 'accounts') return engine.call('accounts', page(input));
    if (action === 'create') {
      if (w.nativePaper?.pendingOrder) fail('NATIVE_RECONCILE_REQUIRED');
      const accountId = identity(id, input.operationId),
        name = String(input.name ?? '').trim();
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
        fail('INVALID_ACCOUNT_NAME');
      const max = input.maxOpenOrders ?? 20;
      if (!Number.isInteger(max) || max < 1 || max > 10000) fail('INVALID_RISK');
      const risk = {
        max_open_orders: max,
        max_order_notional: assets(input.maxOrderNotional, true),
        max_asset_position: assets(input.maxAssetPosition, true),
      };
      await engine.call('account.create', {
        id: accountId,
        name,
        assets: assets(input.assets, false),
        risk,
      });
      await service.mutate((state) => {
        service.workspace(id, state).nativePaper = { accountId };
        return { accountId };
      });
      this.changed(id);
      return engine.call('account.get', { id: accountId });
    }
    if (action === 'bind') {
      if (w.nativePaper?.pendingOrder) fail('NATIVE_RECONCILE_REQUIRED');
      if (!token(input.accountId)) fail('INVALID_ACCOUNT');
      await engine.call('account.get', { id: input.accountId });
      await service.mutate((state) => {
        service.workspace(id, state).nativePaper = { accountId: input.accountId };
        return { accountId: input.accountId };
      });
      this.changed(id);
      return this.execute('status', input);
    }
    const account = service.workspace(id).nativePaper?.accountId;
    if (!account) fail('NATIVE_ACCOUNT_REQUIRED');
    const strategy = 'workspace:' + id;
    if (action === 'halt' || action === 'reset-halt') {
      if (input.accountId && input.accountId !== account) fail('ACCOUNT_SCOPE_CHANGED');
      if (action === 'reset-halt' && (input.confirmed !== true || input.accountId !== account))
        fail('HALT_CONFIRMATION_REQUIRED');
      const operation = action === 'halt' ? identity(id, input.operationId) : input.expectedHalt;
      if (!token(operation)) fail('INVALID_HALT_ID');
      const result = await engine.call('account.' + action, { id: account, operation });
      this.changed(id, true, account);
      return result;
    }
    if (action === 'reconcile') {
      const pending = service.workspace(id).nativePaper?.pendingOrder;
      if (!pending) return { state: 'none' };
      if ((await engine.call('status')).ledger.faulted) fail('NATIVE_LEDGER_RECOVERY_REQUIRED');
      let order;
      try {
        order = await engine.call('order.get', { id: pending.orderId });
      } catch (error) {
        if (error.message !== 'ORDER_NOT_FOUND') throw error;
      }
      if (order && (order.request.account !== account || order.request.strategy !== strategy))
        fail('ORDER_SCOPE_MISMATCH');
      await clearPending();
      this.changed(id);
      return { state: order ? 'found' : 'absent', order: order ?? null };
    }
    if (action === 'enable' || action === 'pause') {
      const result = await engine.call('account.' + action, { id: account });
      this.changed(id);
      return result;
    }
    if (action === 'orders' || action === 'executions')
      return engine.call(action, { ...page(input), strategy });
    if (action === 'order' || action === 'cancel') {
      if (!token(input.orderId)) fail('INVALID_ORDER');
      const order = await engine.call('order.get', { id: input.orderId });
      if ((order.owner ?? order.request.strategy) !== strategy) fail('ORDER_SCOPE_MISMATCH');
      if (action === 'order') return order;
      const result = await engine.call('order.cancel', { id: input.orderId });
      this.changed(id);
      return result;
    }
    if (action === 'submit') {
      const orderId = identity(id, input.operationId);
      if (!PRODUCTS.includes(input.product)) fail('SOURCE_MARKET_INVALID');
      if (!['buy', 'sell'].includes(input.side)) fail('INVALID_SIDE');
      const price = value(input.price, true),
        quantity = value(input.quantity, true);
      let prior;
      try {
        prior = await engine.call('order.get', { id: orderId });
      } catch (error) {
        if (error.message !== 'ORDER_NOT_FOUND') throw error;
      }
      if (prior) {
        const r = prior.request;
        if (
          r.account !== account ||
          r.strategy !== strategy ||
          r.side !== input.side ||
          r.price !== price ||
          r.quantity !== quantity ||
          !r.instrument.startsWith('coinbase:' + input.product + ':')
        )
          fail('COMMAND_CONFLICT');
        if (service.workspace(id).nativePaper?.pendingOrder?.orderId === orderId)
          await clearPending();
        return { duplicate: true, order: prior };
      }
      if (service.workspace(id).nativePaper?.pendingOrder) fail('NATIVE_RECONCILE_REQUIRED');
      const source = service.nativeMarkets
        .inspect()
        .sources.find((s) => s.product === input.product);
      if (source?.phase !== 'ready' || !source.instrument) fail('FRESH_BOOK_REQUIRED');
      const request = {
        id: orderId,
        account,
        strategy,
        instrument: source.instrument,
        side: input.side,
        price,
        quantity,
        post_only: true,
      };
      await service.mutate((state) => {
        const project = service.workspace(id, state);
        project.nativePaper.pendingOrder = { orderId, request };
        return { orderId };
      });
      try {
        const result = await engine.call('order.submit', request);
        await clearPending();
        this.changed(id);
        return result;
      } catch (error) {
        if (error.definitive) {
          let healthy = false;
          try {
            healthy = !(await engine.call('status')).ledger.faulted;
          } catch {
            /* Preserve the pending receipt when health cannot be established. */
          }
          if (healthy) await clearPending();
        }
        error.orderId = orderId;
        this.changed(id);
        throw error;
      }
    }
    fail('UNKNOWN_NATIVE_PAPER_ACTION');
  }
}
module.exports = { NativePaper };
