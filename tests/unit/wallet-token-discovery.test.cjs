/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, getAddress, id, toBeHex, zeroPadValue } = require('ethers');
const { discoverTokens } = require('../../src/main/services/quant/token-discovery');

const owner = '0x' + '1'.repeat(40),
  other = '0x' + '2'.repeat(40);
const first = '0x' + '3'.repeat(40),
  second = '0x' + '4'.repeat(40);
const hash = (value) => toBeHex(value, 32);
const ownerTopic = zeroPadValue(owner, 32),
  otherTopic = zeroPadValue(other, 32);
const transfer = id('Transfer(address,address,uint256)');
const abi = new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function decimals() view returns(uint8)',
  'function symbol() view returns(string)',
]);
const event = (address, from, to, block, index) => ({
  address,
  blockHash: hash(block),
  blockNumber: toBeHex(block).replace(/^0x0/, '0x'),
  logIndex: '0x' + index.toString(16),
  transactionHash: hash(index + 50),
  topics: [transfer, from, to],
  data: hash(2),
  removed: false,
});
const venue = { venue: 'base' };

function fixture() {
  const own = event(first, ownerTopic, ownerTopic, 32, 1);
  const nft = event('0x' + '7'.repeat(40), otherTopic, ownerTopic, 32, 3);
  nft.topics.push(hash(1));
  nft.data = '0x';
  const data = {
    incoming: [own, nft, event(second, otherTopic, ownerTopic, 31, 6)],
    outgoing: [own],
    root: 32,
    replace: false,
    anchorReads: 0,
  };
  const headers = (n) => ({ number: '0x' + n.toString(16), hash: hash(n) });
  const market = {
    connect: async (_config, options) => {
      assert.equal(options.blockTag, 'finalized');
      const rpc = async (method, params) => {
        options.signal.throwIfAborted();
        if (method === 'eth_getBlockByNumber') {
          const n = Number(params[0]);
          if (data.replace && n === data.root && ++data.anchorReads === 3)
            return { ...headers(n), hash: hash(77) };
          return headers(n);
        }
        if (method === 'eth_getLogs') {
          const [{ fromBlock, toBlock, topics }] = params;
          assert.equal(topics[0], transfer);
          assert.equal(topics[1] ?? topics[2], ownerTopic);
          return (topics[1] ? data.outgoing : data.incoming).filter(
            (row) =>
              Number(row.blockNumber) >= Number(fromBlock) &&
              Number(row.blockNumber) <= Number(toBlock),
          );
        }
        assert.equal(method, 'eth_call');
        assert.deepEqual(params[1], { blockHash: hash(32), requireCanonical: true });
        const decoded = abi.parseTransaction(params[0]);
        if (decoded.name === 'balanceOf') {
          assert.equal(decoded.args[0], owner);
          if (params[0].to === second) throw Error('RPC unavailable');
          return abi.encodeFunctionResult('balanceOf', [42]);
        }
        if (decoded.name === 'decimals') return abi.encodeFunctionResult('decimals', [1]);
        return abi.encodeFunctionResult('symbol', ['TOKEN']);
      };
      return {
        rpc,
        chain: { id: 8453, name: 'Base' },
        height: BigInt(data.root),
        block: headers(data.root),
      };
    },
  };
  return { market, data };
}

test('discovery separates ERC-20 and NFT events, deduplicates self-transfers and binds later pages', async () => {
  const { market, data } = fixture();
  const report = await discoverTokens(market, venue, { address: owner, blocks: 2, limit: 1 });
  assert.equal(report.ignoredEvents, 1);
  assert.equal(report.total, 2);
  assert.equal(report.next, 1);
  assert.equal(report.nextEndBlock, '30');
  assert.equal(report.items[0].token, getAddress(first));
  assert.equal(report.items[0].symbol, 'TOKEN');
  assert.equal(report.items[0].amount, '4.2');
  assert.equal(report.items[0].received, 1);
  assert.equal(report.items[0].sent, 1);
  const continuation = {
    address: owner,
    blocks: 2,
    limit: 1,
    offset: 1,
    anchorBlock: report.anchorBlock,
    anchorHash: report.anchorHash,
    snapshotId: report.snapshotId,
  };
  data.root = 33;
  const later = await discoverTokens(market, venue, continuation);
  assert.equal(later.anchorBlock, '32');
  assert.equal(later.items[0].token, second);
  assert.equal(later.items[0].amount, null);
  assert.equal(later.items[0].error, 'WALLET_ASSET_UNAVAILABLE');
  data.incoming.pop();
  await assert.rejects(discoverTokens(market, venue, continuation), /WALLET_DISCOVERY_CHANGED/);
});

test('discovery rejects a changed canonical block and cannot page without a pinned window', async () => {
  const { market, data } = fixture();
  await assert.rejects(
    discoverTokens(market, venue, { address: owner, offset: 1 }),
    /WALLET_DISCOVERY_RANGE/,
  );
  data.replace = true;
  await assert.rejects(discoverTokens(market, venue, { address: owner, blocks: 2 }), /BLOCK_REORG/);
});
