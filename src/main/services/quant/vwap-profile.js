/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Interface } = require('ethers');
const { CHAINS } = require('./market-data');

const periods = 3;
// Six hours at Base's 200 ms cadence, with room for the search boundary.
const scanBlocks = 120000;
const chunkBlocks = 1000;
const maxLogs = 10000;
const rangeErrors = new Set(['MARKET_HTTP_413', 'BASE_RPC_ERROR_-32005']);
const swap = new Interface([
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);
const topic = swap.getEvent('Swap').topicHash;
const hashPattern = /^0x[0-9a-f]{64}$/i;
const profilePattern = /^[0-9a-f]{64}$/;
const atomsPattern = /^(?:0|[1-9]\d{0,38})$/;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = (number) => '0x' + number.toString(16);
async function blockAtOrAfter(header, low, high, time) {
  if (low.time >= time) return low;
  if (high.time < time) return null;
  while (high.number - low.number > 1) {
    const middle = await header(hex(Math.floor((low.number + high.number) / 2)));
    if (middle.time < low.time || middle.time > high.time) throw Error('EXECUTION_PROFILE_HISTORY');
    if (middle.time < time) low = middle;
    else high = middle;
  }
  return high;
}
function quantity(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][\da-f]{0,13})$/i.test(value))
    throw Error('EXECUTION_PROFILE_HISTORY');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw Error('EXECUTION_PROFILE_HISTORY');
  return parsed;
}
function hash(value) {
  if (typeof value !== 'string' || !hashPattern.test(value))
    throw Error('EXECUTION_PROFILE_HISTORY');
  return value.toLowerCase();
}
function shape(slices, intervalMs) {
  if (
    !Number.isInteger(slices) ||
    slices < 2 ||
    slices > 96 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs % 1000 !== 0 ||
    slices * intervalMs > 7200000
  )
    throw Error('EXECUTION_PROFILE_INVALID');
}

async function historySource(market, config, externalSignal) {
  const chain = CHAINS[config.venue];
  const timeout = AbortSignal.timeout(45000);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  async function rpc(method, params) {
    for (const backoff of [400, 1200]) {
      try {
        return await market.rpc(config.venue, config.rpcUrl, method, params, { signal });
      } catch (error) {
        if (error.message !== 'MARKET_HTTP_429') throw error;
        await delay(backoff, undefined, { signal });
      }
    }
    try {
      return await market.rpc(config.venue, config.rpcUrl, method, params, { signal });
    } catch (error) {
      if (error.message === 'MARKET_HTTP_429') throw Error('EXECUTION_PROFILE_RATE_LIMIT');
      throw error;
    }
  }
  if (quantity(await rpc('eth_chainId', [])) !== chain.id) throw Error('CHAIN_ID_MISMATCH');

  async function header(tag, includeFees = false) {
    const block = await rpc('eth_getBlockByNumber', [tag, false]);
    const number = quantity(block?.number);
    if (tag !== 'finalized' && hex(number) !== tag) throw Error('EXECUTION_PROFILE_HISTORY');
    return {
      number,
      hash: hash(block.hash),
      time: quantity(block.timestamp),
      ...(includeFees && { baseFeePerGas: block.baseFeePerGas, gasLimit: block.gasLimit }),
    };
  }
  const finalized = await header('finalized');
  return { chain, rpc, header, finalized };
}

async function capture(market, config, owner, slices, intervalMs, externalSignal) {
  shape(slices, intervalMs);
  const {
    chain,
    rpc,
    header,
    finalized: end,
  } = await historySource(market, config, externalSignal);
  const now = Math.floor(Date.now() / 1000);
  if (end.time > now + 120 || end.time < now - 7200) throw Error('EXECUTION_PROFILE_HISTORY');
  const call = (to, data) => rpc('eth_call', [{ to, data }, hex(end.number)]);
  const { pool, token0 } = await market.basePool(config, chain, call);
  const interval = intervalMs / 1000;
  const duration = slices * interval;
  const startTime = end.time + 1 - periods * duration;
  const low = await header(hex(Math.max(0, end.number - scanBlocks + 1)));
  if (low.time > startTime || (low.time === startTime && low.number !== 0))
    throw Error('EXECUTION_PROFILE_HISTORY');
  const first = await blockAtOrAfter(header, low, end, startTime);

  const volumes = Array(slices).fill(0n);
  let swapCount = 0;
  let total = 0n;
  await scanSwaps(rpc, header, pool, first, end, (block, log) => {
    const slot = Math.floor(((block.time - startTime) % duration) / interval);
    const weth = token0 === chain.weth ? log.amount0 : log.amount1;
    if (weth === 0n) return;
    const amount = weth < 0n ? -weth : weth;
    volumes[slot] += amount;
    total += amount;
    swapCount++;
  });
  if (total === 0n) throw Error('EXECUTION_PROFILE_EMPTY');
  if (total >= 2n ** 128n) throw Error('EXECUTION_PROFILE_LIMIT');
  return {
    version: 1,
    owner,
    configHash: digest(config),
    chainId: chain.id,
    fee: config.poolFee,
    pool,
    slices,
    intervalMs,
    periods,
    startTime,
    endTime: end.time + 1,
    firstBlock: first.number,
    firstBlockHash: first.hash,
    finalizedBlock: end.number,
    finalizedBlockHash: end.hash,
    swapCount,
    wethVolumeAtoms: volumes.map(String),
  };
}

async function scanSwaps(rpc, header, pool, first, end, consume) {
  if (end.number < first.number || end.number - first.number >= scanBlocks)
    throw Error('EXECUTION_PROFILE_LIMIT');
  let logCount = 0;
  let previousTime = first.time;
  let chunk = chunkBlocks;
  let requests = 0;
  for (let from = first.number; from <= end.number;) {
    if (++requests > 256) throw Error('EXECUTION_PROFILE_LIMIT');
    const to = Math.min(end.number, from + chunk - 1);
    let logs;
    try {
      logs = await rpc('eth_getLogs', [
        { address: pool, fromBlock: hex(from), toBlock: hex(to), topics: [topic] },
      ]);
    } catch (error) {
      if (from === to || !rangeErrors.has(error.message)) throw error;
      chunk = Math.floor((to - from + 1) / 2);
      continue;
    }
    if (!Array.isArray(logs)) throw Error('EXECUTION_PROFILE_HISTORY');
    logCount += logs.length;
    if (logCount > maxLogs) throw Error('EXECUTION_PROFILE_LIMIT');
    const groups = new Map();
    const positions = new Set();
    for (const log of logs) {
      const number = quantity(log?.blockNumber);
      const logIndex = quantity(log.logIndex);
      const position = number + ':' + logIndex;
      if (
        log.removed ||
        typeof log.address !== 'string' ||
        log.address.toLowerCase() !== pool ||
        !Array.isArray(log.topics) ||
        log.topics.length !== 3 ||
        !log.topics.every((value) => typeof value === 'string' && hashPattern.test(value)) ||
        log.topics[0].toLowerCase() !== topic ||
        typeof log.data !== 'string' ||
        !/^0x[\da-f]{320}$/i.test(log.data) ||
        number < from ||
        number > to ||
        positions.has(position)
      )
        throw Error('EXECUTION_PROFILE_HISTORY');
      positions.add(position);
      const blockHash = hash(log.blockHash);
      const time = log.blockTimestamp === undefined ? undefined : quantity(log.blockTimestamp);
      const group = groups.get(number);
      if (group) {
        if (
          group.hash !== blockHash ||
          (time !== undefined && group.time !== undefined && time !== group.time)
        )
          throw Error('EXECUTION_PROFILE_CHANGED');
        group.time ??= time;
        group.logs.push({ log, logIndex });
      } else {
        groups.set(number, { number, hash: blockHash, time, logs: [{ log, logIndex }] });
      }
    }
    const blocks = [...groups.values()].sort((a, b) => a.number - b.number);
    // Check the populated edges of each response, and look up headers for logs
    // from providers that omit Base's blockTimestamp extension.
    const verify = blocks.filter(
      (block, index) => block.time === undefined || index === 0 || index === blocks.length - 1,
    );
    for (let offset = 0; offset < verify.length; offset += 4) {
      await Promise.all(
        verify.slice(offset, offset + 4).map(async (block) => {
          const canonical = await header(hex(block.number));
          if (
            canonical.hash !== block.hash ||
            (block.time !== undefined && block.time !== canonical.time)
          )
            throw Error('EXECUTION_PROFILE_CHANGED');
          block.time = canonical.time;
        }),
      );
    }
    for (const block of blocks) {
      if (block.time < previousTime || block.time > end.time)
        throw Error('EXECUTION_PROFILE_HISTORY');
      previousTime = block.time;
      block.logs.sort((a, b) => a.logIndex - b.logIndex);
      for (const { log, logIndex } of block.logs) {
        const { amount0, amount1 } = swap.decodeEventLog('Swap', log.data, log.topics);
        consume(block, { amount0, amount1, logIndex, transactionHash: log.transactionHash });
      }
    }
    from = to + 1;
  }
  if ((await header(hex(end.number))).hash !== end.hash) throw Error('EXECUTION_PROFILE_CHANGED');
}

const file = (directory, id) => path.join(directory, 'execution-profiles', id + '.json');
function archive(directory, profile, writeAtomic) {
  const id = digest(profile);
  writeAtomic(file(directory, id), profile);
  return { id, ...profile };
}
function load(directory, id, owner) {
  if (typeof id !== 'string' || !profilePattern.test(id)) throw Error('EXECUTION_PROFILE_REQUIRED');
  const source = file(directory, id);
  let profile;
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.size > 16384) throw Error();
    profile = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch {
    throw Error('EXECUTION_PROFILE_REQUIRED');
  }
  if (!profile || profile.owner !== owner || profile.version !== 1 || digest(profile) !== id)
    throw Error('EXECUTION_PROFILE_REQUIRED');
  return { id, ...profile };
}
function assertAllocation(plan, command) {
  const volumes = plan.vwap?.weth_volume_atoms;
  if (
    !profilePattern.test(plan.vwap?.profile_id || '') ||
    !Array.isArray(volumes) ||
    volumes.length !== plan.slices ||
    !volumes.every((v) => typeof v === 'string' && atomsPattern.test(v)) ||
    !atomsPattern.test(plan.total_input_atoms) ||
    !atomsPattern.test(command.input_atoms)
  )
    throw Error('EXECUTION_PROFILE_INVALID');
  let sum = 0n;
  let through = 0n;
  for (const [slot, text] of volumes.entries()) {
    const weight = BigInt(text);
    sum += weight;
    if (slot < command.ordinal) through += weight;
  }
  if (sum === 0n || sum >= 2n ** 128n) throw Error('EXECUTION_PROFILE_INVALID');
  const total = BigInt(plan.total_input_atoms);
  const before = through - BigInt(volumes[command.ordinal - 1]);
  const input = (total * through) / sum - (total * before) / sum;
  if (input <= 0n || command.input_atoms !== String(input))
    throw Error('EXECUTION_PROFILE_INVALID');
}
module.exports = {
  capture,
  archive,
  load,
  assertAllocation,
  historySource,
  scanSwaps,
  blockAtOrAfter,
  scanBlocks,
};
