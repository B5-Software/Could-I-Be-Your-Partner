/* SPDX-License-Identifier: GPL-3.0-or-later */
import fields from '../../shared/wallet-policy-fields.json';
import { WalletTokenEditor } from './wallet-token-editor';
import { WalletPeriodEditor } from './wallet-periods';
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class WalletScopeEditor {
  root: HTMLDetailsElement;
  private tokens: WalletTokenEditor;
  private period: WalletPeriodEditor;
  constructor(
    t: (key: string) => string,
    initial: Record<string, unknown> = {},
    periodLocked = false,
  ) {
    this.root = document.createElement('details');
    this.root.className = 'wallet-policy-limits';
    this.root.innerHTML = `<summary>${esc(t('limitsTitle'))}</summary><p>${esc(t('limitsHint'))}</p><div class="wallet-policy-grid">${fields
      .map((f) => {
        const value = initial[f.name] ?? f.initial,
          label = esc(t(f.name));
        if (f.kind === 'toggle')
          return `<label class="wallet-scope-toggle"><span>${label}</span><input type="checkbox" role="switch" name="limit-${f.name}" ${value ? 'checked' : ''}></label>`;
        if (f.kind === 'list')
          return `<label>${label}<textarea name="limit-${f.name}" rows="2" spellcheck="false">${esc(Array.isArray(value) ? value.join('\n') : value)}</textarea></label>`;
        return `<label>${label}<input name="limit-${f.name}" inputmode="${f.kind === 'count' ? 'numeric' : 'decimal'}" value="${esc(value)}" required maxlength="49"></label>`;
      })
      .join('')}</div>`;
    this.tokens = new WalletTokenEditor(t, initial.tokens);
    this.root.append(this.tokens.root);
    this.period = new WalletPeriodEditor(t, initial.period, periodLocked);
    this.root.append(this.period.root);
  }
  read(): Record<string, unknown> {
    const period = this.period.read();
    return {
      ...(period ? { period } : {}),
      ...Object.fromEntries(
        fields.map((f) => {
          const node = this.root.querySelector<HTMLInputElement>(`[name="limit-${f.name}"]`)!;
          return [f.name, f.kind === 'toggle' ? node.checked : node.value];
        }),
      ),
      tokens: this.tokens.read(),
    };
  }
  freeze(): void {
    this.root
      .querySelectorAll<HTMLInputElement>('input,select,textarea,button')
      .forEach((n) => (n.disabled = true));
    this.tokens.freeze();
    this.period.freeze();
  }
}
