/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/wallet-browser-labels.json';
import { walletStatus } from './wallet-panel';

type Options = {
  language: () => string;
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  dialog: (title: string, content: string) => HTMLDialogElement;
};
type Identity = { id: string; name: string; origin: string; fingerprint: string };
type Pending = Identity & { digest: string; expiresAt: number };
type Client = Identity & { revision: number; revoked: boolean; revocationPending: boolean };
type Status = {
  state: string;
  enabled: boolean;
  error: string | null;
  fingerprint: string | null;
  clients: Client[];
  pending: Pending[];
};
type Offer = { uri: string; expiresAt: number };
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export class WalletBrowserPanel {
  constructor(private options: Options) {}

  open(): void {
    const language = this.options.language();
    const t = labels[language.startsWith('en') ? 'en' : language.startsWith('de') ? 'de' : 'zh-CN'];
    const d = this.options.dialog(
      t.wbTitle,
      `<p class="wallet-private-hint">${esc(t.wbHint)}</p><section data-browser-panel aria-busy="true"></section><p role="alert" hidden></p>`,
    );
    const panel = d.querySelector<HTMLElement>('[data-browser-panel]')!;
    const alert = d.querySelector<HTMLElement>('[role=alert]')!;
    const request = this.options.request;
    let status: Status | undefined;
    let offer: Offer | undefined;
    let review: Pending | undefined;
    let busy = false;
    let fetching = false;
    let last = '';
    const report = (message: string) => {
      if (!d.open) return;
      alert.hidden = !message;
      alert.textContent = walletStatus(language, message);
    };
    const button = (action: string, name: string, id = '') =>
      `<button type="button"${['start', 'confirm', 'copy'].includes(action) ? ' class="quant-primary"' : ''} data-browser-action="${action}" data-id="${esc(id)}">${esc(name)}</button>`;
    const time = (value: number) => new Date(value).toLocaleTimeString(language);
    const identity = (v: Identity) =>
      `<strong>${esc(v.name)}</strong><p>${esc(t.wbOrigin)} <code>${esc(v.origin)}</code></p><p>${esc(t.wbFingerprint)} <code>${esc(v.fingerprint)}</code></p>`;
    const render = () => {
      if (!status || !d.open) return;
      const active = status.state === 'listening';
      const retryStop = !active && status.error === 'WALLET_BROWSER_PERSIST';
      if (offer && (!active || offer.expiresAt <= Date.now() || status.pending.length))
        offer = undefined;
      if (review && !status.pending.some((p) => p.digest === review?.digest)) review = undefined;
      const view = JSON.stringify([status, offer?.expiresAt, review?.digest]);
      if (view === last) return;
      const focused = d.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset
        : null;
      last = view;
      panel.innerHTML = `
        <section class="wallet-browser-state">
          <strong role="status">${esc(active ? t.wbRunning : t.wbStopped)}</strong>
          <p>${esc(t.wbEnable)}</p>
          ${status.fingerprint ? `<p>${esc(t.wbFingerprint)} <code>${esc(status.fingerprint)}</code></p>` : ''}
          <footer>
            ${active || status.enabled || retryStop ? button('stop', retryStop ? t.wbRetryStop : t.wbStop) : ''}
            ${!active && !retryStop ? button('start', t.wbStart) : ''}
            ${active ? button('pair', t.wbPair) : ''}
          </footer>
        </section>
        ${offer ? `<section class="wallet-browser-offer"><label>${esc(t.wbAddress)}<textarea readonly rows="3" data-pair-uri></textarea></label><p>${esc(t.wbPairHint)} ${esc(t.wbExpires)} ${esc(time(offer.expiresAt))}</p><footer>${button('copy', t.wbCopy)}</footer></section>` : ''}
        ${status.pending.length ? `<h4>${esc(t.wbPending)}</h4>` : ''}
        <div class="wallet-network-list">${status.pending
          .map(
            (p) =>
              `<article>${identity(p)}<small>${esc(t.wbExpires)} ${esc(time(p.expiresAt))}</small>${review?.digest === p.digest ? `<p class="wallet-warning">${esc(t.wbReviewHint)}</p>` : ''}<footer>${button('deny', t.wbReject, p.id)}${review?.digest === p.digest ? button('confirm', t.wbConfirm, p.id) : button('review', t.wbReview, p.id)}</footer></article>`,
          )
          .join('')}</div>
        <h4>${esc(t.wbClients)}</h4>
        <div class="wallet-network-list">${status.clients
          .map(
            (c) =>
              `<article>${identity(c)}${c.revoked ? `<small>${esc(t.wbRevoked)}</small>` : ''}<footer>${!c.revoked || c.revocationPending ? button('revoke', c.revocationPending ? t.wbRetryRevoke : t.wbRevoke, c.id) : ''}</footer></article>`,
          )
          .join('')}</div>
        ${!status.clients.length ? `<p>${esc(t.wbNone)}</p>` : ''}
        <footer>${button('refresh', t.wbRefresh)}</footer>`;
      if (offer) panel.querySelector<HTMLTextAreaElement>('[data-pair-uri]')!.value = offer.uri;
      if (focused?.browserAction)
        [...panel.querySelectorAll<HTMLButtonElement>('button')]
          .find(
            (b) => b.dataset.browserAction === focused.browserAction && b.dataset.id === focused.id,
          )
          ?.focus();
    };
    const refresh = async () => {
      if (fetching || !d.open) return;
      fetching = true;
      try {
        const next = (await request('browser.status')) as Status;
        if (!d.open) return;
        const cleared = status?.error && !next.error;
        status = next;
        render();
        if (status.error || cleared) report(status.error || '');
      } catch (e) {
        report(e instanceof Error ? e.message : String(e));
        if (!status && d.open) panel.innerHTML = button('refresh', t.wbRefresh);
      } finally {
        fetching = false;
        panel.setAttribute('aria-busy', 'false');
      }
    };
    const act = async (target: HTMLButtonElement) => {
      const action = target.dataset.browserAction;
      const id = target.dataset.id;
      if (action === 'refresh') return refresh();
      if (action === 'review') {
        review = status?.pending.find((p) => p.id === id);
        render();
        [...panel.querySelectorAll<HTMLButtonElement>('[data-browser-action=deny]')]
          .find((b) => b.dataset.id === id)
          ?.focus();
        return;
      }
      if (action === 'copy' && offer && offer.expiresAt > Date.now()) {
        try {
          await navigator.clipboard.writeText(offer.uri);
          target.textContent = t.wbCopied;
        } catch {
          panel.querySelector<HTMLTextAreaElement>('[data-pair-uri]')?.select();
          report(t.wbClipboard);
        }
        return;
      }
      if (action === 'pair') {
        offer = (await request('browser.pair')) as Offer;
        if (!d.open) offer = undefined;
      } else if (action === 'confirm' && review && review.id === id) {
        await request('browser.confirm', { id, digest: review.digest, confirmed: true });
        review = undefined;
      } else if (action === 'deny') {
        await request('browser.deny', { id });
      } else if (action === 'start' || action === 'stop') {
        await request('browser.' + action);
      } else if (action === 'revoke') {
        const client = status?.clients.find((c) => c.id === id);
        if (client) await request('browser.revoke', { id, revision: client.revision });
      }
      await refresh();
    };
    panel.onclick = (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
        'button[data-browser-action]',
      );
      if (!target || busy) return;
      busy = true;
      report('');
      void act(target)
        .catch(async (e) => {
          await refresh();
          report(e instanceof Error ? e.message : String(e));
        })
        .finally(() => (busy = false));
    };
    const timer = window.setInterval(() => {
      if (!busy) void refresh();
    }, 2000);
    d.addEventListener(
      'close',
      () => {
        window.clearInterval(timer);
        offer = review = undefined;
        last = '';
      },
      { once: true },
    );
    void refresh();
  }
}
