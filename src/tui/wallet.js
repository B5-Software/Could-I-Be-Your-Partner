/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { chainLabel } = require('../shared/wallet-chain');
const { LineEditor } = require('./editor');
const networkLabels = require('../shared/wallet-network-labels.json');
const appLabels = require('../shared/wallet-app-labels.json');
const browserLabels = require('../shared/wallet-browser-labels.json');
const messageLabels = require('../shared/wallet-message-labels.json');
const { TuiWalletMessages } = require('./wallet-messages');
const { TuiWalletApps } = require('./wallet-apps');
const { TuiWalletBrowser } = require('./wallet-browser');
const { TuiWalletNetworks } = require('./wallet-networks');
const { getLanguage } = require('./text');
const statuses = require('../shared/wallet-status.json');
const emergencyLabels = require('../shared/wallet-emergency-labels.json');
const exchangeLabels = require('../shared/quant-exchange-labels.json');
const securityLabels = require('../shared/wallet-security-labels.json');
const allowanceLabels = require('../shared/wallet-allowance-labels.json');
const assetLabels = require('../shared/wallet-assets-labels.json');
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
    ...networkLabels['zh-CN'],
    ...appLabels['zh-CN'],
    ...browserLabels['zh-CN'],
    ...messageLabels['zh-CN'],
    ...securityLabels['zh-CN'],
    ...allowanceLabels['zh-CN'],
    ...assetLabels['zh-CN'],
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
    fee: '每笔估算费用上限（原生币，0 表示不限）',
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
    ...networkLabels.en,
    ...appLabels.en,
    ...browserLabels.en,
    ...messageLabels.en,
    ...allowanceLabels.en,
    ...assetLabels.en,
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
    fee: 'Estimated fee cap per transaction (native coin; 0 is unlimited)',
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
    ...networkLabels.de,
    ...appLabels.de,
    ...browserLabels.de,
    ...messageLabels.de,
    ...allowanceLabels.de,
    ...assetLabels.de,
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
    fee: 'Geschätztes Gebührenlimit je Transaktion (native coin; 0 unbegrenzt)',
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
    const language = getLanguage();
    return (
      (statuses[language] || statuses['zh-CN'])[value] ||
      (exchangeLabels[language] || exchangeLabels.zh)[value] ||
      value
    );
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
    if (this.app._disposed) return;
    const overview = this.app.state.modal?.walletOverview ? this.app.state.modal : null;
    const exchangeChanged =
      JSON.stringify(data.emergency?.exchangeCancel) !==
      JSON.stringify(this.emergency?.exchangeCancel);
    const appRequests = data.appRequests ?? [];
    if (appRequests.some((id) => !this.seenApps?.has(id))) this.notify(this.text('appsWaiting'));
    this.seenApps = new Set(appRequests);
    const browsers = data.browserRequests ?? [];
    if (browsers.some((id) => !this.seenBrowsers?.has(id))) this.notify(this.text('wbWaiting'));
    this.seenBrowsers = new Set(browsers);
    const messages = data.messageRequests ?? [];
    if (messages.some((id) => !this.seenMessages?.has(id))) this.notify(this.text('msgWaiting'));
    this.seenMessages = new Set(messages);
    if (data.emergency?.halted && !this.emergency?.halted) {
      this.disposeSensitive();
      this.notify(this.text('esStopped'));
    }
    this.emergency = data.emergency;
    const pending = data.intents.filter((intent) => intent.status === 'approval-required');
    if (pending.some((intent) => !this.seen.has(intent.id))) this.notify(this.text('waiting'));
    this.seen = new Set(pending.map((intent) => intent.id));
    if (overview && exchangeChanged) {
      const value = overview.options[overview.selected]?.value;
      this.showOverview(data);
      const selected = this.app.state.modal.options.findIndex(
        (option) => option.value === value || (value?.id && option.value?.id === value.id),
      );
      if (selected >= 0) this.app.state.modal.selected = selected;
    }
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
    if (!this.app._disposed) this.showOverview(data);
  }
  showOverview(data) {
    this.emergency = data.emergency;
    const exchange = data.emergency?.exchangeCancel;
    const exchangeTitle =
      exchange &&
      this.text(
        exchange.phase === 'running'
          ? 'esExchangeRunning'
          : exchange.phase === 'complete'
            ? 'esExchangeComplete'
            : 'esExchangeAttention',
      );
    const exchangeCounts =
      exchange?.targeted !== undefined &&
      this.text('esExchangeCounts')
        .replace('{canceled}', String(exchange.canceled))
        .replace('{targeted}', String(exchange.targeted))
        .replace('{remaining}', String(exchange.remaining));
    const options = [
      { label: this.text('close'), value: 'close' },
      ...data.wallets.map((wallet) => ({
        label: `${wallet.name} · ${this.text(wallet.kind === 'watch' ? 'watchAccount' : wallet.unlocked ? 'unlocked' : 'locked')} · ${wallet.address.slice(0, 8)}…`,
        value: wallet,
      })),
      {
        label: `${this.text('pending')} · ${data.intents.filter((i) => i.status === 'approval-required').length}`,
        value: 'pending',
      },
      { label: this.text('history'), value: 'history' },
      { label: this.text('networks'), value: 'networks' },
      { label: this.text('appsTitle'), value: 'apps' },
      { label: this.text('wbTitle'), value: 'browser' },
      { label: this.text('msgTitle'), value: 'messages' },
      { label: this.text('portfolioTitle'), value: 'portfolios' },
      { label: this.text('agentScopesTitle'), value: 'agent-scopes' },
      ...(data.wallets.some((w) => w.portfolioBlocked)
        ? [{ label: this.text('portfolioRecover'), value: 'portfolio-recover' }]
        : []),
      { label: this.text('create'), value: 'create' },
      { label: this.text('import'), value: 'import' },
      { label: this.text('watchAdd'), value: 'watch-add' },
      {
        label: this.text(
          data.emergency?.halted
            ? data.emergency.storageError || data.emergency.nativePauseError
              ? 'esRetry'
              : data.emergency.nativePausePending
                ? 'esPending'
                : exchange?.phase === 'running'
                  ? 'esExchangeRunning'
                  : 'esReset'
            : 'esHaltWithExchange',
        ),
        value:
          data.emergency?.halted && !data.emergency.storageError && !data.emergency.nativePauseError
            ? data.emergency.nativePausePending || exchange?.phase === 'running'
              ? 'emergency-refresh'
              : 'emergency-reset'
            : 'emergency-stop',
      },
      ...(data.emergency?.halted &&
      !data.emergency.storageError &&
      exchange?.phase !== 'running' &&
      exchange?.phase !== 'complete'
        ? [
            {
              label: this.text(exchange ? 'esExchangeRetry' : 'esExchangeCancel'),
              value: 'emergency-cancel-exchange',
            },
          ]
        : []),
    ];
    this.menu(
      this.text('title'),
      options,
      async (value) => {
        if (value === 'close') return;
        if (value === 'networks') return new TuiWalletNetworks(this).open();
        if (value === 'apps') return new TuiWalletApps(this).open();
        if (value === 'browser') return new TuiWalletBrowser(this).open();
        if (value === 'messages') return new TuiWalletMessages(this).open();
        if (value === 'portfolios') return new TuiWalletPortfolios(this).open();
        if (value === 'agent-scopes') return new TuiWalletAgentScopes(this).open();
        if (value === 'portfolio-recover') return new TuiWalletPortfolios(this).recover();
        if (value === 'emergency-refresh') return this.open();
        if (value === 'emergency-stop') {
          try {
            await this.call('emergency.halt', {
              expectedGeneration: data.emergency?.generation,
              cancelExchangeOrders: true,
            });
          } finally {
            await this.open();
          }
          return;
        }
        if (value === 'emergency-cancel-exchange') {
          await this.call('emergency.cancelExchange', {
            expectedGeneration: data.emergency?.generation,
          });
          return this.open();
        }
        if (value === 'emergency-reset') return this.resetEmergency();
        if (value === 'pending' || value === 'history') return this.history(0, value === 'pending');
        if (value === 'create' || value === 'import') return this.credentials(value);
        if (value === 'watch-add') return this.watchAccount();
        return this.account(value);
      },
      data.emergency?.halted
        ? [
            this.text('esStopped'),
            this.text('esResidual'),
            this.text('esReconcile') + ': ' + data.emergency.needsReconciliation,
            data.emergency.nativePausePending ? this.text('esPending') : '',
            exchangeTitle,
            exchangeCounts,
            exchange?.error && this.status(exchange.error),
            this.status(data.emergency.storageError || data.emergency.nativePauseError || ''),
          ]
            .filter(Boolean)
            .join('\n')
        : this.text('esExchangeHint'),
      () => {},
    );
    this.app.state.modal.walletOverview = true;
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
        { label: this.text('assetsTitle'), value: 'balance' },
        ...(wallet.unlocked && wallet.kind !== 'watch'
          ? [{ label: this.text('networkSend'), value: 'send' }]
          : []),
        { label: this.text('allowances'), value: 'allowances' },
        { label: this.text('usageTitle'), value: 'usage' },
        { label: this.text('changePassword'), value: 'password-change' },
        {
          label: this.text(wallet.policy.mode === 'autonomous' ? 'revoke' : 'automatic'),
          value: wallet.policy.mode === 'autonomous' ? 'revoke' : 'automatic',
        },
        ...(wallet.kind === 'watch'
          ? [
              { label: this.text('watchImport'), value: 'watch-import' },
              { label: this.text('watchRemove'), value: 'watch-remove' },
            ]
          : []),
      ].filter(
        (option) =>
          (wallet.kind !== 'watch' ||
            ['back', 'balance', 'allowances', 'watch-import', 'watch-remove'].includes(
              option.value,
            )) &&
          (!this.emergency?.halted ||
            [
              'back',
              'balance',
              'allowances',
              'password-change',
              'usage',
              'watch-import',
              'watch-remove',
            ].includes(option.value)),
      ),
      async (action) => {
        if (action === 'back') return this.open();
        if (action === 'send') return new TuiWalletNetworks(this).send(wallet);
        if (action === 'watch-import') return this.credentials('import', wallet);
        if (action === 'watch-remove')
          return this.menu(
            this.text('watchRemove'),
            [
              { label: this.text('back'), value: false },
              { label: this.text('watchRemove'), value: true },
            ],
            async (remove) => {
              if (!remove) return this.account(wallet);
              await this.call('watch.remove', { id: wallet.id });
              return this.open();
            },
            `${wallet.name}\n${wallet.address}\n${this.text('watchRemoveHint')}`,
            () => this.account(wallet),
          );
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
        if (action === 'allowances') return this.allowances(wallet);
        if (action === 'balance') return this.assets(wallet);
        if (action === 'automatic') return this.authorization(wallet);
      },
      wallet.address +
        (wallet.policy.inactiveNetworks?.length
          ? '\n\n' +
            this.text('networkGrantStale') +
            ' ' +
            wallet.policy.inactiveNetworks.join(' / ')
          : ''),
    );
  }
  watchAccount() {
    return this.input(
      this.text('name'),
      (name) =>
        this.input(
          this.text('walletAddress'),
          async (address) => {
            await this.call('watch.add', { name: name.trim(), address: address.trim() });
            return this.open();
          },
          { back: () => this.open() },
        ),
      { back: () => this.open() },
    );
  }
  assets(wallet) {
    const networks = async () => {
      const { items } = await this.call('network.list');
      return this.menu(
        this.text('network'),
        items.map((p) => ({ label: `${p.name} · ${p.id} · ${p.nativeSymbol}`, value: p.key })),
        (chain) => load(chain),
        this.text('assetsHint'),
        () => this.account(wallet),
      );
    };
    const load = async (chain) => {
      const snapshot = await this.call('assets', { id: wallet.id, chain });
      const back = () => load(chain);
      const rows = snapshot.assets.map((asset) =>
        [
          `${asset.symbol || this.text('assetUnknown')} · ${asset.error ? this.text('assetFailed') : (asset.amount ?? `${asset.amountAtomic} ${this.text('assetAtomic')}`)}`,
          asset.address,
          asset.metadataError ? this.text('assetMetadata') : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return this.menu(
        this.text('assetsTitle'),
        [
          { label: this.text('back'), value: 'back' },
          { label: this.text('assetRefresh'), value: 'refresh' },
          { label: this.text('assetDiscover'), value: 'discover' },
          { label: this.text('assetTrack'), value: 'track' },
          ...snapshot.trackedTokens.map((token) => ({
            label: `${this.text('assetUntrack')} · ${token}`,
            value: token,
          })),
        ],
        async (action) => {
          if (action === 'back') return networks();
          if (action === 'refresh') return back();
          if (action === 'discover') return this.discoverAssets(wallet.id, chain, back);
          if (action === 'track')
            return this.input(
              this.text('allowanceToken'),
              async (token) => {
                await this.call('asset.track', { id: wallet.id, chain, token: token.trim() });
                return back();
              },
              { back },
            );
          await this.call('asset.untrack', { id: wallet.id, chain, token: action });
          return back();
        },
        `${snapshot.network} · ${this.text('assetBlock')} #${snapshot.block}\n${rows.join('\n\n')}`,
        networks,
      );
    };
    return networks();
  }
  async discoverAssets(id, chain, back, blocks = 256, cursor = {}, offset = 0) {
    const t = (key) => this.text(key);
    const title = t('assetDiscover');
    const limit = 8;
    const changeWindow = (onBack, range) =>
      this.input(
        t('assetDiscoverWindow'),
        (value) => {
          const size = Number(value);
          if (!Number.isInteger(size) || size < 1 || size > 2000)
            throw Error('WALLET_DISCOVERY_RANGE');
          return this.discoverAssets(id, chain, back, size, range);
        },
        { value: String(blocks), back: onBack },
      );
    let report;
    try {
      report = await this.call('asset.discover', { id, chain, blocks, limit, offset, ...cursor });
    } catch (error) {
      return this.menu(
        title,
        [
          { label: t('assetDiscoverWindow'), value: 'window' },
          { label: t('assetDiscoverScan'), value: 'latest' },
          { label: t('back'), value: 'back' },
        ],
        (action) =>
          action === 'window'
            ? changeWindow(back, {
                anchorBlock: cursor.anchorBlock,
                anchorHash: cursor.anchorHash,
                endBlock: cursor.endBlock,
              })
            : action === 'latest'
              ? this.discoverAssets(id, chain, back, blocks)
              : back(),
        this.status(error.message),
        back,
      );
    }
    const anchor = { anchorBlock: report.anchorBlock, anchorHash: report.anchorHash };
    const current = { ...anchor, endBlock: report.toBlock, snapshotId: report.snapshotId };
    const page = (start = offset) => this.discoverAssets(id, chain, back, blocks, current, start);
    const balance = (row) =>
      row.error ? t('assetFailed') : (row.amount ?? `${row.amountAtomic} ${t('assetAtomic')}`);
    const rowView = (row) =>
      this.menu(
        row.symbol || t('assetUnknown'),
        [
          { label: t('back'), value: 'back' },
          ...(!row.tracked && !row.error && row.amountAtomic !== '0'
            ? [{ label: t('assetTrack'), value: 'track' }]
            : []),
        ],
        async (operation) => {
          if (operation === 'track')
            await this.call('asset.track', {
              id,
              chain,
              token: row.token,
              expectedNetworkRevision: report.networkRevision,
            });
          return page();
        },
        [
          row.token,
          balance(row),
          `#${row.block} · ${t('assetDiscoverReceived')} ${row.received} · ${t('assetDiscoverSent')} ${row.sent}`,
          row.tracked ? t('assetDiscoverTracked') : '',
        ]
          .filter(Boolean)
          .join('\n'),
        page,
      );
    return this.menu(
      title,
      [
        { label: t('back'), value: 'back' },
        { label: t('assetDiscoverWindow'), value: 'window' },
        { label: t('assetDiscoverScan'), value: 'latest' },
        ...report.items.map((row) => ({
          label: `${row.symbol || row.token} · ${balance(row)}`,
          value: row,
        })),
        ...(offset ? [{ label: t('previous'), value: 'previous' }] : []),
        ...(report.next !== null ? [{ label: t('next'), value: 'next' }] : []),
        ...(report.nextEndBlock !== null
          ? [{ label: t('assetDiscoverOlder'), value: 'older' }]
          : []),
      ],
      (value) => {
        if (value === 'back') return back();
        if (value === 'window')
          return changeWindow(() => page(), { ...anchor, endBlock: report.toBlock });
        if (value === 'latest') return this.discoverAssets(id, chain, back, blocks);
        if (value === 'previous') return page(Math.max(0, offset - limit));
        if (value === 'next') return page(report.next);
        if (value === 'older')
          return this.discoverAssets(id, chain, back, blocks, {
            ...anchor,
            endBlock: report.nextEndBlock,
          });
        return rowView(value);
      },
      `${t('assetDiscoverRange')} #${report.fromBlock}–#${report.toBlock} · ${t('assetBlock')} #${report.anchorBlock}\n${report.items.length ? `${offset + 1}–${offset + report.items.length} / ${report.total}` : t('assetDiscoverEmpty')}`,
      back,
    );
  }
  allowances(wallet, selection, onBack) {
    const back = onBack || (() => this.account(wallet));
    const protocolInput = (layered) => (layered ? { protocol: 'permit2' } : {});
    const check = async (chain, layered, token, spender, onBack) => {
      const result = await this.call('allowance.inspect', {
        id: wallet.id,
        chain,
        token: token.trim(),
        spender: spender.trim(),
        ...protocolInput(layered),
      });
      const display = (value, atomic) =>
        result.symbol ? `${value} ${result.symbol}` : `${atomic} ${this.text('allowanceAtomic')}`;
      const amount = display(result.amount, result.amountAtomic);
      const layers = result.permit2;
      const expiry = layers ? new Date(layers.expiration * 1000) : null;
      const summary = [
        result.network,
        result.token,
        result.spender,
        result.unlimited ? `${this.text('allowanceUnlimited')} (${amount})` : amount,
        ...(layers
          ? [
              `${this.text('allowancePermit2Outer')} ${display(layers.tokenAllowance, layers.tokenAllowanceAtomic)}`,
              `${this.text('allowancePermit2Effective')} ${display(layers.effectiveAmount, layers.effectiveAmountAtomic)}`,
              `${this.text('allowancePermit2Expiry')} ${Number.isNaN(expiry.getTime()) ? layers.expiration + ' (Unix)' : expiry.toLocaleString()}${layers.expired ? ` · ${this.text('allowancePermit2Expired')}` : ''} · Nonce ${layers.nonce}`,
            ]
          : []),
        `${this.text('allowanceBlock')} #${result.block} · ${new Date(result.observedAt).toLocaleString()}`,
      ].join('\n');
      return this.menu(
        this.text('allowances'),
        [
          { label: this.text('back'), value: 'back' },
          ...(wallet.unlocked && !this.emergency?.halted && result.amountAtomic !== '0'
            ? [{ label: this.text('allowancePrepare'), value: 'revoke' }]
            : []),
          ...(wallet.unlocked && !this.emergency?.halted && layers?.nextNonce
            ? [{ label: this.text('permit2OrderedPrepare'), value: 'ordered' }]
            : []),
        ],
        async (action) => {
          if (action === 'back') return onBack();
          const intent = await this.call(
            action === 'ordered' ? 'permit2.ordered.prepare' : 'allowance.revoke.prepare',
            {
              id: wallet.id,
              chain,
              token: result.token,
              spender: result.spender,
              ...(action === 'ordered'
                ? { commandId: result.commandId + ':nonce', nonce: layers.nonce }
                : { commandId: result.commandId, ...protocolInput(layered) }),
            },
          );
          return this.inspect(intent.id, 0, onBack);
        },
        summary,
        onBack,
      );
    };
    const scan = async (chain, layered, blocks, cursor) => {
      const page = await this.call('allowance.discover', {
        id: wallet.id,
        chain,
        blocks,
        limit: 8,
        ...protocolInput(layered),
        ...cursor,
      });
      const render = () =>
        this.menu(
          this.text('allowanceDiscover'),
          [
            { label: this.text('back'), value: 'back' },
            ...page.items.map((pair) => ({
              label: `${pair.token} → ${pair.spender} · #${pair.block}`,
              value: pair,
            })),
            ...(page.nextOffset !== null ? [{ label: this.text('next'), value: 'next' }] : []),
            ...(page.nextOffset === null && page.nextEndBlock !== null
              ? [{ label: this.text('allowanceHistoryOlder'), value: 'older' }]
              : []),
          ],
          (selection) => {
            if (selection === 'back') return actions(chain, layered);
            if (selection === 'next')
              return scan(chain, layered, blocks, {
                endBlock: page.toBlock,
                anchorHash: page.anchorHash,
                offset: page.nextOffset,
              });
            if (selection === 'older')
              return scan(chain, layered, blocks, { endBlock: page.nextEndBlock });
            return check(chain, layered, selection.token, selection.spender, render);
          },
          [
            `${this.text('allowanceHistoryRange')} ${page.fromBlock}–${page.toBlock} · ${page.total}`,
            page.items.length
              ? this.text(layered ? 'allowancePermit2History' : 'allowanceHistoryHint')
              : this.text('allowanceHistoryEmpty'),
          ].join('\n'),
          () => actions(chain, layered),
        );
      return render();
    };
    const actions = (chain, layered = false) =>
      this.menu(
        `${this.text('allowances')} · ${layered ? 'Permit2' : 'ERC-20'}`,
        [
          { label: this.text('back'), value: 'back' },
          { label: this.text('allowanceRead'), value: 'read' },
          { label: this.text('allowanceDiscover'), value: 'history' },
          {
            label: `${this.text('allowanceProtocol')} → ${layered ? 'ERC-20' : 'Permit2'}`,
            value: 'switch',
          },
          ...(layered ? [{ label: this.text('permit2SignatureTitle'), value: 'signature' }] : []),
        ],
        (action) => {
          const returnHere = () => actions(chain, layered);
          if (action === 'back') return back();
          if (action === 'switch') return actions(chain, !layered);
          if (action === 'signature') return this.permit2Signatures(wallet, chain, returnHere);
          if (action === 'history')
            return this.input(
              this.text('allowanceHistoryEnd'),
              (end) =>
                this.input(
                  this.text('allowanceHistoryBlocks'),
                  (count) =>
                    scan(
                      chain,
                      layered,
                      Number(count.trim()),
                      end.trim() ? { endBlock: end.trim() } : {},
                    ),
                  { value: '1000', back: returnHere },
                ),
              { back: returnHere },
            );
          return this.input(
            this.text('allowanceToken'),
            (token) =>
              this.input(
                this.text('allowanceSpender'),
                (spender) => check(chain, layered, token, spender, returnHere),
                { back: returnHere },
              ),
            { back: returnHere },
          );
        },
        this.text('allowanceHint'),
        back,
      );
    if (selection)
      return check(
        selection.chain,
        selection.protocol === 'permit2',
        selection.token,
        selection.spender,
        back,
      );
    return this.menu(
      this.text('network'),
      [
        { label: this.text('mainnet'), value: 'base' },
        { label: this.text('testnet'), value: 'base-sepolia' },
      ],
      (chain) => actions(chain),
      this.text('allowanceHint'),
      back,
    );
  }
  permit2Signatures(wallet, chain, back) {
    const enter = (value = '') =>
      this.input(
        this.text('permit2NonceInput'),
        async (input) => {
          const observation = await this.call('permit2.signature.inspect', {
            id: wallet.id,
            chain,
            nonce: input.trim(),
          });
          const retry = () => enter(input);
          return this.menu(
            this.text('permit2SignatureTitle'),
            [
              { label: this.text('back'), value: 'back' },
              ...(!observation.unavailable && wallet.unlocked && !this.emergency?.halted
                ? [{ label: this.text('permit2SignaturePrepare'), value: 'prepare' }]
                : []),
            ],
            async (action) => {
              if (action === 'back') return retry();
              const intent = await this.call('permit2.signature.prepare', {
                id: wallet.id,
                chain,
                nonce: observation.nonce,
                commandId: observation.commandId,
              });
              return this.inspect(intent.id, 0, retry);
            },
            [
              observation.network,
              `Nonce ${observation.nonce} · ${this.text('allowanceBlock')} #${observation.block}`,
              this.text(observation.unavailable ? 'permit2NonceUnavailable' : 'permit2NonceUnused'),
              this.text('permit2SignatureHint'),
            ].join('\n'),
            retry,
          );
        },
        { back, value },
      );
    return enter();
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
      [
        this.text('esScope'),
        this.text('esResetHint'),
        this.text('esResidual'),
        this.emergency?.exchangeCancel?.phase === 'attention'
          ? this.text('esExchangeResidual')
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
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
  credentials(kind, watch) {
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
        const result = await this.call(
          watch ? 'watch.import' : kind === 'create' ? 'create' : 'import',
          {
            name,
            password,
            secret,
            kind: format,
            sourcePassword,
            ...(watch ? { id: watch.id } : {}),
          },
        );
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
    const readPassword = (value) => {
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
    };
    if (watch) return readPassword(watch.name);
    this.input(this.text('name'), readPassword, { back: cancel });
  }
  async authorization(wallet) {
    const { items } = await this.call('network.list');
    const networks = items.filter((p) => !p.archived && p.capabilities.autonomous);
    this.menu(
      this.text('network'),
      [
        ...networks.map((p) => ({ label: `${p.name} · ${p.id}`, value: [p.id] })),
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
                      ' ' +
                      this.text('nativeQuantity') +
                      '\n\n' +
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
  async tokenScope(limits, back) {
    const { items } = await this.call('network.list');
    const show = () =>
      this.menu(
        this.text('tokensTitle'),
        [
          { label: this.text('back'), value: 'back' },
          ...(limits.tokens.length < 16 ? [{ label: this.text('tokenAdd'), value: 'add' }] : []),
          ...limits.tokens.map((token, index) => ({
            label: `${token.symbol || token.address} · ${chainLabel(token.chainId)}`,
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
                  label: `${p.symbol} · ${chainLabel(p.chainId)}`,
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
                ...items
                  .filter((p) => !p.archived)
                  .map((p) => ({ label: `${p.name} · ${p.id}`, value: p.id })),
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
        label: `${intent.network} · ${intent.valueEth} ${intent.nativeSymbol || 'ETH'} · ${this.status(intent.status)} · ${intent.transaction.to.slice(0, 10)}…`,
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
    const permitScope = {
      'permit2-lockdown': 'allowancePermit2Scope',
      'permit2-allowance-invalidate': 'permit2OrderedScope',
      'permit2-signature-invalidate': 'permit2SignatureScope',
    }[description.kind];
    const details = JSON.stringify(
      {
        network: intent.network,
        ...(intent.sourceApp ? { sourceApp: intent.sourceApp } : {}),
        chainId: intent.chainId,
        nativeSymbol: intent.nativeSymbol || 'ETH',
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
        operatorFeeEstimateWei: intent.operatorFeeEstimateWei || '0',
        additionalFeeReserveWei: intent.additionalFeeReserveWei || '0',
        status: this.status(intent.status),
        error: intent.error ? this.status(intent.error) : undefined,
        allowanceCeiling: intent.portfolioAllowanceRisk,
        broadcast:
          intent.submissionMayHaveOccurred === false
            ? this.status('broadcast-not-sent')
            : intent.status === 'submit-unknown'
              ? this.status('broadcast-unknown')
              : undefined,
        description: { ...description, kind: this.status(String(description.kind)) },
        ...(permitScope ? { allowance: this.text(permitScope) } : {}),
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
        ...(!intent.emergencyBlocked && !intent.networkBlocked
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
