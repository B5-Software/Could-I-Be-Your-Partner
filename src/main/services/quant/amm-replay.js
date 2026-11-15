/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { parseUnits, formatUnits } = require('ethers');
const { setTimeout: delay } = require('node:timers/promises');
const { deployments, quoteAbi } = require('./base-swap');
const { MAX_BYTES, validSegment, checkJoin } = require('./base-history-series');
const { historySource } = require('./vwap-profile');
const { historicalFee, readSlot0, MIN_SQRT, MAX_SQRT, Q192 } = require('./amm-replay-cost');

const CODE_VERSION = 'base-amm-replay-1';
const HISTORICAL_COST_VERSION = 'base-amm-replay-2';
const MAX_SWAPS = 100000;
const bps = 10000n;
const hex = (number) => '0x' + number.toString(16);
const abs = (amount) => (amount < 0n ? -amount : amount);

function replayParameters(input = {}) {
  const integer = (value, fallback, min, max) => {
    const n = value ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) throw Error('AMM_REPLAY_PARAMETERS');
    return n;
  };
  const money = (value) => {
    if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,6})?$/.test(value))
      throw Error('AMM_REPLAY_PARAMETERS');
    return formatUnits(parseUnits(value, 6), 6);
  };
  const strategy = input.strategy ?? 'buy-hold';
  if (!['buy-hold', 'sma-cross'].includes(strategy)) throw Error('AMM_REPLAY_PARAMETERS');
  const feeMode = input.feeMode ?? 'fixed';
  if (!['fixed', 'historical'].includes(feeMode)) throw Error('AMM_REPLAY_PARAMETERS');
  const config = {
    strategy,
    fast: integer(input.fast, 9, 2, 200),
    slow: integer(input.slow, 21, 3, 500),
    initialCash: money(input.initialCash ?? '10000'),
    feeMode,
    ...(feeMode === 'fixed'
      ? { fixedFeeUsdc: money(input.fixedFeeUsdc ?? '0') }
      : {
          networkFeeCapUsdc: money(input.networkFeeCapUsdc ?? '1'),
          routerOverheadGas: integer(input.routerOverheadGas, 55000, 21000, 500000),
          tipGwei: input.tipGwei ?? '0',
        }),
    allocationBps: integer(input.allocationBps, 2500, 1, 10000),
    delayBlocks: integer(input.delayBlocks, 1, 1, 10000),
    maxQuotes: integer(input.maxQuotes, 16, 1, 32),
    maxAdverseBps: input.maxAdverseBps == null ? null : integer(input.maxAdverseBps, 0, 0, 10000),
  };
  if (
    config.fast >= config.slow ||
    parseUnits(config.initialCash, 6) <=
      parseUnits(config.fixedFeeUsdc ?? config.networkFeeCapUsdc, 6) ||
    (feeMode === 'historical' &&
      (parseUnits(config.networkFeeCapUsdc, 6) <= 0n ||
        typeof config.tipGwei !== 'string' ||
        !/^\d{1,4}(?:\.\d{1,9})?$/.test(config.tipGwei)))
  )
    throw Error('AMM_REPLAY_PARAMETERS');
  return config;
}

async function loadTape(datasetId, dataset, load, minimumBlocks = 2) {
  const manifest = dataset.series?.segments ?? [
    { id: datasetId, startTime: dataset.amm?.startTime, endTime: dataset.amm?.endTime },
  ];
  if (!manifest.length || manifest.length > 512) throw Error('AMM_REPLAY_DATASET');
  const groups = [];
  let previous,
    first,
    bytes = 0,
    count = 0,
    last;
  for (const [index, entry] of manifest.entries()) {
    let data = dataset;
    if (!dataset.amm) {
      const loaded = await load(entry.id, MAX_BYTES - bytes);
      bytes += loaded.bytes;
      data = loaded.data;
    }
    const amm = validSegment(data);
    first ??= amm;
    if (previous) {
      if (amm.previousDatasetId !== manifest[index - 1].id) throw Error('AMM_REPLAY_DATASET');
      checkJoin(previous, amm);
    }
    if (
      entry.startTime < amm.startTime ||
      entry.endTime !== amm.endTime ||
      (index && entry.startTime !== amm.startTime) ||
      entry.startTime >= entry.endTime ||
      data.market.venue !== dataset.market.venue ||
      data.market.product !== dataset.market.product ||
      data.market.interval !== dataset.market.interval ||
      amm.trades.length !== amm.swapCount
    )
      throw Error('AMM_REPLAY_DATASET');
    for (const trade of amm.trades) {
      if (trade.time < entry.startTime) continue;
      if (++count > MAX_SWAPS) throw Error('AMM_REPLAY_TAPE_LIMIT');
      if (
        trade.time >= entry.endTime ||
        !Number.isSafeInteger(trade.block) ||
        !Number.isSafeInteger(trade.logIndex) ||
        !/^0x[\da-f]{64}$/.test(trade.blockHash) ||
        !/^0x[\da-f]{64}$/.test(trade.transactionHash) ||
        !Number.isSafeInteger(trade.time) ||
        trade.block < 0 ||
        trade.logIndex < 0 ||
        (last &&
          (trade.block < last.block ||
            trade.time < last.time ||
            (trade.block === last.block &&
              (trade.logIndex <= last.logIndex ||
                trade.blockHash !== last.blockHash ||
                trade.time !== last.time))))
      )
        throw Error('AMM_REPLAY_DATASET');
      last = trade;
      const weth = BigInt(trade.wethDeltaAtoms),
        usdc = BigInt(trade.usdcDeltaAtoms);
      if (weth * usdc > 0n) throw Error('AMM_REPLAY_DATASET');
      if (!weth || !usdc) continue;
      if (groups.at(-1)?.block !== trade.block)
        groups.push({
          block: trade.block,
          blockHash: trade.blockHash,
          time: trade.time,
          swaps: [],
        });
      groups.at(-1).swaps.push({
        weth: abs(weth),
        usdc: abs(usdc),
        logIndex: trade.logIndex,
        transactionHash: trade.transactionHash,
      });
    }
    previous = amm;
  }
  if (groups.length < minimumBlocks) throw Error('AMM_REPLAY_MORE_BLOCKS');
  return { manifest, first, groups, eventCount: count };
}

const blockRef = ({ block, blockHash, time }) => ({ block, blockHash, time });
const blockTag = ({ blockHash }) => ({ blockHash, requireCanonical: true });

async function replayAmm({ dataset, datasetId, load, market, marketConfig, config, signal }) {
  const { manifest, first, groups, eventCount } = await loadTape(datasetId, dataset, load);
  const source = { ...marketConfig, poolFee: first.fee, pool: first.pool };
  const { chain, rpc, header, finalized } = await historySource(market, source, signal);
  const deployment = deployments[source.venue];
  if (first.chainId !== chain.id || !deployment) throw Error('AMM_REPLAY_SOURCE_CHANGED');
  const initial = groups[0],
    final = groups.at(-1);
  let finalizedNumber = finalized.number;
  // Load-balanced RPCs can briefly return an older finalized head than capture did.
  for (const wait of [250, 750]) {
    if (finalizedNumber >= final.block) break;
    await delay(wait, undefined, { signal });
    finalizedNumber = (await header('finalized')).number;
  }
  async function verify(group, includeFees = false) {
    if (group.block > finalizedNumber) throw Error('AMM_REPLAY_UNFINALIZED');
    const canonical = await header(hex(group.block), includeFees);
    if (canonical.hash !== group.blockHash || canonical.time !== group.time)
      throw Error('AMM_REPLAY_BLOCK_CHANGED');
    return canonical;
  }
  await Promise.all([verify(initial), verify(final)]);
  const { pool, token0 } = await market.basePool(source, chain, (to, data) =>
    rpc('eth_call', [{ to, data }, blockTag(initial)]),
  );
  if (pool !== first.pool) throw Error('AMM_REPLAY_SOURCE_CHANGED');

  const useHistorical = config.feeMode === 'historical';
  const cashStart = parseUnits(config.initialCash, 6),
    reserve = parseUnits(useHistorical ? config.networkFeeCapUsdc : config.fixedFeeUsdc, 6);
  const charged = { gasUnits: 0n, l1Wei: 0n, l2Wei: 0n, operatorWei: 0n, totalWei: 0n };
  const attempts = [],
    trades = [],
    equity = [],
    prices = [];
  let cash = cashStart,
    position = 0n,
    paid = 0n,
    peak = cashStart,
    drawdown = 0n;
  let fast = 0n,
    slow = 0n,
    observed = 0,
    pending,
    canceledSignals = 0,
    skippedForBudget = 0,
    nextValue = cashStart;
  const stride = Math.ceil(groups.length / 1500);
  function mark(group, value, index) {
    if (value > peak) peak = value;
    const draw = ((peak - value) * 1000000n) / peak;
    if (draw > drawdown) drawdown = draw;
    if (index % stride === 0 || index === groups.length - 1)
      equity.push({ time: group.time, block: group.block, value: Number(formatUnits(value, 6)) });
  }
  async function execute(order, group) {
    const buying = order.side === 'buy';
    const amountIn = buying ? ((cash - reserve) * BigInt(config.allocationBps)) / bps : position;
    if (amountIn <= 0n || (!useHistorical && cash < reserve)) {
      skippedForBudget++;
      return;
    }
    if (attempts.length >= config.maxQuotes) throw Error('AMM_REPLAY_QUOTE_LIMIT');
    const canonical = await verify(group, useHistorical);
    const tokenIn = buying ? chain.usdc : chain.weth,
      tokenOut = buying ? chain.weth : chain.usdc;
    const data = quoteAbi.encodeFunctionData('quoteExactInputSingle', [
      [tokenIn, tokenOut, amountIn, first.fee, 0],
    ]);
    const encoded = await rpc('eth_call', [{ to: deployment.quoter, data }, blockTag(group)]);
    const [amountOut, sqrtAfter, crossed, gas] = quoteAbi.decodeFunctionResult(
      'quoteExactInputSingle',
      encoded,
    );
    if (amountOut <= 0n || sqrtAfter <= MIN_SQRT + 1n || sqrtAfter >= MAX_SQRT - 1n || gas <= 0n)
      throw Error('AMM_REPLAY_INCOMPLETE_QUOTE');
    const { weth, usdc, ...signalRef } = order.signal;
    const observedValue = buying ? amountOut * usdc : amountIn * usdc;
    const quotedValue = buying ? amountIn * weth : amountOut * weth;
    const tolerance = BigInt(config.maxAdverseBps ?? 0);
    const rejected =
      config.maxAdverseBps !== null &&
      (buying
        ? quotedValue * bps > observedValue * (bps + tolerance)
        : quotedValue * bps < observedValue * (bps - tolerance));
    const cost =
      useHistorical && !rejected
        ? await historicalFee({
            rpc,
            group,
            header: canonical,
            chain,
            deployment,
            pool,
            token0,
            fee: first.fee,
            config,
            quote: { gas, tokenIn, tokenOut, amountIn, amountOut },
          })
        : null;
    const perFill = cost ? BigInt(cost.usdcAtoms) : reserve;
    const remainingCash = cash + (buying ? -amountIn : amountOut);
    const status = rejected
      ? 'adverse-price'
      : perFill > reserve || perFill > remainingCash
        ? 'network-cost-limit'
        : 'filled';
    const attempt = {
      side: order.side,
      signal: { ...signalRef, wethAtoms: String(weth), usdcAtoms: String(usdc) },
      execution: blockRef(group),
      tokenIn,
      tokenOut,
      amountInAtoms: String(amountIn),
      amountOutAtoms: String(amountOut),
      sqrtPriceX96After: String(sqrtAfter),
      initializedTicksCrossed: Number(crossed),
      quoteGasEstimate: String(gas),
      status,
      ...(cost && { networkFee: cost }),
    };
    attempts.push(attempt);
    if (status !== 'filled') return;
    cash = remainingCash - perFill;
    if (cost) for (const field of Object.keys(charged)) charged[field] += BigInt(cost[field]);
    position += buying ? amountOut : -amountIn;
    paid += perFill;
    trades.push({
      time: group.time,
      signalTime: signalRef.time,
      side: order.side,
      quantity: formatUnits(buying ? amountOut : amountIn, 18),
      fee: formatUnits(perFill, 6),
      quoteIndex: attempts.length - 1,
    });
  }
  for (const [index, group] of groups.entries()) {
    signal?.throwIfAborted();
    if (pending && group.block - pending.signal.block >= config.delayBlocks) {
      await execute(pending, group);
      pending = undefined;
    }
    for (const trade of group.swaps) {
      const price = (trade.usdc * 10n ** 18n) / trade.weth;
      prices.push(price);
      fast += price;
      slow += price;
      if (observed >= config.fast) fast -= prices[observed - config.fast];
      if (observed >= config.slow) slow -= prices[observed - config.slow];
      observed++;
    }
    const lastSwap = group.swaps.at(-1);
    const hasSignal = config.strategy === 'buy-hold' || observed >= config.slow;
    const long =
      config.strategy === 'buy-hold' || fast * BigInt(config.slow) > slow * BigInt(config.fast);
    const hasPosition = position > 0n;
    const side = hasSignal && long !== hasPosition ? (long ? 'buy' : 'sell') : null;
    if (pending && pending.side !== side) {
      pending = undefined;
      canceledSignals++;
    }
    if (!pending && side) pending = { side, signal: { ...blockRef(group), ...lastSwap } };
    nextValue = cash + (position * lastSwap.usdc) / lastSwap.weth;
    if (group !== final) mark(group, nextValue, index);
  }
  if (config.strategy === 'sma-cross' && observed < config.slow)
    throw Error('AMM_REPLAY_MORE_SWAPS');

  const sqrt = await readSlot0(rpc, pool, blockTag(final), 'AMM_REPLAY_FINAL_MARK');
  const ratio = sqrt * sqrt,
    wethIsToken0 = token0 === chain.weth;
  nextValue = cash + (wethIsToken0 ? (position * ratio) / Q192 : (position * Q192) / ratio);
  mark(final, nextValue, groups.length - 1);
  await verify(final);
  return {
    config,
    trades,
    equity,
    metrics: {
      finalEquity: Number(formatUnits(nextValue, 6)),
      cash: formatUnits(cash, 6),
      position: formatUnits(position, 18),
      returnPct: Number(((nextValue - cashStart) * 1000000n) / cashStart) / 10000,
      maxDrawdownPct: Number(drawdown) / 10000,
      fees: formatUnits(paid, 6),
      fills: trades.length,
      bars: dataset.candles.length,
      observations: observed,
      blocks: groups.length,
    },
    ammReplay: {
      segments: manifest,
      eventCount,
      canceledSignals,
      skippedForBudget,
      pendingAtEnd: pending?.side ?? null,
      attempts,
      finalMark: {
        ...blockRef(final),
        sqrtPriceX96: String(sqrt),
        wethIsToken0,
        equityUsdcAtoms: String(nextValue),
      },
      quoter: deployment.quoter,
      networkFees: {
        mode: config.feeMode,
        usdcAtoms: String(paid),
        ...(useHistorical &&
          Object.fromEntries(Object.entries(charged).map(([key, value]) => [key, String(value)]))),
      },
    },
    assumptions: [
      'swaps-observed-at-block-close',
      'first-eligible-later-observed-block-end',
      'canonical-historical-quoter-includes-pool-fee-and-price-impact',
      'each-quote-uses-unmodified-historical-pool-state',
      ...(useHistorical
        ? [
            'historical-l2-base-fee-and-configured-priority-fee',
            'gas-modeled-as-quoter-estimate-plus-router-overhead',
            'historical-oracle-for-unsigned-router-envelope',
            'historical-same-pool-usdc-fee-mark-rounded-up',
            'buy-sizes-reserve-per-fill-network-cap',
          ]
        : ['fixed-user-configured-network-cost-in-usdc']),
      'interim-equity-uses-observed-swap-ratio',
      'final-inventory-marked-at-historical-slot0',
      'no-mev-or-inclusion-guarantee',
    ],
  };
}

module.exports = { CODE_VERSION, HISTORICAL_COST_VERSION, replayParameters, replayAmm, loadTape };
