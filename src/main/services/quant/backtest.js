/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { atoms, decimal, SCALE, notional, fee } = require('./decimal');

function validateCandles(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10000)
    throw new Error('CANDLES_LIMIT');
  let previous = -1;
  return input.map((bar) => {
    const time = Number(bar.time);
    if (!Number.isSafeInteger(time) || time <= previous || time < 0 || time > 4102444800)
      throw new Error('CANDLES_TIME_ORDER');
    previous = time;
    const result = { time };
    for (const key of ['open', 'high', 'low', 'close']) {
      const value = Number(bar[key]);
      if (!Number.isFinite(value) || value <= 0 || value > 1e12) throw new Error('CANDLES_PRICE');
      result[key] = value;
    }
    if (
      result.high < Math.max(result.open, result.close, result.low) ||
      result.low > Math.min(result.open, result.close)
    )
      throw new Error('CANDLES_RANGE');
    result.volume = Number(bar.volume ?? 0);
    if (!Number.isFinite(result.volume) || result.volume < 0) throw new Error('CANDLES_VOLUME');
    return result;
  });
}

function parameters(input = {}) {
  const strategy = input.strategy || 'sma-cross';
  if (!['sma-cross', 'buy-hold'].includes(strategy)) throw new Error('STRATEGY_UNAVAILABLE');
  const integer = (value, fallback, min, max) => {
    const number = value ?? fallback;
    if (!Number.isInteger(number) || number < min || number > max)
      throw new Error('INVALID_PARAMETERS');
    return number;
  };
  const fast = integer(input.fast, 9, 2, 200);
  const slow = integer(input.slow, 21, 3, 500);
  if (fast >= slow) throw new Error('FAST_MUST_BE_LESS_THAN_SLOW');
  return {
    strategy,
    fast,
    slow,
    initialCash: decimal(atoms(input.initialCash ?? '10000', true)),
    feeBps: integer(input.feeBps, 10, 0, 1000),
    slippageBps: integer(input.slippageBps, 5, 0, 1000),
    allocationBps: integer(input.allocationBps, 2500, 1, 9500),
  };
}

function runBacktest(raw, input = {}) {
  const candles = validateCandles(raw),
    config = parameters(input);
  if (candles.length < (config.strategy === 'sma-cross' ? config.slow + 2 : 3))
    throw new Error('MORE_CANDLES_REQUIRED');
  let cash = atoms(config.initialCash),
    position = 0n,
    totalFees = 0n;
  let pending = null,
    fastSum = 0,
    slowSum = 0,
    lastSignal = false,
    peak = cash,
    worstDrawdown = 0;
  const trades = [],
    equity = [];
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    // A signal observed at the previous close can first execute at THIS open.
    if (pending) {
      const buying = pending === 'buy';
      const price = atoms(
        (bar.open * (1 + ((buying ? 1 : -1) * config.slippageBps) / 10000)).toFixed(8),
        true,
      );
      const budget = (cash * BigInt(config.allocationBps)) / 10000n;
      let quantity = buying
        ? (budget * SCALE * 10000n) / (price * BigInt(10000 + config.feeBps))
        : position;
      if (quantity > 0n) {
        const value = notional(price, quantity),
          costs = fee(value, config.feeBps);
        if (buying && value + costs > cash) quantity = 0n;
        if (quantity) {
          cash += buying ? -value - costs : value - costs;
          position += buying ? quantity : -quantity;
          totalFees += costs;
          trades.push({
            time: bar.time,
            signalTime: candles[i - 1].time,
            side: pending,
            price: decimal(price),
            quantity: decimal(quantity),
            fee: decimal(costs),
          });
        }
      }
      pending = null;
    }
    const close = atoms(bar.close.toFixed(8), true);
    const value = cash + (position * close) / SCALE;
    if (value > peak) peak = value;
    worstDrawdown = Math.max(worstDrawdown, Number(((peak - value) * 1000000n) / peak) / 10000);
    equity.push({ time: bar.time, value: Number(decimal(value)) });
    fastSum += bar.close;
    slowSum += bar.close;
    if (i >= config.fast) fastSum -= candles[i - config.fast].close;
    if (i >= config.slow) slowSum -= candles[i - config.slow].close;
    if (config.strategy === 'buy-hold' && i === 0) pending = 'buy';
    if (config.strategy === 'sma-cross' && i >= config.slow - 1) {
      const signal = fastSum / config.fast > slowSum / config.slow;
      if (signal && !lastSignal && position === 0n) pending = 'buy';
      if (!signal && lastSignal && position > 0n) pending = 'sell';
      lastSignal = signal;
    }
  }
  const finalEquity = equity.at(-1).value;
  return {
    config,
    trades,
    equity,
    metrics: {
      finalEquity,
      cash: decimal(cash),
      position: decimal(position),
      returnPct: (finalEquity / Number(config.initialCash) - 1) * 100,
      maxDrawdownPct: worstDrawdown,
      fees: decimal(totalFees),
      fills: trades.length,
      bars: candles.length,
    },
    assumptions: [
      'candle-next-open',
      'spot-long-only',
      'no-orderbook-or-queue',
      'fixed-fee-and-slippage',
      'unrealized-inventory-marked-at-last-close',
      'not-a-high-frequency-execution-validation',
    ],
  };
}
module.exports = { validateCandles, parameters, runBacktest };
