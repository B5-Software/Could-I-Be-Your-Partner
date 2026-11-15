/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
class TuiWalletApps {
  constructor(wallet) {
    this.w = wallet;
  }
  async open() {
    const apps = await this.w.call('app.list');
    const source = (v) => v.origin + (v.clientName ? ' · ' + v.clientName : '');
    return this.w.menu(
      this.w.text('appsTitle'),
      [
        { label: this.w.text('appsBack'), value: 'back' },
        { label: this.w.text('appsRefresh'), value: 'refresh' },
        ...apps.pending.map((p) => ({
          label: this.w.text('appsPending') + ' · ' + source(p),
          value: 'pending:' + p.id,
        })),
        ...apps.connections.map((c) => ({
          label: source(c) + (c.expired ? ' · ' + this.w.text('appsExpired') : ''),
          value: 'connection:' + c.id,
        })),
      ],
      async (value) => {
        if (value === 'back') return this.w.open();
        if (value === 'refresh') return this.open();
        if (value.startsWith('connection:')) {
          const c = apps.connections.find((c) => c.id === value.slice(11));
          return this.w.menu(
            source(c),
            [
              { label: this.w.text('appsBack'), value: false },
              { label: this.w.text('appsRevoke'), value: true },
            ],
            async (revoke) => {
              if (revoke) await this.w.call('app.revoke', { id: c.id, revision: c.revision });
              return this.open();
            },
            this.w.text('appsHint') +
              '\n\n' +
              c.chain +
              '\n' +
              new Date(c.expiresAt).toLocaleString(),
            () => this.open(),
          );
        }
        const p = apps.pending.find((p) => p.id === value.slice(8));
        if (p.network) return this.addNetwork(p, source(p));
        const [data, networks] = await Promise.all([
          this.w.call('list'),
          this.w.call('network.list'),
        ]);
        if (p.desiredChain && p.walletId) {
          const wallet = data.wallets.find((w) => w.id === p.walletId);
          const chain = networks.items.find((n) => !n.archived && n.key === p.desiredChain);
          return this.w.menu(
            this.w.text('appsSwitch'),
            [
              { label: this.w.text('appsDeny'), value: false },
              ...(wallet && chain ? [{ label: this.w.text('appsSwitch'), value: true }] : []),
            ],
            async (allow) => {
              if (allow)
                await this.w.call('app.allow', {
                  id: p.id,
                  walletId: p.walletId,
                  chain: p.desiredChain,
                  confirmed: true,
                });
              else await this.w.call('app.deny', { id: p.id });
              return this.open();
            },
            [
              source(p),
              wallet && wallet.name + ' · ' + wallet.address,
              chain && chain.name + ' · ' + chain.id,
            ]
              .filter(Boolean)
              .join('\n'),
            () => this.open(),
          );
        }
        return this.w.menu(
          source(p),
          [
            { label: this.w.text('appsDeny'), value: null },
            ...data.wallets.map((w) => ({ label: w.name + ' · ' + w.address, value: w.id })),
          ],
          async (walletId) => {
            if (!walletId) {
              await this.w.call('app.deny', { id: p.id });
              return this.open();
            }
            return this.w.menu(
              this.w.text('appsNetwork'),
              [
                { label: this.w.text('appsBack'), value: null },
                ...networks.items
                  .filter((n) => !n.archived && (!p.desiredChain || p.desiredChain === n.key))
                  .map((n) => ({ label: n.name + ' · ' + n.id, value: n.key })),
              ],
              (chain) => {
                if (!chain) return this.open();
                return this.w.menu(
                  this.w.text('appsReview'),
                  [
                    { label: this.w.text('appsDeny'), value: false },
                    { label: this.w.text('appsAllow'), value: true },
                  ],
                  async (allow) => {
                    await this.w.call(allow ? 'app.allow' : 'app.deny', {
                      id: p.id,
                      walletId,
                      chain,
                      confirmed: allow,
                    });
                    return this.open();
                  },
                  source(p) +
                    '\n' +
                    data.wallets.find((w) => w.id === walletId).name +
                    '\n' +
                    chain +
                    '\n\n' +
                    this.w.text('appsHint'),
                  () => this.open(),
                );
              },
              this.w.text('appsHint'),
              () => this.open(),
            );
          },
          this.w.text('appsHint'),
          () => this.open(),
        );
      },
      this.w.text('appsHint'),
      () => this.w.open(),
    );
  }
  addNetwork(p, source) {
    const t = (k) => this.w.text(k);
    const { network } = p;
    const probe = () =>
      this.w.input(
        t('appsOwnRpc'),
        (rpc) =>
          this.w.input(
            t('networkFeeBuffer'),
            async (fee) => {
              const verified = await this.w.call('app.probeNetwork', {
                id: p.id,
                rpc: rpc.trim(),
                additionalFeeNative: fee.trim(),
              });
              const v = verified.profile;
              return this.w.menu(
                t('appsSaveNetwork'),
                [
                  { label: t('appsDeny'), value: false },
                  { label: t('appsSaveNetwork'), value: true },
                ],
                async (save) => {
                  if (save)
                    await this.w.call('app.addNetwork', {
                      id: p.id,
                      reviewId: verified.id,
                      confirmed: true,
                    });
                  else await this.w.call('app.deny', { id: p.id });
                  return this.open();
                },
                [
                  source,
                  v.name + ' · ' + v.id + ' · ' + v.nativeSymbol,
                  v.rpcOrigin,
                  t(v.capabilities.signType2 ? 'networkReady' : 'networkReadOnly'),
                  t('networkFeeBuffer') + ' · ' + v.additionalFeeNative + ' ' + v.nativeSymbol,
                  v.genesisHash,
                ].join('\n'),
                () => this.open(),
              );
            },
            { value: '0', back: probe },
          ),
        { back: () => this.addNetwork(p, source) },
      );
    return this.w.menu(
      t('appsAddNetwork'),
      [
        { label: t('appsDeny'), value: false },
        { label: t('appsProbe'), value: true },
      ],
      async (verify) => {
        if (verify) return probe();
        await this.w.call('app.deny', { id: p.id });
        return this.open();
      },
      [
        source,
        network.name + ' · ' + network.id + ' · ' + network.nativeSymbol,
        t('appsProbeHint'),
        t('appsSuggestedRpc'),
        ...network.rpcOrigins,
      ].join('\n'),
      () => this.open(),
    );
  }
}
module.exports = { TuiWalletApps };
