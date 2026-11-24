/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/quant-exchange-labels.json';
import { walletStatus } from './wallet-panel';

type Draft = {
  reviewId: string;
  specHash: string;
  product: string;
  side: 'buy' | 'sell';
  price: string;
  size: string;
  postOnly: boolean;
  notional: string;
  estimatedFee: string;
  fixConnectionId?: string;
  stopPrice?: string;
  stopLimitPrice?: string;
  triggerDirection?: 'up' | 'down';
};
type Order = Draft & {
  clientId: string;
  venueId?: string;
  status: string;
  error?: string;
  filledSize?: string;
  executedValue?: string;
  fillFees?: string;
  grantId?: string;
  replaces?: string;
  replacementAvailable?: boolean;
  amendmentAvailable?: boolean;
  cancelAvailable?: boolean;
  stopState?: 'waiting' | 'triggered' | 'unverified';
  activeLeg?: 'take-profit' | 'stop-loss';
  activePrice?: string;
  cancellations?: { clientId: string; outcome?: string; transport: string }[];
  replacement?: { clientId: string; price: string; size: string; error?: string };
  fix?: { clientId: string; pending?: Amendment; amendments: Amendment[] };
};
type Amendment = {
  clientId: string;
  price: string;
  size: string;
  stopPrice?: string;
  stopLimitPrice?: string;
  outcome?: string;
};
type ReplacementDraft = Draft & {
  replaces: string;
  originalPrice: string;
  originalSize: string;
  originalStatus: string;
  filledSize: string;
};
type AmendDraft = Omit<ReplacementDraft, 'replaces' | 'originalStatus'> & {
  orderId: string;
  remainingSize: string;
  keepsPriority: boolean;
  keepsTriggerPriority?: boolean;
  originalStopPrice?: string;
  originalStopLimitPrice?: string;
};
type Authority = {
  grantId: string;
  product: string;
  profileId: string;
  side: 'buy' | 'sell';
  postOnly: boolean;
  perOrder: string;
  total: string;
  maxOrders: number;
  maxCancels?: number;
  minutes: number;
  transport?: 'fix' | 'rest';
  allowAmend?: boolean;
  allowStopLimit?: boolean;
  allowTpsl?: boolean;
};
type AuthorityReview = Authority & { specHash: string };
type Grant = Authority & {
  status: string;
  expiresAt: number;
  remaining: string;
  ordersRemaining: number;
  cancelsRemaining: number;
};
type FixState = {
  phase: 'idle' | 'connecting' | 'recovering' | 'ready' | 'disconnected';
  lastSequence: number | null;
  error: string | null;
};
type FixReport = {
  venueId: string;
  status: string;
  filledSize: string | null;
  remainingSize: string | null;
  price?: string | null;
  checkedAt: number;
  triggered?: boolean;
};
type History = {
  configured: boolean;
  accountError?: string;
  product: string;
  next: number | null;
  drafts: Draft[];
  items: Order[];
  grants: Grant[];
  fix?: FixState;
  watch?: {
    enabled: boolean;
    phase: 'off' | 'idle' | 'connecting' | 'live' | 'fallback';
    lastVerifiedAt?: number;
    error?: string | null;
  };
};
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function openExchange(options: {
  id: string;
  language: () => string;
  request: (action: string, input: Record<string, unknown>) => Promise<unknown>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => unknown;
}): void {
  const language = options.language();
  const dictionary =
    labels[language.startsWith('de') ? 'de' : language.startsWith('en') ? 'en' : 'zh'];
  const t = (key: keyof typeof labels.en) => esc(dictionary[key]);
  const status = (key: string) =>
    esc(
      Object.hasOwn(dictionary, key)
        ? dictionary[key as keyof typeof labels.en]
        : walletStatus(language, key),
    );
  const d = document.createElement('dialog');
  d.className = 'quant-dialog le-dialog quant-exchange-dialog';
  const button = (key: keyof typeof labels.en, action: string, attrs = '') =>
    '<button type="button" data-ex="' + action + '" ' + attrs + '>' + t(key) + '</button>';
  d.innerHTML = `<header class="le-head"><div><h2>${t('title')}</h2><p data-ex-product></p></div>${button('close', 'close')}</header>
    <div class="le-toolbar"><select aria-label="${t('title')}" data-ex-env>
      <option value="sandbox">${t('sandbox')}</option><option value="live">${t('live')}</option></select>
      ${button('refresh', 'refresh')}${button('disconnect', 'disconnect', 'hidden')}</div>
    <p role="alert" data-ex-message hidden></p>
    <section class="quant-exchange-watch" data-ex-watch hidden>
      <div role="status"><p data-ex-watch-status></p><small data-ex-watch-notice></small></div>
      <button type="button" data-ex="watch"></button>
    </section>
    <details data-ex-fix hidden><summary>${t('fixTitle')}</summary>
      <div class="quant-exchange-watch"><div role="status"><p data-ex-fix-status></p><small data-ex-fix-notice></small></div>
        <button type="button" data-ex="fixToggle"></button></div>
      <p class="le-subtle">${t('fixHint')}</p>
      <div class="le-command" data-ex-fix-report role="status" hidden></div>
    </details>
    <details data-ex-account><summary>${t('connect')}</summary><p class="le-subtle">${t('credentialsHint')}</p>
      <form data-ex-credentials autocomplete="off"><div class="le-fields">
      ${(['key', 'secret', 'passphrase'] as const)
        .map(
          (key) =>
            `<label>${t(key)}<input name="${key}" type="password" maxlength="256" autocomplete="off" required></label>`,
        )
        .join('')}
      </div><button class="quant-primary">${t('connect')}</button></form>
    </details>
    <details data-ex-authority hidden><summary>${t('authority')}</summary>
      <p class="le-subtle">${t('authorityHint')}</p><div data-ex-grants></div>
      <form data-ex-authority-form><fieldset><legend>${t('reviewAuthority')}</legend>
        <p class="le-subtle">${t('authorityUnits')}</p>
        <div class="le-fields">
          <label>${t('side')}<select name="side"><option value="buy">${t('buy')}</option><option value="sell">${t('sell')}</option></select></label>
          <label>${t('transport')}<select name="transport"><option value="rest">REST</option><option value="fix">FIX 5.0</option></select></label>
          <label>${t('perOrder')}<input name="perOrder" inputmode="decimal" maxlength="37" required></label>
          <label>${t('total')}<input name="total" inputmode="decimal" maxlength="37" required></label>
          <label><span data-ex-grant-count>${t('maxOrders')}</span><input name="maxOrders" type="number" min="1" max="8000" value="1" required></label>
          <label>${t('maxCancels')}<input name="maxCancels" type="number" min="0" max="8000" value="0" required></label>
          <label>${t('minutes')}<input name="minutes" type="number" min="1" max="43200" value="60" required></label>
        </div><div data-ex-grant-fix hidden>
          <div class="quant-exchange-controls"><label><input name="allowAmend" type="checkbox" role="switch"><span>${t('allowFixAmend')}</span></label></div>
          <div class="quant-exchange-controls"><label><input name="allowStopLimit" type="checkbox" role="switch"><span>${t('allowStopLimit')}</span></label></div>
          <div class="quant-exchange-controls"><label><input name="allowTpsl" type="checkbox" role="switch"><span>${t('allowTpsl')}</span></label></div>
          <p class="le-subtle">${t('fixAuthorityHint')}</p>
        </div><div class="quant-exchange-controls">
          <label><input name="postOnly" type="checkbox" role="switch" checked><span>${t('postOnly')}</span></label>
          <button>${t('reviewAuthority')}</button>
        </div>
        <p class="le-subtle">${t('cancelAuthorityHint')}</p>
      </fieldset></form>
      <div data-ex-authority-review hidden></div>
    </details>
    <form data-ex-order hidden><fieldset><legend>${t('order')}</legend><div class="le-fields">
      <label>${t('side')}<select name="side"><option value="buy">${t('buy')}</option><option value="sell">${t('sell')}</option></select></label>
      <label>${t('size')}<input name="size" inputmode="decimal" maxlength="37" required></label>
      <label><span data-ex-limit-label>${t('price')}</span><input name="price" inputmode="decimal" maxlength="37" required></label>
      <label>${t('transport')}<select name="transport"><option value="rest">REST</option><option value="fix" disabled>FIX 5.0</option></select></label>
      <label data-ex-order-kind hidden>${t('orderKind')}<select name="orderKind"><option value="limit">${t('limitOrder')}</option><option value="stop-limit">${t('stopLimitOrder')}</option><option value="tpsl">${t('tpslOrder')}</option></select></label>
      <label data-ex-stop-field hidden>${t('stopPrice')}<input name="stopPrice" inputmode="decimal" maxlength="37" required disabled></label>
      <label data-ex-direction-field hidden>${t('triggerDirection')}<select name="triggerDirection" disabled><option value="up">${t('triggerUp')}</option><option value="down">${t('triggerDown')}</option></select></label>
      <label data-ex-tpsl-field hidden>${t('stopLimitPrice')}<input name="stopLimitPrice" inputmode="decimal" maxlength="37" required disabled></label>
      </div><p data-ex-stop-hint class="le-subtle" hidden>${t('stopLimitHint')}</p><p data-ex-tpsl-hint class="le-subtle" hidden>${t('tpslHint')}</p><div class="quant-exchange-controls">
      <label><input name="postOnly" type="checkbox" role="switch"><span>${t('postOnly')}</span></label>
      <button data-ex-preview class="quant-primary">${t('preview')}</button></div></fieldset></form>
    <section class="le-history" data-ex-drafts hidden></section>
    <section class="le-history quant-exchange-replacement" data-ex-replacement hidden></section>
    <section class="le-history"><header><h3>${t('history')}</h3></header><div data-ex-history></div>
      <footer data-ex-pagination hidden>${button('previous', 'previous')}${button('next', 'next')}</footer></section>`;
  document.body.append(d);
  d.showModal();
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    d.querySelector<T>(selector)!;
  const accountForm = q<HTMLFormElement>('[data-ex-credentials]');
  const orderForm = q<HTMLFormElement>('[data-ex-order]');
  const authorityForm = q<HTMLFormElement>('[data-ex-authority-form]');
  const grantTransport = q<HTMLSelectElement>('[data-ex-authority-form] [name=transport]');
  const grantAmend = q<HTMLInputElement>('[data-ex-authority-form] [name=allowAmend]');
  const grantStops = q<HTMLInputElement>('[data-ex-authority-form] [name=allowStopLimit]');
  const grantTpsl = q<HTMLInputElement>('[data-ex-authority-form] [name=allowTpsl]');
  const grantPostOnly = q<HTMLInputElement>('[data-ex-authority-form] [name=postOnly]');
  const showGrantTransport = () => {
    const fix = grantTransport.value === 'fix';
    q('[data-ex-grant-fix]').hidden = !fix;
    if (!fix) grantAmend.checked = grantStops.checked = grantTpsl.checked = false;
    if (grantTpsl.checked) grantPostOnly.checked = false;
    grantPostOnly.disabled = grantTpsl.checked;
    q('[data-ex-grant-count]').textContent =
      dictionary[fix && grantAmend.checked ? 'maxOperations' : 'maxOrders'];
  };
  grantTransport.addEventListener('change', showGrantTransport);
  grantAmend.addEventListener('change', showGrantTransport);
  grantTpsl.addEventListener('change', showGrantTransport);
  const orderTransport = q<HTMLSelectElement>('[data-ex-order] [name=transport]');
  const orderKind = q<HTMLSelectElement>('[data-ex-order] [name=orderKind]');
  const setOrderField = (marker: string, show: boolean) => {
    const field = q<HTMLLabelElement>(marker);
    field.hidden = !show;
    field.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!.disabled = !show;
  };
  const syncOrderKind = () => {
    const fix = orderTransport.value === 'fix';
    if (!fix) orderKind.value = 'limit';
    const stop = fix && orderKind.value === 'stop-limit';
    const tpsl = fix && orderKind.value === 'tpsl';
    q('[data-ex-order-kind]').hidden = !fix;
    setOrderField('[data-ex-stop-field]', stop || tpsl);
    setOrderField('[data-ex-direction-field]', stop);
    setOrderField('[data-ex-tpsl-field]', tpsl);
    q('[data-ex-limit-label]').textContent =
      dictionary[tpsl ? 'takeProfitPrice' : stop ? 'executionLimit' : 'price'];
    q('[data-ex-stop-hint]').hidden = !stop;
    q('[data-ex-tpsl-hint]').hidden = !tpsl;
    const postOnly = q<HTMLInputElement>('[data-ex-order] [name=postOnly]');
    if (tpsl) postOnly.checked = false;
    postOnly.disabled = tpsl;
    q<HTMLButtonElement>('[data-ex-preview]').disabled = fix && fixState?.phase !== 'ready';
  };
  orderTransport.addEventListener('change', syncOrderKind);
  orderKind.addEventListener('change', syncOrderKind);
  const selector = q<HTMLSelectElement>('[data-ex-env]');
  const message = (error: unknown) => {
    const node = q('[data-ex-message]');
    node.hidden = !error;
    node.innerHTML = error ? status(error instanceof Error ? error.message : String(error)) : '';
  };
  let env = 'sandbox',
    offset = 0,
    next: number | null = null,
    busy = false;
  let watchEnabled = false;
  let fixState: FixState | undefined;
  let renderToken = 0;
  let refreshPending = false;
  let refreshTimer: ReturnType<typeof setTimeout>;
  let historyMarkup = '';
  let grantMarkup = '';
  let operationId = crypto.randomUUID();
  let authorityReview: AuthorityReview | null = null;
  let historyItems: Order[] = [];
  let replacementReview: ReplacementDraft | AmendDraft | null = null;
  const request = (action: string, input: Record<string, unknown> = {}) =>
    options.request('exchange.' + action, { id: options.id, env, ...input });
  const orderText = (order: Draft) => {
    const prices = order.stopLimitPrice
      ? `${t('takeProfitPrice')} ${esc(order.price)} USD · ${t('stopPrice')} ${esc(order.stopPrice)} USD · ${t('stopLimitPrice')} ${esc(order.stopLimitPrice)} USD`
      : `${esc(order.price)} USD${order.stopPrice ? ' · ' + t('stopPrice') + ' ' + esc(order.stopPrice) + ' USD · ' + t(order.triggerDirection === 'up' ? 'triggerUp' : 'triggerDown') : ''}`;
    return `${t(order.side)} ${esc(order.size)} ${esc(order.product)} · ${prices}${order.postOnly ? ' · ' + t('postOnly') : ''}`;
  };
  const replacementPanel = q('[data-ex-replacement]');
  const showReplacement = (order: Order | null, amend = false) => {
    replacementPanel.hidden = !order;
    if (!order) {
      replacementPanel.replaceChildren();
      return;
    }
    const draft = replacementReview;
    const native = draft && 'orderId' in draft ? draft : null;
    const original = draft
      ? orderText({
          ...order,
          size: draft.originalSize,
          price: draft.originalPrice,
          stopPrice: native?.originalStopPrice,
          stopLimitPrice: native?.originalStopLimitPrice,
        })
      : orderText(order);
    replacementPanel.innerHTML = `<header><h3>${t(amend ? 'amend' : 'replace')}</h3><span>${t(env === 'live' ? 'live' : 'sandbox')}</span></header>
      <div class="quant-exchange-replacement-terms">
        <article><small>${t('originalOrder')} · ${status(draft && 'originalStatus' in draft ? draft.originalStatus : order.status)}</small>
          <strong>${original}</strong>
          <span>${t('filledSize')} · ${esc(draft?.filledSize ?? order.filledSize ?? '—')}</span>
          <code>${esc(order.venueId || order.clientId)}</code>
        </article>
        ${
          draft
            ? `<article><small>${t(amend ? 'amendedTerms' : 'replacementOrder')}</small><strong>${orderText(draft)}</strong>
          ${native ? `<span>${t('fixLeaves')} · ${esc(native.remainingSize)}</span><span>${t(native.stopPrice ? (native.keepsTriggerPriority ? 'keepTriggerPriority' : 'loseTriggerPriority') : native.keepsPriority ? 'amendKeepPriority' : 'amendLosePriority')}</span>` : ''}
          <span>${t(amend ? 'remainingNotional' : 'notional')} · ${esc(draft.notional)} USD</span>
          <span>${t('fee')} · ${esc(draft.estimatedFee)} USD</span></article>`
            : ''
        }
      </div>
      <p class="le-subtle">${t(amend ? 'amendHint' : 'replacementHint')}</p>
      ${
        draft
          ? `<form data-ex-replacement-confirm>
        <label>${t(amend ? 'ackAmend' : 'ackReplace')}<input name="ack" autocomplete="off" required></label>
        <div class="quant-exchange-replacement-actions">${button('discard', 'discardReplacement')}
        <button class="quant-primary">${t(amend ? 'confirmAmend' : 'confirmReplacement')}</button></div></form>`
          : `<form data-ex-replacement-preview="${esc(order.clientId)}" ${amend ? 'data-ex-amend' : ''}><div class="le-fields">
        <label>${t(amend ? 'amendSize' : 'replacementSize')}<input name="size" value="${amend ? esc(order.size) : ''}" inputmode="decimal" maxlength="37" required></label>
        <label>${t(order.stopLimitPrice ? 'takeProfitPrice' : 'price')}<input name="price" value="${esc(amend ? order.price : order.replacement?.price || order.price)}" inputmode="decimal" maxlength="37" required></label>
        ${amend && order.stopPrice ? `<label>${t('stopPrice')}<input name="stopPrice" value="${esc(order.stopPrice)}" inputmode="decimal" maxlength="37" required></label>` : ''}
        ${amend && order.stopLimitPrice ? `<label>${t('stopLimitPrice')}<input name="stopLimitPrice" value="${esc(order.stopLimitPrice)}" inputmode="decimal" maxlength="37" required></label>` : ''}
        </div><div class="quant-exchange-replacement-actions">${button('discard', 'discardReplacement')}
        <button class="quant-primary">${t('preview')}</button></div></form>`
      }`;
    replacementPanel.querySelector<HTMLInputElement>('input')?.focus();
  };
  const discardReplacement = async () => {
    if (replacementReview)
      await request('orderId' in replacementReview ? 'discardAmend' : 'discardReplacement', {
        reviewId: replacementReview.reviewId,
      });
    replacementReview = null;
    showReplacement(null);
  };
  const fixOpen = () => ['connecting', 'recovering', 'ready'].includes(fixState?.phase || '');
  const fixReport = q('[data-ex-fix-report]');
  const showFixState = (next?: FixState) => {
    fixState = next;
    if (!next || next.phase === 'idle') fixReport.hidden = true;
    const key = {
      idle: 'fixIdle',
      connecting: 'fixConnecting',
      recovering: 'fixRecovering',
      ready: 'fixReady',
      disconnected: 'fixDisconnected',
    } as const;
    q('[data-ex-fix-status]').textContent = dictionary[key[next?.phase || 'idle']];
    q('[data-ex-fix-notice]').innerHTML = next?.error
      ? status(next.error)
      : next?.lastSequence && next.phase === 'ready'
        ? t('fixSequence') + ' · ' + esc(next.lastSequence)
        : '';
    q('[data-ex=fixToggle]').textContent = dictionary[fixOpen() ? 'fixClose' : 'fixConnect'];
    const select = q<HTMLSelectElement>('[data-ex-order] [name=transport]');
    const native = q<HTMLOptionElement>('[data-ex-order] [name=transport] option[value=fix]');
    native.disabled = next?.phase !== 'ready';
    if (native.disabled && select.value === 'fix' && orderKind.value === 'limit')
      select.value = 'rest';
    syncOrderKind();
  };
  const units = (grant: Authority) => esc(grant.product.split('-')[grant.side === 'buy' ? 1 : 0]);
  const authoritySummary = (grant: Authority) =>
    `<strong>${t(grant.side)} · ${esc(grant.product)} · ${grant.transport === 'fix' ? 'FIX 5.0' : 'REST'} · ${t(grant.postOnly ? 'postOnly' : 'allowTaker')}${grant.allowAmend ? ' · ' + t('allowFixAmend') : ''}</strong>
    ${grant.allowStopLimit ? `<p>${t('allowStopLimit')}</p>` : ''}
    ${grant.allowTpsl ? `<p>${t('allowTpsl')}</p>` : ''}
    <dl class="quant-exchange-limits">
      <div><dt>${t('perOrder')}</dt><dd>${esc(grant.perOrder)} ${units(grant)}</dd></div>
      <div><dt>${t('total')}</dt><dd>${esc(grant.total)} ${units(grant)}</dd></div>
      <div><dt>${t(grant.allowAmend ? 'maxOperations' : 'maxOrders')}</dt><dd>${esc(grant.maxOrders)}</dd></div>
      ${grant.maxCancels ? `<div><dt>${t('maxCancels')}</dt><dd>${esc(grant.maxCancels)}</dd></div>` : ''}
    </dl>
    <p class="quant-exchange-profile">${t('accountProfile')} <code>${esc(grant.profileId)}</code></p>`;
  const render = async (background = false) => {
    const token = ++renderToken;
    const history = (await request('list', { offset })) as History;
    if (!d.open || token !== renderToken) return;
    historyItems = history.items;
    next = history.next;
    q('[data-ex-product]').textContent =
      history.product + ' · ' + (history.configured ? dictionary.configured : dictionary.connect);
    orderForm.hidden = !history.configured || !replacementPanel.hidden;
    q('[data-ex=disconnect]').hidden = !history.configured;
    q('[data-ex-fix]').hidden = !history.configured || !history.fix;
    showFixState(history.fix);
    const watch = history.watch;
    watchEnabled = watch?.enabled === true;
    q('[data-ex-watch]').hidden = !history.configured;
    q<HTMLButtonElement>('[data-ex=watch]').textContent =
      dictionary[watchEnabled ? 'watchDisable' : 'watchEnable'];
    const watchKey = {
      off: 'watchEnable',
      idle: 'watchIdle',
      connecting: 'watchConnecting',
      live: 'watchLive',
      fallback: 'watchFallback',
    } as const;
    q('[data-ex-watch-status]').textContent =
      watchEnabled && watch ? dictionary[watchKey[watch.phase]] : dictionary.watchIdle;
    q('[data-ex-watch-status]').hidden = !watchEnabled;
    q('[data-ex-watch-notice]').innerHTML = [
      watchEnabled
        ? watch?.lastVerifiedAt
          ? t('watchChecked') +
            ' · ' +
            esc(new Date(watch.lastVerifiedAt).toLocaleTimeString(language))
          : t('watchUnverified')
        : '',
      watch?.error ? status(watch.error) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    q('[data-ex-authority]').hidden = !history.configured && !history.grants.length;
    authorityForm.hidden = !history.configured || !!authorityReview;
    const grants = history.grants
      .map(
        (grant) => `
      <article class="le-command">
        ${authoritySummary(grant)}
        <p>${status(grant.status)} · ${t('remaining')} ${esc(grant.remaining)} ${units(grant)} · ${t(grant.allowAmend ? 'operationsRemaining' : 'ordersRemaining')} ${esc(grant.ordersRemaining)}</p>
        ${grant.maxCancels ? `<p>${t('cancelsRemaining')} · ${esc(grant.cancelsRemaining)}</p>` : ''}
        <p>${t('expiresAt')} · ${esc(new Date(grant.expiresAt).toLocaleString(language))}</p>
        ${grant.status !== 'authorityRevoked' ? button('revokeAuthority', 'revokeAuthority', 'data-grant="' + esc(grant.grantId) + '"') : ''}
      </article>`,
      )
      .join('');
    if (grantMarkup !== grants) {
      grantMarkup = grants;
      q('[data-ex-grants]').innerHTML = grants;
    }
    if (!background) {
      const review = q('[data-ex-authority-review]');
      review.hidden = !authorityReview;
      review.innerHTML = authorityReview
        ? `<form class="le-command" data-ex-authority-confirm>
      ${authoritySummary(authorityReview)}
      <p>${t(env === 'live' ? 'live' : 'sandbox')} · ${t('minutes')} ${esc(authorityReview.minutes)}</p>
      ${authorityReview.transport === 'fix' ? `<p class="le-subtle">${t('fixAuthorityHint')}</p>` : ''}
      ${authorityReview.maxCancels ? `<p class="le-subtle">${t('cancelAuthorityHint')}</p>` : ''}
      ${authorityReview.allowTpsl ? `<p class="le-subtle">${t('tpslHint')}</p>` : ''}
      <label>${t('ackAuthority')}<input name="ack" autocomplete="off" required></label>
      <button class="quant-primary">${t('confirmAuthority')}</button>${button('discard', 'discardAuthority')}
    </form>`
        : '';
      const drafts = q('[data-ex-drafts]');
      drafts.hidden = !history.drafts.length;
      drafts.innerHTML =
        '<header><h3>' +
        t('drafts') +
        '</h3></header>' +
        history.drafts
          .map(
            (
              order,
            ) => `<form class="le-command" data-ex-submit="${esc(order.reviewId)}" data-digest="${esc(order.specHash)}">
        <strong>${orderText(order)} · ${order.fixConnectionId ? 'FIX 5.0' : 'REST'}</strong>
        <p>${t(order.stopLimitPrice ? 'maxNotional' : 'notional')} · ${esc(order.notional)} USD · ${t('fee')} · ${esc(order.estimatedFee)} USD</p>
        ${order.stopPrice ? `<p class="le-subtle">${t(order.stopLimitPrice ? 'tpslHint' : 'stopLimitHint')}</p>` : ''}
        <label>${t('ackSubmit')}<input name="ack" autocomplete="off" required></label>
        <button class="quant-primary">${t('submit')}</button>${button('discard', 'discard', 'data-order="' + esc(order.reviewId) + '"')}
      </form>`,
          )
          .join('');
    }
    const markup =
      history.items
        .map(
          (order) =>
            `<details data-ex-item="${esc(order.clientId)}"><summary>${orderText(order)} · ${status(order.status)}${order.fix ? ' · FIX' : ''}${order.grantId ? ' · ' + t('agentOrder') : ''}</summary><div class="le-command">
      <code>${esc(order.venueId || order.clientId)}</code>
      ${order.stopLimitPrice ? `<p>${t('tpslOrder')} · ${t(order.activeLeg === 'stop-loss' ? 'tpsl-stop-loss' : order.activeLeg === 'take-profit' ? 'tpsl-take-profit' : order.stopState === 'waiting' ? 'tpsl-armed' : order.stopState === 'triggered' ? 'stop-triggered' : 'stop-unverified')}${order.activePrice ? ' · ' + t('activePrice') + ' ' + esc(order.activePrice) + ' USD' : ''}</p>` : order.stopPrice ? `<p>${t('stopLimitOrder')} · ${t(`stop-${order.stopState || 'unverified'}`)}</p>` : ''}
      <p>${t('filledSize')} · ${esc(order.filledSize ?? '—')} · ${esc(order.executedValue ?? '—')} USD · ${t('fillFees')} · ${esc(order.fillFees ?? '—')} USD</p>
      ${order.error ? '<p>' + status(order.error) + '</p>' : ''}
      ${order.replaces ? `<p>${t('originalOrder')} · <code>${esc(order.replaces)}</code></p>` : ''}
      ${order.replacement ? `<p>${t('replacementOrder')} · ${esc(order.replacement.size)} @ ${esc(order.replacement.price)} USD · <code>${esc(order.replacement.clientId)}</code></p>${order.replacement.error ? `<p>${status(order.replacement.error)}</p>` : ''}` : ''}
      ${history.configured ? button('reconcile', 'reconcile', 'data-order="' + esc(order.clientId) + '"') : ''}
      ${history.configured && history.fix && order.venueId ? button('fixQuery', 'fixQuery', 'data-order="' + esc(order.clientId) + '"') : ''}
      ${order.replacementAvailable ? button(order.status === 'canceled' ? 'reviewReplacementAgain' : 'replace', 'replace', 'data-order="' + esc(order.clientId) + '"') : ''}
      ${order.amendmentAvailable ? button('amend', 'amend', 'data-order="' + esc(order.clientId) + '"') : ''}
      ${order.fix?.pending ? `<p>${t('amendPending')} · ${orderText({ ...order, ...order.fix.pending })} <code>${esc(order.fix.pending.clientId)}</code></p>` : ''}
      ${
        order.cancellations?.length
          ? `<details><summary>${t('cancelHistory')} · ${order.cancellations.length}</summary>${order.cancellations
              .slice(-10)
              .reverse()
              .map(
                (row) =>
                  `<p>${status('cancel-' + (row.outcome || 'unknown'))} · ${row.transport === 'fix' ? 'FIX 5.0' : 'REST'} · <code>${esc(row.clientId)}</code></p>`,
              )
              .join('')}</details>`
          : ''
      }
      ${
        order.fix?.amendments.length
          ? `<details><summary>${t('amendHistory')} · ${order.fix.amendments.length}</summary>${order.fix.amendments
              .slice()
              .reverse()
              .map(
                (row) =>
                  `<p>${status('amend-' + row.outcome)} · ${orderText({ ...order, ...row })} <code>${esc(row.clientId)}</code></p>`,
              )
              .join('')}</details>`
          : ''
      }
      ${
        order.cancelAvailable
          ? `<form data-ex-cancel="${esc(order.clientId)}"><label>${t('ackCancel')}<input name="ack" autocomplete="off" required></label><button>${t('cancel')}</button></form>`
          : ''
      }</div></details>`,
        )
        .join('') || '<p class="le-subtle">' + t('empty') + '</p>';
    if (historyMarkup !== markup) {
      historyMarkup = markup;
      const panel = q('[data-ex-history]');
      const expanded = new Map(
        [...panel.querySelectorAll<HTMLDetailsElement>('[data-ex-item][open]')].map((element) => [
          element.dataset.exItem,
          element.querySelector<HTMLInputElement>('[name=ack]'),
        ]),
      );
      const focus = document.activeElement;
      panel.innerHTML = markup;
      for (const element of panel.querySelectorAll<HTMLDetailsElement>('[data-ex-item]')) {
        if (!expanded.has(element.dataset.exItem)) continue;
        element.open = true;
        const old = expanded.get(element.dataset.exItem);
        const input = element.querySelector<HTMLInputElement>('[name=ack]');
        if (old && input) {
          input.value = old.value;
          if (old === focus) {
            input.focus({ preventScroll: true });
            input.setSelectionRange(old.selectionStart, old.selectionEnd);
          }
        }
      }
    }
    q<HTMLButtonElement>('[data-ex=previous]').disabled = offset === 0;
    q<HTMLButtonElement>('[data-ex=next]').disabled = next === null;
    q('[data-ex-pagination]').hidden = offset === 0 && next === null;
    if (history.accountError) message(history.accountError);
  };
  const run = async (work: () => Promise<unknown> | void) => {
    if (busy || !d.open) return;
    busy = true;
    renderToken++;
    d.setAttribute('aria-busy', 'true');
    message(null);
    try {
      await work();
      await render();
    } catch (error) {
      message(error);
    } finally {
      busy = false;
      d.removeAttribute('aria-busy');
      if (refreshPending) {
        refreshPending = false;
        refreshFromEvent();
      }
    }
  };
  const refreshFromEvent = () => {
    clearTimeout(refreshTimer);
    if (busy) {
      refreshPending = true;
      return;
    }
    refreshTimer = setTimeout(() => {
      if (d.open && !busy) void render(true).catch(message);
    }, 150);
  };
  const unsubscribe = options.subscribe((event) => {
    if (event.type === 'quant-exchange-changed' && event.env === env) {
      if (event.fix && d.open) showFixState(event.fix as FixState);
      refreshFromEvent();
    }
  });
  d.addEventListener(
    'close',
    () => {
      accountForm.reset();
      clearTimeout(refreshTimer);
      if (typeof unsubscribe === 'function') unsubscribe();
      d.remove();
    },
    { once: true },
  );
  selector.addEventListener('change', () => {
    if (busy) {
      selector.value = env;
      return;
    }
    void run(() => {
      replacementReview = null;
      showReplacement(null);
      fixReport.hidden = true;
      env = selector.value;
      offset = 0;
      accountForm.reset();
      orderForm.reset();
      authorityForm.reset();
      showGrantTransport();
      authorityReview = null;
      operationId = crypto.randomUUID();
    });
  });
  d.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-ex]');
    if (!button) return;
    const action = button.dataset.ex;
    if (action === 'close') return d.close();
    if (action === 'fixToggle' && fixOpen()) {
      void request('fixDisconnect')
        .then((next) => {
          if (d.open) showFixState(next as FixState);
        })
        .catch(message);
      return;
    }
    void run(async () => {
      if (action === 'previous') offset = Math.max(0, offset - 20);
      if (action === 'next' && next !== null) offset = next;
      if (action === 'disconnect') return request('disconnect');
      if (action === 'watch') return request('watch', { enabled: !watchEnabled });
      if (action === 'fixToggle') {
        showFixState({ phase: 'connecting', lastSequence: null, error: null });
        try {
          return await request('fixConnect');
        } catch (error) {
          if (error instanceof Error && error.message === 'EXCHANGE_FIX_CLOSED') return;
          showFixState({ phase: 'disconnected', lastSequence: null, error: null });
          throw error;
        }
      }
      if (action === 'fixQuery') {
        q<HTMLDetailsElement>('[data-ex-fix]').open = true;
        fixReport.hidden = true;
        const report = (await request('fixQuery', { orderId: button.dataset.order })) as FixReport;
        fixReport.innerHTML = `<strong>${status(report.status)}</strong><code>${esc(report.venueId)}</code>
          ${report.triggered ? `<p>${t('stop-triggered')}</p>` : ''}
          ${report.price ? `<p>${t('activePrice')} · ${esc(report.price)} USD</p>` : ''}
          <p>${t('filledSize')} · ${esc(report.filledSize ?? '—')} · ${t('fixLeaves')} · ${esc(report.remainingSize ?? '—')}</p>
          <small>${t('watchChecked')} · ${esc(new Date(report.checkedAt).toLocaleTimeString(language))}</small>`;
        fixReport.hidden = false;
        fixReport.scrollIntoView({ block: 'nearest' });
      }
      if (action === 'reconcile') return request('reconcile', { orderId: button.dataset.order });
      if (action === 'discardReplacement') return discardReplacement();
      if (action === 'replace' || action === 'amend') {
        await discardReplacement();
        fixReport.hidden = true;
        showReplacement(
          historyItems.find((order) => order.clientId === button.dataset.order) || null,
          action === 'amend',
        );
      }
      if (action === 'revokeAuthority') return request(action, { grantId: button.dataset.grant });
      if (action === 'discardAuthority' && authorityReview) {
        await request(action, { grantId: authorityReview.grantId });
        authorityReview = null;
      }
      if (action === 'discard') {
        operationId = crypto.randomUUID();
        return request('discard', { reviewId: button.dataset.order });
      }
    });
  });
  d.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = Object.fromEntries(new FormData(form));
    if (form === accountForm) accountForm.reset();
    void run(async () => {
      if (form === accountForm) {
        await request('connect', data);
        q<HTMLDetailsElement>('[data-ex-account]').open = false;
      }
      if (form === orderForm) {
        delete data.orderKind;
        await request('preview', { ...data, postOnly: Boolean(data.postOnly), operationId });
        operationId = crypto.randomUUID();
      }
      if (form === authorityForm) {
        authorityReview = (await request('prepareAuthority', {
          ...data,
          postOnly: Boolean(data.postOnly),
          allowAmend: Boolean(data.allowAmend),
          allowStopLimit: Boolean(data.allowStopLimit),
          allowTpsl: Boolean(data.allowTpsl),
          maxOrders: Number(data.maxOrders),
          maxCancels: Number(data.maxCancels),
          minutes: Number(data.minutes),
        })) as AuthorityReview;
      }
      if (form.hasAttribute('data-ex-authority-confirm') && authorityReview) {
        const { grantId, specHash } = authorityReview;
        await request('confirmAuthority', { grantId, specHash, ack: data.ack });
        authorityReview = null;
        authorityForm.reset();
        showGrantTransport();
      }
      if (form.dataset.exSubmit)
        await request('confirm', {
          reviewId: form.dataset.exSubmit,
          specHash: form.dataset.digest,
          ack: data.ack,
        });
      if (form.dataset.exCancel)
        await request('cancel', { orderId: form.dataset.exCancel, ack: data.ack });
      if (form.dataset.exReplacementPreview) {
        const orderId = form.dataset.exReplacementPreview;
        const order = historyItems.find((item) => item.clientId === orderId);
        if (!order) return;
        const amend = form.hasAttribute('data-ex-amend');
        replacementReview = (await request(amend ? 'previewAmend' : 'previewReplacement', {
          ...data,
          orderId,
        })) as ReplacementDraft | AmendDraft;
        showReplacement(order, amend);
      }
      if (form.hasAttribute('data-ex-replacement-confirm') && replacementReview) {
        const { reviewId, specHash } = replacementReview;
        const amend = 'orderId' in replacementReview;
        await request(amend ? 'confirmAmend' : 'confirmReplacement', {
          orderId:
            'orderId' in replacementReview ? replacementReview.orderId : replacementReview.replaces,
          reviewId,
          specHash,
          ack: data.ack,
        });
        replacementReview = null;
        showReplacement(null);
        offset = 0;
      }
    });
  });
  void run(() => {});
}
