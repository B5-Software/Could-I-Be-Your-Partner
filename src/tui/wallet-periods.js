/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { walletBudget } = require('../shared/wallet-budget');
const { getLanguage } = require('./text');
const date = (time) =>
  new Date(time).toLocaleString(getLanguage() === 'zh' ? 'zh-CN' : getLanguage());
class TuiWalletPeriods {
  constructor(browser) {
    this.w = browser;
  }
  note(period) {
    return period
      ? `${this.w.text('periodWindow')}: ${date(period.startMs)}\n${this.w.text('periodNext')}: ${date(period.endMs)}${period.clockRollback ? '\n' + this.w.status('WALLET_PERIOD_CLOCK_ROLLBACK') : ''}`
      : '';
  }
  edit(limits, back, locked = false) {
    const show = () =>
      this.w.menu(
        this.w.text('periodTitle'),
        [
          { label: this.w.text('back'), value: 'back' },
          ...(!locked
            ? [
                {
                  label: this.w.text('periodEnable') + ' · ' + (limits.period ? '●' : '○'),
                  value: 'toggle',
                },
              ]
            : []),
          ...(limits.period
            ? [
                ...(!locked
                  ? [
                      {
                        label: this.w.text('periodSeconds') + ' · ' + limits.period.seconds + ' s',
                        value: 'seconds',
                      },
                    ]
                  : []),
                {
                  label: this.w.text('tokensTitle') + ' · ' + limits.period.tokens.length,
                  value: 'tokens',
                },
                ...['maxTotalValueEth', 'maxTotalFeeEth', 'maxTransactions'].map((name) => ({
                  label: this.w.text(name) + ' · ' + limits.period[name],
                  value: name,
                })),
              ]
            : []),
        ],
        (value) => {
          if (value === 'back') return back();
          if (value === 'toggle') {
            if (limits.period) delete limits.period;
            else
              limits.period = {
                seconds: 3600,
                maxTotalValueEth: '0',
                maxTotalFeeEth: '0',
                maxTransactions: 0,
                tokens: [],
              };
            return show();
          }
          if (value === 'tokens') return this.w.tokenScope(limits.period, show);
          if (value === 'seconds')
            return this.w.menu(
              this.w.text('periodSeconds'),
              [
                { label: this.w.text('back'), value: 'back' },
                ...[3600, 86400, 604800, 2592000].map((seconds, i) => ({
                  label: this.w.text(['periodHour', 'periodDay', 'periodWeek', 'periodMonth'][i]),
                  value: seconds,
                })),
                { label: this.w.text('periodCustom'), value: 'custom' },
              ],
              (seconds) => {
                if (seconds === 'back') return show();
                if (seconds !== 'custom') {
                  limits.period.seconds = seconds;
                  return show();
                }
                return this.w.input(
                  this.w.text('periodCustom'),
                  (text) => {
                    const seconds = Number(text);
                    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 2592000)
                      throw Error(this.w.status('WALLET_PERIOD_INVALID'));
                    limits.period.seconds = seconds;
                    return show();
                  },
                  { value: String(limits.period.seconds), back: show },
                );
              },
              '',
              show,
            );
          return this.w.input(
            this.w.text(value),
            (text) => {
              limits.period[value] = text.trim() || '0';
              return show();
            },
            { value: String(limits.period[value]), back: show },
          );
        },
        this.w.text('periodHint') + (locked ? '\n\n' + this.w.text('periodLocked') : ''),
        back,
      );
    show();
  }
  budget(snapshot, back, offset = 0) {
    const rows = walletBudget(snapshot);
    this.w.menu(
      this.w.text('usageTitle'),
      [
        { label: this.w.text('back'), value: 'back' },
        ...(offset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(offset + 4 < rows.length
          ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }]
          : []),
        ...(snapshot?.period ? [{ label: this.w.text('periodHistory'), value: 'history' }] : []),
      ],
      (value) =>
        value === 'back'
          ? back()
          : value === 'history'
            ? this.history(snapshot.period.identity, () => this.budget(snapshot, back, offset))
            : this.budget(snapshot, back, Math.max(0, offset + (value === 'next' ? 4 : -4))),
      (snapshot?.period
        ? this.note(snapshot.period)
        : typeof snapshot?.startMs === 'number'
          ? `${date(snapshot.startMs)} → ${date(snapshot.endMs)}`
          : '') +
        '\n\n' +
        (rows.length
          ? rows
              .slice(offset, offset + 4)
              .map(
                (r) =>
                  `${this.w.text(r.label)} · ${r.asset}\n${r.usedText}${r.breakdown ? '' : ' / ' + (r.limitText ?? this.w.text('usageUnlimited'))}`,
              )
              .join('\n\n')
          : this.w.text('usageEmpty')),
      back,
    );
  }
  async history(identity, back, offset = 0) {
    const page = await this.w.call('period.history', { ...identity, offset, limit: 2 });
    this.w.menu(
      this.w.text('periodHistory'),
      [
        { label: this.w.text('back'), value: 'back' },
        ...page.items.map((w, i) => ({
          label: `${date(w.startMs)} → ${date(w.endMs)} · ${w.usage.transactions}`,
          value: i,
        })),
        ...(offset ? [{ label: this.w.text('portfolioPrevious'), value: 'previous' }] : []),
        ...(page.next !== null ? [{ label: this.w.text('portfolioPageNext'), value: 'next' }] : []),
      ],
      (value) => {
        if (value === 'back') return back();
        if (value === 'previous') return this.history(identity, back, Math.max(0, offset - 2));
        if (value === 'next') return this.history(identity, back, page.next);
        const w = page.items[value];
        return this.budget(w, () => this.history(identity, back, offset));
      },
      this.w.text('periodLastPolicy') +
        (page.items.length ? '' : '\n' + this.w.text('periodEmpty')),
      back,
    );
  }
}
module.exports = { TuiWalletPeriods };
