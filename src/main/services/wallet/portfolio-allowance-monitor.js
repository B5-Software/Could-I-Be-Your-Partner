/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { digest, read, write, page } = require('../quant/event-files');

const intervals = [60, 300, 900];
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const maxMonitors = 32;
const maxFile = 3 * 1024 * 1024;
const maxNotices = 30;
const failure = (code) => Error(code);
const changed = 'WALLET_ALLOWANCE_MONITOR_CHANGED';
const partial = 'WALLET_ALLOWANCE_MONITOR_PARTIAL';
const attention = new Set([
  'WALLET_ALLOWANCE_MONITOR_REBASE',
  'WALLET_ALLOWANCE_REPORT_SCOPE',
  'WALLET_ALLOWANCE_MONITOR_REMOVED',
]);
const folder = (directory) => path.join(directory, 'allowance-monitors');
const monitorFiles = (directory) => {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error();
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.json') && idPattern.test(name.slice(0, -5)));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw failure('WALLET_ALLOWANCE_MONITOR_STORE');
  }
};
function readState(directory, name) {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFile)
    throw failure('WALLET_ALLOWANCE_MONITOR_STORE');
  const { state, checksum } = read(file);
  if (
    state?.version !== 1 ||
    state.id + '.json' !== name ||
    checksum !== digest(state) ||
    !Number.isSafeInteger(state.revision) ||
    !intervals.includes(state.intervalSeconds) ||
    typeof state.enabled !== 'boolean' ||
    !state.checkpoint ||
    state.checkpoint.portfolioId !== state.id ||
    !Array.isArray(state.notices) ||
    state.notices.length > maxNotices
  )
    throw failure('WALLET_ALLOWANCE_MONITOR_STORE');
  return state;
}
function compareReports(previous, current) {
  const key = (row) => `${row.walletId}:${row.token}:${row.spender}:${row.protocol}`;
  const known = new Map(previous.rows.map((row) => [key(row), row]));
  const increased = current.rows.filter((row) => {
    const prior = known.get(key(row));
    const activeGrant = (entry) => (entry?.expired ? 0n : BigInt(entry?.allowance ?? '0'));
    return (
      BigInt(row.effectiveAtoms ?? '0') > BigInt(prior?.effectiveAtoms ?? '0') ||
      activeGrant(row) > activeGrant(prior)
    );
  });
  const assets = new Map(previous.totals.map((row) => [row.token, row]));
  const increases = current.totals.flatMap((row) => {
    const prior = assets.get(row.token);
    return ['measured', 'includingPermit2'].flatMap((metric) => {
      const before = prior?.[metric].atomic,
        after = row[metric].atomic;
      if (before == null || after == null || BigInt(after) <= BigInt(before)) return [];
      return [
        { token: row.token, symbol: row.symbol, metric, before: prior[metric], after: row[metric] },
      ];
    });
  });
  if (!increased.length && !increases.length) return null;
  return {
    block: current.block,
    blockHash: current.blockHash,
    observedAt: current.observedAt,
    pairCount: increased.length,
    increaseCount: increases.length,
    pairs: increased
      .slice(0, 6)
      .map(({ walletId, walletName, token, spender, protocol, effectiveAtoms, allowance }) => ({
        walletId,
        walletName,
        token,
        spender,
        protocol,
        effectiveAtoms,
        allowance,
      })),
    increases: increases.slice(0, 8),
  };
}

class PortfolioAllowanceMonitor {
  static shouldStart(directory) {
    const target = folder(directory);
    try {
      return monitorFiles(target)
        .slice(0, maxMonitors)
        .some((name) => {
          try {
            const record = readState(target, name);
            return record.enabled && record.nextAt !== null;
          } catch {
            return false;
          }
        });
    } catch {
      return false;
    }
  }
  constructor(portfolios) {
    this.portfolios = portfolios;
    this.wallet = portfolios.wallet;
    this.allowances = portfolios.allowances;
    this.directory = folder(this.wallet.directory);
    this.records = new Map();
    this.damaged = new Set();
    this.controller = new AbortController();
    try {
      const files = monitorFiles(this.directory);
      if (files.length > maxMonitors) throw failure('WALLET_ALLOWANCE_MONITOR_STORE');
      for (const name of files) {
        try {
          const record = readState(this.directory, name);
          this.records.set(record.id, record);
        } catch {
          this.damaged.add(name.slice(0, -5));
        }
      }
    } catch {
      this.storeFailed = true;
    }
  }
  save(record) {
    write(path.join(this.directory, record.id + '.json'), {
      state: record,
      checksum: digest(record),
    });
    this.records.set(record.id, record);
  }
  checkpointFor(id, baselineReportId) {
    const record = this.records.get(id);
    if (record?.seedReportId === baselineReportId && record.status !== 'attention')
      return record.checkpoint;
    return null;
  }
  view(id, record, input) {
    if (!record)
      return {
        id,
        revision: 0,
        enabled: false,
        status: 'off',
        report: null,
        notices: [],
        next: null,
        total: 0,
      };
    const { checkpoint, notices, ...state } = record;
    if (!input.includeReport) {
      const { items, next, total } = page(notices, input);
      return { ...state, lastBlock: checkpoint.block, notices: items, next, total };
    }
    return {
      ...state,
      lastBlock: checkpoint.block,
      report: this.allowances.view(checkpoint, input),
    };
  }
  async request(action, input) {
    page([], input);
    const initial = await this.portfolios.get(input.id);
    const id = initial.portfolio.id;
    if (this.storeFailed || this.damaged.has(id)) throw failure('WALLET_ALLOWANCE_MONITOR_STORE');
    const previous = this.records.get(id);
    if (action === 'get') return this.view(id, previous, input);
    if (!['start', 'stop'].includes(action)) throw failure('UNKNOWN_WALLET_ACTION');
    if (input.expectedRevision !== (previous?.revision ?? 0)) throw failure(changed);
    if (action === 'stop') {
      if (!previous?.enabled) return this.view(id, previous, input);
      const stopped = {
        ...previous,
        revision: previous.revision + 1,
        enabled: false,
        status: 'off',
        nextAt: null,
        error: null,
      };
      this.save(stopped);
      if (this.activeId === id) this.active?.abort(failure(changed));
      return this.view(id, stopped, input);
    }
    if (!previous && this.records.size + this.damaged.size >= maxMonitors)
      throw failure('WALLET_ALLOWANCE_MONITOR_LIMIT');
    const intervalSeconds = input.intervalSeconds ?? 300;
    if (!intervals.includes(intervalSeconds) || initial.state === 'removed')
      throw failure('WALLET_ALLOWANCE_MONITOR_BASELINE');
    const checkpoint = this.allowances.load(id, input.reportId);
    if (
      (checkpoint.portfolioRevision !== initial.revision &&
        checkpoint.reportId !== initial.portfolio.allowanceCeiling?.baselineReportId) ||
      checkpoint.coverage.mode !== 'recent' ||
      checkpoint.coverage.window?.toBlock !== checkpoint.block ||
      checkpoint.coverage.scanIncomplete ||
      checkpoint.coverage.unreadablePairs ||
      checkpoint.coverage.unknownBalances
    )
      throw failure('WALLET_ALLOWANCE_MONITOR_BASELINE');
    const record = {
      version: 1,
      id,
      enabled: true,
      revision: (previous?.revision ?? 0) + 1,
      intervalSeconds,
      status: 'pending',
      nextAt: Date.now(),
      failures: 0,
      checkedAt: null,
      error: null,
      seedReportId: checkpoint.reportId,
      checkpoint,
      notices: previous?.notices ?? [],
    };
    this.save(record);
    if (this.activeId === id) this.active?.abort(failure(changed));
    return this.view(id, record, input);
  }
  tick(now = Date.now()) {
    if (this.pending || this.controller.signal.aborted) return this.pending;
    const due = [...this.records.values()]
      .filter((r) => r.enabled && r.nextAt !== null && r.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!due) return;
    this.activeId = due.id;
    this.active = new AbortController();
    const signal = AbortSignal.any([this.active.signal, this.controller.signal]);
    this.pending = this.check(due, signal).finally(() => {
      this.active = this.pending = this.activeId = null;
    });
    return this.pending;
  }
  async check(record, signal) {
    const live = () => !signal.aborted && this.records.get(record.id) === record;
    let checkpoint, notice;
    try {
      const initial = await this.portfolios.get(record.id);
      if (initial.state === 'removed') throw failure('WALLET_ALLOWANCE_MONITOR_REMOVED');
      const tokens = record.checkpoint.coverage.tokens;
      checkpoint = await this.allowances.run(
        initial,
        {
          ...(tokens.length === 1 && { token: tokens[0] }),
          blocks: 2000 / 2 ** Math.min(record.failures, 4),
        },
        signal,
        record.checkpoint,
      );
      if (
        checkpoint.coverage.scanIncomplete ||
        checkpoint.coverage.unreadablePairs ||
        checkpoint.coverage.unknownBalances
      )
        throw failure(partial);
      if (checkpoint !== record.checkpoint) notice = compareReports(record.checkpoint, checkpoint);
    } catch (error) {
      if (!live()) return;
      const code = /^[A-Z][A-Z_0-9]{1,80}$/.test(error?.message || '')
        ? error.message
        : 'WALLET_ALLOWANCE_READ_FAILED';
      const needsAttention = attention.has(code);
      const failures = Math.min(6, record.failures + 1);
      this.save({
        ...record,
        status: needsAttention ? 'attention' : 'retrying',
        error: code,
        failures,
        nextAt: needsAttention ? null : Date.now() + Math.min(900, 15 * 2 ** failures) * 1000,
      });
      if (needsAttention && record.status !== 'attention') this.publish(record.id, 'attention');
      return;
    }
    if (!live()) return;
    const now = Date.now();
    const catchingUp = BigInt(checkpoint.coverage.monitorLagBlocks ?? '0') > 0n;
    this.save({
      ...record,
      status: catchingUp ? 'catchingUp' : 'watching',
      checkpoint,
      failures: 0,
      error: null,
      checkedAt: now,
      nextAt: now + (catchingUp ? 15 : record.intervalSeconds) * 1000,
      notices: notice ? [notice, ...record.notices].slice(0, maxNotices) : record.notices,
    });
    if (notice) this.publish(record.id, 'increase');
  }
  publish(portfolioId, reason) {
    try {
      this.wallet.publish({ type: 'wallet-allowance-monitor', portfolioId, reason });
    } catch {
      /* The notice is already saved. */
    }
  }
  dispose() {
    this.controller.abort(failure('WALLET_STOPPED'));
    return this.pending;
  }
}

module.exports = { PortfolioAllowanceMonitor };
