/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Interface } = require('ethers');
const { decimal } = require('./decimal');

// Reviewed against Chainlink's reference-data directory on 2026-11-05.
// ETH uses the standard secondary proxy of the shared SVR feed.
// https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json
const BASE_FEEDS = Object.freeze({
  eth: {
    pair: 'ETH/USD',
    address: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    decimals: 8,
    heartbeatSeconds: 1200,
  },
  usdc: {
    pair: 'USDC/USD',
    address: '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B',
    decimals: 8,
    heartbeatSeconds: 86400,
    stablecoinCapped: true,
  },
  sequencer: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433',
});
const feedAbi = new Interface([
  'function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
  'function decimals() view returns(uint8)',
]);

function round(result) {
  if (typeof result !== 'string' || !/^0x[\da-f]{320}$/i.test(result))
    throw Error('WALLET_PRICE_INVALID');
  const decoded = feedAbi.decodeFunctionResult('latestRoundData', result);
  if (
    feedAbi.encodeFunctionResult('latestRoundData', decoded) !== result.toLowerCase() ||
    decoded.roundId === 0n
  )
    throw Error('WALLET_PRICE_INVALID');
  return decoded;
}

async function prices(context, { historical = false } = {}) {
  const unavailable = (error) => ({ status: 'unavailable', error });
  const result = {
    source: 'Chainlink',
    prices: {},
    sequencer: unavailable('WALLET_PRICE_NETWORK'),
  };
  if (context.chain.id !== 8453) return result;
  if (!historical && Math.floor(Date.now() / 1000) - Number(context.timestamp) > 300) {
    result.sequencer = {
      address: BASE_FEEDS.sequencer,
      ...unavailable('WALLET_PRICE_BLOCK_STALE'),
    };
    return result;
  }
  const tag = { blockHash: context.block.hash, requireCanonical: true };
  const call = (to, method) =>
    context.rpc('eth_call', [{ to, data: feedAbi.encodeFunctionData(method) }, tag]);
  try {
    const status = round(await call(BASE_FEEDS.sequencer, 'latestRoundData'));
    if (
      status.startedAt === 0n ||
      status.startedAt > context.timestamp ||
      status.updatedAt < status.startedAt ||
      status.updatedAt > context.timestamp
    )
      throw Error('WALLET_PRICE_INVALID');
    if (status.answer !== 0n) throw Error('WALLET_PRICE_SEQUENCER_DOWN');
    if (context.timestamp - status.startedAt <= 3600n) throw Error('WALLET_PRICE_SEQUENCER_GRACE');
    result.sequencer = {
      status: 'up',
      address: BASE_FEEDS.sequencer,
      startedAt: Number(status.startedAt),
      updatedAt: Number(status.updatedAt),
      graceSeconds: 3600,
    };
  } catch (error) {
    result.sequencer = {
      address: BASE_FEEDS.sequencer,
      ...unavailable(
        /^WALLET_PRICE_/.test(error?.message) ? error.message : 'WALLET_PRICE_UNAVAILABLE',
      ),
    };
    return result;
  }
  await Promise.all(
    ['eth', 'usdc'].map(async (key) => {
      const feed = BASE_FEEDS[key];
      const record = { ...feed, source: 'Chainlink', maxAgeSeconds: feed.heartbeatSeconds + 300 };
      try {
        const reads = await Promise.allSettled([
          call(feed.address, 'latestRoundData'),
          call(feed.address, 'decimals'),
        ]);
        const failed = reads.find((read) => read.status === 'rejected');
        if (failed) throw failed.reason;
        const [raw, digits] = reads.map((read) => read.value);
        if (
          typeof digits !== 'string' ||
          !/^0x[\da-f]{64}$/i.test(digits) ||
          BigInt(digits) !== BigInt(feed.decimals)
        )
          throw Error('WALLET_PRICE_INVALID');
        const data = round(raw);
        if (
          data.answer <= 0n ||
          data.startedAt === 0n ||
          data.startedAt > data.updatedAt ||
          data.updatedAt > context.timestamp ||
          data.answeredInRound < data.roundId
        )
          throw Error('WALLET_PRICE_INVALID');
        const age = context.timestamp - data.updatedAt;
        if (age > BigInt(record.maxAgeSeconds)) throw Error('WALLET_PRICE_STALE');
        result.prices[key] = {
          ...record,
          status: 'available',
          priceAtomic: String(data.answer),
          price: decimal(data.answer),
          updatedAt: Number(data.updatedAt),
          ageSeconds: Number(age),
          roundId: String(data.roundId),
        };
      } catch (error) {
        result.prices[key] = {
          ...record,
          ...unavailable(
            /^WALLET_PRICE_/.test(error?.message) ? error.message : 'WALLET_PRICE_UNAVAILABLE',
          ),
        };
      }
    }),
  );
  return result;
}

function valuation(complete, known) {
  return {
    complete,
    currency: 'USD',
    decimals: 8,
    valueAtomic: complete ? String(known) : null,
    value: complete ? decimal(known) : null,
    knownValueAtomic: String(known),
    knownValue: decimal(known),
    rounding: 'floor-per-wallet-asset',
  };
}

async function valuePortfolio(context, assets, members) {
  const source = await prices(context);
  const supported = context.chain.id === 8453;
  const quoteFor = (asset) =>
    asset.kind === 'native' || asset.address?.toLowerCase() === context.chain.weth
      ? 'eth'
      : asset.address?.toLowerCase() === context.chain.usdc
        ? 'usdc'
        : null;
  const valuedMembers = members.map((member) => {
    const rows = member.assets.map((asset) => {
      const key = quoteFor(asset),
        quote = key ? source.prices[key] : null;
      const zero = supported && asset.amountAtomic === '0';
      const priced =
        supported &&
        quote?.status === 'available' &&
        asset.amountAtomic !== null &&
        asset.decimals !== null;
      const known = priced
        ? (BigInt(asset.amountAtomic) * BigInt(quote.priceAtomic)) / 10n ** BigInt(asset.decimals)
        : 0n;
      const error = !supported
        ? 'WALLET_PRICE_NETWORK'
        : asset.error ||
          (zero ? null : source.sequencer.error || quote?.error || 'WALLET_PRICE_NO_FEED');
      return {
        ...asset,
        valuation: {
          ...valuation(zero || priced, known),
          priceKey: key,
          ...(zero || priced ? {} : { error }),
        },
      };
    });
    const known = rows.reduce((sum, row) => sum + BigInt(row.valuation.knownValueAtomic), 0n);
    return {
      ...member,
      assets: rows,
      valuation: valuation(
        rows.every((row) => row.valuation.complete),
        known,
      ),
    };
  });
  const valuedAssets = assets.map((asset, index) => {
    const rows = valuedMembers.map((member) => member.assets[index].valuation);
    const known = rows.reduce((sum, row) => sum + BigInt(row.knownValueAtomic), 0n);
    const failed = rows.find((row) => row.error);
    return {
      ...asset,
      valuation: {
        ...valuation(
          rows.every((row) => row.complete),
          known,
        ),
        priceKey: quoteFor(asset),
        ...(failed ? { error: failed.error } : {}),
      },
    };
  });
  const known = valuedAssets.reduce(
    (sum, asset) => sum + BigInt(asset.valuation.knownValueAtomic),
    0n,
  );
  return {
    assets: valuedAssets,
    members: valuedMembers,
    valuation: {
      ...valuation(
        valuedAssets.every((asset) => asset.valuation.complete),
        known,
      ),
      ...source,
    },
  };
}

module.exports = { BASE_FEEDS, feedAbi, valuePortfolio, prices };
