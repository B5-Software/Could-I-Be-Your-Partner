/* SPDX-License-Identifier: GPL-3.0-or-later */
import labels from '../../shared/quant-event-labels.json';
import { openNativePaper } from './quant-native-paper';
import type { NativeStrategyVersion } from '../../shared/quant-strategy-types';
type Options = {
  id: string;
  language: () => string;
  request: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => unknown;
};
type Key = keyof typeof labels.zh;
type Page<T> = { items: T[]; total: number | null; next: number | null };
type Recording = {
  recordingId: string;
  name: string;
  product: string;
  status: string;
  events: number;
  sha256: string | null;
  error: string | null;
};
type Replay = {
  replayId: string;
  name: string;
  status: string;
  processed: number;
  eventErrors: number;
  error: string | null;
  planHash: string;
  configuration: { revision: number; recordingId: string; events: number };
  result?: {
    counts: Record<string, number>;
    run: { stats: { fees: string }; reason: string };
    tradeContribution: string | null;
    quoteCurrency: string;
    journalSha256: string;
  };
};
type History = {
  created_at_ns?: string;
  recorded_at_ns?: string;
  at_ns?: string;
  side?: string;
  fees?: string;
  status?: string;
  ordinal?: number;
  request?: { side: string; price: string; quantity: string };
  fill?: { price: string; quantity: string };
  intents?: { side: string; price: string; quantity: string }[];
};
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function openEventData(options: Options): void {
  const t = (key: Key) =>
    labels[
      options.language().startsWith('de') ? 'de' : options.language().startsWith('en') ? 'en' : 'zh'
    ][key];
  const b = (key: Key, action: string) =>
    '<button type="button" class="' +
    (action === 'run' ? 'quant-primary' : '') +
    '" data-qe="' +
    action +
    '">' +
    esc(t(key)) +
    '</button>';
  const dialog = document.createElement('dialog');
  dialog.className = 'quant-dialog quant-event-dialog';
  dialog.innerHTML =
    '<header><div><h2>' +
    esc(t('qeTitle')) +
    '</h2><p>' +
    esc(t('qeHint')) +
    '</p></div>' +
    b('qeClose', 'close') +
    '</header><p role="alert" data-qe-error hidden></p><div class="qe-toolbar">' +
    b('qeAccount', 'account') +
    b('qeRefresh', 'refresh') +
    '</div><div class="qe-columns"><section><h3>' +
    esc(t('qeRecordings')) +
    '</h3><form data-qe-form><label>' +
    esc(t('qeName')) +
    '<input name="name" maxlength="80"></label><label>' +
    esc(t('qeProduct')) +
    '<select name="product">' +
    ['ETH-USD', 'BTC-USD', 'SOL-USD'].map((p) => '<option>' + p + '</option>').join('') +
    '</select></label><button type="submit" class="quant-primary">' +
    esc(t('qeRecord')) +
    '</button></form><div data-qe-recordings></div>' +
    b('qePrevious', 'record-prev') +
    b('qeNext', 'record-next') +
    '</section><section><h3>' +
    esc(t('qeReplays')) +
    '</h3><p data-qe-selected>' +
    esc(t('qeSelect')) +
    '</p><label>' +
    esc(t('qeStrategy')) +
    '<select data-qe-strategy></select></label><label>' +
    esc(t('qeRevision')) +
    '<input type="number" data-qe-revision min="1" step="1" value="1"></label><p class="quant-hint">' +
    esc(t('qeInitial')) +
    '</p>' +
    b('qeReplay', 'run') +
    '<div data-qe-replays></div>' +
    b('qePrevious', 'replay-prev') +
    b('qeNext', 'replay-next') +
    '</section></div><p class="quant-hint">' +
    esc(t('qeModel')) +
    '</p><section data-qe-result></section><section><h3>' +
    esc(t('qeHistory')) +
    '</h3><select data-qe-kind>' +
    (['executions', 'orders', 'decisions'] as const)
      .map(
        (kind, i) =>
          '<option value="' +
          kind +
          '">' +
          esc(t((['qeExecutions', 'qeOrders', 'qeDecisions'] as const)[i]!)) +
          '</option>',
      )
      .join('') +
    '</select><div data-qe-history></div>' +
    b('qePrevious', 'history-prev') +
    b('qeNext', 'history-next') +
    '</section>';
  document.body.append(dialog);
  dialog.showModal();
  const el = <T extends HTMLElement = HTMLElement>(q: string) => dialog.querySelector<T>(q)!;
  const call = <T>(action: string, input: Record<string, unknown> = {}) =>
    options.request(action, { ...input, id: options.id }) as Promise<T>;
  const state = (v: string) =>
    t(
      (
        {
          recording: 'qeRecording',
          complete: 'qeComplete',
          running: 'qeRunning',
          failed: 'qeFailed',
          interrupted: 'qeInterrupted',
          cancelled: 'qeCancelled',
        } as Record<string, Key>
      )[v] || 'qeFailed',
    );
  const orderState = (value: string) => {
    const key = (
      {
        cancelled: 'qeCancelled',
        filled: 'qeFilled',
        open: 'qeOpen',
        partially_filled: 'qePartial',
        partiallyfilled: 'qePartial',
      } as Record<string, Key>
    )[value];
    return key ? t(key) : value;
  };
  let closed = false,
    busy = false,
    refreshing = false,
    recordOffset = 0,
    replayOffset = 0,
    historyOffset = 0,
    recordNext: number | null = null,
    replayNext: number | null = null,
    historyNext: number | null = null,
    selectedRecord = '',
    selectedReplay = '',
    recordOp = crypto.randomUUID(),
    replayOp = crypto.randomUUID();
  let records: Recording[] = [],
    replays: Replay[] = [],
    versions: NativeStrategyVersion[] = [];
  const error = (e: unknown) => {
    el('[data-qe-error]').hidden = false;
    el('[data-qe-error]').textContent = e instanceof Error ? e.message : String(e);
  };
  const history = async () => {
    if (!selectedReplay) return;
    const kind = el<HTMLSelectElement>('[data-qe-kind]').value;
    const requestedReplay = selectedReplay,
      requestedOffset = historyOffset;
    const page = await call<Page<History>>('replay.history', {
      replayId: selectedReplay,
      kind,
      offset: historyOffset,
      limit: 20,
    });
    if (
      closed ||
      requestedReplay !== selectedReplay ||
      requestedOffset !== historyOffset ||
      kind !== el<HTMLSelectElement>('[data-qe-kind]').value
    )
      return;
    historyNext = page.next;
    el('[data-qe-history]').innerHTML =
      '<table><thead><tr><th>' +
      esc(t('qeTime')) +
      '</th><th>' +
      esc(t('qeDetails')) +
      '</th><th>' +
      esc(t('qeFees')) +
      '</th></tr></thead><tbody>' +
      page.items
        .map((row) => {
          const time = row.recorded_at_ns || row.created_at_ns || row.at_ns;
          const actions =
            row.intents ||
            (row.request ? [row.request] : row.fill ? [{ ...row.fill, side: row.side || '' }] : []);
          return (
            '<tr><td>' +
            esc(
              time ? new Date(Number(BigInt(time) / 1000000n)).toLocaleString() : '#' + row.ordinal,
            ) +
            '</td><td>' +
            actions
              .map(
                (a) =>
                  esc(t(a.side === 'buy' ? 'qeBuy' : 'qeSell')) +
                  ' ' +
                  esc(a.quantity) +
                  ' @ ' +
                  esc(a.price),
              )
              .join('<br>') +
            (row.status ? '<small>' + esc(orderState(row.status)) + '</small>' : '') +
            '</td><td>' +
            esc(row.fees || '—') +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table>';
    el<HTMLButtonElement>('[data-qe=history-prev]').disabled = historyOffset === 0;
    el<HTMLButtonElement>('[data-qe=history-next]').disabled = historyNext === null;
  };
  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    const viewKey = () => [recordOffset, replayOffset, selectedRecord, selectedReplay].join(':');
    const requestedView = viewKey();
    try {
      const [r, j, v] = await Promise.all([
        call<Page<Recording>>('recording.list', { offset: recordOffset }),
        call<Page<Replay>>('replay.list', { offset: replayOffset }),
        call<Page<NativeStrategyVersion>>('native.strategy.list', { limit: 100 }),
      ]);
      if (closed || viewKey() !== requestedView) return;
      records = r.items;
      replays = j.items;
      versions = v.items;
      recordNext = r.next;
      replayNext = j.next;
      const selected = records.find((r) => r.recordingId === selectedRecord);
      el('[data-qe-selected]').textContent = selected
        ? selected.name + ' · ' + selected.product
        : t('qeSelect');
      el('[data-qe-recordings]').innerHTML =
        records
          .map(
            (r) =>
              '<article class="qe-item" aria-current="' +
              (selectedRecord === r.recordingId) +
              '"><button type="button" data-qe-record="' +
              esc(r.recordingId) +
              '"><strong>' +
              esc(r.name) +
              '</strong><small>' +
              esc(r.product) +
              ' · ' +
              esc(state(r.status)) +
              ' · ' +
              esc(r.events) +
              ' ' +
              esc(t('qeEvents')) +
              '</small></button>' +
              (r.status === 'recording'
                ? '<button type="button" data-qe-stop="' +
                  esc(r.recordingId) +
                  '">' +
                  esc(t('qeStop')) +
                  '</button>'
                : '') +
              (r.error ? '<small>' + esc(r.error) + '</small>' : '') +
              '</article>',
          )
          .join('') || '<p>' + esc(t('qeEmpty')) + '</p>';
      const previous = el<HTMLSelectElement>('[data-qe-strategy]').value;
      const choices = versions
        .map(
          (v) =>
            '<option value="' +
            v.definition.id +
            '">' +
            esc(v.definition.name) +
            ' · v' +
            v.definition.revision +
            '</option>',
        )
        .join('');
      if (el('[data-qe-strategy]').innerHTML !== choices) {
        el('[data-qe-strategy]').innerHTML = choices;
        if (versions.some((v) => v.definition.id === previous))
          el<HTMLSelectElement>('[data-qe-strategy]').value = previous;
      }
      const chosen = versions.find(
          (v) => v.definition.id === el<HTMLSelectElement>('[data-qe-strategy]').value,
        ),
        revisionInput = el<HTMLInputElement>('[data-qe-revision]');
      if (chosen) {
        revisionInput.max = String(chosen.definition.revision);
        if (revisionInput.dataset.strategy !== chosen.definition.id) {
          revisionInput.dataset.strategy = chosen.definition.id;
          revisionInput.value = String(chosen.definition.revision);
        }
      }
      el<HTMLButtonElement>('[data-qe=run]').disabled =
        !selected ||
        selected.status !== 'complete' ||
        !versions.length ||
        replays.some((j) => j.status === 'running') ||
        busy;
      el('[data-qe-replays]').innerHTML =
        replays
          .map(
            (j) =>
              '<article class="qe-item"><button type="button" data-qe-replay="' +
              esc(j.replayId) +
              '"><strong>' +
              esc(j.name) +
              '</strong><small>' +
              esc(state(j.status)) +
              ' · ' +
              esc(j.processed) +
              ' ' +
              esc(t('qeEvents')) +
              '</small></button>' +
              (j.status === 'running'
                ? '<button type="button" data-qe-cancel="' +
                  esc(j.replayId) +
                  '">' +
                  esc(t('qeCancel')) +
                  '</button>'
                : '') +
              '</article>',
          )
          .join('') || '<p>' + esc(t('qeEmpty')) + '</p>';
      el<HTMLButtonElement>('[data-qe=record-prev]').disabled = recordOffset === 0;
      el<HTMLButtonElement>('[data-qe=record-next]').disabled = recordNext === null;
      el<HTMLButtonElement>('[data-qe=replay-prev]').disabled = replayOffset === 0;
      el<HTMLButtonElement>('[data-qe=replay-next]').disabled = replayNext === null;
      if (selectedReplay) {
        const job = await call<Replay>('replay.get', { replayId: selectedReplay });
        if (closed || viewKey() !== requestedView) return;
        const result = job.result;
        el('[data-qe-result]').innerHTML =
          '<h3>' +
          esc(job.name) +
          '</h3><p>' +
          esc(state(job.status)) +
          (job.error ? ' · ' + esc(job.error) : '') +
          '</p><label>' +
          esc(t('qeEvents')) +
          ' ' +
          esc(job.processed) +
          '<progress value="' +
          esc(job.processed) +
          '" max="' +
          Math.max(1, job.configuration.events) +
          '"></progress></label><div class="qe-metrics">' +
          (result
            ? [
                ['qeOrders', result.counts.orders],
                ['qeExecutions', result.counts.executions],
                ['qeDecisions', result.counts.decisions],
                ['qeErrors', job.eventErrors],
                ['qeFees', result.run.stats.fees + ' ' + result.quoteCurrency],
                [
                  'qeContribution',
                  result.tradeContribution === null
                    ? t('qeNoMark')
                    : result.tradeContribution + ' ' + result.quoteCurrency,
                ],
              ]
                .map(
                  ([key, value]) =>
                    '<div><small>' +
                    esc(t(key as Key)) +
                    '</small><strong>' +
                    esc(value) +
                    '</strong></div>',
                )
                .join('')
            : '') +
          '</div><details><summary>' +
          esc(t('qeVerify')) +
          '</summary><p>' +
          esc(t('qePlanHash')) +
          '<code>' +
          esc(job.planHash) +
          '</code></p>' +
          (result
            ? '<p>' +
              esc(
                result.run.reason === 'USER_STARTED'
                  ? t('qeEnded')
                  : result.run.reason === 'FRESH_BOOK_REQUIRED'
                    ? t('qeStale')
                    : result.run.reason,
              ) +
              '</p><p>' +
              esc(t('qeHash')) +
              '<code>' +
              esc(result.journalSha256) +
              '</code></p>'
            : '') +
          '</details>';
        if (job.status === 'complete') await history();
        else el('[data-qe-history]').textContent = '';
      }
    } catch (e) {
      error(e);
    } finally {
      refreshing = false;
      if (!closed && viewKey() !== requestedView) void refresh();
    }
  };
  const work = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    el('[data-qe-error]').hidden = true;
    try {
      await fn();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      void refresh();
    }
  };
  dialog.addEventListener('submit', (event) => {
    event.preventDefault();
    void work(async () => {
      const form = el<HTMLFormElement>('[data-qe-form]'),
        data = new FormData(form);
      const result = await call<Recording>('recording.start', {
        name: data.get('name'),
        product: data.get('product'),
        operationId: recordOp,
      });
      recordOp = crypto.randomUUID();
      selectedRecord = result.recordingId;
      recordOffset = 0;
    });
  });
  dialog.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.qeRecord) {
      selectedRecord = button.dataset.qeRecord;
      void refresh();
      return;
    }
    if (button.dataset.qeReplay) {
      selectedReplay = button.dataset.qeReplay;
      historyOffset = 0;
      void refresh();
      return;
    }
    if (button.dataset.qeStop) {
      void work(() => call('recording.stop', { recordingId: button.dataset.qeStop }));
      return;
    }
    if (button.dataset.qeCancel) {
      void work(() => call('replay.cancel', { replayId: button.dataset.qeCancel }));
      return;
    }
    const action = button.dataset.qe;
    if (action === 'close') {
      dialog.close();
      return;
    }
    if (action === 'account') {
      openNativePaper(options);
      return;
    }
    if (action === 'run') {
      void work(async () => {
        const version = versions.find(
          (v) => v.definition.id === el<HTMLSelectElement>('[data-qe-strategy]').value,
        );
        if (!version) return;
        const revision = el<HTMLInputElement>('[data-qe-revision]');
        if (!revision.reportValidity()) return;
        const job = await call<Replay>('replay.start', {
          recordingId: selectedRecord,
          strategyId: version.definition.id,
          revision: Number(revision.value),
          operationId: replayOp,
        });
        replayOp = crypto.randomUUID();
        selectedReplay = job.replayId;
        replayOffset = 0;
        historyOffset = 0;
      });
      return;
    }
    if (action === 'record-prev') recordOffset = Math.max(0, recordOffset - 20);
    if (action === 'record-next' && recordNext !== null) recordOffset = recordNext;
    if (action === 'replay-prev') replayOffset = Math.max(0, replayOffset - 20);
    if (action === 'replay-next' && replayNext !== null) replayOffset = replayNext;
    if (action === 'history-prev') historyOffset = Math.max(0, historyOffset - 20);
    if (action === 'history-next' && historyNext !== null) historyOffset = historyNext;
    void refresh();
  });
  el('[data-qe-kind]').addEventListener('change', () => {
    historyOffset = 0;
    void history().catch(error);
  });
  el('[data-qe-strategy]').addEventListener('change', () => {
    el<HTMLInputElement>('[data-qe-revision]').dataset.strategy = '';
    void refresh();
  });
  const timer = setInterval(() => void refresh(), 1500);
  dialog.addEventListener(
    'close',
    () => {
      closed = true;
      clearInterval(timer);
      dialog.remove();
    },
    { once: true },
  );
  void refresh();
}
