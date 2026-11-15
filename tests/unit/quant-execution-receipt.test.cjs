/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id, toBeHex, zeroPadValue } = require('ethers');
const { decodeCall } = require('../../src/main/services/wallet');
const { deployments, routerAbi } = require('../../src/main/services/quant/base-swap');
const { observe, summarize } = require('../../src/main/services/quant/execution-receipt');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { executionSettlementRows } = require('../../src/shared/quant-execution-format');

const chain = CHAINS.base;
const owner = '0x' + '1'.repeat(40);
const pool = '0x' + '2'.repeat(40);
const txHash = '0x' + '3'.repeat(64);
const blockHash = '0x' + '4'.repeat(64);
const topic = id('Transfer(address,address,uint256)');

function fixture() {
  const intent = {
    commandId: 'command:swap',
    hash: txHash,
    status: 'finalized',
    chainId: chain.id,
    address: owner,
    transaction: {
      to: deployments.base.router,
      value: '0',
      data: routerAbi.encodeFunctionData('exactInputSingle', [
        [chain.usdc, chain.weth, 500, owner, 2000000000n, 900000000000000000n, 0],
      ]),
    },
  };
  const log = (token, from, to, amount, index) => ({
    address: token,
    transactionHash: txHash,
    blockHash,
    logIndex: '0x' + index.toString(16),
    topics: [topic, zeroPadValue(from, 32), zeroPadValue(to, 32)],
    data: toBeHex(amount, 32),
  });
  const receipt = {
    transactionHash: txHash,
    blockHash,
    from: owner,
    to: intent.transaction.to,
    status: '0x1',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x2',
    l1Fee: '0x0',
    logs: [
      log(chain.usdc, owner, pool, 1800000000n, 0),
      log(chain.weth, pool, owner, 1100000000000000000n, 1),
      log(chain.weth, owner, pool, 100000000000000000n, 2),
    ],
  };
  return { intent, receipt };
}

test('finalized swap uses net transfers and preserves a reported zero data fee', () => {
  const { intent, receipt } = fixture();
  intent.executionReceipt = observe(intent, receipt, chain, decodeCall);
  const settlement = summarize([intent]);
  assert.deepEqual(settlement.fill, {
    inputAtoms: '1800000000',
    outputAtoms: '1000000000000000000',
    observed: 1,
    finalized: 1,
  });
  assert.equal(settlement.fees.l2GasWei, '42000');
  assert.equal(settlement.fees.l1DataFeeWei, '0');
  const rows = Object.fromEntries(executionSettlementRows('buy', settlement, (key) => key));
  assert.equal(rows.leActualInput, '1800 USDC');
  assert.equal(rows.leActualOutput, '1 WETH');
  assert.equal(rows.leAverageFill, '1800 USDC/WETH');
});

test('contradictory transfers never count as fills and reverted gas remains visible', () => {
  const { intent, receipt } = fixture();
  receipt.logs.push(receipt.logs[1]);
  delete receipt.l1Fee;
  intent.executionReceipt = observe(intent, receipt, chain, decodeCall);
  assert.equal(intent.executionReceipt.fill, null);
  assert.equal(summarize([intent]).fees.l1DataFeeWei, null);
  assert.equal(summarize([intent]).fill.observed, 0);
  assert.equal(
    observe(intent, { ...receipt, transactionHash: '0x' + '9'.repeat(64) }, chain, decodeCall),
    null,
  );
  intent.status = 'reverted';
  intent.confirmation = 'finalized';
  intent.executionReceipt = observe(intent, { ...receipt, status: '0x0' }, chain, decodeCall);
  assert.equal(summarize([intent]).fill.finalized, 0);
  assert.equal(summarize([intent]).fees.l2GasWei, '42000');
  intent.status = 'reorged';
  assert.equal(summarize([intent]).fees.l2GasWei, null);
});

test('total fees require all three components on every finalized transaction', () => {
  const { intent, receipt } = fixture();
  intent.executionReceipt = observe(intent, receipt, chain, decodeCall);
  intent.executionReceipt.operatorFeeWei = '10500007';
  const first = summarize([intent]);
  assert.equal(first.fees.totalWei, '10542007');
  const nextHash = '0x' + '8'.repeat(64);
  const approval = {
    ...intent,
    commandId: 'command:approve',
    hash: nextHash,
    executionReceipt: {
      ...intent.executionReceipt,
      txHash: nextHash,
      operatorFeeWei: null,
      l1DataFeeWei: '9',
      fill: null,
    },
  };
  const incomplete = summarize([intent, approval]);
  assert.equal(incomplete.fees.operatorReceipts, 1);
  assert.equal(incomplete.fees.totalWei, null);
  approval.executionReceipt.operatorFeeWei = '0';
  assert.equal(summarize([intent, approval]).fees.totalWei, '10584016');
});
