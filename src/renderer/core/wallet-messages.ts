/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/wallet-message-labels.json';
import { walletStatus, walletText } from './wallet-panel';
type Options = {
  language: () => string;
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  dialog: (title: string, content: string) => HTMLDialogElement;
};
export type WalletMessage = {
  id: string;
  status: string;
  reviewDigest: string;
  address: string;
  expiresAt: number;
  digest: string;
  preview?: string | null | Record<string, unknown>;
  login?: Record<string, unknown> | null;
  message: { kind: string; origin: string; chainId: number; payload?: string };
  sourceBrowser?: { clientId: string; clientName: string };
  signatureHash?: string;
  error?: string;
};
type Page = { items: WalletMessage[]; total: number; next: number | null };
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const visible = (v: string) =>
  v.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
export class WalletMessagesPanel {
  constructor(private options: Options) {}
  private t(key: keyof typeof labels.en) {
    const l = this.options.language();
    return labels[l.startsWith('en') ? 'en' : l.startsWith('de') ? 'de' : 'zh-CN'][key];
  }
  private async run(d: HTMLDialogElement, b: HTMLButtonElement, fn: () => Promise<void>) {
    if (b.disabled) return;
    b.disabled = true;
    try {
      await fn();
    } catch (error) {
      const n = d.querySelector<HTMLElement>('[role=alert]')!;
      n.hidden = false;
      n.textContent = walletStatus(
        this.options.language(),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      b.disabled = false;
    }
  }
  async open(offset = 0): Promise<void> {
    const [pending, history] = await Promise.all([
      this.options.request('message.list', { status: 'pending', limit: 50 }) as Promise<Page>,
      this.options.request('message.list', {
        status: 'history',
        offset,
        limit: 20,
      }) as Promise<Page>,
    ]);
    const cards = (items: WalletMessage[]) =>
      items
        .map(
          (r) =>
            `<article><strong><code>${esc(r.message.origin)}</code></strong><p>${esc(this.t(r.message.kind === 'typed' ? 'msgTyped' : 'msgPersonal'))} · ${esc(walletStatus(this.options.language(), r.status))}</p><footer><button type="button" data-review="${esc(r.id)}">${esc(this.t('msgReview'))}</button></footer></article>`,
        )
        .join('') || `<p>${esc(this.t('msgNone'))}</p>`;
    const d = this.options.dialog(
      this.t('msgTitle'),
      `<p class="wallet-warning">${esc(this.t('msgWarning'))}</p><h3>${esc(this.t('msgPending'))}</h3><div class="wallet-network-list">${cards(pending.items)}</div><h3>${esc(this.t('msgHistory'))} · ${history.total}</h3><p class="wallet-private-hint">${esc(this.t('msgPrivacy'))}</p><div class="wallet-network-list">${cards(history.items)}</div><p role="alert" hidden></p><footer><button type="button" data-page="${Math.max(0, offset - 20)}" ${offset ? '' : 'disabled'}>${esc(this.t('msgPrevious'))}</button><button type="button" data-page="${history.next ?? offset}" ${history.next === null ? 'disabled' : ''}>${esc(this.t('msgNext'))}</button><button type="button" data-refresh>${esc(this.t('msgRefresh'))}</button></footer>`,
    );
    d.querySelectorAll<HTMLButtonElement>('[data-review]').forEach(
      (b) => (b.onclick = () => void this.run(d, b, () => this.review(b.dataset.review!))),
    );
    d.querySelectorAll<HTMLButtonElement>('[data-page],[data-refresh]').forEach(
      (b) =>
        (b.onclick = () =>
          void this.run(d, b, async () => {
            await this.open(b.dataset.page ? Number(b.dataset.page) : offset);
            d.close();
          })),
    );
  }
  async review(id: string): Promise<void> {
    const r = (await this.options.request('message.get', { id })) as WalletMessage;
    const freeze = Object.freeze({ id: r.id, digest: r.reviewDigest });
    const typed = r.message.kind === 'typed';
    const data = typed
      ? (r.preview as {
          primaryType?: string;
          domain?: { chainId?: string; verifyingContract?: string };
        })
      : null;
    const kind = r.login ? 'msgLogin' : typed ? 'msgTyped' : 'msgPersonal';
    const full = r.preview as Record<string, unknown>;
    const ordered = typed
      ? {
          domain: full.domain,
          message: full.message,
          primaryType: full.primaryType,
          types: full.types,
        }
      : r.preview;
    const body =
      typeof r.preview === 'string'
        ? visible(r.preview)
        : r.preview === null
          ? this.t('msgOpaque')
          : visible(JSON.stringify(ordered, null, 2));
    const browser = r.sourceBrowser
      ? `<small>${esc(walletText(this.options.language(), 'wbSource'))} · ${esc(r.sourceBrowser.clientName)}</small>`
      : '';
    const details = `<div class="wallet-app-origin"><strong>${esc(this.t('msgSource'))}</strong><code>${esc(r.message.origin)}</code>${browser}</div><p class="wallet-warning">${esc(this.t('msgWarning'))}</p><dl class="wallet-message-fields"><dt>${esc(this.t('msgAddress'))}</dt><dd><code>${esc(r.address)}</code></dd><dt>${esc(this.t('msgChain'))}</dt><dd>${r.message.chainId}</dd><dt>${esc(this.t('msgType'))}</dt><dd>${esc(this.t(kind))}${data?.primaryType ? ' · ' + esc(data.primaryType) : ''}</dd><dt>${esc(this.t('msgExpiry'))}</dt><dd>${esc(new Date(r.expiresAt).toLocaleString(this.options.language()))}</dd>${data?.domain?.verifyingContract ? `<dt>${esc(this.t('msgContract'))}</dt><dd><code>${esc(data.domain.verifyingContract)}</code></dd>` : ''}</dl>${typed && data?.domain?.chainId === undefined ? `<p class="wallet-warning">${esc(this.t('msgUnbound'))}</p>` : ''}<h4>${esc(this.t('msgContent'))}</h4><pre class="wallet-message-content" data-message-content>${esc(body)}</pre>${typed ? '' : `<details><summary>${esc(this.t('msgHex'))}</summary><pre class="wallet-message-content">${esc(r.message.payload)}</pre></details>`}<p>${esc(this.t('msgDigest'))}</p><code class="wallet-message-hash">${esc(r.digest)}</code>`;
    const d = this.options.dialog(
      this.t('msgReview'),
      '<div class="wallet-message-body">' +
        details +
        `<p>${esc(walletStatus(this.options.language(), r.status))}</p><p role="alert" hidden></p></div><footer>${r.status === 'approval-required' ? `<button type="button" data-deny>${esc(this.t('msgDeny'))}</button><button type="button" class="wallet-live-button" data-sign>${esc(this.t('msgContinue'))}</button>` : ''}${r.status === 'signing-unknown' || r.status === 'signed-withheld' ? `<button type="button" data-reconcile>${esc(this.t('msgReconcile'))}</button>` : ''}</footer>`,
    );
    d.classList.add('wallet-message-dialog');
    if (!typed && !r.login) {
      const n = document.createElement('p');
      n.className = 'wallet-warning';
      n.textContent = this.t('msgUnbound');
      d.querySelector('h4')?.before(n);
    }
    let reviewed = false;
    const sign = d.querySelector<HTMLButtonElement>('[data-sign]');
    if (sign)
      sign.onclick = () =>
        void this.run(d, sign, async () => {
          if (!reviewed) {
            reviewed = true;
            sign.textContent = this.t('msgSign');
            return;
          }
          await this.options.request('message.approve', { ...freeze, confirmed: true });
          d.close();
        });
    const deny = d.querySelector<HTMLButtonElement>('[data-deny]');
    if (deny)
      deny.onclick = () =>
        void this.run(d, deny, async () => {
          await this.options.request('message.deny', freeze);
          d.close();
        });
    const reconcile = d.querySelector<HTMLButtonElement>('[data-reconcile]');
    if (reconcile)
      reconcile.onclick = () =>
        void this.run(d, reconcile, async () => {
          await this.options.request('message.reconcile', { id: r.id });
          await this.review(r.id);
          d.close();
        });
  }
}
