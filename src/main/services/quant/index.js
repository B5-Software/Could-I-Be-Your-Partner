/* SPDX-License-Identifier: GPL-3.0-or-later */
/* global CIBYP_QUANT_WORKER_SOURCE */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { MarketData, CHAINS, INTERVALS, endpoint } = require('./market-data');
const { validateCandles, parameters } = require('./backtest');
const { SCALE, atoms, decimal, notional, fee } = require('./decimal');
const { NativeEngine } = require('./native-engine');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idPattern = /^[a-z\d-]{1,80}$/i;
const copy = (value) => structuredClone(value);
const problem = (message) => {
  throw new Error(message);
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
    this.nativePaper = new (require('./native-paper').NativePaper)(this);
    this.nativeStrategies = new (require('./native-strategies').NativeStrategies)(this);
    this.recordings = new (require('./event-recordings').EventRecordings)(this);
    this.replays = new (require('./event-replay').EventReplay)(this);
    this.queue = Promise.resolve();
    this.refreshing = new Map();
    this.chatOpening = new Map();
    this.workers = new Set();
    this.runningTests = new Set();
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
  }
  execution() {
    return (this.liveExecution ??= new (require('./live-execution').LiveExecution)(this));
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
    delete value.market.rpcUrl;
    delete value.commands;
    const chain = CHAINS[w.market.venue];
    if (chain)
      value.network = {
        id: chain.id,
        name: chain.name,
        explorer: chain.explorer,
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
      live: Boolean(this.getWallet),
      walletSigning: Boolean(this.getWallet),
      candleBacktest: true,
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
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    if (w.quote && !w.lastError && Date.now() - w.quote.observedAt < 4000) return this.snapshot(w);
    const config = copy(w.market),
      revision = w.marketRevision;
    const task = (async () => {
      try {
        const quote = await this.market.quote(
          config,
          !w.candles.length || Date.now() - (w.historyFetchedAt || 0) > config.interval * 1000,
        );
        return await this.mutate((state) => {
          const current = this.workspace(id, state);
          if (current.marketRevision !== revision) problem('MARKET_CHANGED');
          if (current.quote && quote.time < current.quote.time) problem('MARKET_TIME_REGRESSED');
          if (quote.time > Date.now() / 1000 + 120) problem('MARKET_CLOCK_SKEW');
          const historical = quote.candles.length > 0;
          const bars = new Map(current.candles.map((bar) => [bar.time, bar]));
          for (const bar of quote.candles) bars.set(bar.time, bar);
          const time = Math.floor(quote.time / config.interval) * config.interval;
          const price = Number(quote.price),
            last = bars.get(time);
          if (!last)
            bars.set(time, { time, open: price, high: price, low: price, close: price, volume: 0 });
          else if (!historical)
            bars.set(time, {
              ...last,
              high: Math.max(last.high, price),
              low: Math.min(last.low, price),
              close: price,
            });
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
          current.quote = quote;
          current.lastError = null;
          if (historical) current.historyFetchedAt = Date.now();
          const fresh = Date.now() - quote.time * 1000 < 30000;
          if (fresh)
            for (const order of openOrders(current)) {
              if (quote.time * 1000 <= order.createdAt) continue;
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
        // Keep cached history visible, but a transport failure invalidates trading freshness.
        await this.mutate((state) => {
          const current = this.workspace(id, state);
          if (current.marketRevision === revision)
            current.lastError = { code: safeError(error), time: Date.now() };
        });
        throw new Error(safeError(error));
      }
    })().finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, task);
    return task;
  }
  storeDataset(w, candles, source, label) {
    const data = {
      version: 1,
      market: { venue: w.market.venue, product: w.market.product, interval: w.market.interval },
      source,
      candles: validateCandles(candles),
    };
    const id = hash(data);
    const file = path.join(this.directory, 'datasets', id + '.json');
    if (!fs.existsSync(file)) writeAtomic(file, data);
    return {
      id,
      label: String(label || source).slice(0, 120),
      source,
      count: data.candles.length,
      start: data.candles[0].time,
      end: data.candles.at(-1).time,
      createdAt: Date.now(),
    };
  }
  dataset(id) {
    if (!/^[a-f\d]{64}$/.test(String(id))) problem('INVALID_DATASET');
    const data = JSON.parse(
      fs.readFileSync(path.join(this.directory, 'datasets', id + '.json'), 'utf8'),
    );
    if (hash(data) !== id) problem('DATASET_HASH_MISMATCH');
    return data;
  }
  async backtest(id, input) {
    if (this.runningTests.size >= 2) problem('RESEARCH_BUSY');
    const w = this.workspace(id),
      config = parameters(input.config);
    let datasetId = input.datasetId || w.preferences.datasetId;
    if (!datasetId) {
      const closed = w.candles.filter((bar) => (bar.time + w.market.interval) * 1000 <= Date.now());
      const meta = this.storeDataset(w, closed, w.quote?.quality || 'unknown', 'Market snapshot');
      await this.mutate((state) => {
        const current = this.workspace(id, state);
        if (!current.datasets.some((d) => d.id === meta.id)) current.datasets.push(meta);
      });
      datasetId = meta.id;
    }
    if (!this.workspace(id).datasets.some((d) => d.id === datasetId))
      problem('DATASET_NOT_IN_WORKSPACE');
    const dataset = this.dataset(datasetId),
      token = randomUUID();
    this.runningTests.add(token);
    try {
      const result = await new Promise((resolve, reject) => {
        const bundled = typeof CIBYP_QUANT_WORKER_SOURCE !== 'undefined';
        const worker = new Worker(
          bundled ? CIBYP_QUANT_WORKER_SOURCE : path.join(__dirname, 'research-worker.js'),
          {
            eval: bundled,
            workerData: { candles: dataset.candles, config },
            resourceLimits: { maxOldGenerationSizeMb: 128 },
          },
        );
        this.workers.add(worker);
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('BACKTEST_TIMEOUT'));
        }, 20000);
        worker.once('message', (reply) =>
          reply.error ? reject(new Error(reply.error)) : resolve(reply.result),
        );
        worker.once('error', reject);
        worker.once('exit', (code) => {
          clearTimeout(timeout);
          this.workers.delete(worker);
          if (code !== 0) reject(new Error('BACKTEST_WORKER_EXIT'));
        });
      });
      const run = {
        id: randomUUID(),
        workspaceId: id,
        datasetId,
        codeVersion: 'candle-engine-1',
        createdAt: Date.now(),
        ...result,
        provenance: dataset.market,
        dataSource: dataset.source,
      };
      run.integrity = hash(run);
      writeAtomic(path.join(this.directory, 'runs', run.id + '.json'), run);
      await this.mutate((state) => {
        const current = this.workspace(id, state);
        current.runs.push({
          id: run.id,
          createdAt: run.createdAt,
          datasetId,
          config,
          metrics: run.metrics,
        });
        event(current, 'backtest-completed', { runId: run.id });
      });
      return run;
    } finally {
      this.runningTests.delete(token);
    }
  }
  async openChat(id) {
    if (!this.runtime) problem('CHAT_UNAVAILABLE');
    const key = 'quant:' + id,
      existing = this.runtime.getSession(key);
    if (existing) return this.runtime.getView(key);
    if (this.chatOpening.has(id)) return this.chatOpening.get(id);
    const w = this.workspace(id);
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
    if (action === 'native.source.stop') return this.nativeMarkets.stop(input.product);
    if (action === 'native.source.book') return this.nativeMarkets.book(input.product);
    if (action === 'native.control') {
      if (input.method === 'pause') this.liveExecution?.abortAll();
      return this.native.call(input.method, input.params);
    }
    if (action === 'capabilities')
      return {
        version: 1,
        venues: ['base', 'base-sepolia', 'coinbase'],
        chains: Object.values(CHAINS).map(({ id, name, explorer }) => ({ id, name, explorer })),
        live: Boolean(this.getWallet),
        nativeHftEngine: false,
        intervals: INTERVALS,
      };
    if (action === 'workspace.list') return this.state.workspaces.map((w) => this.summary(w));
    if (action === 'contract')
      return require('./contracts').contractRequest(this, input.id, input, writeAtomic);
    if (action === 'workspace.create')
      return this.mutate((state) => {
        if (state.workspaces.length >= 200) problem('WORKSPACE_LIMIT');
        const venue = input.venue || 'base';
        if (!['base', 'base-sepolia', 'coinbase'].includes(venue)) problem('VENUE_UNAVAILABLE');
        const product = venue === 'coinbase' ? input.product || 'ETH-USD' : 'WETH-USDC';
        if (venue === 'coinbase' && !['ETH-USD', 'BTC-USD', 'SOL-USD'].includes(product))
          problem('PRODUCT_UNAVAILABLE');
        const id = randomUUID(),
          now = Date.now();
        const w = {
          id,
          name: String(input.name || (CHAINS[venue]?.name || 'Coinbase') + ' · ' + product)
            .trim()
            .slice(0, 100),
          createdAt: now,
          updatedAt: now,
          conversationId: 'quant-' + id,
          market: { venue, product, interval: 300, poolFee: 500 },
          marketRevision: 1,
          risk: riskConfig(),
          paper: {
            status: 'paused',
            initialCash: '10000',
            cash: '10000',
            position: '0',
            fees: '0',
          },
          preferences: { layout: 'professional', chatWidth: 360, datasetId: null },
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
          if (p.chatWidth !== undefined) {
            if (!Number.isInteger(p.chatWidth) || p.chatWidth < 280 || p.chatWidth > 600)
              problem('INVALID_LAYOUT');
            w.preferences.chatWidth = p.chatWidth;
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
            if (input.market.interval !== undefined && !INTERVALS.includes(input.market.interval))
              problem('INTERVAL_UNAVAILABLE');
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
            w.marketRevision++;
            w.candles = [];
            w.quote = null;
            w.lastError = null;
          }
          event(w, 'configuration-updated');
        }
        w.updatedAt = Date.now();
        return this.snapshot(w);
      });
    if (action === 'market.refresh') return this.refresh(input.id);
    if (action === 'base.inspect')
      return this.market.chainStatus(this.workspace(input.id).market, input);
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
      const w = this.workspace(input.id);
      if (!w.datasets.some((d) => d.id === input.datasetId)) problem('DATASET_NOT_IN_WORKSPACE');
      return this.dataset(input.datasetId);
    }
    if (action === 'run.backtest') return this.backtest(input.id, input);
    if (action === 'run.get') {
      const w = this.workspace(input.id);
      if (!w.runs.some((run) => run.id === input.runId)) problem('RUN_NOT_IN_WORKSPACE');
      const run = JSON.parse(
        fs.readFileSync(path.join(this.directory, 'runs', input.runId + '.json'), 'utf8'),
      );
      const { integrity, ...data } = run;
      if (hash(data) !== integrity) problem('RUN_HASH_MISMATCH');
      return run;
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
        if (
          !quote ||
          w.lastError ||
          Date.now() - quote.observedAt > 30000 ||
          Date.now() - quote.time * 1000 > 30000
        )
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
  async liveTransaction(id, input, commandId, signal, agentContext) {
    if (input.callId) {
      const call = require('./contracts').loadCall(this, id, input.callId);
      if (call.chainId !== CHAINS[this.workspace(id).market.venue]?.id)
        problem('CONTRACT_NETWORK_CHANGED');
      if (input.to || input.data) problem('CONTRACT_CALL_OVERRIDE');
      input = { ...input, to: call.to, data: call.data, value: input.value || '0' };
    }
    if (!this.getWallet) problem('LIVE_SIGNER_NOT_IMPLEMENTED');
    const w = this.workspace(id);
    return this.getWallet().transact(
      w.market,
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
