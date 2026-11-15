/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { assumptions, parameters, simulate, validateCandles } = require('./backtest');
const { decimal } = require('./decimal');

const VERSION = 'candle-walk-forward-1';
const pairs = (fastPeriods, slowPeriods) =>
  fastPeriods.flatMap((fast) =>
    slowPeriods.filter((slow) => fast < slow).map((slow) => ({ fast, slow })),
  );

function walkForwardParameters(input = {}) {
  const grid = (values, min, max) => {
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > 6 ||
      values.some((value) => !Number.isInteger(value) || value < min || value > max)
    )
      throw Error('WALK_FORWARD_PARAMETERS');
    return [...new Set(values)].sort((a, b) => a - b);
  };
  const integer = (value, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max)
      throw Error('WALK_FORWARD_PARAMETERS');
    return value;
  };
  const fastPeriods = grid(input.fastPeriods ?? [5, 9, 15], 2, 200);
  const slowPeriods = grid(input.slowPeriods ?? [21, 34, 55], 3, 500);
  const trainBars = integer(input.trainBars ?? 120, 5, 5000);
  const testBars = integer(input.testBars ?? 30, 2, 2500);
  const folds = integer(input.folds ?? 3, 1, 8);
  const candidates = pairs(fastPeriods, slowPeriods);
  if (candidates.length < 2 || candidates.some(({ slow }) => trainBars < slow + 2))
    throw Error('WALK_FORWARD_GRID');
  if (trainBars + testBars * folds > 10000) throw Error('WALK_FORWARD_PARAMETERS');
  const { initialCash, feeBps, slippageBps, allocationBps } = parameters({
    initialCash: input.initialCash,
    feeBps: input.feeBps,
    slippageBps: input.slippageBps,
    allocationBps: input.allocationBps,
  });
  return {
    strategy: 'sma-walk-forward',
    trainBars,
    testBars,
    folds,
    fastPeriods,
    slowPeriods,
    initialCash,
    feeBps,
    slippageBps,
    allocationBps,
  };
}

function runWalkForward(raw, input) {
  const config = walkForwardParameters(input);
  const candles = validateCandles(raw);
  const { trainBars, testBars, folds, fastPeriods, slowPeriods } = config;
  const required = trainBars + testBars * folds;
  if (candles.length < required) throw Error('WALK_FORWARD_MORE_CANDLES');
  const offset = candles.length - required;
  const candidates = pairs(fastPeriods, slowPeriods);
  const windows = [];
  const equity = [];
  const trades = [];
  let account, lastMetrics;
  let totalFees = 0n;
  const baseConfig = { ...config, strategy: 'sma-cross' };
  const range = (bars) => ({ start: bars[0].time, end: bars.at(-1).time, bars: bars.length });
  for (let fold = 0; fold < folds; fold++) {
    const from = offset + fold * testBars;
    const split = from + trainBars;
    const training = candles.slice(from, split);
    const trainingScores = candidates
      .map(({ fast, slow }) => {
        const { mark, worstDrawdown, metrics } = simulate(
          training,
          { ...baseConfig, fast, slow },
          { trace: false },
        );
        return { fast, slow, mark, worstDrawdown, metrics };
      })
      .sort((a, b) => {
        if (a.mark !== b.mark) return a.mark > b.mark ? -1 : 1;
        return Number(a.worstDrawdown - b.worstDrawdown) || a.fast - b.fast || a.slow - b.slow;
      });
    const { fast, slow } = trainingScores[0];
    const evaluation = candles.slice(split - slow, split + testBars);
    const holdout = simulate(evaluation, { ...baseConfig, fast, slow }, { start: slow, account });
    account = holdout.account;
    lastMetrics = holdout.metrics;
    totalFees += holdout.totalFees;
    equity.push(...holdout.equity);
    trades.push(...holdout.trades.map((trade) => ({ ...trade, fold: fold + 1 })));
    windows.push({
      index: fold + 1,
      training: range(training),
      testing: range(evaluation.slice(slow)),
      selected: { fast, slow },
      metrics: holdout.metrics,
      trainingScores: trainingScores.map(({ fast, slow, metrics }) => ({
        fast,
        slow,
        returnPct: metrics.returnPct,
        maxDrawdownPct: metrics.maxDrawdownPct,
        fills: metrics.fills,
      })),
    });
  }
  const startingCash = Number(config.initialCash);
  let peak = startingCash,
    maxDrawdownPct = 0;
  for (const { value } of equity) {
    peak = Math.max(peak, value);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - value) / peak) * 100);
  }
  return {
    config,
    trades,
    equity,
    metrics: {
      ...lastMetrics,
      bars: equity.length,
      fills: trades.length,
      fees: decimal(totalFees),
      returnPct: (lastMetrics.finalEquity / startingCash - 1) * 100,
      maxDrawdownPct,
    },
    walkForward: { candidateCount: candidates.length, discardedPrefixBars: offset, windows },
    assumptions: [
      ...assumptions,
      'rolling-training-before-each-disjoint-test-window',
      'training-rank-final-equity-desc-drawdown-asc-fast-asc-slow-asc',
      'warmup-with-training-closes-only',
      'carry-test-cash-and-inventory-across-windows',
      'test-curve-excludes-training-trades-and-fees',
    ],
  };
}

module.exports = { VERSION, walkForwardParameters, runWalkForward };
