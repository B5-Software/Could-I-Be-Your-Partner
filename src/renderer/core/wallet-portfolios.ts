/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/wallet-portfolio-labels.json';
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
type Portfolio = {
  id: string;
  name: string;
  chainId: number;
  members: { walletId: string; address: string }[];
  limits: Record<string, unknown>;
  expiresAt: number;
  maxFeeWei: string;
};
type Snapshot = {
  period?: WalletPeriodSnapshot | null;
  portfolio: Portfolio;
  state: string;
  revision: number;
  usage: Record<string, unknown>;
};
type Options = {
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  language: () => string;
  wallets: () => Wallet[];
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
    this.running.add(d);
    void fn()
      .catch((error) => {
        const n = d.querySelector<HTMLElement>('[data-error]')!;
        n.hidden = false;
        n.textContent = walletStatus(this.options.language(), String(error.message || error));
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
      `<p class="wallet-private-hint">${esc(this.t('portfolioHint'))}</p><button type="button" data-create class="quant-primary">${esc(this.t('portfolioCreate'))}</button><div class="wallet-portfolio-list">${page.items.length ? page.items.map((p) => `<button type="button" data-detail="${esc(p.id)}" class="wallet-portfolio-summary"><span><strong>${esc(p.name)}</strong><small>${p.chainId === 8453 ? 'Base' : 'Base Sepolia'} · ${esc(this.t('portfolio' + p.state[0]!.toUpperCase() + p.state.slice(1)))}</small></span><small>${esc(p.members.map((m) => names.get(m.walletId) ?? m.address).join(' · '))}</small></button>`).join('') : `<p>${esc(this.t('portfolioEmpty'))}</p>`}</div><footer><button type="button" data-prev ${offset ? '' : 'disabled'}>${esc(this.t('portfolioPrevious'))}</button><span>${page.total}</span><button type="button" data-next ${page.next === null ? 'disabled' : ''}>${esc(this.t('portfolioPageNext'))}</button></footer>`,
    );
    d.querySelector('[data-create]')!.addEventListener('click', () => {
      d.close();
      this.create();
    });
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
  private create(snapshot?: Snapshot): void {
    const wallets = this.options.wallets();
    const d = this.dialog(
      this.t('portfolioCreate'),
      `<form><p class="wallet-warning">${esc(this.t('portfolioWarning'))}</p><label>${esc(this.t('portfolioName'))}<input name="portfolio-name" maxlength="80" required></label><label>${esc(this.t('chainId'))}<select name="portfolio-chain"><option value="8453">Base · 8453</option><option value="84532">Base Sepolia · 84532</option></select></label><fieldset class="wallet-portfolio-members"><legend>${esc(this.t('portfolioMembers'))}</legend><p>${esc(this.t(wallets.length ? 'portfolioMemberHint' : 'portfolioNoWallet'))}</p>${wallets.map((w) => `<label class="wallet-scope-toggle"><span>${esc(w.name)}<code>${esc(w.address)}</code></span><input type="checkbox" role="switch" data-member="${esc(w.id)}"></label>`).join('')}</fieldset><div class="wallet-policy-grid"><label>${esc(this.t('portfolioHours'))}<select name="portfolio-hours"><option value="24">${esc(this.t('portfolioDay'))}</option><option value="1">${esc(this.t('portfolioHour'))}</option><option value="0">${esc(this.t('portfolioForever'))}</option></select></label><label>${esc(this.t('portfolioFee'))}<input name="portfolio-fee" value="0.01" inputmode="decimal" required></label></div><div data-scope></div><div data-ack hidden><label>${esc(this.t('portfolioAck'))}<input name="portfolio-ack" autocomplete="off" spellcheck="false"></label></div><footer><button type="submit" data-submit class="wallet-live-button">${esc(this.t('portfolioReview'))}</button></footer></form>`,
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
    );
    d.querySelector('[data-scope]')!.append(scope.root);
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
            const result = await this.call<{ id: string }>('challenge', {
              operation: snapshot ? 'edit' : 'create',
              ...(snapshot ? { id: snapshot.portfolio.id, revision: snapshot.revision } : {}),
              name: values.get('portfolio-name'),
              chainId: snapshot?.portfolio.chainId ?? Number(values.get('portfolio-chain')),
              walletIds: snapshot?.portfolio.members.map((m) => m.walletId) ?? members,
              ...(hours === -1 ? {} : { hours }),
              maxFeeEth: values.get('portfolio-fee'),
              limits: scope.read(),
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
      `<p class="wallet-private-hint">${esc(this.t('portfolioHint'))}</p><p>${p.chainId === 8453 ? 'Base' : 'Base Sepolia'} · ${esc(this.t('portfolio' + snapshot.state[0]!.toUpperCase() + snapshot.state.slice(1)))} · ${esc(this.t('portfolioFee'))}: ${tokenAmount(p.maxFeeWei, 18)}</p><ul class="wallet-portfolio-member-list">${p.members.map((m) => `<li><strong>${esc(this.options.wallets().find((w) => w.id === m.walletId)?.name ?? m.walletId)}</strong><code>${esc(m.address)}</code></li>`).join('')}</ul><div data-scope></div><div class="wallet-budget-list">${rows.map((row) => `<article class="wallet-budget-row"><header><strong>${esc(this.t(row.label))}</strong><small>${esc(row.asset)}</small></header><p>${esc(row.usedText)}${row.breakdown ? '' : ' / ' + esc(row.limitText ?? this.t('usageUnlimited'))}</p>${row.limitText !== null ? `<progress max="100" value="${executionPercent(row.used, row.limit)}"></progress>` : ''}</article>`).join('')}</div><p class="wallet-private-hint">${esc(this.t('portfolioMore'))}</p><footer>${snapshot.state !== 'removed' ? `<button type="button" data-pause>${esc(this.t('portfolioPause'))}</button><button type="button" data-resume>${esc(this.t('portfolioResume'))}</button><button type="button" data-remove>${esc(this.t('portfolioRemove'))}</button>` : ''}</footer>`,
    );
    d.classList.add('wallet-budget-dialog');
    d.querySelector('footer')!.insertAdjacentHTML(
      'beforeend',
      `<button type="button" data-refresh>${esc(this.t('periodRefresh'))}</button>${snapshot.state !== 'removed' ? `<button type="button" data-edit>${esc(this.t('portfolioEdit'))}</button>` : ''}<button type="button" data-revisions>${esc(this.t('portfolioRevisions'))}</button>`,
    );
    d.querySelector('[data-edit]')?.addEventListener('click', () => {
      this.create(snapshot);
      d.close();
    });
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
            `<p>${esc(r.kind === 'baseline' ? this.t('portfolioBaseline') : new Date(r.changedAt).toLocaleString(this.options.language()))}</p><p>${esc(this.t('chainId'))}: ${r.portfolio.chainId === 8453 ? 'Base · 8453' : 'Base Sepolia · 84532'}</p><p>${esc(this.t('portfolioMembers'))}: ${esc(r.portfolio.members.map((m) => m.address).join(' · '))}</p><p>${esc(this.t('portfolioFee'))}: ${esc(tokenAmount(r.portfolio.maxFeeWei, 18))}</p><p>${esc(this.t('portfolioHours'))}: ${esc(r.portfolio.expiresAt ? new Date(r.portfolio.expiresAt).toLocaleString(this.options.language()) : this.t('portfolioForever'))}</p><div data-scope></div>`,
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
