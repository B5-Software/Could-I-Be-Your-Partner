/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const {
  executionAmount,
  executionPercent,
  executionSettlementRows,
  executionBenchmarkRows,
  executionArrivalRows,
  executionEntryCondition,
  executionEntryRows,
  executionExitConditions,
} = require('../shared/quant-execution-format');
const schedules = { settlement: 'leAfterFinality', 'fixed-window': 'leFixed', vwap: 'leVwap' };
const entryRelations = {
  immediate: 'leEntryImmediate',
  'at-or-below': 'leEntryBelow',
  'at-or-above': 'leEntryAbove',
  'protective-exit': 'leProtectiveExit',
};
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
  async detail(id, runId, offset = 0, error = '') {
    const [view, history, { wallets }] = await Promise.all([
      this.call('get', { id, runId }),
      this.call('commands', { id, runId, offset, limit: 20 }),
      this.wallets(),
    ]);
    const run = view.run,
      plan = run.plan,
      wallet = wallets.find((w) => w.id === plan.wallet);
    const fixed = plan.template === 'base-twap-fixed-v1' || Boolean(plan.vwap);
    const time = (ns) => new Date(Number(BigInt(ns) / 1000000n)).toLocaleString();
    const unit = plan.side === 'buy' ? 'USDC' : 'WETH',
      amount = (value) => executionAmount(value, plan.side === 'buy' ? 6 : 18);
    const output = (value) =>
      plan.side === 'buy'
        ? executionAmount(value, 18) + ' WETH'
        : executionAmount(value, 6) + ' USDC';
    const authorized =
      wallet?.unlocked &&
      wallet.policy.mode === 'autonomous' &&
      wallet.policy.chains.includes(plan.chain_id) &&
      (!wallet.policy.expiresAt || wallet.policy.expiresAt > Date.now());
    const options = ['leBack', 'leWallet', 'leRefresh'];
    if (view.profile) options.push('leProfileWeights');
    if (view.benchmarkReady && !view.benchmark) options.push('leBenchmark');
    if (['paused', 'stopped'].includes(run.phase) && !run.pending && authorized)
      options.push('leStart');
    if (!['completed', 'stopped', 'expired'].includes(run.phase)) options.push('leStop');
    if (
      run.pending ||
      view.settlement?.receiptsMissing ||
      (view.settlement &&
        view.settlement.fees.operatorReceipts < view.settlement.fees.finalizedTransactions)
    )
      options.push('leReconcile');
    if (offset) options.push('lePrevious');
    if (history.next !== null) options.push('leNext');
    const priceStatus = view.exitStatus || view.entryStatus;
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
      ...executionSettlementRows(plan.side, view.settlement, (key) => this.text(key)).map(
        ([label, value]) => label + ' · ' + value,
      ),
      ...(run.arrival && view.arrivalComparison
        ? [
            this.text('leArrival'),
            this.text('leArrivalScope'),
            ...executionArrivalRows(run.arrival, view.arrivalComparison, (key) =>
              this.text(key),
            ).map(([label, value]) => label + ' · ' + value),
            run.arrival.block_hash,
          ]
        : []),
      ...(view.benchmark
        ? [
            this.text('leBenchmark'),
            this.text('leBenchmarkScope'),
            ...executionBenchmarkRows(view.benchmark, (key) => this.text(key)).map(
              ([label, value]) => label + ' · ' + value,
            ),
          ]
        : []),
      error,
      this.text('leSlices') + ': ' + run.completed_slices + ' / ' + plan.slices,
      this.text(plan.vwap ? 'leVwap' : fixed ? 'leFixed' : 'leAfterFinality'),
      this.text('leInterval') + ': ' + plan.interval_ms / 1000,
      fixed
        ? this.text('leWindow') +
          ' · ' +
          (run.fixed
            ? time(run.fixed.start_at_ns) + ' → ' + time(run.fixed.end_at_ns)
            : this.text('leFirstStart'))
        : '',
      run.fixed
        ? this.text('leSkipped') +
          ' · ' +
          run.fixed.skipped_slices +
          ' · ' +
          amount(run.fixed.skipped_input_atoms) +
          ' ' +
          unit
        : '',
      this.text('leSlippage') + ': ' + plan.slippage_bps / 100 + '%',
      this.text('leMinimumTotal') +
        ' · ' +
        (plan.min_total_output_atoms
          ? output(plan.min_total_output_atoms)
          : this.text('leQuoteOnly')),
      plan.max_arrival_cost_bps === undefined
        ? ''
        : this.text('leArrivalLimit') + ' · ' + plan.max_arrival_cost_bps + ' bp',
      plan.entry_trigger
        ? this.text('leEntry') + ' · ' + executionEntryCondition(plan.entry_trigger)
        : '',
      ...(plan.protective_exit
        ? executionExitConditions(plan.protective_exit, (key) => this.text(key)).map(
            ([label, value]) => label + ' · ' + value,
          )
        : []),
      this.text(!wallet?.unlocked ? 'leLocked' : authorized ? 'leGranted' : 'leAutoRequired'),
      priceStatus
        ? this.status(priceStatus)
        : run.pending
          ? this.text(run.phase === 'running' ? 'leFinality' : 'lePending')
          : '',
      view.lastError || run.phase === 'expired' ? this.status(view.lastError || run.reason) : '',
      this.text('leHistory') + ': ' + history.total,
      ...history.items.map((command) => {
        const exit = command.exit_trigger;
        const observation = exit?.observation || command.entry_observation;
        return [
          command.ordinal +
            '/' +
            plan.slices +
            ' · ' +
            amount(command.input_atoms) +
            ' ' +
            unit +
            ' · ' +
            this.status(command.stage),
          ...(command.window
            ? [
                this.text('leWindow') +
                  ' · ' +
                  time(command.window.opens_at_ns) +
                  ' → ' +
                  time(command.window.closes_at_ns),
              ]
            : []),
          ...(command.min_output_atoms
            ? [this.text('leMinimumSlice') + ' · ' + output(command.min_output_atoms)]
            : []),
          ...(command.min_arrival_output_atoms
            ? [this.text('leArrivalMinimum') + ' · ' + output(command.min_arrival_output_atoms)]
            : []),
          ...(exit
            ? [
                this.text('leExitCause') +
                  ' · ' +
                  this.text(exit.cause === 'stop-loss' ? 'leStopLoss' : 'leTakeProfit'),
              ]
            : []),
          ...(observation
            ? [
                ...executionEntryRows(
                  observation,
                  (key) => this.text(key),
                  this.parent.app.state.language,
                ).map(([label, value]) => label + ' · ' + value),
                observation.block_hash,
              ]
            : []),
          ...executionSettlementRows(plan.side, command.settlement, (key) => this.text(key)).map(
            ([label, value]) => label + ' · ' + value,
          ),
          ...command.hashes,
        ].join('\n');
      }),
    ]
      .filter(Boolean)
      .join('\n');
    return this.menu(
      this.text('leTitle'),
      options,
      async (value) => {
        if (value === 'leBack') return this.open(id);
        if (value === 'leWallet') return this.parent.ui.open();
        if (value === 'leProfileWeights')
          return this.profile(view.profile, () => this.detail(id, runId, offset));
        if (value === 'leNext' || value === 'lePrevious')
          return this.detail(
            id,
            runId,
            value === 'leNext' ? history.next : Math.max(0, offset - 20),
          );
        if (value === 'leStart') await this.call('start', { id, runId });
        if (value === 'leStop') await this.call('stop', { id, runId });
        if (value === 'leReconcile') await this.call('reconcile', { id, runId });
        if (value === 'leBenchmark') {
          try {
            await this.call('benchmark', { id, runId });
          } catch (failure) {
            return this.detail(id, runId, offset, this.status(failure.message));
          }
        }
        return this.detail(id, runId, offset);
      },
      body,
      () => this.open(id),
    );
  }
  profile(profile, back, offset = 0) {
    const pageSize = 5;
    const volumes = profile.wethVolumeAtoms;
    const total = volumes.reduce((sum, value) => sum + BigInt(value), 0n).toString();
    const options = ['leBack'];
    if (offset > 0) options.push('lePrevious');
    if (offset + pageSize < volumes.length) options.push('leNext');
    const lines = [
      this.text('leProfilePool') + ' · ' + profile.pool,
      this.text('leProfileBlock') + ' · ' + profile.finalizedBlock,
      profile.finalizedBlockHash,
      new Date(profile.startTime * 1000).toLocaleString() +
        ' → ' +
        new Date(profile.endTime * 1000).toLocaleString(),
      profile.swapCount + ' ' + this.text('leProfileSwaps'),
      ...volumes
        .slice(offset, offset + pageSize)
        .map(
          (value, index) =>
            offset +
            index +
            1 +
            '/' +
            volumes.length +
            ' · ' +
            executionPercent(value, total) +
            '% · ' +
            executionAmount(value, 18) +
            ' WETH',
        ),
    ];
    return this.menu(
      this.text('leProfileWeights'),
      options,
      (value) =>
        value === 'leBack'
          ? back()
          : this.profile(profile, back, offset + (value === 'leNext' ? pageSize : -pageSize)),
      lines.join('\n'),
      back,
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
      schedule: 'settlement',
      entryRelation: 'immediate',
      entryPrice: '',
      stopLossPrice: '',
      takeProfitPrice: '',
      totalInput: '100',
      minimumTotalOutput: '',
      maxArrivalCostBps: '',
      slices: '2',
      seconds: '60',
      slippage: '0.50',
      maxEstimatedFeeEth: '0.01',
    };
    const d = this.draft;
    const protective = d.entryRelation === 'protective-exit';
    const fields = [
      ['totalInput', 'leInput'],
      ['minimumTotalOutput', 'leMinimumTotal'],
      ['maxArrivalCostBps', 'leArrivalLimit'],
      ...(protective
        ? [
            ['stopLossPrice', 'leStopLossPrice'],
            ['takeProfitPrice', 'leTakeProfitPrice'],
          ]
        : d.entryRelation === 'immediate'
          ? []
          : [['entryPrice', 'leEntryPrice']]),
      ['slices', 'leSlices'],
      ['seconds', 'leInterval'],
      ['slippage', 'leSlippage'],
      ['maxEstimatedFeeEth', 'leFeeBudget'],
    ];
    const options = [
      'leCancel',
      'leChooseWallet',
      'leSide',
      {
        label: this.text('leSchedule') + ' · ' + this.text(schedules[d.schedule]),
        value: 'leSchedule',
      },
      {
        label: this.text('lePriceMode') + ' · ' + this.text(entryRelations[d.entryRelation]),
        value: 'leEntry',
      },
      ...fields.map(([key, label]) => ({ label: this.text(label) + ': ' + d[key], value: key })),
      ...(d.schedule === 'vwap'
        ? ['leProfileCapture', ...(d.profile ? ['leProfileWeights'] : [])]
        : []),
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
        if (value === 'leSchedule')
          return this.menu(
            this.text(value),
            Object.values(schedules),
            (schedule) => {
              d.schedule = Object.keys(schedules).find((key) => schedules[key] === schedule);
              delete d.profile;
              return this.editor(id);
            },
            this.text('leFixedScope'),
            () => this.editor(id),
          );
        if (value === 'leProfileWeights') return this.profile(d.profile, () => this.editor(id));
        if (value === 'leEntry')
          return this.menu(
            this.text('lePriceMode'),
            Object.entries(entryRelations).map(([value, label]) => ({
              label: this.text(label),
              value,
            })),
            (relation) => {
              d.entryRelation = relation;
              return this.editor(id);
            },
            [this.text('leEntryHint'), this.text('leExitHint')].join('\n'),
            () => this.editor(id),
          );
        if (value === 'leProfileCapture') {
          try {
            d.profile = await this.call('profile', {
              id,
              slices: Number(d.slices),
              intervalMs: Number(d.seconds) * 1000,
            });
            return this.profile(d.profile, () => this.editor(id));
          } catch (failure) {
            return this.editor(id, this.status(failure.message));
          }
        }
        if (value === 'leSave') {
          try {
            if (
              !/^\d+$/.test(d.slices) ||
              !/^\d+$/.test(d.seconds) ||
              !/^\d(?:\.\d{1,2})?$/.test(d.slippage)
            )
              throw Error(this.text('leInvalid'));
            if (d.schedule === 'vwap' && !d.profile) throw Error('EXECUTION_PROFILE_REQUIRED');
            const arrivalLimit = d.maxArrivalCostBps.trim();
            if (arrivalLimit && !/^\d{1,4}$/.test(arrivalLimit))
              throw Error('EXECUTION_ARRIVAL_LIMIT_RANGE');
            const result = await this.call('create', {
              id,
              operationId: d.operationId,
              walletId: d.walletId,
              side: d.side,
              totalInput: d.totalInput,
              ...(d.minimumTotalOutput.trim()
                ? { minimumTotalOutput: d.minimumTotalOutput.trim() }
                : {}),
              ...(arrivalLimit ? { maxArrivalCostBps: Number(arrivalLimit) } : {}),
              ...(protective
                ? {
                    protectiveExit: {
                      stopLossPrice: d.stopLossPrice.trim(),
                      ...(d.takeProfitPrice.trim() && {
                        takeProfitPrice: d.takeProfitPrice.trim(),
                      }),
                    },
                  }
                : d.entryRelation !== 'immediate' && {
                    entryTrigger: { relation: d.entryRelation, price: d.entryPrice.trim() },
                  }),
              slices: Number(d.slices),
              intervalMs: Number(d.seconds) * 1000,
              schedule: d.schedule,
              ...(d.schedule === 'vwap' ? { profileId: d.profile.id } : {}),
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
              if (value === 'slices' || value === 'seconds') delete d.profile;
              return this.editor(id);
            },
            { value: d[value], back: () => this.editor(id) },
          );
      },
      [
        this.text('leDraftHint'),
        this.text('leFeeHint'),
        this.text('leMinimumHint'),
        this.text(protective ? 'leExitHint' : 'leEntryHint'),
        d.schedule !== 'settlement' ? this.text('leFixedScope') : '',
        d.schedule === 'vwap' ? this.text('leVwapScope') : '',
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
