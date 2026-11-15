/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { createHash } = require('node:crypto');
const { NativeEngine } = require('./native-engine');
const { amount, decimal } = require('./coinbase-stream');
const { fail, digest, identity, write, read, lines, page } = require('./event-files');
const safeError = (e) =>
  /^[A-Z][A-Z_0-9]{1,80}$/.test(e?.message || '') ? e.message : 'REPLAY_FAILED';
const signed = (n) => (n < 0n ? '-' : '') + decimal(n < 0n ? -n : n);
const ms = 1000000n;
const signedAtoms = (value) => (value.startsWith('-') ? -amount(value.slice(1)) : amount(value));
function validationParameters(input) {
  const { revisions, trainMs, testMs, folds, startMs = 0 } = input;
  if (
    !Array.isArray(revisions) ||
    revisions.length < 2 ||
    revisions.length > 4 ||
    new Set(revisions).size !== revisions.length ||
    revisions.some((n) => !Number.isInteger(n) || n < 1 || n > 1000) ||
    !Number.isInteger(folds) ||
    folds < 1 ||
    folds > 4 ||
    !Number.isSafeInteger(startMs) ||
    startMs < 0 ||
    ![trainMs, testMs].every((n) => Number.isSafeInteger(n) && n >= 500) ||
    startMs + trainMs + testMs * folds > 21600000
  )
    fail('REPLAY_VALIDATION_PARAMETERS');
  return { revisions: [...revisions].sort((a, b) => a - b), trainMs, testMs, folds, startMs };
}

class EventReplay {
  constructor(service) {
    this.service = service;
    this.directory = path.join(service.directory, 'replays');
    this.jobs = new Map();
    this.unpersisted = new Map();
    this.queue = Promise.resolve();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const item of this.listAll())
      if (['running', 'queued'].includes(item.status))
        this.persist({ ...item, status: 'interrupted', error: 'REPLAY_INTERRUPTED' });
  }
  folder(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('REPLAY_ID_INVALID');
    return path.join(this.directory, id);
  }
  persist(value) {
    write(path.join(this.folder(value.replayId), 'manifest.json'), value);
    return value;
  }
  listAll() {
    return fs
      .readdirSync(this.directory)
      .filter((id) => /^[a-f0-9]{64}$/.test(id))
      .map((id) => read(path.join(this.folder(id), 'manifest.json')));
  }
  get(replayId, owner, full = false) {
    const value =
      this.jobs.get(replayId)?.value ||
      this.unpersisted.get(replayId) ||
      read(path.join(this.folder(replayId), 'manifest.json'));
    if (value.owner !== owner) fail('REPLAY_SCOPE_MISMATCH');
    return this.view(value, full);
  }
  view(value, full = false, summary = false) {
    if (
      (value.plan.validation || value.validation) &&
      (!value.plan.validation ||
        !value.validation ||
        value.planHash !== digest(value.plan) ||
        value.validationHash !== digest(value.validation))
    )
      fail('REPLAY_VALIDATION_HASH_MISMATCH');
    if (full) return structuredClone(value);
    const { plan, validation, ...state } = value;
    return structuredClone({
      ...state,
      ...(!summary && validation && { validation }),
      configuration: {
        recordingId: plan.recording.recordingId,
        events: plan.recording.events,
        recordingHash: plan.recording.sha256,
        strategyId: plan.version.definition.id,
        revision: plan.version.definition.revision,
        strategyHash: plan.version.hash,
        engineSha256: plan.engineSha256,
        assets: plan.assets,
        risk: plan.risk,
        latencyMs: plan.latencyMs,
        schedulerMs: plan.schedulerMs,
        cancelLatencyMs: plan.cancelLatencyMs,
        timing: plan.timing,
        ...(plan.validation && { validation: plan.validation }),
      },
    });
  }
  changed(value) {
    try {
      this.service.publish({
        type: 'quant-replays-changed',
        id: value.owner,
        replayId: value.replayId,
      });
    } catch {}
  }
  async request(action, input) {
    this.service.workspace(input.id);
    if (action === 'list')
      return page(
        this.listAll()
          .filter((v) => v.owner === input.id)
          .map((v) =>
            this.view(
              this.jobs.get(v.replayId)?.value || this.unpersisted.get(v.replayId) || v,
              false,
              true,
            ),
          )
          .sort((a, b) => b.createdAt - a.createdAt),
        input,
      );
    if (action === 'get') {
      this.get(input.replayId, input.id);
      const waitMs = input.waitMs ?? 0;
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) fail('INVALID_WAIT');
      const job = this.jobs.get(input.replayId);
      if (job && waitMs) {
        let timer, abortListener;
        const wake = new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
          if (input.signal) {
            abortListener = () => resolve();
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener('abort', abortListener, { once: true });
          }
        });
        try {
          await Promise.race([job.done, wake]);
        } finally {
          clearTimeout(timer);
          if (abortListener) input.signal.removeEventListener('abort', abortListener);
        }
      }
      return this.get(input.replayId, input.id);
    }
    if (action === 'plan') {
      if (!['lineage', 'instruments', 'accounts'].includes(input.section))
        fail('INVALID_HISTORY_KIND');
      return page(this.get(input.replayId, input.id, true).plan[input.section], input);
    }
    if (action === 'history') return this.history(input);
    if (action === 'cancel') {
      const value = this.get(input.replayId, input.id),
        job = this.jobs.get(input.replayId);
      if (job) {
        job.cancelled = true;
        job.engine?.dispose();
      }
      return { ...value, cancelRequested: Boolean(job) };
    }
    if (action !== 'start' && action !== 'validate') fail('UNKNOWN_REPLAY_ACTION');
    const validation = action === 'validate' ? validationParameters(input) : undefined;
    const task = this.queue.then(() => this.start(input, validation));
    this.queue = task.catch(() => {});
    return task;
  }
  async start(input, validation) {
    const replayId = identity(input.id, input.operationId),
      file = path.join(this.folder(replayId), 'manifest.json');
    if (fs.existsSync(file)) {
      const old = this.get(replayId, input.id, true);
      if (
        old.plan.recording.recordingId !== input.recordingId ||
        old.plan.version.definition.id !== input.strategyId ||
        digest(old.plan.validation ?? null) !== digest(validation ?? null) ||
        (!validation &&
          input.revision !== undefined &&
          old.plan.version.definition.revision !== input.revision) ||
        (input.assets && digest(old.plan.assets) !== digest(input.assets))
      )
        fail('REPLAY_OPERATION_CONFLICT');
      return this.view(old);
    }
    if (this.jobs.size) fail('REPLAY_BUSY');
    const recording = await this.service.recordings.verify(input.recordingId, input.id);
    if (validation) {
      const end = validation.startMs + validation.trainMs + validation.testMs * validation.folds;
      const stages = (validation.revisions.length + 1) * validation.folds;
      if (!recording.endedMonoNs || BigInt(recording.endedMonoNs) < BigInt(end) * ms)
        fail('REPLAY_VALIDATION_COVERAGE');
      if (
        recording.events * stages > 500000 ||
        recording.bytes > 32 * 1024 * 1024 ||
        end * stages > 86400000
      )
        fail('REPLAY_VALIDATION_LIMIT');
    }
    const version = await this.service.nativeStrategies.request('get', {
      id: input.id,
      strategyId: input.strategyId,
      revision: validation ? validation.revisions.at(-1) : input.revision,
    });
    const d = version.definition;
    if (d.instrument !== recording.instrument.id) fail('REPLAY_INSTRUMENT_MISMATCH');
    const account = await this.service.native.call('account.get', { id: d.account });
    const assets =
      input.assets ||
      Object.fromEntries(Object.entries(account.assets).map(([key, v]) => [key, v.available]));
    if (
      !assets ||
      typeof assets !== 'object' ||
      Array.isArray(assets) ||
      !Object.keys(assets).length ||
      Object.keys(assets).length > 16
    )
      fail('REPLAY_ASSETS_INVALID');
    const normalized = {};
    for (const [asset, value] of Object.entries(assets)) {
      if (!/^[\w:.-]{1,128}$/.test(asset)) fail('REPLAY_ASSETS_INVALID');
      normalized[asset] = decimal(amount(value));
    }
    const executable = this.service.native.resolve();
    const lineage = [];
    let lineageOffset = 0;
    do {
      const versions = await this.service.nativeStrategies.request('versions', {
        id: input.id,
        strategyId: d.id,
        offset: lineageOffset,
        limit: 100,
      });
      lineage.push(...versions.items.filter((v) => v.definition.revision <= d.revision));
      lineageOffset = versions.next;
    } while (lineageOffset !== null && lineage.length < d.revision);
    if (lineage.length !== d.revision) fail('REPLAY_STRATEGY_LINEAGE_MISSING');
    if (
      validation &&
      validation.revisions.some(
        (revision) =>
          !lineage.some(
            ({ definition }) =>
              definition.revision === revision &&
              definition.account === d.account &&
              definition.instrument === d.instrument,
          ),
      )
    )
      fail('REPLAY_VALIDATION_STRATEGY_MISMATCH');
    const instruments = [],
      accounts = [];
    for (const instrumentId of new Set(lineage.map((v) => v.definition.instrument)))
      instruments.push(await this.service.native.call('instrument.get', { id: instrumentId }));
    for (const accountId of new Set(lineage.map((v) => v.definition.account))) {
      const a = await this.service.native.call('account.get', { id: accountId });
      accounts.push({
        id: a.id,
        name: 'Replay account',
        risk: a.risk,
        assets: accountId === d.account ? normalized : {},
      });
    }
    const plan = {
      schemaVersion: 1,
      recording,
      versionedStrategy: version.hash,
      version,
      lineage,
      instruments,
      accounts,
      assets: normalized,
      risk: account.risk,
      engineSha256: executable.sha256,
      model: 'conservative-l2-fifo',
      latencyMs: 500,
      schedulerMs: 50,
      cancelLatencyMs: 0,
      timing: 'recorded-host-adapter-input',
      marketImpact: false,
      ...(validation && { validation }),
    };
    const value = {
      version: 1,
      replayId,
      owner: input.id,
      name: recording.name + ' · ' + d.name + (validation ? '' : ' v' + d.revision),
      status: 'running',
      createdAt: Date.now(),
      plan,
      planHash: digest(plan),
      processed: 0,
      eventErrors: 0,
      errorSamples: [],
      error: null,
      liveExecution: false,
    };
    if (validation) {
      value.validation = {
        folds: [],
        score: 'trade-contribution-net-of-execution-fees',
        accountMode: 'independent-fixed-opening-assets',
      };
      value.validationHash = digest(value.validation);
      value.validationProgress = {
        completed: 0,
        total: validation.folds * (validation.revisions.length + 1),
      };
    }
    this.persist(value);
    const job = { value, cancelled: false, engine: null };
    this.jobs.set(replayId, job);
    this.changed(value);
    job.done = (validation ? this.runValidation(job, executable) : this.run(job, executable))
      .catch((error) => {
        value.status = job.cancelled ? 'cancelled' : 'failed';
        value.error = job.cancelled ? 'REPLAY_CANCELLED' : safeError(error);
        value.endedAt = Date.now();
        try {
          this.persist(value);
        } catch {
          value.error = 'REPLAY_STORAGE_FAILED';
          this.unpersisted.set(replayId, value);
          if (this.unpersisted.size > 16)
            this.unpersisted.delete(this.unpersisted.keys().next().value);
        }
      })
      .finally(async () => {
        await this.close(job.engine);
        this.jobs.delete(replayId);
        this.changed(value);
      });
    return this.view(value);
  }
  async close(engine) {
    if (!engine) return;
    await engine.stop().catch(() => engine.dispose());
    const end = Date.now() + 5500;
    while (engine.child && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (engine.child) engine.fail(engine.child, 'REPLAY_SHUTDOWN_TIMEOUT');
  }
  async run(job, executable) {
    const { value } = job;
    value.result = await this.simulate(
      job,
      executable,
      value.plan,
      this.folder(value.replayId),
      value,
    );
    value.status = 'complete';
    value.endedAt = Date.now();
    this.persist(value);
  }
  async runValidation(job, executable) {
    const { value } = job;
    const { validation, lineage } = value.plan;
    const folder = this.folder(value.replayId);
    const run = async (phase, fold, revision, window) => {
      this.checkJob(job);
      Object.assign(value.validationProgress, { phase, fold, revision });
      this.changed(value);
      const stage = phase === 'training' ? `train-${fold}-${revision}` : `test-${fold}`;
      const plan = {
        ...value.plan,
        version: lineage.find((v) => v.definition.revision === revision),
        lineage: lineage.filter((v) => v.definition.revision <= revision),
      };
      const evidence = { processed: 0, eventErrors: 0, errorSamples: [] };
      const result = await this.simulate(
        job,
        executable,
        plan,
        path.join(folder, stage),
        evidence,
        window,
      );
      value.processed += evidence.processed;
      value.eventErrors += evidence.eventErrors;
      value.errorSamples.push(
        ...evidence.errorSamples
          .slice(0, 20 - value.errorSamples.length)
          .map((row) => ({ ...row, phase, fold, revision })),
      );
      if (result.tradeContribution === null || evidence.eventErrors)
        fail('REPLAY_VALIDATION_INELIGIBLE_WINDOW');
      value.validationProgress.completed++;
      return {
        revision,
        strategyHash: plan.version.hash,
        processed: evidence.processed,
        fees: result.run.stats.fees,
        counts: result.counts,
        markPrice: result.markPrice,
        tradeContribution: result.tradeContribution,
        quoteCurrency: result.quoteCurrency,
        reason: result.run.reason,
        journalSha256: result.journalSha256,
        historyHashes: result.historyHashes,
        finalAssets: Object.fromEntries(
          Object.entries(result.finalAccount.assets).map(([asset, balance]) => [
            asset,
            balance.total,
          ]),
        ),
      };
    };
    for (let i = 0; i < validation.folds; i++) {
      const fold = i + 1;
      const startMs = validation.startMs + i * validation.testMs;
      const split = startMs + validation.trainMs;
      const training = { startMs, endMs: split };
      const test = { startMs: split, endMs: split + validation.testMs };
      const ranking = [];
      for (const revision of validation.revisions)
        ranking.push(await run('training', fold, revision, training));
      ranking.sort((a, b) => {
        const score = signedAtoms(b.tradeContribution) - signedAtoms(a.tradeContribution);
        if (score) return score > 0n ? 1 : -1;
        const feeDifference = amount(a.fees) - amount(b.fees);
        return feeDifference ? (feeDifference < 0n ? -1 : 1) : a.revision - b.revision;
      });
      const result = await run('test', fold, ranking[0].revision, test);
      this.checkJob(job);
      value.validation.folds.push({ fold, training, test, ranking, result });
      value.validationHash = digest(value.validation);
      this.persist(value);
      this.changed(value);
    }
    value.status = 'complete';
    value.endedAt = Date.now();
    this.persist(value);
  }
  checkJob(job) {
    if (job.cancelled || this.service.disposed) fail('REPLAY_CANCELLED');
  }
  async simulate(job, executable, plan, folder, evidence, window) {
    const d = plan.version.definition;
    const engine = (job.engine = new NativeEngine({
      directory: path.join(folder, 'native'),
      binaryPath: executable.binary,
      replay: true,
    }));
    if (engine.resolve().sha256 !== plan.engineSha256) fail('REPLAY_ENGINE_CHANGED');
    await engine.start();
    for (const instrument of plan.instruments) await engine.call('instrument.register', instrument);
    for (const account of plan.accounts) await engine.call('account.create', account);
    await engine.call('account.enable', { id: d.account });
    for (const version of plan.lineage) await engine.call('strategy.define', version.definition);
    const start = BigInt(window?.startMs ?? 0) * ms;
    const end = window ? BigInt(window.endMs) * ms : null;
    let mono = 0n,
      wall = 0n,
      first = true,
      started = false,
      scanned = 0,
      lastProgress = 0;
    const advance = async (target, targetWall, event) => {
      while (target - mono > 60000000000n) {
        this.checkJob(job);
        mono += 60000000000n;
        wall += 60000000000n;
        await engine.replayStep({ mono_ns: mono.toString(), wall_ns: wall.toString() });
      }
      this.checkJob(job);
      const response = await engine.replayStep({
        mono_ns: target.toString(),
        wall_ns: targetWall.toString(),
        ...(event && { event }),
      });
      mono = target;
      wall = targetWall;
      return response;
    };
    const startStrategy = async () => {
      await engine.call('strategy.start', {
        run_id: 'run:replay',
        id: d.id,
        revision: d.revision,
        mode: 'paper',
      });
      started = true;
      await advance(mono, wall);
    };
    const hash = createHash('sha256');
    for await (const bytes of lines(
      path.join(this.service.recordings.folder(plan.recording.recordingId), 'events.jsonl'),
    )) {
      this.checkJob(job);
      scanned++;
      hash.update(bytes);
      const row = JSON.parse(bytes),
        target = BigInt(row.mono_ns),
        targetWall = BigInt(row.wall_ns);
      // Hash the entire recording, but never send a later event to a window's engine.
      if (end !== null && target >= end) continue;
      if (!first && !started && target >= start) {
        await advance(start, target === start ? targetWall : wall + start - mono);
        await startStrategy();
      }
      const result = await advance(target, targetWall, { method: row.method, params: row.params });
      if (result.event?.ok === false) {
        evidence.eventErrors++;
        if (evidence.errorSamples.length < 20)
          evidence.errorSamples.push({ sequence: row.sequence, error: result.event.error });
      }
      if (first) {
        if (result.event?.ok !== true) fail('REPLAY_INITIAL_BOOK_INVALID');
        if (!start) await startStrategy();
        first = false;
      }
      if (target >= start) evidence.processed++;
      if (!window && Date.now() - lastProgress > 500) {
        lastProgress = Date.now();
        this.changed(job.value);
      }
    }
    if (first || scanned !== plan.recording.events || hash.digest('hex') !== plan.recording.sha256)
      fail('RECORDING_CHANGED_DURING_REPLAY');
    if (end !== null) {
      if (!started || !evidence.processed) fail('REPLAY_VALIDATION_EMPTY_WINDOW');
      await advance(end - 1n, wall + end - 1n - mono);
    } else if (plan.recording.endedMonoNs) {
      await advance(BigInt(plan.recording.endedMonoNs), BigInt(plan.recording.endedWallNs));
    }
    const finalBook = await engine.call('book', { id: d.instrument });
    const runBeforeStop = (await engine.call('strategy.runs', { run: 'run:replay' })).items[0];
    await engine.call('strategy.stop', { run_id: 'run:replay', cancel: true });
    const finalAccount = await engine.call('account.get', { id: d.account });
    const counts = {},
      historyHashes = {};
    for (const kind of ['orders', 'executions', 'decisions']) {
      const saved = await this.dump(engine, folder, kind, d);
      counts[kind] = saved.total;
      historyHashes[kind] = saved.sha256;
    }
    const bid = finalBook.bids[0]?.[0],
      ask = finalBook.asks[0]?.[0],
      scale = 10n ** 18n;
    let mark = null,
      contribution = null;
    if (finalBook.eligible && bid && ask) {
      mark = (amount(bid) + amount(ask)) / 2n;
      const base = plan.recording.instrument.base,
        quote = plan.recording.instrument.quote;
      const changeBase =
        amount(finalAccount.assets[base]?.total || '0') - amount(plan.assets[base] || '0');
      const changeQuote =
        amount(finalAccount.assets[quote]?.total || '0') - amount(plan.assets[quote] || '0');
      contribution = signed(changeQuote + (changeBase * mark) / scale);
    }
    const result = {
      run: runBeforeStop,
      counts,
      historyHashes,
      finalAccount,
      markPrice: mark === null ? null : decimal(mark),
      markSource: 'last eligible book midpoint; not executable',
      tradeContribution: contribution,
      quoteCurrency: plan.recording.instrument.quote,
      finalBook: {
        valid: finalBook.valid,
        eligible: finalBook.eligible,
        sourceTimeNs: finalBook.sourceTimeNs,
      },
      limitations: [
        'L2 same-price FIFO estimate',
        '500ms arrival latency',
        'instant paper cancellations',
        'no market impact',
        'host adapter input timestamps; not exact live processing replay',
      ],
    };
    this.checkJob(job);
    await this.close(engine);
    job.engine = null;
    const wal = path.join(folder, 'native/events.jsonl'),
      journalHash = createHash('sha256');
    for await (const bytes of fs.createReadStream(wal)) journalHash.update(bytes);
    result.journalSha256 = journalHash.digest('hex');
    this.checkJob(job);
    return result;
  }
  async dump(engine, folder, kind, definition) {
    const fd = await fs.promises.open(path.join(folder, kind + '.jsonl'), 'wx', 0o600);
    const hash = createHash('sha256');
    let offset = 0,
      total = 0;
    try {
      do {
        const method = kind === 'decisions' ? 'strategy.decisions' : kind;
        const q = kind === 'decisions' ? { run: 'run:replay' } : { strategy: definition.id };
        const result = await engine.call(method, { ...q, offset, limit: 100 });
        total = result.total;
        if (total > 100000) fail('REPLAY_REPORT_LIMIT');
        const text = result.items.map((row) => JSON.stringify(row) + '\n').join('');
        hash.update(text);
        await fd.writeFile(text);
        offset = result.next;
      } while (offset !== null);
      await fd.sync();
    } finally {
      await fd.close();
    }
    return { total, sha256: hash.digest('hex') };
  }
  async history(input) {
    const value = this.get(input.replayId, input.id);
    if (!['orders', 'executions', 'decisions'].includes(input.kind)) fail('INVALID_HISTORY_KIND');
    let folder = this.folder(input.replayId);
    let result = value.result;
    if (value.validation) {
      if (
        !Number.isInteger(input.fold) ||
        (input.trainingRevision !== undefined && !Number.isInteger(input.trainingRevision))
      )
        fail('REPLAY_VALIDATION_FOLD');
      const window = value.validation.folds[input.fold - 1];
      if (!window) fail('REPLAY_REPORT_NOT_READY');
      if (input.trainingRevision === undefined) {
        result = window.result;
        folder = path.join(folder, `test-${window.fold}`);
      } else {
        result = window.ranking.find((candidate) => candidate.revision === input.trainingRevision);
        if (!result) fail('REPLAY_VALIDATION_FOLD');
        folder = path.join(folder, `train-${window.fold}-${result.revision}`);
      }
    } else if (value.status !== 'complete') fail('REPLAY_REPORT_NOT_READY');
    const { offset = 0, limit = 20 } = input;
    page([], input);
    const items = [],
      hash = createHash('sha256');
    let count = 0;
    for await (const bytes of lines(path.join(folder, input.kind + '.jsonl'))) {
      hash.update(bytes);
      if (count >= offset && items.length < limit) items.push(JSON.parse(bytes));
      count++;
    }
    if (
      hash.digest('hex') !== result.historyHashes[input.kind] ||
      count !== result.counts[input.kind]
    )
      fail('REPLAY_HISTORY_HASH_MISMATCH');
    const total = result.counts[input.kind];
    return { items, total, next: offset + limit < total ? offset + limit : null };
  }
  dispose() {
    for (const job of this.jobs.values()) {
      job.cancelled = true;
      job.engine?.dispose();
    }
  }
}
module.exports = { EventReplay };
