/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const fields = [
  ['quantity', 'nsQuantity', 'quantity', '0.001'],
  ['bidOffsetTicks', 'nsBidOffset', 'bid_offset_ticks', 0],
  ['askOffsetTicks', 'nsAskOffset', 'ask_offset_ticks', 0],
  ['repriceTicks', 'nsReprice', 'reprice_ticks', 1],
  ['refreshMs', 'nsRefreshMs', 'refresh_ms', 1000],
  ['ttlMs', 'nsTtl', 'ttl_ms', 15000],
  ['minInventory', 'nsMinInventory', 'min_inventory', '0'],
  ['maxInventory', 'nsMaxInventory', 'max_inventory', '10'],
  ['maxNotional', 'nsMaxNotional', 'max_notional', '10000'],
  ['maxFees', 'nsMaxFees', 'max_fees', '50'],
  ['maxDecisions', 'nsMaxDecisions', 'max_decisions', 1000],
];
class NativeStrategyBrowser {
  constructor(parent) {
    this.parent = parent;
  }
  text(key) {
    return this.parent.text(key);
  }
  call(action, input) {
    return this.parent.call('native.strategy.' + action, input);
  }
  menu(title, options, choose, body, back) {
    return this.parent.menu(title, options, choose, body, back);
  }
  async open(id, offset = 0) {
    const page = await this.call('list', { id, offset, limit: 20 });
    const options = [
      { label: this.text('nsBack'), value: 'back' },
      { label: this.text('nsAccount'), value: 'account' },
      { label: this.text('nsRefresh'), value: 'refresh' },
    ];
    if (page.connected === false) options.push({ label: this.text('nsConnect'), value: 'connect' });
    else
      options.push(
        { label: this.text('nsNew'), value: 'new' },
        ...page.items.map((v) => ({
          label: v.definition.name + ' · v' + v.definition.revision,
          value: v.definition.id,
        })),
      );
    if (offset) options.push({ label: this.text('nsPrevious'), value: 'previous' });
    if (page.next !== null) options.push({ label: this.text('nsNext'), value: 'next' });
    this.menu(
      this.text('nsTitle'),
      options,
      async (action) => {
        if (action === 'back') return this.parent.project(id);
        if (action === 'account') return this.parent.nativePaper(id);
        if (action === 'connect') {
          await this.parent.call('native.start');
          return this.open(id);
        }
        if (action === 'new') return this.editor(id);
        if (action === 'next' || action === 'previous')
          return this.open(id, action === 'next' ? page.next : Math.max(0, offset - 20));
        if (action === 'refresh') return this.open(id, offset);
        return this.detail(id, action);
      },
      this.text('nsScope'),
      () => this.parent.project(id),
    );
  }
  async detail(id, strategyId) {
    const version = await this.call('get', { id, strategyId }),
      d = version.definition;
    const runs = await this.call('runs', { id, strategyId, limit: 20 }),
      run = runs.items.find((r) => r.phase === 'running') || runs.items[0];
    const options = ['nsBack', 'nsRefresh', 'nsEdit', 'nsVersions'];
    if (!runs.items.some((r) => r.phase === 'running')) options.push('nsPaper', 'nsShadow');
    if (run) options.push('nsStop', 'nsDecisions');
    const body = [
      this.text('nsScope'),
      version.hash,
      run
        ? this.text('nsPinned') +
          ' v' +
          run.run.revision +
          ' · ' +
          this.text(
            run.phase === 'running'
              ? 'nsRunning'
              : run.phase === 'paused'
                ? 'nsPaused'
                : 'nsStopped',
          ) +
          '\n' +
          run.reason +
          '\n' +
          this.text('nsGross') +
          ': ' +
          run.stats.gross_filled +
          '\n' +
          this.text('nsFees') +
          ': ' +
          run.stats.fees
        : this.text('nsNoRuns'),
    ].join('\n\n');
    this.menu(
      d.name + ' · v' + d.revision,
      options.map((value) => ({ label: this.text(value), value })),
      async (action) => {
        if (action === 'nsBack') return this.open(id);
        if (action === 'nsRefresh') return this.detail(id, strategyId);
        if (action === 'nsEdit') return this.editor(id, version);
        if (action === 'nsVersions') return this.history(id, strategyId, 'versions');
        if (action === 'nsDecisions') return this.history(id, strategyId, 'decisions', run.run.id);
        if (action === 'nsStop')
          await this.call('stop', { id, runId: run.run.id, cancelOrders: true });
        else
          await this.call('start', {
            id,
            strategyId,
            revision: d.revision,
            mode: action === 'nsPaper' ? 'paper' : 'shadow',
            operationId: randomUUID(),
          });
        return this.detail(id, strategyId);
      },
      body,
      () => this.open(id),
    );
  }
  editor(id, version) {
    const values = {},
      m = version?.definition.maker,
      operationId = randomUUID();
    const steps = [
      ['name', 'nsName', version?.definition.name || 'Maker'],
      ...fields.map(([key, label, native, initial]) => [key, label, m?.[native] ?? initial]),
    ];
    const step = (index) => {
      if (index === steps.length) {
        const { name, product, ...config } = values;
        return this.call('define', {
          id,
          name,
          product,
          config,
          operationId,
          ...(version
            ? {
                strategyId: version.definition.id,
                revision: version.definition.revision + 1,
                accountId: version.definition.account,
              }
            : {}),
        }).then((result) => this.detail(id, result.definition.id));
      }
      const [key, label, initial] = steps[index];
      return this.parent.ui.input(
        this.text(label),
        (value) => {
          values[key] = typeof initial === 'number' ? Number(value) : value;
          return step(index + 1);
        },
        {
          value: String(values[key] ?? initial),
          back: () => (index ? step(index - 1) : this.open(id)),
        },
      );
    };
    this.menu(
      this.text('nsProduct'),
      ['ETH-USD', 'BTC-USD', 'SOL-USD'].map((value) => ({ label: value, value })),
      (product) => {
        values.product = product;
        return this.menu(
          this.text('nsSides'),
          ['both', 'buy', 'sell'].map((value) => ({
            label: this.text(value === 'both' ? 'nsBoth' : value === 'buy' ? 'nsBuy' : 'nsSell'),
            value,
          })),
          (sides) => {
            values.sides = sides;
            return step(0);
          },
          '',
          () => this.open(id),
        );
      },
      '',
      () => this.open(id),
    );
  }
  async history(id, strategyId, kind, runId, offset = 0) {
    const page = await this.call(kind, { id, strategyId, runId, offset, limit: 15 });
    const options = [
      { label: this.text('nsBack'), value: 'back' },
      ...page.items.map((v, index) => ({
        label:
          kind === 'versions'
            ? 'v' + v.definition.revision + ' · ' + v.definition.name
            : '#' +
              v.ordinal +
              ' · ' +
              v.intents
                .map(
                  (i) =>
                    this.text(i.side === 'buy' ? 'nsBuy' : 'nsSell') +
                    ' ' +
                    i.quantity +
                    ' @ ' +
                    i.price,
                )
                .join(' / '),
        value: index,
      })),
    ];
    if (offset) options.push({ label: this.text('nsPrevious'), value: 'previous' });
    if (page.next !== null) options.push({ label: this.text('nsNext'), value: 'next' });
    this.menu(
      this.text(kind === 'versions' ? 'nsVersions' : 'nsDecisions'),
      options,
      (value) => {
        if (value === 'back') return this.detail(id, strategyId);
        if (value === 'next' || value === 'previous')
          return this.history(
            id,
            strategyId,
            kind,
            runId,
            value === 'next' ? page.next : Math.max(0, offset - 15),
          );
        const v = page.items[value],
          body =
            kind === 'versions'
              ? v.hash
              : v.outcomes
                  .map(
                    (o) =>
                      this.text(
                        o.status === 'shadow'
                          ? 'nsShadow'
                          : o.status === 'accepted'
                            ? 'nsAccepted'
                            : 'nsRejected',
                      ) + (o.error ? ' · ' + o.error : ''),
                  )
                  .join('\n') || this.text('nsUnconfirmed');
        return this.menu(
          this.text(kind === 'versions' ? 'nsVersions' : 'nsDecisions'),
          [{ label: this.text('nsBack'), value: 'back' }],
          () => this.history(id, strategyId, kind, runId, offset),
          body,
          () => this.history(id, strategyId, kind, runId, offset),
        );
      },
      String(page.total),
      () => this.detail(id, strategyId),
    );
  }
}
module.exports = { NativeStrategyBrowser };
