/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { decimal, SCALE } = require('./decimal');
const { validateCandles } = require('./backtest');

const CHAINS = Object.freeze({
  base: {
    id: 8453,
    name: 'Base',
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
  'base-sepolia': {
    id: 84532,
    name: 'Base Sepolia',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    factory: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  },
});
const INTERVALS = [60, 300, 900, 3600, 21600, 86400];
const address = (input) => {
  if (!/^0x[\da-f]{40}$/i.test(String(input))) throw new Error('INVALID_ADDRESS');
  return String(input).toLowerCase();
};
const word = (hex, index = 0) => {
  if (typeof hex !== 'string' || !/^0x(?:[\da-f]{64})+$/i.test(hex) || hex.length > 32770)
    throw new Error('INVALID_CONTRACT_RESPONSE');
  const text = hex.slice(2 + index * 64, 66 + index * 64);
  if (text.length !== 64) throw new Error('INVALID_CONTRACT_RESPONSE');
  return BigInt('0x' + text);
};
const contractAddress = (hex) => {
  const value = word(hex);
  if (value >> 160n) throw new Error('INVALID_CONTRACT_RESPONSE');
  return address('0x' + value.toString(16).padStart(40, '0'));
};
const uint = (hex) => {
  if (typeof hex !== 'string' || !/^0x[\da-f]{1,64}$/i.test(hex))
    throw new Error('INVALID_RPC_RESPONSE');
  return BigInt(hex);
};
const endpoint = (input) => {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('INVALID_RPC_URL');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !(
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    )
  )
    throw new Error('RPC_REQUIRES_HTTPS_OR_LOCALHOST');
  return parsed.href;
};

async function json(fetcher, url, options = {}) {
  const response = await fetcher(url, {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(12000)])
      : AbortSignal.timeout(12000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`MARKET_HTTP_${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error('MARKET_RESPONSE_LIMIT');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('INVALID_MARKET_JSON');
  }
}

class MarketData {
  constructor(fetcher = (...args) => global.fetch(...args)) {
    this.fetch = fetcher;
  }
  async publicProduct(product) {
    if (!['ETH-USD', 'BTC-USD', 'SOL-USD'].includes(product))
      throw new Error('SOURCE_MARKET_INVALID');
    return json(this.fetch, 'https://api.coinbase.com/api/v3/brokerage/market/products/' + product);
  }
  async publicTime() {
    return json(this.fetch, 'https://api.coinbase.com/api/v3/brokerage/time', {
      headers: { 'Cache-Control': 'no-cache' },
    });
  }
  async rpc(chain, rpcUrl, method, params = [], options = {}) {
    if (!CHAINS[chain]) throw new Error('CHAIN_UNAVAILABLE');
    const reply = await json(this.fetch, endpoint(rpcUrl || CHAINS[chain].rpc), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: options.signal,
    });
    if (reply.id !== 1 || reply.jsonrpc !== '2.0' || reply.error || reply.result === undefined)
      throw new Error(
        reply.error ? `BASE_RPC_ERROR_${Number(reply.error.code) || 0}` : 'INVALID_RPC_RESPONSE',
      );
    return reply.result;
  }
  async connect(config, options = {}) {
    const chain = CHAINS[config.venue];
    if (!chain) throw new Error('CHAIN_UNAVAILABLE');
    const rpc = (method, params) => this.rpc(config.venue, config.rpcUrl, method, params, options);
    if (uint(await rpc('eth_chainId')) !== BigInt(chain.id)) throw new Error('CHAIN_ID_MISMATCH');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    if (!block || !/^0x[\da-f]{64}$/i.test(block.hash || '')) throw new Error('INVALID_BLOCK');
    const height = uint(block.number),
      timestamp = uint(block.timestamp);
    if (timestamp > BigInt(Math.floor(Date.now() / 1000) + 120))
      throw new Error('BLOCK_CLOCK_SKEW');
    return { chain, rpc, block, height, timestamp };
  }
  async chainStatus(config, input = {}, options = {}) {
    const { chain, rpc, block, height, timestamp } = await this.connect(config, options);
    const finality = {};
    await Promise.all(
      ['safe', 'finalized'].map(async (tag) => {
        try {
          const value = await rpc('eth_getBlockByNumber', [tag, false]);
          finality[tag] = value ? { number: String(uint(value.number)), hash: value.hash } : null;
        } catch {
          finality[tag] = null;
        }
      }),
    );
    const result = {
      chainId: chain.id,
      network: chain.name,
      block: String(height),
      hash: block.hash,
      timestamp: Number(timestamp),
      finality,
      observedAt: Date.now(),
    };
    if (input.address) {
      const owner = address(input.address);
      const balance = uint(await rpc('eth_getBalance', [owner, block.number]));
      result.balance = { address: owner, wei: String(balance), eth: formatUnits(balance, 18) };
    }
    if (input.hash) {
      if (!/^0x[\da-f]{64}$/i.test(input.hash)) throw new Error('INVALID_TRANSACTION_HASH');
      const receipt = await rpc('eth_getTransactionReceipt', [input.hash]);
      result.transaction = { hash: input.hash, state: 'pending-or-unknown' };
      if (receipt) {
        const canonical = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
        const number = uint(receipt.blockNumber);
        let state =
          canonical?.hash !== receipt.blockHash
            ? 'reorged'
            : uint(receipt.status) === 0n
              ? 'reverted'
              : 'included';
        if (state === 'included') {
          if (finality.finalized && BigInt(finality.finalized.number) >= number)
            state = 'finalized';
          else if (finality.safe && BigInt(finality.safe.number) >= number) state = 'safe';
        }
        const confirmation =
          canonical?.hash !== receipt.blockHash
            ? 'reorged'
            : finality.finalized && BigInt(finality.finalized.number) >= number
              ? 'finalized'
              : finality.safe && BigInt(finality.safe.number) >= number
                ? 'safe'
                : 'included';
        result.transaction = { hash: input.hash, block: String(number), state, confirmation };
      }
    }
    return result;
  }
  async base(config, options = {}) {
    const { chain, rpc, block, height, timestamp } = await this.connect(config, options);
    const call = (to, data) => rpc('eth_call', [{ to, data }, block.number]);
    const fee = config.poolFee ?? 500;
    if (!Number.isInteger(fee) || fee < 1 || fee >= 1000000) throw new Error('BASE_POOL_FEE_RANGE');
    let pool;
    {
      const tokens = [chain.weth.slice(2), chain.usdc.slice(2)].sort();
      const data =
        '0x1698ee82' +
        tokens.map((token) => token.padStart(64, '0')).join('') +
        BigInt(fee).toString(16).padStart(64, '0');
      pool = contractAddress(await call(chain.factory, data));
    }
    pool = address(pool);
    if (/^0x0{40}$/.test(pool)) throw new Error('BASE_POOL_NOT_FOUND');
    if (config.pool && address(config.pool) !== pool) throw new Error('BASE_POOL_NOT_CANONICAL');
    const [zero, one, slot, liquidity] = await Promise.all([
      call(pool, '0x0dfe1681'),
      call(pool, '0xd21220a7'),
      call(pool, '0x3850c7bd'),
      call(pool, '0x1a686502'),
    ]);
    const token0 = contractAddress(zero),
      token1 = contractAddress(one);
    // This first adapter is intentionally WETH/native USDC, not arbitrary unverified token ABIs.
    if (![token0, token1].includes(chain.weth) || ![token0, token1].includes(chain.usdc))
      throw new Error('BASE_POOL_REQUIRES_WETH_USDC');
    const [d0, d1] = await Promise.all([call(token0, '0x313ce567'), call(token1, '0x313ce567')]);
    const decimals0 = word(d0),
      decimals1 = word(d1),
      sqrt = word(slot);
    if (
      decimals0 > 30n ||
      decimals1 > 30n ||
      sqrt <= 0n ||
      sqrt >= 2n ** 160n ||
      word(liquidity) <= 0n
    )
      throw new Error('BASE_POOL_NO_LIQUIDITY');
    if (
      (token0 === chain.weth ? decimals0 : decimals1) !== 18n ||
      (token0 === chain.usdc ? decimals0 : decimals1) !== 6n
    )
      throw new Error('BASE_TOKEN_DECIMALS_MISMATCH');
    const ratio = sqrt * sqrt,
      q192 = 2n ** 192n;
    const price =
      token0 === chain.weth
        ? (ratio * 10n ** decimals0 * SCALE) / (q192 * 10n ** decimals1)
        : (q192 * 10n ** decimals1 * SCALE) / (ratio * 10n ** decimals0);
    if (price <= 0n) throw new Error('BASE_PRICE_PRECISION');
    const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
    if (canonical?.hash !== block.hash) throw new Error('BASE_BLOCK_REORGED');
    return {
      source: 'base-uniswap-v3-sampled',
      chainId: chain.id,
      product: 'WETH-USDC',
      pool,
      block: String(height),
      blockHash: block.hash,
      time: Number(timestamp),
      price: decimal(price),
      observedAt: Date.now(),
      book: null,
      candles: [],
      quality: 'sampled-pool-price-no-traded-volume',
      finality: 'included',
    };
  }
  async coinbase(config, history = true) {
    const product = config.product;
    if (!['BTC-USD', 'ETH-USD', 'SOL-USD'].includes(product))
      throw new Error('PRODUCT_UNAVAILABLE');
    if (!INTERVALS.includes(config.interval)) throw new Error('INTERVAL_UNAVAILABLE');
    const root = `https://api.exchange.coinbase.com/products/${product}`;
    const results = await Promise.all([
      json(this.fetch, root + '/ticker'),
      json(this.fetch, root + '/book?level=2'),
      history
        ? json(this.fetch, root + '/candles?granularity=' + config.interval)
        : Promise.resolve([]),
    ]);
    const ticker = results[0],
      time = Date.parse(ticker.time) / 1000;
    if (
      !Number.isFinite(time) ||
      !Number.isFinite(Number(ticker.price)) ||
      Number(ticker.price) <= 0
    )
      throw new Error('INVALID_TICKER');
    const levels = (input) => {
      if (!Array.isArray(input)) throw new Error('INVALID_ORDERBOOK');
      return input.slice(0, 20).map((row) => {
        if (!(Number(row[0]) > 0) || !(Number(row[1]) > 0)) throw new Error('INVALID_ORDERBOOK');
        return { price: String(row[0]), quantity: String(row[1]) };
      });
    };
    const candles = history
      ? validateCandles(
          results[2]
            .map((row) => ({
              time: row[0],
              low: row[1],
              high: row[2],
              open: row[3],
              close: row[4],
              volume: row[5],
            }))
            .sort((a, b) => a.time - b.time),
        )
      : [];
    return {
      source: 'coinbase-public-rest',
      product,
      time,
      price: Number(ticker.price).toFixed(8),
      observedAt: Date.now(),
      candles,
      book: {
        bids: levels(results[1].bids),
        asks: levels(results[1].asks),
        sequence: String(results[1].sequence),
        kind: 'rest-snapshot-not-streaming',
      },
      quality: 'exchange-candles',
    };
  }
  async quote(config, history) {
    return CHAINS[config.venue] ? this.base(config) : this.coinbase(config, history);
  }
}
function formatUnits(value, places) {
  const unit = 10n ** BigInt(places),
    tail = String(value % unit)
      .padStart(places, '0')
      .replace(/0+$/, '');
  return String(value / unit) + (tail ? '.' + tail : '');
}
module.exports = { MarketData, CHAINS, INTERVALS, address, endpoint, formatUnits };
