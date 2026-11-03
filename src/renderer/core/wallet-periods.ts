/* SPDX-License-Identifier: GPL-3.0-or-later */
import { WalletTokenEditor } from './wallet-token-editor';
import { walletBudget, type WalletPeriodSnapshot } from '../../shared/wallet-budget';
import { executionPercent } from '../../shared/quant-execution-format';
import { walletStatus } from './wallet-panel';
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class WalletPeriodEditor {
  root: HTMLDetailsElement;
  private tokens: WalletTokenEditor;
  constructor(t: (key: string) => string, initial: unknown, locked = false) {
    const p = (initial || {}) as Record<string, unknown>,
      seconds = Number(p.seconds || 3600),
      presets = [3600, 86400, 604800, 2592000];
    this.root = document.createElement('details');
    this.root.className = 'wallet-policy-limits wallet-period-editor';
    this.root.innerHTML = `<summary>${esc(t('periodTitle'))}</summary><p>${esc(t('periodHint'))}</p><label class="wallet-scope-toggle"><span>${esc(t('periodEnable'))}</span><input type="checkbox" role="switch" name="period-enabled" ${initial ? 'checked' : ''} ${locked ? 'disabled' : ''}></label><div data-period-fields><div class="wallet-policy-grid"><label>${esc(t('periodSeconds'))}<select name="period-preset" ${locked ? 'disabled' : ''}>${presets.map((s, i) => `<option value="${s}" ${seconds === s ? 'selected' : ''}>${esc(t(['periodHour', 'periodDay', 'periodWeek', 'periodMonth'][i]!))}</option>`).join('')}<option value="custom" ${presets.includes(seconds) ? '' : 'selected'}>${esc(t('periodCustom'))}</option></select></label><label data-custom-seconds>${esc(t('periodCustom'))}<input name="period-custom" type="number" min="1" max="2592000" step="1" value="${seconds}" ${locked ? 'disabled' : ''}></label>${['maxTotalValueEth', 'maxTotalFeeEth', 'maxTransactions'].map((k) => `<label>${esc(t(k))}<input name="period-${k}" inputmode="${k === 'maxTransactions' ? 'numeric' : 'decimal'}" value="${esc(p[k] ?? '0')}" maxlength="49" required></label>`).join('')}</div><div data-period-tokens></div></div>${locked ? `<p>${esc(t('periodLocked'))}</p>` : ''}`;
    this.tokens = new WalletTokenEditor(t, p.tokens);
    this.root.querySelector('[data-period-tokens]')!.append(this.tokens.root);
    const enabled = this.root.querySelector<HTMLInputElement>('[name=period-enabled]')!,
      preset = this.root.querySelector<HTMLSelectElement>('[name=period-preset]')!,
      custom = this.root.querySelector<HTMLInputElement>('[name=period-custom]')!;
    const update = () => {
      this.root.querySelector<HTMLElement>('[data-period-fields]')!.hidden = !enabled.checked;
      this.root
        .querySelectorAll<HTMLInputElement>(
          '[data-period-fields] input,[data-period-fields] select,[data-period-fields] textarea,[data-period-fields] button',
        )
        .forEach((n) => (n.disabled = !enabled.checked));
      preset.disabled = locked || !enabled.checked;
      custom.disabled = locked || !enabled.checked || preset.value !== 'custom';
      this.root.querySelector<HTMLElement>('[data-custom-seconds]')!.hidden =
        preset.value !== 'custom';
    };
    enabled.addEventListener('change', update);
    preset.addEventListener('change', update);
    update();
  }
  read(): Record<string, unknown> | null {
    if (!this.root.querySelector<HTMLInputElement>('[name=period-enabled]')!.checked) return null;
    const preset = this.root.querySelector<HTMLSelectElement>('[name=period-preset]')!.value;
    return {
      seconds: Number(
        preset === 'custom'
          ? this.root.querySelector<HTMLInputElement>('[name=period-custom]')!.value
          : preset,
      ),
      ...Object.fromEntries(
        ['maxTotalValueEth', 'maxTotalFeeEth', 'maxTransactions'].map((k) => [
          k,
          this.root.querySelector<HTMLInputElement>(`[name=period-${k}]`)!.value,
        ]),
      ),
      tokens: this.tokens.read(),
    };
  }
  freeze(): void {
    this.root
      .querySelectorAll<HTMLInputElement>('input,select,textarea,button')
      .forEach((n) => (n.disabled = true));
    this.tokens.freeze();
  }
}
export function periodNote(
  period: WalletPeriodSnapshot | null | undefined,
  t: (key: string) => string,
  language: string,
): string {
  if (!period) return '';
  return `<p class="wallet-private-hint">${esc(t('periodWindow'))}: ${esc(new Date(period.startMs).toLocaleString(language))} · ${esc(t('periodNext'))}: ${esc(new Date(period.endMs).toLocaleString(language))}${period.clockRollback ? ' · ' + esc(walletStatus(language, 'WALLET_PERIOD_CLOCK_ROLLBACK')) : ''}</p>`;
}
export async function openPeriodHistory(
  options: {
    request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
    language: () => string;
    t: (key: string) => string;
  },
  identity: { kind: string; id: string },
  offset = 0,
): Promise<void> {
  const p = (await options.request('period.history', { ...identity, offset, limit: 2 })) as {
      items: {
        startMs: number;
        endMs: number;
        usage: Record<string, unknown>;
        limits: Record<string, unknown>;
      }[];
      total: number;
      next: number | null;
    },
    t = options.t,
    language = options.language();
  const d = document.createElement('dialog');
  d.className = 'quant-dialog wallet-dialog wallet-policy-dialog wallet-portfolio-dialog';
  d.innerHTML = `<header><h3>${esc(t('periodHistory'))}</h3><button type="button" data-exit aria-label="${esc(t('portfolioCancel'))}">×</button></header><p class="wallet-private-hint">${esc(t('periodLastPolicy'))}</p>${
    p.items.length
      ? p.items
          .map(
            (w) =>
              `<section><h4>${esc(new Date(w.startMs).toLocaleString(language))} → ${esc(new Date(w.endMs).toLocaleString(language))}</h4><div class="wallet-budget-list">${walletBudget(
                { limits: w.limits, usage: w.usage, revoked: false, expiresAt: 0 },
              )
                .map(
                  (r) =>
                    `<article class="wallet-budget-row"><header><strong>${esc(t(r.label))}</strong><small>${esc(r.asset)}</small></header><p>${esc(r.usedText)}${r.breakdown ? '' : ' / ' + esc(r.limitText ?? t('usageUnlimited'))}</p>${r.limitText === null ? '' : `<progress max="100" value="${executionPercent(r.used, r.limit)}"></progress>`}</article>`,
                )
                .join('')}</div></section>`,
          )
          .join('')
      : `<p>${esc(t('periodEmpty'))}</p>`
  }<p data-error hidden role="alert"></p><footer><button type="button" data-prev ${offset ? '' : 'disabled'}>${esc(t('portfolioPrevious'))}</button><span>${p.total}</span><button type="button" data-next ${p.next === null ? 'disabled' : ''}>${esc(t('portfolioPageNext'))}</button></footer>`;
  d.querySelector('[data-exit]')!.addEventListener('click', () => d.close());
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  let busy = false;
  for (const selector of ['[data-prev]', '[data-next]'])
    d.querySelector(selector)!.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      void openPeriodHistory(
        options,
        identity,
        selector === '[data-prev]' ? Math.max(0, offset - 2) : p.next!,
      )
        .then(() => d.close())
        .catch((error) => {
          const n = d.querySelector<HTMLElement>('[data-error]')!;
          n.hidden = false;
          n.textContent = walletStatus(language, String(error.message || error));
        })
        .finally(() => (busy = false));
    });
}
