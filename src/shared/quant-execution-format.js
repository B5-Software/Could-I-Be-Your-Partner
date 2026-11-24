/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
function executionAmount(value, decimals) {
  if (!/^\d+$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30)
    return '—';
  if (!decimals) return value;
  const padded = value.padStart(decimals + 1, '0'),
    fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
function executionPercent(value, total) {
  if (!/^\d+$/.test(value) || !/^[1-9]\d*$/.test(total)) return 0;
  return Math.min(100, Number((BigInt(value) * 10000n) / BigInt(total)) / 100);
}
function wethPrice(usdc, weth) {
  const base = BigInt(weth);
  return base > 0n ? executionAmount(String((BigInt(usdc) * 10n ** 18n) / base), 6) : '—';
}
function signedAmount(value, decimals) {
  return (
    (value.startsWith('-') ? '−' : value === '0' ? '' : '+') +
    executionAmount(value.replace(/^-/, ''), decimals)
  );
}
function poolPriceRatio(snapshot) {
  const sqrt = BigInt(snapshot.sqrt_price_x96);
  const squared = sqrt * sqrt;
  const q192 = 1n << 192n;
  // USDC atoms per WETH atom.
  return snapshot.weth_is_token0 ? [squared, q192] : [q192, squared];
}
function executionEntryCondition(trigger) {
  const relation = trigger.relation === 'at-or-below' ? '≤' : '≥';
  return relation + ' ' + executionAmount(trigger.price_atoms, 6) + ' USDC/WETH';
}
function executionEntryRows(observation, label, locale) {
  const [num, den] = poolPriceRatio(observation);
  return [
    [label('leEntryObserved'), executionAmount(String((num * 10n ** 18n) / den), 6) + ' USDC/WETH'],
    [
      label('leEntryBlock'),
      observation.block + ' · ' + new Date(observation.block_time * 1000).toLocaleString(locale),
    ],
  ];
}
function executionExitConditions(exit, label) {
  const rows = [
    [
      label('leStopLoss'),
      executionEntryCondition({
        relation: 'at-or-below',
        price_atoms: exit.stop_loss_price_atoms,
      }),
    ],
  ];
  if (exit.take_profit_price_atoms)
    rows.push([
      label('leTakeProfit'),
      executionEntryCondition({
        relation: 'at-or-above',
        price_atoms: exit.take_profit_price_atoms,
      }),
    ]);
  return rows;
}
function executionSettlementRows(side, settlement, label) {
  if (!settlement) return [];
  const rows = [];
  const { fill, fees } = settlement;
  if (fill.finalized) {
    rows.push([label('leReceiptCoverage'), fill.observed + ' / ' + fill.finalized]);
    if (fill.observed) {
      const buying = side === 'buy';
      const base = BigInt(buying ? fill.outputAtoms : fill.inputAtoms);
      const quote = BigInt(buying ? fill.inputAtoms : fill.outputAtoms);
      rows.push(
        [
          label('leActualInput'),
          executionAmount(fill.inputAtoms, buying ? 6 : 18) + (buying ? ' USDC' : ' WETH'),
        ],
        [
          label('leActualOutput'),
          executionAmount(fill.outputAtoms, buying ? 18 : 6) + (buying ? ' WETH' : ' USDC'),
        ],
        [label('leAverageFill'), wethPrice(quote, base) + ' USDC/WETH'],
      );
    }
  }
  if (fees.finalizedTransactions) {
    for (const [key, amount, count] of [
      ['leL2Gas', fees.l2GasWei, fees.l2Receipts],
      ['leL1DataFee', fees.l1DataFeeWei, fees.l1Receipts],
      ['leOperatorFee', fees.operatorFeeWei ?? null, fees.operatorReceipts ?? 0],
    ]) {
      rows.push([
        label(key),
        (amount === null ? '—' : executionAmount(amount, 18) + ' ETH') +
          ' · ' +
          count +
          ' / ' +
          fees.finalizedTransactions,
      ]);
    }
    if (fees.totalWei != null)
      rows.push([label('leActualFeeTotal'), executionAmount(fees.totalWei, 18) + ' ETH']);
  }
  return rows;
}
function executionBenchmarkRows(benchmark, label, locale) {
  return [
    [
      label('leBenchmarkPrice'),
      wethPrice(benchmark.marketUsdcAtoms, benchmark.marketWethAtoms) + ' USDC/WETH',
    ],
    [label('leBenchmarkCost'), signedAmount(benchmark.costBpsHundredths, 2) + ' bp'],
    [label('leBenchmarkBlocks'), benchmark.firstBlock + ' – ' + benchmark.lastBlock],
    [label('leProfilePool'), benchmark.pool],
    [
      label('leBenchmarkPeriod'),
      new Date(benchmark.firstTime * 1000).toLocaleString(locale) +
        ' – ' +
        new Date(benchmark.lastTime * 1000).toLocaleString(locale),
    ],
    [
      label('leBenchmarkSample'),
      benchmark.swapCount + ' · ' + executionAmount(benchmark.marketWethAtoms, 18) + ' WETH',
    ],
  ];
}
function executionArrivalRows(arrival, comparison, label, locale) {
  if (!arrival || !comparison) return [];
  const rows = [
    [label('leArrivalPrice'), executionAmount(comparison.referencePriceAtoms, 6) + ' USDC/WETH'],
    [
      label('leArrivalBlock'),
      arrival.block + ' · ' + new Date(arrival.block_time * 1000).toLocaleString(locale),
    ],
  ];
  if (comparison.costUsdcAtoms !== null && comparison.costBpsHundredths !== null)
    rows.push([
      label('leArrivalCost'),
      signedAmount(comparison.costUsdcAtoms, 6) +
        ' USDC · ' +
        signedAmount(comparison.costBpsHundredths, 2) +
        ' bp',
    ]);
  return rows;
}
module.exports = {
  executionAmount,
  signedAmount,
  executionPercent,
  executionSettlementRows,
  executionBenchmarkRows,
  executionArrivalRows,
  executionEntryCondition,
  executionEntryRows,
  executionExitConditions,
  poolPriceRatio,
};
