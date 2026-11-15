/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/wallet-app-labels.json';
import { walletStatus, walletText } from './wallet-panel';
import type { WalletNetwork } from './wallet-networks';
type Options = {
  language: () => string;
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  dialog: (title: string, content: string) => HTMLDialogElement;
};
type Connection = {
  id: string;
  origin: string;
  walletId: string;
  chain: string;
  revision: number;
  expiresAt: number;
  expired: boolean;
  clientName?: string;
};
type Pending = {
  id: string;
  origin: string;
  clientName?: string;
  desiredChain?: string;
  walletId?: string;
  network?: { id: number; name: string; nativeSymbol: string; rpcOrigins: string[] };
  expiresAt: number;
};
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class WalletAppsPanel {
  constructor(private options: Options) {}
  private t(key: keyof typeof labels.en): string {
    const language = this.options.language();
    return labels[language.startsWith('en') ? 'en' : language.startsWith('de') ? 'de' : 'zh-CN'][
      key
    ];
  }
  async open(): Promise<void> {
    const source = (v: { origin: string; clientName?: string }) =>
      `<strong><code>${esc(v.origin)}</code></strong>${v.clientName ? `<p>${esc(walletText(this.options.language(), 'wbSource'))} · ${esc(v.clientName)}</p>` : ''}`;
    const [apps, data, networks] = await Promise.all([
      this.options.request('app.list') as Promise<{
        connections: Connection[];
        pending: Pending[];
      }>,
      this.options.request('list') as Promise<{
        wallets: { id: string; name: string; address: string }[];
      }>,
      this.options.request('network.list') as Promise<{
        items: { key: string; id: number; name: string; archived: boolean }[];
      }>,
    ]);
    const d = this.options.dialog(
      this.t('appsTitle'),
      `<p class="wallet-private-hint">${esc(this.t('appsHint'))}</p><h4>${esc(this.t('appsPending'))}</h4><div class="wallet-app-requests">${apps.pending
        .map((p) => {
          const header =
            source(p) +
            `<p>${esc(new Date(p.expiresAt).toLocaleString(this.options.language()))}</p>`;
          if (p.network) return this.networkForm(p, header);
          const wallets = data.wallets.filter((w) => !p.walletId || p.walletId === w.id);
          const chains = networks.items.filter(
            (n) => !n.archived && (!p.desiredChain || p.desiredChain === n.key),
          );
          return `<form class="wallet-app-request" data-request="${esc(p.id)}">${header}${p.desiredChain ? `<h4>${esc(this.t('appsSwitch'))}</h4>` : ''}<label>${esc(this.t('appsAccount'))}<select name="wallet" ${p.walletId ? 'disabled' : ''}>${wallets.map((w) => `<option value="${esc(w.id)}">${esc(w.name)} · ${esc(w.address)}</option>`).join('')}</select></label><label>${esc(this.t('appsNetwork'))}<select name="chain" ${p.desiredChain ? 'disabled' : ''}>${chains
            .map((n) => `<option value="${esc(n.key)}">${esc(n.name)} · ${n.id}</option>`)
            .join(
              '',
            )}</select></label><p data-review hidden></p><footer><button type="button" data-deny="${esc(p.id)}">${esc(this.t('appsDeny'))}</button><button type="submit" ${wallets.length && chains.length ? '' : 'disabled'}>${esc(this.t('appsReview'))}</button></footer></form>`;
        })
        .join(
          '',
        )}</div><h4>${esc(this.t('appsConnected'))}</h4><div class="wallet-network-list">${apps.connections.map((c) => `<article>${source(c)}<p>${esc(data.wallets.find((w) => w.id === c.walletId)?.name ?? c.walletId)} · ${esc(networks.items.find((n) => n.key === c.chain)?.name ?? c.chain)}</p><small>${esc(this.t(c.expired ? 'appsExpired' : 'appsExpiry'))} · ${esc(new Date(c.expiresAt).toLocaleString(this.options.language()))}</small><footer><button type="button" data-revoke="${esc(c.id)}">${esc(this.t('appsRevoke'))}</button></footer></article>`).join('')}</div>${!apps.pending.length && !apps.connections.length ? `<p>${esc(this.t('appsEmpty'))}</p>` : ''}<p role="alert" hidden></p><footer><button type="button" data-refresh>${esc(this.t('appsRefresh'))}</button></footer>`,
    );
    const reload = async () => {
      if (!d.open) return;
      await this.open();
      d.close();
    };
    const run = async (button: HTMLButtonElement, fn: () => Promise<void>) => {
      if (button.disabled) return;
      button.disabled = true;
      const alert = d.querySelector<HTMLElement>('[role=alert]')!;
      alert.hidden = true;
      try {
        await fn();
      } catch (error) {
        alert.hidden = false;
        alert.textContent = walletStatus(
          this.options.language(),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        button.disabled = false;
      }
    };
    d.querySelector<HTMLButtonElement>('[data-refresh]')!.onclick = (event) =>
      void run(event.currentTarget as HTMLButtonElement, reload);
    d.querySelectorAll<HTMLButtonElement>('[data-deny]').forEach(
      (b) =>
        (b.onclick = () =>
          void run(b, async () => {
            await this.options.request('app.deny', { id: b.dataset.deny });
            await reload();
          })),
    );
    d.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach(
      (b) =>
        (b.onclick = () =>
          void run(b, async () => {
            const c = apps.connections.find((c) => c.id === b.dataset.revoke)!;
            await this.options.request('app.revoke', { id: c.id, revision: c.revision });
            await reload();
          })),
    );
    d.querySelectorAll<HTMLFormElement>('[data-network]').forEach((form) => {
      const rpc = form.querySelector<HTMLInputElement>('[name=rpc]')!;
      const fee = form.querySelector<HTMLInputElement>('[name=fee]')!;
      const button = form.querySelector<HTMLButtonElement>('[type=submit]')!;
      const review = form.querySelector<HTMLElement>('[data-network-review]')!;
      let verified: { id: string; profile: WalletNetwork } | null = null;
      form.onsubmit = (event) => {
        event.preventDefault();
        void run(button, async () => {
          if (verified) {
            await this.options.request('app.addNetwork', {
              id: form.dataset.network,
              reviewId: verified.id,
              confirmed: true,
            });
            await reload();
            return;
          }
          rpc.readOnly = fee.readOnly = true;
          try {
            verified = (await this.options.request('app.probeNetwork', {
              id: form.dataset.network,
              rpc: rpc.value.trim(),
              additionalFeeNative: fee.value.trim(),
            })) as { id: string; profile: WalletNetwork };
          } catch (e) {
            rpc.readOnly = fee.readOnly = false;
            throw e;
          }
          const p = verified.profile;
          const t = (k: Parameters<typeof walletText>[1]) =>
            esc(walletText(this.options.language(), k));
          review.innerHTML = `<strong>${esc(p.name)} · ${p.id} · ${esc(p.nativeSymbol)}</strong><code>${esc(p.rpcOrigin)}</code><small>${t(p.capabilities.signType2 ? 'networkReady' : 'networkReadOnly')}</small><small>${t('networkFeeBuffer')} · ${esc(p.additionalFeeNative)} ${esc(p.nativeSymbol)}</small><small>${t('networkGenesis')}</small><code>${esc(p.genesisHash)}</code>`;
          review.hidden = false;
          button.textContent = this.t('appsSaveNetwork');
        });
      };
    });
    d.querySelectorAll<HTMLFormElement>('[data-request]').forEach((form) => {
      let frozen: { walletId: string; chain: string } | null = null;
      form.onsubmit = (event) => {
        event.preventDefault();
        const b = form.querySelector<HTMLButtonElement>('[type=submit]')!;
        void run(b, async () => {
          if (!frozen) {
            frozen = {
              walletId: form.querySelector<HTMLSelectElement>('[name=wallet]')!.value,
              chain: form.querySelector<HTMLSelectElement>('[name=chain]')!.value,
            };
            form.querySelectorAll('select').forEach((n) => (n.disabled = true));
            const review = form.querySelector<HTMLElement>('[data-review]')!;
            review.textContent = this.t('appsHint');
            review.hidden = false;
            b.textContent = this.t(
              apps.pending.find((p) => p.id === form.dataset.request)?.desiredChain
                ? 'appsSwitch'
                : 'appsAllow',
            );
            return;
          }
          await this.options.request('app.allow', {
            id: form.dataset.request,
            ...frozen,
            confirmed: true,
          });
          await reload();
        });
      };
    });
  }
  private networkForm(p: Pending, header: string): string {
    const network = p.network!;
    const t = (k: Parameters<typeof walletText>[1]) => esc(walletText(this.options.language(), k));
    return `<form class="wallet-app-request wallet-network-form" data-network="${esc(p.id)}">
      ${header}<h4>${esc(this.t('appsAddNetwork'))}</h4>
      <strong>${esc(network.name)} · ${network.id} · ${esc(network.nativeSymbol)}</strong>
      <p>${esc(this.t('appsProbeHint'))}</p>
      <p>${esc(this.t('appsSuggestedRpc'))}</p>
      <ul>${network.rpcOrigins.map((origin) => `<li><code>${esc(origin)}</code></li>`).join('')}</ul>
      <label>${esc(this.t('appsOwnRpc'))}<input name="rpc" type="url" required maxlength="2048" spellcheck="false" autocomplete="off"></label>
      <label>${t('networkFeeBuffer')}<input name="fee" required inputmode="decimal" value="0"></label>
      <small>${t('networkFeeHint')}</small>
      <div class="wallet-network-review" data-network-review hidden></div>
      <footer><button type="button" data-deny="${esc(p.id)}">${esc(this.t('appsDeny'))}</button><button type="submit" class="quant-primary">${esc(this.t('appsProbe'))}</button></footer>
    </form>`;
  }
}
