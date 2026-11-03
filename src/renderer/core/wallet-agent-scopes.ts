/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/wallet-agent-scope-labels.json';
import periodLabels from '../../shared/wallet-period-labels.json';
import { periodNote, openPeriodHistory } from './wallet-periods';
import type { WalletPeriodSnapshot } from '../../shared/wallet-budget';
import policyLabels from '../../shared/wallet-policy-labels.json';
import tokenLabels from '../../shared/wallet-token-labels.json';
import portfolioLabels from '../../shared/wallet-portfolio-labels.json';
import { walletBudget, walletScopeValues } from '../../shared/wallet-budget';
import { executionPercent } from '../../shared/quant-execution-format';
import { WalletScopeEditor } from './wallet-scope-editor';
import { walletStatus } from './wallet-panel';
import { tokenAmount } from '../../shared/wallet-token-format';
type Scope = {
  id: string;
  subject: string;
  label: string;
  chainId: number;
  walletIds: string[];
  limits: Record<string, unknown>;
  maxFeeWei: string;
  expiresAt: number;
  parentId: string | null;
};
type Snapshot = {
  period?: WalletPeriodSnapshot | null;
  scope: Scope;
  state: string;
  revision: number;
  ready: boolean;
  reason: string | null;
  path: string[];
  usage: Record<string, unknown>;
  locallyBlocked?: boolean;
};
type Options = {
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  language: () => string;
  wallets?: () => { id: string; name: string }[];
};
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class WalletAgentScopePanel {
  private busy = new WeakSet<HTMLDialogElement>();
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
          ...portfolioLabels[lang],
          ...labels[lang],
          ...periodLabels[lang],
        } as Record<string, string>
      )[key] ?? key
    );
  };
  private call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.options.request('scope.' + action, input) as Promise<T>;
  }
  private dialog(title: string, body: string): HTMLDialogElement {
    const d = document.createElement('dialog');
    d.className =
      'quant-dialog wallet-dialog wallet-policy-dialog wallet-portfolio-dialog wallet-agent-scope-dialog';
    d.innerHTML = `<header><h3>${esc(title)}</h3><button type="button" data-exit aria-label="${esc(this.t('portfolioCancel'))}">×</button></header>${body}<p data-error role="alert" hidden></p>`;
    d.querySelector('[data-exit]')!.addEventListener('click', () => d.close());
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
    return d;
  }
  private run(d: HTMLDialogElement, fn: () => Promise<unknown>): void {
    if (this.busy.has(d)) return;
    this.busy.add(d);
    void fn()
      .catch((error) => {
        const node = d.querySelector<HTMLElement>('[data-error]')!;
        node.hidden = false;
        node.textContent = walletStatus(this.options.language(), String(error.message || error));
      })
      .finally(() => this.busy.delete(d));
  }
  async open(offset = 0): Promise<void> {
    const page = await this.call<{
      items: (Omit<Scope, 'limits' | 'maxFeeWei'> & { state: string })[];
      total: number;
      next: number | null;
    }>('list', { offset });
    const d = this.dialog(
      this.t('agentScopesTitle'),
      `<p class="wallet-private-hint">${esc(this.t('agentScopesHint'))}</p><div class="wallet-portfolio-list">${page.items.length ? page.items.map((s) => `<button type="button" data-scope="${esc(s.id)}" class="wallet-portfolio-summary"><span><strong>${esc(s.label)}</strong><small>${s.chainId === 8453 ? 'Base' : 'Base Sepolia'} · ${esc(this.t(s.state === 'active' ? 'portfolioActive' : 'portfolioPaused'))}</small></span><small>${esc(s.subject)}</small></button>`).join('') : `<p>${esc(this.t('agentScopesEmpty'))}</p>`}</div><footer><button type="button" data-prev ${offset ? '' : 'disabled'}>${esc(this.t('portfolioPrevious'))}</button><button type="button" data-refresh>${esc(this.t('agentScopesRefresh'))}</button><span>${page.total}</span><button type="button" data-next ${page.next === null ? 'disabled' : ''}>${esc(this.t('portfolioPageNext'))}</button></footer>`,
    );
    const open = (next: number) =>
      this.run(d, async () => {
        await this.open(next);
        d.close();
      });
    d.querySelector('[data-prev]')!.addEventListener('click', () => open(Math.max(0, offset - 20)));
    d.querySelector('[data-next]')!.addEventListener('click', () => open(page.next!));
    d.querySelector('[data-refresh]')!.addEventListener('click', () => open(offset));
    d.querySelectorAll<HTMLElement>('[data-scope]').forEach((b) =>
      b.addEventListener('click', () =>
        this.run(d, async () => {
          await this.detail(b.dataset.scope!);
          d.close();
        }),
      ),
    );
  }
  async detail(id: string): Promise<void> {
    const s = await this.call<Snapshot>('get', { id }),
      p = s.scope,
      rows = walletBudget({
        limits: p.limits,
        usage: s.usage,
        revoked: !s.ready,
        expiresAt: p.expiresAt,
        period: s.period,
      });
    const d = this.dialog(
      p.label,
      `<p class="wallet-private-hint">${esc(this.t('agentScopesHint'))}</p><p>${p.chainId === 8453 ? 'Base' : 'Base Sepolia'} · ${esc(this.t(s.ready && !s.locallyBlocked ? 'agentScopesReady' : 'agentScopesRestricted'))}${s.reason ? ' · ' + esc(walletStatus(this.options.language(), s.reason)) : ''}</p><dl class="wallet-portfolio-member-list"><dt>${esc(this.t('agentScopesSubject'))}</dt><dd><code>${esc(p.subject)}</code></dd><dt>${esc(this.t('agentScopesExpiry'))}</dt><dd>${esc(p.expiresAt ? new Date(p.expiresAt).toLocaleString(this.options.language()) : this.t('agentScopesNoExpiry'))}</dd><dt>${esc(this.t('agentScopesWallets'))}</dt><dd>${esc(p.walletIds.join(' · ') || '—')}</dd></dl><div data-editor></div><div class="wallet-budget-list">${rows.map((r) => `<article class="wallet-budget-row"><header><strong>${esc(this.t(r.label))}</strong><small>${esc(r.asset)}</small></header><p>${esc(r.usedText)}${r.breakdown ? '' : ' / ' + esc(r.limitText ?? this.t('usageUnlimited'))}</p>${r.limitText !== null ? `<progress max="100" value="${executionPercent(r.used, r.limit)}"></progress>` : ''}</article>`).join('')}</div><div class="wallet-portfolio-list">${s.path
        .slice(1)
        .map(
          (a, i) =>
            `<button type="button" data-ancestor="${esc(a)}">${esc(this.t('agentScopesAncestor'))} ${i + 1}</button>`,
        )
        .join(
          '',
        )}</div><footer><button type="button" data-back>${esc(this.t('portfolioBack'))}</button><button type="button" data-refresh>${esc(this.t('agentScopesRefresh'))}</button>${s.state === 'active' ? `<button type="button" data-pause>${esc(this.t('agentScopesPause'))}</button>` : `<button type="button" data-confirm="active">${esc(this.t('agentScopesResume'))}</button>`}${s.locallyBlocked ? `<button type="button" data-confirm="recover">${esc(this.t('agentScopesRecover'))}</button>` : ''}</footer>`,
    );
    const editor = new WalletScopeEditor(this.t, walletScopeValues(p.limits));
    const walletNames = new Map(this.options.wallets?.().map((w) => [w.id, w.name]) ?? []);
    const members = d.querySelector('.wallet-portfolio-member-list dd:last-child');
    if (members)
      members.textContent = p.walletIds.map((id) => walletNames.get(id) ?? id).join(' · ') || '—';
    editor.freeze();
    d.querySelector('[data-editor]')!.append(editor.root);
    if (s.period) {
      d.querySelector('[data-editor]')!.insertAdjacentHTML(
        'beforebegin',
        periodNote(s.period, this.t, this.options.language()),
      );
      d.querySelector('footer')!.insertAdjacentHTML(
        'beforeend',
        `<button type="button" data-period-history>${esc(this.t('periodHistory'))}</button>`,
      );
      d.querySelector('[data-period-history]')!.addEventListener('click', () =>
        this.run(d, async () => {
          await openPeriodHistory({ ...this.options, t: this.t }, s.period!.identity);
          d.close();
        }),
      );
    }
    d.querySelector('[data-editor]')!.insertAdjacentHTML(
      'beforebegin',
      `<p class="wallet-private-hint">${esc(this.t('portfolioFee'))}: ${p.maxFeeWei === '0' ? esc(this.t('usageUnlimited')) : esc(tokenAmount(p.maxFeeWei, 18))}</p>`,
    );
    d.querySelector('[data-back]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.open();
        d.close();
      }),
    );
    d.querySelector('[data-refresh]')!.addEventListener('click', () =>
      this.run(d, async () => {
        await this.detail(id);
        d.close();
      }),
    );
    d.querySelector('[data-pause]')?.addEventListener('click', () =>
      this.run(d, async () => {
        await this.call('pause', { id, revision: s.revision });
        await this.detail(id);
        d.close();
      }),
    );
    d.querySelectorAll<HTMLElement>('[data-ancestor]').forEach((b) =>
      b.addEventListener('click', () =>
        this.run(d, async () => {
          await this.detail(b.dataset.ancestor!);
          d.close();
        }),
      ),
    );
    d.querySelectorAll<HTMLElement>('[data-confirm]').forEach((b) =>
      b.addEventListener('click', () =>
        this.run(d, async () => {
          await this.confirm(s, b.dataset.confirm!);
          d.close();
        }),
      ),
    );
  }
  private async confirm(snapshot: Snapshot, kind: string): Promise<void> {
    const c = await this.call<{ id: string }>('challenge', {
      id: snapshot.scope.id,
      revision: snapshot.revision,
      kind,
    });
    const d = this.dialog(
      this.t(kind === 'active' ? 'agentScopesResume' : 'agentScopesRecover'),
      `<p class="wallet-warning">${esc(this.t('agentScopesReview'))}</p><p>${esc(snapshot.scope.label)} · ${esc(snapshot.scope.subject)}</p><form><label>${esc(this.t('agentScopesAck'))}<input name="ack" autocomplete="off" spellcheck="false"></label><footer><button type="submit" class="wallet-live-button" disabled>${esc(this.t('agentScopesConfirm'))}</button></footer></form>`,
    );
    const input = d.querySelector<HTMLInputElement>('input')!,
      submit = d.querySelector<HTMLButtonElement>('[type=submit]')!;
    input.addEventListener('input', () => (submit.disabled = input.value !== 'ALLOW AGENT SCOPE'));
    d.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      submit.disabled = true;
      this.run(d, async () => {
        try {
          await this.call('confirm', { challengeId: c.id, ack: input.value, confirmed: true });
          await this.detail(snapshot.scope.id);
          d.close();
        } finally {
          submit.disabled = input.value !== 'ALLOW AGENT SCOPE';
        }
      });
    });
  }
}
