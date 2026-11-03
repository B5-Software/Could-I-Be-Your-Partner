/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/quant-native-paper-labels.json';
import sourceLabels from '../../shared/quant-source-labels.json';
import type {
  NativePaperStatus,
  NativePaperOrder,
  NativePaperExecution,
} from '../../shared/quant-types';
const escape = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
type Key = keyof typeof labels.zh;
type Options = {
  id: string;
  language: () => string;
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => unknown;
};
export function openNativePaper(options: Options): void {
  const language = () =>
    options.language().startsWith('de') ? 'de' : options.language().startsWith('en') ? 'en' : 'zh';
  const t = (key: Key) => labels[language()][key];
  const dialog = document.createElement('dialog');
  dialog.className = 'quant-dialog quant-native-paper';
  const button = (key: Key, action: string) =>
    `<button type="button" data-np="${action}">${escape(t(key))}</button>`;
  const field = (key: Key, name: string, value = '', extra = '') =>
    `<label>${escape(t(key))}<input name="${name}" value="${escape(value)}" ${extra}></label>`;
  dialog.innerHTML = `<header><div><h2>${escape(t('npTitle'))}</h2><p>${escape(t('npHint'))}</p></div>${button('npClose', 'close')}</header><p class="quant-hint">${escape(t('npShare'))}</p><p data-np-error role="alert" hidden></p><section class="np-toolbar">${button('npStart', 'start')}<label>${escape(t('npSelect'))}<select data-np-accounts><option value="">${escape(t('npNone'))}</option></select></label>${button('npCreate', 'create')}${button('npRefresh', 'refresh')}</section><section data-np-account aria-live="polite"></section><form data-np-create hidden><h3>${escape(t('npCreate'))}</h3><div class="np-grid">${field('npName', 'name', 'Paper')}${field('npCash', 'cash', '10000', 'inputmode="decimal"')}${field('npMaxOrder', 'maxOrder', '1000', 'inputmode="decimal"')}${field('npMaxOrders', 'maxOrders', '20', 'type="number" min="1" max="10000"')}</div><details><summary>${escape(t('npAdvanced'))}</summary><div class="np-grid">${['ETH', 'BTC', 'SOL'].map((asset, i) => `<label>${escape(t('npInitial'))} · ${asset}<input name="fund${asset}" value="0" inputmode="decimal"></label><label>${escape(t('npPositionLimit'))} · ${asset}<input name="cap${asset}" value="${[10, 1, 100][i]}" inputmode="decimal"></label>`).join('')}</div></details><footer><button type="submit" class="quant-primary">${escape(t('npCreate'))}</button>${button('npBack', 'create-back')}</footer></form><form data-np-order><div class="np-grid"><label>${escape(t('npProduct'))}<select name="product"><option>ETH-USD</option><option>BTC-USD</option><option>SOL-USD</option></select></label><label>${escape(t('npSide'))}<select name="side"><option value="buy">${escape(t('npBuy'))}</option><option value="sell">${escape(t('npSell'))}</option></select></label>${field('npPrice', 'price', '', 'inputmode="decimal" required')}${field('npQuantity', 'quantity', '', 'inputmode="decimal" required')}</div><p class="quant-hint" data-np-source></p><footer>${button('npConnect', 'source')}<button type="submit" class="quant-primary">${escape(t('npSubmit'))}</button></footer><p class="quant-hint">${escape(t('npLimitHint'))}</p></form><section class="np-reconcile" hidden><p>${escape(t('npUncertain'))}</p>${button('npReconcile', 'reconcile')}</section><section class="np-history"><header>${button('npOrders', 'orders')}${button('npFills', 'executions')}<span data-np-count></span></header><div data-np-history></div><footer>${button('npPrevious', 'previous')}${button('npNext', 'next')}</footer></section>`;
  document.body.append(dialog);
  dialog
    .querySelector('[data-np-accounts]')!
    .parentElement!.insertAdjacentHTML(
      'afterend',
      `<span class="np-account-pages">${button('npPrevious', 'accounts-previous')}${button('npNext', 'accounts-next')}</span>`,
    );
  dialog.showModal();
  dialog
    .querySelector('[data-np-account]')!
    .insertAdjacentHTML(
      'afterend',
      '<section class="np-reconcile" data-np-safety hidden><strong data-np-safety-title></strong><p data-np-safety-text></p>' +
        button('npHalt', 'halt') +
        button('npResetHalt', 'reset-halt') +
        '</section><section class="np-reconcile" data-np-confirm hidden><p>' +
        escape(t('npConfirmReset')) +
        '</p>' +
        button('npStayHalted', 'reset-cancel') +
        button('npResetHalt', 'reset-confirm') +
        '</section>',
    );
  const el = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const call = <T = unknown>(action: string, input: Record<string, unknown> = {}) =>
    options.request(
      action === 'native.start' || action === 'native.source.start'
        ? action
        : 'native.paper.' + action,
      { ...input, id: options.id },
    ) as Promise<T>;
  let busy = false,
    accountOffset = 0,
    accountNext: number | null = null,
    pulling = false,
    refreshAgain = false,
    offset = 0,
    next: number | null = null,
    tab = 'orders',
    timer: ReturnType<typeof setTimeout> | undefined,
    status: NativePaperStatus | undefined,
    accountOptions = '',
    createOperation = crypto.randomUUID(),
    orderOperation = crypto.randomUUID(),
    orderPayload = '',
    closed = false;
  let pendingReset: { accountId: string; expectedHalt: string } | undefined;
  let haltOperation = crypto.randomUUID();
  let halting = false;
  const error = (e: unknown) => {
    if (closed) return;
    const n = el('[data-np-error]');
    const message = e instanceof Error ? e.message : String(e);
    const messages: Record<string, Key> = {
      NATIVE_OUTCOME_UNKNOWN: 'npUncertain',
      NATIVE_RECONCILE_REQUIRED: 'npUncertain',
      NATIVE_ACCOUNT_REQUIRED: 'npNone',
      NATIVE_NOT_RUNNING: 'npNotRunning',
      ACCOUNT_PAUSED: 'npPaused',
      ACCOUNT_HALTED: 'npHaltHint',
      HALT_CHANGED: 'npHaltChanged',
      ACCOUNT_SCOPE_CHANGED: 'npHaltChanged',
      LEDGER_PAUSED: 'npPaused',
    };
    n.textContent = messages[message] ? t(messages[message]!) : message;
    n.hidden = false;
  };
  const ns = (v: string) => {
    try {
      return new Date(Number(BigInt(v) / 1000000n)).toLocaleString();
    } catch {
      return '—';
    }
  };
  const state = (o: NativePaperOrder) =>
    t(
      o.execution.held
        ? 'npHeld'
        : o.status === 'filled'
          ? 'npOrderFilled'
          : o.status === 'cancelled'
            ? 'npOrderCancelled'
            : o.status === 'partially-filled'
              ? 'npOrderPartial'
              : 'npAttached',
    );
  const refresh = async () => {
    if (closed) return;
    if (pulling) {
      refreshAgain = true;
      return;
    }
    pulling = true;
    try {
      const requestedTab = tab,
        requestedOffset = offset,
        requestedAccountOffset = accountOffset;
      status = await call<NativePaperStatus>('view', {
        kind: requestedTab,
        offset: requestedOffset,
        limit: 15,
        accountOffset: requestedAccountOffset,
      });
      if (closed) return;
      if (
        requestedTab !== tab ||
        requestedOffset !== offset ||
        requestedAccountOffset !== accountOffset
      ) {
        refreshAgain = true;
        return;
      }
      el<HTMLButtonElement>('[data-np=start]').disabled =
        status.connected || busy || ['starting', 'stopping'].includes(status.engineState ?? '');
      el<HTMLButtonElement>('[data-np=create]').disabled =
        !status.connected || busy || !!status.pendingOrder;
      el<HTMLButtonElement>('[data-np-create] [type=submit]').disabled =
        !status.connected || busy || !!status.pendingOrder;
      el('.np-reconcile').hidden = !status.pendingOrder;
      el<HTMLButtonElement>('[data-np=reconcile]').disabled = !status.connected || busy;
      const select = el<HTMLSelectElement>('[data-np-accounts]');
      select.disabled = !status.connected || busy || !!status.pendingOrder;
      if (status.connected) {
        const accounts = status.accountsPage!;
        accountNext = accounts.next;
        if (status.account && !accounts.items.some((a) => a.id === status!.accountId))
          accounts.items.unshift(status.account);
        const html =
          `<option value="">${escape(t('npNone'))}</option>` +
          accounts.items
            .map(
              (a) =>
                `<option value="${escape(a.id)}">${escape(a.name)} · ${escape(a.id.slice(-6))}</option>`,
            )
            .join('');
        if (html !== accountOptions) {
          select.innerHTML = html;
          accountOptions = html;
        }
        select.value = status.accountId || '';
      }
      el<HTMLButtonElement>('[data-np=accounts-previous]').disabled =
        !status.connected || busy || accountOffset === 0;
      el<HTMLButtonElement>('[data-np=accounts-next]').disabled =
        !status.connected || busy || accountNext === null;
      const a = status.account;
      el('[data-np-safety-title]').textContent = t(a?.halt ? 'npHalted' : 'npHalt');
      el<HTMLFormElement>('[data-np-order]').hidden = !!a?.halt;
      el('[data-np-safety]').hidden = !a;
      el('[data-np-safety-text]').textContent = t(a?.halt ? 'npHaltHint' : 'npHaltScope');
      el<HTMLButtonElement>('[data-np=halt]').disabled = !status.connected || halting;
      el<HTMLButtonElement>('[data-np=reset-halt]').hidden = !a?.halt;
      el<HTMLButtonElement>('[data-np=reset-halt]').disabled = !status.connected || busy;
      const accountHtml = a
        ? `<header><div><h3>${escape(a.name)}</h3><span>${escape(t(a.active ? 'npActive' : 'npPaused'))} · ${a.openOrders} ${escape(t('npOpen'))}</span></div>${button(a.active ? 'npPause' : 'npEnable', a.active ? 'pause' : 'enable')}</header><div class="np-balances">${Object.entries(
            a.assets,
          )
            .map(
              ([asset, b]) =>
                `<article><strong>${escape(asset)}</strong><div>${escape(t('npTotal'))}<b>${escape(b.total)}</b></div><div>${escape(t('npReserved'))}<b>${escape(b.reserved)}</b></div><div>${escape(t('npAvailable'))}<b>${escape(b.available)}</b></div></article>`,
            )
            .join('')}</div>`
        : `<p>${escape(t(status.connected ? 'npNone' : 'npNotRunning'))}</p>`;
      const accountNode = el('[data-np-account]');
      if (accountNode.innerHTML !== accountHtml) accountNode.innerHTML = accountHtml;
      accountNode.querySelector<HTMLButtonElement>('button')?.toggleAttribute('disabled', busy);
      if (a?.halt)
        accountNode
          .querySelector<HTMLButtonElement>('[data-np=enable]')
          ?.setAttribute('disabled', '');
      const product = el<HTMLSelectElement>('[data-np-order] [name=product]').value,
        source = status.sources.find((s) => s.product === product);
      const phase = source?.phase,
        key =
          phase === 'ready'
            ? 'sourceReady'
            : phase === 'reconnecting'
              ? 'sourceReconnect'
              : phase === 'delayed'
                ? 'sourceDelayed'
                : phase === 'snapshot'
                  ? 'sourceSnapshot'
                  : phase === 'stopped'
                    ? 'sourceStop'
                    : 'sourceResolving';
      el('[data-np-source]').textContent = source
        ? `${product} · ${sourceLabels[language()][key]} · ${source.assumptions?.feeBps ?? '—'} bps${source.lastError ? ' · ' + source.lastError : ''}`
        : '';
      el<HTMLButtonElement>('[data-np-order] [type=submit]').disabled =
        !a?.active || phase !== 'ready' || busy || !!status.pendingOrder;
      el<HTMLButtonElement>('[data-np=source]').disabled = !status.connected || busy;
      if (a) {
        const page = status.historyPage!;
        next = page.next;
        el('[data-np-count]').textContent = `${page.total}`;
        const headers = (
          tab === 'orders'
            ? ['npSide', 'npPrice', 'npQuantity', 'npFilled', 'npFees', 'npStatus']
            : ['npTime', 'npSide', 'npPrice', 'npQuantity', 'npFillFee', 'npSource']
        ) as Key[];
        const rows =
          tab === 'orders'
            ? (page.items as NativePaperOrder[])
                .map(
                  (o) =>
                    `<tr><td>${escape(t(o.request.side === 'buy' ? 'npBuy' : 'npSell'))}<small>${escape(o.request.instrument.split(':')[1])} · ${escape(t('npAccount'))} ${escape(o.request.account.slice(-6))}</small></td><td>${escape(o.request.price)}</td><td>${escape(o.request.quantity)}</td><td>${escape(o.filled)}</td><td>${escape(o.fees)}</td><td>${escape(state(o))}${['open', 'partially-filled'].includes(o.status) ? `<button type="button" data-cancel="${escape(o.request.id)}">${escape(t('npCancel'))}</button>` : ''}<small>${escape(o.request.id.slice(-12))}</small></td></tr>`,
                )
                .join('')
            : (page.items as NativePaperExecution[])
                .map(
                  (e) =>
                    `<tr><td>${escape(ns(e.recorded_at_ns))}</td><td>${escape(t(e.side === 'buy' ? 'npBuy' : 'npSell'))}</td><td>${escape(e.fill.price)}</td><td>${escape(e.fill.quantity)}</td><td>${escape(e.fees)}</td><td><details><summary>${escape(e.fill.source?.event_id || e.fill.id)}</summary><small>${escape(e.fill.source?.venue)} · ${escape(e.fill.source?.provider_time_ns || e.fill.source?.time_ns)}</small></details></td></tr>`,
                )
                .join('');
        const html = rows
          ? `<table><thead><tr>${headers.map((k) => `<th>${escape(t(k))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
          : `<p>${escape(t(tab === 'orders' ? 'npNoOrders' : 'npNoFills'))}</p>`;
        const target = el('[data-np-history]');
        if (target.innerHTML !== html) target.innerHTML = html;
      } else {
        el('[data-np-history]').textContent = '';
        next = null;
      }
      el<HTMLButtonElement>('[data-np=previous]').disabled = offset === 0 || busy;
      el<HTMLButtonElement>('[data-np=next]').disabled = next === null || busy;
    } catch (e) {
      error(e);
    } finally {
      pulling = false;
      if (refreshAgain && !closed) {
        refreshAgain = false;
        void refresh();
      }
    }
  };
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    dialog
      .querySelectorAll<HTMLButtonElement>(
        '[data-np=start],[data-np=create],[data-np=source],[data-np=reconcile],[data-np-account] button,[data-np-create] [type=submit],[data-np-order] [type=submit]',
      )
      .forEach((b) => {
        b.disabled = true;
      });
    el('[data-np-error]').hidden = true;
    try {
      await work();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      dialog.removeAttribute('aria-busy');
      await refresh();
    }
  };
  el<HTMLSelectElement>('[data-np-accounts]').addEventListener('change', () => {
    const accountId = el<HTMLSelectElement>('[data-np-accounts]').value;
    if (accountId) void run(() => call('bind', { accountId }));
  });
  el<HTMLSelectElement>('[data-np-order] [name=product]').addEventListener(
    'change',
    () => void refresh(),
  );
  dialog.addEventListener('click', (event) => {
    const node = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!node || node.disabled) return;
    if (node.dataset.cancel) {
      void run(() => call('cancel', { orderId: node.dataset.cancel }));
      return;
    }
    const action = node.dataset.np;
    if (action === 'halt') {
      const accountId = status?.account?.id;
      if (!accountId || halting) return;
      halting = true;
      node.disabled = true;
      void (async () => {
        try {
          await call('halt', { accountId, operationId: haltOperation });
          haltOperation = crypto.randomUUID();
        } catch (e) {
          error(e);
        } finally {
          halting = false;
          await refresh();
        }
      })();
      return;
    }
    if (action === 'reset-halt' && status?.account?.halt) {
      pendingReset = { accountId: status.account.id, expectedHalt: status.account.halt.id };
      el('[data-np-confirm]').hidden = false;
      el<HTMLButtonElement>('[data-np=reset-cancel]').focus();
      return;
    }
    if (action === 'reset-cancel' || action === 'reset-confirm') {
      const pending = pendingReset;
      pendingReset = undefined;
      el('[data-np-confirm]').hidden = true;
      if (action === 'reset-confirm' && pending)
        void run(() => call('reset-halt', { ...pending, confirmed: true }));
      return;
    }
    if (action === 'accounts-previous' || action === 'accounts-next') {
      accountOffset =
        action === 'accounts-next'
          ? (accountNext ?? accountOffset)
          : Math.max(0, accountOffset - 20);
      void refresh();
      return;
    }
    if (action === 'close') return dialog.close();
    if (action === 'create' || action === 'create-back') {
      el('[data-np-create]').hidden = action === 'create-back';
      if (action === 'create') createOperation = crypto.randomUUID();
      return;
    }
    if (action === 'orders' || action === 'executions') {
      tab = action;
      offset = 0;
      void refresh();
      return;
    }
    if (action === 'previous' || action === 'next') {
      offset = action === 'previous' ? Math.max(0, offset - 15) : (next ?? offset);
      void refresh();
      return;
    }
    if (action === 'refresh') {
      void refresh();
      return;
    }
    if (action === 'start') {
      void run(() => call('native.start'));
      return;
    }
    if (action === 'source') {
      void run(() =>
        call('native.source.start', {
          product: el<HTMLSelectElement>('[data-np-order] [name=product]').value,
          feeBps: status?.sources.find(
            (s) => s.product === el<HTMLSelectElement>('[data-np-order] [name=product]').value,
          )?.assumptions?.feeBps,
        }),
      );
      return;
    }
    if (action === 'reconcile') {
      void run(() => call('reconcile'));
      return;
    }
    if (action === 'enable' || action === 'pause') void run(() => call(action));
  });
  el<HTMLFormElement>('[data-np-create]').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement),
      v = (k: string) => String(data.get(k) || '0');
    void run(async () => {
      await call('create', {
        operationId: createOperation,
        name: v('name'),
        assets: { USD: v('cash'), ETH: v('fundETH'), BTC: v('fundBTC'), SOL: v('fundSOL') },
        maxOrderNotional: { USD: v('maxOrder') },
        maxAssetPosition: { ETH: v('capETH'), BTC: v('capBTC'), SOL: v('capSOL') },
        maxOpenOrders: Number(v('maxOrders')),
      });
      if (!closed) el('[data-np-create]').hidden = true;
      createOperation = crypto.randomUUID();
    });
  });
  el<HTMLFormElement>('[data-np-order]').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement),
      data = Object.fromEntries(
        ['product', 'side', 'price', 'quantity'].map((k) => [k, String(form.get(k) || '')]),
      );
    const payload = JSON.stringify(data);
    if (orderPayload && payload !== orderPayload) orderOperation = crypto.randomUUID();
    orderPayload = payload;
    void run(async () => {
      await call('submit', { ...data, operationId: orderOperation });
      orderOperation = crypto.randomUUID();
      orderPayload = '';
    });
  });
  const unsubscribe = options.subscribe((event) => {
    if (
      ![
        'quant-native-changed',
        'quant-native-paper-changed',
        'quant-native-strategies-changed',
        'quant-market-source-changed',
        'quant-market-sources-changed',
      ].includes(String(event.type)) ||
      closed ||
      timer
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, 400);
  });
  dialog.addEventListener(
    'close',
    () => {
      closed = true;
      clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
      dialog.remove();
    },
    { once: true },
  );
  void refresh();
}
