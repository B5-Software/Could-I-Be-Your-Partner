/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/quant-execution-labels.json';
import {
  executionAmount,
  executionPercent,
  type ExecutionRun,
  type ExecutionCommand,
  type ExecutionPage,
  type ExecutionView,
  type ExecutionWallet,
} from '../../shared/quant-execution-types';
import { walletStatus } from './wallet-panel';
type Key = keyof typeof labels.zh;
type Options = {
  id: string;
  venue: string;
  language: () => string;
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  backend: (method: string, ...args: unknown[]) => Promise<unknown>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => unknown;
};
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function openLiveExecution(options: Options): HTMLDialogElement {
  const language = () =>
    options.language().startsWith('de') ? 'de' : options.language().startsWith('en') ? 'en' : 'zh';
  const t = (key: Key) => labels[language()][key];
  const status = (value: string) => walletStatus(options.language(), value);
  const button = (key: Key, action: string, extra = '') =>
    '<button type="button" data-le="' + action + '" ' + extra + '>' + esc(t(key)) + '</button>';
  const field = (key: Key, name: string, value: string, attrs = '') =>
    '<label>' +
    esc(t(key)) +
    '<input name="' +
    name +
    '" value="' +
    value +
    '" ' +
    attrs +
    '></label>';
  const dialog = document.createElement('dialog');
  dialog.className = 'quant-dialog le-dialog';
  dialog.innerHTML =
    '<header class="le-head"><div><span class="le-live">' +
    esc(t('leLive')) +
    '</span><h2>' +
    esc(t('leTitle')) +
    '</h2><p>' +
    esc(t('leBackground')) +
    '</p></div>' +
    button('leClose', 'close') +
    '</header>' +
    '<p class="le-notice">' +
    esc(t('leHint')) +
    '</p><p data-le-error class="le-error" role="alert" hidden></p>' +
    '<div class="le-toolbar">' +
    button('leCreate', 'new', 'class="quant-primary"') +
    button('leWallet', 'wallet') +
    button('leRefresh', 'refresh') +
    '</div>' +
    '<form data-le-form hidden><fieldset><legend>' +
    esc(t('leReview')) +
    '</legend><div class="le-fields">' +
    '<label>' +
    esc(t('leChooseWallet')) +
    '<select name="walletId" required></select></label>' +
    '<label>' +
    esc(t('leSide')) +
    '<select name="side"><option value="buy">' +
    esc(t('leBuy')) +
    '</option><option value="sell">' +
    esc(t('leSell')) +
    '</option></select></label>' +
    field('leInput', 'totalInput', '100', 'inputmode="decimal" required') +
    field('leSlices', 'slices', '2', 'type="number" min="1" max="1000" required') +
    field('leInterval', 'seconds', '60', 'type="number" min="1" max="86400" required') +
    field('leSlippage', 'slippage', '0.50', 'inputmode="decimal" required') +
    field('leFeeBudget', 'maxEstimatedFeeEth', '0.01', 'inputmode="decimal" required') +
    '</div><p class="le-subtle">' +
    esc(t('leFeeHint')) +
    '</p><p class="le-subtle">' +
    esc(t('leDraftHint')) +
    '</p>' +
    '<footer><button type="submit" class="quant-primary">' +
    esc(t('leSave')) +
    '</button>' +
    button('leCancel', 'cancel') +
    '</footer></fieldset></form>' +
    '<div class="le-shell"><aside><div data-le-list>' +
    esc(t('leLoading')) +
    '</div><footer>' +
    button('lePrevious', 'previous') +
    '<span data-le-count></span>' +
    button('leNext', 'next') +
    '</footer></aside>' +
    '<main data-le-detail aria-live="polite"></main></div>';
  document.body.append(dialog);
  dialog.showModal();
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!;
  const form = q<HTMLFormElement>('[data-le-form]');
  const select = form.elements.namedItem('walletId') as HTMLSelectElement;
  let wallets: ExecutionWallet[] = [],
    items: ExecutionRun[] = [],
    selected = '',
    offset = 0,
    next: number | null = null,
    commandOffset = 0;
  let view: ExecutionView | undefined, history: ExecutionPage<ExecutionCommand> | undefined;
  let closed = false,
    refreshing = false,
    busy = false,
    pendingRefresh = false,
    operationId = crypto.randomUUID();
  let renderKey = '',
    walletKey = '',
    refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const stopping = new Set<string>();
  const error = (value: unknown) => {
    if (closed) return;
    const node = q('[data-le-error]');
    node.hidden = false;
    node.textContent = status(value instanceof Error ? value.message : String(value));
  };
  const amount = (run: ExecutionRun, value = run.plan.total_input_atoms) =>
    executionAmount(value, run.plan.side === 'buy' ? 6 : 18);
  const unit = (run: ExecutionRun) => (run.plan.side === 'buy' ? 'USDC' : 'WETH');
  const walletName = (id: string) => wallets.find((w) => w.id === id)?.name || '—';
  const title = (run: ExecutionRun) =>
    (run.plan.side === 'buy' ? t('leBuy') : t('leSell')) + ' · ' + amount(run) + ' ' + unit(run);
  const time = (value: string) => {
    if (!/^\d+$/.test(value)) return '—';
    const date = new Date(Number(BigInt(value) / 1000000n));
    return Number.isFinite(date.getTime()) ? date.toLocaleString(options.language()) : '—';
  };
  const metric = (name: string, value: string, total: string, units: string, progress: number) =>
    '<div class="le-metric"><span>' +
    esc(name) +
    '</span><strong title="' +
    esc(value + ' / ' + total + ' ' + units) +
    '">' +
    esc(value) +
    '<small> / ' +
    esc(total) +
    ' ' +
    esc(units) +
    '</small></strong><div class="le-track" role="progressbar" aria-label="' +
    esc(name) +
    '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
    progress +
    '"><span style="width:' +
    progress +
    '%"></span></div></div>';
  function render() {
    if (closed) return;
    q('[data-le-list]').innerHTML = items.length
      ? items
          .map(
            (run) =>
              '<button type="button" class="le-plan" data-le-run="' +
              esc(run.plan.id) +
              '" aria-current="' +
              (selected === run.plan.id) +
              '"><strong>' +
              esc(title(run)) +
              '</strong><span>' +
              esc(walletName(run.plan.wallet)) +
              '</span><small>' +
              esc(status(run.phase)) +
              ' · ' +
              run.completed_slices +
              ' / ' +
              run.plan.slices +
              '</small></button>',
          )
          .join('')
      : '<p class="le-subtle">' + esc(t('leEmpty')) + '</p>';
    q('[data-le-count]').textContent = items.length
      ? offset + 1 + '–' + (offset + items.length)
      : '0';
    q<HTMLButtonElement>('[data-le=previous]').disabled = offset === 0;
    q<HTMLButtonElement>('[data-le=next]').disabled = next === null;
    const supported = ['base', 'base-sepolia'].includes(options.venue);
    q<HTMLButtonElement>('[data-le=new]').disabled = !supported || busy || !wallets.length;
    if (!view) {
      q('[data-le-detail]').innerHTML =
        '<p class="le-subtle">' +
        esc(!supported ? t('leOnlyBase') : !wallets.length ? t('leNoWallet') : t('leEmpty')) +
        '</p>';
      return;
    }
    const key = JSON.stringify([view, history, wallets, language(), busy, [...stopping]]);
    if (renderKey === key) return;
    renderKey = key;
    const node = q('[data-le-detail]'),
      scroll = node.scrollTop;
    const expanded = new Set(
      [...node.querySelectorAll<HTMLDetailsElement>('details[open]')].map((n) => n.dataset.command),
    );
    const run = view.run,
      wallet = wallets.find((w) => w.id === run.plan.wallet),
      auto =
        wallet?.policy.mode === 'autonomous' &&
        wallet.policy.chains.includes(run.plan.chain_id) &&
        (!wallet.policy.expiresAt || wallet.policy.expiresAt > Date.now());
    const permitted = wallet?.unlocked && auto;
    const state = !wallet?.unlocked ? t('leLocked') : !auto ? t('leAutoRequired') : t('leGranted');
    const canStart =
      supported &&
      permitted &&
      !run.pending &&
      ['paused', 'stopped'].includes(run.phase) &&
      !busy &&
      !stopping.has(run.plan.id);
    const confirmed = executionPercent(run.allocated_input_atoms, run.plan.total_input_atoms);
    const fee = view.feeUsage,
      budget = fee.budgetWei || '0',
      reserved = fee.reservedEstimateWei;
    const row = (label: string, value: string) =>
      '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
    node.innerHTML =
      '<header class="le-detail-head"><div><small>Base' +
      (run.plan.chain_id === 84532 ? ' Sepolia' : '') +
      ' · ' +
      esc(walletName(run.plan.wallet)) +
      '</small><h3>' +
      esc(title(run)) +
      '</h3></div><span class="le-status" data-phase="' +
      run.phase +
      '">' +
      esc(status(run.phase)) +
      '</span></header>' +
      '<p class="le-subtle">' +
      esc(t('leScope')) +
      '</p><div class="le-metrics">' +
      metric(
        t('leProgress'),
        amount(run, run.allocated_input_atoms),
        amount(run),
        unit(run),
        confirmed,
      ) +
      metric(
        t('leFees'),
        executionAmount(reserved, 18),
        executionAmount(budget, 18),
        'ETH',
        executionPercent(reserved, budget),
      ) +
      '</div>' +
      '<p class="le-subtle">' +
      esc(t('leFeeHint')) +
      '</p><dl class="le-facts">' +
      row(t('leSlices'), String(run.plan.slices)) +
      row(t('leInterval'), String(run.plan.interval_ms / 1000)) +
      row(t('leSlippage'), String(run.plan.slippage_bps / 100) + '%') +
      '</dl>' +
      (run.pending
        ? '<p class="le-notice">' +
          esc(run.phase === 'running' ? t('leFinality') : t('lePending')) +
          '</p>'
        : '') +
      '<p class="le-authority">' +
      esc(state) +
      '</p>' +
      (view.lastError ? '<p class="le-error">' + esc(status(view.lastError)) + '</p>' : '') +
      '<div class="le-run-actions">' +
      button('leStart', 'start', 'class="quant-primary" ' + (!canStart ? 'disabled' : '')) +
      button(
        stopping.has(run.plan.id) ? 'leStopBusy' : 'leStop',
        'stop',
        'class="le-stop" ' +
          (['completed', 'stopped'].includes(run.phase) || stopping.has(run.plan.id)
            ? 'disabled'
            : ''),
      ) +
      (run.pending ? button('leReconcile', 'reconcile', busy ? 'disabled' : '') : '') +
      button('leWallet', 'wallet') +
      '</div>' +
      '<section class="le-history"><header><h3>' +
      esc(t('leHistory')) +
      '</h3><span>' +
      String(history?.total ?? 0) +
      '</span></header>' +
      (history?.items.length
        ? history.items
            .map(
              (command) =>
                '<details data-command="' +
                esc(command.id) +
                '"><summary><span>' +
                command.ordinal +
                ' / ' +
                run.plan.slices +
                '</span><strong>' +
                esc(amount(run, command.input_atoms) + ' ' + unit(run)) +
                '</strong><span>' +
                esc(status(command.stage)) +
                '</span></summary>' +
                '<div class="le-command"><small>' +
                esc(time(command.updated_at_ns)) +
                '</small><p>' +
                esc(status(command.reason)) +
                '</p>' +
                command.hashes
                  .map((hash) => '<code title="' + esc(t('leHash')) + '">' + esc(hash) + '</code>')
                  .join('') +
                '</div></details>',
            )
            .join('')
        : '<p class="le-subtle">' + esc(t('leNoHistory')) + '</p>') +
      '<footer>' +
      button('lePrevious', 'history-previous', commandOffset === 0 ? 'disabled' : '') +
      button(
        'leNext',
        'history-next',
        history?.next === null || history?.next === undefined ? 'disabled' : '',
      ) +
      '</footer></section>';
    for (const details of node.querySelectorAll<HTMLDetailsElement>('details'))
      details.open = expanded.has(details.dataset.command);
    node.scrollTop = scroll;
  }
  async function refresh() {
    if (closed) return;
    if (refreshing) {
      pendingRefresh = true;
      return;
    }
    refreshing = true;
    const requestedOffset = offset;
    try {
      const [page, result] = await Promise.all([
        options.request('execution.list', { id: options.id, offset, limit: 20 }) as Promise<
          ExecutionPage<ExecutionRun>
        >,
        options.backend('wallet:request', 'list') as Promise<{ wallets: ExecutionWallet[] }>,
      ]);
      if (closed) return;
      if (requestedOffset !== offset) {
        pendingRefresh = true;
        return;
      }
      items = page.items;
      next = page.next;
      wallets = result.wallets;
      const newWalletKey = JSON.stringify(wallets.map((w) => [w.id, w.name, w.address]));
      if (walletKey !== newWalletKey && document.activeElement !== select) {
        const old = select.value;
        select.innerHTML = wallets
          .map(
            (w) =>
              '<option value="' +
              esc(w.id) +
              '">' +
              esc(w.name + ' · ' + w.address.slice(0, 8) + '…') +
              '</option>',
          )
          .join('');
        if (wallets.some((w) => w.id === old)) select.value = old;
        walletKey = newWalletKey;
      }
      if (!selected && items.length) selected = items[0]!.plan.id;
      if (selected) {
        const requestedSelection = selected;
        const requestedCommandOffset = commandOffset;
        const details = await Promise.all([
          options.request('execution.get', {
            id: options.id,
            runId: selected,
          }) as Promise<ExecutionView>,
          options.request('execution.commands', {
            id: options.id,
            runId: selected,
            offset: commandOffset,
            limit: 20,
          }) as Promise<ExecutionPage<ExecutionCommand>>,
        ]);
        if (requestedSelection !== selected || requestedCommandOffset !== commandOffset) {
          pendingRefresh = true;
          return;
        }
        [view, history] = details;
      }
      render();
    } catch (value) {
      error(value);
    } finally {
      refreshing = false;
      if (pendingRefresh && !closed) {
        pendingRefresh = false;
        void refresh();
      }
    }
  }
  dialog.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target || target.disabled) return;
    if (target.dataset.leRun) {
      selected = target.dataset.leRun;
      commandOffset = 0;
      view = undefined;
      renderKey = '';
      render();
      void refresh();
      return;
    }
    const action = target.dataset.le;
    if (action === 'close') {
      dialog.close();
      return;
    }
    if (action === 'wallet') {
      dialog.close();
      window.dispatchEvent(new CustomEvent('cibyp:quant-open-wallet'));
      return;
    }
    if (action === 'new') {
      form.hidden = false;
      form.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    if (action === 'cancel') {
      form.hidden = true;
      return;
    }
    if (action === 'refresh') {
      void refresh();
      return;
    }
    if (action === 'previous' || action === 'next') {
      offset = action === 'next' ? (next ?? offset) : Math.max(0, offset - 20);
      selected = '';
      void refresh();
      return;
    }
    if (action === 'history-previous' || action === 'history-next') {
      commandOffset =
        action === 'history-next'
          ? (history?.next ?? commandOffset)
          : Math.max(0, commandOffset - 20);
      void refresh();
      return;
    }
    if (!selected || !['start', 'stop', 'reconcile'].includes(action || '')) return;
    const id = view?.run.plan.id;
    if (!id) return;
    if (action === 'stop') stopping.add(id);
    else busy = true;
    renderKey = '';
    render();
    void options
      .request('execution.' + action, { id: options.id, runId: id })
      .then(() => {
        q('[data-le-error]').hidden = true;
      })
      .catch(error)
      .finally(() => {
        if (action !== 'stop') busy = false;
        stopping.delete(id);
        renderKey = '';
        void refresh();
      });
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(form),
      value = (name: string) => String(data.get(name) || '');
    const slip = /^(\d)(?:\.(\d{0,2}))?$/.exec(value('slippage'));
    const slippageBps = slip ? Number(slip[1]) * 100 + Number((slip[2] || '').padEnd(2, '0')) : NaN;
    if (!Number.isInteger(slippageBps) || slippageBps > 500) {
      error(t('leInvalid'));
      return;
    }
    busy = true;
    form.querySelector('fieldset')!.disabled = true;
    void options
      .request('execution.create', {
        id: options.id,
        operationId,
        walletId: value('walletId'),
        side: value('side'),
        totalInput: value('totalInput'),
        slices: Number(value('slices')),
        intervalMs: Number(value('seconds')) * 1000,
        slippageBps,
        maxEstimatedFeeEth: value('maxEstimatedFeeEth'),
      })
      .then((result) => {
        if (closed) return;
        selected = (result as ExecutionRun).plan.id;
        offset = 0;
        commandOffset = 0;
        operationId = crypto.randomUUID();
        form.hidden = true;
        q('[data-le-error]').hidden = true;
      })
      .catch(error)
      .finally(() => {
        busy = false;
        form.querySelector('fieldset')!.disabled = false;
        void refresh();
      });
  });
  const unsubscribe = options.subscribe((event) => {
    if (closed) return;
    if (
      [
        'wallet-changed',
        'quant-live-execution-changed',
        'quant-native-execution-changed',
        'quant-native-changed',
      ].includes(String(event.type))
    ) {
      if (!refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void refresh();
        }, 300);
    }
  });
  const ticker = setInterval(() => void refresh(), 3000);
  dialog.addEventListener(
    'close',
    () => {
      closed = true;
      clearInterval(ticker);
      clearTimeout(refreshTimer);
      if (typeof unsubscribe === 'function') unsubscribe();
      dialog.remove();
    },
    { once: true },
  );
  void refresh();
  return dialog;
}
