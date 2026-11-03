/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/quant-strategy-labels.json';
import type {
  NativeStrategyVersion,
  NativeStrategyRun,
  NativeStrategyDecision,
} from '../../shared/quant-strategy-types';
import { openNativePaper } from './quant-native-paper';
type Key = keyof typeof labels.zh;
type Options = {
  id: string;
  language: () => string;
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => unknown;
};
type Page<T> = { items: T[]; total: number | null; next: number | null; connected?: boolean };
type View = {
  connected: boolean;
  definitionsPage: Page<NativeStrategyVersion>;
  selected: NativeStrategyVersion | null;
  runsPage: Page<NativeStrategyRun>;
  decisionsPage: Page<NativeStrategyDecision>;
};
const escape = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const fields = [
  ['quantity', 'nsQuantity', '0.001'],
  ['bidOffsetTicks', 'nsBidOffset', 0],
  ['askOffsetTicks', 'nsAskOffset', 0],
  ['repriceTicks', 'nsReprice', 1],
  ['refreshMs', 'nsRefreshMs', 1000],
  ['ttlMs', 'nsTtl', 15000],
  ['minInventory', 'nsMinInventory', '0'],
  ['maxInventory', 'nsMaxInventory', '10'],
  ['maxNotional', 'nsMaxNotional', '10000'],
  ['maxFees', 'nsMaxFees', '50'],
  ['maxDecisions', 'nsMaxDecisions', 1000],
] as const;
const nativeKeys = [
  'quantity',
  'bid_offset_ticks',
  'ask_offset_ticks',
  'reprice_ticks',
  'refresh_ms',
  'ttl_ms',
  'min_inventory',
  'max_inventory',
  'max_notional',
  'max_fees',
  'max_decisions',
] as const;
export function openStrategies(options: Options): void {
  const t = (k: Key) =>
    labels[
      options.language().startsWith('de') ? 'de' : options.language().startsWith('en') ? 'en' : 'zh'
    ][k];
  const button = (k: Key, action: string) =>
    '<button type="button" data-ns="' + action + '">' + escape(t(k)) + '</button>';
  const dialog = document.createElement('dialog');
  dialog.className = 'quant-dialog quant-strategy-dialog';
  dialog.innerHTML =
    '<header><div><h2>' +
    escape(t('nsTitle')) +
    '</h2><p>' +
    escape(t('nsHint')) +
    '</p></div>' +
    button('nsClose', 'close') +
    '</header><p class="quant-hint">' +
    escape(t('nsScope')) +
    '</p><p data-ns-error role="alert" hidden></p><div class="ns-toolbar">' +
    button('nsConnect', 'connect') +
    button('nsAccount', 'account') +
    button('nsNew', 'new') +
    button('nsRefresh', 'refresh') +
    '</div><div class="ns-layout"><aside><div data-ns-list></div><footer>' +
    button('nsPrevious', 'list-previous') +
    button('nsNext', 'list-next') +
    '</footer></aside><main><section data-ns-editor hidden></section><section data-ns-detail></section><section data-ns-run></section><section class="ns-decisions"><h3>' +
    escape(t('nsDecisions')) +
    '</h3><div data-ns-decisions></div><footer>' +
    button('nsPrevious', 'decisions-previous') +
    button('nsNext', 'decisions-next') +
    '</footer></section></main></div>';
  document.body.append(dialog);
  dialog.showModal();
  const el = <T extends HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  const call = <T = unknown>(action: string, input: Record<string, unknown> = {}) =>
    options.request(action === 'native.start' ? action : 'native.strategy.' + action, {
      ...input,
      id: options.id,
    }) as Promise<T>;
  let selected = '',
    version: NativeStrategyVersion | undefined,
    run: NativeStrategyRun | undefined,
    offset = 0,
    next: number | null = null,
    decisionOffset = 0,
    decisionNext: number | null = null,
    refreshing = false,
    again = false,
    busy = false,
    closed = false,
    detailSignature = '',
    editVersion: NativeStrategyVersion | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined,
    operation = crypto.randomUUID();
  const startIds = new Map<string, string>();
  const error = (e: unknown) => {
    if (closed) return;
    el('[data-ns-error]').textContent = e instanceof Error ? e.message : String(e);
    el('[data-ns-error]').hidden = false;
  };
  const phase = (p: string) =>
    t(
      p === 'running'
        ? 'nsRunning'
        : p === 'paused'
          ? 'nsPaused'
          : p === 'completed'
            ? 'nsCompleted'
            : 'nsStopped',
    );
  const when = (v: string) => {
    try {
      return new Date(Number(BigInt(v) / 1000000n)).toLocaleString();
    } catch {
      return '—';
    }
  };
  const refresh = async () => {
    if (closed) return;
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      const requestedSelection = selected,
        requestedOffset = offset;
      const snapshot = await call<View>('view', { strategyId: selected, offset, decisionOffset });
      if (closed) return;
      if (requestedSelection !== selected || requestedOffset !== offset) {
        again = true;
        return;
      }
      const list = { ...snapshot.definitionsPage, connected: snapshot.connected };
      next = list.next;
      el<HTMLButtonElement>('[data-ns=new]').disabled = list.connected === false || busy;
      el<HTMLButtonElement>('[data-ns=connect]').disabled = list.connected !== false || busy;
      if (!selected && list.items.length) selected = list.items[0]!.definition.id;
      const requested = selected;
      const html =
        list.items
          .map(
            (v) =>
              '<button type="button" data-ns-select="' +
              escape(v.definition.id) +
              '" aria-current="' +
              String(v.definition.id === selected) +
              '"><strong>' +
              escape(v.definition.name) +
              '</strong><small>' +
              escape(v.definition.instrument.split(':')[1]) +
              ' · v' +
              v.definition.revision +
              '</small></button>',
          )
          .join('') ||
        '<p>' + escape(t(list.connected === false ? 'nsNoNative' : 'nsNoStrategies')) + '</p>';
      el('[data-ns-list]').innerHTML = html;
      el<HTMLButtonElement>('[data-ns=list-previous]').disabled = offset === 0;
      el<HTMLButtonElement>('[data-ns=list-next]').disabled = next === null;
      if (list.connected === false) {
        el('[data-ns-detail]').textContent = t('nsNoNative');
        el('[data-ns-run]').textContent = '';
        el('[data-ns-decisions]').textContent = '';
        detailSignature = '';
        return;
      }
      if (!selected) return;
      const value = snapshot.selected!;
      if (closed) return;
      if (requested !== selected) {
        again = true;
        return;
      }
      version = value;
      const d = value.definition;
      const signature = d.id + ':' + d.revision;
      const previousMode = el<HTMLSelectElement>('[data-ns-mode]')?.value ?? 'shadow';
      if (detailSignature !== signature) {
        el('[data-ns-detail]').innerHTML =
          '<header><div><h3>' +
          escape(d.name) +
          ' · v' +
          d.revision +
          '</h3><small title="' +
          escape(value.hash) +
          '">' +
          escape(d.instrument.split(':')[1]) +
          ' · ' +
          escape(d.account.slice(-6)) +
          ' · ' +
          escape(value.hash.slice(0, 12)) +
          '</small></div>' +
          button('nsEdit', 'edit') +
          button('nsVersions', 'versions') +
          '</header><div class="ns-start-controls"><label>' +
          escape(t('nsStart')) +
          '<select data-ns-mode><option value="shadow">' +
          escape(t('nsShadow')) +
          '</option><option value="paper">' +
          escape(t('nsPaper')) +
          '</option></select></label>' +
          button('nsStart', 'start') +
          '</div>';
        detailSignature = signature;
        el<HTMLSelectElement>('[data-ns-mode]').value = previousMode;
      }
      const runs = snapshot.runsPage;
      if (closed) return;
      if (requested !== selected) {
        again = true;
        return;
      }
      const previousRun = run?.run.id;
      run = runs.items.find((r) => r.phase === 'running') || runs.items[0];
      if (previousRun !== run?.run.id) {
        if (decisionOffset !== 0) again = true;
        decisionOffset = 0;
      }
      el<HTMLButtonElement>('[data-ns=start]').disabled =
        busy || runs.items.some((r) => r.phase === 'running');
      el('[data-ns-run]').innerHTML = run
        ? '<header><div><h3>' +
          escape(t('nsCurrent')) +
          ' · ' +
          escape(phase(run.phase)) +
          '</h3><small>' +
          escape(t('nsPinned')) +
          ' v' +
          run.run.revision +
          ' · ' +
          escape(t(run.run.mode === 'shadow' ? 'nsShadow' : 'nsPaper')) +
          ' · ' +
          escape(run.run.id.slice(-10)) +
          '</small></div>' +
          button('nsStop', 'stop') +
          '</header><p class="quant-hint">' +
          escape(t('nsReason')) +
          ': ' +
          escape(run.reason) +
          '</p><div class="ns-stats">' +
          [
            ['nsGross', run.stats.gross_filled],
            ['nsOpenNotional', run.stats.open_notional],
            ['nsFees', run.stats.fees],
            ['nsOrders', run.stats.orders],
            ['nsDecisions', run.run.decisions],
          ]
            .map(
              ([key, value]) =>
                '<article><span>' +
                escape(t(key as Key)) +
                '</span><strong>' +
                escape(value) +
                '</strong></article>',
            )
            .join('') +
          '</div>'
        : '<p>' + escape(t('nsNoRuns')) + '</p>';
      if (run) {
        el<HTMLButtonElement>('[data-ns=stop]').disabled = busy || run.phase === 'stopped';
        const page = snapshot.decisionsPage;
        if (closed) return;
        if (requested !== selected) {
          again = true;
          return;
        }
        decisionNext = page.next;
        el('[data-ns-decisions]').innerHTML = page.items.length
          ? '<table><thead><tr><th>' +
            escape(t('nsTime')) +
            '</th><th>' +
            escape(t('nsIntent')) +
            '</th><th>' +
            escape(t('nsResult')) +
            '</th></tr></thead><tbody>' +
            page.items
              .map(
                (p) =>
                  '<tr><td>' +
                  escape(when(p.at_ns)) +
                  '<small>#' +
                  p.ordinal +
                  '</small></td><td>' +
                  p.intents
                    .map(
                      (i) =>
                        escape(t(i.side === 'buy' ? 'nsBuy' : 'nsSell')) +
                        ' ' +
                        escape(i.quantity) +
                        ' @ ' +
                        escape(i.price),
                    )
                    .join('<br>') +
                  '</td><td>' +
                  p.intents
                    .map((i) => {
                      const outcome = p.outcomes.find((o) => o.order_id === i.id);
                      return (
                        escape(
                          outcome
                            ? t(
                                outcome.status === 'shadow'
                                  ? 'nsShadow'
                                  : outcome.status === 'accepted'
                                    ? 'nsAccepted'
                                    : 'nsRejected',
                              )
                            : t('nsUnconfirmed'),
                        ) + (outcome?.error ? '<small>' + escape(outcome.error) + '</small>' : '')
                      );
                    })
                    .join('<br>') +
                  '</td></tr>',
              )
              .join('') +
            '</tbody></table>'
          : '<p>' + escape(t('nsNoDecisions')) + '</p>';
      } else {
        decisionNext = null;
        el('[data-ns-decisions]').textContent = t('nsNoDecisions');
      }
      el<HTMLButtonElement>('[data-ns=decisions-previous]').disabled = decisionOffset === 0;
      el<HTMLButtonElement>('[data-ns=decisions-next]').disabled = decisionNext === null;
    } catch (e) {
      error(e);
    } finally {
      refreshing = false;
      if (again && !closed) {
        again = false;
        void refresh();
      }
    }
  };
  const work = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    el('[data-ns-error]').hidden = true;
    dialog.setAttribute('aria-busy', 'true');
    try {
      await fn();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      dialog.removeAttribute('aria-busy');
      void refresh();
    }
  };
  const editor = (current?: NativeStrategyVersion) => {
    editVersion = current;
    operation = crypto.randomUUID();
    const d = current?.definition,
      m = d?.maker;
    el('[data-ns-editor]').hidden = false;
    el('[data-ns-editor]').innerHTML =
      '<form><h3>' +
      escape(t(current ? 'nsEdit' : 'nsNew')) +
      '</h3><div class="ns-fields"><label>' +
      escape(t('nsName')) +
      '<input name="name" maxlength="80" value="' +
      escape(d?.name || 'Maker') +
      '" required></label><label>' +
      escape(t('nsProduct')) +
      '<select name="product">' +
      ['ETH-USD', 'BTC-USD', 'SOL-USD']
        .map(
          (p) =>
            '<option' +
            (p === (d?.instrument.split(':')[1] || 'ETH-USD') ? ' selected' : '') +
            '>' +
            p +
            '</option>',
        )
        .join('') +
      '</select></label><label>' +
      escape(t('nsSides')) +
      '<select name="sides">' +
      (['both', 'buy', 'sell'] as const)
        .map(
          (s) =>
            '<option value="' +
            s +
            '"' +
            (s === (m?.sides || 'both') ? ' selected' : '') +
            '>' +
            escape(t(s === 'both' ? 'nsBoth' : s === 'buy' ? 'nsBuy' : 'nsSell')) +
            '</option>',
        )
        .join('') +
      '</select></label></div><h4>' +
      escape(t('nsTiming')) +
      '</h4><div class="ns-fields">' +
      fields
        .map(
          ([name, key, initial], index) =>
            '<label>' +
            escape(t(key)) +
            '<input name="' +
            name +
            '" value="' +
            escape(m?.[nativeKeys[index]!] ?? initial) +
            '" ' +
            (typeof initial === 'number'
              ? 'type="number" step="1" min="0"'
              : 'inputmode="decimal"') +
            ' required></label>',
        )
        .join('') +
      '</div><footer><button type="submit" class="quant-primary">' +
      escape(t('nsSave')) +
      '</button>' +
      button('nsBack', 'cancel-edit') +
      '</footer></form>';
  };
  dialog.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const data = new FormData(event.target),
      v = (name: string) => String(data.get(name) || '');
    const config: Record<string, string | number> = { sides: v('sides') };
    for (const [name, , initial] of fields)
      config[name] = typeof initial === 'number' ? Number(v(name)) : v(name);
    void work(async () => {
      const result = await call<NativeStrategyVersion>('define', {
        name: v('name'),
        product: v('product'),
        config,
        operationId: operation,
        ...(editVersion
          ? {
              strategyId: editVersion.definition.id,
              revision: editVersion.definition.revision + 1,
              accountId: editVersion.definition.account,
            }
          : {}),
      });
      selected = result.definition.id;
      el('[data-ns-editor]').hidden = true;
    });
  });
  dialog.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!target || target.disabled) return;
    if (target.dataset.nsSelect) {
      selected = target.dataset.nsSelect;
      decisionOffset = 0;
      void refresh();
      return;
    }
    const action = target.dataset.ns;
    if (action === 'close') return dialog.close();
    if (action === 'account') {
      openNativePaper(options);
      return;
    }
    if (action === 'new' || action === 'edit') {
      if (!busy) editor(action === 'edit' ? version : undefined);
      return;
    }
    if (action === 'cancel-edit') {
      el('[data-ns-editor]').hidden = true;
      return;
    }
    if (action === 'connect') {
      void work(() => call('native.start'));
      return;
    }
    if (action === 'refresh') {
      void refresh();
      return;
    }
    if (action === 'list-next' || action === 'list-previous') {
      offset = action === 'list-next' ? (next ?? offset) : Math.max(0, offset - 20);
      void refresh();
      return;
    }
    if (action === 'decisions-next' || action === 'decisions-previous') {
      decisionOffset =
        action === 'decisions-next'
          ? (decisionNext ?? decisionOffset)
          : Math.max(0, decisionOffset - 15);
      void refresh();
      return;
    }
    if (action === 'versions' && selected) {
      void work(async () => {
        const page = await call<Page<NativeStrategyVersion>>('versions', {
          strategyId: selected,
          limit: 100,
        });
        if (!closed) {
          const node = document.createElement('dialog');
          node.className = 'quant-dialog';
          node.innerHTML =
            '<header><h2>' +
            escape(t('nsVersions')) +
            '</h2><button type="button">' +
            escape(t('nsClose')) +
            '</button></header>' +
            page.items
              .map(
                (v) =>
                  '<p>v' +
                  v.definition.revision +
                  ' · ' +
                  escape(v.definition.name) +
                  '<small>' +
                  escape(v.hash) +
                  '</small></p>',
              )
              .join('');
          node.querySelector('button')!.onclick = () => node.close();
          node.addEventListener('close', () => node.remove(), { once: true });
          document.body.append(node);
          node.showModal();
        }
      });
      return;
    }
    if (action === 'start' && version) {
      const v = version,
        mode = el<HTMLSelectElement>('[data-ns-mode]').value,
        key = v.definition.id + ':' + v.definition.revision + ':' + mode;
      const id = startIds.get(key) || crypto.randomUUID();
      startIds.set(key, id);
      void work(async () => {
        await call('start', {
          strategyId: v.definition.id,
          revision: v.definition.revision,
          mode,
          operationId: id,
        });
        startIds.delete(key);
        decisionOffset = 0;
      });
      return;
    }
    if (action === 'stop' && run) {
      const id = run.run.id;
      void work(() => call('stop', { runId: id, cancelOrders: true }));
    }
  });
  const off = options.subscribe((event) => {
    if (
      closed ||
      timer ||
      ![
        'quant-native-strategies-changed',
        'quant-native-changed',
        'quant-market-source-changed',
        'quant-market-sources-changed',
      ].includes(String(event.type))
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
      if (typeof off === 'function') off();
      dialog.remove();
    },
    { once: true },
  );
  void refresh();
}
