/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { portfolioPerformance } = require('../../src/main/services/wallet/portfolio-performance');

const one = { walletId: 'one', address: '0x' + '1'.repeat(40) };
const two = { walletId: 'two', address: '0x' + '2'.repeat(40) };
const portfolio = { id: 'fixture', chainId: 8453, members: [one, two] };
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const make = (owner, nonce, number, side, input, output) => ({
  id: 'intent-' + number,
  ...owner,
  chainId: 8453,
  status: 'finalized',
  block: '100',
  commandId: number + ':swap',
  execution: { planId: 'plan' },
  transaction: { nonce },
  description: {
    kind: 'uniswap-v3-swap',
    recipient: owner.address,
    tokenIn: side === 'buy' ? 'USDC' : 'WETH',
    tokenOut: side === 'buy' ? 'WETH' : 'USDC',
  },
  hash: hash(number),
  executionReceipt: {
    version: 1,
    txHash: hash(number),
    blockHash: hash(100),
    fill: { inputAtoms: String(input), outputAtoms: String(output) },
    gasUsed: '10',
    l2GasWei: '5',
    l1DataFeeWei: '3',
    operatorFeeWei: '2',
  },
});

test('FIFO follows wallet nonce and conserves cost through partial fills without lending lots across wallets', () => {
  const buy = make(one, 4, 1, 'buy', 10, 3);
  const firstSale = make(one, 5, 2, 'sell', 1, 2);
  const secondSale = make(one, 6, 3, 'sell', 2, 7);
  const unrelatedSale = make(two, 1, 4, 'sell', 3, 10);
  const records = [unrelatedSale, secondSale, buy, firstSale, { ...buy }];
  const report = portfolioPerformance(portfolio, 1, records, { limit: 2 });
  assert.equal(report.totals.matchedWeth.atomic, '3');
  assert.equal(report.totals.unmatchedSaleWeth.atomic, '3');
  assert.equal(report.totals.realizedGrossUsdc.amount, '-0.000001');
  assert.equal(report.totals.openCostUsdc.atomic, '0');
  assert.equal(report.fees.totalWei, '40');
  assert.equal(report.next, 2);
  assert.equal(report.items.find((item) => item.walletId === 'two').realizedGrossUsdc, null);
  const page = portfolioPerformance(portfolio, 1, records, {
    limit: 2,
    offset: 2,
    snapshotId: report.snapshotId,
  });
  assert.equal(
    page.items.find((item) => item.intentId === firstSale.id).matchedCostUsdc.atomic,
    '3',
  );
  assert.equal(
    report.items.find((item) => item.intentId === secondSale.id).matchedCostUsdc.atomic,
    '7',
  );
  const isolated = portfolioPerformance(portfolio, 1, records, { walletId: 'two' });
  assert.equal(isolated.totals.realizedGrossUsdc, null);
  assert.equal(isolated.fees.totalWei, '10');
  assert.throws(
    () => portfolioPerformance(portfolio, 2, records, { snapshotId: report.snapshotId }),
    /WALLET_PORTFOLIO_PERFORMANCE_CHANGED/,
  );
});

test('an earlier unreconciled swap breaks the retained cost basis until evidence is restored', () => {
  const buy = make(one, 1, 7, 'buy', 4, 6);
  const pending = make(one, 2, 8, 'sell', 2, 4);
  const sale = make(one, 3, 9, 'sell', 2, 3);
  pending.status = 'submitted';
  delete pending.executionReceipt;
  const report = portfolioPerformance(portfolio, 4, [sale, buy, pending], {});
  assert.equal(report.totals.realizedGrossUsdc, null);
  assert.equal(report.totals.interruptedBasisWeth.atomic, '6');
  assert.equal(report.totals.unmatchedSaleWeth.atomic, '2');
  assert.equal(report.items.find((item) => item.intentId === pending.id).side, 'unknown');
  const recovered = make(one, 2, 8, 'sell', 2, 4);
  recovered.executionReceipt.operatorFeeWei = null;
  const after = portfolioPerformance(portfolio, 4, [sale, buy, recovered], {});
  assert.equal(after.totals.realizedGrossUsdc.atomic, '5');
  assert.equal(after.totals.openWeth.atomic, '2');
  assert.equal(after.fees.totalWei, null);
  assert.equal(after.fees.operatorReceipts, 2);
  assert.throws(
    () =>
      portfolioPerformance(portfolio, 4, [sale, buy, recovered], { snapshotId: report.snapshotId }),
    /WALLET_PORTFOLIO_PERFORMANCE_CHANGED/,
  );
});

test('historical fees use the recorded block and preserve total buy fees across partial lots', () => {
  const priced = (record, ethFee) => {
    record.executionReceipt.l2GasWei = ethFee;
    record.executionReceipt.l1DataFeeWei = '0';
    record.executionReceipt.operatorFeeWei = '0';
    record.executionReceipt.feeQuote = {
      version: 1,
      blockHash: record.executionReceipt.blockHash,
      blockNumber: record.block,
      source: 'Chainlink',
      eth: { priceAtomic: '200000000000', roundId: '10' },
      usdc: { priceAtomic: '98000000', roundId: '20' },
    };
    return record;
  };
  const buy = priced(make(one, 1, 1, 'buy', 10, 3), '2000000000');
  const first = priced(make(one, 2, 2, 'sell', 1, 8), '1000000000');
  const last = priced(make(one, 3, 3, 'sell', 3, 21), '2000000000');
  const approval = priced(make(one, 0, 4, 'buy', 10, 3), '3000000000');
  approval.commandId = '4:approve';
  delete approval.executionReceipt.fill;
  const failed = priced(make(one, 4, 5, 'sell', 1, 1), '4000000000');
  failed.status = 'reverted';
  failed.confirmation = 'finalized';
  delete failed.executionReceipt.fill;
  const rows = [buy, first, last, approval, failed];
  const complete = portfolioPerformance(portfolio, 1, rows, {});
  assert.equal(complete.totals.realizedGrossUsdc.atomic, '12');
  assert.equal(complete.totals.matchedSwapFeesUsdc.atomic, '8');
  assert.equal(complete.totals.realizedAfterSwapFeesUsdc.atomic, '4');
  assert.equal(complete.historicalFees.totalUsdc.atomic, '24');
  assert.equal(complete.historicalFees.priced, 5);
  assert.deepEqual(
    complete.items.map((row) => row.transactionFeeUsdc.atomic),
    ['4', '2', '4'],
  );
  last.executionReceipt.feeQuote.blockHash = hash(999);
  const partial = portfolioPerformance(portfolio, 1, rows, {});
  assert.equal(partial.totals.realizedGrossUsdc.atomic, '12');
  assert.equal(partial.totals.realizedAfterSwapFeesUsdc, null);
  assert.equal(partial.totals.pricedSaleCount, 1);
  assert.equal(partial.historicalFees.totalUsdc, null);
  assert.equal(partial.historicalFees.knownUsdc.atomic, '20');
  assert.notEqual(partial.snapshotId, complete.snapshotId);
});
