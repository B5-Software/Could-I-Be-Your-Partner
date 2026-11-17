/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BASE_FEEDS,
  feedAbi,
  valuePortfolio,
} = require('../../src/main/services/quant/portfolio-valuation');
const { CHAINS, MarketData } = require('../../src/main/services/quant/market-data');

function fixture(now = Math.floor(Date.now() / 1000)) {
  const state = {
    ethAnswer: 200000000000n,
    ethAge: 30,
    ethDecimals: 8,
    seqAnswer: 0n,
    seqStarted: now - 7200,
  };
  const calls = [];
  const context = {
    chain: CHAINS.base,
    timestamp: BigInt(now),
    block: { hash: '0x' + 'a'.repeat(64) },
  };
  const asset = (kind, amountAtomic, address, decimals, symbol) => ({
    kind,
    amountAtomic,
    address,
    decimals,
    symbol,
  });
  const one = [
    asset('native', '1000000000000000000', undefined, 18, 'ETH'),
    asset('erc20', '500000000000000000', CHAINS.base.weth, 18, 'WETH'),
    asset('erc20', '1000000', CHAINS.base.usdc, 6, 'USDC'),
    asset('erc20', '3', '0x' + '4'.repeat(40), 0, null),
  ];
  const two = one.map((value, index) => ({
    ...value,
    amountAtomic: ['2000000000000000000', '0', '2000000', '0'][index],
  }));
  const members = [
    { walletId: 'one', assets: one },
    { walletId: 'two', assets: two },
  ];
  const assets = one.map((value, index) => ({
    ...value,
    amountAtomic: String(BigInt(value.amountAtomic) + BigInt(two[index].amountAtomic)),
  }));
  context.rpc = async (method, params) => {
    assert.equal(method, 'eth_call');
    assert.deepEqual(params[1], { blockHash: context.block.hash, requireCanonical: true });
    calls.push(params);
    const address = params[0].to;
    if (params[0].data === feedAbi.encodeFunctionData('decimals'))
      return feedAbi.encodeFunctionResult('decimals', [
        address === BASE_FEEDS.eth.address ? state.ethDecimals : 8,
      ]);
    assert.equal(params[0].data, feedAbi.encodeFunctionData('latestRoundData'));
    const sequence = address === BASE_FEEDS.sequencer;
    const age = address === BASE_FEEDS.eth.address ? state.ethAge : 60;
    return feedAbi.encodeFunctionResult('latestRoundData', [
      1,
      sequence ? state.seqAnswer : address === BASE_FEEDS.eth.address ? state.ethAnswer : 98000000n,
      sequence ? state.seqStarted : now - age - 10,
      now - age,
      1,
    ]);
  };
  return {
    context,
    assets,
    members,
    state,
    calls,
    now,
    read: () => valuePortfolio(context, assets, members),
  };
}

test('historical fee pricing fixes the block, checks finality and rejects stale rounds or a reorg', async () => {
  const f = fixture(Math.floor(Date.now() / 1000) - 86400);
  const block = { ...f.context.block, number: '0x14', timestamp: '0x' + f.now.toString(16) };
  const market = new MarketData();
  let finalized = block,
    canonicalReads = 0,
    reorg = false;
  market.rpc = async (_venue, _url, method, params) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_call') return f.context.rpc(method, params);
    assert.equal(method, 'eth_getBlockByNumber');
    if (params[0] === 'finalized') return finalized;
    assert.deepEqual(params, ['0x14', false]);
    canonicalReads++;
    if (reorg && canonicalReads === 2) return { ...block, hash: '0x' + 'b'.repeat(64) };
    return block;
  };
  const quote = () => market.baseFeeQuote({ venue: 'base' }, '20', block.hash);
  const result = await quote();
  assert.equal(result.blockHash, block.hash);
  assert.equal(result.timestamp, f.now);
  assert.equal(result.eth.roundId, '1');
  assert.equal(result.usdc.price, '0.98');
  assert.equal(f.calls.length, 5);
  finalized = { ...block, number: '0x13' };
  await assert.rejects(quote(), /WALLET_PRICE_BLOCK_UNFINALIZED/);
  finalized = block;
  f.state.ethAge = 1501;
  await assert.rejects(quote(), /WALLET_PRICE_STALE/);
  canonicalReads = 0;
  reorg = true;
  await assert.rejects(quote(), /BLOCK_REORG/);
});

test('USD reference values preserve decimal math, depeg pricing, partial coverage and the member-to-total sum', async () => {
  const f = fixture(),
    before = JSON.stringify([f.assets, f.members]);
  const result = await f.read();
  assert.equal(result.valuation.complete, false);
  assert.equal(result.valuation.value, null);
  assert.equal(result.valuation.knownValue, '7002.94');
  assert.equal(result.assets[2].valuation.value, '2.94');
  assert.equal(result.members[0].valuation.knownValue, '3000.98');
  assert.equal(result.assets[3].valuation.error, 'WALLET_PRICE_NO_FEED');
  assert.equal(result.members[1].assets[3].valuation.value, '0');
  assert.equal(result.valuation.prices.usdc.stablecoinCapped, true);
  assert.equal(result.valuation.prices.eth.ageSeconds, 30);
  assert.equal(
    result.valuation.knownValueAtomic,
    String(
      result.members.reduce((sum, member) => sum + BigInt(member.valuation.knownValueAtomic), 0n),
    ),
  );
  assert.equal(f.calls.length, 5);
  assert.equal(JSON.stringify([f.assets, f.members]), before);
});

test('invalid or stale feeds and sequencer outages never become current USD prices', async (t) => {
  for (const [name, change, expected] of [
    [
      'negative price',
      (f) => {
        f.state.ethAnswer = -1n;
      },
      'WALLET_PRICE_INVALID',
    ],
    [
      'stale price',
      (f) => {
        f.state.ethAge = 1501;
      },
      'WALLET_PRICE_STALE',
    ],
    [
      'future price',
      (f) => {
        f.state.ethAge = -10;
      },
      'WALLET_PRICE_INVALID',
    ],
    [
      'wrong decimals',
      (f) => {
        f.state.ethDecimals = 18;
      },
      'WALLET_PRICE_INVALID',
    ],
    [
      'sequencer down',
      (f) => {
        f.state.seqAnswer = 1n;
      },
      'WALLET_PRICE_SEQUENCER_DOWN',
    ],
    [
      'sequencer grace',
      (f) => {
        f.state.seqStarted = f.now - 3600;
      },
      'WALLET_PRICE_SEQUENCER_GRACE',
    ],
    [
      'stale block',
      (f) => {
        f.context.timestamp = BigInt(f.now - 301);
      },
      'WALLET_PRICE_BLOCK_STALE',
    ],
    [
      'test network',
      (f) => {
        f.context.chain = CHAINS['base-sepolia'];
      },
      'WALLET_PRICE_NETWORK',
    ],
  ])
    await t.test(name, async () => {
      const f = fixture();
      change(f);
      const result = await f.read();
      assert.equal(result.assets[0].valuation.value, null);
      assert.equal(result.assets[0].valuation.error, expected);
      assert.equal(result.valuation.value, null);
    });
});

test('one failed feed keeps other reference prices and known partial values without treating missing balances as zero', async () => {
  const f = fixture(),
    original = f.context.rpc;
  f.context.rpc = (method, params) => {
    if (params[0].to === BASE_FEEDS.eth.address) throw Error('fixture feed outage');
    return original(method, params);
  };
  f.members[1].assets[2].amountAtomic = null;
  f.members[1].assets[2].error = 'WALLET_ASSET_UNAVAILABLE';
  f.assets[2].amountAtomic = null;
  const result = await f.read();
  assert.equal(result.valuation.value, null);
  assert.equal(result.valuation.knownValue, '0.98');
  assert.equal(result.valuation.prices.eth.status, 'unavailable');
  assert.equal(result.valuation.prices.eth.error, 'WALLET_PRICE_UNAVAILABLE');
  assert.equal(result.valuation.prices.usdc.status, 'available');
  assert.equal(result.assets[2].valuation.value, null);
  assert.equal(result.assets[2].valuation.knownValue, '0.98');
  assert.equal(result.members[1].assets[2].valuation.error, 'WALLET_ASSET_UNAVAILABLE');
  assert.equal(result.members[1].assets[1].valuation.value, '0');
});

test('malformed oracle ABI never produces a price', async (t) => {
  for (const raw of [
    '0x',
    '0x' + '0'.repeat(320),
    '0x' + 'f'.repeat(320),
    '0x' + '0'.repeat(384),
  ]) {
    await t.test(raw.slice(0, 12) + ':' + raw.length, async () => {
      const f = fixture(),
        original = f.context.rpc;
      f.context.rpc = (method, params) =>
        params[0].to === BASE_FEEDS.eth.address &&
        params[0].data === feedAbi.encodeFunctionData('latestRoundData')
          ? Promise.resolve(raw)
          : original(method, params);
      const result = await f.read();
      assert.equal(result.assets[0].valuation.value, null);
      assert.equal(result.valuation.prices.eth.status, 'unavailable');
      assert.equal(result.assets[2].valuation.value, '2.94');
    });
  }
});

test('eight-place USD flooring preserves member totals for dust and full uint256 holdings', async () => {
  const f = fixture();
  for (const member of f.members) {
    member.assets[0].amountAtomic = '1';
    member.assets[1].amountAtomic = '999999';
    member.assets[3].amountAtomic = '0';
  }
  f.members[0].assets[2].amountAtomic = String((1n << 256n) - 1n);
  for (const [index, asset] of f.assets.entries())
    asset.amountAtomic = String(
      f.members.reduce((sum, member) => sum + BigInt(member.assets[index].amountAtomic), 0n),
    );
  const result = await f.read();
  assert.equal(result.valuation.complete, true);
  assert.equal(result.assets[0].valuation.value, '0');
  assert.equal(result.assets[1].valuation.valueAtomic, '0');
  const expected = (((1n << 256n) - 1n) * 98000000n) / 1000000n + 196000000n;
  assert.equal(result.valuation.valueAtomic, String(expected));
  assert.equal(result.valuation.rounding, 'floor-per-wallet-asset');
});

test('portfolio reference prices are opt-in and a reorg during the oracle read rejects the whole snapshot', async () => {
  const f = fixture();
  const block = { ...f.context.block, number: '0x123', timestamp: '0x' + f.now.toString(16) };
  f.context.block = block;
  let canonical = block,
    oracleCalls = 0;
  const market = new MarketData();
  market.rpc = async (_chain, _url, method, params) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') return params[0] === 'latest' ? block : canonical;
    assert.deepEqual(params[1], { blockHash: block.hash, requireCanonical: true });
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
    if (
      [BASE_FEEDS.eth.address, BASE_FEEDS.usdc.address, BASE_FEEDS.sequencer].includes(params[0].to)
    ) {
      oracleCalls++;
      canonical = { ...block, hash: '0x' + 'b'.repeat(64) };
      return f.context.rpc(method, params);
    }
    return '0x' + '0'.repeat(63) + '1';
  };
  const members = [{ walletId: 'one', address: '0x' + '1'.repeat(40) }];
  assert.equal(
    (await market.portfolioHoldings({ venue: 'base' }, { members })).valuation,
    undefined,
  );
  assert.equal(oracleCalls, 0);
  await assert.rejects(
    market.portfolioHoldings({ venue: 'base' }, { members, valuation: true }),
    /BLOCK_REORG/,
  );
  assert.equal(oracleCalls, 5);
});
