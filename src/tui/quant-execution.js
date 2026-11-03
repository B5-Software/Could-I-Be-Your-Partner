/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { executionAmount } = require('../shared/quant-execution-format');
class LiveExecutionBrowser {
  constructor(parent) {
    this.parent = parent;
    this.draft = null;
  }
  text(key) {
    return this.parent.text(key);
  }
  status(value) {
    return this.parent.ui.status(value);
  }
  call(action, input) {
    return this.parent.call('execution.' + action, input);
  }
  menu(title, keys, choose, body, back) {
    return this.parent.menu(
      title,
      keys.map((value) => (typeof value === 'string' ? { label: this.text(value), value } : value)),
      choose,
      body,
      back,
    );
  }
  wallets() {
    return this.parent.app.runtime.api.backendRequest('wallet:request', 'list');
  }
  async open(id, offset = 0) {
    const [project, page] = await Promise.all([
      this.parent.call('workspace.get', { id }),
      this.call('list', { id, offset, limit: 20 }),
    ]);
    const base = ['base', 'base-sepolia'].includes(project.market.venue);
    const options = ['leBack', 'leWallet', 'leRefresh'];
    if (base) options.push('leCreate');
    options.push(
      ...page.items.map((run) => ({
        label:
          this.text(run.plan.side === 'buy' ? 'leBuy' : 'leSell') +
          ' · ' +
          this.status(run.phase) +
          ' · ' +
          run.completed_slices +
          '/' +
          run.plan.slices,
        value: run.plan.id,
      })),
    );
    if (offset) options.push('lePrevious');
    if (page.next !== null) options.push('leNext');
    return this.menu(
      this.text('leTitle'),
      options,
      async (value) => {
        if (value === 'leBack') return this.parent.project(id);
        if (value === 'leWallet') return this.parent.ui.open();
        if (value === 'leRefresh') return this.open(id, offset);
        if (value === 'leCreate') {
          this.draft = null;
          return this.editor(id);
        }
        if (value === 'lePrevious' || value === 'leNext')
          return this.open(id, value === 'leNext' ? page.next : Math.max(0, offset - 20));
        return this.detail(id, value);
      },
      [
        this.text('leBackground'),
        this.text('leHint'),
        !base ? this.text('leOnlyBase') : this.text('leScope'),
        !page.items.length ? this.text('leEmpty') : '',
      ]
        .filter(Boolean)
        .join('\n'),
      () => this.parent.project(id),
    );
  }
  async detail(id, runId, offset = 0) {
    const [view, history, { wallets }] = await Promise.all([
      this.call('get', { id, runId }),
      this.call('commands', { id, runId, offset, limit: 20 }),
      this.wallets(),
    ]);
    const run = view.run,
      plan = run.plan,
      wallet = wallets.find((w) => w.id === plan.wallet);
    const unit = plan.side === 'buy' ? 'USDC' : 'WETH',
      amount = (value) => executionAmount(value, plan.side === 'buy' ? 6 : 18);
    const authorized =
      wallet?.unlocked &&
      wallet.policy.mode === 'autonomous' &&
      wallet.policy.chains.includes(plan.chain_id) &&
      (!wallet.policy.expiresAt || wallet.policy.expiresAt > Date.now());
    const options = ['leBack', 'leWallet', 'leRefresh'];
    if (['paused', 'stopped'].includes(run.phase) && !run.pending && authorized)
      options.push('leStart');
    if (!['completed', 'stopped'].includes(run.phase)) options.push('leStop');
    if (run.pending) options.push('leReconcile');
    if (offset) options.push('lePrevious');
    if (history.next !== null) options.push('leNext');
    const body = [
      this.text('leBackground'),
      this.text('leHint'),
      this.text(plan.side === 'buy' ? 'leBuy' : 'leSell') + ' · ' + this.status(run.phase),
      (wallet?.name || '—') + ' · ' + plan.chain_id,
      this.text('leProgress') +
        ': ' +
        amount(run.allocated_input_atoms) +
        ' / ' +
        amount(plan.total_input_atoms) +
        ' ' +
        unit,
      this.text('leFees') +
        ': ' +
        executionAmount(view.feeUsage.reservedEstimateWei, 18) +
        ' / ' +
        (view.feeUsage.budgetWei ? executionAmount(view.feeUsage.budgetWei, 18) : '—') +
        ' ETH',
      this.text('leFeeHint'),
      this.text('leSlices') + ': ' + run.completed_slices + ' / ' + plan.slices,
      this.text('leInterval') + ': ' + plan.interval_ms / 1000,
      this.text('leSlippage') + ': ' + plan.slippage_bps / 100 + '%',
      this.text(!wallet?.unlocked ? 'leLocked' : authorized ? 'leGranted' : 'leAutoRequired'),
      run.pending ? this.text(run.phase === 'running' ? 'leFinality' : 'lePending') : '',
      view.lastError ? this.status(view.lastError) : '',
      this.text('leHistory') + ': ' + history.total,
      ...history.items.map((command) =>
        [
          command.ordinal +
            '/' +
            plan.slices +
            ' · ' +
            amount(command.input_atoms) +
            ' ' +
            unit +
            ' · ' +
            this.status(command.stage),
          ...command.hashes,
        ].join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n');
    return this.menu(
      this.text('leTitle'),
      options,
      async (value) => {
        if (value === 'leBack') return this.open(id);
        if (value === 'leWallet') return this.parent.ui.open();
        if (value === 'leNext' || value === 'lePrevious')
          return this.detail(
            id,
            runId,
            value === 'leNext' ? history.next : Math.max(0, offset - 20),
          );
        if (value === 'leStart') await this.call('start', { id, runId });
        if (value === 'leStop') await this.call('stop', { id, runId });
        if (value === 'leReconcile') await this.call('reconcile', { id, runId });
        return this.detail(id, runId, offset);
      },
      body,
      () => this.open(id),
    );
  }
  async editor(id, error = '') {
    const { wallets } = await this.wallets();
    if (!wallets.length)
      return this.menu(
        this.text('leTitle'),
        ['leWallet', 'leBack'],
        (value) => (value === 'leWallet' ? this.parent.ui.open() : this.open(id)),
        this.text('leNoWallet'),
        () => this.open(id),
      );
    this.draft ||= {
      operationId: randomUUID(),
      walletId: wallets[0].id,
      side: 'buy',
      totalInput: '100',
      slices: '2',
      seconds: '60',
      slippage: '0.50',
      maxEstimatedFeeEth: '0.01',
    };
    const d = this.draft;
    const fields = [
      ['totalInput', 'leInput'],
      ['slices', 'leSlices'],
      ['seconds', 'leInterval'],
      ['slippage', 'leSlippage'],
      ['maxEstimatedFeeEth', 'leFeeBudget'],
    ];
    const options = [
      'leCancel',
      'leChooseWallet',
      'leSide',
      ...fields.map(([key, label]) => ({ label: this.text(label) + ': ' + d[key], value: key })),
      'leSave',
    ];
    return this.menu(
      this.text('leReview'),
      options,
      async (value) => {
        if (value === 'leCancel') return this.open(id);
        if (value === 'leChooseWallet')
          return this.menu(
            this.text(value),
            wallets.map((w) => ({
              label: w.name + ' · ' + w.address.slice(0, 10) + '…',
              value: w.id,
            })),
            (walletId) => {
              d.walletId = walletId;
              return this.editor(id);
            },
            '',
            () => this.editor(id),
          );
        if (value === 'leSide')
          return this.menu(
            this.text(value),
            ['leBuy', 'leSell'],
            (side) => {
              d.side = side === 'leBuy' ? 'buy' : 'sell';
              return this.editor(id);
            },
            '',
            () => this.editor(id),
          );
        if (value === 'leSave') {
          try {
            if (
              !/^\d+$/.test(d.slices) ||
              !/^\d+$/.test(d.seconds) ||
              !/^\d(?:\.\d{1,2})?$/.test(d.slippage)
            )
              throw Error(this.text('leInvalid'));
            const result = await this.call('create', {
              id,
              operationId: d.operationId,
              walletId: d.walletId,
              side: d.side,
              totalInput: d.totalInput,
              slices: Number(d.slices),
              intervalMs: Number(d.seconds) * 1000,
              slippageBps: Math.round(Number(d.slippage) * 100),
              maxEstimatedFeeEth: d.maxEstimatedFeeEth,
            });
            this.draft = null;
            return this.detail(id, result.plan.id);
          } catch (failure) {
            return this.editor(id, this.status(failure.message));
          }
        }
        const field = fields.find(([key]) => key === value);
        if (field)
          return this.parent.ui.input(
            this.text(field[1]),
            (entry) => {
              d[value] = entry;
              return this.editor(id);
            },
            { value: d[value], back: () => this.editor(id) },
          );
      },
      [
        this.text('leDraftHint'),
        this.text('leFeeHint'),
        wallets.find((w) => w.id === d.walletId)?.name,
        this.text(d.side === 'buy' ? 'leBuy' : 'leSell'),
        error,
      ]
        .filter(Boolean)
        .join('\n'),
      () => this.open(id),
    );
  }
}
module.exports = { LiveExecutionBrowser };
