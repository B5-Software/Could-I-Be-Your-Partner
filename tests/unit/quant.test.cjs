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
const { runWalkForward } = require('../../src/main/services/quant/walk-forward');

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
const walkConfig = {
  trainBars: 8,
  testBars: 4,
  folds: 2,
  fastPeriods: [3, 2],
  slowPeriods: [5, 4],
};
const walkBars = () => Array.from({ length: 18 }, (_, i) => bar(60 * (i + 1), 100 + i * 10));

test('walk-forward fits only past data, fills at the next open and carries one test portfolio', () => {
  const candles = walkBars();
  const result = runWalkForward(candles, walkConfig);
  assert.equal(result.walkForward.discardedPrefixBars, 2);
  const [first, second] = result.walkForward.windows;
  assert.equal(first.training.start, candles[2].time);
  assert.equal(first.training.end, candles[9].time);
  assert.equal(first.testing.start, candles[10].time);
  assert.equal(first.testing.end, candles[13].time);
  assert.equal(second.training.end, first.testing.end);
  assert.equal(second.testing.start, candles[14].time);
  assert.equal(result.equity.length, 8);
  assert.equal(result.metrics.bars, 8);
  assert.deepEqual(result.config.fastPeriods, [2, 3]);
  assert.deepEqual(result.config.slowPeriods, [4, 5]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].fold, 1);
  assert.equal(result.trades[0].time, first.testing.start);
  assert.equal(result.trades[0].signalTime, first.training.end);
  assert.equal(result.trades[0].price, '200.1');
  assert.equal(result.metrics.fees, result.trades[0].fee);
  assert.equal(first.metrics.position, second.metrics.position);
  assert.ok(second.metrics.returnPct > 0);
  assert.equal(second.metrics.fills, 0);

  const changed = runWalkForward(
    candles.map((row, i) => (i < 10 ? row : bar(row.time, 60 - i))),
    walkConfig,
  );
  assert.deepEqual(changed.walkForward.windows[0].trainingScores, first.trainingScores);
  assert.deepEqual(changed.walkForward.windows[0].selected, first.selected);
  assert.notEqual(changed.metrics.returnPct, result.metrics.returnPct);
  const tied = runWalkForward(
    candles.map((row) => bar(row.time, 100)),
    walkConfig,
  );
  assert.deepEqual(tied.walkForward.windows[0].selected, { fast: 2, slow: 4 });
  assert.throws(() => runWalkForward(candles.slice(-15), walkConfig), /WALK_FORWARD_MORE_CANDLES/);
  assert.throws(
    () => runWalkForward(candles, { ...walkConfig, fastPeriods: [3, 3], slowPeriods: [4] }),
    /WALK_FORWARD_GRID/,
  );
});

test('walk-forward worker saves verifiable owned evidence and skips cancelled experiments', async (t) => {
  const { service, directory } = fixture(t);
  const w = await service.request('workspace.create', {});
  const dataset = await service.request('dataset.import', {
    id: w.id,
    text: JSON.stringify(walkBars()),
  });
  const input = { id: w.id, datasetId: dataset.id, config: walkConfig };
  const controller = new AbortController();
  const pending = service.request('run.walk-forward', input, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(service.workspace(w.id).runs.length, 0);
  const result = await service.request('run.walk-forward', input);
  assert.equal(result.codeVersion, 'candle-walk-forward-1');
  assert.ok(result.integrity);
  const reopened = new QuantService({ directory });
  t.after(() => reopened.dispose());
  const request = { id: w.id, runId: result.id, fold: 2 };
  assert.deepEqual(
    await reopened.request('run.walk-forward.fold', request),
    result.walkForward.windows[1],
  );
  await assert.rejects(
    reopened.request('run.walk-forward.fold', { ...request, fold: 0 }),
    /WALK_FORWARD_FOLD/,
  );
  const other = await reopened.request('workspace.create', {});
  await assert.rejects(
    reopened.request('run.walk-forward.fold', { ...request, id: other.id }),
    /RUN_NOT_IN_WORKSPACE/,
  );
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
test('holdings use one canonical block, preserve uint256 precision and keep unavailable token balances distinct from zero', async () => {
  const chain = CHAINS.base;
  const block = { number: '0x123', hash: '0x' + 'a'.repeat(64), timestamp: '0x100' };
  const custom = '0x' + '3'.repeat(40),
    failed = '0x' + '4'.repeat(40);
  let canonical = block;
  const data = new MarketData();
  data.rpc = async (_chain, _url, method, params) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') return params[0] === 'latest' ? block : canonical;
    assert.deepEqual(params[1], { blockHash: block.hash, requireCanonical: true });
    if (method === 'eth_getBalance') return '0x100000000000000000';
    assert.equal(method, 'eth_call');
    if (params[0].to === failed) throw Error('fixture RPC failure');
    if (params[0].data === '0x313ce567') throw Error('optional decimals unavailable');
    return '0x' + 'f'.repeat(64);
  };
  const read = () =>
    data.tokenHoldings(
      { venue: 'base' },
      { address: '0x' + '2'.repeat(40), tokens: [custom, failed, custom] },
    );
  const snapshot = await read();
  assert.equal(snapshot.assets.length, 5);
  assert.equal(snapshot.assets[0].amountAtomic, String(0x100000000000000000n));
  assert.equal(snapshot.assets[1].symbol, 'USDC');
  assert.equal(snapshot.assets[3].amountAtomic, String((1n << 256n) - 1n));
  assert.equal(snapshot.assets[3].amount, null);
  assert.equal(snapshot.assets[3].metadataError, 'WALLET_ASSET_DECIMALS_UNAVAILABLE');
  assert.equal(snapshot.assets[4].amountAtomic, null);
  assert.equal(snapshot.assets[4].error, 'WALLET_ASSET_UNAVAILABLE');
  canonical = { ...block, hash: '0x' + 'b'.repeat(64) };
  await assert.rejects(read(), /BLOCK_REORG/);
  assert.equal(chain.id, snapshot.chainId);
});
test('portfolio holdings share one block, bound RPC concurrency and retain incomplete totals without losing known amounts', async () => {
  const members = [1, 2, 3].map((value) => ({
    walletId: 'wallet-' + value,
    address: '0x' + String(value).repeat(40),
  }));
  const custom = '0x' + '4'.repeat(40);
  const block = { number: '0x123', hash: '0x' + 'a'.repeat(64), timestamp: '0x100' };
  let canonical = block,
    active = 0,
    maximum = 0,
    decimalsReads = 0;
  const data = new MarketData();
  data.rpc = async (_chain, _url, method, params) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getBlockByNumber') return params[0] === 'latest' ? block : canonical;
      assert.deepEqual(params[1], { blockHash: block.hash, requireCanonical: true });
      if (method === 'eth_getBalance') {
        if (params[0] === members[1].address) throw Error('fixture native balance failure');
        return '0xde0b6b3a7640000';
      }
      assert.equal(method, 'eth_call');
      if (params[0].data === '0x313ce567') {
        decimalsReads++;
        return '0x' + '0'.repeat(64);
      }
      const owner = '0x' + params[0].data.slice(-40);
      if (params[0].to === CHAINS.base.usdc && owner === members[1].address) return '0x';
      const value = params[0].to === custom ? (1n << 256n) - 1n : 1250000n;
      return '0x' + value.toString(16).padStart(64, '0');
    } finally {
      active--;
    }
  };
  const read = () => data.portfolioHoldings({ venue: 'base' }, { members, tokens: [custom] });
  const snapshot = await read();
  assert.ok(maximum <= 4);
  assert.equal(decimalsReads, 1);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.assets[0].amountAtomic, null);
  assert.equal(snapshot.assets[0].knownAmountAtomic, '2000000000000000000');
  assert.equal(snapshot.assets[1].amountAtomic, null);
  assert.equal(snapshot.assets[1].knownAmountAtomic, '2500000');
  assert.equal(snapshot.assets[1].knownAmount, '2.5');
  assert.deepEqual(snapshot.assets[1].missingWalletIds, ['wallet-2']);
  assert.equal(snapshot.assets[3].amountAtomic, String(3n * ((1n << 256n) - 1n)));
  assert.equal(snapshot.assets[3].amount, snapshot.assets[3].amountAtomic);
  assert.ok(snapshot.members.every((member) => member.blockHash === snapshot.blockHash));
  canonical = { ...block, hash: '0x' + 'b'.repeat(64) };
  await assert.rejects(read(), /BLOCK_REORG/);
});
test('ERC-20 allowance stays exact, pins the read block and rejects malformed data or a reorg', async () => {
  const chain = CHAINS['base-sepolia'];
  const owner = '0x' + '1'.repeat(40);
  const spender = '0x' + '2'.repeat(40);
  const block = { number: '0x123', hash: '0x' + 'a'.repeat(64), timestamp: '0x100' };
  let result = '0x' + 'f'.repeat(64),
    canonical = block;
  const data = new MarketData();
  data.rpc = async (_chain, _url, method, params) => {
    if (method === 'eth_chainId') return '0x14a34';
    if (method === 'eth_getBlockByNumber') return params[0] === 'latest' ? block : canonical;
    assert.equal(method, 'eth_call');
    assert.deepEqual(params, [
      {
        to: require('ethers').getAddress(chain.usdc),
        data: '0xdd62ed3e' + owner.slice(2).padStart(64, '0') + spender.slice(2).padStart(64, '0'),
      },
      { blockHash: block.hash, requireCanonical: true },
    ]);
    return result;
  };
  const read = () =>
    data.tokenAllowance({ venue: 'base-sepolia' }, { address: owner, token: chain.usdc, spender });
  const observed = await read();
  assert.equal(observed.chainId, 84532);
  assert.equal(observed.amountAtomic, String((1n << 256n) - 1n));
  assert.equal(observed.unlimited, true);
  assert.equal(observed.blockHash, block.hash);
  canonical = { ...block, hash: '0x' + 'b'.repeat(64) };
  await assert.rejects(read(), /BLOCK_REORG/);
  result = '0x';
  await assert.rejects(read(), /INVALID_CONTRACT_RESPONSE/);
});
test('ERC-20 approval discovery deduplicates events and pins paged results to their window', async () => {
  const { Interface } = require('ethers');
  const abi = new Interface([
    'event Approval(address indexed owner,address indexed spender,uint256 amount)',
  ]);
  const owner = '0x' + '1'.repeat(40);
  const spender = '0x' + '2'.repeat(40);
  const other = '0x' + '3'.repeat(40);
  const token = '0x' + '4'.repeat(40);
  const head = { number: '0x6', hash: '0x' + 'a'.repeat(64), timestamp: '0x100' };
  let canonical = head;
  const event = (destination, amount, at, logIndex) => ({
    ...abi.encodeEventLog('Approval', [owner, destination, amount]),
    address: token,
    blockNumber: at,
    blockHash: head.hash,
    transactionHash: '0x' + 'b'.repeat(64),
    logIndex,
    removed: false,
  });
  const nft = event(other, 7n, '0x6', '0x4');
  nft.topics.push(nft.data);
  nft.data = '0x';
  const market = new MarketData();
  market.rpc = async (_chain, _url, method, args) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') return args[0] === 'latest' ? head : canonical;
    assert.equal(method, 'eth_getLogs');
    assert.deepEqual(args, [{ fromBlock: '0x4', toBlock: '0x6', topics: nft.topics.slice(0, 2) }]);
    return [
      event(spender, 900n, '0x4', '0x0'),
      nft,
      event(other, 700n, '0x6', '0x1'),
      event(spender, 0n, '0x6', '0x2'),
    ];
  };
  const scan = (cursor) =>
    market.discoverTokenApprovals(
      { venue: 'base' },
      { address: owner, blocks: 3, limit: 1, ...cursor },
    );
  const first = await scan();
  assert.equal(first.total, 2);
  assert.equal(first.items[0].spender, spender);
  assert.equal(first.items[0].eventAmountAtomic, '0');
  assert.equal(first.nextOffset, 1);
  assert.equal(first.nextEndBlock, '3');
  const cursor = {
    endBlock: first.toBlock,
    anchorHash: first.anchorHash,
    offset: first.nextOffset,
  };
  assert.equal((await scan(cursor)).items[0].spender, other);
  await assert.rejects(scan({ offset: 1 }), /WALLET_APPROVAL_SCAN_RANGE/);
  canonical = { ...head, hash: '0x' + 'c'.repeat(64) };
  await assert.rejects(scan(cursor), /BLOCK_REORG/);
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
