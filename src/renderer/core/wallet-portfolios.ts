/* SPDX-License-Identifier: GPL-3.0-or-later */
import { chainLabel } from '../../shared/wallet-chain';
import labels from '../../shared/wallet-portfolio-labels.json';
import allowanceLabels from '../../shared/wallet-allowance-labels.json';
import assetLabels from '../../shared/wallet-assets-labels.json';
import periodLabels from '../../shared/wallet-period-labels.json';
import { periodNote, openPeriodHistory } from './wallet-periods';
import type { WalletPeriodSnapshot } from '../../shared/wallet-budget';
import policyLabels from '../../shared/wallet-policy-labels.json';
import tokenLabels from '../../shared/wallet-token-labels.json';
import { walletBudget, walletScopeValues } from '../../shared/wallet-budget';
import { tokenAmount } from '../../shared/wallet-token-format';
import { executionPercent } from '../../shared/quant-execution-format';
import { WalletScopeEditor } from './wallet-scope-editor';
import { walletStatus } from './wallet-panel';
type Wallet = { id: string; name: string; address: string; portfolioBlocked?: boolean };
type RatePolicy = { windowSeconds: number; maxSignatures: number };
type RateObservation = RatePolicy & {
  status: 'ready' | 'limited' | 'settling' | 'clock-rollback';
  used: number;
  remaining: number;
  nextEligibleAt: number | null;
};
type Portfolio = {
  id: string;
  name: string;
  chainId: number;
  members: { walletId: string; address: string }[];
  limits: Record<string, unknown>;
  expiresAt: number;
  maxFeeWei: string;
  equityFloorUsdAtomic?: string;
  signatureRate?: RatePolicy;
  allowanceCeiling?: { token: string; atoms: string; decimals: number; baselineReportId: string };
};
type Equity = {
  status: 'disabled' | 'satisfied' | 'below' | 'unavailable';
  availableUsd?: string;
  block?: string;
  blockHash?: string;
  error?: string;
};
type Snapshot = {
  period?: WalletPeriodSnapshot | null;
  signatureRate?: RateObservation | null;
  portfolio: Portfolio;
  state: string;
  revision: number;
  usage: Record<string, unknown>;
};
type Holding = {
  address?: string;
  symbol: string | null;
  amount: string | null;
  amountAtomic: string | null;
  knownAmountAtomic?: string;
  knownAmount?: string | null;
  complete?: boolean;
  error?: string;
  valuation?: ReferenceValue;
  capital?: {
    complete: boolean;
    reservedAtomic: string;
    reserved: string | null;
    availableAtomic: string | null;
    available: string | null;
    shortfallAtomic: string | null;
  };
};
type ReferenceValue = {
  complete: boolean;
  value: string | null;
  knownValue: string;
  error?: string;
};
type PriceFeed = {
  pair: string;
  address: string;
  status: string;
  price?: string;
  updatedAt?: number;
  ageSeconds?: number;
  error?: string;
  stablecoinCapped?: boolean;
};
type Holdings = {
  capital?: { pendingCount: number; unknownCount: number; approvalCount: number };
  name: string;
  network: string;
  block: string;
  blockHash: string;
  complete: boolean;
  assets: Holding[];
  members: {
    walletId: string;
    name: string;
    address: string;
    assets: Holding[];
    valuation?: ReferenceValue;
  }[];
  valuation?: ReferenceValue & {
    source: string;
    prices: Record<string, PriceFeed>;
    sequencer: { status: string; error?: string };
  };
};
type Options = {
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  language: () => string;
  wallets: () => Wallet[];
  reviewAllowance?: (walletId: string, selection: AllowanceReview) => void;
};
export type AllowanceReview = {
  chain: 'base' | 'base-sepolia';
  protocol: 'erc20' | 'permit2';
  token: string;
  spender: string;
};
type AllowanceAmount = { atomic: string | null; amount: string | null };
type PerformanceAmount = { atomic: string; amount: string };
type PerformanceReport = {
  snapshotId: string;
  next: number | null;
  total: number;
  totals: {
    buyCount: number;
    sellCount: number;
    missingCount: number;
    matchedWeth: PerformanceAmount;
    unmatchedSaleWeth: PerformanceAmount;
    interruptedBasisWeth: PerformanceAmount;
    openWeth: PerformanceAmount;
    openCostUsdc: PerformanceAmount;
    matchedCostUsdc: PerformanceAmount;
    matchedProceedsUsdc: PerformanceAmount;
    realizedGrossUsdc: PerformanceAmount | null;
    matchedSaleCount: number;
    pricedSaleCount: number;
    matchedSwapFeesUsdc: PerformanceAmount | null;
    realizedAfterSwapFeesUsdc: PerformanceAmount | null;
  };
  fees: {
    l2GasWei: string | null;
    l1DataFeeWei: string | null;
    operatorFeeWei: string | null;
    totalWei: string | null;
    l2Receipts: number;
    l1Receipts: number;
    operatorReceipts: number;
    finalizedTransactions: number;
  };
  historicalFees?: {
    available: boolean;
    priced: number;
    transactions: number;
    knownUsdc: PerformanceAmount | null;
    totalUsdc: PerformanceAmount | null;
  };
  items: {
    walletId: string;
    block: string | null;
    txHash: string;
    side: 'buy' | 'sell' | 'unknown';
    boughtWeth?: PerformanceAmount;
    paidUsdc?: PerformanceAmount;
    matchedWeth?: PerformanceAmount;
    unmatchedSaleWeth?: PerformanceAmount;
    matchedCostUsdc?: PerformanceAmount;
    matchedProceedsUsdc?: PerformanceAmount;
    realizedGrossUsdc?: PerformanceAmount | null;
    transactionFeeUsdc?: PerformanceAmount | null;
    realizedAfterSwapFeesUsdc?: PerformanceAmount | null;
    feeQuote?: { eth: { roundId: string }; usdc: { roundId: string } };
  }[];
};
type AllowanceReport = {
  reportId: string;
  observedAt: number;
  block: string;
  blockHash: string;
  coverage: {
    tokens: string[];
    nextEndBlock: string | null;
    scannedRanges: { fromBlock: string; toBlock: string }[];
    scanIncomplete: boolean;
    unreadablePairs: number;
    unknownBalances: number;
    mode?: string;
    monitoredRange?: { fromBlock: string; toBlock: string };
  };
  totals: {
    token: string;
    symbol: string | null;
    decimals?: number | null;
    measured: AllowanceAmount;
    includingPermit2: AllowanceAmount;
    balance: AllowanceAmount;
  }[];
  items: (Omit<AllowanceReview, 'chain'> & {
    walletId: string;
    walletName: string;
    symbol?: string;
    upstream: boolean;
    unlimited: boolean;
    status: string;
    spendable: AllowanceAmount;
  })[];
  total: number;
  next: number | null;
};
type AllowanceMonitor = {
  revision: number;
  enabled: boolean;
  status: string;
  lastBlock?: string;
  intervalSeconds?: number;
  checkedAt?: number;
  nextAt?: number;
  error?: string;
  next: number | null;
  notices: {
    block: string;
    blockHash: string;
    observedAt: number;
    pairCount: number;
    increaseCount: number;
    increases: {
      symbol?: string;
      token: string;
      metric: string;
      before: AllowanceAmount;
      after: AllowanceAmount;
    }[];
    pairs: (Omit<AllowanceReview, 'chain'> & { walletId: string; walletName: string })[];
  }[];
};
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class WalletPortfolioPanel {
  private running = new WeakSet<HTMLDialogElement>();
  constructor(private options: Options) {}
  private t = (key: string): string => {
    const lang = this.options.language().startsWith('en')
      ? 'en'
      : this.options.language().startsWith('de')
        ? 'de'
        : 'zh-CN';
    return (
      (
        {
          ...policyLabels[lang],
          ...tokenLabels[lang],
          ...labels[lang],
          ...assetLabels[lang],
          ...allowanceLabels[lang],
          ...periodLabels[lang],
        } as Record<string, string>
      )[key] ?? key
    );
  };
  private call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.options.request('portfolio.' + action, input) as Promise<T>;
  }
  private dialog(title: string, body: string): HTMLDialogElement {
    const d = document.createElement('dialog');
    d.className = 'quant-dialog wallet-dialog wallet-policy-dialog wallet-portfolio-dialog';
    d.innerHTML = `<header><h3>${esc(title)}</h3><button type="button" data-exit aria-label="${esc(this.t('portfolioCancel'))}">×</button></header>${body}<p data-error role="alert" hidden></p>`;
    d.addEventListener('close', () => d.remove());
    d.querySelector('[data-exit]')!.addEventListener('click', () => d.close());
    document.body.append(d);
    d.showModal();
    return d;
  }
  private run(d: HTMLDialogElement, fn: () => Promise<unknown>): void {
    if (this.running.has(d)) return;
    const alert = d.querySelector<HTMLElement>('[data-error]')!;
    alert.hidden = true;
    this.running.add(d);
    void fn()
      .catch((error) => {
        alert.hidden = false;
        alert.textContent = walletStatus(this.options.language(), String(error.message || error));
      })
      .finally(() => this.running.delete(d));
  }
  async open(offset = 0): Promise<void> {
    const page = await this.call<{
      items: (Portfolio & { state: string; revision: number })[];
      total: number;
      next: number | null;
    }>('list', { offset });
    const names = new Map(this.options.wallets().map((w) => [w.id, w.name]));
    const d = this.dialog(
      this.t('portfolioTitle'),
      `<p class="wallet-private-hint">${esc(this.t('portfolioHint'))}</p><button type="button" data-create class="quant-primary">${esc(this.t('portfolioCreate'))}</button><div class="wallet-portfolio-list">${page.items.length ? page.items.map((p) => `<button type="button" data-detail="${esc(p.id)}" class="wallet-portfolio-summary"><span><strong>${esc(p.name)}</strong><small>${chainLabel(p.chainId)} · ${esc(this.t('portfolio' + p.state[0]!.toUpperCase() + p.state.slice(1)))}</small></span><small>${esc(p.members.map((m) => names.get(m.walletId) ?? m.address).join(' · '))}</small></button>`).join('') : `<p>${esc(this.t('portfolioEmpty'))}</p>`}</div><footer><button type="button" data-prev ${offset ? '' : 'disabled'}>${esc(this.t('portfolioPrevious'))}</button><span>${page.total}</span><button type="button" data-next ${page.next === null ? 'disabled' : ''}>${esc(this.t('portfolioPageNext'))}</button></footer>`,
    );
    d.querySelector('[data-create]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.create();
        d.close();
      }),
    );
    d.querySelector('[data-prev]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.open(Math.max(0, offset - 20));
        d.close();
      }),
    );
    d.querySelector('[data-next]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.open(page.next!);
        d.close();
      }),
    );
    d.querySelectorAll<HTMLElement>('[data-detail]').forEach((b) =>
      b.addEventListener('click', () =>
        this.run(d, async () => {
          await this.detail(b.dataset.detail!);
          d.close();
        }),
      ),
    );
  }
  private async create(snapshot?: Snapshot): Promise<void> {
    const page = (await this.options.request('network.list')) as {
      items: {
        id: number;
        name: string;
        archived: boolean;
        capabilities: { signType2: boolean };
      }[];
    };
    const networks = page.items.filter(
      (p) => snapshot?.portfolio.chainId === p.id || (!p.archived && p.capabilities.signType2),
    );
    const wallets = this.options.wallets();
    const d = this.dialog(
      this.t('portfolioCreate'),
      `<form><p class="wallet-warning">${esc(this.t('portfolioWarning'))}</p><label>${esc(this.t('portfolioName'))}<input name="portfolio-name" maxlength="80" required></label><label>${esc(this.t('chainId'))}<select name="portfolio-chain">${networks.map((p) => `<option value="${p.id}">${esc(p.name)} · ${p.id}</option>`).join('')}</select></label><fieldset class="wallet-portfolio-members"><legend>${esc(this.t('portfolioMembers'))}</legend><p>${esc(this.t(wallets.length ? 'portfolioMemberHint' : 'portfolioNoWallet'))}</p>${wallets.map((w) => `<label class="wallet-scope-toggle"><span>${esc(w.name)}<code>${esc(w.address)}</code></span><input type="checkbox" role="switch" data-member="${esc(w.id)}"></label>`).join('')}</fieldset><div class="wallet-policy-grid"><label>${esc(this.t('portfolioHours'))}<select name="portfolio-hours"><option value="24">${esc(this.t('portfolioDay'))}</option><option value="1">${esc(this.t('portfolioHour'))}</option><option value="0">${esc(this.t('portfolioForever'))}</option></select></label><label>${esc(this.t('portfolioFee'))}<input name="portfolio-fee" value="0.01" inputmode="decimal" required></label></div><div data-scope></div><div data-ack hidden><label>${esc(this.t('portfolioAck'))}<input name="portfolio-ack" autocomplete="off" spellcheck="false"></label></div><footer><button type="submit" data-submit class="wallet-live-button">${esc(this.t('portfolioReview'))}</button></footer></form>`,
    );
    if (snapshot) {
      d.querySelector('h3')!.textContent = this.t('portfolioEdit');
      d.querySelector('.wallet-warning')!.textContent = this.t('portfolioEditHint');
      d.querySelector<HTMLInputElement>('[name=portfolio-name]')!.value = snapshot.portfolio.name;
      const chain = d.querySelector<HTMLSelectElement>('[name=portfolio-chain]')!;
      chain.value = String(snapshot.portfolio.chainId);
      chain.disabled = true;
      d.querySelectorAll<HTMLInputElement>('[data-member]').forEach((n) => {
        n.checked = snapshot.portfolio.members.some((m) => m.walletId === n.dataset.member);
        n.disabled = true;
      });
      d.querySelector<HTMLSelectElement>('[name=portfolio-hours]')!.insertAdjacentHTML(
        'afterbegin',
        `<option value="-1" selected>${esc(this.t('portfolioKeepExpiry'))}</option>`,
      );
      d.querySelector<HTMLInputElement>('[name=portfolio-fee]')!.value = tokenAmount(
        snapshot.portfolio.maxFeeWei,
        18,
      );
    }
    const scope = new WalletScopeEditor(
      this.t,
      snapshot ? walletScopeValues(snapshot.portfolio.limits) : {},
      !!snapshot?.portfolio.limits.period,
      networks,
    );
    const scopeNode = d.querySelector('[data-scope]')!;
    scopeNode.insertAdjacentHTML(
      'beforebegin',
      `<div data-equity-field><label>${esc(this.t('portfolioEquityFloor'))}<input name="portfolio-equity" inputmode="decimal" maxlength="25"></label><p class="wallet-private-hint">${esc(this.t('portfolioEquityHelp'))}</p></div>`,
    );
    scopeNode.insertAdjacentHTML(
      'beforebegin',
      `<fieldset class="wallet-portfolio-members"><legend>${esc(this.t('portfolioRate'))}</legend><div class="wallet-policy-grid"><label>${esc(this.t('portfolioRateWindow'))}<input type="number" name="rate-window" min="1" max="300" value="${esc(snapshot?.portfolio.signatureRate?.windowSeconds ?? '')}"></label><label>${esc(this.t('portfolioRateLimit'))}<input type="number" name="rate-limit" min="1" max="1000" value="${esc(snapshot?.portfolio.signatureRate?.maxSignatures ?? '')}"></label></div><p class="wallet-private-hint">${esc(this.t('portfolioRateHint'))}</p></fieldset>`,
    );
    const chainField = d.querySelector<HTMLSelectElement>('[name=portfolio-chain]')!;
    const equityInput = d.querySelector<HTMLInputElement>('[name=portfolio-equity]')!;
    if (snapshot?.portfolio.equityFloorUsdAtomic)
      equityInput.value = tokenAmount(snapshot.portfolio.equityFloorUsdAtomic, 8);
    const showEquity = () => {
      equityInput.disabled = chainField.value !== '8453';
      equityInput.closest<HTMLElement>('[data-equity-field]')!.hidden = equityInput.disabled;
    };
    chainField.addEventListener('change', showEquity);
    showEquity();
    scopeNode.append(scope.root);
    const form = d.querySelector('form')!,
      submit = d.querySelector<HTMLButtonElement>('[data-submit]')!;
    let challenge = '';
    form.addEventListener('input', () => {
      if (challenge)
        submit.disabled =
          (form.elements.namedItem('portfolio-ack') as HTMLInputElement).value !==
          'ALLOW PORTFOLIO';
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit.disabled = true;
      this.run(d, async () => {
        try {
          if (!challenge) {
            const values = new FormData(form),
              members = [...form.querySelectorAll<HTMLInputElement>('[data-member]:checked')].map(
                (n) => n.dataset.member!,
              );
            const hours = Number(values.get('portfolio-hours'));
            const windowSeconds = values.get('rate-window'),
              maxSignatures = values.get('rate-limit');
            const result = await this.call<{ id: string }>('challenge', {
              operation: snapshot ? 'edit' : 'create',
              ...(snapshot ? { id: snapshot.portfolio.id, revision: snapshot.revision } : {}),
              name: values.get('portfolio-name'),
              chainId: snapshot?.portfolio.chainId ?? Number(values.get('portfolio-chain')),
              walletIds: snapshot?.portfolio.members.map((m) => m.walletId) ?? members,
              ...(hours === -1 ? {} : { hours }),
              maxFeeEth: values.get('portfolio-fee'),
              limits: scope.read(),
              ...(!equityInput.disabled && { equityFloorUsd: equityInput.value.trim() }),
              signatureRate:
                windowSeconds || maxSignatures
                  ? { windowSeconds: Number(windowSeconds), maxSignatures: Number(maxSignatures) }
                  : null,
            });
            challenge = result.id;
            scope.freeze();
            form
              .querySelectorAll<HTMLInputElement>('input,select,textarea,button')
              .forEach((n) => (n.disabled = true));
            d.querySelector<HTMLElement>('[data-ack]')!.hidden = false;
            const ack = form.elements.namedItem('portfolio-ack') as HTMLInputElement;
            ack.disabled = false;
            ack.focus();
            submit.textContent = this.t('portfolioConfirm');
          } else {
            await this.call('confirm', {
              challengeId: challenge,
              ack: (form.elements.namedItem('portfolio-ack') as HTMLInputElement).value,
              confirmed: true,
            });
            await this.open();
            d.close();
          }
        } finally {
          submit.disabled =
            !!challenge &&
            (form.elements.namedItem('portfolio-ack') as HTMLInputElement).value !==
              'ALLOW PORTFOLIO';
        }
      });
    });
  }
  async detail(id: string): Promise<void> {
    const snapshot = await this.call<Snapshot>('get', { id }),
      p = snapshot.portfolio;
    const rows = walletBudget({
      revoked: snapshot.state !== 'active',
      expiresAt: p.expiresAt,
      limits: p.limits,
      usage: snapshot.usage,
      period: snapshot.period,
    });
    const d = this.dialog(
      p.name,
      `<p class="wallet-private-hint">${esc(this.t('portfolioHint'))}</p><p>${chainLabel(p.chainId)} · ${esc(this.t('portfolio' + snapshot.state[0]!.toUpperCase() + snapshot.state.slice(1)))} · ${esc(this.t('portfolioFee'))}: ${tokenAmount(p.maxFeeWei, 18)}</p><ul class="wallet-portfolio-member-list">${p.members.map((m) => `<li><strong>${esc(this.options.wallets().find((w) => w.id === m.walletId)?.name ?? m.walletId)}</strong><code>${esc(m.address)}</code></li>`).join('')}</ul><div data-scope></div><div class="wallet-budget-list">${rows.map((row) => `<article class="wallet-budget-row"><header><strong>${esc(this.t(row.label))}</strong><small>${esc(row.asset)}</small></header><p>${esc(row.usedText)}${row.breakdown ? '' : ' / ' + esc(row.limitText ?? this.t('usageUnlimited'))}</p>${row.limitText !== null ? `<progress max="100" value="${executionPercent(row.used, row.limit)}"></progress>` : ''}</article>`).join('')}</div><p class="wallet-private-hint">${esc(this.t('portfolioMore'))}</p><footer>${snapshot.state !== 'removed' ? `<button type="button" data-pause>${esc(this.t('portfolioPause'))}</button><button type="button" data-resume>${esc(this.t('portfolioResume'))}</button><button type="button" data-remove>${esc(this.t('portfolioRemove'))}</button>` : ''}</footer>`,
    );
    d.classList.add('wallet-budget-dialog');
    if (snapshot.signatureRate && snapshot.state !== 'removed') {
      d.querySelector('[data-scope]')!.insertAdjacentHTML(
        'beforebegin',
        `<section class="wallet-budget-row" data-portfolio-rate><header><strong>${esc(this.t('portfolioRate'))}</strong><button type="button">${esc(this.t('portfolioRateRefresh'))}</button></header><p role="status"></p><progress></progress></section>`,
      );
      const panel = d.querySelector('[data-portfolio-rate]')!;
      const progress = panel.querySelector('progress')!;
      const status = panel.querySelector('[role=status]')!;
      const show = (rate?: RateObservation | null) => {
        progress.hidden = !rate;
        if (!rate) {
          status.textContent = this.t('portfolioRateDisabled');
          return;
        }
        const message =
          rate.status === 'clock-rollback'
            ? walletStatus(this.options.language(), 'WALLET_PORTFOLIO_RATE_CLOCK_ROLLBACK')
            : this.t(
                {
                  ready: 'portfolioRateReady',
                  limited: 'portfolioRateLimited',
                  settling: 'portfolioRateSettling',
                }[rate.status],
              );
        status.textContent = `${rate.used} / ${rate.maxSignatures} · ${rate.windowSeconds} s · ${message}${rate.nextEligibleAt ? ' · ' + this.t('portfolioRateNext') + ' ' + new Date(rate.nextEligibleAt).toLocaleString() : ''}`;
        progress.max = rate.maxSignatures;
        progress.value = Math.min(rate.used, progress.max);
        progress.setAttribute('aria-label', this.t('portfolioRate'));
      };
      show(snapshot.signatureRate);
      const refresh = panel.querySelector('button')!;
      refresh.onclick = () =>
        this.run(d, async () => {
          refresh.disabled = true;
          try {
            show((await this.call<Snapshot>('get', { id })).signatureRate);
          } finally {
            refresh.disabled = false;
          }
        });
    }
    if (p.equityFloorUsdAtomic && snapshot.state !== 'removed') {
      d.querySelector('[data-scope]')!.insertAdjacentHTML(
        'beforebegin',
        `<section><p>${esc(this.t('portfolioEquityFloor'))} · ${esc(tokenAmount(p.equityFloorUsdAtomic, 8))} USD</p><p class="wallet-private-hint">${esc(this.t('portfolioEquityHelp'))}</p><button type="button" data-equity-check>${esc(this.t('portfolioEquityCheck'))}</button><p role="status" data-equity-status></p></section>`,
      );
      const check = d.querySelector<HTMLButtonElement>('[data-equity-check]')!;
      check.addEventListener('click', () =>
        this.run(d, async () => {
          check.disabled = true;
          const status = d.querySelector<HTMLElement>('[data-equity-status]')!;
          status.textContent = this.t('portfolioHoldingsLoading');
          try {
            const result = await this.call<Equity>('equity', { id });
            status.textContent = result.error
              ? walletStatus(this.options.language(), result.error)
              : result.status === 'disabled'
                ? this.t('portfolioEquityDisabled')
                : `${this.t(result.status === 'below' ? 'portfolioEquityBelow' : 'portfolioEquitySatisfied')} · ${this.t('portfolioEquityAvailable')} ${result.availableUsd} USD · #${result.block}`;
            status.title = result.blockHash || '';
          } finally {
            check.disabled = false;
          }
        }),
      );
    }
    d.querySelector('footer')!.insertAdjacentHTML(
      'beforeend',
      `<button type="button" data-refresh>${esc(this.t('periodRefresh'))}</button><button type="button" data-holdings>${esc(this.t('portfolioHoldings'))}</button>${snapshot.state !== 'removed' ? `<button type="button" data-edit>${esc(this.t('portfolioEdit'))}</button>` : ''}<button type="button" data-revisions>${esc(this.t('portfolioRevisions'))}</button>`,
    );
    d.querySelector('[data-holdings]')!.addEventListener('click', () => {
      this.holdings(id);
      d.close();
    });
    if ([8453, 84532].includes(p.chainId)) {
      if (p.allowanceCeiling && snapshot.state !== 'removed') {
        const rule = p.allowanceCeiling;
        d.querySelector('[data-scope]')!.insertAdjacentHTML(
          'beforebegin',
          `<p class="wallet-private-hint">${esc(this.t('portfolioAllowanceCeiling'))} · ${esc(tokenAmount(rule.atoms, rule.decimals))} <code>${esc(rule.token)}</code></p>`,
        );
      }
      d.querySelector('footer')!.insertAdjacentHTML(
        'beforeend',
        `<button type="button" data-exposure>${esc(this.t('portfolioExposure'))}</button><button type="button" data-performance>${esc(this.t('portfolioPerformance'))}</button>`,
      );
      d.querySelector('[data-exposure]')!.addEventListener('click', () =>
        this.run(d, async () => {
          await this.allowanceExposure(id, p.chainId === 8453 ? 'base' : 'base-sepolia');
          d.close();
        }),
      );
      d.querySelector('[data-performance]')!.addEventListener('click', () =>
        this.run(d, async () => {
          await this.performance(p);
          d.close();
        }),
      );
    }
    d.querySelector('[data-edit]')?.addEventListener('click', () =>
      this.run(d, async () => {
        await this.create(snapshot);
        d.close();
      }),
    );
    d.querySelector('[data-refresh]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.detail(id);
        d.close();
      }),
    );
    d.querySelector('[data-revisions]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.revisions(id);
        d.close();
      }),
    );
    if (snapshot.period) {
      d.querySelector('[data-scope]')!.insertAdjacentHTML(
        'beforebegin',
        periodNote(snapshot.period, this.t, this.options.language()),
      );
      d.querySelector('footer')!.insertAdjacentHTML(
        'beforeend',
        `<button type="button" data-period-history>${esc(this.t('periodHistory'))}</button>`,
      );
      d.querySelector('[data-period-history]')!.addEventListener('click', () =>
        this.run(d, async () => {
          await openPeriodHistory({ ...this.options, t: this.t }, snapshot.period!.identity);
          d.close();
        }),
      );
    }
    if (snapshot.state === 'paused')
      d.querySelector<HTMLButtonElement>('[data-pause]')!.disabled = true;
    if (snapshot.state === 'active')
      d.querySelector<HTMLButtonElement>('[data-resume]')!.disabled = true;
    const scope = new WalletScopeEditor(this.t, walletScopeValues(p.limits));
    scope.freeze();
    d.querySelector('[data-scope]')!.append(scope.root);
    d.querySelector('[data-pause]')?.addEventListener('click', () =>
      this.run(d, async () => {
        await this.call('pause', { id, revision: snapshot.revision });
        await this.detail(id);
        d.close();
      }),
    );
    for (const [selector, operation] of [
      ['[data-resume]', 'active'],
      ['[data-remove]', 'removed'],
    ])
      d.querySelector(selector!)?.addEventListener('click', () => {
        d.close();
        this.confirmState(snapshot, operation!);
      });
  }
  private async allowanceExposure(
    id: string,
    chain: AllowanceReview['chain'],
    monitored = false,
  ): Promise<void> {
    const d = this.dialog(
      this.t(monitored ? 'portfolioMonitorEvidence' : 'portfolioExposure'),
      `<p class="wallet-private-hint">${esc(this.t('portfolioExposureHint'))}</p>
      <div class="wallet-policy-grid" ${monitored ? 'hidden' : ''}><label>${esc(this.t('portfolioExposureBlocks'))}<input data-exposure-blocks type="number" value="1000" min="1" max="2000" required></label><label>${esc(this.t('portfolioExposureToken'))}<input data-exposure-token maxlength="42" pattern="0x[0-9a-fA-F]{40}" spellcheck="false"></label></div>
      <div class="wallet-allowance-actions" ${monitored ? 'hidden' : ''}><button type="button" data-mode="recent" class="quant-primary">${esc(this.t('portfolioExposureRecent'))}</button><button type="button" data-mode="older" disabled>${esc(this.t('portfolioExposureOlder'))}</button><button type="button" data-mode="refresh" disabled>${esc(this.t('portfolioExposureRefresh'))}</button><button type="button" data-mode="fresh" disabled>${esc(this.t('portfolioExposureFresh'))}</button><button type="button" data-exposure-monitor>${esc(this.t('portfolioMonitor'))}</button></div>
      <div class="wallet-allowance-history" ${monitored ? 'hidden' : ''}><label>${esc(this.t('portfolioExposureHistory'))}<select data-exposure-history disabled></select></label><nav data-history-nav hidden aria-label="${esc(this.t('portfolioExposureHistory'))}"><button type="button" data-history-prev hidden>${esc(this.t('portfolioPrevious'))}</button><button type="button" data-history-next hidden>${esc(this.t('portfolioPageNext'))}</button></nav><button type="button" data-exposure-ceiling>${esc(this.t('portfolioAllowanceCeiling'))}</button></div>
      <p role="status" data-exposure-progress></p><section data-exposure-summary></section><section data-exposure-pairs></section>
      <footer><button type="button" data-exposure-back>${esc(this.t('portfolioBack'))}</button><label><input type="checkbox" role="switch" data-exposure-all>${esc(this.t('portfolioExposureAll'))}</label><button type="button" data-pair-prev disabled>${esc(this.t('portfolioPrevious'))}</button><button type="button" data-pair-next disabled>${esc(this.t('portfolioPageNext'))}</button></footer>`,
    );
    const el = <T extends HTMLElement = HTMLElement>(selector: string) =>
      d.querySelector<T>(selector)!;
    const token = el<HTMLInputElement>('[data-exposure-token]'),
      blocks = el<HTMLInputElement>('[data-exposure-blocks]');
    const selector = el<HTMLSelectElement>('[data-exposure-history]');
    let current: AllowanceReport | undefined,
      offset = 0,
      historyOffset = 0,
      historyNext: number | null = null;
    const filter = () => (el<HTMLInputElement>('[data-exposure-all]').checked ? 'all' : 'review');
    const textAmount = (value: AllowanceAmount) => value.amount ?? value.atomic ?? '—';
    const render = (report: AllowanceReport) => {
      current = report;
      token.value = report.coverage.tokens.length === 1 ? report.coverage.tokens[0]! : '';
      const coverage = report.coverage;
      const ranges = [
        ...coverage.scannedRanges,
        ...(coverage.monitoredRange ? [coverage.monitoredRange] : []),
      ];
      const partial =
        coverage.scanIncomplete || coverage.unreadablePairs || coverage.unknownBalances;
      el('[data-exposure-summary]').innerHTML =
        `<p title="${esc(report.blockHash)}">${esc(this.t('assetBlock'))} #${esc(report.block)} · ${esc(new Date(report.observedAt).toLocaleString())}</p>${partial ? `<p class="wallet-warning">${esc(this.t('portfolioExposurePartial'))}</p>` : ''}
      <div class="wallet-budget-list">${report.totals.map((asset) => `<article class="wallet-budget-row"><header><strong>${esc(asset.symbol || asset.token)}</strong><small>${esc(this.t('portfolioHoldings'))} · ${esc(textAmount(asset.balance))}</small></header><p>${esc(this.t('portfolioExposureMeasured'))} · ${esc(textAmount(asset.measured))}</p><small>${esc(this.t('portfolioExposurePotential'))} · ${esc(textAmount(asset.includingPermit2))}</small></article>`).join('')}</div>
      <p class="wallet-private-hint">${esc(this.t('portfolioExposurePotentialHint'))}</p><details><summary>${esc(this.t('portfolioExposureCoverage'))} · ${ranges.length}</summary><ul>${ranges.map((range) => `<li>#${esc(range.fromBlock)}–#${esc(range.toBlock)}</li>`).join('')}</ul></details>`;
      el('[data-exposure-pairs]').innerHTML = report.items.length
        ? `<div class="wallet-portfolio-list">${report.items.map((row, i) => `<article class="wallet-budget-row"><header><strong>${esc(row.walletName)} · ${esc(row.symbol || row.token)}</strong><small>${esc(row.upstream ? this.t('allowancePermit2Outer') : row.protocol === 'permit2' ? 'Permit2' : 'ERC-20')}</small></header><code>${esc(row.spender)}</code><p>${esc(this.t('portfolioExposure' + row.status[0]!.toUpperCase() + row.status.slice(1)))} · ${esc(textAmount(row.spendable))}${row.unlimited ? ` · ${esc(this.t('allowanceUnlimited'))}` : ''}</p>${this.options.reviewAllowance ? `<button type="button" data-exposure-review="${i}">${esc(this.t('portfolioExposureReview'))}</button>` : ''}</article>`).join('')}</div>`
        : `<p>${esc(this.t('portfolioEmpty'))}</p>`;
      el<HTMLButtonElement>('[data-mode=older]').disabled = coverage.nextEndBlock === null;
      el<HTMLButtonElement>('[data-mode=refresh]').disabled = false;
      el<HTMLButtonElement>('[data-mode=fresh]').disabled = false;
      el<HTMLButtonElement>('[data-pair-prev]').disabled = offset === 0;
      el<HTMLButtonElement>('[data-pair-next]').disabled = report.next === null;
    };
    const list = async () => {
      const result = await this.call<{ items: AllowanceReport[]; next: number | null }>(
        'allowances.list',
        { id, offset: historyOffset, limit: 12 },
      );
      selector.innerHTML = result.items.length
        ? result.items
            .map(
              (row) =>
                `<option value="${esc(row.reportId)}">#${esc(row.block)} · ${esc(new Date(row.observedAt).toLocaleString())}</option>`,
            )
            .join('')
        : `<option value="">${esc(this.t('portfolioEmpty'))}</option>`;
      if (current && result.items.some((row) => row.reportId === current!.reportId))
        selector.value = current.reportId;
      historyNext = result.next;
      selector.disabled = !result.items.length;
      el('[data-history-prev]').hidden = historyOffset === 0;
      el('[data-history-next]').hidden = historyNext === null;
      el('[data-history-nav]').hidden = historyOffset === 0 && historyNext === null;
    };
    const load = async (reportId?: string) => {
      const report = monitored
        ? (
            await this.call<{ report: AllowanceReport | null }>('allowanceMonitor.get', {
              id,
              includeReport: true,
              filter: filter(),
              offset,
              limit: 8,
            })
          ).report
        : await this.call<AllowanceReport>('allowances.get', {
            id,
            reportId,
            filter: filter(),
            offset,
            limit: 8,
          });
      if (report) render(report);
    };
    const scan = async (mode: string) => {
      const scopedToken =
        current?.coverage.tokens.length === 1 ? current.coverage.tokens[0] : undefined;
      const requestedToken =
        mode === 'older' || mode === 'refresh' ? scopedToken : token.value.trim() || undefined;
      if (
        (mode !== 'refresh' && !blocks.reportValidity()) ||
        (mode !== 'older' && mode !== 'refresh' && !token.reportValidity())
      )
        return;
      const usePrevious =
        mode !== 'fresh' && current && scopedToken?.toLowerCase() === requestedToken?.toLowerCase();
      const progress = el('[data-exposure-progress]');
      progress.textContent = this.t('portfolioHoldingsLoading');
      try {
        const report = await this.call<AllowanceReport>('allowances.scan', {
          id,
          mode: mode === 'fresh' ? 'recent' : mode,
          blocks: mode === 'refresh' ? undefined : Number(blocks.value),
          token: requestedToken,
          ...(usePrevious && { previousReportId: current!.reportId }),
          filter: filter(),
          limit: 8,
        });
        offset = historyOffset = 0;
        render(report);
        await list();
      } finally {
        progress.textContent = '';
      }
    };
    selector.addEventListener('change', () =>
      this.run(d, async () => {
        offset = 0;
        await load(selector.value);
      }),
    );
    el('[data-exposure-all]').addEventListener('change', () =>
      this.run(d, async () => {
        offset = 0;
        if (current) await load(current.reportId);
      }),
    );
    d.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.hasAttribute('data-exposure-back'))
        return this.run(d, async () => {
          if (!monitored) await this.detail(id);
          d.close();
        });
      if (button.hasAttribute('data-exposure-monitor'))
        return this.allowanceMonitor(id, chain, current);
      if (button.hasAttribute('data-exposure-ceiling'))
        return this.run(d, () => this.allowanceCeiling(id, current));
      if (button.dataset.mode) return this.run(d, () => scan(button.dataset.mode!));
      if (button.dataset.exposureReview !== undefined && current) {
        const row = current.items[Number(button.dataset.exposureReview)];
        if (row)
          this.options.reviewAllowance?.(row.walletId, {
            chain,
            protocol: row.protocol,
            token: row.token,
            spender: row.spender,
          });
      }
      if (button.hasAttribute('data-history-prev') || button.hasAttribute('data-history-next'))
        return this.run(d, async () => {
          historyOffset = button.hasAttribute('data-history-prev')
            ? Math.max(0, historyOffset - 12)
            : (historyNext ?? historyOffset);
          await list();
          if (selector.value) {
            offset = 0;
            await load(selector.value);
          }
        });
      if (
        current &&
        (button.hasAttribute('data-pair-prev') || button.hasAttribute('data-pair-next'))
      )
        return this.run(d, async () => {
          offset = button.hasAttribute('data-pair-prev')
            ? Math.max(0, offset - 8)
            : (current!.next ?? offset);
          await load(current!.reportId);
        });
    });
    this.run(d, async () => {
      if (monitored) return load();
      await list();
      if (selector.value) await load(selector.value);
    });
  }
  private async allowanceCeiling(id: string, baseline?: AllowanceReport): Promise<void> {
    const snapshot = await this.call<Snapshot>('get', { id });
    const rule = snapshot.portfolio.allowanceCeiling;
    const canSet =
      snapshot.state !== 'removed' &&
      baseline?.coverage.mode === 'recent' &&
      !baseline.coverage.scanIncomplete &&
      !baseline.coverage.unknownBalances &&
      !baseline.coverage.unreadablePairs;
    const assets = canSet
      ? baseline.totals.filter((asset) => Number.isInteger(asset.decimals))
      : [];
    const d = this.dialog(
      this.t('portfolioAllowanceCeiling'),
      `<p class="wallet-private-hint">${esc(this.t('portfolioAllowanceCeilingHint'))}</p>
      ${rule ? `<p>${esc(this.t('portfolioAllowanceCeiling'))} · ${esc(tokenAmount(rule.atoms, rule.decimals))} <code>${esc(rule.token)}</code></p>` : ''}
      <form><div class="wallet-policy-grid" ${assets.length ? '' : 'hidden'}><label>${esc(this.t('allowanceToken'))}<select name="token">${assets.map((asset) => `<option value="${esc(asset.token)}" ${asset.token === rule?.token ? 'selected' : ''}>${esc(asset.symbol ? `${asset.symbol} · ${asset.token}` : asset.token)}</option>`).join('')}</select></label><label>${esc(this.t('portfolioAllowanceCeilingAmount'))}<input name="amount" inputmode="decimal" maxlength="100" required value="${esc(rule ? tokenAmount(rule.atoms, rule.decimals) : '')}"></label></div>
      <p>${esc(assets.length ? `${this.t('portfolioMonitorBaseline')} #${baseline!.block}` : this.t('portfolioMonitorNeedsBaseline'))}</p>
      <footer>${rule && snapshot.state !== 'removed' ? `<button type="button" data-ceiling-remove>${esc(this.t('portfolioAllowanceCeilingRemove'))}</button>` : ''}<button type="submit" ${assets.length ? '' : 'disabled'}>${esc(this.t('portfolioReview'))}</button></footer></form>`,
    );
    const confirm = (ceiling: { reportId: string; token: string; amount: string } | null) => {
      const summary = ceiling
        ? `${this.t('portfolioAllowanceCeiling')} · ${ceiling.amount} · ${ceiling.token} · #${baseline!.block}`
        : this.t('portfolioAllowanceCeilingRemove');
      this.confirmation(
        { id, operation: 'allowance-ceiling', revision: snapshot.revision, ceiling },
        this.t('portfolioAllowanceCeiling'),
        summary,
        async () => {
          d.close();
        },
      );
    };
    const form = d.querySelector('form')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!assets.length) return;
      const input = new FormData(form);
      confirm({
        reportId: baseline!.reportId,
        token: String(input.get('token')),
        amount: String(input.get('amount')).trim(),
      });
    });
    d.querySelector('[data-ceiling-remove]')?.addEventListener('click', () => confirm(null));
  }
  private allowanceMonitor(
    id: string,
    chain: AllowanceReview['chain'],
    baseline?: AllowanceReport,
  ): void {
    const canStart =
      baseline?.coverage.mode === 'recent' &&
      !baseline.coverage.scanIncomplete &&
      !baseline.coverage.unknownBalances &&
      !baseline.coverage.unreadablePairs;
    const d = this.dialog(
      this.t('portfolioMonitor'),
      `<p class="wallet-private-hint">${esc(this.t('portfolioMonitorHint'))}</p>
      <section data-monitor-state aria-live="polite"></section>
      <label>${esc(this.t('portfolioMonitorInterval'))}<select data-monitor-interval>${[60, 300, 900].map((seconds) => `<option value="${seconds}" ${seconds === 300 ? 'selected' : ''}>${seconds / 60}</option>`).join('')}</select></label>
      <p class="wallet-private-hint">${esc(canStart ? `${this.t('portfolioMonitorBaseline')} #${baseline.block}` : this.t('portfolioMonitorNeedsBaseline'))}</p>
      <div class="wallet-allowance-actions"><button type="button" data-monitor-start ${canStart ? '' : 'disabled'}>${esc(this.t('portfolioMonitorStart'))}</button><button type="button" data-monitor-stop disabled>${esc(this.t('portfolioMonitorStop'))}</button><button type="button" data-monitor-evidence disabled>${esc(this.t('portfolioMonitorEvidence'))}</button><button type="button" data-monitor-refresh>${esc(this.t('assetRefresh'))}</button></div>
      <h4>${esc(this.t('portfolioMonitorHistory'))}</h4><div data-monitor-history></div><footer><button type="button" data-monitor-prev disabled>${esc(this.t('portfolioPrevious'))}</button><button type="button" data-monitor-next disabled>${esc(this.t('portfolioPageNext'))}</button></footer>`,
    );
    const el = <T extends HTMLElement = HTMLElement>(selector: string) =>
      d.querySelector<T>(selector)!;
    const interval = el<HTMLSelectElement>('[data-monitor-interval]');
    let state: AllowanceMonitor | undefined,
      offset = 0;
    const textAmount = (value: AllowanceAmount) => value.amount ?? value.atomic ?? '—';
    const load = async () => {
      state = await this.call<AllowanceMonitor>('allowanceMonitor.get', { id, offset, limit: 5 });
      const date = (value?: number) => (value ? new Date(value).toLocaleString() : '—');
      el('[data-monitor-state]').innerHTML =
        `<strong>${esc(this.t('portfolioMonitor_' + state.status))}</strong>
        ${state.lastBlock ? `<p>${esc(this.t('assetBlock'))} #${esc(state.lastBlock)} · ${esc(date(state.checkedAt))}</p>` : ''}
        ${state.nextAt ? `<p>${esc(this.t('portfolioMonitorNextCheck'))} · ${esc(date(state.nextAt))}</p>` : ''}
        ${state.error ? `<p class="wallet-warning">${esc(walletStatus(this.options.language(), state.error))}</p>` : ''}`;
      el('[data-monitor-history]').innerHTML = state.notices.length
        ? `<div class="wallet-portfolio-list">${state.notices
            .map(
              (
                notice,
                i,
              ) => `<article class="wallet-budget-row"><header><strong title="${esc(notice.blockHash)}">#${esc(notice.block)} · ${esc(date(notice.observedAt))}</strong><small>${esc(this.t('portfolioMonitorPairs'))} ${notice.pairCount} · ${esc(this.t('portfolioMonitorIncreases'))} ${notice.increaseCount}</small></header>
        ${notice.increases.map((row) => `<p>${esc(row.symbol || row.token)} · ${esc(this.t(row.metric === 'measured' ? 'portfolioExposureMeasured' : 'portfolioExposurePotential'))} · ${esc(textAmount(row.before))} → ${esc(textAmount(row.after))}</p>`).join('')}
        ${notice.pairs.map((row, j) => `<p>${esc(row.walletName)} · ${esc(row.protocol === 'permit2' ? 'Permit2' : 'ERC-20')} <code>${esc(row.spender)}</code>${this.options.reviewAllowance ? ` <button type="button" data-monitor-pair="${i}:${j}">${esc(this.t('portfolioExposureReview'))}</button>` : ''}</p>`).join('')}
        </article>`,
            )
            .join('')}</div>`
        : `<p>${esc(this.t('portfolioEmpty'))}</p>`;
      el<HTMLButtonElement>('[data-monitor-stop]').disabled = !state.enabled;
      el<HTMLButtonElement>('[data-monitor-evidence]').disabled = !state.lastBlock;
      el<HTMLButtonElement>('[data-monitor-prev]').disabled = offset === 0;
      el<HTMLButtonElement>('[data-monitor-next]').disabled = state.next === null;
    };
    d.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || !state) return;
      if (button.hasAttribute('data-monitor-evidence'))
        return void this.allowanceExposure(id, chain, true);
      if (button.dataset.monitorPair) {
        const [i, j] = button.dataset.monitorPair.split(':').map(Number);
        const pair = state.notices[i!]?.pairs[j!];
        if (pair)
          this.options.reviewAllowance?.(pair.walletId, {
            chain,
            token: pair.token,
            spender: pair.spender,
            protocol: pair.protocol,
          });
        return;
      }
      this.run(d, async () => {
        if (button.hasAttribute('data-monitor-start') && canStart) {
          await this.call('allowanceMonitor.start', {
            id,
            reportId: baseline.reportId,
            expectedRevision: state!.revision,
            intervalSeconds: Number(interval.value),
          });
          offset = 0;
        } else if (button.hasAttribute('data-monitor-stop')) {
          await this.call('allowanceMonitor.stop', { id, expectedRevision: state!.revision });
        } else if (button.hasAttribute('data-monitor-prev')) offset = Math.max(0, offset - 5);
        else if (button.hasAttribute('data-monitor-next')) offset = state!.next ?? offset;
        else if (!button.hasAttribute('data-monitor-refresh')) return;
        await load();
      });
    });
    this.run(d, async () => {
      await load();
      if (state?.intervalSeconds) interval.value = String(state.intervalSeconds);
    });
  }
  private async performance(portfolio: Portfolio): Promise<void> {
    const names = new Map(this.options.wallets().map(({ id, name }) => [id, name]));
    const d = this.dialog(
      this.t('portfolioPerformance'),
      `
      <p class="wallet-private-hint">${esc(this.t('portfolioPerformanceHint'))}</p>
      <div class="wallet-allowance-history"><label>${esc(this.t('portfolioMembers'))}<select data-performance-wallet><option value="">${esc(this.t('portfolioPerformanceAll'))}</option>${portfolio.members.map((m) => `<option value="${esc(m.walletId)}">${esc(names.get(m.walletId) ?? m.address)}</option>`).join('')}</select></label><button type="button" data-performance-refresh>${esc(this.t('periodRefresh'))}</button><button type="button" data-performance-price hidden>${esc(this.t('portfolioPerformancePrice'))}</button></div>
      <p data-performance-price-status role="status" hidden></p>
      <section data-performance-summary aria-live="polite"></section>
      <section data-performance-rows></section>
      <footer><button type="button" data-performance-back>${esc(this.t('portfolioBack'))}</button><button type="button" data-performance-prev disabled>${esc(this.t('portfolioPrevious'))}</button><span data-performance-page></span><button type="button" data-performance-next disabled>${esc(this.t('portfolioPageNext'))}</button></footer>`,
    );
    const select = d.querySelector<HTMLSelectElement>('[data-performance-wallet]')!;
    const previous = d.querySelector<HTMLButtonElement>('[data-performance-prev]')!;
    const next = d.querySelector<HTMLButtonElement>('[data-performance-next]')!;
    const price = d.querySelector<HTMLButtonElement>('[data-performance-price]')!;
    const priceStatus = d.querySelector<HTMLElement>('[data-performance-price-status]')!;
    const limit = 6;
    let report: PerformanceReport | undefined,
      offset = 0,
      displayedWallet = '',
      pricingOffset = 0;
    const missing = '—';
    const display = (value: PerformanceAmount | undefined | null, units: string) =>
      value ? `${value.amount} ${units}` : missing;
    const render = () => {
      const { totals, fees, historicalFees, items, total } = report!;
      const cards = [
        ['portfolioPerformanceGross', display(totals.realizedGrossUsdc, 'USDC')],
        ['portfolioPerformanceMatched', display(totals.matchedWeth, 'WETH')],
        [
          'portfolioPerformanceOpen',
          display(totals.openWeth, 'WETH') + ' · ' + display(totals.openCostUsdc, 'USDC'),
        ],
        ['portfolioPerformanceCost', display(totals.matchedCostUsdc, 'USDC')],
        ['portfolioPerformanceProceeds', display(totals.matchedProceedsUsdc, 'USDC')],
        ['portfolioPerformanceUnmatched', display(totals.unmatchedSaleWeth, 'WETH')],
      ];
      if (historicalFees?.available && totals.matchedSaleCount)
        cards.splice(1, 0, [
          'portfolioPerformanceNet',
          `${display(totals.realizedAfterSwapFeesUsdc, 'USDC')} · ${totals.pricedSaleCount}/${totals.matchedSaleCount}`,
        ]);
      const feeRows = [
        ['portfolioPerformanceFeeL2', fees.l2GasWei, fees.l2Receipts],
        ['portfolioPerformanceFeeL1', fees.l1DataFeeWei, fees.l1Receipts],
        ['portfolioPerformanceFeeOperator', fees.operatorFeeWei, fees.operatorReceipts],
      ] as const;
      const fee = (wei: string | null) => (wei === null ? missing : `${tokenAmount(wei, 18)} ETH`);
      d.querySelector('[data-performance-summary]')!.innerHTML =
        `<dl class="wallet-performance-grid">${cards.map(([key, value]) => `<div class="wallet-budget-row"><dt>${esc(this.t(key!))}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
        ${totals.missingCount ? `<p class="wallet-warning">${esc(this.t('portfolioPerformanceMissing'))} · ${totals.missingCount} · ${esc(this.t('portfolioPerformanceInterrupted'))} ${esc(display(totals.interruptedBasisWeth, 'WETH'))}</p>` : ''}
        <details><summary>${esc(this.t('portfolioPerformanceFees'))} · ${esc(fee(fees.totalWei))}</summary><dl class="wallet-performance-fees">${feeRows.map(([label, wei, count]) => `<div><dt>${esc(this.t(label))}</dt><dd>${esc(fee(wei))} · ${count}/${fees.finalizedTransactions}</dd></div>`).join('')}
        ${historicalFees?.available ? `<div><dt>${esc(this.t('portfolioPerformanceHistoricalFees'))}</dt><dd>${esc(display(historicalFees.totalUsdc ?? historicalFees.knownUsdc, 'USDC'))} · ${historicalFees.priced}/${historicalFees.transactions}</dd></div>` : ''}
        ${totals.matchedSwapFeesUsdc ? `<div><dt>${esc(this.t('portfolioPerformanceMatchedFees'))}</dt><dd>${esc(display(totals.matchedSwapFeesUsdc, 'USDC'))}</dd></div>` : ''}</dl></details>`;
      d.querySelector('[data-performance-rows]')!.innerHTML = items.length
        ? `<div class="wallet-portfolio-list">${items
            .map(
              (
                row,
              ) => `<article class="wallet-budget-row"><header><strong>${esc(names.get(row.walletId) ?? row.walletId)}</strong><small>${row.block ? '#' + esc(row.block) : ''}</small></header><code>${esc(row.txHash)}</code>
           ${row.side === 'unknown' ? `<p>${esc(this.t('portfolioPerformanceMissing'))}</p>` : row.side === 'buy' ? `<p>${esc(this.t('portfolioPerformanceBuy'))} · ${esc(display(row.boughtWeth, 'WETH'))} · ${esc(display(row.paidUsdc, 'USDC'))}</p>` : `<p>${esc(this.t('portfolioPerformanceGross'))} · ${esc(display(row.realizedGrossUsdc, 'USDC'))}</p><small>${esc(this.t('portfolioPerformanceCost'))} ${esc(display(row.matchedCostUsdc, 'USDC'))} · ${esc(this.t('portfolioPerformanceProceeds'))} ${esc(display(row.matchedProceedsUsdc, 'USDC'))}</small><p><small>${esc(this.t('portfolioPerformanceMatched'))} ${esc(display(row.matchedWeth, 'WETH'))} · ${esc(this.t('portfolioPerformanceUnmatched'))} ${esc(display(row.unmatchedSaleWeth, 'WETH'))}</small></p>`}
           ${row.realizedAfterSwapFeesUsdc ? `<p>${esc(this.t('portfolioPerformanceNet'))} · ${esc(display(row.realizedAfterSwapFeesUsdc, 'USDC'))}</p>` : ''}
           ${row.feeQuote ? `<details><summary>${esc(this.t('portfolioPerformanceHistoricalFees'))} · ${esc(display(row.transactionFeeUsdc, 'USDC'))}</summary><p>${esc(this.t('portfolioPerformanceQuote'))} · ETH/USD #${esc(row.feeQuote.eth.roundId)} · USDC/USD #${esc(row.feeQuote.usdc.roundId)}</p></details>` : ''}</article>`,
            )
            .join('')}</div>`
        : `<p>${esc(this.t('portfolioPerformanceEmpty'))}</p>`;
      previous.disabled = offset === 0;
      next.disabled = report!.next === null;
      price.hidden = !historicalFees?.available || !historicalFees.transactions;
      price.textContent = this.t(
        pricingOffset ? 'portfolioPerformancePriceNext' : 'portfolioPerformancePrice',
      );
      d.querySelector('[data-performance-page]')!.textContent = total
        ? `${offset + 1}–${offset + items.length} / ${total}`
        : '';
    };
    const load = async (start = 0, snapshotId?: string, walletId = select.value) => {
      select.disabled = true;
      try {
        report = await this.call<PerformanceReport>('performance', {
          id: portfolio.id,
          walletId: walletId || undefined,
          offset: start,
          limit,
          snapshotId,
        });
        offset = start;
        displayedWallet = walletId;
        render();
      } finally {
        select.value = displayedWallet;
        select.disabled = false;
      }
    };
    select.addEventListener('change', () =>
      this.run(d, async () => {
        pricingOffset = 0;
        priceStatus.hidden = true;
        await load();
      }),
    );
    price.addEventListener('click', () =>
      this.run(d, async () => {
        priceStatus.hidden = true;
        price.disabled = select.disabled = true;
        try {
          const result = await this.call<{
            next: number | null;
            saved: number;
            unavailable: number;
            errors: string[];
          }>('performance.priceFees', {
            id: portfolio.id,
            walletId: displayedWallet || undefined,
            offset: pricingOffset,
            limit,
          });
          pricingOffset = result.next ?? 0;
          priceStatus.textContent = [
            `${this.t('portfolioPerformancePriceSaved')} ${result.saved}`,
            `${this.t('portfolioPerformancePriceUnavailable')} ${result.unavailable}`,
            ...result.errors.map((error) => walletStatus(this.options.language(), error)),
          ].join(' · ');
          priceStatus.hidden = false;
          await load();
        } finally {
          price.disabled = select.disabled = false;
        }
      }),
    );
    previous.addEventListener('click', () =>
      this.run(d, () => load(Math.max(0, offset - limit), report?.snapshotId)),
    );
    next.addEventListener('click', () =>
      this.run(d, () => load(report?.next ?? offset, report?.snapshotId)),
    );
    d.querySelector('[data-performance-refresh]')!.addEventListener('click', () =>
      this.run(d, () => load()),
    );
    d.querySelector('[data-performance-back]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.detail(portfolio.id);
        d.close();
      }),
    );
    this.run(d, () => load());
  }
  private holdings(id: string): void {
    const d = this.dialog(
      this.t('portfolioHoldings'),
      `<p>${esc(this.t('portfolioHoldingsHint'))}</p><output aria-live="polite"></output><div data-capital></div><div data-valuation></div><div data-assets></div><div data-members></div><p role="alert" hidden></p><footer><button type="button" data-valuation-read>${esc(this.t('portfolioValuationRead'))}</button><button type="button" data-refresh>${esc(this.t('assetRefresh'))}</button></footer>`,
    );
    const output = d.querySelector('output')!;
    const assets = d.querySelector('[data-assets]')!;
    const members = d.querySelector('[data-members]')!;
    const alert = d.querySelector<HTMLElement>('[role="alert"]')!;
    const refresh = d.querySelector<HTMLButtonElement>('[data-refresh]')!;
    const valueRead = d.querySelector<HTMLButtonElement>('[data-valuation-read]')!;
    const valueView = d.querySelector('[data-valuation]')!;
    let withValuation = false;
    const reference = (value: ReferenceValue) =>
      value.complete
        ? `${value.value} USD`
        : `${this.t('portfolioValuationPartial')} · ${value.knownValue} USD`;
    const cards = (rows: Holding[]) =>
      `<div class="wallet-assets">${rows
        .map((row) => {
          const incomplete = row.complete === false || !!row.error;
          const amount = incomplete
            ? this.t('assetFailed')
            : (row.amount ?? `${row.amountAtomic} ${this.t('assetAtomic')}`);
          const known =
            row.knownAmount == null
              ? `${row.knownAmountAtomic} ${this.t('assetAtomic')}`
              : `${row.knownAmount} ${row.symbol ?? ''}`;
          const value = row.valuation
            ? `<small>${esc(reference(row.valuation))}</small>${row.valuation.error ? `<small>${esc(walletStatus(this.options.language(), row.valuation.error))}</small>` : ''}`
            : '';
          const capital = row.capital;
          const reserve = capital
            ? `<dl class="wallet-capital-values"><div><dt>${esc(this.t('portfolioCapitalReserved'))}</dt><dd>${esc(capital.reserved ?? `${capital.reservedAtomic} ${this.t('assetAtomic')}`)}</dd></div><div><dt>${esc(this.t('portfolioCapitalAvailable'))}</dt><dd>${esc(capital.complete ? (capital.available ?? `${capital.availableAtomic} ${this.t('assetAtomic')}`) : this.t('portfolioCapitalUnavailable'))}</dd></div></dl>${capital.shortfallAtomic && capital.shortfallAtomic !== '0' ? `<small class="wallet-warning">${esc(this.t('portfolioCapitalShortfall'))}</small>` : ''}`
            : '';
          return `<article><header><strong>${esc(row.symbol ?? this.t('assetUnknown'))}</strong><span>${esc(amount)}</span></header>${row.address ? `<code>${esc(row.address)}</code>` : ''}${row.complete === false ? `<small>${esc(this.t('portfolioHoldingsKnown'))} · ${esc(known)}</small>` : ''}${value}${reserve}</article>`;
        })
        .join('')}</div>`;
    const load = async () => {
      if (refresh.disabled) return;
      refresh.disabled = valueRead.disabled = true;
      d.setAttribute('aria-busy', 'true');
      output.textContent = this.t('portfolioHoldingsLoading');
      assets.replaceChildren();
      members.replaceChildren();
      valueView.replaceChildren();
      d.querySelector('[data-capital]')!.replaceChildren();
      alert.hidden = true;
      try {
        const snapshot = await this.call<Holdings>('holdings', {
          id,
          ...(withValuation ? { valuation: true } : {}),
        });
        if (!d.open) return;
        output.textContent = `${snapshot.name} · ${snapshot.network} · ${this.t('assetBlock')} #${snapshot.block}`;
        output.title = snapshot.blockHash;
        const capital = snapshot.capital;
        if (capital)
          d.querySelector('[data-capital]')!.innerHTML =
            `<section class="wallet-capital-summary"><h3>${esc(this.t('portfolioCapital'))}</h3><p>${esc(this.t('portfolioCapitalPending'))} · ${capital.pendingCount}　${esc(this.t('portfolioCapitalApprovals'))} · ${capital.approvalCount}</p><small>${esc(this.t('portfolioCapitalHint'))}</small>${capital.unknownCount ? `<p class="wallet-warning">${esc(this.t('portfolioCapitalUnknown'))}</p>` : ''}</section>`;
        const value = snapshot.valuation;
        if (value) {
          const sequencer =
            value.sequencer.status === 'up'
              ? this.t('portfolioValuationUp')
              : walletStatus(
                  this.options.language(),
                  value.sequencer.error ?? 'WALLET_PRICE_UNAVAILABLE',
                );
          valueView.innerHTML = `<section class="wallet-valuation"><h3>${esc(this.t('portfolioValuation'))}</h3><strong>${esc(reference(value))}</strong><p>${esc(this.t('portfolioValuationHint'))}</p><details><summary>${esc(this.t('portfolioValuationSources'))}</summary><p>${esc(this.t('portfolioValuationSequencer'))} · ${esc(sequencer)}</p>${Object.values(
            value.prices,
          )
            .map(
              (feed) =>
                `<article><strong>${esc(feed.pair)}</strong><p>${feed.status === 'available' ? `${esc(feed.price)} USD · ${esc(new Date(feed.updatedAt! * 1000).toLocaleString(this.options.language()))} · ${esc(this.t('portfolioValuationAge'))} ${esc(feed.ageSeconds)} s` : esc(walletStatus(this.options.language(), feed.error ?? 'WALLET_PRICE_UNAVAILABLE'))}</p><code>${esc(feed.address)}</code>${feed.stablecoinCapped ? `<small>${esc(this.t('portfolioValuationCapped'))}</small>` : ''}</article>`,
            )
            .join('')}</details></section>`;
        }
        assets.innerHTML = `${snapshot.complete ? '' : `<p class="wallet-warning">${esc(this.t('portfolioHoldingsPartial'))}</p>`}${cards(snapshot.assets)}`;
        members.innerHTML = `<h3>${esc(this.t('portfolioHoldingsMembers'))}</h3>${snapshot.members.map((member) => `<details><summary>${esc(member.name)}</summary><code>${esc(member.address)}</code>${cards(member.assets)}</details>`).join('')}`;
      } catch (error) {
        output.textContent = '';
        alert.textContent = walletStatus(
          this.options.language(),
          error instanceof Error ? error.message : String(error),
        );
        alert.hidden = false;
      } finally {
        refresh.disabled = false;
        valueRead.disabled = withValuation;
        d.removeAttribute('aria-busy');
      }
    };
    refresh.addEventListener('click', () => void load());
    valueRead.addEventListener('click', () => {
      withValuation = true;
      void load();
    });
    void load();
  }
  async revisions(id: string, offset = 0): Promise<void> {
    const page = await this.call<{
      items: { revision: number; name: string; changedAt: number; kind: string; state: string }[];
      total: number;
      next: number | null;
    }>('revisions', { id, offset });
    const d = this.dialog(
      this.t('portfolioRevisions'),
      `<div class="wallet-portfolio-list">${page.items.map((r) => `<button type="button" data-revision="${r.revision}" class="wallet-portfolio-summary"><strong>${esc(r.name)} · ${esc(this.t('portfolioRevision'))} ${r.revision}</strong><small>${esc(r.kind === 'baseline' ? this.t('portfolioBaseline') : new Date(r.changedAt).toLocaleString(this.options.language()))}</small></button>`).join('')}</div><footer><button type="button" data-back>${esc(this.t('portfolioBack'))}</button><button type="button" data-prev ${offset ? '' : 'disabled'}>${esc(this.t('portfolioPrevious'))}</button><span>${page.total}</span><button type="button" data-next ${page.next === null ? 'disabled' : ''}>${esc(this.t('portfolioPageNext'))}</button></footer>`,
    );
    d.querySelector('[data-back]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.detail(id);
        d.close();
      }),
    );
    for (const selector of ['[data-prev]', '[data-next]'])
      d.querySelector(selector)!.addEventListener('click', () =>
        this.run(d, async () => {
          await this.revisions(
            id,
            selector === '[data-prev]' ? Math.max(0, offset - 20) : page.next!,
          );
          d.close();
        }),
      );
    d.querySelectorAll<HTMLElement>('[data-revision]').forEach((b) =>
      b.addEventListener('click', () =>
        this.run(d, async () => {
          const r = await this.call<{ portfolio: Portfolio; changedAt: number; kind: string }>(
            'revision',
            { id, revision: Number(b.dataset.revision) },
          );
          const view = this.dialog(
            `${r.portfolio.name} · ${this.t('portfolioRevision')} ${b.dataset.revision}`,
            `<p>${esc(r.kind === 'baseline' ? this.t('portfolioBaseline') : new Date(r.changedAt).toLocaleString(this.options.language()))}</p><p>${esc(this.t('chainId'))}: ${chainLabel(r.portfolio.chainId) + ' · ' + r.portfolio.chainId}</p><p>${esc(this.t('portfolioMembers'))}: ${esc(r.portfolio.members.map((m) => m.address).join(' · '))}</p><p>${esc(this.t('portfolioFee'))}: ${esc(tokenAmount(r.portfolio.maxFeeWei, 18))}</p><p>${esc(this.t('portfolioHours'))}: ${esc(r.portfolio.expiresAt ? new Date(r.portfolio.expiresAt).toLocaleString(this.options.language()) : this.t('portfolioForever'))}</p><div data-scope></div>`,
          );
          const editor = new WalletScopeEditor(this.t, walletScopeValues(r.portfolio.limits));
          editor.freeze();
          view.querySelector('[data-scope]')!.append(editor.root);
        }),
      ),
    );
  }
  private confirmState(snapshot: Snapshot, operation: string): void {
    this.confirmation(
      { id: snapshot.portfolio.id, operation, revision: snapshot.revision },
      this.t(operation === 'active' ? 'portfolioResume' : 'portfolioRemove'),
      snapshot.portfolio.name,
      () => this.detail(snapshot.portfolio.id),
    );
  }
  recover(): void {
    const wallets = this.options
      .wallets()
      .filter((w) => w.portfolioBlocked)
      .slice(0, 16);
    this.confirmation(
      { operation: 'recover', walletIds: wallets.map((w) => w.id) },
      this.t('portfolioRecover'),
      this.t('portfolioRecoverHint') +
        '\n' +
        wallets.map((w) => w.name + ' · ' + w.address).join('\n'),
      () => this.open(),
    );
  }
  private confirmation(
    input: Record<string, unknown>,
    title: string,
    summary: string,
    done: () => Promise<void>,
  ): void {
    const d = this.dialog(
      title,
      `<form><p class="wallet-warning">${esc(this.t('portfolioWarning'))}</p><p>${esc(summary)}</p><div data-ack hidden><label>${esc(this.t('portfolioAck'))}<input name="ack" autocomplete="off" spellcheck="false"></label></div><footer><button type="submit" class="wallet-live-button">${esc(this.t('portfolioReview'))}</button></footer></form>`,
    );
    const form = d.querySelector('form')!,
      button = d.querySelector<HTMLButtonElement>('[type=submit]')!;
    let challenge = '';
    form.addEventListener('input', () => {
      if (challenge)
        button.disabled =
          (form.elements.namedItem('ack') as HTMLInputElement).value !== 'ALLOW PORTFOLIO';
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      button.disabled = true;
      this.run(d, async () => {
        try {
          if (!challenge) {
            const c = await this.call<{ id: string }>('challenge', input);
            challenge = c.id;
            d.querySelector<HTMLElement>('[data-ack]')!.hidden = false;
            button.textContent = this.t('portfolioConfirm');
            (form.elements.namedItem('ack') as HTMLInputElement).focus();
          } else {
            await this.call('confirm', {
              challengeId: challenge,
              ack: (form.elements.namedItem('ack') as HTMLInputElement).value,
              confirmed: true,
            });
            await done();
            d.close();
          }
        } finally {
          button.disabled =
            !!challenge &&
            (form.elements.namedItem('ack') as HTMLInputElement).value !== 'ALLOW PORTFOLIO';
        }
      });
    });
  }
}
