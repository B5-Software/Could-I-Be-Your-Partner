/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Interface } = require('ethers');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { captureHistory } = require('../../src/main/services/quant/base-history');
const { QuantService } = require('../../src/main/services/quant');
const { BaseHistoryRecorder } = require('../../src/main/services/quant/base-history-recorder');
const { buildSeries } = require('../../src/main/services/quant/base-history-series');
const { quoteAbi, deployments } = require('../../src/main/services/quant/base-swap');

const origin = 1700000040;
const config = { venue: 'base', interval: 60, poolFee: 500 };
const pool = '0x' + 'a'.repeat(40);
const hex = (value) => '0x' + value.toString(16);
const hash = (value) => '0x' + value.toString(16).padStart(64, '0');
const swap = new Interface([
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);

function fixture() {
  const timestamps = [
    -60, 0, 0, 59, 60, 60, 119, 120, 179, 180, 181, 239, 240, 241, 299, 300, 359, 360, 361,
  ];
  const trade = (block, index, weth, usdc) => ({
    ...swap.encodeEventLog('Swap', [pool, pool, usdc * 10n ** 6n, weth * 10n ** 18n, 1n, 1n, 0]),
    address: pool,
    blockNumber: hex(block),
    blockHash: hash(block),
    transactionHash: hash(100 + block),
    logIndex: hex(index),
    ...(block % 2 && { blockTimestamp: hex(origin + timestamps[block]) }),
  });
  const logs = [
    trade(12, 0, 1n, -2000n),
    trade(9, 0, 1n, -1900n),
    trade(6, 0, 0n, 1n),
    trade(5, 0, 2n, -4400n),
    trade(2, 0, 1n, -2100n),
    trade(1, 3, -2n, 4000n),
    trade(1, 1, 1n, -1800n),
    trade(0, 0, 1n, -2500n),
  ];
  return {
    logs,
    timestamps,
    changedBlock: null,
    head: 13,
    maxBlocksPerQuery: 1000,
    ranges: [],
    basePool: async () => ({ pool, token0: CHAINS.base.usdc }),
    async rpc(_venue, _rpcUrl, method, params) {
      if (method === 'eth_chainId') return hex(8453);
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'finalized' ? this.head : Number(params[0]);
        return {
          number: hex(number),
          hash: hash(number + (number === this.changedBlock ? 50 : 0)),
          timestamp: hex(origin + timestamps[number]),
        };
      }
      assert.equal(method, 'eth_getLogs');
      const { fromBlock, toBlock } = params[0];
      this.ranges.push([Number(fromBlock), Number(toBlock)]);
      if (Number(toBlock) - Number(fromBlock) + 1 > this.maxBlocksPerQuery)
        throw Error('MARKET_HTTP_413');
      return this.logs.filter(
        (row) =>
          Number(row.blockNumber) >= Number(fromBlock) &&
          Number(row.blockNumber) <= Number(toBlock),
      );
    },
  };
}

test('finalized Base tape orders swaps by block and log index, and leaves empty intervals empty', async () => {
  const market = fixture();
  market.maxBlocksPerQuery = 3;
  const { candles, amm } = await captureHistory(market, config, {
    count: 3,
    endTime: origin + 180,
  });
  assert.deepEqual(market.ranges, [
    [1, 8],
    [1, 4],
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 8],
  ]);
  assert.deepEqual(candles, [
    { time: origin, open: 1800, high: 2100, low: 1800, close: 2100, volume: 4 },
    { time: origin + 60, open: 2200, high: 2200, low: 2200, close: 2200, volume: 2 },
  ]);
  assert.deepEqual(amm.volumes, [
    {
      time: origin,
      wethVolumeAtoms: '4000000000000000000',
      usdcVolumeAtoms: '7900000000',
      count: 3,
    },
    {
      time: origin + 60,
      wethVolumeAtoms: '2000000000000000000',
      usdcVolumeAtoms: '4400000000',
      count: 1,
    },
  ]);
  assert.deepEqual(
    amm.trades.map((t) => [t.block, t.logIndex, t.side]),
    [
      [1, 1, 'sell'],
      [1, 3, 'buy'],
      [2, 0, 'sell'],
      [5, 0, 'sell'],
      [6, 0, null],
    ],
  );
  assert.equal(amm.boundary.number, 9);
  const next = await captureHistory(market, config, { count: 3, afterDatasetId: 'previous' }, amm);
  assert.equal(next.amm.startTime, amm.endTime);
  assert.equal(next.amm.previousDatasetId, 'previous');
  assert.equal(next.amm.endTime, origin + 240);
  assert.deepEqual(
    next.amm.trades.map((row) => row.block),
    [9],
  );
  await assert.rejects(captureHistory(market, config, {}, next.amm), /BASE_HISTORY_UP_TO_DATE/);
  market.head = 12;
  assert.deepEqual(await captureHistory(market, config, { count: 3, endTime: origin + 180 }), {
    candles,
    amm,
  });
  const empty = await captureHistory(market, config, { count: 1, endTime: origin + 180 });
  assert.deepEqual(empty.candles, []);
  assert.equal(empty.amm.swapCount, 0);
  const delayedFirstCapture = await captureHistory(market, config, {
    count: 2,
    recordingStartedAt: (origin + 195) * 1000,
  });
  assert.equal(delayedFirstCapture.amm.endTime, origin + 180);
});

test('Base tape fails closed on changed continuation anchors, malformed trades and invalid ranges', async () => {
  const market = fixture();
  const { amm } = await captureHistory(market, config, { count: 3, endTime: origin + 180 });
  market.changedBlock = amm.boundary.number;
  await assert.rejects(captureHistory(market, config, {}, amm), /EXECUTION_PROFILE_CHANGED/);
  market.changedBlock = null;
  delete market.logs[1].transactionHash;
  await assert.rejects(captureHistory(market, config, {}, amm), /BASE_HISTORY_TRADE/);
  await assert.rejects(captureHistory(market, config, { count: 361 }), /BASE_HISTORY_RANGE/);
  await assert.rejects(
    captureHistory(market, config, { endTime: origin + 181 }),
    /BASE_HISTORY_RANGE/,
  );
  await assert.rejects(
    captureHistory(market, { ...config, poolFee: 3000 }, {}, amm),
    /BASE_HISTORY_SOURCE_CHANGED/,
  );
});

test('default Base history restarts at the fallback provider after rate limiting; explicit RPC stays pinned', async () => {
  const market = fixture();
  const rpc = market.rpc.bind(market);
  const calls = [];
  market.rpc = async (...args) => {
    calls.push([args[1], args[2]]);
    if (args[1] !== 'https://base-rpc.publicnode.com' && args[2] === 'eth_getLogs')
      throw Error('EXECUTION_PROFILE_RATE_LIMIT');
    return rpc(...args);
  };
  const input = { count: 1, endTime: origin + 60 };
  const result = await captureHistory(market, config, input);
  assert.equal(result.amm.swapCount, 3);
  assert.deepEqual(
    calls.find(([url]) => url),
    ['https://base-rpc.publicnode.com', 'eth_chainId'],
  );
  calls.length = 0;
  const rpcUrl = 'https://fixture.rpc';
  await assert.rejects(
    captureHistory(market, { ...config, rpcUrl }, input),
    /EXECUTION_PROFILE_RATE_LIMIT/,
  );
  assert.ok(calls.every(([url]) => url === rpcUrl));
});

function recordingFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-amm-recorder-'));
  const market = fixture();
  let service;
  const restart = () => {
    service?.dispose();
    service = new QuantService({ directory });
    service.market = market;
    return service;
  };
  t.after(() => {
    service.dispose();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-amm-recorder-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { market, directory, restart, service: restart() };
}

test('automatic recording waits for complete windows, commits a durable cursor, and pauses on an invalid anchor', async (t) => {
  const { directory, market, restart, service } = recordingFixture(t);
  const { id } = await service.request('workspace.create', { venue: 'base' });
  await service.request('workspace.update', { id, market: { interval: 60 } });
  assert.equal(BaseHistoryRecorder.shouldStart(directory), false);
  const start = await service.request('base.history.record.start', { id, count: 2 });
  assert.equal(start.phase, 'waiting');
  await service.baseRecorder.capture(id);
  const first = await service.request('base.history.record.status', { id });
  assert.equal(first.batches, 1);
  assert.equal(first.endTime, origin + 240);
  assert.equal(BaseHistoryRecorder.shouldStart(directory), true);
  const resumed = restart();
  await resumed.baseRecorder.capture(id);
  assert.equal(
    (await resumed.request('base.history.record.status', { id })).datasetId,
    first.datasetId,
  );
  market.head = 15;
  await resumed.baseRecorder.capture(id);
  assert.equal((await resumed.request('base.history.record.status', { id })).batches, 1);
  market.head = 18;
  await resumed.baseRecorder.capture(id);
  const second = await resumed.request('base.history.record.status', { id });
  assert.equal(second.batches, 2);
  assert.equal(second.endTime, origin + 360);
  const archive = await resumed.request('dataset.get', { id, datasetId: second.datasetId });
  assert.equal(archive.amm.startTime, first.endTime);
  assert.equal(archive.amm.previousDatasetId, first.datasetId);
  const workspace = await resumed.request('workspace.get', { id });
  assert.equal(workspace.preferences.datasetId, null);

  const rpc = market.rpc.bind(market);
  market.rpc = async () => {
    throw Error('MARKET_CONNECTION_FAILED');
  };
  await resumed.baseRecorder.capture(id);
  const failed = await resumed.request('base.history.record.status', { id });
  assert.equal(failed.phase, 'retrying');
  assert.equal(failed.datasetId, second.datasetId);
  assert.equal(failed.failures, 1);
  market.rpc = rpc;
  market.timestamps.push(419, 420, 479, 480, 481);
  market.head = market.timestamps.length - 1;
  await resumed.baseRecorder.capture(id);
  const empty = await resumed.request('base.history.record.status', { id });
  assert.equal(empty.endTime, origin + 480);
  const emptyArchive = await resumed.request('dataset.get', { id, datasetId: empty.datasetId });
  assert.deepEqual(emptyArchive.candles, []);
  assert.equal(emptyArchive.amm.previousDatasetId, second.datasetId);
  market.timestamps.push(539, 540, 599, 600, 601);
  market.head = market.timestamps.length - 1;
  market.changedBlock = emptyArchive.amm.boundary.number;
  await resumed.baseRecorder.capture(id);
  const paused = await resumed.request('base.history.record.status', { id });
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.lastError, 'EXECUTION_PROFILE_CHANGED');
  assert.equal(paused.datasetId, empty.datasetId);
  assert.equal(BaseHistoryRecorder.shouldStart(directory), false);
  await resumed.request('workspace.update', { id, market: { interval: 300 } });
  await assert.rejects(
    resumed.request('base.history.record.start', { id, resume: true }),
    /BASE_HISTORY_SOURCE_CHANGED/,
  );
});

test('pausing an active recording aborts its RPC and fences a late result', async (t) => {
  const { service, market } = recordingFixture(t);
  const { id } = await service.request('workspace.create', { venue: 'base' });
  await service.request('workspace.update', { id, market: { interval: 60 } });
  await service.request('base.history.record.start', { id, count: 1 });
  const received = Promise.withResolvers(),
    reply = Promise.withResolvers();
  const rpc = market.rpc.bind(market);
  market.rpc = async (...args) => {
    if (args[2] === 'eth_getLogs') {
      received.resolve(args[4].signal);
      await reply.promise;
    }
    return rpc(...args);
  };
  const late = service.baseRecorder.capture(id);
  const signal = await received.promise;
  const stopped = await service.request('base.history.record.stop', { id });
  assert.equal(stopped.phase, 'paused');
  assert.equal(signal.aborted, true);
  reply.resolve();
  await late;
  assert.equal((await service.request('workspace.get', { id })).datasets.length, 0);
  market.rpc = rpc;
  await service.request('base.history.record.start', { id, resume: true });
  await service.baseRecorder.capture(id);
  assert.equal((await service.request('base.history.record.status', { id })).batches, 1);
  await service.request('workspace.update', { id, market: { interval: 60 } });
  assert.equal((await service.request('base.history.record.status', { id })).phase, 'waiting');
  await service.request('workspace.update', { id, market: { interval: 300 } });
  assert.equal(
    (await service.request('base.history.record.status', { id })).pauseReason,
    'market-changed',
  );
});

test('linked Base segments pin a clipped, reproducible research dataset with real gaps', async (t) => {
  const { market, restart, service } = recordingFixture(t);
  const { id } = await service.request('workspace.create', { venue: 'base' });
  await service.request('workspace.update', { id, market: { interval: 60 } });
  const first = await service.request('base.history.capture', {
    id,
    count: 3,
    endTime: origin + 180,
  });
  market.head = 18;
  const last = await service.request('base.history.capture', {
    id,
    count: 3,
    afterDatasetId: first.id,
  });
  const input = { id, datasetId: last.id, windows: 5, select: true };
  const pinned = await service.request('base.history.series', input);
  assert.deepEqual(pinned.series, {
    interval: 60,
    segmentCount: 2,
    gaps: 2,
    slots: 5,
    requestedStart: origin + 60,
  });
  assert.equal(pinned.count, 3);
  assert.deepEqual(await service.request('base.history.series', input), pinned);
  const requestedMore = await service.request('base.history.series', {
    ...input,
    windows: 12,
    select: false,
  });
  assert.equal(requestedMore.start, origin);
  assert.equal(requestedMore.series.requestedStart, origin - 360);
  const restored = restart();
  const loaded = await restored.request('dataset.get', { id, datasetId: pinned.id });
  assert.deepEqual(loaded.series.segments, [
    { id: first.id, startTime: origin + 60, endTime: origin + 180 },
    { id: last.id, startTime: origin + 180, endTime: origin + 360 },
  ]);
  assert.deepEqual(loaded.series.emptyRanges, [
    { startTime: origin + 120, endTime: origin + 180 },
    { startTime: origin + 300, endTime: origin + 360 },
  ]);
  assert.deepEqual(
    loaded.candles.map((bar) => bar.time),
    [origin + 60, origin + 180, origin + 240],
  );
  const run = await restored.request('run.backtest', { id, config: { strategy: 'buy-hold' } });
  assert.equal(run.datasetId, pinned.id);
  assert.equal(run.dataSource, 'base-finalized-uniswap-v3-series');
  assert.equal(run.provenance.pool, pool);
  assert.deepEqual(run.dataSeries, loaded.series);
  assert.equal(run.trades[0].emptyIntervalsBeforeFill, 1);
  assert.deepEqual(
    run.trades.map(({ signalTime, time }) => [signalTime, time]),
    [[origin + 60, origin + 180]],
  );
  assert.ok(run.assumptions.includes('signals-fill-at-next-observed-open-across-empty-intervals'));
  assert.deepEqual(await restored.request('run.get', { id, runId: run.id }), run);
  const other = await restored.request('workspace.create', { venue: 'base' });
  await assert.rejects(
    restored.request('base.history.series', { ...input, id: other.id }),
    /DATASET_NOT_IN_WORKSPACE/,
  );
  await assert.rejects(
    restored.request('base.history.trades', { id, datasetId: pinned.id }),
    /BASE_HISTORY_SOURCE_CHANGED/,
  );
  fs.writeFileSync(restored.datasetFile(first.id), '{"corrupt":true}');
  await assert.rejects(restored.request('base.history.series', input), /DATASET_HASH_MISMATCH/);
  assert.deepEqual(await restored.request('dataset.get', { id, datasetId: pinned.id }), loaded);
});

test('a Base series rejects an inconsistent archive checkpoint', async () => {
  const market = fixture();
  const first = await captureHistory(market, config, { count: 3, endTime: origin + 180 });
  const later = await captureHistory(
    market,
    config,
    { count: 1, afterDatasetId: 'first' },
    first.amm,
  );
  const archives = new Map([
    ['first', first],
    ['later', later],
  ]);
  later.amm.firstBlock = { ...later.amm.firstBlock, hash: hash(9999) };
  await assert.rejects(
    buildSeries('later', 4, async (id) => ({
      data: { ...archives.get(id), market: config, source: 'base-finalized-uniswap-v3-swaps' },
      bytes: 10,
    })),
    /BASE_SERIES_DISCONTINUITY/,
  );
});

test('AMM replay uses the last observed signal in a block, quotes only later canonical blocks and preserves rejection evidence', async (t) => {
  const { market, service } = recordingFixture(t);
  const { id } = await service.request('workspace.create', { venue: 'base' });
  await service.request('workspace.update', { id, market: { interval: 60 } });
  const tape = await service.request('base.history.capture', {
    id,
    count: 3,
    endTime: origin + 180,
  });
  const calls = [],
    oldRpc = market.rpc.bind(market),
    sqrt = 1771595571142957102961017161607260n;
  market.rpc = async (...args) => {
    if (args[2] !== 'eth_call') return oldRpc(...args);
    const [request, block] = args[3];
    assert.equal(block.requireCanonical, true);
    if (request.to === pool) return hash(sqrt) + '0'.repeat(6 * 64);
    assert.equal(request.to, deployments.base.quoter);
    const [swap] = quoteAbi.decodeFunctionData('quoteExactInputSingle', request.data);
    calls.push({ block, in: swap.amountIn });
    return quoteAbi.encodeFunctionResult('quoteExactInputSingle', [10n ** 16n, sqrt, 4, 90000]);
  };
  const input = {
    id,
    datasetId: tape.id,
    config: { initialCash: '100', fixedFeeUsdc: '1', delayBlocks: 2, maxAdverseBps: 10 },
  };
  const readyRpc = market.rpc;
  let finalizedReads = 0;
  market.rpc = (...args) => {
    if (args[2] === 'eth_getBlockByNumber' && args[3][0] === 'finalized' && ++finalizedReads === 1)
      return readyRpc(args[0], args[1], args[2], ['0x2', false], args[4]);
    return readyRpc(...args);
  };
  const run = await service.request('run.amm', input);
  assert.equal(finalizedReads, 2);
  assert.equal(run.metrics.fills, 0);
  assert.equal(run.metrics.cash, '100.0');
  assert.equal(run.ammReplay.attempts.length, 1);
  const [quote] = run.ammReplay.attempts;
  assert.deepEqual([quote.signal.block, quote.signal.logIndex, quote.execution.block], [1, 3, 5]);
  assert.equal(quote.status, 'adverse-price');
  assert.equal(quote.initializedTicksCrossed, 4);
  assert.deepEqual(calls, [
    { block: { blockHash: hash(5), requireCanonical: true }, in: 24750000n },
  ]);
  const page = await service.request('run.amm.attempts', { id, runId: run.id, limit: 1 });
  assert.deepEqual(page.items, [quote]);
  assert.equal(page.finalMark.equityUsdcAtoms, '100000000');
  market.changedBlock = 5;
  await assert.rejects(service.request('run.amm', input), /AMM_REPLAY_BLOCK_CHANGED/);
  assert.equal((await service.request('workspace.get', { id })).runs.length, 1);
  market.changedBlock = null;
  market.head = 18;
  const extended = await service.request('base.history.capture', {
    id,
    count: 5,
    endTime: origin + 300,
  });
  const quoteRpc = market.rpc;
  market.rpc = async (...args) => {
    if (args[2] === 'eth_call' && args[3][0].to === deployments.base.quoter) {
      const [swap] = quoteAbi.decodeFunctionData('quoteExactInputSingle', args[3][0].data);
      if (swap.tokenIn.toLowerCase() === CHAINS.base.weth)
        return quoteAbi.encodeFunctionResult('quoteExactInputSingle', [19000000n, sqrt, 3, 80000]);
    }
    return quoteRpc(...args);
  };
  const sma = await service.request('run.amm', {
    id,
    datasetId: extended.id,
    config: { strategy: 'sma-cross', fast: 2, slow: 3, initialCash: '100', fixedFeeUsdc: '1' },
  });
  assert.deepEqual(
    sma.ammReplay.attempts.map((row) => [row.side, row.signal.block, row.execution.block]),
    [
      ['buy', 2, 5],
      ['sell', 9, 12],
    ],
  );
  assert.equal(sma.metrics.position, '0.0');
  assert.equal(sma.metrics.fees, '2.0');
});
