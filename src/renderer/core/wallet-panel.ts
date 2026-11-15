import securityLabels from '../../shared/wallet-security-labels.json';
import networkLabels from '../../shared/wallet-network-labels.json';
import appLabels from '../../shared/wallet-app-labels.json';
import browserLabels from '../../shared/wallet-browser-labels.json';
import messageLabels from '../../shared/wallet-message-labels.json';
import { WalletMessagesPanel } from './wallet-messages';
import { WalletAppsPanel } from './wallet-apps';
import { WalletBrowserPanel } from './wallet-browser';
import { WalletNetworkPanel } from './wallet-networks';
import allowanceLabels from '../../shared/wallet-allowance-labels.json';
import assetLabels from '../../shared/wallet-assets-labels.json';
import policyLabels from '../../shared/wallet-policy-labels.json';
import tokenLabels from '../../shared/wallet-token-labels.json';
import { WalletScopeEditor } from './wallet-scope-editor';
import { WalletPortfolioPanel, type AllowanceReview } from './wallet-portfolios';
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
  networkBlocked?: boolean;
  sourceApp?: { origin: string; connectionId: string; clientId?: string; clientName?: string };
  id: string;
  walletId: string;
  address: string;
  digest: string;
  status: string;
  chainId: number;
  network: string;
  nativeSymbol?: string;
  additionalFeeReserveWei?: string;
  valueEth: string;
  executionFeeMaxWei: string;
  l1FeeEstimateWei: string;
  operatorFeeEstimateWei?: string;
  hash?: string;
  replacementOf?: string | null;
  submissionMayHaveOccurred?: boolean;
  error?: string;
  portfolioAllowanceRisk?: {
    phase: 'sign' | 'broadcast';
    block?: string;
    blockHash?: string;
    projected?: string;
    ceiling?: string;
  };
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
  kind?: 'watch' | 'local';
  trackedTokens?: Record<string, string[]>;
  portfolioBlocked?: boolean;
  policy: {
    mode: string;
    chains: number[];
    inactiveNetworks?: number[];
    expiresAt?: number;
    maxFeeEth?: string;
    limits?: Record<string, unknown>;
  };
};
type Options = {
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => unknown;
  language: () => string;
  notify?: (message: string) => void;
};
type AllowanceObservation = {
  amount: string | null;
  amountAtomic: string;
  block: string;
  blockHash: string;
  commandId: string;
  network: string;
  observedAt: number;
  spender: string;
  symbol: string | null;
  token: string;
  unlimited: boolean;
  permit2?: {
    expiration: number;
    nonce: string;
    nextNonce: string | null;
    expired: boolean;
    tokenAllowance: string | null;
    tokenAllowanceAtomic: string;
    effectiveAmount: string | null;
    effectiveAmountAtomic: string;
  };
};
type ApprovalPair = { token: string; spender: string; block: string; transactionHash: string };
type ApprovalScan = {
  items: ApprovalPair[];
  fromBlock: string;
  toBlock: string;
  anchorHash: string;
  nextOffset: number | null;
  nextEndBlock: string | null;
  total: number;
};
type AssetSnapshot = {
  network: string;
  block: string;
  blockHash: string;
  observedAt: number;
  trackedTokens: string[];
  assets: {
    kind: string;
    address?: string;
    symbol: string | null;
    amount: string | null;
    amountAtomic: string | null;
    error?: string;
    metadataError?: string;
  }[];
};
const zh = {
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
  fee: '每笔估算费用上限（原生币；0 表示不限）',
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
  fee: 'Estimated fee cap per transaction (native coin; 0 = unlimited)',
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
  ...networkLabels.de,
  ...appLabels.de,
  ...browserLabels.de,
  ...messageLabels.de,
  ...allowanceLabels.de,
  ...assetLabels.de,
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
  fee: 'Geschätztes Gebührenlimit pro Transaktion (native coin; 0 = unbegrenzt)',
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
  const t = (key: Key) => {
    const text = walletText(language, key),
      symbol = intent.nativeSymbol || 'ETH';
    if (key === 'value') return text.replaceAll('ETH', symbol);
    if (key === 'native') return text + ' · ' + intent.chainId;
    if (key === 'feeEstimate' && ![8453, 84532].includes(intent.chainId))
      return walletText(language, 'networkFeeDisplay').replace('{symbol}', symbol);
    return text;
  };
  if (intent.emergencyBlocked || intent.networkBlocked)
    return (
      '<article class="wallet-approval"><p class="wallet-warning">' +
      esc(
        intent.emergencyBlocked ? t('esBlocked') : walletStatus(language, 'WALLET_NETWORK_CHANGED'),
      ) +
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
  const lockdown = description.kind === 'permit2-lockdown';
  const ordered = description.kind === 'permit2-allowance-invalidate';
  const signature = description.kind === 'permit2-signature-invalidate';
  const approval = description.kind === 'approve' || lockdown;
  const summary =
    approval && description.rawTokenAmount === '0'
      ? t(lockdown ? 'allowancePermit2Zero' : 'allowanceZero')
      : description.kind === 'uniswap-v3-swap'
        ? `${description.amountIn} ${description.tokenIn} → ≥ ${description.minimumAmountOut} ${description.tokenOut}`
        : description.tokenAmount
          ? `${walletStatus(language, String(description.kind))} · ${description.tokenAmount} ${description.token}`
          : walletStatus(language, String(description.kind));
  const fee = executionAmount(
    (
      BigInt(intent.executionFeeMaxWei) +
      BigInt(intent.l1FeeEstimateWei) +
      BigInt(intent.operatorFeeEstimateWei || '0') +
      BigInt(intent.additionalFeeReserveWei || '0')
    ).toString(),
    18,
  );
  const completeDetails = {
    ...(intent.sourceApp ? { sourceApp: intent.sourceApp } : {}),
    description: intent.description,
    transaction: intent.transaction,
    ...(intent.expiresAt ? { expiresAt: new Date(intent.expiresAt).toLocaleString() } : {}),
  };
  const source = intent.sourceApp
    ? `<p class="wallet-app-origin">${esc(t('appsSource'))}<br><code>${esc(intent.sourceApp.origin)}</code>${intent.sourceApp.clientName ? `<small>${esc(t('wbSource'))} · ${esc(intent.sourceApp.clientName)}</small>` : ''}</p>`
    : '';
  const replacement =
    source +
    (intent.replacementOf
      ? `<p class="wallet-warning wallet-replacement">${esc(t('replacementWarning'))}<code>${esc(intent.replacementOf)}</code></p>`
      : '');
  const spender =
    (approval || ordered) && typeof description.recipient === 'string'
      ? `<dt>${esc(t('allowanceSpender'))}</dt><dd>${esc(description.recipient)}</dd>`
      : '';
  const underlying =
    lockdown || ordered
      ? `<dt>${esc(t('allowanceToken'))}</dt><dd>${esc(description.tokenContract)}</dd>`
      : '';
  const scopeLabel = lockdown
    ? 'allowancePermit2Scope'
    : ordered
      ? 'permit2OrderedScope'
      : signature
        ? 'permit2SignatureScope'
        : null;
  const scope = scopeLabel ? `<p class="wallet-warning">${esc(t(scopeLabel))}</p>` : '';
  const nonce = ordered
    ? `<dt>${esc(t('permit2NextNonce'))}</dt><dd>${esc(description.nextNonce)}</dd>`
    : signature
      ? `<dt>Nonce</dt><dd>${esc(description.permitNonce)}</dd>`
      : '';
  return `<article class="wallet-approval"><header><span>${esc(t('native'))} · ${esc(intent.network)}</span><strong>${esc(t('pending'))}</strong></header>${replacement}<p class="wallet-action-summary">${esc(summary)}</p>${scope}<dl><dt>${esc(t('to'))}</dt><dd>${esc(intent.transaction.to)}</dd>${underlying}${spender}${nonce}<dt>${esc(t('value'))}</dt><dd>${esc(intent.valueEth)}</dd><dt>${esc(t('feeEstimate'))}</dt><dd>≈ ${esc(fee)}</dd></dl><details><summary>${esc(t('details'))}</summary><pre>${esc(JSON.stringify(completeDetails, null, 2))}</pre></details><footer><button type="button" data-wallet-decision="deny" data-intent="${intent.id}" data-digest="${intent.digest}">${esc(t('deny'))}</button><button type="button" class="wallet-live-button" data-wallet-decision="approve" data-intent="${intent.id}" data-digest="${intent.digest}" ${intent.replacementOf ? `data-replacement="${esc(intent.replacementOf)}"` : ''}>${esc(t(intent.replacementOf ? 'replacementApprove' : 'approve'))}</button></footer></article>`;
}
export class WalletPanel {
  private emergency: WalletEmergency | undefined;
  private historyOffset = 0;
  private refreshGeneration = 0;
  private readonly root = document.getElementById('settings-wallet')!;
  private wallets: Wallet[] = [];
  private portfolios: WalletPortfolioPanel;
  private agentScopes: WalletAgentScopePanel;
  private networks: WalletNetworkPanel;
  private apps: WalletAppsPanel;
  private browser: WalletBrowserPanel;
  private messages: WalletMessagesPanel;
  private seenAppRequests = new Set<string>();
  private seenBrowserRequests = new Set<string>();
  private seenMessageRequests = new Set<string>();
  constructor(private readonly options: Options) {
    this.browser = new WalletBrowserPanel({
      ...options,
      dialog: (title, content) => {
        const d = this.dialog(title, content);
        d.classList.add('wallet-browser-dialog');
        d.showModal();
        return d;
      },
    });
    this.messages = new WalletMessagesPanel({
      ...options,
      dialog: (title, content) => {
        const d = this.dialog(title, content);
        d.showModal();
        return d;
      },
    });
    this.apps = new WalletAppsPanel({
      ...options,
      dialog: (title, content) => {
        const d = this.dialog(title, content);
        d.showModal();
        return d;
      },
    });
    this.networks = new WalletNetworkPanel({
      ...options,
      dialog: (title, content) => {
        const d = this.dialog(title, content);
        d.showModal();
        return d;
      },
      refresh: () => this.refresh(),
      reportError: (error) => this.error(error),
    });
    this.portfolios = new WalletPortfolioPanel({
      ...options,
      wallets: () => this.wallets.filter((w) => w.kind !== 'watch'),
      reviewAllowance: (id, selection) => this.allowances(id, selection),
    });
    this.agentScopes = new WalletAgentScopePanel({ ...options, wallets: () => this.wallets });
    options.subscribe((event) => {
      if (event.type === 'wallet-allowance-monitor')
        options.notify?.(
          this.t(
            event.reason === 'attention'
              ? 'portfolioMonitorAttentionNotice'
              : 'portfolioMonitorIncreaseNotice',
          ),
        );
      if (Array.isArray(event.browserRequests)) {
        const ids = event.browserRequests.filter((id): id is string => typeof id === 'string');
        if (ids.some((id) => !this.seenBrowserRequests.has(id)))
          options.notify?.(this.t('wbWaiting'));
        this.seenBrowserRequests = new Set(ids);
      }
      if (Array.isArray(event.messageRequests)) {
        const ids = event.messageRequests.filter((id): id is string => typeof id === 'string');
        if (ids.some((id) => !this.seenMessageRequests.has(id)))
          options.notify?.(this.t('msgWaiting'));
        this.seenMessageRequests = new Set(ids);
      }
      if (Array.isArray(event.appRequests)) {
        const ids = event.appRequests.filter((id): id is string => typeof id === 'string');
        if (ids.some((id) => !this.seenAppRequests.has(id)))
          options.notify?.(this.t('appsWaiting'));
        this.seenAppRequests = new Set(ids);
      }
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
  private accountCard(w: Wallet): string {
    const watch = w.kind === 'watch';
    const state = watch ? 'watchAccount' : w.unlocked ? 'unlocked' : 'locked';
    const actions = watch
      ? this.btn('watchImport', 'import', w.id) + this.btn('watchRemove', 'watch-remove', w.id)
      : this.btn(w.unlocked ? 'lock' : 'unlock', w.unlocked ? 'lock' : 'unlock', w.id) +
        (w.unlocked ? this.btn('networkSend', 'send', w.id) : '') +
        this.btn('backup', 'backup', w.id) +
        this.btn('changePassword', 'password-change', w.id);
    const policy = watch
      ? ''
      : `<div class="wallet-policy"><div><strong>${esc(this.t(w.policy.mode === 'autonomous' ? 'automatic' : 'manual'))}</strong><small>${w.policy.chains.length ? esc(w.policy.chains.join(' / ')) : 'Base / Base Sepolia'}${w.policy.expiresAt ? ' · ' + esc(new Date(w.policy.expiresAt).toLocaleString()) : ''}</small></div>${this.btn(w.policy.mode === 'autonomous' ? 'revoke' : 'enable', w.policy.mode === 'autonomous' ? 'revoke' : 'enable', w.id)}</div>`;
    const inactive = w.policy.inactiveNetworks?.length
      ? `<p class="wallet-warning">${esc(this.t('networkGrantStale'))} ${esc(w.policy.inactiveNetworks.join(' / '))}</p>`
      : '';
    return `<article class="wallet-account"><header><div><strong>${esc(w.name)}</strong><code>${esc(w.address)}</code></div><span class="wallet-state ${w.unlocked ? 'unlocked' : ''}">${esc(this.t(state))}</span></header><div class="wallet-account-actions">${this.btn('assetsTitle', 'balance', w.id)}${this.btn('allowances', 'allowances', w.id)}${watch ? '' : this.btn('usageTitle', 'usage', w.id)}${actions}</div>${policy}${inactive}</article>`;
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
    this.root.innerHTML = `<div class="wallet-heading"><div><h3>${esc(this.t('title'))}</h3><p>${esc(this.t('hint'))}</p></div><div>${this.btn('create', 'create')}${this.btn('import', 'import')}${this.btn('watchAdd', 'watch-add')}</div></div><p class="wallet-private-hint">${esc(this.t('noSecrets'))}</p><div data-wallet-error role="status" hidden></div>
      <div class="wallet-account-list">${data.wallets.length ? data.wallets.map((w) => this.accountCard(w)).join('') : `<p>${esc(this.t('empty'))}</p>`}</div>
      <h3>${esc(this.t('history'))} <small>${history.total}</small></h3><div class="wallet-history">${history.items.length ? history.items.map((intent) => `<div class="wallet-history-row"><span><strong>${esc(intent.network)} · ${esc(intent.description.kind)}</strong><small>${esc(new Date(intent.createdAt).toLocaleString())}</small></span><code>${esc(intent.hash ? intent.hash.slice(0, 12) + '…' : intent.transaction.to.slice(0, 12) + '…')}</code><span>${esc(walletStatus(this.options.language(), intent.status))}</span>${this.btn('details', 'details', intent.id)}</div>`).join('') : `<p>${esc(this.t('none'))}</p>`}</div><div class="wallet-pagination"><button type="button" data-wallet-action="previous" ${this.historyOffset ? '' : 'disabled'}>${esc(this.t('previous'))}</button><span>${history.total ? this.historyOffset + 1 : 0}–${Math.min(this.historyOffset + 25, history.total)} / ${history.total}</span><button type="button" data-wallet-action="next" ${history.next === null ? 'disabled' : ''}>${esc(this.t('next'))}</button></div>`;
    this.root
      .querySelector('.wallet-heading>div:last-child')
      ?.insertAdjacentHTML('beforeend', this.btn('portfolioTitle', 'portfolios'));
    this.root
      .querySelector('.wallet-heading>div:last-child')
      ?.insertAdjacentHTML('beforeend', this.btn('agentScopesTitle', 'agent-scopes'));
    this.root
      .querySelector('.wallet-heading>div:last-child')
      ?.insertAdjacentHTML('beforeend', this.btn('networks', 'networks'));
    this.root
      .querySelector('.wallet-heading>div:last-child')
      ?.insertAdjacentHTML('beforeend', this.btn('appsTitle', 'apps'));
    this.root
      .querySelector('.wallet-heading>div:last-child')
      ?.insertAdjacentHTML('beforeend', this.btn('wbTitle', 'browser'));
    this.root
      .querySelector('.wallet-heading>div:last-child')
      ?.insertAdjacentHTML('beforeend', this.btn('msgTitle', 'messages'));
    if (data.wallets.some((w) => w.portfolioBlocked))
      this.root
        .querySelector('.wallet-heading')
        ?.insertAdjacentHTML(
          'afterend',
          `<section class="wallet-warning"><p>${esc(this.t('portfolioBlocked'))}</p>${this.btn('portfolioRecover', 'portfolio-recover')}</section>`,
        );
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
    if (action === 'networks') return this.networks.open();
    if (action === 'apps') return this.apps.open();
    if (action === 'browser') return this.browser.open();
    if (action === 'messages') return this.messages.open();
    if (action === 'send') return this.networks.send(this.wallets.find((w) => w.id === id)!);
    if (action === 'watch-add' || action === 'watch-remove') {
      this.watchAccount(action === 'watch-remove' ? id : undefined);
      return;
    }
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
        const risk = intent.portfolioAllowanceRisk;
        if (risk?.projected !== undefined) {
          const detail = document.createElement('p');
          detail.textContent = `${this.t('portfolioAllowanceCeiling')} · ${risk.projected} / ${risk.ceiling} · #${risk.block}`;
          detail.title = risk.blockHash || '';
          notice.after(detail);
        }
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
      await this.authorization(this.wallets.find((w) => w.id === id)!);
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
    if (action === 'allowances') {
      this.allowances(id);
      return;
    }
    if (action === 'balance') {
      await this.assets(id);
    }
  }
  private watchAccount(id?: string): void {
    const account = this.wallets.find((wallet) => wallet.id === id);
    const dialog = this.dialog(
      this.t(id ? 'watchRemove' : 'watchAdd'),
      `<form><p>${esc(this.t(id ? 'watchRemoveHint' : 'watchHint'))}</p>${id ? `<p>${esc(account?.name)}<br><code>${esc(account?.address)}</code></p>` : `<fieldset class="wallet-allowance-fields"><label>${esc(this.t('name'))}<input name="name" maxlength="100"></label><label>${esc(this.t('walletAddress'))}<input name="address" required pattern="0x[0-9a-fA-F]{40}" maxlength="42" spellcheck="false"></label></fieldset>`}<p role="alert" hidden></p><footer><button type="submit">${esc(this.t(id ? 'watchRemove' : 'save'))}</button></footer></form>`,
    );
    const form = dialog.querySelector('form')!;
    const button = form.querySelector('button')!;
    const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      const values = Object.fromEntries(new FormData(form));
      button.disabled = alert.hidden = true;
      try {
        await this.call(id ? 'watch.remove' : 'watch.add', id ? { id } : values);
        dialog.close();
        await this.refresh();
      } catch (error) {
        alert.textContent = walletStatus(
          this.options.language(),
          error instanceof Error ? error.message : String(error),
        );
        alert.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    dialog.showModal();
  }
  private async assets(id: string): Promise<void> {
    const { items: networks } = await this.call<{
      items: import('./wallet-networks').WalletNetwork[];
    }>('network.list');
    const dialog = this.dialog(
      this.t('assetsTitle'),
      `<p>${esc(this.t('assetsHint'))}</p><form><label>${esc(this.t('network'))}<select name="chain">${networks.map((p) => `<option value="${esc(p.key)}">${esc(p.name)} · ${p.id} · ${esc(p.nativeSymbol)}</option>`).join('')}</select></label><output aria-live="polite"></output><p role="alert" hidden></p><div class="wallet-assets"></div><label>${esc(this.t('allowanceToken'))}<input name="token" required pattern="0x[0-9a-fA-F]{40}" maxlength="42" placeholder="0x…" spellcheck="false"></label><footer><button type="button" data-refresh>${esc(this.t('assetRefresh'))}</button><button type="submit">${esc(this.t('assetTrack'))}</button></footer></form>`,
    );
    const form = dialog.querySelector('form')!;
    const chain = form.querySelector<HTMLSelectElement>('[name="chain"]')!;
    const token = form.querySelector<HTMLInputElement>('[name="token"]')!;
    const results = form.querySelector('.wallet-assets')!;
    const output = form.querySelector('output')!;
    const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
    let busy = false;
    const load = async (action?: string, address?: string) => {
      if (busy) return;
      busy = true;
      for (const control of form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >('input,select,button'))
        control.disabled = true;
      alert.hidden = true;
      results.replaceChildren();
      output.textContent = '';
      try {
        if (action) await this.call(action, { id, chain: chain.value, token: address });
        const snapshot = await this.call<AssetSnapshot>('assets', { id, chain: chain.value });
        if (!dialog.open) return;
        output.textContent = `${snapshot.network} · ${this.t('assetBlock')} #${snapshot.block} · ${new Date(snapshot.observedAt).toLocaleString()}`;
        output.title = snapshot.blockHash;
        for (const asset of snapshot.assets) {
          const card = document.createElement('article');
          const amount = asset.error
            ? this.t('assetFailed')
            : (asset.amount ?? `${asset.amountAtomic} ${this.t('assetAtomic')}`);
          card.innerHTML = `<header><strong>${esc(asset.symbol ?? this.t('assetUnknown'))}</strong><span>${esc(amount)}</span></header>${asset.address ? `<code>${esc(asset.address)}</code>` : ''}${asset.metadataError ? `<small>${esc(this.t('assetMetadata'))}</small>` : ''}`;
          if (
            asset.address &&
            snapshot.trackedTokens.some(
              (value) => value.toLowerCase() === asset.address!.toLowerCase(),
            )
          ) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = this.t('assetUntrack');
            remove.addEventListener('click', () => void load('asset.untrack', asset.address));
            card.append(remove);
          }
          results.append(card);
        }
        if (action === 'asset.track') token.value = '';
      } catch (error) {
        alert.textContent = walletStatus(
          this.options.language(),
          error instanceof Error ? error.message : String(error),
        );
        alert.hidden = false;
      } finally {
        busy = false;
        for (const control of form.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLButtonElement
        >('input,select,button'))
          control.disabled = false;
      }
    };
    chain.addEventListener('change', () => void load());
    form.querySelector('[data-refresh]')!.addEventListener('click', () => void load());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void load('asset.track', token.value.trim());
    });
    dialog.showModal();
    void load();
  }
  private allowances(id: string, selection?: AllowanceReview): void {
    const dialog = this.dialog(
      this.t('allowances'),
      `<form><p>${esc(this.t('allowanceHint'))}</p>
        <fieldset class="wallet-allowance-fields">
          <label>${esc(this.t('network'))}<select name="chain"><option value="base">Base</option><option value="base-sepolia">Base Sepolia</option></select></label>
          <label>${esc(this.t('allowanceProtocol'))}<select name="protocol"><option value="erc20">ERC-20</option><option value="permit2">Permit2</option></select></label>
          <label>${esc(this.t('allowanceToken'))}<input name="token" required pattern="0x[0-9a-fA-F]{40}" maxlength="42" spellcheck="false" placeholder="0x…"></label>
          <label>${esc(this.t('allowanceSpender'))}<input name="spender" required pattern="0x[0-9a-fA-F]{40}" maxlength="42" spellcheck="false" placeholder="0x…"></label>
        </fieldset>
        <output aria-live="polite"></output><p role="alert" hidden></p>
        <footer><button type="button" data-approval-history>${esc(this.t('allowanceDiscover'))}</button><button type="submit" value="read">${esc(this.t('allowanceRead'))}</button><button type="submit" class="wallet-live-button" value="revoke" disabled>${esc(this.t('allowancePrepare'))}</button></footer>
        <div class="wallet-permit2-actions" hidden><button type="button" data-signature>${esc(this.t('permit2SignatureTitle'))}</button><button type="submit" value="ordered" disabled>${esc(this.t('permit2OrderedPrepare'))}</button></div>
      </form>`,
    );
    const form = dialog.querySelector('form')!;
    const fields = form.querySelector('fieldset')!;
    const output = form.querySelector('output')!;
    const alert = form.querySelector('[role="alert"]') as HTMLElement;
    const read = form.querySelector<HTMLButtonElement>('[value="read"]')!;
    const revoke = form.querySelector<HTMLButtonElement>('[value="revoke"]')!;
    const history = form.querySelector<HTMLButtonElement>('[data-approval-history]')!;
    const chain = form.querySelector<HTMLSelectElement>('[name="chain"]')!;
    const protocol = form.querySelector<HTMLSelectElement>('[name="protocol"]')!;
    const permitActions = form.querySelector<HTMLElement>('.wallet-permit2-actions')!;
    const signature = form.querySelector<HTMLButtonElement>('[data-signature]')!;
    const ordered = form.querySelector<HTMLButtonElement>('[value="ordered"]')!;
    const protocolInput = () => (protocol.value === 'permit2' ? { protocol: 'permit2' } : {});
    const canSign = () =>
      !!this.wallets.find((w) => w.id === id)?.unlocked && !this.emergency?.halted;
    let observation: AllowanceObservation | undefined;
    const canPrepare = () => !!observation && observation.amountAtomic !== '0' && canSign();
    const canInvalidate = () => !!observation?.permit2?.nextNonce && canSign();
    const clearObservation = () => {
      observation = undefined;
      output.textContent = '';
      alert.hidden = true;
      revoke.disabled = ordered.disabled = true;
      permitActions.hidden = protocol.value !== 'permit2';
    };
    fields.addEventListener('input', clearObservation);
    signature.addEventListener('click', () => this.permit2Signatures(id, chain.value));
    history.addEventListener('click', () =>
      this.allowanceHistory(id, chain.value, protocolInput(), (pair) => {
        if (!dialog.open) return;
        clearObservation();
        form.querySelector<HTMLInputElement>('[name="token"]')!.value = pair.token;
        form.querySelector<HTMLInputElement>('[name="spender"]')!.value = pair.spender;
        form.requestSubmit(read);
      }),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (read.disabled) return;
      const invalidating = event.submitter === ordered;
      const preparing = event.submitter === revoke || invalidating;
      if (preparing && !(invalidating ? canInvalidate() : canPrepare())) return;
      const values = Object.fromEntries(new FormData(form));
      delete values.protocol;
      const selectedProtocol = protocolInput();
      if (!preparing) clearObservation();
      alert.hidden = true;
      fields.disabled =
        read.disabled =
        revoke.disabled =
        ordered.disabled =
        signature.disabled =
        history.disabled =
          true;
      try {
        if (preparing && observation) {
          const intent = await this.call<WalletIntent>(
            invalidating ? 'permit2.ordered.prepare' : 'allowance.revoke.prepare',
            {
              id,
              chain: values.chain,
              token: observation.token,
              spender: observation.spender,
              ...(invalidating
                ? { commandId: observation.commandId + ':nonce', nonce: observation.permit2!.nonce }
                : { commandId: observation.commandId, ...selectedProtocol }),
            },
          );
          observation = undefined;
          output.textContent =
            intent.status === 'approval-required'
              ? this.t(invalidating ? 'permit2Prepared' : 'allowancePrepared')
              : walletStatus(this.options.language(), intent.status);
          void this.refresh().catch((error) => this.error(error));
        } else {
          observation = await this.call<AllowanceObservation>('allowance.inspect', {
            id,
            ...values,
            ...selectedProtocol,
          });
          const symbol = observation.symbol;
          const display = (value: string | null, atomic: string) =>
            symbol ? `${value} ${symbol}` : `${atomic} ${this.t('allowanceAtomic')}`;
          const amount = display(observation.amount, observation.amountAtomic);
          const layered = observation.permit2;
          const expiration = layered ? new Date(layered.expiration * 1000) : null;
          output.textContent = [
            observation.network,
            observation.unlimited ? `${this.t('allowanceUnlimited')} (${amount})` : amount,
            `${this.t('allowanceBlock')} #${observation.block}`,
            new Date(observation.observedAt).toLocaleString(),
          ].join(' · ');
          if (layered && expiration) {
            output.append(
              document.createElement('br'),
              [
                `${this.t('allowancePermit2Outer')} ${display(layered.tokenAllowance, layered.tokenAllowanceAtomic)}`,
                `${this.t('allowancePermit2Effective')} ${display(layered.effectiveAmount, layered.effectiveAmountAtomic)}`,
                `${this.t('allowancePermit2Expiry')} ${Number.isNaN(expiration.getTime()) ? layered.expiration + ' (Unix)' : expiration.toLocaleString()}`,
                ...(layered.expired ? [this.t('allowancePermit2Expired')] : []),
                `Nonce ${layered.nonce}`,
              ].join(' · '),
            );
          }
          output.title = observation.blockHash;
        }
      } catch (error) {
        alert.textContent = walletStatus(
          this.options.language(),
          error instanceof Error ? error.message : String(error),
        );
        alert.hidden = false;
      } finally {
        fields.disabled = read.disabled = history.disabled = signature.disabled = false;
        revoke.disabled = !canPrepare();
        ordered.disabled = !canInvalidate();
      }
    });
    dialog.showModal();
    if (selection) {
      chain.value = selection.chain;
      protocol.value = selection.protocol;
      form.querySelector<HTMLInputElement>('[name="token"]')!.value = selection.token;
      form.querySelector<HTMLInputElement>('[name="spender"]')!.value = selection.spender;
      clearObservation();
      form.requestSubmit(read);
    }
  }
  private permit2Signatures(id: string, chain: string): void {
    const dialog = this.dialog(
      `${this.t('permit2SignatureTitle')} · ${chain === 'base' ? 'Base' : 'Base Sepolia'}`,
      `<form><p>${esc(this.t('permit2SignatureHint'))}</p><fieldset class="wallet-allowance-fields"><label>${esc(this.t('permit2NonceInput'))}<input name="nonce" maxlength="78" required autocomplete="off" spellcheck="false"></label></fieldset><output aria-live="polite"></output><p role="alert" hidden></p><footer><button type="submit" value="read">${esc(this.t('allowanceRead'))}</button><button type="submit" value="prepare" disabled>${esc(this.t('permit2SignaturePrepare'))}</button></footer></form>`,
    );
    const form = dialog.querySelector('form')!;
    const input = form.querySelector('input')!;
    const output = form.querySelector('output')!;
    const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
    const read = form.querySelector<HTMLButtonElement>('[value="read"]')!;
    const prepare = form.querySelector<HTMLButtonElement>('[value="prepare"]')!;
    type Observation = { nonce: string; unavailable: boolean; block: string; commandId: string };
    let observation: Observation | undefined;
    const canPrepare = () =>
      !!observation &&
      !observation.unavailable &&
      !!this.wallets.find((w) => w.id === id)?.unlocked &&
      !this.emergency?.halted;
    input.addEventListener('input', () => {
      observation = undefined;
      output.textContent = '';
      alert.hidden = prepare.disabled = true;
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const preparing = event.submitter === prepare;
      if (read.disabled || (preparing && !canPrepare())) return;
      input.disabled = read.disabled = prepare.disabled = alert.hidden = true;
      try {
        if (preparing && observation) {
          const intent = await this.call<WalletIntent>('permit2.signature.prepare', {
            id,
            chain,
            nonce: observation.nonce,
            commandId: observation.commandId,
          });
          observation = undefined;
          output.textContent =
            intent.status === 'approval-required'
              ? this.t('permit2Prepared')
              : walletStatus(this.options.language(), intent.status);
          void this.refresh().catch((error) => this.error(error));
        } else {
          observation = undefined;
          output.textContent = '';
          observation = await this.call<Observation>('permit2.signature.inspect', {
            id,
            chain,
            nonce: input.value.trim(),
          });
          output.textContent = `${this.t(observation.unavailable ? 'permit2NonceUnavailable' : 'permit2NonceUnused')} · Nonce ${observation.nonce} · ${this.t('allowanceBlock')} #${observation.block}`;
        }
      } catch (error) {
        alert.textContent = walletStatus(
          this.options.language(),
          error instanceof Error ? error.message : String(error),
        );
        alert.hidden = false;
      } finally {
        input.disabled = read.disabled = false;
        prepare.disabled = !canPrepare();
      }
    });
    dialog.showModal();
  }
  private allowanceHistory(
    id: string,
    chain: string,
    protocol: { protocol?: string },
    select: (pair: ApprovalPair) => void,
  ): void {
    const dialog = this.dialog(
      `${this.t('allowanceDiscover')} · ${chain === 'base' ? 'Base' : 'Base Sepolia'} · ${protocol.protocol ? 'Permit2' : 'ERC-20'}`,
      `<form><p>${esc(this.t(protocol.protocol ? 'allowancePermit2History' : 'allowanceHistoryHint'))}</p>
        <fieldset class="wallet-allowance-fields">
          <label>${esc(this.t('allowanceHistoryEnd'))}<input name="end" inputmode="numeric" pattern="[0-9]{1,16}" maxlength="16"></label>
          <label>${esc(this.t('allowanceHistoryBlocks'))}<input name="blocks" type="number" required min="1" max="2000" value="1000"></label>
        </fieldset>
        <output aria-live="polite"></output><p role="alert" hidden></p>
        <div class="wallet-approval-history"></div>
        <footer><button type="submit">${esc(this.t('allowanceHistoryScan'))}</button><button type="button" data-next hidden>${esc(this.t('next'))}</button><button type="button" data-older hidden>${esc(this.t('allowanceHistoryOlder'))}</button></footer>
      </form>`,
    );
    const form = dialog.querySelector('form')!;
    const fields = form.querySelector('fieldset')!;
    const results = form.querySelector('.wallet-approval-history')!;
    const output = form.querySelector('output')!;
    const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
    const scan = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const next = form.querySelector<HTMLButtonElement>('[data-next]')!;
    const older = form.querySelector<HTMLButtonElement>('[data-older]')!;
    const end = form.querySelector<HTMLInputElement>('[name="end"]')!;
    const blocks = form.querySelector<HTMLInputElement>('[name="blocks"]')!;
    let page: ApprovalScan | undefined;
    const clear = () => {
      page = undefined;
      results.replaceChildren();
      output.textContent = '';
      alert.hidden = next.hidden = older.hidden = true;
    };
    fields.addEventListener('input', clear);
    const load = async (cursor: Record<string, unknown>) => {
      if (scan.disabled || !form.reportValidity()) return;
      clear();
      fields.disabled = scan.disabled = true;
      try {
        page = await this.call<ApprovalScan>('allowance.discover', {
          id,
          chain,
          blocks: blocks.valueAsNumber,
          ...protocol,
          ...cursor,
        });
        if (!dialog.open) return;
        output.textContent = `${this.t('allowanceHistoryRange')} ${page.fromBlock}–${page.toBlock} · ${page.total}`;
        if (!page.items.length) results.textContent = this.t('allowanceHistoryEmpty');
        for (const pair of page.items) {
          const button = document.createElement('button');
          button.type = 'button';
          button.innerHTML = `<code>${esc(pair.token)}</code><code>→ ${esc(pair.spender)}</code><small>#${esc(pair.block)}</small>`;
          button.title = pair.transactionHash;
          button.addEventListener('click', () => {
            dialog.close();
            select(pair);
          });
          results.append(button);
        }
        next.hidden = page.nextOffset === null;
        older.hidden = page.nextEndBlock === null || page.nextOffset !== null;
      } catch (error) {
        alert.textContent = walletStatus(
          this.options.language(),
          error instanceof Error ? error.message : String(error),
        );
        alert.hidden = false;
      } finally {
        fields.disabled = scan.disabled = false;
      }
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void load(end.value ? { endBlock: end.value } : {});
    });
    next.addEventListener('click', () => {
      if (page?.nextOffset != null)
        void load({ endBlock: page.toBlock, anchorHash: page.anchorHash, offset: page.nextOffset });
    });
    older.addEventListener('click', () => {
      if (page?.nextEndBlock != null) {
        end.value = page.nextEndBlock;
        void load({ endBlock: end.value });
      }
    });
    dialog.showModal();
    void load({});
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
    const watch =
      action === 'import'
        ? this.wallets.find((wallet) => wallet.id === id && wallet.kind === 'watch')
        : undefined;
    if (
      location.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
      !location.hostname.endsWith('.onion')
    ) {
      this.error(new Error(this.t('insecure')));
      return;
    }
    const dialog = this.dialog(
      this.t(watch ? 'watchImport' : action === 'password-change' ? 'changePassword' : action),
      `<form><p class="quant-hint">${esc(this.t('noSecrets'))}</p>${action === 'import' ? `<p>${esc(this.t('watchUpgradeHint'))}</p>` : ''}${watch ? `<p>${esc(watch.name)}<br><code>${esc(watch.address)}</code></p>` : action !== 'unlock' && action !== 'password-change' ? `<label>${esc(this.t('name'))}<input name="name" maxlength="100" autocomplete="off"></label>` : ''}
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
        watch ? 'watch.import' : action === 'password-change' ? 'password.change' : action,
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
          if (!dialog.isConnected) return;
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
  private async authorization(wallet: Wallet): Promise<void> {
    const { items } = await this.call<{
      items: {
        id: number;
        name: string;
        archived: boolean;
        capabilities: { autonomous: boolean };
      }[];
    }>('network.list');
    const networks = items.filter((p) => !p.archived && p.capabilities.autonomous);
    const dialog = this.dialog(
      this.t('warningTitle'),
      `<form><code>${esc(wallet.address)}</code><p class="wallet-warning">${esc(this.t('warning'))}</p><label>${esc(this.t('scope'))}<select name="chains">${networks.map((p) => `<option value="${p.id}">${esc(p.name)} · ${p.id}</option>`).join('')}<option value="8453,84532">${esc(this.t('both'))}</option></select></label><label>${esc(this.t('expiry'))}<select name="hours"><option value="24">${esc(this.t('day'))}</option><option value="1">${esc(this.t('oneHour'))}</option><option value="0">${esc(this.t('forever'))}</option></select></label><label>${esc(this.t('fee'))}<input name="maxFeeEth" inputmode="decimal" value="0.01"></label><div data-second hidden><label>${esc(this.t('type'))}<input name="ack" autocomplete="off" spellcheck="false" placeholder="ALLOW LIVE"></label></div><p data-error role="alert" hidden></p><footer><button type="button" data-close>${esc(this.t('cancel'))}</button><button type="submit" class="wallet-live-button" data-continue>${esc(this.t('read'))}</button></footer></form>`,
    );
    dialog.classList.add('wallet-policy-dialog');
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    let challengeId = '';
    const form = dialog.querySelector('form')!;
    const scope = new WalletScopeEditor(
      (key) => this.t(key as Key),
      wallet.policy.limits,
      false,
      networks,
    );
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
