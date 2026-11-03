/* SPDX-License-Identifier: GPL-3.0-or-later */
import fields from '../../shared/wallet-token-fields.json';
import presets from '../../shared/wallet-token-presets.json';
type Token = Record<string, unknown>;
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class WalletTokenEditor {
  root: HTMLElement;
  constructor(t: (key: string) => string, initial: unknown) {
    this.root = document.createElement('section');
    this.root.className = 'wallet-token-editor';
    this.root.innerHTML = `<h4>${esc(t('tokensTitle'))}</h4><p>${esc(t('tokensHint'))}</p><div data-token-list></div><div class="wallet-token-add"><select aria-label="${esc(t('tokenPreset'))}"><option value="">${esc(t('tokenPreset'))}</option>${presets.map((p, i) => `<option value="${i}">${p.symbol} · ${p.chainId === 8453 ? 'Base' : 'Base Sepolia'}</option>`).join('')}</select><button type="button" data-token-add>${esc(t('tokenCustom'))}</button></div>`;
    const add = (value: Token = {}) => {
      const list = this.root.querySelector('[data-token-list]')!;
      if (list.children.length >= 16) return;
      const row = document.createElement('fieldset');
      row.className = 'wallet-token-card';
      row.innerHTML = `<legend>${esc(value.symbol || t('tokenCustom'))}</legend><button type="button" data-token-remove aria-label="${esc(t('tokenRemove'))}">×</button><div class="wallet-policy-grid">${fields
        .map((f) => {
          const valueForField = value[f.name] ?? f.initial;
          const attr = `data-token-field="${f.name}"`;
          if (f.kind === 'toggle')
            return `<label class="wallet-scope-toggle"><span>${esc(t(f.name))}</span><input type="checkbox" role="switch" ${attr} ${valueForField ? 'checked' : ''}></label>`;
          let control: string;
          if (f.kind === 'chain')
            control = `<select ${attr}><option value="8453" ${valueForField === 8453 ? 'selected' : ''}>Base · 8453</option><option value="84532" ${valueForField === 84532 ? 'selected' : ''}>Base Sepolia · 84532</option></select>`;
          else if (f.kind === 'list')
            control = `<textarea ${attr} rows="2" spellcheck="false">${esc(Array.isArray(valueForField) ? valueForField.join('\n') : valueForField)}</textarea>`;
          else
            control = `<input ${attr} value="${esc(valueForField)}" maxlength="${f.kind === 'amount' ? 335 : f.kind === 'text' ? 24 : 128}" ${f.kind === 'amount' ? 'inputmode="decimal"' : f.kind === 'count' ? 'inputmode="numeric"' : ''} ${['address', 'count', 'amount'].includes(f.kind) ? 'required' : ''} spellcheck="false">`;
          return `<label class="${['address', 'list'].includes(f.kind) ? 'wallet-token-wide' : ''}">${esc(t(f.name))}${control}</label>`;
        })
        .join('')}</div>`;
      row.querySelector('[data-token-remove]')!.addEventListener('click', () => row.remove());
      list.append(row);
    };
    this.root.querySelector('[data-token-add]')!.addEventListener('click', () => add());
    this.root.querySelector('select')!.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      if (select.value !== '') add(presets[Number(select.value)]);
      select.value = '';
    });
    if (Array.isArray(initial)) initial.slice(0, 16).forEach(add);
  }
  read(): Token[] {
    return [...this.root.querySelectorAll('[data-token-list]>fieldset')].map((row) =>
      Object.fromEntries(
        fields.map((field) => {
          const node = row.querySelector<HTMLInputElement>(`[data-token-field="${field.name}"]`)!;
          return [
            field.name,
            field.kind === 'toggle'
              ? node.checked
              : ['chain', 'count'].includes(field.kind)
                ? Number(node.value)
                : node.value,
          ];
        }),
      ),
    );
  }
  freeze(): void {
    this.root
      .querySelectorAll<HTMLInputElement>('input,select,textarea,button')
      .forEach((node) => (node.disabled = true));
  }
}
