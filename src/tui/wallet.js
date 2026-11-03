/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { LineEditor } = require('./editor');
const { getLanguage } = require('./text');
const statuses = require('../shared/wallet-status.json');
const emergencyLabels = require('../shared/wallet-emergency-labels.json');
const securityLabels = require('../shared/wallet-security-labels.json');
const policyLabels = require('../shared/wallet-policy-labels.json');
const policyFields = require('../shared/wallet-policy-fields.json');
const tokenLabels = require('../shared/wallet-token-labels.json');
const tokenFields = require('../shared/wallet-token-fields.json');
const tokenPresets = require('../shared/wallet-token-presets.json');
const { walletBudget } = require('../shared/wallet-budget');
const portfolioLabels = require('../shared/wallet-portfolio-labels.json');
const { TuiWalletPortfolios } = require('./wallet-portfolios');
const periodLabels = require('../shared/wallet-period-labels.json');
const { TuiWalletPeriods } = require('./wallet-periods');
const agentScopeLabels = require('../shared/wallet-agent-scope-labels.json');
const { TuiWalletAgentScopes } = require('./wallet-agent-scopes');
const labels = {
  zh: {
    ...securityLabels['zh-CN'],
    ...policyLabels['zh-CN'],
    ...tokenLabels['zh-CN'],
    ...portfolioLabels['zh-CN'],
    ...periodLabels['zh-CN'],
    ...agentScopeLabels['zh-CN'],
    ...emergencyLabels.zh,
    title: '钱包',
    accounts: '选择钱包',
    pending: '等待实盘授权',
    history: '实盘历史',
    create: '创建钱包',
    import: '导入钱包',
    back: '返回',
    close: '关闭',
    cancel: '取消',
    name: '钱包名称',
    password: '本地钱包密码（至少 12 个字符）',
    unlock: '解锁钱包',
    lock: '锁定钱包',
    balance: '余额',
    automatic: '全自动实盘权限',
    revoke: '撤销自动实盘权限',
    empty: '暂无记录',
    locked: '已锁定',
    unlocked: '已解锁',
    network: '选择网络',
    mainnet: 'Base 主网',
    testnet: 'Base Sepolia',
    both: '两个网络',
    duration: '有效期',
    minutes: '15 分钟',
    hour: '1 小时',
    day: '24 小时',
    session: '直到关闭后台',
    forever: '直到手动撤销',
    fee: '每笔估算费用上限（ETH，0 表示不限）',
    warning:
      '允许 Agent 在所选钱包和网络连续转账、兑换和调用合约，无需逐笔确认。可能损失全部资产，链上操作通常无法撤回。撤销本应用权限不会撤回已广播交易或链上代币授权。L1 费用只是估算。此权限不会自动解锁钱包。',
    read: '已阅读，继续',
    ack: '输入 ALLOW LIVE 完成二次确认',
    approved: '确认授权并签名',
    deny: '拒绝交易',
    details: '交易详情',
    reconcile: '核实签名及链上结果',
    data: '查看完整调用数据',
    next: '下一页',
    previous: '上一页',
    backup: '离线保存助记词，只显示一次。不要发送到聊天。关闭后清除此页面。',
    key: '私钥',
    phrase: '助记词',
    keystore: '加密 Keystore JSON',
    sourcePassword: '原 Keystore 密码',
    secret: '输入钱包密钥材料（已遮挡）',
    ready: '钱包操作已完成',
    waiting: '钱包有待授权操作，使用 /wallet 查看',
    error: '钱包操作失败',
    input: '输入内容 · Enter 确认 · Esc 取消',
    choose: '↑↓ 选择 · Enter 打开 · Esc 返回',
  },
  en: {
    ...securityLabels.en,
    ...policyLabels.en,
    ...tokenLabels.en,
    ...portfolioLabels.en,
    ...periodLabels.en,
    ...agentScopeLabels.en,
    ...emergencyLabels.en,
    title: 'Wallet',
    accounts: 'Choose a wallet',
    pending: 'Pending live approvals',
    history: 'Live history',
    create: 'Create wallet',
    import: 'Import wallet',
    back: 'Back',
    close: 'Close',
    cancel: 'Cancel',
    name: 'Wallet name',
    password: 'Local wallet password (at least 12 characters)',
    unlock: 'Unlock wallet',
    lock: 'Lock wallet',
    balance: 'Balance',
    automatic: 'Autonomous live permission',
    revoke: 'Revoke autonomous permission',
    empty: 'No records',
    locked: 'Locked',
    unlocked: 'Unlocked',
    network: 'Choose network',
    mainnet: 'Base mainnet',
    testnet: 'Base Sepolia',
    both: 'Both networks',
    duration: 'Duration',
    minutes: '15 minutes',
    hour: '1 hour',
    day: '24 hours',
    session: 'Until the backend closes',
    forever: 'Until manually revoked',
    fee: 'Estimated fee cap per transaction (ETH; 0 is unlimited)',
    warning:
      'Allows continuous transfers, swaps and contract calls from the selected wallet/network without individual approval. All assets may be lost; onchain actions are usually irreversible. Revoking app permission cannot undo broadcasts or onchain token allowances. L1 fees are estimates. This permission does not unlock the wallet.',
    read: 'I have read this; continue',
    ack: 'Type ALLOW LIVE to confirm again',
    approved: 'Authorize and sign',
    deny: 'Deny transaction',
    details: 'Transaction details',
    reconcile: 'Reconcile signature and chain outcome',
    data: 'Read full calldata',
    next: 'Next page',
    previous: 'Previous page',
    backup:
      'Save the recovery phrase offline. It is shown once, never sent to chat, and cleared when this page closes.',
    key: 'Private key',
    phrase: 'Recovery phrase',
    keystore: 'Encrypted Keystore JSON',
    sourcePassword: 'Original Keystore password',
    secret: 'Enter wallet key material (masked)',
    ready: 'Wallet action completed',
    waiting: 'A wallet operation needs approval; use /wallet',
    error: 'Wallet action failed',
    input: 'Enter to confirm · Esc to cancel',
    choose: '↑↓ select · Enter open · Esc back',
  },
  de: {
    ...securityLabels.de,
    ...policyLabels.de,
    ...tokenLabels.de,
    ...portfolioLabels.de,
    ...periodLabels.de,
    ...agentScopeLabels.de,
    ...emergencyLabels.de,
    title: 'Wallet',
    accounts: 'Wallet auswählen',
    pending: 'Ausstehende Live-Freigaben',
    history: 'Live-Verlauf',
    create: 'Wallet erstellen',
    import: 'Wallet importieren',
    back: 'Zurück',
    close: 'Schließen',
    cancel: 'Abbrechen',
    name: 'Wallet-Name',
    password: 'Lokales Wallet-Passwort (mindestens 12 Zeichen)',
    unlock: 'Wallet entsperren',
    lock: 'Wallet sperren',
    balance: 'Guthaben',
    automatic: 'Autonome Live-Berechtigung',
    revoke: 'Autonome Berechtigung widerrufen',
    empty: 'Keine Einträge',
    locked: 'Gesperrt',
    unlocked: 'Entsperrt',
    network: 'Netzwerk auswählen',
    mainnet: 'Base Mainnet',
    testnet: 'Base Sepolia',
    both: 'Beide Netzwerke',
    duration: 'Gültigkeit',
    minutes: '15 Minuten',
    hour: '1 Stunde',
    day: '24 Stunden',
    session: 'Bis das Backend geschlossen wird',
    forever: 'Bis zum manuellen Widerruf',
    fee: 'Geschätztes Gebührenlimit je Transaktion (ETH; 0 unbegrenzt)',
    warning:
      'Erlaubt fortlaufende Transfers, Swaps und Vertragsaufrufe im gewählten Wallet/Netzwerk ohne Einzelbestätigung. Alle Vermögenswerte können verloren gehen; Onchain-Aktionen sind meist unumkehrbar. Ein Widerruf macht Übertragungen und Token-Freigaben nicht rückgängig. L1-Gebühren sind Schätzwerte. Das Wallet wird dadurch nicht entsperrt.',
    read: 'Gelesen; weiter',
    ack: 'Zur zweiten Bestätigung ALLOW LIVE eingeben',
    approved: 'Freigeben und signieren',
    deny: 'Transaktion ablehnen',
    details: 'Transaktionsdetails',
    reconcile: 'Signatur und Kettenergebnis abgleichen',
    data: 'Vollständige Aufrufdaten lesen',
    next: 'Nächste Seite',
    previous: 'Vorherige Seite',
    backup:
      'Wiederherstellungsphrase offline sichern. Sie erscheint einmal, niemals im Chat, und wird beim Schließen entfernt.',
    key: 'Privater Schlüssel',
    phrase: 'Wiederherstellungsphrase',
    keystore: 'Verschlüsseltes Keystore-JSON',
    sourcePassword: 'Ursprüngliches Keystore-Passwort',
    secret: 'Wallet-Schlüsseldaten eingeben (verdeckt)',
    ready: 'Wallet-Aktion abgeschlossen',
    waiting: 'Wallet-Freigabe erforderlich; /wallet öffnen',
    error: 'Wallet-Aktion fehlgeschlagen',
    input: 'Enter bestätigen · Esc abbrechen',
    choose: '↑↓ auswählen · Enter öffnen · Esc zurück',
  },
};
class WalletBrowser {
  constructor(app) {
    this.app = app;
    this.seen = new Set();
    this.generation = 0;
  }
  text(key) {
    return (labels[getLanguage()] || labels.zh)[key] || labels.en[key] || key;
  }
  status(value) {
    return (statuses[getLanguage()] || statuses['zh-CN'])[value] || value;
  }
  call(action, input = {}) {
    return this.app.runtime.api.backendRequest('wallet:request', action, input).catch((error) => {
      if (error instanceof Error) error.message = this.status(error.message);
      throw error;
    });
  }
  notify(text) {
    this.app.state.toast = { text, type: 'info', expiresAt: this.app.clock() + 6000 };
  }
  menu(title, options, onChoose, subtitle = '', back = () => this.open()) {
    this.app.state.modal = {
      kind: 'walletMenu',
      title,
      body: subtitle,
      colorKey: 'permission',
      options,
      selected: 0,
      footer: this.text('choose'),
      onChoose,
      onCancel: back,
    };
    const modal = this.app.state.modal;
    modal.onDispose = () => {
      modal.body = '';
    };
  }
  input(title, callback, { masked = false, value = '', back = () => this.open() } = {}) {
    const editor = new LineEditor();
    editor.setValue(value);
    this.app.state.modal = {
      kind: 'walletInput',
      title,
      colorKey: 'permission',
      inputMode: true,
      masked,
      editor,
      footer: this.text('input'),
      onSubmit: async () => {
        const text = editor.value;
        editor.setValue('');
        this.app.state.modal = null;
        await callback(text);
      },
      onCancel: () => {
        editor.setValue('');
        return back();
      },
    };
    this.app.state.modal.onDispose = () => editor.setValue('');
  }
  async changed() {
    const data = await this.call('list');
    if (data.emergency?.halted && !this.emergency?.halted) {
      this.disposeSensitive();
      this.notify(this.text('esStopped'));
    }
    this.emergency = data.emergency;
    const pending = data.intents.filter((intent) => intent.status === 'approval-required');
    if (pending.some((intent) => !this.seen.has(intent.id))) this.notify(this.text('waiting'));
    this.seen = new Set(pending.map((intent) => intent.id));
  }
  disposeSensitive() {
    this.generation++;
    const modal = this.app.state.modal;
    if (modal?.kind?.startsWith('wallet')) {
      modal.onDispose?.();
      this.app.state.modal = null;
    }
    this.clearSecrets?.();
  }
  async open() {
    if (this.app._disposed) return;
    const data = await this.call('list');
    this.emergency = data.emergency;
    const options = [
      { label: this.text('close'), value: 'close' },
      ...data.wallets.map((wallet) => ({
        label: `${wallet.name} · ${this.text(wallet.unlocked ? 'unlocked' : 'locked')} · ${wallet.address.slice(0, 8)}…`,
        value: wallet,
      })),
      {
        label: `${this.text('pending')} · ${data.intents.filter((i) => i.status === 'approval-required').length}`,
        value: 'pending',
      },
      { label: this.text('history'), value: 'history' },
      { label: this.text('portfolioTitle'), value: 'portfolios' },
      { label: this.text('agentScopesTitle'), value: 'agent-scopes' },
      ...(data.wallets.some((w) => w.portfolioBlocked)
        ? [{ label: this.text('portfolioRecover'), value: 'portfolio-recover' }]
        : []),
      { label: this.text('create'), value: 'create' },
      { label: this.text('import'), value: 'import' },
      {
        label: this.text(
          data.emergency?.halted
            ? data.emergency.storageError || data.emergency.nativePauseError
              ? 'esRetry'
              : data.emergency.nativePausePending
                ? 'esPending'
                : 'esReset'
            : 'esHalt',
        ),
        value:
          data.emergency?.halted && !data.emergency.storageError && !data.emergency.nativePauseError
            ? data.emergency.nativePausePending
              ? 'emergency-refresh'
              : 'emergency-reset'
            : 'emergency-stop',
      },
    ];
    this.menu(
      this.text('title'),
      options,
      async (value) => {
        if (value === 'close') return;
        if (value === 'portfolios') return new TuiWalletPortfolios(this).open();
        if (value === 'agent-scopes') return new TuiWalletAgentScopes(this).open();
        if (value === 'portfolio-recover') return new TuiWalletPortfolios(this).recover();
        if (value === 'emergency-refresh') return this.open();
        if (value === 'emergency-stop') {
          try {
            await this.call('emergency.halt', { expectedGeneration: data.emergency?.generation });
          } finally {
            await this.open();
          }
          return;
        }
        if (value === 'emergency-reset') return this.resetEmergency();
        if (value === 'pending' || value === 'history') return this.history(0, value === 'pending');
        if (value === 'create' || value === 'import') return this.credentials(value);
        return this.account(value);
      },
      data.emergency?.halted
        ? [
            this.text('esStopped'),
            this.text('esResidual'),
            this.text('esReconcile') + ': ' + data.emergency.needsReconciliation,
            data.emergency.nativePausePending ? this.text('esPending') : '',
            this.status(data.emergency.storageError || data.emergency.nativePauseError || ''),
          ]
            .filter(Boolean)
            .join('\n')
        : '',
      () => {},
    );
  }
  account(wallet) {
    this.menu(
      wallet.name,
      [
        { label: this.text('back'), value: 'back' },
        {
          label: this.text(wallet.unlocked ? 'lock' : 'unlock'),
          value: wallet.unlocked ? 'lock' : 'unlock',
        },
        { label: this.text('balance'), value: 'balance' },
        { label: this.text('usageTitle'), value: 'usage' },
        { label: this.text('changePassword'), value: 'password-change' },
        {
          label: this.text(wallet.policy.mode === 'autonomous' ? 'revoke' : 'automatic'),
          value: wallet.policy.mode === 'autonomous' ? 'revoke' : 'automatic',
        },
      ].filter(
        (option) =>
          !this.emergency?.halted ||
          ['back', 'balance', 'password-change', 'usage'].includes(option.value),
      ),
      async (action) => {
        if (action === 'back') return this.open();
        if (action === 'usage') {
          const snapshot = await this.call('policy.usage', { id: wallet.id });
          if (snapshot?.period)
            return new TuiWalletPeriods(this).budget(snapshot, () => this.account(wallet));
          const rows = walletBudget(snapshot);
          return this.menu(
            this.text('usageTitle'),
            [{ label: this.text('back'), value: 'back' }],
            () => this.account(wallet),
            this.text('usageHint') +
              '\n\n' +
              (rows.length
                ? rows
                    .map(
                      (row) =>
                        `${this.text(row.label)} · ${row.asset}\n${row.usedText}${row.breakdown ? '' : ' / ' + (row.limitText ?? this.text('usageUnlimited'))}${row.contract ? '\n' + row.contract : ''}`,
                    )
                    .join('\n\n')
                : this.text('usageEmpty')),
          );
        }
        if (action === 'unlock')
          return this.menu(
            this.text('duration'),
            [15, 60, 0].map((minutes, index) => ({
              label: this.text(['minutes', 'hour', 'session'][index]),
              value: minutes,
            })),
            (minutes) =>
              this.input(
                this.text('password'),
                async (password) => {
                  await this.call('unlock', { id: wallet.id, password, minutes });
                  await this.open();
                },
                { masked: true },
              ),
          );
        if (action === 'lock' || action === 'revoke') {
          await this.call(action === 'lock' ? 'lock' : 'policy.revoke', { id: wallet.id });
          return this.open();
        }
        if (action === 'password-change')
          return this.menu(
            this.text('changePassword'),
            [
              { label: this.text('back'), value: false },
              { label: this.text('changePassword'), value: true },
            ],
            (proceed) => (proceed ? this.changePassword(wallet) : this.account(wallet)),
            this.text('changePasswordHint'),
            () => this.account(wallet),
          );
        if (action === 'balance')
          return this.menu(
            this.text('network'),
            [
              { label: this.text('mainnet'), value: 'base' },
              { label: this.text('testnet'), value: 'base-sepolia' },
            ],
            async (chain) => {
              const result = await this.call('balance', { id: wallet.id, chain });
              this.menu(
                this.text('balance'),
                [{ label: this.text('back'), value: 0 }],
                () => this.account(wallet),
                JSON.stringify(result, null, 2),
              );
            },
          );
        if (action === 'automatic') return this.authorization(wallet);
      },
      wallet.address,
    );
  }
  resetEmergency() {
    return this.menu(
      this.text('esReset'),
      [
        { label: this.text('back'), value: 'back' },
        { label: this.text('esRead'), value: 'continue' },
      ],
      async (value) => {
        if (value === 'back') return this.open();
        const challenge = await this.call('emergency.challenge');
        return this.input(
          this.text('esAck'),
          async (ack) => {
            await this.call('emergency.reset', { challengeId: challenge.id, ack, confirmed: true });
            return this.open();
          },
          { back: () => this.open() },
        );
      },
      [this.text('esScope'), this.text('esResetHint'), this.text('esResidual')].join('\n'),
      () => this.open(),
    );
  }
  changePassword(wallet) {
    const generation = ++this.generation;
    let password = '',
      newPassword = '';
    const clear = () => {
      password = '';
      newPassword = '';
    };
    this.clearSecrets = clear;
    const cancel = () => {
      clear();
      return this.open();
    };
    this.input(
      this.text('currentPassword'),
      (value) => {
        password = value;
        this.input(
          this.text('newPassword'),
          (value) => {
            newPassword = value;
            this.input(
              this.text('repeatPassword'),
              async (repeated) => {
                if (repeated !== newPassword) {
                  clear();
                  throw Error(this.text('passwordMismatch'));
                }
                try {
                  await this.call('password.change', { id: wallet.id, password, newPassword });
                  if (!this.app._disposed && generation === this.generation) await this.open();
                } finally {
                  clear();
                }
              },
              { masked: true, back: cancel },
            );
          },
          { masked: true, back: cancel },
        );
      },
      { masked: true, back: cancel },
    );
  }
  credentials(kind) {
    const generation = ++this.generation;
    let name = '',
      password = '',
      secret = '',
      format = '',
      sourcePassword = '';
    const clear = () => {
      name = '';
      password = '';
      secret = '';
      format = '';
      sourcePassword = '';
    };
    this.clearSecrets = clear;
    const cancel = () => {
      clear();
      return this.open();
    };
    const commit = async () => {
      try {
        const result = await this.call(kind === 'create' ? 'create' : 'import', {
          name,
          password,
          secret,
          kind: format,
          sourcePassword,
        });
        if (this.app._disposed || generation !== this.generation) return;
        if (result.mnemonic) {
          let phrase = result.mnemonic;
          this.menu(
            this.text('backup'),
            [{ label: this.text('close'), value: 0 }],
            () => {
              phrase = '';
              return this.open();
            },
            phrase,
            () => {
              phrase = '';
              return this.open();
            },
          );
          const modal = this.app.state.modal;
          modal.onDispose = () => {
            phrase = '';
            modal.body = '';
          };
        } else await this.open();
      } finally {
        clear();
      }
    };
    const readSecret = () =>
      this.input(
        this.text('secret'),
        async (value) => {
          secret = value;
          if (format === 'keystore')
            return this.input(
              this.text('sourcePassword'),
              async (value) => {
                sourcePassword = value;
                return commit();
              },
              { masked: true, back: cancel },
            );
          return commit();
        },
        { masked: true, back: cancel },
      );
    this.input(
      this.text('name'),
      (value) => {
        name = value.trim();
        this.input(
          this.text('password'),
          async (value) => {
            password = value;
            if (kind === 'create') return commit();
            this.menu(
              this.text('import'),
              ['privateKey', 'mnemonic', 'keystore'].map((value, index) => ({
                label: this.text(['key', 'phrase', 'keystore'][index]),
                value,
              })),
              (value) => {
                format = value;
                return readSecret();
              },
              '',
              cancel,
            );
          },
          { masked: true, back: cancel },
        );
      },
      { back: cancel },
    );
  }
  authorization(wallet) {
    this.menu(
      this.text('network'),
      [
        { label: this.text('mainnet'), value: [8453] },
        { label: this.text('testnet'), value: [84532] },
        { label: this.text('both'), value: [8453, 84532] },
      ],
      (chains) => {
        this.menu(
          this.text('duration'),
          [1, 24, 0].map((value, index) => ({
            label: this.text(['hour', 'day', 'forever'][index]),
            value,
          })),
          (hours) => {
            this.input(
              this.text('fee'),
              (maxFeeEth) => {
                this.policyScope(wallet, (limits) => {
                  this.menu(
                    this.text('automatic'),
                    [
                      { label: this.text('cancel'), value: false },
                      { label: this.text('read'), value: true },
                    ],
                    async (ready) => {
                      if (!ready) return this.open();
                      const challenge = await this.call('policy.challenge', {
                        id: wallet.id,
                        chains,
                        hours,
                        maxFeeEth,
                        limits,
                      });
                      this.input(this.text('ack'), async (ack) => {
                        await this.call('policy.grant', {
                          challengeId: challenge.id,
                          ack,
                          confirmed: true,
                        });
                        await this.open();
                      });
                    },
                    this.text('warning') +
                      '\n\n' +
                      wallet.name +
                      ' · ' +
                      wallet.address +
                      '\n' +
                      chains.join(' / ') +
                      ' · ' +
                      hours +
                      'h · ' +
                      maxFeeEth +
                      ' ETH\n\n' +
                      this.policySummary(limits),
                  );
                });
              },
              { value: '0.01' },
            );
          },
        );
      },
    );
  }
  policyValue(field, value) {
    if (field.name === 'decimals') return String(value);
    if (field.kind === 'toggle') return this.text(value ? 'limitsOn' : 'limitsOff');
    if (Array.isArray(value)) return value.length ? value.join(', ') : this.text('limitsNone');
    return /^0(?:\.0+)?$/.test(String(value)) || String(value).trim() === ''
      ? this.text('limitsNone')
      : String(value);
  }
  policySummary(limits) {
    return (
      policyFields
        .map((field) => this.text(field.name) + ' · ' + this.policyValue(field, limits[field.name]))
        .join('\n') +
      '\n' +
      this.text('tokensTitle') +
      ' · ' +
      (limits.tokens?.length ?? 0) +
      '\n' +
      (limits.tokens ?? [])
        .map((token) =>
          tokenFields
            .map(
              (field) =>
                this.text(field.name) +
                ' · ' +
                this.policyValue(field, token[field.name] ?? field.initial),
            )
            .join('\n'),
        )
        .join('\n\n') +
      (limits.period
        ? '\n\n' +
          this.text('periodTitle') +
          ' · ' +
          limits.period.seconds +
          ' s\n' +
          ['maxTotalValueEth', 'maxTotalFeeEth', 'maxTransactions']
            .map((k) => this.text(k) + ' · ' + limits.period[k])
            .join('\n') +
          '\n' +
          (limits.period.tokens ?? [])
            .map((token) =>
              tokenFields
                .map(
                  (f) =>
                    this.text(f.name) + ' · ' + this.policyValue(f, token[f.name] ?? f.initial),
                )
                .join('\n'),
            )
            .join('\n\n')
        : '')
    );
  }
  policyScope(wallet, done, options = {}) {
    const limits = Object.fromEntries(
      policyFields.map((field) => [
        field.name,
        wallet.policy?.limits?.[field.name] ?? structuredClone(field.initial),
      ]),
    );
    limits.tokens = structuredClone(wallet.policy?.limits?.tokens ?? []);
    if (wallet.policy?.limits?.period) limits.period = structuredClone(wallet.policy.limits.period);
    const show = () =>
      this.menu(
        this.text('limitsTitle'),
        [
          { label: this.text('cancel'), value: 'cancel' },
          { label: this.text('limitsNext'), value: 'continue' },
          { label: this.text('tokensTitle') + ' · ' + limits.tokens.length, value: 'tokens' },
          { label: this.text('periodTitle'), value: 'period' },
          ...policyFields.map((field) => ({
            label: this.text(field.name) + ' · ' + this.policyValue(field, limits[field.name]),
            value: field.name,
          })),
        ],
        (action) => {
          if (action === 'cancel') return this.open();
          if (action === 'continue') return done(limits);
          if (action === 'tokens') return this.tokenScope(limits, show);
          if (action === 'period')
            return new TuiWalletPeriods(this).edit(limits, show, options.periodLocked);
          const field = policyFields.find((field) => field.name === action);
          if (field.kind === 'toggle') {
            limits[action] = !limits[action];
            return show();
          }
          this.input(
            this.text(action),
            (value) => {
              limits[action] =
                field.kind === 'eth' || field.kind === 'count' ? value.trim() || '0' : value;
              return show();
            },
            {
              value: Array.isArray(limits[action])
                ? limits[action].join(', ')
                : String(limits[action]),
              back: show,
            },
          );
        },
        this.text('limitsHint'),
        () => this.open(),
      );
    show();
  }
  tokenScope(limits, back) {
    const show = () =>
      this.menu(
        this.text('tokensTitle'),
        [
          { label: this.text('back'), value: 'back' },
          ...(limits.tokens.length < 16 ? [{ label: this.text('tokenAdd'), value: 'add' }] : []),
          ...limits.tokens.map((token, index) => ({
            label: `${token.symbol || token.address} · ${token.chainId === 8453 ? 'Base' : 'Base Sepolia'}`,
            value: index,
          })),
        ],
        (choice) => {
          if (choice === 'back') return back();
          if (choice === 'add')
            return this.menu(
              this.text('tokenAdd'),
              [
                { label: this.text('back'), value: 'back' },
                ...tokenPresets.map((p, i) => ({
                  label: `${p.symbol} · ${p.chainId === 8453 ? 'Base' : 'Base Sepolia'}`,
                  value: i,
                })),
                { label: this.text('tokenCustom'), value: 'custom' },
              ],
              (preset) => {
                if (preset === 'back') return show();
                const token = Object.fromEntries(
                  tokenFields.map((field) => [field.name, structuredClone(field.initial)]),
                );
                if (preset !== 'custom') Object.assign(token, tokenPresets[preset]);
                limits.tokens.push(token);
                return edit(limits.tokens.length - 1);
              },
              this.text('tokensHint'),
              show,
            );
          return edit(choice);
        },
        this.text('tokensHint'),
        back,
      );
    const edit = (index) => {
      const token = limits.tokens[index];
      return this.menu(
        token.symbol || this.text('tokenCustom'),
        [
          { label: this.text('back'), value: 'back' },
          { label: this.text('tokenRemove'), value: 'remove' },
          ...tokenFields.map((field) => ({
            label: this.text(field.name) + ' · ' + this.policyValue(field, token[field.name]),
            value: field.name,
          })),
        ],
        (choice) => {
          if (choice === 'back') return show();
          if (choice === 'remove') {
            limits.tokens.splice(index, 1);
            return show();
          }
          const field = tokenFields.find((f) => f.name === choice);
          if (field.kind === 'toggle') {
            token[choice] = !token[choice];
            return edit(index);
          }
          if (field.kind === 'chain')
            return this.menu(
              this.text('chainId'),
              [
                { label: 'Base · 8453', value: 8453 },
                { label: 'Base Sepolia · 84532', value: 84532 },
              ],
              (value) => {
                token[choice] = value;
                return edit(index);
              },
              '',
              () => edit(index),
            );
          return this.input(
            this.text(choice),
            (value) => {
              token[choice] = field.kind === 'count' ? Number(value) : value;
              return edit(index);
            },
            {
              value: Array.isArray(token[choice])
                ? token[choice].join(', ')
                : String(token[choice]),
              back: () => edit(index),
            },
          );
        },
        this.text('tokensHint'),
        show,
      );
    };
    show();
  }
  async history(offset = 0, pending = false) {
    const result = await this.call('history', {
      offset,
      limit: 20,
      ...(pending ? { status: 'approval-required' } : {}),
    });
    const options = [
      { label: this.text('back'), value: 'back' },
      ...result.items.map((intent) => ({
        label: `${intent.network} · ${intent.valueEth} ETH · ${this.status(intent.status)} · ${intent.transaction.to.slice(0, 10)}…`,
        value: intent.id,
      })),
    ];
    if (offset) options.push({ label: this.text('previous'), value: 'previous' });
    if (result.next !== null) options.push({ label: this.text('next'), value: 'next' });
    this.menu(
      this.text(pending ? 'pending' : 'history'),
      options,
      (action) => {
        if (action === 'back') return this.open();
        if (action === 'previous') return this.history(Math.max(0, offset - 20), pending);
        if (action === 'next') return this.history(result.next, pending);
        return this.inspect(action, 0, () => this.history(offset, pending));
      },
      `${offset} / ${result.total}`,
    );
  }
  async inspect(id, offset = 0, back = () => this.open(), raw = false) {
    const intent = await this.call('intent.inspect', { id });
    const { calldata, ...description } = intent.description;
    const details = JSON.stringify(
      {
        network: intent.network,
        address: intent.address,
        to: intent.transaction.to,
        valueEth: intent.valueEth,
        nonce: intent.transaction.nonce,
        gasLimit: intent.transaction.gasLimit,
        maxFeePerGas: intent.transaction.maxFeePerGas,
        maxPriorityFeePerGas: intent.transaction.maxPriorityFeePerGas,
        expiresAt: intent.expiresAt ? new Date(intent.expiresAt).toLocaleString() : undefined,
        executionFeeMaxWei: intent.executionFeeMaxWei,
        l1FeeEstimateWei: intent.l1FeeEstimateWei,
        status: this.status(intent.status),
        error: intent.error ? this.status(intent.error) : undefined,
        broadcast:
          intent.submissionMayHaveOccurred === false
            ? this.status('broadcast-not-sent')
            : intent.status === 'submit-unknown'
              ? this.status('broadcast-unknown')
              : undefined,
        description: { ...description, kind: this.status(String(description.kind)) },
        hash: intent.hash,
        ...(intent.replacementOf
          ? { warning: this.text('replacementWarning'), previousHash: intent.replacementOf }
          : {}),
      },
      null,
      2,
    );
    const options = [
      { label: this.text('back'), value: 'back' },
      { label: this.text('data'), value: 'data' },
    ];
    if (raw && offset) options.push({ label: this.text('previous'), value: 'previous' });
    if (raw && offset + 1600 < intent.transaction.data.length)
      options.push({ label: this.text('next'), value: 'next' });
    if (intent.status === 'approval-required')
      options.push(
        { label: this.text('deny'), value: 'deny' },
        ...(!intent.emergencyBlocked
          ? [
              {
                label: this.text(intent.replacementOf ? 'replacementApprove' : 'approved'),
                value: 'approve',
              },
            ]
          : []),
      );
    if (
      (intent.hash || intent.status === 'signing-unknown') &&
      intent.submissionMayHaveOccurred !== false
    )
      options.push({ label: this.text('reconcile'), value: 'reconcile' });
    this.menu(
      this.text('details'),
      options,
      async (action) => {
        if (action === 'back') return back();
        if (action === 'data') return this.inspect(id, 0, back, true);
        if (action === 'next' || action === 'previous')
          return this.inspect(
            id,
            Math.max(0, offset + (action === 'next' ? 1600 : -1600)),
            back,
            true,
          );
        await this.call('intent.' + action, {
          id,
          digest: intent.digest,
          ...(action === 'approve' && intent.replacementOf
            ? { replacementOf: intent.replacementOf }
            : {}),
        });
        this.notify(this.text('ready'));
        return back();
      },
      raw
        ? `${offset} / ${intent.transaction.data.length}\n${intent.transaction.data.slice(offset, offset + 1600)}`
        : details,
      back,
    );
  }
}
module.exports = { WalletBrowser, labels };
