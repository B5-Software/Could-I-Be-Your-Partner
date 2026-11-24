/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
class EventDataBrowser {
  constructor(parent) {
    this.parent = parent;
  }
  t(key) {
    return this.parent.text(key);
  }
  async open(id, domain = 'recording', offset = 0) {
    const page = await this.parent.call(domain + '.list', { id, offset });
    const options = [
      { label: this.t('back'), value: 'back' },
      { label: this.t('qeRefresh'), value: 'refresh' },
      { label: this.t(domain === 'recording' ? 'qeReplays' : 'qeRecordings'), value: 'switch' },
    ];
    if (domain === 'recording') options.push({ label: this.t('qeRecord'), value: 'new' });
    options.push(
      ...page.items.map((v) => ({
        label:
          v.name +
          ' · ' +
          this.status(v.status) +
          (v.validationProgress ? ` · ${this.t('qeValidation')}` : ''),
        value: v.recordingId || v.replayId,
      })),
    );
    if (offset) options.push({ label: this.t('qePrevious'), value: 'previous' });
    if (page.next !== null) options.push({ label: this.t('qeNext'), value: 'next' });
    this.parent.menu(
      this.t('qeTitle'),
      options,
      async (value) => {
        if (value === 'back') return this.parent.project(id);
        if (value === 'refresh') return this.open(id, domain, offset);
        if (value === 'switch')
          return this.open(id, domain === 'recording' ? 'replay' : 'recording');
        if (value === 'next' || value === 'previous')
          return this.open(id, domain, value === 'next' ? page.next : Math.max(0, offset - 20));
        if (value === 'new') return this.create(id);
        return this.detail(id, domain, value);
      },
      this.t('qeHint'),
      () => this.parent.project(id),
    );
  }
  status(status) {
    return this.t(
      {
        recording: 'qeRecording',
        complete: 'qeComplete',
        running: 'qeRunning',
        failed: 'qeFailed',
        interrupted: 'qeInterrupted',
        cancelled: 'qeCancelled',
      }[status] || 'qeFailed',
    );
  }
  create(id) {
    const operationId = randomUUID();
    this.parent.chooseNativeMarket(
      'qeProduct',
      ({ product, venue }) =>
        this.parent.ui.input(
          this.t('qeName'),
          async (name) => {
            const result = await this.parent.call('recording.start', {
              id,
              operationId,
              product,
              venue,
              name,
            });
            return this.detail(id, 'recording', result.recordingId);
          },
          { value: product, back: () => this.open(id) },
        ),
      this.t('qeInitial'),
      () => this.open(id),
    );
  }
  async detail(id, domain, itemId) {
    const v = await this.parent.call(domain + '.get', {
      id,
      [domain === 'recording' ? 'recordingId' : 'replayId']: itemId,
    });
    const actions = ['back', 'qeRefresh'];
    if (domain === 'recording' && v.status === 'recording') actions.push('qeStop');
    if (domain === 'recording' && v.status === 'complete') actions.push('qeReplay');
    if (domain === 'recording' && v.status === 'complete' && v.endedMonoNs)
      actions.push('qeValidation');
    if (domain === 'replay' && v.status === 'running') actions.push('qeCancel');
    if (domain === 'replay' && v.status === 'complete' && !v.validation)
      actions.push('qeExecutions', 'qeOrders', 'qeDecisions');
    const folds = v.validation?.folds || [];
    const body = [
      ...(v.product ? [this.parent.nativeVenueLabel(v.venue) + ' / ' + v.product] : []),
      this.status(v.status),
      v.validationProgress
        ? `${this.t('qeStageProgress')} ${v.validationProgress.completed}/${v.validationProgress.total}`
        : this.t('qeEvents') + ': ' + (v.events ?? v.processed),
      ...(v.validation ? [this.t('qeValidationHint')] : []),
      ...(v.endedMonoNs ? [`${this.t('qeDurationMs')} ${BigInt(v.endedMonoNs) / 1000000n}`] : []),
      v.error || '',
      v.sha256 || v.planHash || '',
      ...(v.result
        ? [
            this.t('qeFees') + ': ' + v.result.run.stats.fees + ' ' + v.result.quoteCurrency,
            this.t('qeContribution') + ': ' + (v.result.tradeContribution ?? this.t('qeNoMark')),
            this.t('qeHash') + ': ' + v.result.journalSha256,
          ]
        : []),
      this.t('qeModel'),
    ].join('\n\n');
    this.parent.menu(
      v.name,
      [
        ...actions.map((value) => ({ label: this.t(value), value })),
        ...folds.map(({ fold, result }) => ({
          label: `${this.t('qeFold').replace('{n}', String(fold))} · v${result.revision} · ${result.tradeContribution} ${result.quoteCurrency}`,
          value: fold,
        })),
      ],
      async (action) => {
        if (typeof action === 'number') return this.validationFold(id, itemId, folds[action - 1]);
        if (action === 'back') return this.open(id, domain);
        if (action === 'qeRefresh') return this.detail(id, domain, itemId);
        if (action === 'qeStop')
          await this.parent.call('recording.stop', { id, recordingId: itemId });
        else if (action === 'qeCancel')
          await this.parent.call('replay.cancel', { id, replayId: itemId });
        else if (action === 'qeReplay') return this.replay(id, itemId);
        else if (action === 'qeValidation') return this.replay(id, itemId, 0, true);
        else
          return this.history(
            id,
            itemId,
            { qeExecutions: 'executions', qeOrders: 'orders', qeDecisions: 'decisions' }[action],
          );
        return this.detail(id, domain, itemId);
      },
      body,
      () => this.open(id, domain),
    );
  }
  async replay(id, recordingId, offset = 0, validation = false) {
    const page = await this.parent.call('native.strategy.list', { id, offset, limit: 20 }),
      operationId = randomUUID();
    const options = [
      { label: this.t('back'), value: 'back' },
      ...page.items
        .filter((v) => !validation || v.definition.revision >= 2)
        .map((v) => ({
          label: v.definition.name + ' · v' + v.definition.revision,
          value: v.definition.id,
        })),
    ];
    if (offset) options.push({ label: this.t('qePrevious'), value: 'previous' });
    if (page.next !== null) options.push({ label: this.t('qeNext'), value: 'next' });
    this.parent.menu(
      this.t('qeStrategy'),
      options,
      async (value) => {
        if (value === 'back') return this.detail(id, 'recording', recordingId);
        if (value === 'previous' || value === 'next')
          return this.replay(
            id,
            recordingId,
            value === 'next' ? page.next : Math.max(0, offset - 20),
            validation,
          );
        const version = page.items.find((v) => v.definition.id === value);
        if (validation) {
          const revision = version.definition.revision;
          const defaults = {
            qeRevisions: `${revision - 1}, ${revision}`,
            qeStartMs: 0,
            qeTrainMs: 60000,
            qeTestMs: 30000,
            qeFolds: 2,
          };
          return this.parent.fields(
            Object.keys(defaults),
            defaults,
            async (values) => {
              const job = await this.parent.call('replay.validate', {
                id,
                recordingId,
                strategyId: value,
                operationId,
                revisions: values.qeRevisions.split(/[,，]/).map((v) => Number(v.trim())),
                startMs: Number(values.qeStartMs),
                trainMs: Number(values.qeTrainMs),
                testMs: Number(values.qeTestMs),
                folds: Number(values.qeFolds),
              });
              return this.detail(id, 'replay', job.replayId);
            },
            () => this.replay(id, recordingId, offset, true),
          );
        }
        return this.parent.ui.input(
          this.t('qeRevision'),
          async (revision) => {
            const job = await this.parent.call('replay.start', {
              id,
              recordingId,
              strategyId: value,
              revision: Number(revision),
              operationId,
            });
            return this.detail(id, 'replay', job.replayId);
          },
          {
            value: String(version.definition.revision),
            back: () => this.replay(id, recordingId, offset),
          },
        );
      },
      this.t(validation ? 'qeValidationHint' : 'qeInitial'),
      () => this.detail(id, 'recording', recordingId),
    );
  }
  validationFold(id, replayId, window) {
    const back = () => this.detail(id, 'replay', replayId);
    const show = () => this.validationFold(id, replayId, window);
    const { fold, training, test, ranking, result } = window;
    const contribution = (row) =>
      `v${row.revision} · ${row.tradeContribution} ${row.quoteCurrency} · ${this.t('qeFees')} ${row.fees} · ${this.t('qeExecutions')} ${row.counts.executions}`;
    const span = (range) => `${range.startMs}–${range.endMs} ms`;
    const kinds = { qeExecutions: 'executions', qeOrders: 'orders', qeDecisions: 'decisions' };
    this.parent.menu(
      this.t('qeFold').replace('{n}', String(fold)),
      [
        { label: this.t('back'), value: 'back' },
        { label: `${this.t('qeTest')} · v${result.revision}`, value: 'test' },
        ...ranking.map((row) => ({
          label: `${this.t('qeTraining')} · v${row.revision}`,
          value: row.revision,
        })),
      ],
      (choice) => {
        if (choice === 'back') return back();
        return this.parent.menu(
          this.t('qeHistory'),
          [
            { label: this.t('back'), value: 'back' },
            ...Object.keys(kinds).map((value) => ({ label: this.t(value), value })),
          ],
          (kind) =>
            kind === 'back'
              ? show()
              : this.history(
                  id,
                  replayId,
                  kinds[kind],
                  0,
                  { fold, ...(choice !== 'test' && { trainingRevision: choice }) },
                  show,
                ),
          '',
          show,
        );
      },
      `${this.t('qeTest')} · ${span(test)}\n${contribution(result)}\n\n${this.t('qeTraining')} · ${span(training)}\n${ranking.map(contribution).join('\n')}`,
      back,
    );
  }
  async history(
    id,
    replayId,
    kind,
    offset = 0,
    stage = {},
    back = () => this.detail(id, 'replay', replayId),
  ) {
    const page = await this.parent.call('replay.history', {
      id,
      replayId,
      kind,
      ...stage,
      offset,
      limit: 15,
    });
    const body =
      page.items
        .map((v) => {
          const actions =
            v.intents || (v.request ? [v.request] : v.fill ? [{ ...v.fill, side: v.side }] : []);
          return (
            actions
              .map(
                (a) =>
                  this.t(a.side === 'buy' ? 'qeBuy' : 'qeSell') +
                  ' ' +
                  a.quantity +
                  ' @ ' +
                  a.price,
              )
              .join(' / ') +
            ' · ' +
            (v.fees || v.status || '')
          );
        })
        .join('\n') || this.t('qeEmpty');
    const options = [{ label: this.t('back'), value: 'back' }];
    if (offset) options.push({ label: this.t('qePrevious'), value: 'previous' });
    if (page.next !== null) options.push({ label: this.t('qeNext'), value: 'next' });
    this.parent.menu(
      this.t('qeHistory'),
      options,
      (value) =>
        value === 'back'
          ? back()
          : this.history(
              id,
              replayId,
              kind,
              value === 'next' ? page.next : Math.max(0, offset - 15),
              stage,
              back,
            ),
      body,
      back,
    );
  }
}
module.exports = { EventDataBrowser };
