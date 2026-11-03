/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QuantService } = require('../../src/main/services/quant');
const { MarketData, CHAINS } = require('../../src/main/services/quant/market-data');
const { atoms, decimal } = require('../../src/main/services/quant/decimal');
const { runBacktest, validateCandles } = require('../../src/main/services/quant/backtest');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-quant-'));
  const service = new QuantService({ directory });
  service.market.quote = async () => ({
    source: 'fixture',
    price: '100',
    time: Date.now() / 1000,
    observedAt: Date.now(),
    quality: 'fixture-test-only',
    book: null,
    candles: [],
  });
  t.after(() => {
    service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { service, directory };
}
const bar = (time, price) => ({
  time,
  open: price,
  high: price + 1,
  low: price - 1,
  close: price,
  volume: 10,
});

test('fixed-point paper amounts reject exponent/negative/precision overflow', () => {
  assert.equal(decimal(atoms('123.12345678')), '123.12345678');
  for (const invalid of ['1e5', '-1', 'NaN', '1.123456789', '', Infinity])
    assert.throws(() => atoms(invalid));
  assert.throws(() => atoms('0', true));
});
test('backtest uses next open, fees and mark-to-market; OHLC alone is not HFT validation', () => {
  const result = runBacktest([bar(60, 100), bar(120, 200), bar(180, 300)], {
    strategy: 'buy-hold',
    feeBps: 0,
    slippageBps: 0,
    allocationBps: 5000,
  });
  assert.equal(result.trades[0].time, 120);
  assert.equal(result.trades[0].signalTime, 60);
  assert.equal(result.trades[0].price, '200');
  assert.equal(result.trades[0].quantity, '25');
  assert.equal(result.metrics.finalEquity, 12500);
  assert.ok(result.assumptions.includes('not-a-high-frequency-execution-validation'));
  assert.throws(() => validateCandles([bar(60, 100), bar(60, 101)]), /TIME_ORDER/);
  assert.throws(() => validateCandles([{ ...bar(60, 100), high: 1 }]), /RANGE/);
});
test('durable paper receipts deduplicate across restarts and reject changed intents', async (t) => {
  const { service, directory } = fixture(t);
  const w = await service.request('workspace.create', { venue: 'base' });
  await service.refresh(w.id);
  await service.request('paper.start', { id: w.id });
  const input = { id: w.id, side: 'buy', quantity: '1', commandId: 'same-command' };
  const first = await service.request('paper.order', input);
  const second = await service.request('paper.order', { ...input, quantity: '1.000' });
  assert.equal(first.id, second.id);
  await assert.rejects(service.request('paper.order', { ...input, quantity: '2' }), /CONFLICT/);
  const restored = new QuantService({ directory });
  t.after(() => restored.dispose());
  const state = await restored.request('workspace.get', { id: w.id });
  assert.equal(state.orders.length, 1);
  assert.equal(state.paper.status, 'paused');
  assert.equal(state.paper.position, '1');
  assert.notEqual(state.paper.cash, '10000');
  assert.equal((await restored.request('paper.order', input)).id, first.id);
});
test('limit orders reserve funds atomically and cannot fill from the submitting sample', async (t) => {
  const { service } = fixture(t),
    w = await service.request('workspace.create', {});
  await service.refresh(w.id);
  await service.request('workspace.update', {
    id: w.id,
    risk: { maxPosition: '1000', maxExposure: '50000' },
  });
  await service.request('paper.start', { id: w.id });
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      service.request('paper.order', {
        id: w.id,
        side: 'buy',
        type: 'limit',
        quantity: '10',
        limitPrice: '90',
        commandId: 'reserve:' + i,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 11);
  const current = await service.request('workspace.get', { id: w.id });
  assert.equal(current.paper.position, '0');
  assert.equal(current.paper.reservedCash, '9909.9');
  await assert.rejects(
    service.request('workspace.update', { id: w.id, risk: { feeBps: 500 } }),
    /PAUSE_AND_CANCEL/,
  );
  await service.request('paper.cancelAll', { id: w.id });
  assert.equal((await service.request('workspace.get', { id: w.id })).paper.availableCash, '10000');
});
test('a failed durable commit never publishes new balances or succeeds a command', async (t) => {
  const { service } = fixture(t),
    w = await service.request('workspace.create', {});
  await service.refresh(w.id);
  await service.request('paper.start', { id: w.id });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === service.file) throw new Error('fixture disk failure');
    return rename(from, to);
  });
  await assert.rejects(
    service.request('paper.order', { id: w.id, side: 'buy', quantity: '1', commandId: 'failed' }),
    /disk failure/,
  );
  assert.equal((await service.request('workspace.get', { id: w.id })).paper.cash, '10000');
  assert.equal(service.workspace(w.id).commands.failed, undefined);
});
test('immutable experiments and datasets survive reopening; integrity and ownership are checked', async (t) => {
  const { service, directory } = fixture(t),
    w = await service.request('workspace.create', {});
  const candles = Array.from({ length: 80 }, (_, i) =>
    bar(60 + i * 60, 100 + Math.sin(i / 5) * 10),
  );
  const dataset = await service.request('dataset.import', {
    id: w.id,
    text: JSON.stringify(candles),
    label: 'Research.csv',
  });
  const run = await service.request('run.backtest', {
    id: w.id,
    datasetId: dataset.id,
    config: { strategy: 'sma-cross' },
  });
  assert.ok(run.integrity);
  assert.equal(run.metrics.bars, 80);
  const reopened = new QuantService({ directory });
  t.after(() => reopened.dispose());
  assert.deepEqual(await reopened.request('run.get', { id: w.id, runId: run.id }), run);
  const other = await reopened.request('workspace.create', {});
  await assert.rejects(
    reopened.request('dataset.get', { id: other.id, datasetId: dataset.id }),
    /NOT_IN_WORKSPACE/,
  );
  const file = path.join(directory, 'datasets', dataset.id + '.json'),
    data = JSON.parse(fs.readFileSync(file));
  data.candles[0].close = 123;
  fs.writeFileSync(file, JSON.stringify(data));
  await assert.rejects(
    reopened.request('dataset.get', { id: w.id, datasetId: dataset.id }),
    /HASH_MISMATCH/,
  );
});
test('market failures retain history and invalidate paper freshness; no live fallback exists', async (t) => {
  const { service } = fixture(t),
    w = await service.request('workspace.create', {});
  await service.refresh(w.id);
  await service.request('paper.start', { id: w.id });
  service.market.quote = async () => {
    throw new Error('private-url-or-key-do-not-expose');
  };
  // The service intentionally shares a quote for four seconds across frontends.
  service.workspace(w.id).quote.observedAt -= 5000;
  await assert.rejects(service.refresh(w.id), /MARKET_CONNECTION_FAILED/);
  const state = await service.request('workspace.get', { id: w.id });
  assert.ok(state.candles.length);
  assert.equal(state.lastError.code, 'MARKET_CONNECTION_FAILED');
  await assert.rejects(
    service.request('paper.order', { id: w.id, side: 'buy', quantity: '1', commandId: 'stale' }),
    /FRESH_MARKET/,
  );
  await assert.rejects(service.request('live.order', { id: w.id }), /NOT_IMPLEMENTED/);
});
test('Base refuses a mismatched chain before reading/signing any contract', async () => {
  const methods = [];
  const data = new MarketData(async (_url, options) => {
    const body = JSON.parse(options.body);
    methods.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
  });
  await assert.rejects(data.base({ venue: 'base' }), /CHAIN_ID_MISMATCH/);
  assert.deepEqual(methods, ['eth_chainId']);
  assert.equal(CHAINS['base-sepolia'].id, 84532);
});
test('Base spot price uses token ordering/decimals and rejects a mid-read reorg', async () => {
  let reorg = false;
  const q192 = 2n ** 192n,
    ratio = (q192 * 10n ** 12n) / 2000n;
  let sqrt = ratio,
    x = (sqrt + 1n) / 2n;
  while (x < sqrt) {
    sqrt = x;
    x = (ratio / x + x) / 2n;
  }
  const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const hash = '0x' + 'a'.repeat(64),
    pool = '0x' + 'b'.repeat(40),
    chain = CHAINS.base;
  let blocks = 0;
  const data = new MarketData(async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    let result;
    if (method === 'eth_chainId') result = '0x2105';
    else if (method === 'eth_getBlockByNumber') {
      blocks++;
      result = {
        number: '0x123',
        hash: reorg && blocks % 2 === 0 ? '0x' + 'c'.repeat(64) : hash,
        timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
      };
    } else if (method === 'eth_call') {
      const { to, data } = params[0];
      if (to === chain.factory) result = word(pool);
      else if (data === '0x0dfe1681') result = word(chain.usdc);
      else if (data === '0xd21220a7') result = word(chain.weth);
      else if (data === '0x3850c7bd') result = word(sqrt);
      else if (data === '0x1a686502') result = word(1000);
      else if (data === '0x313ce567') result = word(to === chain.usdc ? 6 : 18);
    }
    assert.ok(result);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
  const quote = await data.base({ venue: 'base' });
  assert.ok(Math.abs(Number(quote.price) - 2000) < 0.0001);
  assert.equal(quote.quality, 'sampled-pool-price-no-traded-volume');
  await assert.rejects(
    data.base({ venue: 'base', pool: '0x' + 'd'.repeat(40) }),
    /BASE_POOL_NOT_CANONICAL/,
  );
  await assert.rejects(data.base({ venue: 'base', poolFee: 0 }), /BASE_POOL_FEE_RANGE/);
  reorg = true;
  await assert.rejects(data.base({ venue: 'base' }), /REORGED/);
});
