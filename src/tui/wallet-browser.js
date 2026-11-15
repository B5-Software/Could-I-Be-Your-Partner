/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

class TuiWalletBrowser {
  constructor(wallet) {
    this.w = wallet;
  }
  async open() {
    const state = await this.w.call('browser.status');
    const t = (k) => this.w.text(k);
    const active = state.state === 'listening';
    const retryStop = !active && state.error === 'WALLET_BROWSER_PERSIST';
    const options = [
      { label: t('wbBack'), value: 'back' },
      { label: t('wbRefresh'), value: 'refresh' },
      ...(active || state.enabled || retryStop
        ? [{ label: t(retryStop ? 'wbRetryStop' : 'wbStop'), value: 'stop' }]
        : []),
      ...(!active && !retryStop ? [{ label: t('wbStart'), value: 'start' }] : []),
      ...(active ? [{ label: t('wbPair'), value: 'pair' }] : []),
      ...state.pending.map((p) => ({
        label: t('wbReview') + ' · ' + p.name,
        value: 'pending:' + p.id,
      })),
      ...state.clients.map((c) => ({
        label: c.name + (c.revoked ? ' · ' + t('wbRevoked') : ''),
        value: 'client:' + c.id,
      })),
    ];
    return this.w.menu(
      t('wbTitle'),
      options,
      async (value) => {
        if (value === 'back') return this.w.open();
        if (value === 'refresh') return this.open();
        if (value === 'pair') return this.offer(await this.w.call('browser.pair'));
        if (value === 'start' || value === 'stop') {
          await this.w.call('browser.' + value);
          return this.open();
        }
        if (value.startsWith('pending:')) {
          const p = state.pending.find((p) => p.id === value.slice(8));
          const frozen = { id: p.id, digest: p.digest };
          return this.w.menu(
            t('wbReview'),
            [
              { label: t('wbReject'), value: false },
              { label: t('wbConfirm'), value: true },
            ],
            async (allow) => {
              await this.w.call(
                allow ? 'browser.confirm' : 'browser.deny',
                allow ? { ...frozen, confirmed: true } : { id: p.id },
              );
              return this.open();
            },
            this.identity(p) + '\n\n' + t('wbReviewHint'),
            () => this.open(),
          );
        }
        const c = state.clients.find((c) => c.id === value.slice(7));
        return this.w.menu(
          c.name,
          [
            { label: t('wbBack'), value: false },
            ...(!c.revoked || c.revocationPending
              ? [{ label: t(c.revocationPending ? 'wbRetryRevoke' : 'wbRevoke'), value: true }]
              : []),
          ],
          async (revoke) => {
            if (revoke) await this.w.call('browser.revoke', { id: c.id, revision: c.revision });
            return this.open();
          },
          this.identity(c),
          () => this.open(),
        );
      },
      t(active ? 'wbRunning' : 'wbStopped') +
        '\n' +
        t('wbEnable') +
        '\n' +
        t('wbHint') +
        (state.fingerprint ? '\n' + t('wbFingerprint') + ': ' + state.fingerprint : '') +
        (state.error ? '\n' + this.w.status(state.error) : ''),
      () => this.w.open(),
    );
  }
  identity(item) {
    return [
      item.name,
      this.w.text('wbOrigin') + ': ' + item.origin,
      this.w.text('wbFingerprint') + ': ' + item.fingerprint,
    ].join('\n');
  }
  offer(offer) {
    const t = (k) => this.w.text(k);
    const hint =
      t('wbPairHint') +
      '\n' +
      t('wbExpires') +
      ' ' +
      new Date(offer.expiresAt).toLocaleTimeString();
    this.w.menu(
      t('wbAddress'),
      [
        { label: t('wbCopy'), value: 'copy' },
        { label: t('wbRefresh'), value: 'refresh' },
      ],
      async (action) => {
        if (action !== 'copy' || offer.expiresAt <= Date.now()) return this.open();
        try {
          await this.w.app.onCopy(offer.uri);
          this.w.notify(t('wbCopied'));
          return this.open();
        } catch {
          this.w.menu(
            t('wbClipboard'),
            [{ label: t('wbBack'), value: null }],
            () => this.open(),
            hint + '\n\n' + offer.uri,
            () => this.open(),
          );
        }
      },
      hint,
      () => this.open(),
    );
  }
}
module.exports = { TuiWalletBrowser };
