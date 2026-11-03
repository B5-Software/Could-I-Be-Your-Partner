import securityLabels from '../../shared/wallet-security-labels.json';
import policyLabels from '../../shared/wallet-policy-labels.json';
import tokenLabels from '../../shared/wallet-token-labels.json';
import { WalletScopeEditor } from './wallet-scope-editor';
import { WalletPortfolioPanel } from './wallet-portfolios';
import portfolioLabels from '../../shared/wallet-portfolio-labels.json';
import periodLabels from '../../shared/wallet-period-labels.json';
import { periodNote, openPeriodHistory } from './wallet-periods';
import agentScopeLabels from '../../shared/wallet-agent-scope-labels.json';
import { WalletAgentScopePanel } from './wallet-agent-scopes';
import { walletBudget, type WalletBudgetSnapshot } from '../../shared/wallet-budget';
import { executionPercent } from '../../shared/quant-execution-format';
/* SPDX-License-Identifier: GPL-3.0-or-later */
import rawStatuses from '../../shared/wallet-status.json';
import emergencyLabels from '../../shared/wallet-emergency-labels.json';
import type { WalletEmergency } from '../../shared/wallet-emergency-types';
import { executionAmount } from '../../shared/quant-execution-format';
const statuses: Record<string, Record<string, string>> = rawStatuses;
export function walletStatus(language: string, status: string): string {
  const key = language.startsWith('de') ? 'de' : language.startsWith('en') ? 'en' : 'zh-CN';
  return statuses[key]![status] || status;
}
export type WalletIntent = {
  emergencyBlocked?: boolean;
  id: string;
  walletId: string;
  address: string;
  digest: string;
  status: string;
  chainId: number;
  network: string;
  valueEth: string;
  executionFeeMaxWei: string;
  l1FeeEstimateWei: string;
  hash?: string;
  replacementOf?: string | null;
  submissionMayHaveOccurred?: boolean;
  error?: string;
  workspaceId?: string;
  description: Record<string, unknown>;
  transaction: { to: string; data: string; value: string };
  authorization: { mode: string };
  createdAt: number;
  expiresAt?: number;
};
type Wallet = {
  id: string;
  name: string;
  address: string;
  unlocked: boolean;
  portfolioBlocked?: boolean;
  policy: {
    mode: string;
    chains: number[];
    expiresAt?: number;
    maxFeeEth?: string;
    limits?: Record<string, unknown>;
  };
};
type Options = {
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => unknown;
  language: () => string;
};
const zh = {
  ...securityLabels['zh-CN'],
  ...policyLabels['zh-CN'],
  ...tokenLabels['zh-CN'],
  ...portfolioLabels['zh-CN'],
  ...periodLabels['zh-CN'],
  ...agentScopeLabels['zh-CN'],
  ...emergencyLabels.zh,
  title: '原生钱包',
  hint: '在本机创建或导入钱包。加密密钥由独立签名进程使用，不进入模型上下文。',
  create: '创建钱包',
  import: '导入钱包',
  unlock: '解锁',
  lock: '锁定',
  backup: '导出加密备份',
  empty: '尚未添加钱包',
  name: '钱包名称',
  password: '本地钱包密码（至少 12 个字符）',
  kind: '导入格式',
  key: '私钥',
  phrase: '助记词',
  keystore: '加密 Keystore JSON',
  secret: '钱包密钥材料',
  sourcePassword: '原 Keystore 密码（留空使用上方密码）',
  cancel: '取消',
  save: '保存',
  close: '关闭',
  unlocked: '已解锁',
  locked: '已锁定',
  duration: '解锁时长',
  minutes: '15 分钟',
  hour: '1 小时',
  session: '直到关闭后台',
  manual: '默认逐笔实盘授权',
  automatic: 'Agent 全自动实盘权限',
  enable: '授权全自动实盘',
  revoke: '撤销自动实盘权限',
  scope: '网络范围',
  mainnet: 'Base 主网 · 8453',
  testnet: 'Base Sepolia · 84532',
  both: 'Base 主网与 Sepolia',
  expiry: '权限有效期',
  oneHour: '1 小时',
  day: '24 小时',
  forever: '直到手动撤销',
  fee: '每笔估算费用上限（ETH；0 表示不限）',
  warningTitle: '允许 Agent 连续操作真实资产',
  warning:
    '此权限允许 Agent 在选定钱包和网络中连续转账、兑换、调用合约和授权代币，无需每笔确认。可能损失全部资产，链上操作通常无法撤回。\n\n合约授权可能在撤销本应用权限后仍然有效。撤销权限不能撤回已经广播的交易。费用中的 L1 部分是估算值，不是链上保证的最大费用。\n\n此操作不会自动解锁钱包，不会扩大到其他钱包或网络。普通自动批准、任务 Goal 和其他 Agent 均不能开启此权限。',
  read: '我已阅读，继续',
  confirm: '确认授权',
  type: '输入 ALLOW LIVE 完成二次确认',
  backupTitle: '请离线保存助记词',
  backupHint: '只显示这一次。不要发到聊天中，也不要交给 Agent。关闭后清除此页面中的明文。',
  history: '实盘交易历史',
  none: '尚无实盘交易',
  approve: '授权并签名',
  deny: '拒绝',
  reconcile: '对账',
  native: '真实资产',
  pending: '等待实盘授权',
  feeEstimate: 'L2 最高执行费 + L1 估算费（ETH）',
  balance: '读取 Base 余额',
  network: '网络',
  status: '状态',
  to: '目标地址',
  value: 'ETH 数额',
  error: '钱包操作失败',
  saved: '钱包配置已保存',
  noSecrets: '私钥、助记词和密码仅在此页面输入。不要通过聊天发送。',
  insecure: '请使用本机页面、HTTPS 或受保护的 Tor 地址管理钱包。',
  previous: '上一页',
  next: '下一页',
  details: '交易详情',
  syncFailed: '钱包后台对账暂时失败，记录仍然保留。请检查节点或磁盘状态。',
};
type Key = keyof typeof zh;
const en: Record<Key, string> = {
  ...securityLabels.en,
  ...policyLabels.en,
  ...tokenLabels.en,
  ...portfolioLabels.en,
  ...periodLabels.en,
  ...agentScopeLabels.en,
  ...emergencyLabels.en,
  title: 'Native wallet',
  hint: 'Create or import locally. Encrypted keys are used by a separate signing process and never enter model context.',
  create: 'Create wallet',
  import: 'Import wallet',
  unlock: 'Unlock',
  lock: 'Lock',
  backup: 'Export encrypted backup',
  empty: 'No wallets yet',
  name: 'Wallet name',
  password: 'Local wallet password (12+ characters)',
  kind: 'Import format',
  key: 'Private key',
  phrase: 'Recovery phrase',
  keystore: 'Encrypted Keystore JSON',
  secret: 'Wallet key material',
  sourcePassword: 'Original Keystore password (blank uses the password above)',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  unlocked: 'Unlocked',
  locked: 'Locked',
  duration: 'Unlock duration',
  minutes: '15 minutes',
  hour: '1 hour',
  session: 'Until backend exits',
  manual: 'Per-transaction live approval by default',
  automatic: 'Autonomous live permission',
  enable: 'Authorize autonomous live',
  revoke: 'Revoke autonomous live',
  scope: 'Network scope',
  mainnet: 'Base Mainnet · 8453',
  testnet: 'Base Sepolia · 84532',
  both: 'Base Mainnet and Sepolia',
  expiry: 'Permission lifetime',
  oneHour: '1 hour',
  day: '24 hours',
  forever: 'Until revoked',
  fee: 'Estimated fee cap per transaction (ETH; 0 = unlimited)',
  warningTitle: 'Allow the Agent to operate real assets continuously',
  warning:
    'This permission allows continuous transfers, swaps, contract calls and token approvals on the selected wallet and networks without per-transaction confirmation. All assets may be lost; onchain actions are generally irreversible.\n\nContract approvals may remain valid after revoking application permission. Revocation cannot undo broadcasts. The L1 fee is an estimate, not a protocol-enforced maximum.\n\nThis does not unlock the wallet or authorize other accounts/networks. Generic auto-approve, goals and other Agents cannot enable this permission.',
  read: 'I have read this; continue',
  confirm: 'Confirm authorization',
  type: 'Type ALLOW LIVE for the second confirmation',
  backupTitle: 'Store the recovery phrase offline',
  backupHint:
    'Shown once only. Do not put it in chat or give it to an Agent. Closing clears this page.',
  history: 'Live transaction history',
  none: 'No live transactions yet',
  approve: 'Authorize and sign',
  deny: 'Deny',
  reconcile: 'Reconcile',
  native: 'Real assets',
  pending: 'Live approval required',
  feeEstimate: 'L2 maximum execution fee + estimated L1 fee (ETH)',
  balance: 'Read Base balance',
  network: 'Network',
  status: 'Status',
  to: 'Destination',
  value: 'ETH amount',
  error: 'Wallet action failed',
  saved: 'Wallet configuration saved',
  noSecrets: 'Enter keys, recovery phrases and passwords only here. Never send them through chat.',
  insecure: 'Manage wallets from a local page, HTTPS or a protected Tor address.',
  previous: 'Previous',
  next: 'Next',
  details: 'Transaction details',
  syncFailed:
    'Wallet background reconciliation is unavailable. Records are preserved; check the node or disk.',
};
const de: Record<Key, string> = {
  ...en,
  ...securityLabels.de,
  ...policyLabels.de,
  ...tokenLabels.de,
  ...portfolioLabels.de,
  ...periodLabels.de,
  ...agentScopeLabels.de,
  ...emergencyLabels.de,
  title: 'Native Wallet',
  hint: 'Wallet lokal erstellen oder importieren. Verschlüsselte Schlüssel werden in einem separaten Signierprozess verwendet und gelangen nicht in den Modellkontext.',
  create: 'Wallet erstellen',
  import: 'Wallet importieren',
  unlock: 'Entsperren',
  lock: 'Sperren',
  backup: 'Verschlüsseltes Backup exportieren',
  empty: 'Noch keine Wallets',
  name: 'Wallet-Name',
  password: 'Lokales Wallet-Passwort (mindestens 12 Zeichen)',
  kind: 'Importformat',
  key: 'Privater Schlüssel',
  phrase: 'Wiederherstellungsphrase',
  keystore: 'Verschlüsseltes Keystore-JSON',
  secret: 'Wallet-Schlüsselmaterial',
  sourcePassword: 'Ursprüngliches Keystore-Passwort (leer: obiges Passwort)',
  cancel: 'Abbrechen',
  save: 'Speichern',
  close: 'Schließen',
  unlocked: 'Entsperrt',
  locked: 'Gesperrt',
  duration: 'Entsperrdauer',
  minutes: '15 Minuten',
  hour: '1 Stunde',
  session: 'Bis das Backend endet',
  manual: 'Standardmäßig jede Live-Transaktion freigeben',
  automatic: 'Autonome Live-Berechtigung',
  enable: 'Autonomen Live-Handel autorisieren',
  revoke: 'Autonome Berechtigung widerrufen',
  scope: 'Netzwerkbereich',
  mainnet: 'Base Mainnet · 8453',
  testnet: 'Base Sepolia · 84532',
  both: 'Base Mainnet und Sepolia',
  expiry: 'Gültigkeit',
  oneHour: '1 Stunde',
  day: '24 Stunden',
  forever: 'Bis zum Widerruf',
  fee: 'Geschätztes Gebührenlimit pro Transaktion (ETH; 0 = unbegrenzt)',
  warningTitle: 'Agent darf echte Vermögenswerte fortlaufend verwenden',
  warning:
    'Diese Berechtigung erlaubt Überweisungen, Swaps, Vertragsaufrufe und Token-Freigaben im gewählten Wallet und Netzwerk ohne Einzelbestätigung. Alle Vermögenswerte können verloren gehen; Onchain-Aktionen sind normalerweise unumkehrbar.\n\nVertragsfreigaben können nach einem Widerruf dieser App-Berechtigung weiterhin gelten. Bereits gesendete Transaktionen lassen sich damit nicht zurücknehmen. Die L1-Gebühr ist eine Schätzung, kein garantiertes Protokolllimit.\n\nDas Wallet wird dadurch nicht entsperrt. Andere Konten und Netzwerke werden nicht freigegeben. Allgemeine automatische Freigaben, Goals und andere Agents können diese Berechtigung nicht aktivieren.',
  read: 'Gelesen; fortfahren',
  confirm: 'Autorisierung bestätigen',
  type: 'Zur zweiten Bestätigung ALLOW LIVE eingeben',
  backupTitle: 'Wiederherstellungsphrase offline sichern',
  backupHint:
    'Nur einmal angezeigt. Nicht im Chat senden oder an einen Agent weitergeben. Beim Schließen wird diese Seite geleert.',
  history: 'Live-Transaktionsverlauf',
  none: 'Noch keine Live-Transaktionen',
  approve: 'Autorisieren und signieren',
  deny: 'Ablehnen',
  reconcile: 'Abgleichen',
  native: 'Echte Vermögenswerte',
  pending: 'Live-Freigabe erforderlich',
  feeEstimate: 'Maximale L2-Ausführungsgebühr + geschätzte L1-Gebühr (ETH)',
  balance: 'Base-Guthaben lesen',
  network: 'Netzwerk',
  status: 'Status',
  to: 'Zieladresse',
  value: 'ETH-Betrag',
  error: 'Wallet-Aktion fehlgeschlagen',
  saved: 'Wallet-Konfiguration gespeichert',
  noSecrets:
    'Schlüssel, Wiederherstellungsphrasen und Passwörter nur hier eingeben, niemals im Chat.',
  insecure: 'Wallets nur lokal, über HTTPS oder eine geschützte Tor-Adresse verwalten.',
  previous: 'Zurück',
  next: 'Weiter',
  details: 'Transaktionsdetails',
  syncFailed:
    'Wallet-Abgleich ist vorübergehend nicht verfügbar. Einträge bleiben erhalten; Knoten oder Datenträger prüfen.',
};
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function walletText(language: string, key: Key): string {
  return (language.startsWith('de') ? de : language.startsWith('en') ? en : zh)[key];
}
export function approvalCard(intent: WalletIntent, language: string): string {
  const t = (key: Key) => walletText(language, key);
  if (intent.emergencyBlocked)
    return (
      '<article class="wallet-approval"><p class="wallet-warning">' +
      esc(t('esBlocked')) +
      '</p><details><summary>' +
      esc(t('details')) +
      '</summary><pre>' +
      esc(JSON.stringify(intent, null, 2)) +
      '</pre></details><button type="button" data-wallet-decision="deny" data-intent="' +
      esc(intent.id) +
      '" data-digest="' +
      esc(intent.digest) +
      '">' +
      esc(t('deny')) +
      '</button></article>'
    );
  const description = intent.description;
  const summary =
    description.kind === 'uniswap-v3-swap'
      ? `${description.amountIn} ${description.tokenIn} → ≥ ${description.minimumAmountOut} ${description.tokenOut}`
      : description.tokenAmount
        ? `${walletStatus(language, String(description.kind))} · ${description.tokenAmount} ${description.token}`
        : walletStatus(language, String(description.kind));
  const fee = executionAmount(
    (BigInt(intent.executionFeeMaxWei) + BigInt(intent.l1FeeEstimateWei)).toString(),
    18,
  );
  const completeDetails = {
    description: intent.description,
    transaction: intent.transaction,
    ...(intent.expiresAt ? { expiresAt: new Date(intent.expiresAt).toLocaleString() } : {}),
  };
  const replacement = intent.replacementOf
    ? `<p class="wallet-warning wallet-replacement">${esc(t('replacementWarning'))}<code>${esc(intent.replacementOf)}</code></p>`
    : '';
  return `<article class="wallet-approval"><header><span>${esc(t('native'))} · ${esc(intent.network)}</span><strong>${esc(t('pending'))}</strong></header>${replacement}<p class="wallet-action-summary">${esc(summary)}</p><dl><dt>${esc(t('to'))}</dt><dd>${esc(intent.transaction.to)}</dd><dt>${esc(t('value'))}</dt><dd>${esc(intent.valueEth)}</dd><dt>${esc(t('feeEstimate'))}</dt><dd>≈ ${esc(fee)}</dd></dl><details><summary>${esc(t('details'))}</summary><pre>${esc(JSON.stringify(completeDetails, null, 2))}</pre></details><footer><button type="button" data-wallet-decision="deny" data-intent="${intent.id}" data-digest="${intent.digest}">${esc(t('deny'))}</button><button type="button" class="wallet-live-button" data-wallet-decision="approve" data-intent="${intent.id}" data-digest="${intent.digest}" ${intent.replacementOf ? `data-replacement="${esc(intent.replacementOf)}"` : ''}>${esc(t(intent.replacementOf ? 'replacementApprove' : 'approve'))}</button></footer></article>`;
}
export class WalletPanel {
  private emergency: WalletEmergency | undefined;
  private historyOffset = 0;
  private refreshGeneration = 0;
  private readonly root = document.getElementById('settings-wallet')!;
  private wallets: Wallet[] = [];
  private portfolios: WalletPortfolioPanel;
  private agentScopes: WalletAgentScopePanel;
  constructor(private readonly options: Options) {
    this.portfolios = new WalletPortfolioPanel({ ...options, wallets: () => this.wallets });
    this.agentScopes = new WalletAgentScopePanel({ ...options, wallets: () => this.wallets });
    options.subscribe((event) => {
      if (event.type === 'wallet-changed') void this.refresh().catch((error) => this.error(error));
    });
    window.addEventListener('cibyp:settings-tab', (event) => {
      if ((event as CustomEvent).detail.tab === 'wallet')
        void this.refresh().catch((error) => this.error(error));
    });
    window.addEventListener(
      'languagechange',
      () => void this.refresh().catch((error) => this.error(error)),
    );
    this.root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-wallet-action]');
      if (button) void this.action(button).catch((error) => this.error(error));
    });
    document.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-wallet-decision]',
      );
      if (!button) return;
      button.disabled = true;
      void this.call('intent.' + button.dataset.walletDecision, {
        id: button.dataset.intent,
        digest: button.dataset.digest,
        ...(button.dataset.replacement ? { replacementOf: button.dataset.replacement } : {}),
      })
        .then(() => this.refresh())
        .catch((error) => this.error(error))
        .finally(() => {
          button.disabled = false;
        });
    });
  }
  private t(key: Key): string {
    return walletText(this.options.language(), key);
  }
  private call<T = unknown>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.options.request(action, input) as Promise<T>;
  }
  private btn(key: Key, action: string, id = ''): string {
    return `<button type="button" data-wallet-action="${action}" data-wallet-id="${id}">${esc(this.t(key))}</button>`;
  }
  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const [data, history] = await Promise.all([
      this.call<{
        wallets: Wallet[];
        intents: WalletIntent[];
        syncError?: string;
        emergency?: WalletEmergency;
      }>('list'),
      this.call<{ items: WalletIntent[]; total: number; next: number | null }>('history', {
        offset: this.historyOffset,
        limit: 25,
      }),
    ]);
    if (generation !== this.refreshGeneration) return;
    if (this.historyOffset && !history.items.length) {
      this.historyOffset = Math.max(0, this.historyOffset - 25);
      return this.refresh();
    }
    this.wallets = data.wallets;
    const newlyStopped = data.emergency?.halted && !this.emergency?.halted;
    this.emergency = data.emergency;
    if (newlyStopped)
      for (const dialog of document.querySelectorAll<HTMLDialogElement>(
        '.wallet-dialog:not([data-emergency-reset])',
      ))
        dialog.close();
    this.root.innerHTML = `<div class="wallet-heading"><div><h3>${esc(this.t('title'))}</h3><p>${esc(this.t('hint'))}</p></div><div>${this.btn('create', 'create')}${this.btn('import', 'import')}</div></div><p class="wallet-private-hint">${esc(this.t('noSecrets'))}</p><div data-wallet-error role="status" hidden></div>
      <div class="wallet-account-list">${data.wallets.length ? data.wallets.map((w) => `<article class="wallet-account"><header><div><strong>${esc(w.name)}</strong><code>${esc(w.address)}</code></div><span class="wallet-state ${w.unlocked ? 'unlocked' : ''}">${esc(this.t(w.unlocked ? 'unlocked' : 'locked'))}</span></header><div class="wallet-account-actions">${this.btn(w.unlocked ? 'lock' : 'unlock', w.unlocked ? 'lock' : 'unlock', w.id)}${this.btn('backup', 'backup', w.id)}${this.btn('changePassword', 'password-change', w.id)}${this.btn('balance', 'balance', w.id)}</div><div class="wallet-policy"><div><strong>${esc(this.t(w.policy.mode === 'autonomous' ? 'automatic' : 'manual'))}</strong><small>${w.policy.chains.length ? esc(w.policy.chains.join(' / ')) : 'Base / Base Sepolia'}${w.policy.expiresAt ? ' · ' + esc(new Date(w.policy.expiresAt).toLocaleString()) : ''}</small></div>${this.btn(w.policy.mode === 'autonomous' ? 'revoke' : 'enable', w.policy.mode === 'autonomous' ? 'revoke' : 'enable', w.id)}</div></article>`).join('') : `<p>${esc(this.t('empty'))}</p>`}</div>
      <h3>${esc(this.t('history'))} <small>${history.total}</small></h3><div class="wallet-history">${history.items.length ? history.items.map((intent) => `<div class="wallet-history-row"><span><strong>${esc(intent.network)} · ${esc(intent.description.kind)}</strong><small>${esc(new Date(intent.createdAt).toLocaleString())}</small></span><code>${esc(intent.hash ? intent.hash.slice(0, 12) + '…' : intent.transaction.to.slice(0, 12) + '…')}</code><span>${esc(walletStatus(this.options.language(), intent.status))}</span>${this.btn('details', 'details', intent.id)}</div>`).join('') : `<p>${esc(this.t('none'))}</p>`}</div><div class="wallet-pagination"><button type="button" data-wallet-action="previous" ${this.historyOffset ? '' : 'disabled'}>${esc(this.t('previous'))}</button><span>${history.total ? this.historyOffset + 1 : 0}–${Math.min(this.historyOffset + 25, history.total)} / ${history.total}</span><button type="button" data-wallet-action="next" ${history.next === null ? 'disabled' : ''}>${esc(this.t('next'))}</button></div>`;
    this.root
      .querySelector('.wallet-heading>div:last-child')
      ?.insertAdjacentHTML('beforeend', this.btn('portfolioTitle', 'portfolios'));
    this.root
      .querySelector('.wallet-heading>div:last-child')
      ?.insertAdjacentHTML('beforeend', this.btn('agentScopesTitle', 'agent-scopes'));
    if (data.wallets.some((w) => w.portfolioBlocked))
      this.root
        .querySelector('.wallet-heading')
        ?.insertAdjacentHTML(
          'afterend',
          `<section class="wallet-warning"><p>${esc(this.t('portfolioBlocked'))}</p>${this.btn('portfolioRecover', 'portfolio-recover')}</section>`,
        );
    for (const wallet of data.wallets)
      this.root
        .querySelector(`[data-wallet-action="balance"][data-wallet-id="${wallet.id}"]`)
        ?.insertAdjacentHTML('afterend', this.btn('usageTitle', 'usage', wallet.id));
    if (this.emergency) {
      const state = this.emergency;
      this.root.insertAdjacentHTML(
        'afterbegin',
        '<section class="wallet-emergency ' +
          (state.halted ? 'is-stopped' : '') +
          '" data-wallet-emergency role="status"><div><strong>' +
          esc(this.t(state.halted ? 'esStopped' : 'esTitle')) +
          '</strong><p>' +
          esc(this.t(state.halted ? 'esResidual' : 'esReady')) +
          '</p>' +
          (state.halted
            ? '<p>' + esc(this.t('esReconcile')) + ': ' + state.needsReconciliation + '</p>'
            : '') +
          (state.nativePausePending ? '<p>' + esc(this.t('esPending')) + '</p>' : '') +
          (state.storageError || state.nativePauseError
            ? '<p class="wallet-error">' +
              esc(
                walletStatus(
                  this.options.language(),
                  state.storageError || state.nativePauseError!,
                ),
              ) +
              '</p>'
            : '') +
          '</div>' +
          this.btn(
            state.halted
              ? state.storageError || state.nativePauseError
                ? 'esRetry'
                : 'esReset'
              : 'esHalt',
            state.halted && !state.storageError && !state.nativePauseError
              ? 'emergency-reset'
              : 'emergency-stop',
          ) +
          '</section>',
      );
      const reset = this.root.querySelector<HTMLButtonElement>(
        '[data-wallet-action=emergency-reset]',
      );
      if (reset) reset.disabled = state.nativePausePending;
      if (state.halted)
        for (const action of this.root.querySelectorAll<HTMLButtonElement>(
          '[data-wallet-action=unlock],[data-wallet-action=enable]',
        )) {
          action.disabled = true;
          action.title = this.t('esStopped');
        }
    }
    if (data.syncError) this.error(new Error(this.t('syncFailed')));
    window.dispatchEvent(new CustomEvent('cibyp:wallet-updated', { detail: data }));
  }
  private async action(button: HTMLElement): Promise<void> {
    const id = button.dataset.walletId!,
      action = button.dataset.walletAction;
    if (action === 'emergency-stop') {
      try {
        await this.call('emergency.halt', { expectedGeneration: this.emergency?.generation });
      } finally {
        await this.refresh();
      }
      return;
    }
    if (action === 'emergency-reset') {
      this.resetEmergency();
      return;
    }
    if (action === 'next' || action === 'previous') {
      this.historyOffset = Math.max(0, this.historyOffset + (action === 'next' ? 25 : -25));
      await this.refresh();
      return;
    }
    if (action === 'details') {
      const intent = await this.call<WalletIntent>('intent.inspect', { id });
      const dialog = this.dialog(
        this.t('details'),
        `<div data-wallet-detail>${intent.status === 'approval-required' ? approvalCard(intent, this.options.language()) : `<pre>${esc(JSON.stringify(intent, null, 2))}</pre>`}</div><footer>${intent.hash || intent.status === 'signing-unknown' ? this.btn('reconcile', 'reconcile', id) : ''}<button type="button" data-close>${esc(this.t('close'))}</button></footer>`,
      );
      if (intent.status !== 'approval-required') {
        const notice = document.createElement('p');
        notice.textContent = [
          walletStatus(this.options.language(), intent.status),
          intent.submissionMayHaveOccurred === false
            ? walletStatus(this.options.language(), 'broadcast-not-sent')
            : intent.status === 'submit-unknown'
              ? walletStatus(this.options.language(), 'broadcast-unknown')
              : '',
          intent.error ? walletStatus(this.options.language(), intent.error) : '',
        ]
          .filter(Boolean)
          .join(' · ');
        dialog.querySelector('[data-wallet-detail]')!.prepend(notice);
      }
      if (intent.submissionMayHaveOccurred === false)
        dialog.querySelector('[data-wallet-action="reconcile"]')?.remove();
      dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const reconcile = target.closest<HTMLElement>('[data-wallet-action="reconcile"]');
        if (reconcile) void this.action(reconcile).catch((error) => this.error(error));
        if (reconcile || target.closest('[data-wallet-decision]')) dialog.close();
      });
      dialog.showModal();
      return;
    }
    if (
      action === 'create' ||
      action === 'import' ||
      action === 'unlock' ||
      action === 'password-change'
    ) {
      this.credentials(action, id);
      return;
    }
    if (action === 'enable') {
      this.authorization(this.wallets.find((w) => w.id === id)!);
      return;
    }
    if (action === 'lock' || action === 'revoke') {
      await this.call(action === 'lock' ? 'lock' : 'policy.revoke', { id });
      await this.refresh();
      return;
    }
    if (action === 'reconcile') {
      await this.call('intent.reconcile', { id });
      await this.refresh();
      return;
    }
    if (action === 'backup') {
      const file = await this.call<{ name: string; text: string }>('keystore.export', { id });
      const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (action === 'usage') {
      const snapshot = await this.call<WalletBudgetSnapshot | null>('policy.usage', { id });
      const rows = walletBudget(snapshot);
      const dialog = this.dialog(
        this.t('usageTitle'),
        `<p class="wallet-private-hint">${esc(this.t('usageHint'))}</p>${snapshot && (snapshot.revoked || (snapshot.expiresAt !== 0 && snapshot.expiresAt <= Date.now())) ? `<p class="wallet-warning">${esc(this.t('usageRevoked'))}</p>` : ''}<div class="wallet-budget-list">${rows.length ? rows.map((row) => `<article class="wallet-budget-row"><header><strong>${esc(this.t(row.label as Key))}</strong><small>${esc(row.asset)}</small></header><p>${esc(row.usedText)}${row.breakdown ? '' : ' / ' + esc(row.limitText ?? this.t('usageUnlimited'))}</p>${row.contract ? `<code>${esc(row.contract)}</code>` : ''}${row.limitText !== null ? `<progress max="100" value="${executionPercent(row.used, row.limit)}" aria-label="${esc(this.t(row.label as Key))}"></progress>` : ''}</article>`).join('') : `<p>${esc(this.t('usageEmpty'))}</p>`}</div>`,
      );
      dialog.classList.add('wallet-budget-dialog');
      if (snapshot?.period) {
        const t = (key: string) => this.t(key as Key);
        dialog
          .querySelector('.wallet-budget-list')
          ?.insertAdjacentHTML(
            'beforebegin',
            periodNote(snapshot.period, t, this.options.language()),
          );
        dialog.insertAdjacentHTML(
          'beforeend',
          `<footer><button type="button" data-period-history>${esc(t('periodHistory'))}</button></footer>`,
        );
        dialog.querySelector('[data-period-history]')!.addEventListener('click', () => {
          void openPeriodHistory({ ...this.options, t }, snapshot.period!.identity)
            .then(() => dialog.close())
            .catch((error) => this.error(error));
        });
      }
      dialog.showModal();
      return;
    }
    if (action === 'agent-scopes') {
      await this.agentScopes.open();
      return;
    }
    if (action === 'portfolios') {
      await this.portfolios.open();
      return;
    }
    if (action === 'portfolio-recover') {
      this.portfolios.recover();
      return;
    }
    if (action === 'balance') {
      const value = await this.call('balance', { id, chain: 'base' });
      const dialog = this.dialog(
        this.t('balance'),
        `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`,
      );
      dialog.showModal();
    }
  }
  private dialog(title: string, html: string): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.className = 'quant-dialog wallet-dialog';
    dialog.innerHTML = `<header><h2>${esc(title)}</h2><button type="button" data-close aria-label="${esc(this.t('close'))}">×</button></header>${html}`;
    document.body.append(dialog);
    dialog
      .querySelectorAll('[data-close]')
      .forEach((button) => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener(
      'close',
      () => {
        dialog
          .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')
          .forEach((input) => {
            input.value = '';
          });
        dialog.textContent = '';
        dialog.remove();
      },
      { once: true },
    );
    return dialog;
  }
  private resetEmergency(): void {
    const dialog = this.dialog(
      this.t('esReset'),
      '<form><p class="wallet-warning">' +
        esc(this.t('esScope')) +
        '</p><p>' +
        esc(this.t('esResetHint')) +
        '</p><p>' +
        esc(this.t('esResidual')) +
        '</p><label data-second hidden>' +
        esc(this.t('esAck')) +
        '<input name="ack" autocomplete="off" spellcheck="false" placeholder="RESET LIVE"></label><p data-error role="alert" hidden></p><footer><button type="button" data-close>' +
        esc(this.t('cancel')) +
        '</button><button type="submit" data-continue>' +
        esc(this.t('esRead')) +
        '</button></footer></form>',
    );
    dialog.dataset.emergencyReset = 'true';
    const form = dialog.querySelector('form')!,
      button = dialog.querySelector<HTMLButtonElement>('[data-continue]')!,
      ack = dialog.querySelector<HTMLInputElement>('[name=ack]')!;
    let challenge: { id: string } | undefined;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      button.disabled = true;
      void (async () => {
        try {
          if (!challenge) {
            challenge = await this.call<{ id: string }>('emergency.challenge');
            dialog.querySelector<HTMLElement>('[data-second]')!.hidden = false;
            button.textContent = this.t('esConfirm');
            ack.focus();
          } else {
            await this.call('emergency.reset', {
              challengeId: challenge.id,
              ack: ack.value,
              confirmed: true,
            });
            dialog.close();
            await this.refresh();
          }
        } catch (error) {
          const node = dialog.querySelector<HTMLElement>('[data-error]')!;
          node.hidden = false;
          node.textContent = walletStatus(this.options.language(), (error as Error).message);
          challenge = undefined;
        } finally {
          button.disabled = Boolean(challenge) && ack.value !== 'RESET LIVE';
        }
      })();
    });
    ack.addEventListener('input', () => {
      button.disabled = Boolean(challenge) && ack.value !== 'RESET LIVE';
    });
    dialog.showModal();
  }
  private credentials(
    action: 'create' | 'import' | 'unlock' | 'password-change',
    id: string,
  ): void {
    if (
      location.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
      !location.hostname.endsWith('.onion')
    ) {
      this.error(new Error(this.t('insecure')));
      return;
    }
    const dialog = this.dialog(
      this.t(action === 'password-change' ? 'changePassword' : action),
      `<form><p class="quant-hint">${esc(this.t('noSecrets'))}</p>${action !== 'unlock' && action !== 'password-change' ? `<label>${esc(this.t('name'))}<input name="name" maxlength="100" autocomplete="off"></label>` : ''}
      <label>${esc(this.t(action === 'password-change' ? 'currentPassword' : 'password'))}<input type="password" name="password" minlength="${action === 'unlock' || action === 'password-change' ? 1 : 12}" required autocomplete="${action === 'unlock' || action === 'password-change' ? 'current-password' : 'new-password'}"></label>
      ${action === 'password-change' ? `<p>${esc(this.t('changePasswordHint'))}</p><label>${esc(this.t('newPassword'))}<input name="newPassword" type="password" minlength="12" maxlength="1024" required autocomplete="new-password"></label><label>${esc(this.t('repeatPassword'))}<input name="repeatPassword" type="password" minlength="12" maxlength="1024" required autocomplete="new-password"></label>` : ''}
      ${action === 'import' ? `<label>${esc(this.t('kind'))}<select name="kind"><option value="privateKey">${esc(this.t('key'))}</option><option value="mnemonic">${esc(this.t('phrase'))}</option><option value="keystore">${esc(this.t('keystore'))}</option></select></label><label>${esc(this.t('secret'))}<textarea name="secret" rows="4" required spellcheck="false" autocomplete="off"></textarea></label><label>${esc(this.t('sourcePassword'))}<input name="sourcePassword" type="password" autocomplete="off"></label>` : ''}
      ${action === 'unlock' ? `<label>${esc(this.t('duration'))}<select name="minutes"><option value="15">${esc(this.t('minutes'))}</option><option value="60">${esc(this.t('hour'))}</option><option value="0">${esc(this.t('session'))}</option></select></label>` : ''}<p data-error role="alert" hidden></p><footer><button type="button" data-close>${esc(this.t('cancel'))}</button><button type="submit" class="quant-primary">${esc(this.t(action === 'password-change' ? 'changePassword' : action))}</button></footer></form>`,
    );
    dialog
      .querySelectorAll('[data-close]')
      .forEach((button) => button.addEventListener('click', () => dialog.close()));
    const form = dialog.querySelector('form')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      if (action === 'password-change' && values.newPassword !== values.repeatPassword) {
        const error = form.querySelector<HTMLElement>('[data-error]')!;
        error.hidden = false;
        error.textContent = this.t('passwordMismatch');
        return;
      }
      const input: Record<string, unknown> = { ...values, id };
      delete input.repeatPassword;
      if (action === 'unlock') input.minutes = Number(values.minutes);
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      submit.disabled = true;
      form
        .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[type="password"],textarea')
        .forEach((node) => {
          node.value = '';
        });
      void this.call<{ mnemonic?: string }>(
        action === 'password-change' ? 'password.change' : action,
        input,
      )
        .then(async (result) => {
          dialog.close();
          await this.refresh();
          if (result.mnemonic) {
            const backup = this.dialog(
              this.t('backupTitle'),
              `<p>${esc(this.t('backupHint'))}</p><code class="wallet-phrase">${esc(result.mnemonic)}</code><footer><button type="button" data-close>${esc(this.t('close'))}</button></footer>`,
            );
            backup.querySelector('[data-close]')?.addEventListener('click', () => backup.close());
            backup.showModal();
          }
        })
        .catch((error) => {
          const node = form.querySelector<HTMLElement>('[data-error]')!;
          node.hidden = false;
          node.textContent =
            this.t('error') +
            ' · ' +
            walletStatus(this.options.language(), String(error.message || error));
        })
        .finally(() => {
          submit.disabled = false;
          for (const key of ['password', 'secret', 'sourcePassword', 'newPassword'])
            delete input[key];
        });
    });
    dialog.showModal();
  }
  private authorization(wallet: Wallet): void {
    const dialog = this.dialog(
      this.t('warningTitle'),
      `<form><code>${esc(wallet.address)}</code><p class="wallet-warning">${esc(this.t('warning'))}</p><label>${esc(this.t('scope'))}<select name="chains"><option value="8453">${esc(this.t('mainnet'))}</option><option value="84532">${esc(this.t('testnet'))}</option><option value="8453,84532">${esc(this.t('both'))}</option></select></label><label>${esc(this.t('expiry'))}<select name="hours"><option value="24">${esc(this.t('day'))}</option><option value="1">${esc(this.t('oneHour'))}</option><option value="0">${esc(this.t('forever'))}</option></select></label><label>${esc(this.t('fee'))}<input name="maxFeeEth" inputmode="decimal" value="0.01"></label><div data-second hidden><label>${esc(this.t('type'))}<input name="ack" autocomplete="off" spellcheck="false" placeholder="ALLOW LIVE"></label></div><p data-error role="alert" hidden></p><footer><button type="button" data-close>${esc(this.t('cancel'))}</button><button type="submit" class="wallet-live-button" data-continue>${esc(this.t('read'))}</button></footer></form>`,
    );
    dialog.classList.add('wallet-policy-dialog');
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    let challengeId = '';
    const form = dialog.querySelector('form')!;
    const scope = new WalletScopeEditor((key) => this.t(key as Key), wallet.policy.limits);
    form.querySelector('[data-second]')!.before(scope.root);
    form.addEventListener('input', () => {
      if (challengeId)
        form.querySelector<HTMLButtonElement>('[data-continue]')!.disabled =
          form.querySelector<HTMLInputElement>('[name="ack"]')!.value !== 'ALLOW LIVE';
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>('[data-continue]')!,
        values = Object.fromEntries(new FormData(form));
      button.disabled = true;
      void (async () => {
        if (!challengeId) {
          const challenge = await this.call<{ id: string }>('policy.challenge', {
            id: wallet.id,
            chains: String(values.chains).split(',').map(Number),
            hours: Number(values.hours),
            maxFeeEth: values.maxFeeEth,
            limits: scope.read(),
          });
          challengeId = challenge.id;
          scope.freeze();
          form.querySelector<HTMLElement>('[data-second]')!.hidden = false;
          form
            .querySelectorAll<HTMLSelectElement | HTMLInputElement>(
              '[name="chains"],[name="hours"],[name="maxFeeEth"],[name^="limit-"]',
            )
            .forEach((input) => {
              input.disabled = true;
            });
          button.textContent = this.t('confirm');
          form.querySelector<HTMLInputElement>('[name="ack"]')!.focus();
          return;
        }
        if (values.ack !== 'ALLOW LIVE') throw new Error(this.t('type'));
        await this.call('policy.grant', { challengeId, ack: values.ack, confirmed: true });
        dialog.close();
        await this.refresh();
      })()
        .catch((error) => {
          const node = form.querySelector<HTMLElement>('[data-error]')!;
          node.hidden = false;
          node.textContent = walletStatus(this.options.language(), String(error.message || error));
        })
        .finally(() => {
          button.disabled =
            !!challengeId &&
            form.querySelector<HTMLInputElement>('[name="ack"]')!.value !== 'ALLOW LIVE';
        });
    });
    dialog.showModal();
  }
  private error(error: unknown): void {
    let node = this.root.querySelector<HTMLElement>('[data-wallet-error]');
    if (!node) {
      node = document.createElement('p');
      node.dataset.walletError = '';
      this.root.prepend(node);
    }
    node.hidden = false;
    node.textContent =
      this.t('error') +
      ' · ' +
      walletStatus(this.options.language(), error instanceof Error ? error.message : String(error));
  }
}
