/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { id } = require('./coinbase-exchange');

const terminal = new Set(['filled', 'canceled', 'rejected']);
const isOpenOrder = (order) => order?.env === 'live' && !terminal.has(order.status);

class ExchangeEmergencyCancellation {
  constructor(exchange) {
    this.exchange = exchange;
  }
  static valid(batch, orders) {
    if (batch === null) return true;
    if (
      !batch ||
      !id.test(batch.latchId) ||
      !Array.isArray(batch.targets) ||
      batch.targets.length > orders.length ||
      new Set(batch.targets).size !== batch.targets.length ||
      !['running', 'complete', 'attention'].includes(batch.phase)
    )
      return false;
    const liveIds = new Set(
      orders.filter((order) => order.env === 'live').map((order) => order.clientId),
    );
    return batch.targets.every((target) => liveIds.has(target));
  }
  status(latchId) {
    const { cancelBatch: batch, orders } = this.exchange;
    if (!batch || batch.latchId !== latchId) return null;
    const ids = new Set(batch.targets);
    const targeted = orders.filter((o) => ids.has(o.clientId));
    const canceled = targeted.filter((o) => o.status === 'canceled').length;
    const remaining = targeted.filter(isOpenOrder).length;
    const error = remaining ? this.storageFailure || batch.error : null;
    return {
      phase: this.running ? 'running' : remaining ? 'attention' : 'complete',
      targeted: ids.size,
      canceled,
      remaining,
      error,
    };
  }
  notify() {
    this.exchange.service.getWallet().emit();
  }
  start(latchId, { retry = false } = {}) {
    const owner = this.exchange;
    const assertLatch = () => {
      const latch = owner.service.getWallet().emergency.status();
      if (
        owner.closed ||
        latch.latchId !== latchId ||
        !latch.cancelExchangeOrders ||
        latch.storageError
      )
        throw Error('WALLET_EMERGENCY_CHANGED');
    };
    assertLatch();
    owner.emergencyHalt();
    const old = owner.cancelBatch?.latchId === latchId ? owner.cancelBatch : null;
    if (this.running || (old && old.phase !== 'running' && !retry)) return;
    if (old?.phase === 'complete') return;
    const targets = old?.targets || owner.orders.filter(isOpenOrder).map((order) => order.clientId);
    const persist = (batch) => owner.persist(owner.orders, owner.grants, batch);
    const controller = new AbortController();
    const running = { controller, latchId };
    this.storageFailure = null;
    persist({ latchId, targets, phase: targets.length ? 'running' : 'complete', error: null });
    if (!targets.length) return;
    this.running = running;
    const operation = owner.queue
      .then(async () => {
        const guard = () => {
          controller.signal.throwIfAborted();
          assertLatch();
        };
        let error = null;
        try {
          guard();
          await this.cancelTargets(targets, controller, guard);
        } catch (failure) {
          error = publicError(controller.signal.reason || failure);
        }
        if (owner.closed) return;
        const remaining = this.status(latchId).remaining;
        persist({
          latchId,
          targets,
          phase: remaining ? 'attention' : 'complete',
          error: remaining ? error : null,
        });
      })
      .catch(() => {
        this.storageFailure = 'EXCHANGE_EMERGENCY_STORAGE';
      })
      .finally(() => {
        if (this.running === running) this.running = null;
        if (!owner.closed) this.notify();
      });
    owner.queue = operation.catch(() => {});
  }
  async cancelTargets(targets, controller, guard) {
    const owner = this.exchange;
    const byId = new Map(owner.orders.map((order) => [order.clientId, order]));
    const pending = targets.map((key) => byId.get(key)).filter(isOpenOrder);
    if (!pending.length) return;
    const account = await owner.account('live');
    const timer = setTimeout(() => controller.abort(Error('EXCHANGE_EMERGENCY_TIMEOUT')), 45000);
    timer.unref?.();
    let cursor = 0;
    const worker = async () => {
      let failure = null;
      while (cursor < pending.length) {
        guard();
        const order = pending[cursor++];
        try {
          if (order.profileId !== account.profileId) throw Error('EXCHANGE_PROFILE');
          await owner.cancelForEmergency(account, order, guard, controller.signal);
        } catch (error) {
          if (
            [
              'EXCHANGE_AUTH',
              'EXCHANGE_RATE_LIMIT',
              'EXCHANGE_STORE',
              'EXCHANGE_STORE_LIMIT',
            ].includes(error.message)
          )
            controller.abort(error);
          failure ||= error;
        } finally {
          if (!owner.closed) this.notify();
        }
      }
      return failure;
    };
    try {
      const workers = await Promise.allSettled(
        Array.from({ length: Math.min(4, pending.length) }, worker),
      );
      const error =
        controller.signal.reason ||
        workers
          .map((outcome) => (outcome.status === 'rejected' ? outcome.reason : outcome.value))
          .find(Boolean);
      if (error) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  dispose() {
    this.running?.controller.abort(Error('QUANT_STOPPED'));
  }
}

function publicError(error) {
  return /^(EXCHANGE|WALLET_EMERGENCY)_[A-Z_]+$/.test(error?.message || '')
    ? error.message
    : 'EXCHANGE_NETWORK';
}

module.exports = { ExchangeEmergencyCancellation, isOpenOrder };
