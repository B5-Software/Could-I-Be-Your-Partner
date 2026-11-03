/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { walletBudget, walletScopeValues } = require('../shared/wallet-budget');
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
          label: `${p.name} · ${p.chainId === 8453 ? 'Base' : 'Base Sepolia'} · ${this.w.text('portfolio' + p.state[0].toUpperCase() + p.state.slice(1))}`,
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
      (p.chainId === 8453 ? 'Base' : 'Base Sepolia') +
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
        this.w.text('portfolioHint'),
      () => this.open(),
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
        maxFeeEth: require('../shared/wallet-token-format').tokenAmount(p.maxFeeWei, 18),
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
          { label: this.w.text('portfolioHours'), value: 'expiry' },
          { label: this.w.text('portfolioScope'), value: 'scope' },
          { label: this.w.text('portfolioReview'), value: 'review' },
        ],
        (value) => {
          if (value === 'back') return back();
          if (value === 'review')
            return this.confirm(
              draft,
              back,
              this.w.text('portfolioEditHint') +
                '\n\n' +
                draft.name +
                '\n' +
                (p.chainId === 8453 ? 'Base · 8453' : 'Base Sepolia · 84532') +
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
    const { wallets } = await this.w.call('list');
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
            { label: 'Base · 8453', value: 8453 },
            { label: 'Base Sepolia · 84532', value: 84532 },
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
    this.w.menu(
      this.w.text('portfolioReview'),
      [
        { label: this.w.text('portfolioCancel'), value: false },
        { label: this.w.text('portfolioReview'), value: true },
      ],
      async (ready) => {
        if (!ready) return back();
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
      this.w.text('portfolioWarning') + '\n\n' + summary,
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
