/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
class TuiWalletNetworks {
  constructor(wallet) {
    this.w = wallet;
  }
  async open() {
    const { items } = await this.w.call('network.list');
    return this.w.menu(
      this.w.text('networks'),
      [
        { label: this.w.text('networkBack'), value: 'back' },
        { label: this.w.text('networkAdd'), value: 'add' },
        ...items.map((p) => ({
          label: `${p.name} · ${p.id} · ${p.nativeSymbol}${p.archived ? ' · ' + this.w.text('networkStopped') : ''}`,
          value: p.key,
        })),
      ],
      async (value) => {
        if (value === 'back') return this.w.open();
        if (value === 'add') return this.edit();
        const p = items.find((p) => p.key === value);
        return this.w.menu(
          p.name,
          [
            { label: this.w.text('networkBack'), value: 'back' },
            { label: this.w.text(p.archived ? 'networkRestore' : 'networkEdit'), value: 'edit' },
            ...(!p.builtin && !p.archived
              ? [{ label: this.w.text('networkArchive'), value: 'archive' }]
              : []),
          ],
          async (action) => {
            if (action === 'back') return this.open();
            if (action === 'edit') return this.edit(p.key);
            await this.w.call('network.archive', { key: p.key, revision: p.revision });
            return this.open();
          },
          `${p.id} · ${p.nativeSymbol}\n${p.rpcOrigin}\n${this.w.text(p.archived ? 'networkStopped' : p.capabilities.signType2 ? 'networkReady' : 'networkReadOnly')}\n${p.genesisHash ?? ''}`,
          () => this.open(),
        );
      },
      this.w.text('networkHint') + '\n\n' + this.w.text('networkSupport'),
      () => this.w.open(),
    );
  }
  async edit(key) {
    const p = key ? await this.w.call('network.config', { key }) : null;
    const draft = p
      ? { ...p }
      : {
          name: '',
          id: '',
          nativeSymbol: 'ETH',
          nativeDecimals: 18,
          rpc: '',
          additionalFeeNative: '0',
          revision: 0,
        };
    const fields = [
      ...(!p?.builtin
        ? [
            ['name', 'networkName'],
            ...(!p ? [['id', 'networkChainId']] : []),
            ['nativeSymbol', 'networkSymbol'],
          ]
        : []),
      ['rpc', 'networkRpc'],
      ...(!p?.builtin ? [['additionalFeeNative', 'networkFeeBuffer']] : []),
    ];
    const next = (index) => {
      if (index < fields.length) {
        const [field, label] = fields[index];
        return this.w.input(
          this.w.text(label),
          (value) => {
            draft[field] = field === 'id' ? Number(value.trim()) : value.trim();
            return next(index + 1);
          },
          { value: String(draft[field]), back: () => this.open() },
        );
      }
      return this.w.menu(
        this.w.text('networkReview'),
        [
          { label: this.w.text('networkBack'), value: false },
          { label: this.w.text('networkReview'), value: true },
        ],
        async (ready) => {
          if (!ready) return this.open();
          const c = await this.w.call('network.challenge', draft),
            profile = c.profile;
          this.w.menu(
            this.w.text('networkConfirm'),
            [
              { label: this.w.text('networkBack'), value: false },
              { label: this.w.text('networkConfirm'), value: true },
            ],
            async (save) => {
              if (!save) return this.open();
              await this.w.call('network.confirm', {
                challengeId: c.id,
                ack: 'SAVE NETWORK',
                confirmed: true,
              });
              return this.open();
            },
            `${profile.name} · ${profile.id} · ${profile.nativeSymbol}\n${profile.rpcOrigin}\n${profile.genesisHash}\n\n${this.w.text(profile.capabilities.signType2 ? 'networkReady' : 'networkReadOnly')}`,
            () => this.open(),
          );
        },
        this.w.text('networkFeeHint'),
        () => this.open(),
      );
    };
    return next(0);
  }
  async send(wallet) {
    const { items } = await this.w.call('network.list');
    return this.w.menu(
      this.w.text('networkSend'),
      [
        { label: this.w.text('networkBack'), value: null },
        ...items
          .filter((p) => !p.archived && p.capabilities.signType2)
          .map((p) => ({ label: `${p.name} · ${p.id} · ${p.nativeSymbol}`, value: p.key })),
      ],
      (chain) => {
        if (!chain) return this.w.account(wallet);
        return this.w.input(
          this.w.text('networkRecipient'),
          (to) =>
            this.w.input(
              this.w.text('networkAmount'),
              async (value) => {
                const intent = await this.w.call('transaction.prepare', {
                  id: wallet.id,
                  chain,
                  to: to.trim(),
                  value: value.trim(),
                });
                return this.w.inspect(intent.id, 0, () => this.w.account(wallet));
              },
              { back: () => this.send(wallet) },
            ),
          { back: () => this.send(wallet) },
        );
      },
      this.w.text('networkPrepared'),
      () => this.w.account(wallet),
    );
  }
}
module.exports = { TuiWalletNetworks };
