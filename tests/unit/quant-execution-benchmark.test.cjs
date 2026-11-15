/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');
const {
  capture,
  arrivalComparison,
  arrivalMinimum,
} = require('../../src/main/services/quant/execution-benchmark');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { executionBenchmarkRows } = require('../../src/shared/quant-execution-format');

const chain = CHAINS.base;
const pool = '0x' + 'a'.repeat(40);
const txHash = '0x' + 'b'.repeat(64);
const blockHash = '0x' + 'c'.repeat(64);
const event = new Interface([
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);
const block = { number: '0x10', timestamp: '0x69000000', hash: blockHash };
const source = {
  key: 'fixture',
  config: { venue: 'base', rpcUrl: '', poolFee: 500 },
  rows: [
    { txHash, block: 16, blockHash, inputAtoms: '2000000000000000000', outputAtoms: '4000000000' },
  ],
};
const sell = { plan: { side: 'sell' } };
const log = (hash, index, weth, usdc) => ({
  ...event.encodeEventLog('Swap', [pool, pool, weth, usdc, 1n, 1n, 0n]),
  transactionHash: hash,
  blockHash,
  blockNumber: block.number,
  logIndex: index,
  address: pool,
});
const own = log(txHash, '0x0', 2000000000000000000n, -4000000000n);
const external = log('0x' + 'd'.repeat(64), '0x1', -1000000000000000000n, 2100000000n);
function market(logs) {
  return {
    async basePool() {
      return { pool, token0: chain.weth };
    },
    async rpc(_venue, _url, method) {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getBlockByNumber') return block;
      if (method === 'eth_getLogs') return logs;
      throw Error('Unexpected RPC: ' + method);
    },
  };
}

test('a sell below the external pool VWAP has positive execution cost', async () => {
  const report = await capture(market([own, external]), sell, source);
  assert.equal(report.costBpsHundredths, '47619');
  assert.equal(report.swapCount, 1);
  const rows = Object.fromEntries(executionBenchmarkRows(report, (key) => key, 'en-US'));
  assert.equal(rows.leBenchmarkPrice, '2100 USDC/WETH');
  assert.equal(rows.leBenchmarkCost, '+476.19 bp');
});

test('a benchmark requires matching own amounts and an independent sample', async () => {
  await assert.rejects(capture(market([external]), sell, source), /EXECUTION_BENCHMARK_EVIDENCE/);
  const wrongAmount = log(txHash, '0x0', 2000000000000000000n, -3900000000n);
  await assert.rejects(
    capture(market([wrongAmount, external]), sell, source),
    /EXECUTION_BENCHMARK_EVIDENCE/,
  );
  await assert.rejects(capture(market([own]), sell, source), /EXECUTION_BENCHMARK_EMPTY/);
});

test('arrival cost handles reversed token order and computes cost only for verified fills', () => {
  const run = {
    plan: { side: 'sell' },
    arrival: { sqrt_price_x96: String(2n << 96n), weth_is_token0: false },
  };
  assert.deepEqual(arrivalComparison(run, { observed: 0 }), {
    referencePriceAtoms: '250000000000000000',
    costUsdcAtoms: null,
    costBpsHundredths: null,
  });
  assert.deepEqual(arrivalComparison(run, { observed: 1, inputAtoms: '8', outputAtoms: '1' }), {
    referencePriceAtoms: '250000000000000000',
    costUsdcAtoms: '1',
    costBpsHundredths: '500000',
  });
});

test('arrival floor rounds buy and sell outputs up and accepts a zero-bp limit', () => {
  const arrival = { sqrt_price_x96: String(2n << 96n), weth_is_token0: false };
  assert.equal(
    arrivalMinimum({ plan: { side: 'buy', max_arrival_cost_bps: 2500 }, arrival }, '3'),
    10n,
  );
  assert.equal(
    arrivalMinimum({ plan: { side: 'sell', max_arrival_cost_bps: 1000 }, arrival }, '7'),
    2n,
  );
  assert.equal(
    arrivalMinimum({ plan: { side: 'buy', max_arrival_cost_bps: 0 }, arrival }, '3'),
    12n,
  );
  assert.throws(
    () => arrivalMinimum({ plan: { side: 'sell', max_arrival_cost_bps: 10000 }, arrival }, '7'),
    /EXECUTION_ARRIVAL_LIMIT_RANGE/,
  );
});
