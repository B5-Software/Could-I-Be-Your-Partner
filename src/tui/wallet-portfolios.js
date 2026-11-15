/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { chainLabel } = require('../shared/wallet-chain');
const { walletBudget, walletScopeValues } = require('../shared/wallet-budget');
const { tokenAmount } = require('../shared/wallet-token-format');
const { TuiWalletPeriods } = require('./wallet-periods');
class TuiWalletPortfolios {
  constructor(browser) {
    this.w = browser;
  }
  async open(offset = 0) {
    const page = await this.w.call('portfolio.list', { offset });
    this.w.menu(
      this.w.text('portfolioTitle'),
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        { label: this.w.text('portfolioCreate'), value: 'create' },
        ...page.items.map((p) => ({
          label: `${p.name} · ${chainLabel(p.chainId)} · ${this.w.text('portfolio' + p.state[0].toUpperCase() + p.state.slice(1))}`,
          value: p.id,
        })),
        ...(offset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(page.next !== null ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }] : []),
      ],
      async (value) => {
        if (value === 'back') return this.w.open();
        if (value === 'create') return this.create();
        if (value === 'previous') return this.open(Math.max(0, offset - 20));
        if (value === 'next') return this.open(page.next);
        return this.detail(value);
      },
      this.w.text('portfolioHint'),
      () => this.w.open(),
    );
  }
  async detail(id) {
    const [result, data] = await Promise.all([
        this.w.call('portfolio.get', { id }),
        this.w.call('list'),
      ]),
      p = result.portfolio;
    const names = new Map(data.wallets.map((w) => [w.id, w.name]));
    const rows = walletBudget({ limits: p.limits, usage: result.usage, period: result.period });
    this.w.menu(
      p.name,
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        { label: this.w.text('portfolioMembers'), value: 'members' },
        { label: this.w.text('portfolioScope'), value: 'scope' },
        { label: this.w.text('usageTitle'), value: 'usage' },
        { label: this.w.text('portfolioHoldings'), value: 'holdings' },
        ...([8453, 84532].includes(p.chainId)
          ? [{ label: this.w.text('portfolioExposure'), value: 'exposure' }]
          : []),
        ...(p.equityFloorUsdAtomic && result.state !== 'removed'
          ? [{ label: this.w.text('portfolioEquityCheck'), value: 'equity' }]
          : []),
        { label: this.w.text('portfolioRevisions'), value: 'revisions' },
        ...(result.state !== 'removed'
          ? [{ label: this.w.text('portfolioEdit'), value: 'edit' }]
          : []),
        ...(result.state !== 'removed'
          ? [
              ...(result.state === 'active'
                ? [{ label: this.w.text('portfolioPause'), value: 'pause' }]
                : [{ label: this.w.text('portfolioResume'), value: 'active' }]),
              { label: this.w.text('portfolioRemove'), value: 'removed' },
            ]
          : []),
      ],
      async (value) => {
        if (value === 'back') return this.open();
        if (value === 'usage') return this.usage(result, rows);
        if (value === 'holdings') return this.holdings(id);
        if (value === 'exposure')
          return this.exposure(id, p.chainId === 8453 ? 'base' : 'base-sepolia');
        if (value === 'equity') return this.equity(id);
        if (value === 'revisions') return this.revisions(id);
        if (value === 'edit') return this.edit(result);
        if (value === 'scope' || value === 'members')
          return this.w.menu(
            this.w.text(value === 'scope' ? 'portfolioScope' : 'portfolioMembers'),
            [{ label: this.w.text('portfolioBack'), value: 'back' }],
            () => this.detail(id),
            value === 'scope'
              ? this.w.policySummary(walletScopeValues(p.limits))
              : p.members
                  .map((m) => `${names.get(m.walletId) ?? m.walletId}\n${m.address}`)
                  .join('\n\n'),
            () => this.detail(id),
          );
        if (value === 'pause') {
          await this.w.call('portfolio.pause', { id, revision: result.revision });
          return this.detail(id);
        }
        return this.confirm(
          { operation: value, id, revision: result.revision },
          () => this.detail(id),
          p.name,
        );
      },
      chainLabel(p.chainId) +
        ' · ' +
        this.w.text('portfolio' + result.state[0].toUpperCase() + result.state.slice(1)) +
        '\n' +
        this.w.text('portfolioMembers') +
        ' · ' +
        p.members.length +
        '\n' +
        p.members
          .slice(0, 3)
          .map((m) => names.get(m.walletId) ?? m.address)
          .join(' · ') +
        '\n\n' +
        this.w.text('portfolioHint') +
        (p.equityFloorUsdAtomic && result.state !== 'removed'
          ? `\n${this.w.text('portfolioEquityFloor')} · ${tokenAmount(p.equityFloorUsdAtomic, 8)} USD`
          : '') +
        (p.allowanceCeiling && result.state !== 'removed'
          ? `\n${this.w.text('portfolioAllowanceCeiling')} · ${tokenAmount(p.allowanceCeiling.atoms, p.allowanceCeiling.decimals)} ${p.allowanceCeiling.token}`
          : ''),
      () => this.open(),
    );
  }
  async exposure(id, chain, report, offset = 0, filter = 'review') {
    const back = () => this.detail(id);
    const render = () => this.exposure(id, chain, report, offset, filter);
    const load = async (reportId, nextOffset, nextFilter) => {
      const next = await this.w.call('portfolio.allowances.get', {
        id,
        reportId,
        offset: nextOffset,
        filter: nextFilter,
        limit: 6,
      });
      return this.exposure(id, chain, next, nextOffset, nextFilter);
    };
    const scan = async (mode, blocks, token, previousReportId) => {
      const next = await this.w.call('portfolio.allowances.scan', {
        id,
        mode,
        blocks,
        token,
        previousReportId,
        filter,
        limit: 6,
      });
      return this.exposure(id, chain, next, 0, filter);
    };
    const history = async (pageOffset = 0) => {
      const page = await this.w.call('portfolio.allowances.list', {
        id,
        offset: pageOffset,
        limit: 8,
      });
      return this.w.menu(
        this.w.text('portfolioExposureHistory'),
        [
          { label: this.w.text('portfolioBack'), value: 'back' },
          ...page.items.map((row) => ({
            label: `#${row.block} · ${new Date(row.observedAt).toLocaleString()}`,
            value: row.reportId,
          })),
          ...(pageOffset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
          ...(page.next !== null
            ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }]
            : []),
        ],
        (value) => {
          if (value === 'back') return render();
          if (value === 'previous') return history(Math.max(0, pageOffset - 8));
          if (value === 'next') return history(page.next);
          return load(value, 0, filter);
        },
        page.items.length ? '' : this.w.text('portfolioEmpty'),
        render,
      );
    };
    const coverage = report?.coverage;
    const scopedToken = coverage?.tokens.length === 1 ? coverage.tokens[0] : undefined;
    const amount = (v) => v.amount ?? v.atomic ?? '—';
    const body = report
      ? [
          `${this.w.text('assetBlock')} #${report.block} · ${new Date(report.observedAt).toLocaleString()}`,
          coverage.scanIncomplete || coverage.unreadablePairs || coverage.unknownBalances
            ? this.w.text('portfolioExposurePartial')
            : '',
          `${this.w.text('portfolioExposureCoverage')} · ${coverage.scannedRanges.length}\n${
            coverage.scannedRanges
              .slice(-4)
              .map(({ fromBlock, toBlock }) => `#${fromBlock}–#${toBlock}`)
              .join(', ') || '—'
          }${coverage.scannedRanges.length > 4 ? '…' : ''}`,
          ...report.totals.map(
            (asset) =>
              `${asset.symbol || asset.token} · ${this.w.text('portfolioExposureMeasured')} ${amount(asset.measured)} / ${this.w.text('portfolioHoldings')} ${amount(asset.balance)}\n${this.w.text('portfolioExposurePotential')} ${amount(asset.includingPermit2)}`,
          ),
          this.w.text('portfolioExposurePotentialHint'),
          this.w.text('portfolioExposureHint'),
        ]
      : [this.w.text('portfolioExposureHint')];
    const rowLabel = (row) => {
      const status = this.w.text(
        'portfolioExposure' + row.status[0].toUpperCase() + row.status.slice(1),
      );
      return `${row.walletName} · ${row.symbol || row.token} · ${row.spender} · ${status} · ${amount(row.spendable)}`;
    };
    return this.w.menu(
      this.w.text('portfolioExposure'),
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        { label: this.w.text('portfolioExposureRecent'), value: 'recent' },
        ...(report
          ? [
              ...(coverage.nextEndBlock !== null
                ? [{ label: this.w.text('portfolioExposureOlder'), value: 'older' }]
                : []),
              { label: this.w.text('portfolioExposureRefresh'), value: 'refresh' },
              { label: this.w.text('portfolioExposureFresh'), value: 'fresh' },
              {
                label: this.w.text(
                  filter === 'review' ? 'portfolioExposureAll' : 'portfolioExposureReviewed',
                ),
                value: 'filter',
              },
            ]
          : []),
        { label: this.w.text('portfolioExposureHistory'), value: 'history' },
        { label: this.w.text('portfolioMonitor'), value: 'monitor' },
        { label: this.w.text('portfolioAllowanceCeiling'), value: 'ceiling' },
        ...(report?.items ?? []).map((row) => ({ label: rowLabel(row), value: row })),
        ...(offset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(report?.next != null
          ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }]
          : []),
      ],
      async (value) => {
        if (value === 'back') return back();
        if (value === 'history') return history();
        if (value === 'monitor') return this.allowanceMonitor(id, chain, report, render);
        if (value === 'ceiling') return this.allowanceCeiling(id, report, render);
        if (value === 'filter')
          return load(report.reportId, 0, filter === 'review' ? 'all' : 'review');
        if (value === 'next' || value === 'previous')
          return load(
            report.reportId,
            value === 'next' ? report.next : Math.max(0, offset - 6),
            filter,
          );
        if (value === 'refresh') return scan('refresh', undefined, scopedToken, report.reportId);
        if (value === 'older')
          return this.w.input(
            this.w.text('portfolioExposureBlocks'),
            (count) => scan('older', Number(count.trim()), scopedToken, report.reportId),
            { value: '1000', back: render },
          );
        if (value === 'recent' || value === 'fresh')
          return this.w.input(
            this.w.text('portfolioExposureBlocks'),
            (count) =>
              this.w.input(
                this.w.text('portfolioExposureToken'),
                (input) => {
                  const token = input.trim() || undefined;
                  const previous =
                    value === 'recent' && token?.toLowerCase() === scopedToken?.toLowerCase()
                      ? report?.reportId
                      : undefined;
                  return scan('recent', Number(count.trim()), token, previous);
                },
                { value: scopedToken || '', back: render },
              ),
            { value: '1000', back: render },
          );
        return this.reviewExposureRow(value, chain, render);
      },
      body.filter(Boolean).join('\n\n'),
      back,
    );
  }
  async reviewExposureRow(pair, chain, back) {
    const { wallets } = await this.w.call('list');
    const wallet = wallets.find((row) => row.id === pair.walletId);
    if (!wallet) throw Error('WALLET_NOT_FOUND');
    return this.w.allowances(wallet, { ...pair, chain }, back);
  }
  async allowanceCeiling(id, baseline, back) {
    const snapshot = await this.w.call('portfolio.get', { id });
    const rule = snapshot.portfolio.allowanceCeiling;
    const canSet =
      snapshot.state !== 'removed' &&
      baseline?.coverage.mode === 'recent' &&
      !baseline.coverage.scanIncomplete &&
      !baseline.coverage.unknownBalances &&
      !baseline.coverage.unreadablePairs;
    const assets = canSet
      ? baseline.totals.filter((asset) => Number.isInteger(asset.decimals))
      : [];
    const open = () => this.allowanceCeiling(id, baseline, back);
    const confirm = (ceiling, text) =>
      this.confirm(
        { id, revision: snapshot.revision, operation: 'allowance-ceiling', ceiling },
        open,
        text,
      );
    return this.w.menu(
      this.w.text('portfolioAllowanceCeiling'),
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        ...assets.map(({ token, symbol }) => ({
          label: `${symbol || token} · ${this.w.text('portfolioAllowanceCeilingAmount')}`,
          value: token,
        })),
        ...(rule && snapshot.state !== 'removed'
          ? [{ label: this.w.text('portfolioAllowanceCeilingRemove'), value: 'remove' }]
          : []),
      ],
      (token) => {
        if (token === 'back') return back();
        if (token === 'remove')
          return confirm(null, this.w.text('portfolioAllowanceCeilingRemove'));
        return this.w.input(
          this.w.text('portfolioAllowanceCeilingAmount'),
          (value) => {
            const amount = value.trim();
            return confirm(
              { reportId: baseline.reportId, token, amount },
              `${this.w.text('portfolioAllowanceCeiling')} · ${amount} · ${token} · #${baseline.block}`,
            );
          },
          {
            value: rule?.token === token ? tokenAmount(rule.atoms, rule.decimals) : '',
            back: open,
          },
        );
      },
      [
        this.w.text('portfolioAllowanceCeilingHint'),
        rule ? `${tokenAmount(rule.atoms, rule.decimals)} ${rule.token}` : '',
        assets.length
          ? `${this.w.text('portfolioMonitorBaseline')} #${baseline.block}`
          : this.w.text('portfolioMonitorNeedsBaseline'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      back,
    );
  }
  async allowanceMonitor(id, chain, baseline, back, offset = 0) {
    const state = await this.w.call('portfolio.allowanceMonitor.get', { id, offset, limit: 4 });
    const open = (next = 0) => this.allowanceMonitor(id, chain, baseline, back, next);
    const canStart =
      baseline?.coverage.mode === 'recent' &&
      !baseline.coverage.scanIncomplete &&
      !baseline.coverage.unreadablePairs &&
      !baseline.coverage.unknownBalances;
    const named = (name, value) => ({ label: this.w.text(name), value });
    const chooseInterval = () =>
      this.w.menu(
        this.w.text('portfolioMonitorInterval'),
        [
          named('portfolioBack', 'back'),
          ...[60, 300, 900].map((seconds) => ({ label: String(seconds / 60), value: seconds })),
        ],
        async (seconds) => {
          if (seconds === 'back') return open(offset);
          await this.w.call('portfolio.allowanceMonitor.start', {
            id,
            reportId: baseline.reportId,
            expectedRevision: state.revision,
            intervalSeconds: seconds,
          });
          return open();
        },
        `${this.w.text('portfolioMonitorBaseline')} #${baseline.block}`,
        () => open(offset),
      );
    const textAmount = (amount) => amount.amount ?? amount.atomic ?? '—';
    const notice = (entry) =>
      this.w.menu(
        this.w.text('portfolioMonitorHistory'),
        [
          named('portfolioBack', 'back'),
          ...entry.pairs.map((pair) => ({
            label: `${pair.walletName} · ${pair.spender}`,
            value: pair,
          })),
        ],
        (option) =>
          option === 'back'
            ? open(offset)
            : this.reviewExposureRow(option, chain, () => notice(entry)),
        [
          `#${entry.block} · ${entry.blockHash}`,
          `${this.w.text('portfolioMonitorPairs')} ${entry.pairCount} · ${this.w.text('portfolioMonitorIncreases')} ${entry.increaseCount}`,
          ...entry.increases.map(
            (row) =>
              `${row.symbol || row.token} · ${this.w.text(row.metric === 'measured' ? 'portfolioExposureMeasured' : 'portfolioExposurePotential')} ${textAmount(row.before)} → ${textAmount(row.after)}`,
          ),
        ].join('\n'),
        () => open(offset),
      );
    return this.w.menu(
      this.w.text('portfolioMonitor'),
      [
        named('portfolioBack', 'back'),
        named('assetRefresh', 'refresh'),
        ...(canStart ? [named('portfolioMonitorStart', 'start')] : []),
        ...(state.enabled ? [named('portfolioMonitorStop', 'stop')] : []),
        ...(state.lastBlock ? [named('portfolioMonitorEvidence', 'evidence')] : []),
        ...state.notices.map((entry) => ({
          label: `#${entry.block} · ${new Date(entry.observedAt).toLocaleString()}`,
          value: entry,
        })),
        ...(offset ? [named('portfolioPrevious', 'previous')] : []),
        ...(state.next !== null ? [named('portfolioPageNext', 'next')] : []),
      ],
      async (value) => {
        if (value === 'back') return back();
        if (value === 'refresh') return open(offset);
        if (value === 'start') return chooseInterval();
        if (value === 'stop') {
          await this.w.call('portfolio.allowanceMonitor.stop', {
            id,
            expectedRevision: state.revision,
          });
          return open(offset);
        }
        if (value === 'evidence') return this.monitorEvidence(id, chain, () => open(offset));
        if (value === 'previous') return open(Math.max(0, offset - 4));
        if (value === 'next') return open(state.next);
        return notice(value);
      },
      [
        this.w.text('portfolioMonitor_' + state.status),
        state.lastBlock ? `${this.w.text('assetBlock')} #${state.lastBlock}` : '',
        state.nextAt
          ? `${this.w.text('portfolioMonitorNextCheck')} · ${new Date(state.nextAt).toLocaleString()}`
          : '',
        state.error ? this.w.status(state.error) : '',
        this.w.text(canStart ? 'portfolioMonitorHint' : 'portfolioMonitorNeedsBaseline'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      back,
    );
  }
  async monitorEvidence(id, chain, back, offset = 0, filter = 'review') {
    const { report } = await this.w.call('portfolio.allowanceMonitor.get', {
      id,
      includeReport: true,
      offset,
      filter,
      limit: 6,
    });
    if (!report) return back();
    const open = (nextOffset = offset, nextFilter = filter) =>
      this.monitorEvidence(id, chain, back, nextOffset, nextFilter);
    const named = (key, value) => ({ label: this.w.text(key), value });
    const amount = (v) => v.amount ?? v.atomic ?? '—';
    const range = report.coverage.monitoredRange;
    return this.w.menu(
      this.w.text('portfolioMonitorEvidence'),
      [
        named('portfolioBack', 'back'),
        named(filter === 'review' ? 'portfolioExposureAll' : 'portfolioExposureReviewed', 'filter'),
        ...report.items.map((row) => ({
          label: `${row.walletName} · ${row.spender} · ${amount(row.spendable)} ${row.symbol ?? ''}`,
          value: row,
        })),
        ...(offset ? [named('portfolioPrevious', 'previous')] : []),
        ...(report.next !== null ? [named('portfolioPageNext', 'next')] : []),
      ],
      (value) => {
        if (value === 'back') return back();
        if (value === 'filter') return open(0, filter === 'review' ? 'all' : 'review');
        if (value === 'previous') return open(Math.max(0, offset - 6));
        if (value === 'next') return open(report.next);
        return this.reviewExposureRow(value, chain, open);
      },
      [
        `#${report.block} · ${report.blockHash}`,
        range
          ? `${this.w.text('portfolioExposureCoverage')} · #${range.fromBlock}–#${range.toBlock}`
          : '',
        ...report.totals.map(
          (asset) =>
            `${asset.symbol || asset.token} · ${this.w.text('portfolioExposureMeasured')} ${amount(asset.measured)}\n${this.w.text('portfolioExposurePotential')} ${amount(asset.includingPermit2)}`,
        ),
      ]
        .filter(Boolean)
        .join('\n\n'),
      back,
    );
  }
  async equity(id) {
    const back = () => this.detail(id);
    const result = await this.w.call('portfolio.equity', { id });
    const body = result.error
      ? this.w.status(result.error)
      : result.status === 'disabled'
        ? this.w.text('portfolioEquityDisabled')
        : `${this.w.text(result.status === 'below' ? 'portfolioEquityBelow' : 'portfolioEquitySatisfied')}\n${this.w.text('portfolioEquityAvailable')} · ${result.availableUsd} USD\n${this.w.text('portfolioEquityFloor')} · ${result.floorUsd} USD\n#${result.block} · ${result.blockHash}`;
    return this.w.menu(
      this.w.text('portfolioEquityCheck'),
      [
        { label: this.w.text('back'), value: 'back' },
        { label: this.w.text('assetRefresh'), value: 'refresh' },
      ],
      (value) => (value === 'back' ? back() : this.equity(id)),
      `${body}\n\n${this.w.text('portfolioEquityHelp')}`,
      back,
    );
  }
  async holdings(id, snapshot, memberId, offset = 0, withValuation = false) {
    snapshot ??= await this.w.call('portfolio.holdings', {
      id,
      ...(withValuation ? { valuation: true } : {}),
    });
    const member = memberId ? snapshot.members.find((value) => value.walletId === memberId) : null;
    const capital = member?.capital ?? snapshot.capital;
    const rows = member ? member.assets : snapshot.assets;
    const render = () => this.holdings(id, snapshot, memberId, offset);
    const showMembers = () =>
      this.w.menu(
        this.w.text('portfolioHoldingsMembers'),
        [
          { label: this.w.text('portfolioBack'), value: null },
          ...snapshot.members.map((m) => ({
            label: `${m.name} · ${m.address}`,
            value: m.walletId,
          })),
        ],
        (value) => (value ? this.holdings(id, snapshot, value) : render()),
        '',
        render,
      );
    return this.w.menu(
      this.w.text('portfolioHoldings'),
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        { label: this.w.text('assetRefresh'), value: 'refresh' },
        { label: this.w.text('portfolioHoldingsMembers'), value: 'members' },
        ...(!snapshot.valuation
          ? [{ label: this.w.text('portfolioValuationRead'), value: 'valuation' }]
          : [{ label: this.w.text('portfolioValuationSources'), value: 'sources' }]),
        ...(offset > 0 ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(offset + 6 < rows.length
          ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }]
          : []),
      ],
      (value) => {
        if (value === 'back') return member ? this.holdings(id, snapshot) : this.detail(id);
        if (value === 'members') return showMembers();
        if (value === 'valuation') return this.holdings(id, undefined, memberId, 0, true);
        if (value === 'sources') return this.valuationSources(snapshot, render);
        if (value === 'refresh')
          return this.holdings(id, undefined, memberId, 0, !!snapshot.valuation);
        return this.holdings(id, snapshot, memberId, offset + (value === 'next' ? 6 : -6));
      },
      [
        `${snapshot.name} · ${snapshot.network} · ${this.w.text('assetBlock')} #${snapshot.block}`,
        member ? `${member.name}\n${member.address}` : '',
        snapshot.complete ? '' : this.w.text('portfolioHoldingsPartial'),
        ...(capital
          ? [
              this.w.text('portfolioCapitalPending') +
                ' · ' +
                capital.pendingCount +
                ' · ' +
                this.w.text('portfolioCapitalApprovals') +
                ' · ' +
                capital.approvalCount,
              this.w.text('portfolioCapitalHint'),
              capital.unknownCount ? this.w.text('portfolioCapitalUnknown') : '',
            ]
          : []),
        ...(snapshot.valuation
          ? [
              this.w.text('portfolioValuation') +
                ' · ' +
                this.referenceValue(member?.valuation ?? snapshot.valuation),
              this.w.text('portfolioValuationHint'),
            ]
          : []),
        ...rows
          .slice(offset, offset + 6)
          .map((row) =>
            [
              `${row.symbol ?? this.w.text('assetUnknown')} · ${row.complete === false || row.error ? this.w.text('assetFailed') : (row.amount ?? `${row.amountAtomic} ${this.w.text('assetAtomic')}`)}`,
              row.address,
              row.complete === false
                ? `${this.w.text('portfolioHoldingsKnown')} ${row.knownAmount == null ? `${row.knownAmountAtomic} ${this.w.text('assetAtomic')}` : `${row.knownAmount} ${row.symbol ?? ''}`}`
                : '',
              row.valuation ? this.referenceValue(row.valuation) : '',
              row.valuation?.error ? this.w.status(row.valuation.error) : '',
              row.capital
                ? `${this.w.text('portfolioCapitalReserved')} · ${row.capital.reserved ?? row.capital.reservedAtomic + ' ' + this.w.text('assetAtomic')}\n${this.w.text('portfolioCapitalAvailable')} · ${row.capital.complete ? (row.capital.available ?? row.capital.availableAtomic + ' ' + this.w.text('assetAtomic')) : this.w.text('portfolioCapitalUnavailable')}`
                : '',
              row.capital?.shortfallAtomic && row.capital.shortfallAtomic !== '0'
                ? this.w.text('portfolioCapitalShortfall')
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
      ]
        .filter(Boolean)
        .join('\n\n'),
      () => (member ? this.holdings(id, snapshot) : this.detail(id)),
    );
  }
  referenceValue(value) {
    return value.complete
      ? `${value.value} USD`
      : `${this.w.text('portfolioValuationPartial')} · ${value.knownValue} USD`;
  }
  valuationSources(snapshot, back) {
    const value = snapshot.valuation;
    const sequencer =
      value.sequencer.status === 'up'
        ? this.w.text('portfolioValuationUp')
        : this.w.status(value.sequencer.error ?? 'WALLET_PRICE_UNAVAILABLE');
    return this.w.menu(
      this.w.text('portfolioValuationSources'),
      [{ label: this.w.text('portfolioBack'), value: 'back' }],
      back,
      [
        `${snapshot.network} · ${this.w.text('assetBlock')} #${snapshot.block}`,
        `${this.w.text('portfolioValuationSequencer')} · ${sequencer}`,
        ...Object.values(value.prices).map((feed) =>
          [
            `${feed.pair} · ${feed.status === 'available' ? feed.price + ' USD' : this.w.status(feed.error ?? 'WALLET_PRICE_UNAVAILABLE')}`,
            feed.updatedAt
              ? `${new Date(feed.updatedAt * 1000).toLocaleString()} · ${this.w.text('portfolioValuationAge')} ${feed.ageSeconds} s`
              : '',
            feed.address,
            feed.stablecoinCapped ? this.w.text('portfolioValuationCapped') : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ].join('\n\n'),
      back,
    );
  }
  usage(snapshot, rows, offset = 0) {
    if (snapshot.period)
      return new TuiWalletPeriods(this.w).budget(
        { limits: snapshot.portfolio.limits, usage: snapshot.usage, period: snapshot.period },
        () => this.detail(snapshot.portfolio.id),
        offset,
      );
    this.w.menu(
      this.w.text('usageTitle'),
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        ...(offset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(offset + 4 < rows.length
          ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }]
          : []),
      ],
      (value) =>
        value === 'back'
          ? this.detail(snapshot.portfolio.id)
          : this.usage(snapshot, rows, Math.max(0, offset + (value === 'next' ? 4 : -4))),
      rows
        .slice(offset, offset + 4)
        .map(
          (r) =>
            `${this.w.text(r.label)} · ${r.asset}\n${r.usedText}${r.breakdown ? '' : ' / ' + (r.limitText ?? this.w.text('usageUnlimited'))}`,
        )
        .join('\n\n'),
      () => this.detail(snapshot.portfolio.id),
    );
  }
  edit(snapshot) {
    const p = snapshot.portfolio,
      draft = {
        operation: 'edit',
        id: p.id,
        revision: snapshot.revision,
        name: p.name,
        maxFeeEth: tokenAmount(p.maxFeeWei, 18),
        ...(p.chainId === 8453 && {
          equityFloorUsd: p.equityFloorUsdAtomic ? tokenAmount(p.equityFloorUsdAtomic, 8) : '',
        }),
        limits: walletScopeValues(p.limits),
      };
    const back = () => this.detail(p.id);
    const show = () =>
      this.w.menu(
        this.w.text('portfolioEdit'),
        [
          { label: this.w.text('back'), value: 'back' },
          { label: this.w.text('portfolioName') + ' · ' + draft.name, value: 'name' },
          { label: this.w.text('portfolioFee') + ' · ' + draft.maxFeeEth, value: 'fee' },
          ...(p.chainId === 8453
            ? [
                {
                  label: `${this.w.text('portfolioEquityFloor')} · ${draft.equityFloorUsd || this.w.text('portfolioEquityDisabled')}`,
                  value: 'equity',
                },
              ]
            : []),
          { label: this.w.text('portfolioHours'), value: 'expiry' },
          { label: this.w.text('portfolioScope'), value: 'scope' },
          { label: this.w.text('portfolioReview'), value: 'review' },
        ],
        (value) => {
          if (value === 'back') return back();
          if (value === 'equity')
            return this.w.input(
              this.w.text('portfolioEquityFloor'),
              (text) => {
                draft.equityFloorUsd = text.trim();
                return show();
              },
              { value: draft.equityFloorUsd, back: show },
            );
          if (value === 'review')
            return this.confirm(
              draft,
              back,
              this.w.text('portfolioEditHint') +
                '\n\n' +
                draft.name +
                '\n' +
                (chainLabel(p.chainId) + ' · ' + p.chainId) +
                '\n' +
                p.members.map((m) => m.address).join('\n') +
                '\n' +
                this.w.text('portfolioFee') +
                ' · ' +
                draft.maxFeeEth +
                '\n' +
                this.w.text('portfolioHours') +
                ' · ' +
                (draft.hours === undefined
                  ? this.w.text('portfolioKeepExpiry') +
                    ' · ' +
                    (p.expiresAt
                      ? new Date(p.expiresAt).toLocaleString()
                      : this.w.text('portfolioForever'))
                  : draft.hours === 0
                    ? this.w.text('portfolioForever')
                    : String(draft.hours)) +
                '\n\n' +
                this.w.policySummary(draft.limits),
            );
          if (value === 'scope')
            return this.w.policyScope(
              { policy: { limits: draft.limits } },
              (limits) => {
                draft.limits = limits;
                return show();
              },
              { periodLocked: !!p.limits.period },
            );
          if (value === 'expiry')
            return this.w.menu(
              this.w.text('portfolioHours'),
              [
                { label: this.w.text('portfolioKeepExpiry'), value: -1 },
                ...[24, 1, 0].map((h, i) => ({
                  label: this.w.text(['portfolioDay', 'portfolioHour', 'portfolioForever'][i]),
                  value: h,
                })),
              ],
              (hours) => {
                if (hours === -1) delete draft.hours;
                else draft.hours = hours;
                return show();
              },
              '',
              show,
            );
          return this.w.input(
            this.w.text(value === 'name' ? 'portfolioName' : 'portfolioFee'),
            (text) => {
              draft[value === 'name' ? 'name' : 'maxFeeEth'] = text.trim();
              return show();
            },
            { value: value === 'name' ? draft.name : draft.maxFeeEth, back: show },
          );
        },
        this.w.text('portfolioEditHint'),
        back,
      );
    show();
  }
  async revisions(id, offset = 0) {
    const page = await this.w.call('portfolio.revisions', { id, offset }),
      back = () => this.detail(id);
    this.w.menu(
      this.w.text('portfolioRevisions'),
      [
        { label: this.w.text('back'), value: 'back' },
        ...page.items.map((r) => ({
          label: `${r.revision} · ${r.name} · ${r.kind === 'baseline' ? this.w.text('portfolioBaseline') : new Date(r.changedAt).toLocaleString()}`,
          value: r.revision,
        })),
        ...(offset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(page.next !== null ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }] : []),
      ],
      async (value) => {
        if (value === 'back') return back();
        if (value === 'previous') return this.revisions(id, Math.max(0, offset - 20));
        if (value === 'next') return this.revisions(id, page.next);
        const r = await this.w.call('portfolio.revision', { id, revision: value });
        return this.w.menu(
          r.portfolio.name + ' · ' + this.w.text('portfolioRevision') + ' ' + value,
          [{ label: this.w.text('back'), value: 'back' }],
          () => this.revisions(id, offset),
          this.w.policySummary(walletScopeValues(r.portfolio.limits)),
          () => this.revisions(id, offset),
        );
      },
      '',
      back,
    );
  }
  async create() {
    const data = await this.w.call('list');
    const { items: networks } = await this.w.call('network.list');
    const wallets = data.wallets.filter((wallet) => wallet.kind !== 'watch');
    if (!wallets.length)
      return this.w.menu(
        this.w.text('portfolioTitle'),
        [{ label: this.w.text('portfolioBack'), value: 'back' }],
        () => this.open(),
        this.w.text('portfolioNoWallet'),
      );
    const draft = { operation: 'create', walletIds: [], hours: 24, maxFeeEth: '0.01' };
    this.w.input(
      this.w.text('portfolioName'),
      (name) => {
        draft.name = name;
        this.w.menu(
          this.w.text('chainId'),
          [
            ...networks
              .filter((p) => !p.archived && p.capabilities.signType2)
              .map((p) => ({ label: `${p.name} · ${p.id}`, value: p.id })),
          ],
          (chainId) => {
            draft.chainId = chainId;
            members();
          },
        );
      },
      { back: () => this.open() },
    );
    const members = () =>
      this.w.menu(
        this.w.text('portfolioMembers'),
        [
          { label: this.w.text('portfolioBack'), value: 'back' },
          { label: this.w.text('portfolioNext'), value: 'next' },
          ...wallets.map((w) => ({
            label: `${draft.walletIds.includes(w.id) ? '●' : '○'} ${w.name} · ${w.address}`,
            value: w.id,
          })),
        ],
        (value) => {
          if (value === 'back') return this.open();
          if (value === 'next') {
            if (!draft.walletIds.length) return members();
            return this.w.menu(
              this.w.text('portfolioHours'),
              [24, 1, 0].map((value, i) => ({
                label: this.w.text(['portfolioDay', 'portfolioHour', 'portfolioForever'][i]),
                value,
              })),
              (hours) => {
                draft.hours = hours;
                this.w.input(
                  this.w.text('portfolioFee'),
                  (fee) => {
                    draft.maxFeeEth = fee;
                    this.w.policyScope({ policy: {} }, (limits) => {
                      draft.limits = limits;
                      this.confirm(
                        draft,
                        () => this.open(),
                        draft.name +
                          '\n' +
                          draft.walletIds
                            .map((id) => wallets.find((w) => w.id === id).name)
                            .join(' · ') +
                          '\n' +
                          this.w.policySummary(limits),
                      );
                    });
                  },
                  { value: '0.01', back: members },
                );
              },
            );
          }
          if (draft.walletIds.includes(value))
            draft.walletIds = draft.walletIds.filter((id) => id !== value);
          else if (draft.walletIds.length < 16) draft.walletIds.push(value);
          return members();
        },
        this.w.text('portfolioMemberHint'),
        () => this.open(),
      );
  }
  confirm(input, back, summary) {
    const configureEquity = input.operation === 'create' && input.chainId === 8453;
    this.w.menu(
      this.w.text('portfolioReview'),
      [
        { label: this.w.text('portfolioCancel'), value: false },
        { label: this.w.text('portfolioReview'), value: true },
        ...(configureEquity
          ? [{ label: this.w.text('portfolioEquityFloor'), value: 'equity' }]
          : []),
      ],
      async (ready) => {
        if (!ready) return back();
        if (ready === 'equity')
          return this.w.input(
            this.w.text('portfolioEquityFloor'),
            (text) => this.confirm({ ...input, equityFloorUsd: text.trim() }, back, summary),
            { value: input.equityFloorUsd || '', back: () => this.confirm(input, back, summary) },
          );
        const challenge = await this.w.call('portfolio.challenge', input);
        this.w.input(
          this.w.text('portfolioAck'),
          async (ack) => {
            await this.w.call('portfolio.confirm', {
              challengeId: challenge.id,
              ack,
              confirmed: true,
            });
            return back();
          },
          { back },
        );
      },
      this.w.text('portfolioWarning') +
        '\n\n' +
        summary +
        (input.equityFloorUsd !== undefined
          ? `\n\n${this.w.text('portfolioEquityFloor')} · ${input.equityFloorUsd || this.w.text('portfolioEquityDisabled')}\n${this.w.text('portfolioEquityHelp')}`
          : ''),
      back,
    );
  }
  async recover() {
    const { wallets } = await this.w.call('list');
    const blocked = wallets.filter((w) => w.portfolioBlocked).slice(0, 16);
    this.confirm(
      { operation: 'recover', walletIds: blocked.map((w) => w.id) },
      () => this.w.open(),
      this.w.text('portfolioRecoverHint') +
        '\n' +
        blocked.map((w) => w.name + ' · ' + w.address).join('\n'),
    );
  }
}
module.exports = { TuiWalletPortfolios };
