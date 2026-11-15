/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/wallet-network-labels.json';
import { walletStatus } from './wallet-panel';
export type WalletNetwork = {
  key: string;
  id: number;
  name: string;
  nativeSymbol: string;
  rpcOrigin: string;
  rpc?: string;
  additionalFeeNative: string;
  revision: number;
  builtin: boolean;
  archived: boolean;
  genesisHash: string | null;
  capabilities: { signType2: boolean };
};
type Options = {
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  language: () => string;
  dialog: (title: string, content: string) => HTMLDialogElement;
  refresh: () => Promise<void>;
  reportError: (error: unknown) => void;
};
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class WalletNetworkPanel {
  constructor(private options: Options) {}
  private t(key: keyof typeof labels.en): string {
    const language = this.options.language();
    return labels[language.startsWith('en') ? 'en' : language.startsWith('de') ? 'de' : 'zh-CN'][
      key
    ];
  }
  private call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.options.request(action, input) as Promise<T>;
  }
  async open(): Promise<void> {
    const data = await this.call<{ items: WalletNetwork[] }>('network.list');
    const d = this.options.dialog(
      this.t('networks'),
      `<p>${esc(this.t('networkHint'))}</p><p>${esc(this.t('networkSupport'))}</p><div class="wallet-network-list">${data.items.map((p) => `<article><header><strong>${esc(p.name)}</strong><span>${p.id} · ${esc(p.nativeSymbol)}</span></header><code>${esc(p.rpcOrigin)}</code><small>${esc(this.t(p.archived ? 'networkStopped' : p.capabilities.signType2 ? 'networkReady' : 'networkReadOnly'))}</small><footer><button type="button" data-edit="${esc(p.key)}">${esc(this.t(p.archived ? 'networkRestore' : 'networkEdit'))}</button>${p.builtin ? `<span>${esc(this.t('networkBuiltin'))}</span>` : `<button type="button" data-archive="${esc(p.key)}" ${p.archived ? 'disabled' : ''}>${esc(this.t('networkArchive'))}</button>`}</footer></article>`).join('')}</div><p role="alert" hidden></p><footer><button type="button" data-add>${esc(this.t('networkAdd'))}</button></footer>`,
    );
    d.querySelector('[data-add]')!.addEventListener('click', () => {
      d.close();
      void this.edit().catch(this.options.reportError);
    });
    d.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => {
        d.close();
        void this.edit(b.dataset.edit).catch(this.options.reportError);
      }),
    );
    d.querySelectorAll<HTMLButtonElement>('[data-archive]').forEach((b) =>
      b.addEventListener(
        'click',
        () =>
          void this.run(d, b, async () => {
            const p = data.items.find((p) => p.key === b.dataset.archive)!;
            await this.call('network.archive', { key: p.key, revision: p.revision });
            d.close();
            await this.options.refresh();
            await this.open();
          }),
      ),
    );
  }
  private async edit(key?: string): Promise<void> {
    const p = key ? await this.call<WalletNetwork>('network.config', { key }) : null;
    const d = this.options.dialog(
      this.t('networkEdit'),
      `<form class="wallet-network-form"><div data-fields><label>${esc(this.t('networkName'))}<input name="name" required maxlength="80" value="${esc(p?.name)}" ${p?.builtin ? 'readonly' : ''}></label><label>${esc(this.t('networkChainId'))}<input name="id" required inputmode="numeric" pattern="[0-9]+" maxlength="16" value="${p?.id ?? ''}" ${p ? 'readonly' : ''}></label><label>${esc(this.t('networkRpc'))}<input name="rpc" type="url" required maxlength="2048" spellcheck="false" autocomplete="off" value="${esc(p?.rpc)}"></label><label>${esc(this.t('networkSymbol'))}<input name="symbol" required pattern="[A-Za-z][A-Za-z0-9]{0,11}" maxlength="12" value="${esc(p?.nativeSymbol ?? 'ETH')}" ${p?.builtin ? 'readonly' : ''}></label><label ${p?.builtin ? 'hidden' : ''}>${esc(this.t('networkFeeBuffer'))}<input name="fee" required inputmode="decimal" value="${esc(p?.additionalFeeNative ?? '0')}"></label></div><small>${esc(this.t('networkFeeHint'))}</small><div data-review hidden></div><p role="alert" hidden></p><footer><button type="button" data-edit-fields hidden>${esc(this.t('networkBack'))}</button><button type="submit">${esc(this.t('networkReview'))}</button></footer></form>`,
    );
    const form = d.querySelector('form')!,
      submit = form.querySelector<HTMLButtonElement>('[type=submit]')!,
      back = form.querySelector<HTMLButtonElement>('[data-edit-fields]')!,
      review = form.querySelector<HTMLElement>('[data-review]')!;
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input'));
    let challenge: { id: string; profile: WalletNetwork } | null = null;
    const reset = () => {
      challenge = null;
      inputs.forEach((n) => (n.disabled = false));
      back.hidden = true;
      review.hidden = true;
      submit.textContent = this.t('networkReview');
    };
    back.addEventListener('click', reset);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.run(d, submit, async () => {
        if (challenge) {
          await this.call('network.confirm', {
            challengeId: challenge.id,
            ack: 'SAVE NETWORK',
            confirmed: true,
          });
          d.close();
          await this.options.refresh();
          await this.open();
          return;
        }
        const value = (name: string) =>
          form.querySelector<HTMLInputElement>(`[name=${name}]`)!.value;
        const input = {
          id: Number(value('id')),
          name: value('name'),
          rpc: value('rpc'),
          nativeSymbol: value('symbol'),
          nativeDecimals: 18,
          additionalFeeNative: value('fee'),
          revision: p?.revision ?? 0,
        };
        inputs.forEach((n) => (n.disabled = true));
        try {
          challenge = await this.call('network.challenge', input);
        } catch (error) {
          reset();
          throw error;
        }
        if (!d.open || !challenge) return;
        const profile = challenge.profile;
        review.innerHTML = `<section class="wallet-network-review"><strong>${esc(profile.name)} · ${profile.id} · ${esc(profile.nativeSymbol)}</strong><p>${esc(profile.rpcOrigin)}</p><p>${esc(this.t(profile.capabilities.signType2 ? 'networkReady' : 'networkReadOnly'))}</p><details><summary>${esc(this.t('networkGenesis'))}</summary><code>${esc(profile.genesisHash)}</code></details></section>`;
        review.hidden = false;
        back.hidden = false;
        submit.textContent = this.t('networkConfirm');
      });
    });
  }
  async send(wallet: { id: string; name: string; unlocked: boolean }): Promise<void> {
    if (!wallet.unlocked) throw Error('WALLET_LOCKED');
    const { items } = await this.call<{ items: WalletNetwork[] }>('network.list');
    const available = items.filter((p) => !p.archived && p.capabilities.signType2);
    const d = this.options.dialog(
      this.t('networkSend'),
      `<form class="wallet-network-form"><strong>${esc(wallet.name)}</strong><label>${esc(this.t('networks'))}<select name="chain">${available.map((p) => `<option value="${esc(p.key)}">${esc(p.name)} · ${p.id} · ${esc(p.nativeSymbol)}</option>`).join('')}</select></label><label>${esc(this.t('networkRecipient'))}<input name="to" required pattern="0x[0-9a-fA-F]{40}" maxlength="42" spellcheck="false"></label><label>${esc(this.t('networkAmount'))}<input name="value" required inputmode="decimal" pattern="[0-9]+([.][0-9]{1,18})?"></label><p>${esc(this.t('networkPrepared'))}</p><p role="alert" hidden></p><footer><button type="submit" ${available.length ? '' : 'disabled'}>${esc(this.t('networkPrepare'))}</button></footer></form>`,
    );
    const form = d.querySelector('form')!,
      button = form.querySelector<HTMLButtonElement>('[type=submit]')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.run(d, button, async () => {
        await this.call('transaction.prepare', {
          id: wallet.id,
          chain: form.querySelector<HTMLSelectElement>('[name=chain]')!.value,
          to: form.querySelector<HTMLInputElement>('[name=to]')!.value,
          value: form.querySelector<HTMLInputElement>('[name=value]')!.value,
        });
        d.close();
        await this.options.refresh();
      });
    });
  }
  private async run(
    d: HTMLDialogElement,
    button: HTMLButtonElement,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    d.setAttribute('aria-busy', 'true');
    const alert = d.querySelector<HTMLElement>('[role=alert]')!;
    alert.hidden = true;
    try {
      await fn();
    } catch (error) {
      if (d.open) {
        alert.hidden = false;
        alert.textContent = walletStatus(
          this.options.language(),
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      button.disabled = false;
      d.removeAttribute('aria-busy');
    }
  }
}
