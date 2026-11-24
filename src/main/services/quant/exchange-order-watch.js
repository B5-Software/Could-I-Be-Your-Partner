/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { id } = require('./coinbase-exchange');
const { CoinbaseUserFeed } = require('./coinbase-user-feed');

const environments = ['sandbox', 'live'];
const accountBinding = (account) => account?.credentialId || account?.profileId;
const errorCode = (error) =>
  /^EXCHANGE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'EXCHANGE_WATCH_NETWORK';

class ExchangeOrderWatch {
  static file(directory) {
    return path.join(directory, 'coinbase-order-watch.json');
  }
  constructor(
    owner,
    {
      feedFactory = (options) => new CoinbaseUserFeed(options),
      pollMs = 30000,
      fallbackMs = 15000,
      minimumMs = 350,
      now = Date.now,
      monotonic = () => performance.now(),
    } = {},
  ) {
    Object.assign(this, { owner, feedFactory, pollMs, fallbackMs, minimumMs, now, monotonic });
    this.file = ExchangeOrderWatch.file(owner.service.directory);
    this.monitors = new Map();
    this.bindings = {};
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error();
      const { version, bindings } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        version !== 1 ||
        !bindings ||
        Array.isArray(bindings) ||
        typeof bindings !== 'object' ||
        Object.entries(bindings).some(
          ([env, key]) => !environments.includes(env) || typeof key !== 'string' || !id.test(key),
        )
      )
        throw Error();
      this.bindings = bindings;
    } catch (error) {
      if (error.code !== 'ENOENT') this.storageError = 'EXCHANGE_WATCH_STORAGE';
    }
  }
  async resume() {
    await Promise.all(
      Object.keys(this.bindings).map(async (env) => {
        try {
          this.accountChanged(env, await this.owner.account(env, false));
        } catch {
          /* The order panel reports an unreadable account vault. */
        }
      }),
    );
  }
  setEnabled(env, account, enabled) {
    if (typeof enabled !== 'boolean') throw Error('EXCHANGE_WATCH_CONFIG');
    const next = { ...this.bindings };
    if (enabled) next[env] = accountBinding(account);
    else delete next[env];
    try {
      this.owner.write(this.file, { version: 1, bindings: next });
    } catch {
      throw Error('EXCHANGE_WATCH_STORAGE');
    }
    this.storageError = null;
    this.bindings = next;
    this.accountChanged(env, account);
    return this.status(env);
  }
  accountChanged(env, account) {
    if (this.owner.closed || this.owner.accounts.get(env) !== account) return;
    const enabled = Boolean(this.bindings[env] && this.bindings[env] === accountBinding(account));
    const before = this.monitors.get(env);
    if (before?.account === account && enabled) return;
    if (before) {
      this.monitors.delete(env);
      before.dispose();
    }
    if (enabled) {
      const monitor = new OrderMonitor(this, env, account);
      this.monitors.set(env, monitor);
      monitor.refreshOrders();
    }
    this.emit(env);
  }
  status(env) {
    return (
      this.monitors.get(env)?.status() || {
        enabled: false,
        phase: 'off',
        error: this.storageError || null,
      }
    );
  }
  ordersChanged(env) {
    this.monitors.get(env)?.refreshOrders();
    this.emit(env);
  }
  emit(env, detail) {
    if (this.owner.closed) return;
    try {
      this.owner.service.publish({ type: 'quant-exchange-changed', env, ...detail });
    } catch {
      /* Durable orders and transport remain authoritative. */
    }
  }
  dispose() {
    for (const monitor of this.monitors.values()) monitor.dispose();
    this.monitors.clear();
  }
}

class OrderMonitor {
  constructor(watch, env, account) {
    this.watch = watch;
    this.env = env;
    this.account = account;
    this.entries = new Map();
    this.phase = 'idle';
    this.controller = new AbortController();
    this.feed = watch.feedFactory({
      env,
      account,
      onStatus: (phase, error) => {
        this.phase = phase;
        this.transportError = error;
        if (phase === 'live') for (const entry of this.entries.values()) this.expedite(entry, true);
        this.schedule();
        watch.emit(env);
      },
      onHint: (product, venueIds, clientId) => {
        let matched = false;
        for (const entry of this.entries.values()) {
          const order = entry.order;
          if (
            order.product === product &&
            (order.clientId === clientId || venueIds.includes(order.venueId))
          ) {
            this.expedite(entry);
            matched = true;
          }
        }
        if (!matched) return;
        this.lastEventAt = watch.now();
        this.schedule();
      },
    });
  }
  status() {
    return {
      enabled: true,
      phase: this.phase,
      tracked: this.entries.size,
      lastEventAt: this.lastEventAt || null,
      lastVerifiedAt: this.lastVerifiedAt || null,
      error: this.restError || this.transportError || null,
    };
  }
  refreshOrders() {
    if (this.controller.signal.aborted) return;
    const now = this.watch.now();
    const time = this.watch.monotonic();
    const keep = new Set();
    for (const order of this.watch.owner.orders) {
      if (
        order.env !== this.env ||
        order.profileId !== this.account.profileId ||
        !this.watch.owner.shouldWatch(order, now)
      )
        continue;
      keep.add(order.clientId);
      const entry = this.entries.get(order.clientId);
      if (entry) entry.order = order;
      else this.entries.set(order.clientId, { order, due: time, lastAttempt: 0, failures: 0 });
    }
    for (const key of this.entries.keys()) if (!keep.has(key)) this.entries.delete(key);
    this.feed.setProducts([
      ...new Set([...this.entries.values()].map(({ order }) => order.product)),
    ]);
    this.schedule();
  }
  expedite(entry, recovered = false) {
    const time = this.watch.monotonic();
    if (!recovered && entry.failures && entry.due > time) return;
    entry.due = Math.min(entry.due, Math.max(time, entry.lastAttempt + this.watch.minimumMs));
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.reading || this.controller.signal.aborted || !this.entries.size) return;
    const due = Math.min(...[...this.entries.values()].map((entry) => entry.due));
    const delay = Math.max(0, Math.max(due, this.nextRead || 0) - this.watch.monotonic());
    this.timer = setTimeout(() => void this.read(), delay);
    this.timer.unref?.();
  }
  async read() {
    const { owner, now, monotonic, minimumMs, pollMs, fallbackMs } = this.watch;
    if (this.controller.signal.aborted || this.reading) return;
    let entry;
    for (const row of this.entries.values()) if (!entry || row.due < entry.due) entry = row;
    const time = monotonic();
    if (!entry || entry.due > time || (this.nextRead || 0) > time) return this.schedule();
    if (!owner.shouldWatch(entry.order, now())) return this.refreshOrders();
    if (this.env === 'live' && owner.emergencyCancellation.running) {
      this.nextRead = time + 750;
      return this.schedule();
    }
    if (owner.activeWrites.has(entry.order.clientId)) {
      entry.due = time + 750;
      return this.schedule();
    }
    this.reading = true;
    entry.lastAttempt = time;
    entry.due = time + (this.phase === 'live' ? pollMs : fallbackMs);
    try {
      const verified = await owner.verifyWatchedOrder(
        this.account,
        entry.order,
        this.controller.signal,
      );
      if (verified) {
        entry.failures = 0;
        entry.error = null;
        this.lastVerifiedAt = now();
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        entry.error = errorCode(error);
        entry.failures++;
        entry.due = monotonic() + Math.min(180000, fallbackMs * 2 ** Math.min(entry.failures, 4));
      }
    } finally {
      this.reading = false;
      this.nextRead = monotonic() + minimumMs;
      this.restError = [...this.entries.values()].find((row) => row.error)?.error || null;
      if (!this.controller.signal.aborted) {
        this.refreshOrders();
        this.watch.emit(this.env);
      }
    }
  }
  dispose() {
    this.controller.abort();
    this.feed.dispose();
    clearTimeout(this.timer);
  }
}

module.exports = { ExchangeOrderWatch };
