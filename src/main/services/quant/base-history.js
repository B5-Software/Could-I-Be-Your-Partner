/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { CHAINS } = require('./market-data');
const { historySource, scanSwaps, blockAtOrAfter, scanBlocks } = require('./vwap-profile');

const SOURCE = 'base-finalized-uniswap-v3-swaps';
const MAX_SECONDS = 21600;
const BASE_PUBLIC_HISTORY = 'https://base-rpc.publicnode.com';
const hex = (number) => '0x' + number.toString(16);
const abs = (amount) => (amount < 0n ? -amount : amount);
const price = ({ weth, usdc }) => Number((usdc * 10n ** 24n + weth / 2n) / weth) / 1e12;
const above = (a, b) => a.usdc * b.weth > b.usdc * a.weth;

function captureWindow(interval) {
  const maxCount = Math.floor(MAX_SECONDS / interval);
  return { maxCount, defaultCount: Math.min(maxCount, Math.max(1, Math.floor(900 / interval))) };
}

async function captureHistory(market, config, input, previous, signal) {
  try {
    return await captureFromRpc(market, config, input, previous, signal);
  } catch (error) {
    if (
      config.rpcUrl ||
      config.venue !== 'base' ||
      error.message !== 'EXECUTION_PROFILE_RATE_LIMIT'
    )
      throw error;
    signal?.throwIfAborted();
    // Start over so the archive is always assembled from one provider's finalized view.
    return captureFromRpc(
      market,
      { ...config, rpcUrl: BASE_PUBLIC_HISTORY },
      input,
      previous,
      signal,
    );
  }
}

async function captureFromRpc(market, config, input, previous, signal) {
  if (!CHAINS[config.venue]) throw Error('BASE_HISTORY_VENUE');
  const interval = config.interval;
  const count = input.count ?? captureWindow(interval).defaultCount;
  if (!Number.isSafeInteger(count) || count < 1 || count * interval > MAX_SECONDS)
    throw Error('BASE_HISTORY_RANGE');
  if (
    input.endTime !== undefined &&
    (previous || !Number.isSafeInteger(input.endTime) || input.endTime % interval !== 0)
  )
    throw Error('BASE_HISTORY_RANGE');
  if (previous && (previous.interval !== interval || previous.fee !== config.poolFee))
    throw Error('BASE_HISTORY_SOURCE_CHANGED');

  const { chain, rpc, header, finalized } = await historySource(market, config, signal);
  if (finalized.time > Math.floor(Date.now() / 1000) + 120) throw Error('MARKET_CLOCK_SKEW');
  if (previous && previous.chainId !== chain.id) throw Error('BASE_HISTORY_SOURCE_CHANGED');
  const closed = Math.floor(finalized.time / interval) * interval;
  const startedThrough =
    input.recordingStartedAt === undefined
      ? closed
      : Math.floor(input.recordingStartedAt / (interval * 1000)) * interval;
  const endTime = previous
    ? Math.min(closed, previous.endTime + count * interval)
    : (input.endTime ?? Math.min(closed, startedThrough));
  const startTime = previous?.endTime ?? endTime - count * interval;
  if (endTime > closed || startTime < 0) throw Error('BASE_HISTORY_RANGE');
  if (endTime <= startTime) throw Error('BASE_HISTORY_UP_TO_DATE');
  if (input.completeWindow && endTime - startTime < count * interval)
    throw Error('BASE_HISTORY_UP_TO_DATE');

  // Most captures are recent. Older explicit windows need an archival RPC.
  let lower =
    previous?.boundary ?? (await header(hex(Math.max(0, finalized.number - scanBlocks + 1))));
  if (previous) {
    const canonical = await header(hex(lower.number));
    if (
      canonical.hash !== lower.hash ||
      canonical.time !== lower.time ||
      lower.number > finalized.number
    )
      throw Error('EXECUTION_PROFILE_CHANGED');
  } else if (lower.number && lower.time >= endTime) {
    lower = await header('0x0');
  }
  const boundary = await blockAtOrAfter(header, lower, finalized, endTime);
  if (!boundary) throw Error('BASE_HISTORY_RANGE');
  const last = boundary.number ? await header(hex(boundary.number - 1)) : null;
  let first = null;
  if (last && last.time >= startTime) {
    const low =
      previous?.boundary ?? (await header(hex(Math.max(0, last.number - scanBlocks + 1))));
    if (!previous && low.number && low.time >= startTime) throw Error('EXECUTION_PROFILE_LIMIT');
    first = await blockAtOrAfter(header, low, last, startTime);
  }
  if (last && last.time >= endTime) throw Error('EXECUTION_PROFILE_HISTORY');
  const { pool, token0 } = await market.basePool(config, chain, (to, data) =>
    rpc('eth_call', [{ to, data }, hex(boundary.number)]),
  );
  if (previous && previous.pool !== pool) throw Error('BASE_HISTORY_SOURCE_CHANGED');

  const trades = [];
  const buckets = new Map();
  if (first)
    await scanSwaps(rpc, header, pool, first, last, (block, log) => {
      if (
        block.time < startTime ||
        block.time >= endTime ||
        typeof log.transactionHash !== 'string' ||
        !/^0x[\da-f]{64}$/i.test(log.transactionHash)
      )
        throw Error('BASE_HISTORY_TRADE');
      const wethDelta = token0 === chain.weth ? log.amount0 : log.amount1;
      const usdcDelta = token0 === chain.weth ? log.amount1 : log.amount0;
      if (wethDelta * usdcDelta > 0n) throw Error('BASE_HISTORY_TRADE');
      const weth = abs(wethDelta),
        usdc = abs(usdcDelta);
      const side = weth && usdc ? (wethDelta < 0n ? 'buy' : 'sell') : null;
      trades.push({
        block: block.number,
        blockHash: block.hash,
        logIndex: log.logIndex,
        time: block.time,
        transactionHash: log.transactionHash.toLowerCase(),
        wethDeltaAtoms: String(wethDelta),
        usdcDeltaAtoms: String(usdcDelta),
        side,
      });
      if (!side) return;
      const time = Math.floor(block.time / interval) * interval;
      const trade = { weth, usdc };
      const bucket = buckets.get(time) ?? {
        open: trade,
        high: trade,
        low: trade,
        weth: 0n,
        usdc: 0n,
        count: 0,
      };
      if (above(trade, bucket.high)) bucket.high = trade;
      if (above(bucket.low, trade)) bucket.low = trade;
      bucket.close = trade;
      bucket.weth += weth;
      bucket.usdc += usdc;
      bucket.count++;
      buckets.set(time, bucket);
    });
  for (const block of new Map(
    [first, boundary, finalized].filter(Boolean).map((item) => [item.number, item]),
  ).values()) {
    const canonical = await header(hex(block.number));
    if (canonical.hash !== block.hash || canonical.time !== block.time)
      throw Error('EXECUTION_PROFILE_CHANGED');
  }

  const candles = [];
  const volumes = [];
  for (const [time, bucket] of buckets) {
    candles.push({
      time,
      open: price(bucket.open),
      high: price(bucket.high),
      low: price(bucket.low),
      close: price(bucket.close),
      volume: Number(bucket.weth) / 1e18,
    });
    volumes.push({
      time,
      wethVolumeAtoms: String(bucket.weth),
      usdcVolumeAtoms: String(bucket.usdc),
      count: bucket.count,
    });
  }
  return {
    candles,
    amm: {
      chainId: chain.id,
      pool,
      fee: config.poolFee,
      interval,
      startTime,
      endTime,
      firstBlock: first,
      lastBlock: first ? last : null,
      boundary,
      previousDatasetId: input.afterDatasetId ?? null,
      swapCount: trades.length,
      volumes,
      trades,
    },
  };
}

module.exports = { SOURCE, captureWindow, captureHistory };
