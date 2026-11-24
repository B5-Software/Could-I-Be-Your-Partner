/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CHAINS } = require('./market-data');
const { historySource, scanSwaps } = require('./vwap-profile');

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const positiveAtoms = (value) => typeof value === 'string' && /^[1-9]\d{0,77}$/.test(value);
const blockNumber = (value) =>
  typeof value === 'string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value));
const hex = (number) => '0x' + number.toString(16);
const abs = (value) => (value < 0n ? -value : value);
const file = (directory, runId) =>
  path.join(directory, 'execution-benchmarks', digest(runId) + '.json');

const { poolPriceRatio } = require('../../../shared/quant-execution-format');

function arrivalMinimum(run, inputAtoms) {
  const bps = run.plan.max_arrival_cost_bps;
  if (bps === undefined) return null;
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10000)
    throw Error('EXECUTION_ARRIVAL_LIMIT_RANGE');
  if (!run.arrival) throw Error('EXECUTION_ARRIVAL_REQUIRED');
  const [num, den] = poolPriceRatio(run.arrival);
  const input = BigInt(inputAtoms);
  const buying = run.plan.side === 'buy';
  const numerator = buying ? input * den * 10000n : input * num * BigInt(10000 - bps);
  const denominator = buying ? num * BigInt(10000 + bps) : den * 10000n;
  return (numerator + denominator - 1n) / denominator;
}

function arrivalComparison(run, fill) {
  if (!run.arrival) return null;
  const [num, den] = poolPriceRatio(run.arrival);
  const referencePriceAtoms = String((num * 10n ** 18n) / den);
  if (!fill.observed) return { referencePriceAtoms, costUsdcAtoms: null, costBpsHundredths: null };
  const buying = run.plan.side === 'buy';
  const weth = BigInt(buying ? fill.outputAtoms : fill.inputAtoms);
  const usdc = BigInt(buying ? fill.inputAtoms : fill.outputAtoms);
  const value = weth * num;
  const delta = buying ? usdc * den - value : value - usdc * den;
  return {
    referencePriceAtoms,
    costUsdcAtoms: String(delta / den),
    costBpsHundredths: String((delta * 1000000n) / value),
  };
}

function basis(run, records) {
  if (
    !['completed', 'expired', 'stopped'].includes(run.phase) ||
    run.pending ||
    run.completed_slices < 1
  )
    return null;
  const trades = records.filter(
    (intent) =>
      intent.status === 'finalized' &&
      intent.submissionMayHaveOccurred !== false &&
      intent.commandId.endsWith(':swap'),
  );
  if (trades.length !== run.completed_slices) return null;
  const source = trades[0].config;
  if (CHAINS[source?.venue]?.id !== run.plan.chain_id) return null;
  const config = { venue: source.venue, rpcUrl: source.rpcUrl || '', poolFee: run.plan.pool_fee };
  const rows = [];
  const txs = new Set();
  for (const intent of trades) {
    const evidence = intent.executionReceipt;
    const txHash = typeof intent.hash === 'string' ? intent.hash.toLowerCase() : null;
    if (
      !hash(txHash) ||
      txs.has(txHash) ||
      evidence?.version !== 1 ||
      evidence.txHash !== txHash ||
      !hash(evidence.blockHash) ||
      !positiveAtoms(evidence.fill?.inputAtoms) ||
      !positiveAtoms(evidence.fill?.outputAtoms) ||
      !blockNumber(intent.block) ||
      intent.config?.venue !== config.venue ||
      (intent.config?.rpcUrl || '') !== config.rpcUrl
    )
      return null;
    txs.add(txHash);
    rows.push({
      txHash,
      block: Number(intent.block),
      blockHash: evidence.blockHash,
      inputAtoms: evidence.fill.inputAtoms,
      outputAtoms: evidence.fill.outputAtoms,
    });
  }
  rows.sort((a, b) => a.block - b.block || a.txHash.localeCompare(b.txHash));
  return { key: digest([run.plan, rows]), config, rows };
}

function load(directory, runId, key) {
  try {
    const target = file(directory, runId);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > 16384) return null;
    const { report, checksum } = JSON.parse(fs.readFileSync(target, 'utf8'));
    return report?.version === 1 && report.key === key && digest(report) === checksum
      ? report
      : null;
  } catch {
    return null;
  }
}

async function capture(market, run, source, signal) {
  const { config, rows } = source;
  const { chain, rpc, header, finalized } = await historySource(market, config, signal);
  const ownBlocks = new Map();
  for (const row of rows) {
    const known = ownBlocks.get(row.block);
    if ((known && known !== row.blockHash) || row.block > finalized.number)
      throw Error('EXECUTION_BENCHMARK_EVIDENCE');
    ownBlocks.set(row.block, row.blockHash);
  }
  const blocks = [...ownBlocks.entries()];
  const headers = new Map();
  for (let offset = 0; offset < blocks.length; offset += 4) {
    await Promise.all(
      blocks.slice(offset, offset + 4).map(async ([number, expected]) => {
        const block = await header(hex(number));
        if (block.hash !== expected) throw Error('EXECUTION_BENCHMARK_EVIDENCE');
        headers.set(number, block);
      }),
    );
  }
  const first = headers.get(rows[0].block);
  const last = headers.get(rows.at(-1).block);
  const call = (to, data) => rpc('eth_call', [{ to, data }, hex(last.number)]);
  const { pool, token0 } = await market.basePool(config, chain, call);
  const buying = run.plan.side === 'buy';
  const wethFirst = token0 === chain.weth;
  const own = new Map(rows.map((row) => [row.txHash, row]));
  const seen = new Set();
  let count = 0;
  let weth = 0n;
  let usdc = 0n;
  await scanSwaps(rpc, header, pool, first, last, (block, log) => {
    const txHash =
      typeof log.transactionHash === 'string' ? log.transactionHash.toLowerCase() : null;
    if (!hash(txHash)) throw Error('EXECUTION_BENCHMARK_EVIDENCE');
    const wethDelta = wethFirst ? log.amount0 : log.amount1;
    const usdcDelta = wethFirst ? log.amount1 : log.amount0;
    if (own.has(txHash)) {
      const fill = own.get(txHash);
      if (
        seen.has(txHash) ||
        fill.blockHash !== block.hash ||
        fill.block !== block.number ||
        (buying ? usdcDelta : wethDelta) !== BigInt(fill.inputAtoms) ||
        -(buying ? wethDelta : usdcDelta) !== BigInt(fill.outputAtoms)
      )
        throw Error('EXECUTION_BENCHMARK_EVIDENCE');
      seen.add(txHash);
      return;
    }
    if (wethDelta * usdcDelta >= 0n) return;
    weth += abs(wethDelta);
    usdc += abs(usdcDelta);
    count++;
  });
  if (seen.size !== own.size) throw Error('EXECUTION_BENCHMARK_EVIDENCE');
  if (count === 0) throw Error('EXECUTION_BENCHMARK_EMPTY');
  let actualWeth = 0n;
  let actualUsdc = 0n;
  for (const row of rows) {
    actualWeth += BigInt(buying ? row.outputAtoms : row.inputAtoms);
    actualUsdc += BigInt(buying ? row.inputAtoms : row.outputAtoms);
  }
  const denominator = actualWeth * usdc;
  const signed = actualUsdc * weth - denominator;
  const cost = (buying ? signed : -signed) * 1000000n;
  return {
    version: 1,
    key: source.key,
    pool,
    chainId: chain.id,
    fee: config.poolFee,
    firstBlock: first.number,
    firstBlockHash: first.hash,
    firstTime: first.time,
    lastBlock: last.number,
    lastBlockHash: last.hash,
    lastTime: last.time,
    finalizedBlock: finalized.number,
    finalizedBlockHash: finalized.hash,
    swapCount: count,
    excludedTransactions: own.size,
    marketWethAtoms: String(weth),
    marketUsdcAtoms: String(usdc),
    actualWethAtoms: String(actualWeth),
    actualUsdcAtoms: String(actualUsdc),
    costBpsHundredths: String(cost / denominator),
  };
}

function archive(directory, runId, report, writeAtomic) {
  writeAtomic(file(directory, runId), { report, checksum: digest(report) });
  return report;
}

module.exports = { basis, capture, load, archive, arrivalComparison, arrivalMinimum };
