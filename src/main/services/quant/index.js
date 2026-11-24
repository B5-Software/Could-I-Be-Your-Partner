/* SPDX-License-Identifier: GPL-3.0-or-later */
/* global CIBYP_QUANT_WORKER_SOURCE */
'use strict';
const panelLimits = require('../../../shared/quant-layout-preferences.json');
const {
  venues: spotVenues,
  products: spotProducts,
} = require('../../../shared/quant-native-venues.json');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const {
  MarketData,
  CHAINS,
  INTERVALS,
  intervalsForVenue,
  KRAKEN_OHLC_SOURCE,
  endpoint,
} = require('./market-data');
const { discoverTokens } = require('./token-discovery');
const {
  readArchive: readKrakenArchive,
  SOURCE: KRAKEN_ARCHIVE_SOURCE,
} = require('./kraken-archive');
const { validateCandles, parameters } = require('./backtest');
const { VERSION: WALK_FORWARD_VERSION, walkForwardParameters } = require('./walk-forward');
const { SCALE, atoms, decimal, notional, fee } = require('./decimal');
const { NativeEngine } = require('./native-engine');
const { SOURCE: BASE_HISTORY_SOURCE, captureHistory, captureWindow } = require('./base-history');
const { BaseHistoryRecorder } = require('./base-history-recorder');
const { SERIES_SOURCE, MAX_BYTES, buildSeries } = require('./base-history-series');
const {
  CODE_VERSION: AMM_REPLAY_VERSION,
  HISTORICAL_COST_VERSION,
  replayParameters,
  replayAmm,
} = require('./amm-replay');
const {
  CODE_VERSION: AMM_SCENARIO_VERSION,
  scenarioParameters,
  runScenario,
} = require('./amm-scenario');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idPattern = /^[a-z\d-]{1,80}$/i;
const copy = (value) => structuredClone(value);
const problem = (message) => {
  throw new Error(message);
};
const venues = [...Object.keys(CHAINS), ...spotVenues.map(({ id }) => id)];
const freshSample = (quote, now) => {
  const age = now - quote.time * 1000;
  return age >= -2000 && age < 30000 && now - quote.observedAt < 30000;
};

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) problem('QUANT_STORAGE_LIMIT');
  const temporary = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function parseImport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 6 * 1024 * 1024)
    problem('IMPORT_SIZE_LIMIT');
  if (text.trim().startsWith('[')) return validateCandles(JSON.parse(text.trim()));
  const lines = text
    .trim()
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  const columns = lines
    .shift()
    .split(',')
    .map((v) => v.trim().toLowerCase());
  if (
    !['time', 'open', 'high', 'low', 'close'].every((v) => columns.includes(v)) ||
    new Set(columns).size !== columns.length
  )
    problem('CSV_HEADERS_REQUIRED');
  return validateCandles(
    lines
      .filter((line) => line.trim())
      .map((line) => {
        const cells = line.split(',');
        if (cells.length !== columns.length) problem('CSV_COLUMN_COUNT');
        const row = Object.fromEntries(columns.map((name, i) => [name, cells[i].trim()]));
        row.time = /^\d+$/.test(row.time) ? Number(row.time) : Date.parse(row.time) / 1000;
        return row;
      }),
  );
}
function riskConfig(input = {}) {
  const integer = (value, fallback, maximum) => {
    value ??= fallback;
    if (!Number.isInteger(value) || value < 0 || value > maximum) problem('INVALID_RISK');
    return value;
  };
  return {
    maxOrder: decimal(atoms(input.maxOrder ?? '1000', true)),
    maxExposure: decimal(atoms(input.maxExposure ?? '5000', true)),
    maxPosition: decimal(atoms(input.maxPosition ?? '10', true)),
    feeBps: integer(input.feeBps, 10, 1000),
    slippageBps: integer(input.slippageBps, 5, 1000),
  };
}
const openOrders = (w) => w.orders.filter((order) => order.status === 'open');
function reserved(w) {
  let cash = 0n,
    position = 0n,
    buyQuantity = 0n;
  for (const order of openOrders(w)) {
    if (order.side === 'buy') {
      cash += atoms(order.reserved);
      buyQuantity += atoms(order.quantity);
    } else position += atoms(order.quantity);
  }
  return { cash, position, buyQuantity };
}
function fill(w, order, price, time) {
  const quantity = atoms(order.quantity),
    buying = order.side === 'buy';
  const value = buying ? notional(price, quantity) : (price * quantity) / SCALE;
  const costs = fee(value, w.risk.feeBps);
  const cash = atoms(w.paper.cash),
    position = atoms(w.paper.position);
  if ((buying && cash < value + costs) || (!buying && position < quantity))
    problem('PAPER_BALANCE_INVARIANT');
  w.paper.cash = decimal(cash + (buying ? -value - costs : value - costs));
  w.paper.position = decimal(position + (buying ? quantity : -quantity));
  w.paper.fees = decimal(atoms(w.paper.fees) + costs);
  Object.assign(order, {
    status: 'filled',
    fillPrice: decimal(price),
    fee: decimal(costs),
    filledAt: time,
  });
}
function event(w, type, details = {}) {
  w.audit.push({ id: randomUUID(), time: Date.now(), type, ...details });
  w.updatedAt = Date.now();
}

class QuantService {
  constructor({
    directory,
    runtime,
    publish = () => {},
    fetcher,
    getWallet,
    nativeOptions,
    researchOptions,
    sourceOptions,
  } = {}) {
    if (!directory) problem('QUANT_STORAGE_UNAVAILABLE');
    this.directory = directory;
    this.runtime = runtime;
    this.publish = publish;
    this.native = new NativeEngine({
      directory: path.join(directory, 'native'),
      publish: (event) => {
        this.nativeMarkets?.nativeChanged(event);
        this.liveExecution?.nativeChanged(event);
        publish(event);
      },
      ...nativeOptions,
    });
    this.getWallet = getWallet;
    this.market = new MarketData(fetcher);
    this.nativeMarkets = new (require('./native-markets').NativeMarkets)({
      engine: this.native,
      market: this.market,
      publish,
      sourceOptions,
    });
    this.research = new (require('./research').QuantResearch)(this, researchOptions);
    this.questions = new (require('./questions').QuantQuestions)(this, writeAtomic);
    this.nativePaper = new (require('./native-paper').NativePaper)(this);
    this.nativeStrategies = new (require('./native-strategies').NativeStrategies)(this);
    this.recordings = new (require('./event-recordings').EventRecordings)(this);
    this.replays = new (require('./event-replay').EventReplay)(this);
    this.queue = Promise.resolve();
    this.refreshing = new Map();
    this.baseCaptures = new Map();
    this.baseSeriesReads = new Set();
    this.chatOpening = new Map();
    this.workers = new Set();
    this.runningTests = new Set();
    this.krakenArchiveFlights = new Map();
    this.disposed = false;
    this.file = path.join(directory, 'state.json');
    this.state = { version: 1, revision: 0, workspaces: [] };
    if (fs.existsSync(this.file)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        problem('QUANT_STORE_CORRUPT');
      }
      if (
        this.state.version !== 1 ||
        !Array.isArray(this.state.workspaces) ||
        !Number.isSafeInteger(this.state.revision) ||
        this.state.workspaces.some(
          (w) => !idPattern.test(w.id) || !Array.isArray(w.orders) || !Array.isArray(w.audit),
        )
      )
        problem('QUANT_STORE_CORRUPT');
      let recovered = false;
      for (const w of this.state.workspaces) {
        if (w.paper.status === 'running' || openOrders(w).length) {
          recovered = true;
          w.paper.status = 'paused';
          for (const order of openOrders(w))
            Object.assign(order, {
              status: 'cancelled',
              reason: 'paper-restart',
              cancelledAt: Date.now(),
            });
          event(w, 'recovery-paused', { reason: 'paper-orders-cancelled-no-offline-fill-assumed' });
        }
      }
      if (recovered) {
        this.state.revision++;
        writeAtomic(this.file, this.state);
      }
    }
    this.baseRecorder = new BaseHistoryRecorder(this, event);
    this.baseRecorder.arm();
  }
  execution() {
    return (this.liveExecution ??= new (require('./live-execution').LiveExecution)(this));
  }
  exchange() {
    return (this.exchangeOrders ??= new (require('./exchange-orders').ExchangeOrders)(
      this,
      writeAtomic,
    ));
  }
  workspace(id, state = this.state) {
    if (typeof id !== 'string' || !idPattern.test(id)) problem('INVALID_WORKSPACE');
    return state.workspaces.find((w) => w.id === id) || problem('QUANT_WORKSPACE_NOT_FOUND');
  }
  writeResearch(file, snapshot) {
    writeAtomic(file, snapshot);
  }
  summary(w) {
    return {
      id: w.id,
      name: w.name,
      venue: w.market.venue,
      product: w.market.product,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      paperStatus: w.paper.status,
      archived: w.archived || false,
    };
  }
  snapshot(w) {
    const value = copy(w),
      reserves = reserved(w);
    value.market.customRpc = Boolean(value.market.rpcUrl);
    value.market.intervals = intervalsForVenue(w.market.venue);
    delete value.market.rpcUrl;
    delete value.commands;
    delete value.baseRecorder;
    const chain = CHAINS[w.market.venue];
    if (chain)
      value.network = {
        id: chain.id,
        name: chain.name,
        explorer: chain.explorer,
        historyWindow: captureWindow(w.market.interval),
        recorder: this.baseRecorder.status(w),
        tokens: {
          WETH: { address: chain.weth, decimals: 18 },
          USDC: { address: chain.usdc, decimals: 6 },
        },
        uniswapV3: {
          factory: chain.factory,
          ...require('./base-swap').deployments[w.market.venue],
        },
      };
    value.orders = value.orders.slice(-100).reverse();
    value.audit = value.audit.slice(-100).reverse();
    value.runs = value.runs.slice(-100).reverse();
    value.research = (value.research || []).slice(-25).reverse();
    value.researchCount = w.research?.length || 0;
    value.orderCount = w.orders.length;
    value.auditCount = w.audit.length;
    value.runCount = w.runs.length;
    value.paper.availableCash = decimal(atoms(w.paper.cash) - reserves.cash);
    value.paper.availablePosition = decimal(atoms(w.paper.position) - reserves.position);
    value.paper.reservedCash = decimal(reserves.cash);
    value.paper.equity = w.quote
      ? decimal(atoms(w.paper.cash) + (atoms(w.paper.position) * atoms(w.quote.price)) / SCALE)
      : w.paper.cash;
    value.capabilities = {
      live: Boolean(this.getWallet) && w.market.venue !== 'kraken',
      walletSigning: Boolean(this.getWallet),
      candleBacktest: true,
      krakenArchive: w.market.venue === 'kraken',
      paper: true,
      baseRpc: Boolean(CHAINS[w.market.venue]),
      newsResearch: true,
      researchEvidenceArchive: true,
      execution: 'research-and-snapshot-paper',
      paperFillModel: 'snapshot-crossing-full-fill-no-queue',
      nativeHftEngine: false,
    };
    return value;
  }
  mutate(fn) {
    const task = this.queue.then(() => {
      if (this.disposed) problem('QUANT_STOPPED');
      const next = copy(this.state),
        value = fn(next);
      next.revision++;
      writeAtomic(this.file, next); // Publish only after the state/receipts are durable.
      this.state = next;
      try {
        this.publish({ type: 'quant-changed', revision: next.revision });
      } catch {
        /* Observers cannot roll back a durable commit. */
      }
      this.arm();
      this.baseRecorder.arm();
      return copy(value);
    });
    this.queue = task.catch(() => {});
    return task;
  }
  arm() {
    if (
      this.timer ||
      this.disposed ||
      !this.state.workspaces.some((w) => w.paper.status === 'running' || openOrders(w).length)
    )
      return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await Promise.allSettled(
        this.state.workspaces
          .filter((w) => w.paper.status === 'running' || openOrders(w).length)
          .map((w) => this.refresh(w.id)),
      );
      this.arm();
    }, 6000);
    this.timer.unref?.();
  }
  async refresh(id) {
    const w = this.workspace(id);
    const previous = this.refreshing.get(id);
    if (previous && previous.revision === w.marketRevision) return previous.task;
    previous?.controller.abort(new Error('MARKET_CHANGED'));
    if (w.quote && !w.lastError && Date.now() - w.quote.observedAt < 4000) return this.snapshot(w);
    const config = copy(w.market),
      revision = w.marketRevision;
    const controller = new AbortController();
    const flight = { controller, revision, task: null };
    const kraken = config.venue === 'kraken';
    const now = Date.now(),
      intervalMs = config.interval * 1000,
      fetchedAt = w.historyFetchedAt || 0;
    const history = kraken
      ? !fetchedAt ||
        !Number.isSafeInteger(w.historyOpenTime) ||
        (now - fetchedAt >= 10000 &&
          Math.floor(Math.max(now, (w.quote?.time || 0) * 1000) / intervalMs) * config.interval >
            w.historyOpenTime)
      : !w.candles.length || now - fetchedAt > intervalMs;
    flight.task = (async () => {
      try {
        const quote = await this.market.quote(config, history, {
          since: kraken ? w.candles.at(-1)?.time : undefined,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        return await this.mutate((state) => {
          const current = this.workspace(id, state);
          if (current.marketRevision !== revision) problem('MARKET_CHANGED');
          if (current.quote && quote.time < current.quote.time) problem('MARKET_TIME_REGRESSED');
          if (quote.time > Date.now() / 1000 + 120) problem('MARKET_CLOCK_SKEW');
          const historical = quote.candles.length > 0;
          const bars = new Map(current.candles.map((bar) => [bar.time, bar]));
          for (const bar of quote.candles) bars.set(bar.time, bar);
          if (kraken) {
            if (history) {
              if (quote.openCandleTime < (current.historyOpenTime || 0))
                problem('MARKET_TIME_REGRESSED');
              current.historyOpenTime = quote.openCandleTime;
              current.historyFetchedAt = quote.observedAt;
            }
          } else {
            const time = Math.floor(quote.time / config.interval) * config.interval;
            const price = Number(quote.price),
              last = bars.get(time);
            if (!last)
              bars.set(time, {
                time,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: 0,
              });
            else if (!historical)
              bars.set(time, {
                ...last,
                high: Math.max(last.high, price),
                low: Math.min(last.low, price),
                close: price,
              });
            if (historical) current.historyFetchedAt = Date.now();
          }
          let ordered = [...bars.values()].sort((a, b) => a.time - b.time);
          if (ordered.length > 2000) {
            const archive = this.storeDataset(
              current,
              ordered.slice(0, 1000),
              quote.quality,
              'Recorded · ' + new Date(ordered[0].time * 1000).toISOString(),
            );
            if (!current.datasets.some((dataset) => dataset.id === archive.id))
              current.datasets.push(archive);
            ordered = ordered.slice(1000);
            event(current, 'market-history-archived', { datasetId: archive.id });
          }
          current.candles = ordered;
          delete quote.candles;
          delete quote.openCandleTime;
          current.quote = quote;
          current.lastError = null;
          if (freshSample(quote, Date.now()))
            for (const order of openOrders(current)) {
              if (
                quote.time * 1000 <= order.createdAt ||
                quote.time <= (order.submittedQuoteTime ?? 0)
              )
                continue;
              const limit = atoms(order.limitPrice),
                mark = atoms(quote.price);
              if (
                (order.side === 'buy' && mark <= limit) ||
                (order.side === 'sell' && mark >= limit)
              ) {
                fill(current, order, limit, Date.now());
                event(current, 'paper-filled', { orderId: order.id });
              }
            }
          return this.snapshot(current);
        });
      } catch (error) {
        if (controller.signal.aborted || this.workspace(id).marketRevision !== revision)
          problem(controller.signal.aborted ? controller.signal.reason.message : 'MARKET_CHANGED');
        // Keep cached history visible, but a transport failure invalidates trading freshness.
        await this.mutate((state) => {
          const current = this.workspace(id, state);
          if (current.marketRevision === revision)
            current.lastError = { code: safeError(error), time: Date.now() };
        });
        throw new Error(safeError(error));
      }
    })().finally(() => {
      if (this.refreshing.get(id) === flight) this.refreshing.delete(id);
    });
    this.refreshing.set(id, flight);
    return flight.task;
  }
  storeDataset(w, candles, source, label, { amm, series, archive, market = w.market } = {}) {
    const coverage = amm || series;
    const data = {
      version: 1,
      market: { venue: market.venue, product: market.product, interval: market.interval },
      source,
      candles: coverage && !candles.length ? [] : validateCandles(candles),
      ...(amm && { amm }),
      ...(series && { series }),
      ...(archive && { archive }),
    };
    const id = hash(data);
    const file = path.join(this.directory, 'datasets', id + '.json');
    if (!fs.existsSync(file)) writeAtomic(file, data);
    return {
      id,
      label: String(label || source).slice(0, 120),
      source,
      market: data.market,
      count: data.candles.length,
      start: coverage?.startTime ?? data.candles[0].time,
      end: coverage?.endTime ?? data.candles.at(-1).time,
      createdAt: Date.now(),
      ...(archive && { archive }),
      ...(amm && {
        amm: {
          chainId: amm.chainId,
          fee: amm.fee,
          interval: amm.interval,
          swapCount: amm.swapCount,
        },
      }),
      ...(series && {
        series: {
          interval: series.interval,
          segmentCount: series.segments.length,
          gaps: series.gaps,
          slots: series.slots,
          requestedStart: series.requestedStart,
        },
      }),
    };
  }
  datasetFile(id) {
    if (!/^[a-f\d]{64}$/.test(String(id))) problem('INVALID_DATASET');
    return path.join(this.directory, 'datasets', id + '.json');
  }
  decodeDataset(id, bytes) {
    const data = JSON.parse(bytes.toString('utf8'));
    if (hash(data) !== id) problem('DATASET_HASH_MISMATCH');
    return data;
  }
  dataset(id) {
    return this.decodeDataset(id, fs.readFileSync(this.datasetFile(id)));
  }
  async captureKrakenArchive({ id, from, to, select }, signal) {
    const w = this.workspace(id);
    if (w.market.venue !== 'kraken') problem('KRAKEN_ARCHIVE_MARKET');
    if (this.krakenArchiveFlights.has(id) || this.krakenArchiveFlights.size >= 2)
      problem('RESEARCH_BUSY');
    const controller = new AbortController();
    const scopes = [controller.signal, AbortSignal.timeout(120000)];
    if (signal) scopes.push(signal);
    const combined = AbortSignal.any(scopes);
    const revision = w.marketRevision;
    this.krakenArchiveFlights.set(id, controller);
    try {
      const { candles, archive } = await readKrakenArchive(
        this.market.fetch,
        w.market,
        { from, to },
        combined,
      );
      return await this.mutate((state) => {
        combined.throwIfAborted();
        const current = this.workspace(id, state);
        if (current.marketRevision !== revision) problem('MARKET_CHANGED');
        const meta = this.storeDataset(
          current,
          candles,
          KRAKEN_ARCHIVE_SOURCE,
          'Kraken · ' + archive.entries.map((item) => item.quarter).join(' / '),
          { archive },
        );
        const existing = current.datasets.find((dataset) => dataset.id === meta.id);
        if (!existing) {
          current.datasets.push(meta);
          event(current, 'kraken-archive-captured', { datasetId: meta.id });
        }
        if (select === true) current.preferences.datasetId = meta.id;
        return existing || meta;
      });
    } finally {
      this.krakenArchiveFlights.delete(id);
    }
  }
  captureCandles(id, { label, select = false, signal } = {}) {
    return this.mutate((state) => {
      signal?.throwIfAborted();
      const w = this.workspace(id, state);
      const closed =
        w.market.venue === 'kraken'
          ? w.candles
          : w.candles.filter((bar) => (bar.time + w.market.interval) * 1000 <= Date.now());
      if (!closed.length) problem('NO_CLOSED_CANDLES');
      const source =
        w.market.venue === 'kraken' ? KRAKEN_OHLC_SOURCE : w.quote?.quality || 'unknown';
      const meta = this.storeDataset(w, closed, source, label || 'Market snapshot');
      const existing = w.datasets.find((item) => item.id === meta.id);
      if (!existing) w.datasets.push(meta);
      if (select) w.preferences.datasetId = meta.id;
      return existing || meta;
    });
  }
  switchKrakenCandles(w, previousMarket) {
    if (w.candles.length) {
      const label = 'Recorded · ' + new Date(w.candles[0].time * 1000).toISOString();
      const archive = this.storeDataset(w, w.candles, KRAKEN_OHLC_SOURCE, label, {
        market: previousMarket,
      });
      if (!w.datasets.some((dataset) => dataset.id === archive.id)) w.datasets.push(archive);
    }
    const latest = w.datasets
      .filter(
        (dataset) =>
          dataset.source === KRAKEN_OHLC_SOURCE &&
          dataset.market?.product === w.market.product &&
          dataset.market.interval === w.market.interval,
      )
      .sort((a, b) => b.end - a.end || b.createdAt - a.createdAt)[0];
    return latest ? this.dataset(latest.id).candles : [];
  }
  workspaceDataset(w, id) {
    if (!w.datasets.some((dataset) => dataset.id === id)) problem('DATASET_NOT_IN_WORKSPACE');
    return this.dataset(id);
  }
  archiveReader(w, signal) {
    const owned = new Set(w.datasets.map((dataset) => dataset.id));
    return async (id, remaining) => {
      signal.throwIfAborted();
      if (!owned.has(id)) problem('DATASET_NOT_IN_WORKSPACE');
      const file = this.datasetFile(id);
      try {
        if ((await fs.promises.stat(file)).size > Math.min(remaining, 32 * 1024 * 1024))
          problem('BASE_SERIES_READ_LIMIT');
        const buffer = await fs.promises.readFile(file, { signal });
        if (buffer.length > remaining) problem('BASE_SERIES_READ_LIMIT');
        return { data: this.decodeDataset(id, buffer), bytes: buffer.length };
      } catch (error) {
        if (error.code === 'ENOENT') problem('BASE_SERIES_MISSING_SEGMENT');
        throw error;
      }
    };
  }
  async createBaseSeries(input, externalSignal) {
    const w = this.workspace(input.id);
    if (this.baseSeriesReads.size >= 2) problem('RESEARCH_BUSY');
    const anchorId = input.datasetId ?? w.preferences.datasetId;
    if (!anchorId) problem('BASE_SERIES_REQUIRES_SEGMENT');
    const controller = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    this.baseSeriesReads.add(controller);
    try {
      const { candles, series, market } = await buildSeries(
        anchorId,
        input.windows,
        this.archiveReader(w, signal),
      );
      return await this.mutate((state) => {
        signal.throwIfAborted();
        const current = this.workspace(w.id, state);
        const meta = this.storeDataset(
          current,
          candles,
          SERIES_SOURCE,
          `${CHAINS[market.venue].name} · Uniswap v3 · ${new Date(series.startTime * 1000).toISOString()} – ${new Date(series.endTime * 1000).toISOString()}`,
          { series, market },
        );
        const existing = current.datasets.find((dataset) => dataset.id === meta.id);
        if (!existing) {
          current.datasets.push(meta);
          event(current, 'base-history-series-created', {
            datasetId: meta.id,
            segmentCount: series.segments.length,
          });
        }
        if (input.select === true) current.preferences.datasetId = meta.id;
        return existing ?? meta;
      });
    } finally {
      this.baseSeriesReads.delete(controller);
    }
  }
  async captureBaseHistory(input, externalSignal, recording) {
    const w = this.workspace(input.id);
    if (this.baseCaptures.has(w.id) || this.baseCaptures.size >= 2) problem('BASE_HISTORY_BUSY');
    const config = copy(w.market),
      revision = w.marketRevision;
    const previous =
      input.afterDatasetId === undefined
        ? null
        : this.workspaceDataset(w, input.afterDatasetId).amm;
    if (previous === undefined) problem('BASE_HISTORY_SOURCE_CHANGED');
    const controller = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    this.baseCaptures.set(w.id, controller);
    try {
      const { candles, amm } = await captureHistory(
        this.market,
        config,
        { ...input, completeWindow: Boolean(recording), recordingStartedAt: recording?.startedAt },
        previous,
        signal,
      );
      return await this.mutate((state) => {
        signal.throwIfAborted();
        const current = this.workspace(w.id, state);
        if (current.marketRevision !== revision) problem('MARKET_CHANGED');
        const record = recording && this.baseRecorder.check(current, recording);
        const meta = this.storeDataset(
          current,
          candles,
          BASE_HISTORY_SOURCE,
          `${CHAINS[config.venue].name} · Uniswap v3 · ${new Date(amm.startTime * 1000).toISOString()}`,
          { amm },
        );
        const stored = current.datasets.find((dataset) => dataset.id === meta.id);
        if (!stored) {
          current.datasets.push(meta);
          event(current, 'base-history-captured', { datasetId: meta.id, swapCount: amm.swapCount });
        }
        if (input.select === true) current.preferences.datasetId = meta.id;
        if (record) this.baseRecorder.advance(record, stored ?? meta);
        return stored ?? meta;
      });
    } catch (error) {
      if (error.name === 'TimeoutError' && !signal.aborted) problem('BASE_HISTORY_TIMEOUT');
      throw error;
    } finally {
      this.baseCaptures.delete(w.id);
    }
  }
  async backtest(id, input, signal, walkForward = false) {
    if (this.runningTests.size >= 2) problem('RESEARCH_BUSY');
    signal?.throwIfAborted();
    const w = this.workspace(id);
    const config = walkForward ? walkForwardParameters(input.config) : parameters(input.config);
    const token = randomUUID();
    this.runningTests.add(token);
    try {
      let datasetId = input.datasetId || w.preferences.datasetId;
      if (!datasetId) datasetId = (await this.captureCandles(id, { signal })).id;
      signal?.throwIfAborted();
      if (!this.workspace(id).datasets.some((d) => d.id === datasetId))
        problem('DATASET_NOT_IN_WORKSPACE');
      const dataset = this.dataset(datasetId);
      const result = await new Promise((resolve, reject) => {
        const bundled = typeof CIBYP_QUANT_WORKER_SOURCE !== 'undefined';
        const worker = new Worker(
          bundled ? CIBYP_QUANT_WORKER_SOURCE : path.join(__dirname, 'research-worker.js'),
          {
            eval: bundled,
            workerData: { candles: dataset.candles, config, walkForward },
            resourceLimits: { maxOldGenerationSizeMb: 128 },
          },
        );
        this.workers.add(worker);
        const abort = () => {
          reject(signal.reason);
          void worker.terminate();
        };
        signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => {
          reject(new Error('BACKTEST_TIMEOUT'));
          void worker.terminate();
        }, 20000);
        worker.once('message', (reply) =>
          reply.error ? reject(new Error(reply.error)) : resolve(reply.result),
        );
        worker.once('error', reject);
        worker.once('exit', () => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          this.workers.delete(worker);
          reject(new Error('BACKTEST_WORKER_EXIT'));
        });
      });
      const evidence = dataset.amm || dataset.series;
      const observedIntervals =
        dataset.series || dataset.archive || dataset.source === KRAKEN_OHLC_SOURCE;
      const run = {
        id: randomUUID(),
        workspaceId: id,
        datasetId,
        codeVersion: walkForward ? WALK_FORWARD_VERSION : 'candle-engine-1',
        createdAt: Date.now(),
        ...result,
        provenance: evidence
          ? {
              ...dataset.market,
              chainId: evidence.chainId,
              pool: evidence.pool,
              fee: evidence.fee,
            }
          : dataset.market,
        dataSource: dataset.source,
        ...(dataset.series && { dataSeries: dataset.series }),
        ...(dataset.archive && { archive: dataset.archive }),
        ...(observedIntervals && {
          trades: result.trades.map((trade) => ({
            ...trade,
            emptyIntervalsBeforeFill: (trade.time - trade.signalTime) / dataset.market.interval - 1,
          })),
          assumptions: [
            ...result.assumptions,
            'signals-fill-at-next-observed-open-across-empty-intervals',
            'indicators-use-observed-candles',
          ],
        }),
      };
      return await this.saveRun(
        run,
        walkForward ? 'walk-forward-completed' : 'backtest-completed',
        signal,
      );
    } finally {
      this.runningTests.delete(token);
    }
  }
  async saveRun(run, type, signal) {
    run.integrity = hash(run);
    return this.mutate((state) => {
      signal?.throwIfAborted();
      const current = this.workspace(run.workspaceId, state);
      writeAtomic(path.join(this.directory, 'runs', run.id + '.json'), run);
      const { id, createdAt, datasetId, config, metrics } = run;
      current.runs.push({
        id,
        createdAt,
        datasetId,
        config,
        metrics,
        ...((run.ammReplay || run.ammScenario || run.walkForward) && {
          codeVersion: run.codeVersion,
        }),
      });
      event(current, type, { runId: id });
      return run;
    });
  }
  async runAmmExperiment(input, externalSignal, scenario = false) {
    if (this.runningTests.size >= 2 || this.ammReplayAbort) problem('RESEARCH_BUSY');
    const w = this.workspace(input.id);
    const datasetId = input.datasetId ?? w.preferences.datasetId;
    if (!datasetId) problem('AMM_REPLAY_DATASET');
    const config = scenario ? scenarioParameters(input.config) : replayParameters(input.config);
    const controller = new AbortController();
    this.ammReplayAbort = controller;
    this.runningTests.add(controller);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;
    try {
      const load = this.archiveReader(w, signal);
      const { data: dataset } = await load(datasetId, MAX_BYTES);
      const evidence = dataset.amm || dataset.series;
      if (!evidence || dataset.market.venue !== w.market.venue) problem('AMM_REPLAY_DATASET');
      const execute = scenario ? runScenario : replayAmm;
      const result = await execute({
        dataset,
        datasetId,
        load,
        market: this.market,
        marketConfig: copy(w.market),
        config,
        signal,
      });
      return await this.saveRun(
        {
          id: randomUUID(),
          workspaceId: w.id,
          datasetId,
          createdAt: Date.now(),
          codeVersion: scenario
            ? AMM_SCENARIO_VERSION
            : config.feeMode === 'historical'
              ? HISTORICAL_COST_VERSION
              : AMM_REPLAY_VERSION,
          ...result,
          provenance: {
            ...dataset.market,
            chainId: evidence.chainId,
            pool: evidence.pool,
            fee: evidence.fee,
          },
          dataSource: dataset.source,
          ...(dataset.series && { dataSeries: dataset.series }),
        },
        scenario ? 'amm-scenario-saved' : 'amm-replay-completed',
        signal,
      );
    } finally {
      this.runningTests.delete(controller);
      this.ammReplayAbort = undefined;
    }
  }
  getRun(id, runId) {
    const w = this.workspace(id);
    if (!w.runs.some((run) => run.id === runId)) problem('RUN_NOT_IN_WORKSPACE');
    const run = JSON.parse(
      fs.readFileSync(path.join(this.directory, 'runs', runId + '.json'), 'utf8'),
    );
    const { integrity, ...data } = run;
    if (hash(data) !== integrity) problem('RUN_HASH_MISMATCH');
    return run;
  }
  async openChat(id) {
    if (!this.runtime) problem('CHAT_UNAVAILABLE');
    const w = this.workspace(id);
    if (this.chatOpening.has(id)) return this.chatOpening.get(id);
    const key = 'quant:' + id,
      existing = this.runtime.getSession(key);
    if (existing) return this.runtime.getView(key);
    const task = (async () => {
      const view = await this.runtime.initialize({
        key,
        mode: 'chat',
        profile: 'quant',
        conversationId: w.conversationId,
      });
      const history = this.loadConversation(id);
      if (history?.messages?.length)
        await this.runtime.agentAction(key, 'loadFromHistory', [history]);
      return this.runtime.getView(key) || view;
    })().finally(() => this.chatOpening.delete(id));
    this.chatOpening.set(id, task);
    return task;
  }
  saveConversation(id, payload) {
    const w = this.workspace(id);
    if (payload.id !== w.conversationId) problem('QUANT_CONVERSATION_MISMATCH');
    const persisted = copy(payload);
    persisted.llmOverride = Object.fromEntries(
      Object.entries(persisted.llmOverride || {}).filter(([key]) =>
        ['model', 'provider', 'poolEntryId', 'reasoningEffort', 'vision', 'contextLength'].includes(
          key,
        ),
      ),
    );
    writeAtomic(path.join(this.directory, 'conversations', id + '.json'), persisted);
    return { ok: true };
  }
  loadConversation(id) {
    this.workspace(id);
    const file = path.join(this.directory, 'conversations', id + '.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  async request(action, input = {}, context = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) problem('INVALID_PARAMS');
    if (action.startsWith('execution.'))
      return this.execution().request(action.slice(10), input, context);
    if (action.startsWith('exchange.'))
      return this.exchange().request(action.slice(9), input, context);
    if (action.startsWith('recording.')) return this.recordings.request(action.slice(10), input);
    if (action.startsWith('replay.')) return this.replays.request(action.slice(7), input);
    if (action === 'research.search' || action === 'research.read')
      return this.research.request(action.slice(9), input);
    if (action.startsWith('native.paper.'))
      return this.nativePaper.request(action.slice(13), input);
    if (action.startsWith('native.strategy.'))
      return this.nativeStrategies.request(action.slice(16), input);
    if (action === 'native.status')
      return {
        ...this.native.inspect(),
        ...(this.native.state === 'connected'
          ? { summary: (await this.native.call('status')).ledger }
          : {}),
      };
    if (action === 'native.start') return this.native.start();
    if (action === 'native.stop') {
      this.liveExecution?.abortAll();
      await this.nativeMarkets.stopAll();
      return this.native.stop();
    }
    if (action === 'native.source.status') return this.nativeMarkets.inspect();
    if (action === 'native.source.start') return this.nativeMarkets.start(input);
    if (action === 'native.source.stop') return this.nativeMarkets.stop(input.product, input.venue);
    if (action === 'native.source.book') return this.nativeMarkets.book(input.product, input.venue);
    if (action === 'native.control') {
      if (input.method === 'pause') this.liveExecution?.abortAll();
      return this.native.call(input.method, input.params);
    }
    if (action === 'capabilities')
      return {
        version: 1,
        venues,
        chains: Object.values(CHAINS).map(({ id, name, explorer }) => ({ id, name, explorer })),
        walletNetworks: this.getWallet?.().networks.list().items ?? [],
        live: Boolean(this.getWallet),
        nativeHftEngine: false,
        exchange: {
          venue: 'coinbase-exchange',
          environments: ['sandbox', 'live'],
          orderTypes: ['limit-gtc'],
          manualSubmit: true,
        },
        intervals: INTERVALS,
        venueIntervals: Object.fromEntries(
          venues.map((venue) => [venue, intervalsForVenue(venue)]),
        ),
      };
    if (action === 'workspace.list') return this.state.workspaces.map((w) => this.summary(w));
    if (action === 'contract')
      return require('./contracts').contractRequest(this, input.id, input, writeAtomic, context);
    if (action === 'workspace.create')
      return this.mutate((state) => {
        if (state.workspaces.length >= 200) problem('WORKSPACE_LIMIT');
        const venue = input.venue || 'base';
        if (!venues.includes(venue)) problem('VENUE_UNAVAILABLE');
        const spot = spotVenues.find(({ id }) => id === venue);
        const product = spot ? input.product || 'ETH-USD' : 'WETH-USDC';
        if (spot && !spotProducts.includes(product)) problem('PRODUCT_UNAVAILABLE');
        const interval = input.interval ?? 300;
        if (!intervalsForVenue(venue).includes(interval)) problem('INTERVAL_UNAVAILABLE');
        const id = randomUUID(),
          now = Date.now();
        const w = {
          id,
          name: String(input.name || (CHAINS[venue]?.name || spot.label) + ' · ' + product)
            .trim()
            .slice(0, 100),
          createdAt: now,
          updatedAt: now,
          conversationId: 'quant-' + id,
          market: { venue, product, interval, ...(venue !== 'kraken' && { poolFee: 500 }) },
          marketRevision: 1,
          risk: riskConfig(),
          paper: {
            status: 'paused',
            initialCash: '10000',
            cash: '10000',
            position: '0',
            fees: '0',
          },
          preferences: {
            layout: 'professional',
            chatWidth: panelLimits.chatWidth.default,
            datasetId: null,
          },
          quote: null,
          candles: [],
          datasets: [],
          runs: [],
          orders: [],
          audit: [],
          commands: {},
        };
        event(w, 'workspace-created');
        state.workspaces.push(w);
        return this.snapshot(w);
      });
    if (action === 'workspace.get') return this.snapshot(this.workspace(input.id));
    if (action === 'workspace.update')
      return this.mutate((state) => {
        const w = this.workspace(input.id, state);
        if (input.name !== undefined) {
          if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
            problem('INVALID_NAME');
          w.name = input.name.trim();
        }
        if (input.preferences) {
          const p = input.preferences;
          if (p.layout !== undefined) {
            if (!['professional', 'immersive'].includes(p.layout)) problem('INVALID_LAYOUT');
            w.preferences.layout = p.layout;
          }
          for (const [key, bounds] of Object.entries(panelLimits)) {
            const value = p[key];
            if (value === undefined) continue;
            if (!Number.isInteger(value) || value < bounds.min || value > bounds.max)
              problem('INVALID_LAYOUT');
            w.preferences[key] = value;
          }
          if (p.focusDetails !== undefined) {
            if (typeof p.focusDetails !== 'boolean') problem('INVALID_LAYOUT');
            w.preferences.focusDetails = p.focusDetails;
          }
          if (p.datasetId !== undefined) {
            if (p.datasetId !== null && !w.datasets.some((d) => d.id === p.datasetId))
              problem('DATASET_NOT_IN_WORKSPACE');
            w.preferences.datasetId = p.datasetId;
          }
        }
        if (input.market || input.risk) {
          if (w.paper.status === 'running' || openOrders(w).length)
            problem('PAUSE_AND_CANCEL_BEFORE_CONFIGURING');
          if (input.risk) w.risk = riskConfig({ ...w.risk, ...input.risk });
          if (input.market) {
            const previousMarket = { ...w.market };
            const before = JSON.stringify(w.market);
            if (
              input.market.interval !== undefined &&
              !intervalsForVenue(w.market.venue).includes(input.market.interval)
            )
              problem('INTERVAL_UNAVAILABLE');
            if (
              w.market.venue === 'kraken' &&
              ['rpcUrl', 'pool', 'poolFee'].some((key) => Object.hasOwn(input.market, key))
            )
              problem('CHAIN_UNAVAILABLE');
            if (input.market.rpcUrl !== undefined)
              w.market.rpcUrl = input.market.rpcUrl ? endpoint(input.market.rpcUrl) : '';
            if (input.market.pool !== undefined) {
              if (input.market.pool && !/^0x[\da-f]{40}$/i.test(input.market.pool))
                problem('INVALID_ADDRESS');
              w.market.pool = input.market.pool || '';
            }
            if (input.market.poolFee !== undefined) {
              if (
                !Number.isInteger(input.market.poolFee) ||
                input.market.poolFee < 1 ||
                input.market.poolFee >= 1000000
              )
                problem('BASE_POOL_FEE_RANGE');
              w.market.poolFee = input.market.poolFee;
            }
            if (input.market.interval !== undefined) w.market.interval = input.market.interval;
            if (JSON.stringify(w.market) !== before) {
              const candles =
                w.market.venue === 'kraken' ? this.switchKrakenCandles(w, previousMarket) : [];
              this.baseRecorder.pause(w, 'market-changed');
              w.marketRevision = (w.marketRevision ?? 0) + 1;
              w.candles = candles;
              w.quote = null;
              w.lastError = null;
              delete w.historyFetchedAt;
              delete w.historyOpenTime;
            }
          }
          event(w, 'configuration-updated');
        }
        w.updatedAt = Date.now();
        return this.snapshot(w);
      });
    if (action === 'market.refresh') return this.refresh(input.id);
    if (action === 'market.kraken.archive') return this.captureKrakenArchive(input, context.signal);
    if (action === 'market.candles') {
      const w = this.workspace(input.id);
      const dataset = input.datasetId ? this.workspaceDataset(w, input.datasetId) : null;
      const candles = dataset?.candles || w.candles;
      const offset = input.offset ?? 0,
        limit = input.limit ?? 10;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        problem('INVALID_PAGINATION');
      const end = Math.max(0, candles.length - offset);
      const items = candles.slice(Math.max(0, end - limit), end).reverse();
      return {
        items,
        total: candles.length,
        offset,
        next: offset + items.length < candles.length ? offset + items.length : null,
        source: dataset?.source ?? w.quote?.quality ?? null,
        ...(dataset?.archive && { archive: dataset.archive }),
        market: copy(
          dataset?.market ?? {
            venue: w.market.venue,
            product: w.market.product,
            interval: w.market.interval,
          },
        ),
      };
    }
    if (action === 'base.history.record.status')
      return this.baseRecorder.status(this.workspace(input.id));
    if (action === 'base.history.record.start') return this.baseRecorder.start(input);
    if (action === 'base.history.record.stop') return this.baseRecorder.stop(input.id);
    if (action === 'base.history.capture') return this.captureBaseHistory(input, context.signal);
    if (action === 'base.history.series') return this.createBaseSeries(input, context.signal);
    if (action === 'base.history.trades') {
      const { amm } = this.workspaceDataset(this.workspace(input.id), input.datasetId);
      if (!amm) problem('BASE_HISTORY_SOURCE_CHANGED');
      const offset = input.offset ?? 0,
        limit = input.limit ?? 50;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        problem('HISTORY_PAGE');
      return { items: amm.trades.slice(offset, offset + limit), offset, total: amm.swapCount };
    }
    if (action === 'base.inspect') {
      const { market, config, chain } = this.evmContext(input.id, input.chainId);
      if (input.discoverAssets === true) {
        if (chain.archived) problem('WALLET_CHAIN_UNAVAILABLE');
        const result = await discoverTokens(
          market,
          { ...config, rpcUrl: config.rpcUrl || chain.rpc },
          input,
          context.signal,
        );
        if (input.chainId !== undefined)
          this.getWallet().networks.assert(chain.key, chain.revision);
        return result;
      }
      if (!chain.builtin && (input.signatureNonce !== undefined || input.protocol === 'permit2'))
        problem('WALLET_CHAIN_UNAVAILABLE');
      if (input.assets === true)
        return market.tokenHoldings(config, input, { signal: context.signal });
      if (input.signatureNonce !== undefined)
        return market.permit2SignatureNonce(
          config,
          { address: input.address, nonce: input.signatureNonce },
          { signal: context.signal },
        );
      if (input.approvalHistory === true)
        return market.discoverTokenApprovals(
          config,
          { ...input, limit: input.limit ?? 8 },
          { signal: context.signal },
        );
      if (input.token !== undefined || input.spender !== undefined)
        return market.tokenAllowance(config, input, { signal: context.signal });
      return market.chainStatus(config, input, { signal: context.signal });
    }
    if (action === 'dataset.import') {
      const w = this.workspace(input.id),
        candles = parseImport(input.text);
      const meta = this.storeDataset(
        w,
        candles,
        'user-import-unverified',
        input.label || 'Imported candles',
      );
      return this.mutate((state) => {
        const current = this.workspace(input.id, state);
        if (!current.datasets.some((d) => d.id === meta.id)) current.datasets.push(meta);
        current.preferences.datasetId = meta.id;
        event(current, 'dataset-imported', { datasetId: meta.id });
        return meta;
      });
    }
    if (action === 'dataset.get') {
      const data = this.workspaceDataset(this.workspace(input.id), input.datasetId);
      if (data.amm) delete data.amm.trades;
      return data;
    }
    if (action === 'dataset.capture') {
      if (
        input.label !== undefined &&
        (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120)
      )
        problem('INVALID_NAME');
      return this.captureCandles(input.id, {
        label: input.label?.trim(),
        select: input.select === true,
        signal: context.signal,
      });
    }
    if (action === 'run.backtest') return this.backtest(input.id, input, context.signal);
    if (action === 'run.walk-forward') return this.backtest(input.id, input, context.signal, true);
    if (action === 'run.walk-forward.fold') {
      const run = this.getRun(input.id, input.runId);
      const fold = input.fold;
      if (!run.walkForward || !Number.isInteger(fold) || !run.walkForward.windows[fold - 1])
        problem('WALK_FORWARD_FOLD');
      return run.walkForward.windows[fold - 1];
    }
    if (action === 'run.amm') return this.runAmmExperiment(input, context.signal);
    if (action === 'run.amm.scenario') return this.runAmmExperiment(input, context.signal, true);
    if (action === 'run.amm.scenario.get') {
      const run = this.getRun(input.id, input.runId);
      if (!run.ammScenario) problem('AMM_SCENARIO_RUN_REQUIRED');
      return {
        id: run.id,
        datasetId: run.datasetId,
        config: run.config,
        provenance: run.provenance,
        metrics: run.metrics,
        assumptions: run.assumptions,
        ...run.ammScenario,
      };
    }
    if (action === 'run.get') return this.getRun(input.id, input.runId);
    if (action === 'run.amm.attempts') {
      const run = this.getRun(input.id, input.runId);
      if (!run.ammReplay) problem('AMM_REPLAY_RUN_REQUIRED');
      const offset = input.offset ?? 0,
        limit = input.limit ?? 10;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20
      )
        problem('INVALID_PAGINATION');
      return {
        items: run.ammReplay.attempts.slice(offset, offset + limit),
        offset,
        total: run.ammReplay.attempts.length,
        finalMark: run.ammReplay.finalMark,
      };
    }
    if (action === 'history.list') {
      const w = this.workspace(input.id),
        kind = input.kind || 'audit';
      if (!['audit', 'orders', 'runs', 'research'].includes(kind)) problem('HISTORY_KIND');
      const items = w[kind] || [];
      const offset = input.offset ?? 0,
        limit = input.limit ?? 50;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        problem('INVALID_PAGINATION');
      return {
        items: copy([...items].reverse().slice(offset, offset + limit)),
        total: items.length,
        nextOffset: offset + limit < items.length ? offset + limit : null,
      };
    }
    if (
      action === 'paper.start' ||
      action === 'paper.pause' ||
      action === 'paper.cancelAll' ||
      action === 'paper.cancel'
    )
      return this.mutate((state) => {
        const w = this.workspace(input.id, state);
        if (action === 'paper.start') w.paper.status = 'running';
        if (action === 'paper.pause') w.paper.status = 'paused';
        if (action.startsWith('paper.cancel')) {
          const orders = openOrders(w).filter(
            (order) => action === 'paper.cancelAll' || order.id === input.orderId,
          );
          if (action === 'paper.cancel' && !orders.length) problem('OPEN_ORDER_NOT_FOUND');
          for (const order of orders)
            Object.assign(order, { status: 'cancelled', cancelledAt: Date.now(), reason: 'user' });
        }
        event(w, action);
        return this.snapshot(w);
      });
    if (action === 'paper.order')
      return this.mutate((state) => {
        const w = this.workspace(input.id, state),
          { side, type = 'market', quantity, limitPrice, commandId } = input;
        if (!/^[\w:-]{1,160}$/.test(String(commandId || ''))) problem('COMMAND_ID_REQUIRED');
        const intent = {
          side,
          type,
          quantity: decimal(atoms(quantity, true)),
          limitPrice: type === 'limit' ? decimal(atoms(limitPrice, true)) : null,
        };
        if (!['buy', 'sell'].includes(side) || !['market', 'limit'].includes(type))
          problem('ORDER_UNAVAILABLE');
        const digest = hash(intent),
          previous = w.commands[commandId];
        if (previous) {
          if (previous.digest !== digest) problem('COMMAND_ID_CONFLICT');
          return w.orders.find((order) => order.id === previous.orderId);
        }
        if (w.paper.status !== 'running') problem('PAPER_PAUSED');
        const quote = w.quote;
        if (!quote || w.lastError || !freshSample(quote, Date.now()))
          problem('FRESH_MARKET_REQUIRED');
        if (w.orders.filter((order) => order.createdAt > Date.now() - 60000).length >= 60)
          problem('PAPER_ORDER_RATE_LIMIT');
        const buying = side === 'buy',
          mark = atoms(quote.price, true),
          qty = atoms(intent.quantity, true);
        const price =
          type === 'limit'
            ? atoms(intent.limitPrice, true)
            : (mark * BigInt(10000 + (buying ? 1 : -1) * w.risk.slippageBps)) / 10000n;
        if (
          price <= 0n ||
          (type === 'limit' && (price > (mark * 120n) / 100n || price < (mark * 80n) / 100n))
        )
          problem('PRICE_BAND');
        const value = notional(price, qty),
          costs = fee(value, w.risk.feeBps),
          reserves = reserved(w);
        if (value > atoms(w.risk.maxOrder)) problem('MAX_ORDER_NOTIONAL');
        if (buying) {
          if (value + costs > atoms(w.paper.cash) - reserves.cash)
            problem('INSUFFICIENT_PAPER_CASH');
          const exposureQty = atoms(w.paper.position) + reserves.buyQuantity + qty;
          if (
            exposureQty > atoms(w.risk.maxPosition) ||
            notional(mark, exposureQty) > atoms(w.risk.maxExposure)
          )
            problem('MAX_POSITION_EXPOSURE');
        } else if (qty > atoms(w.paper.position) - reserves.position)
          problem('INSUFFICIENT_PAPER_POSITION');
        const order = {
          id: randomUUID(),
          commandId,
          environment: 'paper',
          product: w.market.product,
          ...intent,
          status: 'open',
          createdAt: Date.now(),
          submittedQuoteTime: quote.time,
          reserved: buying ? decimal(value + costs) : '0',
          fillModel: 'snapshot-crossing-full-fill-no-queue',
        };
        w.orders.push(order);
        w.commands[commandId] = { digest, orderId: order.id };
        if (type === 'market') fill(w, order, price, Date.now());
        event(w, 'paper-order', { orderId: order.id, side, status: order.status });
        return order;
      });
    if (action === 'chat.open') return this.openChat(input.id);
    if (action === 'chat.questionnaire.respond') {
      await this.openChat(input.id);
      return this.runtime.respond('quant:' + input.id, {
        questionnaireId: input.questionnaireId ?? null,
        revision: input.revision,
        action: input.action,
        answers: input.answers,
      });
    }
    if (action === 'chat.send') {
      if (
        typeof input.message !== 'string' ||
        !input.message.trim() ||
        input.message.length > 30000
      )
        problem('INVALID_MESSAGE');
      await this.openChat(input.id);
      const key = 'quant:' + input.id;
      if (input.autonomous === true && !this.runtime.getSession(key)?.busy)
        return this.runtime.goalCommand(key, 'set', input.message).then(() => ({ ok: true }));
      return this.runtime.submitMessage('quant:' + input.id, input.message);
    }
    if (action === 'chat.stop') {
      this.workspace(input.id);
      return this.runtime.stop('quant:' + input.id);
    }
    if (action.startsWith('live.') || action.startsWith('wallet.'))
      problem('LIVE_SIGNER_NOT_IMPLEMENTED');
    problem('UNKNOWN_QUANT_ACTION');
  }
  evmContext(id, chainId) {
    const workspace = this.workspace(id);
    if (chainId === undefined) {
      const chain = CHAINS[workspace.market.venue];
      if (!chain) problem('WALLET_CHAIN_UNAVAILABLE');
      return { market: this.market, config: workspace.market, chain: { ...chain, builtin: true } };
    }
    if (!this.getWallet) problem('LIVE_SIGNER_NOT_IMPLEMENTED');
    const wallet = this.getWallet(),
      chain = wallet.networks.byId(chainId);
    return { market: wallet.market, config: { venue: chain.key }, chain };
  }
  async liveTransaction(id, input, commandId, signal, agentContext) {
    const { config, chain } = this.evmContext(id, input.chainId);
    if (input.callId) {
      const call = require('./contracts').loadCall(this, id, input.callId);
      if (call.chainId !== chain.id) problem('CONTRACT_NETWORK_CHANGED');
      if (input.to || input.data) problem('CONTRACT_CALL_OVERRIDE');
      input = { ...input, to: call.to, data: call.data, value: input.value || '0' };
    }
    if (!this.getWallet) problem('LIVE_SIGNER_NOT_IMPLEMENTED');
    return this.getWallet().transact(
      config,
      { ...input, commandId },
      { actor: 'agent', workspaceId: id, signal, agentContext },
    );
  }
  async liveSwap(id, input, commandId, signal, agentContext) {
    if (!this.getWallet) problem('LIVE_SIGNER_NOT_IMPLEMENTED');
    const w = this.workspace(id);
    return require('./base-swap').executeBaseSwap({
      market: this.market,
      walletService: this.getWallet(),
      config: w.market,
      input,
      commandId,
      workspaceId: id,
      agentContext,
      signal,
    });
  }
  dispose() {
    this.disposed = true;
    for (const flight of this.refreshing.values())
      flight.controller.abort(new Error('QUANT_STOPPED'));
    this.exchangeOrders?.dispose();
    this.baseRecorder.dispose();
    for (const controller of this.baseCaptures.values()) controller.abort();
    for (const controller of this.krakenArchiveFlights.values()) controller.abort();
    for (const controller of this.baseSeriesReads) controller.abort();
    this.ammReplayAbort?.abort();
    this.liveExecution?.dispose();
    this.recordings.dispose();
    this.replays.dispose();
    this.nativeMarkets.dispose();
    this.research.web.cache.clear();
    this.native.dispose();
    clearTimeout(this.timer);
    for (const worker of this.workers) worker.terminate();
  }
}
function safeError(error) {
  return /^[A-Z][A-Z_\d-]{1,100}$/.test(error.message || '')
    ? error.message
    : 'MARKET_CONNECTION_FAILED';
}
module.exports = { QuantService, writeAtomic, parseImport, riskConfig };
