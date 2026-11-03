/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { walletBudget, walletScopeValues } = require('../shared/wallet-budget');
const { getLanguage } = require('./text');
const { TuiWalletPeriods } = require('./wallet-periods');
class TuiWalletAgentScopes {
  constructor(browser) {
    this.w = browser;
  }
  async open(offset = 0) {
    const p = await this.w.call('scope.list', { offset });
    this.w.menu(
      this.w.text('agentScopesTitle'),
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        ...p.items.map((s) => ({
          label: `${s.label} · ${s.chainId === 8453 ? 'Base' : 'Base Sepolia'} · ${this.w.text(s.state === 'active' ? 'portfolioActive' : 'portfolioPaused')}`,
          value: s.id,
        })),
        ...(offset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(p.next !== null ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }] : []),
      ],
      (v) =>
        v === 'back'
          ? this.w.open()
          : v === 'previous'
            ? this.open(Math.max(0, offset - 20))
            : v === 'next'
              ? this.open(p.next)
              : this.detail(v),
      this.w.text('agentScopesHint'),
      () => this.w.open(),
    );
  }
  async detail(id) {
    const s = await this.w.call('scope.get', { id }),
      p = s.scope;
    this.w.menu(
      p.label,
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        { label: this.w.text('portfolioScope'), value: 'scope' },
        { label: this.w.text('usageTitle'), value: 'usage' },
        ...(p.parentId ? [{ label: this.w.text('agentScopesAncestor'), value: 'parent' }] : []),
        {
          label: this.w.text(s.state === 'active' ? 'agentScopesPause' : 'agentScopesResume'),
          value: s.state === 'active' ? 'pause' : 'active',
        },
        ...(s.locallyBlocked
          ? [{ label: this.w.text('agentScopesRecover'), value: 'recover' }]
          : []),
      ],
      async (v) => {
        if (v === 'back') return this.open();
        if (v === 'parent') return this.detail(p.parentId);
        if (v === 'scope')
          return this.w.menu(
            this.w.text('portfolioScope'),
            [{ label: this.w.text('portfolioBack'), value: 'back' }],
            () => this.detail(id),
            this.w.policySummary(walletScopeValues(p.limits)),
            () => this.detail(id),
          );
        if (v === 'usage') return this.usage(s);
        if (v === 'pause') {
          await this.w.call('scope.pause', { id, revision: s.revision });
          return this.detail(id);
        }
        return this.confirm(s, v);
      },
      `${this.w.text('agentScopesSubject')}: ${p.subject}\n${this.w.text(s.ready && !s.locallyBlocked ? 'agentScopesReady' : 'agentScopesRestricted')}${s.reason ? ' · ' + this.w.status(s.reason) : ''}\n${this.w.text('agentScopesWallets')}: ${p.walletIds.join(' · ') || '—'}\n${this.w.text('agentScopesExpiry')}: ${p.expiresAt ? new Date(p.expiresAt).toLocaleString(getLanguage() === 'zh' ? 'zh-CN' : getLanguage()) : this.w.text('agentScopesNoExpiry')}\n\n${this.w.text('agentScopesHint')}`,
      () => this.open(),
    );
  }
  usage(s, offset = 0) {
    if (s.period)
      return new TuiWalletPeriods(this.w).budget(
        { limits: s.scope.limits, usage: s.usage, period: s.period },
        () => this.detail(s.scope.id),
        offset,
      );
    const rows = walletBudget({ limits: s.scope.limits, usage: s.usage });
    this.w.menu(
      this.w.text('usageTitle'),
      [
        { label: this.w.text('portfolioBack'), value: 'back' },
        ...(offset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(offset + 4 < rows.length
          ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }]
          : []),
      ],
      (v) =>
        v === 'back'
          ? this.detail(s.scope.id)
          : this.usage(s, Math.max(0, offset + (v === 'next' ? 4 : -4))),
      rows
        .slice(offset, offset + 4)
        .map(
          (r) =>
            `${this.w.text(r.label)} · ${r.asset}\n${r.usedText}${r.breakdown ? '' : ' / ' + (r.limitText ?? this.w.text('usageUnlimited'))}`,
        )
        .join('\n\n'),
      () => this.detail(s.scope.id),
    );
  }
  confirm(s, kind) {
    const back = () => this.detail(s.scope.id);
    this.w.menu(
      this.w.text('agentScopesConfirm'),
      [
        { label: this.w.text('portfolioCancel'), value: false },
        { label: this.w.text('portfolioReview'), value: true },
      ],
      async (ready) => {
        if (!ready) return back();
        const c = await this.w.call('scope.challenge', {
          id: s.scope.id,
          revision: s.revision,
          kind,
        });
        this.w.input(
          this.w.text('agentScopesAck'),
          async (ack) => {
            await this.w.call('scope.confirm', { challengeId: c.id, ack, confirmed: true });
            return back();
          },
          { back },
        );
      },
      this.w.text('agentScopesReview') + '\n\n' + s.scope.label + ' · ' + s.scope.subject,
      back,
    );
  }
}
module.exports = { TuiWalletAgentScopes };
