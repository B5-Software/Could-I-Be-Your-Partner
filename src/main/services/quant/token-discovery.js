/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { getAddress, id, ZeroAddress, zeroPadValue } = require('ethers');
const { boundedRpc, readTokenBalance } = require('./market-data');
const { digest, page } = require('./event-files');

const transferTopic = id('Transfer(address,address,uint256)');
const hashPattern = /^0x[\da-f]{64}$/i;
const addressTopic = /^0x0{24}[\da-f]{40}$/i;
const blockText = /^(?:0|[1-9]\d{0,15})$/;
const validBlock = (value) => typeof value === 'string' && blockText.test(value);
const quantity = (value) =>
  typeof value === 'string' && /^0x(?:0|[1-9a-f][\da-f]{0,15})$/i.test(value)
    ? BigInt(value)
    : null;
const hex = (number) => '0x' + number.toString(16);

function transferCandidates(incoming, outgoing, owner, start, end) {
  const seen = new Map(),
    tokens = new Map();
  let ignoredEvents = 0;
  for (const [logs, direction] of [
    [incoming, 2],
    [outgoing, 1],
  ]) {
    if (!Array.isArray(logs)) throw Error('INVALID_RPC_RESPONSE');
    if (logs.length > 1024) throw Error('WALLET_DISCOVERY_DENSE');
    for (const log of logs) {
      if (log?.removed) throw Error('BLOCK_REORG');
      const topics = Array.isArray(log?.topics)
        ? log.topics.map((topic) => (typeof topic === 'string' ? topic.toLowerCase() : null))
        : null;
      if (topics?.[direction] !== owner || topics[0] !== transferTopic)
        throw Error('INVALID_RPC_RESPONSE');
      const height = quantity(log.blockNumber),
        position = quantity(log.logIndex);
      if (
        height === null ||
        height < start ||
        height > end ||
        position === null ||
        !hashPattern.test(log.blockHash || '') ||
        !hashPattern.test(log.transactionHash || '')
      )
        throw Error('INVALID_RPC_RESPONSE');
      const token = getAddress(log.address);
      if (token === ZeroAddress) throw Error('INVALID_RPC_RESPONSE');
      const key = `${height}:${position}`;
      const fingerprint = [token, log.blockHash, log.transactionHash, ...topics, log.data].join(
        ':',
      );
      if (seen.has(key)) {
        if (seen.get(key) !== fingerprint) throw Error('INVALID_RPC_RESPONSE');
        continue;
      }
      seen.set(key, fingerprint);
      // ERC-721 uses the same event signature but indexes the token ID instead of a value word.
      if (
        topics.length !== 3 ||
        !addressTopic.test(topics[1] || '') ||
        !addressTopic.test(topics[2] || '') ||
        !hashPattern.test(log.data || '') ||
        BigInt(log.data) === 0n
      ) {
        ignoredEvents++;
        continue;
      }
      let activity = tokens.get(token);
      if (!activity) {
        activity = { token, received: 0, sent: 0 };
        tokens.set(token, activity);
      }
      if (topics[1] === owner) activity.sent++;
      if (topics[2] === owner) activity.received++;
      if (
        activity.height === undefined ||
        height > activity.height ||
        (height === activity.height && position > activity.position)
      ) {
        Object.assign(activity, {
          height,
          position,
          blockHash: log.blockHash.toLowerCase(),
          transactionHash: log.transactionHash.toLowerCase(),
        });
      }
    }
  }
  const candidates = [...tokens.values()].sort((a, b) =>
    a.height === b.height ? (a.position > b.position ? -1 : 1) : a.height > b.height ? -1 : 1,
  );
  return {
    ignoredEvents,
    candidates: candidates.map(({ height, position, ...activity }) => ({
      ...activity,
      block: String(height),
      logIndex: String(position),
    })),
  };
}

async function discoverTokens(market, config, input, requestSignal) {
  const owner = getAddress(input.address);
  if (owner === ZeroAddress) throw Error('INVALID_ADDRESS');
  const blocks = input.blocks ?? 256,
    limit = input.limit ?? 8,
    offset = input.offset ?? 0;
  page([], { offset, limit });
  const anchored = input.anchorBlock !== undefined || input.anchorHash !== undefined;
  if (
    !Number.isInteger(blocks) ||
    blocks < 1 ||
    blocks > 2000 ||
    limit > 16 ||
    (anchored &&
      (!validBlock(input.anchorBlock) ||
        typeof input.anchorHash !== 'string' ||
        !hashPattern.test(input.anchorHash))) ||
    (input.endBlock !== undefined && (!anchored || !validBlock(input.endBlock))) ||
    (offset > 0 && (!anchored || !input.snapshotId)) ||
    (input.snapshotId !== undefined && !/^[\da-f]{64}$/.test(input.snapshotId))
  )
    throw Error('WALLET_DISCOVERY_RANGE');

  const timeout = AbortSignal.timeout(30000);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  signal.throwIfAborted();
  const {
    rpc: connected,
    chain,
    block,
    height,
  } = await market.connect(config, { blockTag: 'finalized', signal });
  const rpc = boundedRpc(connected);
  const anchorBlock = anchored ? BigInt(input.anchorBlock) : height;
  const anchorHash = (input.anchorHash ?? block.hash).toLowerCase();
  const end = input.endBlock === undefined ? anchorBlock : BigInt(input.endBlock);
  if (anchorBlock > height || end > anchorBlock) throw Error('WALLET_DISCOVERY_RANGE');
  const start = end < BigInt(blocks) ? 0n : end - BigInt(blocks) + 1n;
  const canonical = async (number, hash) => {
    const result = await rpc('eth_getBlockByNumber', [hex(number), false]);
    if (
      quantity(result?.number) !== number ||
      typeof result.hash !== 'string' ||
      result.hash.toLowerCase() !== hash
    )
      throw Error('BLOCK_REORG');
  };
  if (height === anchorBlock && block.hash.toLowerCase() !== anchorHash) throw Error('BLOCK_REORG');
  await canonical(anchorBlock, anchorHash);
  const topic = zeroPadValue(owner, 32).toLowerCase();
  const range = { fromBlock: hex(start), toBlock: hex(end) };
  const [incoming, outgoing] = await Promise.all([
    rpc('eth_getLogs', [{ ...range, topics: [transferTopic, null, topic] }]),
    rpc('eth_getLogs', [{ ...range, topics: [transferTopic, topic] }]),
  ]);
  const { candidates, ignoredEvents } = transferCandidates(incoming, outgoing, topic, start, end);
  const snapshotId = digest([
    chain.id,
    config.venue,
    owner,
    anchorHash,
    String(start),
    String(end),
    candidates,
    ignoredEvents,
  ]);
  if (input.snapshotId !== undefined && input.snapshotId !== snapshotId)
    throw Error('WALLET_DISCOVERY_CHANGED');
  const rows = page(candidates, { offset, limit });
  const tag = { blockHash: anchorHash, requireCanonical: true };
  // Check the provenance of every returned candidate without fetching a header per transfer.
  const headers = new Map();
  for (const { block, blockHash } of rows.items) {
    if (headers.has(block) && headers.get(block) !== blockHash) throw Error('BLOCK_REORG');
    headers.set(block, blockHash);
  }
  await Promise.all([...headers].map(([block, blockHash]) => canonical(BigInt(block), blockHash)));
  const items = await Promise.all(
    rows.items.map(async (activity) => ({
      ...activity,
      ...(await readTokenBalance(rpc, tag, owner, activity.token, null, true)),
    })),
  );
  signal.throwIfAborted();
  await canonical(anchorBlock, anchorHash);
  signal.throwIfAborted();
  return {
    chainId: chain.id,
    network: chain.name,
    address: owner,
    anchorBlock: String(anchorBlock),
    anchorHash,
    fromBlock: String(start),
    toBlock: String(end),
    snapshotId,
    ignoredEvents,
    nextEndBlock: start ? String(start - 1n) : null,
    ...rows,
    items,
  };
}

module.exports = { discoverTokens };
