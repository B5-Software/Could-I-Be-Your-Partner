/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { decimal, SCALE } = require('./decimal');
const { validateCandles } = require('./backtest');
const { valuePortfolio, prices } = require('./portfolio-valuation');
const { Interface, getAddress, ZeroAddress, MaxUint256, zeroPadValue } = require('ethers');
const {
  PERMIT2,
  MAX_ORDERED_NONCE,
  permit2,
  permit2Topics,
  usesPermit2,
  unorderedNonce,
} = require('./permit2');
const erc20Allowance = new Interface([
  'function allowance(address,address) view returns(uint256)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
]);
const erc20Balance = new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function decimals() view returns(uint8)',
]);
const approvalTopic = erc20Allowance.getEvent('Approval').topicHash;
const hashPattern = /^0x[\da-f]{64}$/i;
const baseGasOracle = '0x420000000000000000000000000000000000000f';
const operatorOracle = new Interface(['function getOperatorFee(uint256) view returns (uint256)']);
const maxOperatorGas = (1n << 64n) - 1n;
const maxOperatorFee = maxOperatorGas * (((1n << 32n) - 1n) * 100n + 1n);

async function readOperatorFee(rpc, gas, block) {
  if (typeof gas !== 'bigint' || gas <= 0n || gas > maxOperatorGas)
    throw Error('WALLET_GAS_ESTIMATE_RANGE');
  const data = operatorOracle.encodeFunctionData('getOperatorFee', [gas]);
  const result = await rpc('eth_call', [{ to: baseGasOracle, data }, block]);
  if (typeof result !== 'string' || !/^0x[\da-f]{64}$/i.test(result))
    throw Error('WALLET_OPERATOR_FEE_UNAVAILABLE');
  const fee = BigInt(result);
  if (fee > maxOperatorFee) throw Error('WALLET_OPERATOR_FEE_UNAVAILABLE');
  return fee;
}

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

function boundedRpc(rpc) {
  const queue = [];
  let active = 0;
  return (method, params) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve()
          .then(() => rpc(method, params))
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      };
      if (active < 4) run();
      else queue.push(run);
    });
}

class MarketData {
  constructor(fetcher = (...args) => global.fetch(...args), resolveChain = (key) => CHAINS[key]) {
    this.fetch = fetcher;
    this.resolveChain = resolveChain;
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
    const profile = this.resolveChain(chain);
    if (!profile) throw new Error('CHAIN_UNAVAILABLE');
    const reply = await json(this.fetch, endpoint(rpcUrl || profile.rpc), {
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
    const chain = this.resolveChain(config.venue);
    if (!chain) throw new Error('CHAIN_UNAVAILABLE');
    const rpc = (method, params) =>
      this.rpc(config.venue, config.rpcUrl || chain.rpc, method, params, options);
    if (uint(await rpc('eth_chainId')) !== BigInt(chain.id)) throw new Error('CHAIN_ID_MISMATCH');
    if (chain.genesisHash) {
      const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
      if (
        typeof genesis?.hash !== 'string' ||
        genesis.hash.toLowerCase() !== chain.genesisHash.toLowerCase()
      )
        throw Error('WALLET_NETWORK_GENESIS');
    }
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    if (!block || !hashPattern.test(block.hash || '')) throw new Error('INVALID_BLOCK');
    const height = uint(block.number),
      timestamp = uint(block.timestamp);
    if (timestamp > BigInt(Math.floor(Date.now() / 1000) + 120))
      throw new Error('BLOCK_CLOCK_SKEW');
    return { chain, rpc, block, height, timestamp };
  }
  async tokenAllowance(config, input, options = {}) {
    const layered = usesPermit2(input.protocol);
    const [owner, token, spender] = [input.address, input.token, input.spender].map(getAddress);
    if ([owner, token, spender].includes(ZeroAddress)) throw new Error('INVALID_ADDRESS');
    const { chain, rpc, block, height, timestamp } =
      options.connection || (await this.connect(config, options));
    const call = (to, data) =>
      rpc('eth_call', [
        { to, data },
        { blockHash: block.hash, requireCanonical: true },
      ]);
    const [outer, inner] = await Promise.all([
      call(
        token,
        erc20Allowance.encodeFunctionData('allowance', [owner, layered ? PERMIT2 : spender]),
      ),
      layered && call(PERMIT2, permit2.encodeFunctionData('allowance', [owner, token, spender])),
    ]);
    if (typeof outer !== 'string' || !hashPattern.test(outer))
      throw new Error('INVALID_CONTRACT_RESPONSE');
    const tokenAllowance = BigInt(outer);
    const max = layered ? (1n << 160n) - 1n : MaxUint256;
    let amount = tokenAllowance;
    let permit2Details;
    if (layered) {
      if (typeof inner !== 'string' || inner.length !== 194)
        throw new Error('INVALID_CONTRACT_RESPONSE');
      amount = word(inner);
      const expiration = word(inner, 1),
        nonce = word(inner, 2);
      if (amount > max || expiration >> 48n || nonce >> 48n)
        throw new Error('INVALID_CONTRACT_RESPONSE');
      const expired = timestamp > expiration;
      permit2Details = {
        contract: PERMIT2,
        expiration: Number(expiration),
        nonce: String(nonce),
        nextNonce: nonce < MAX_ORDERED_NONCE ? String(nonce + 1n) : null,
        expired,
        tokenAllowanceAtomic: String(tokenAllowance),
        effectiveAmountAtomic: String(
          expired ? 0n : amount < tokenAllowance ? amount : tokenAllowance,
        ),
      };
    }
    if (!options.connection) {
      const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
      if (canonical?.hash !== block.hash) throw new Error('BLOCK_REORG');
    }
    const symbol =
      token.toLowerCase() === chain.usdc
        ? 'USDC'
        : token.toLowerCase() === chain.weth
          ? 'WETH'
          : null;
    const display = (value) =>
      symbol ? formatUnits(BigInt(value), symbol === 'USDC' ? 6 : 18) : null;
    return {
      chainId: chain.id,
      network: chain.name,
      address: owner,
      token,
      spender,
      amountAtomic: String(amount),
      amount: display(amount),
      symbol,
      unlimited: amount === max,
      ...(permit2Details
        ? {
            permit2: {
              ...permit2Details,
              tokenAllowance: display(permit2Details.tokenAllowanceAtomic),
              effectiveAmount: display(permit2Details.effectiveAmountAtomic),
            },
          }
        : {}),
      block: String(height),
      blockHash: block.hash,
      blockTimestamp: Number(timestamp),
      observedAt: Date.now(),
    };
  }
  async tokenHoldings(config, input, options = {}) {
    const owner = getAddress(input.address);
    if (owner === ZeroAddress) throw new Error('INVALID_ADDRESS');
    const tokenLimit = options.connection ? 32 : 16;
    if (
      input.tokens !== undefined &&
      (!Array.isArray(input.tokens) || input.tokens.length > tokenLimit)
    )
      throw new Error('WALLET_ASSET_RANGE');
    const extra = (input.tokens ?? []).map(getAddress);
    if (extra.includes(ZeroAddress)) throw new Error('INVALID_ADDRESS');
    const connection = options.connection || (await this.connect(config, options));
    const { chain, block, height, timestamp } = connection;
    const rpc = options.connection ? connection.rpc : boundedRpc(connection.rpc);
    const tag = { blockHash: block.hash, requireCanonical: true };
    const tokens = [
      ...new Set(
        [chain.usdc, chain.weth, ...extra].filter(Boolean).map((token) => token.toLowerCase()),
      ),
    ];
    const [balance, assets, minedNonce] = await Promise.all([
      rpc('eth_getBalance', [owner, tag])
        .then(uint)
        .catch((error) => {
          if (!options.partialNative) throw error;
          return null;
        }),
      Promise.all(
        tokens.map(async (token) => {
          const preset =
            token === chain.usdc
              ? { symbol: 'USDC', decimals: 6 }
              : token === chain.weth
                ? { symbol: 'WETH', decimals: 18 }
                : null;
          const asset = {
            kind: 'erc20',
            address: getAddress(token),
            symbol: preset?.symbol ?? null,
            decimals: preset?.decimals ?? null,
          };
          const call = (method) =>
            rpc('eth_call', [
              {
                to: token,
                data: erc20Balance.encodeFunctionData(
                  method,
                  method === 'balanceOf' ? [owner] : [],
                ),
              },
              tag,
            ]);
          try {
            const result = await call('balanceOf');
            if (typeof result !== 'string' || !hashPattern.test(result))
              throw new Error('INVALID_CONTRACT_RESPONSE');
            if (!preset) {
              try {
                const result = await call('decimals');
                if (
                  typeof result !== 'string' ||
                  !hashPattern.test(result) ||
                  BigInt(result) > 255n
                )
                  throw new Error('INVALID_CONTRACT_RESPONSE');
                asset.decimals = Number(BigInt(result));
              } catch {
                asset.metadataError = 'WALLET_ASSET_DECIMALS_UNAVAILABLE';
              }
            }
            return {
              ...asset,
              amountAtomic: String(BigInt(result)),
              amount: asset.decimals === null ? null : formatUnits(BigInt(result), asset.decimals),
            };
          } catch {
            return {
              ...asset,
              amountAtomic: null,
              amount: null,
              error: 'WALLET_ASSET_UNAVAILABLE',
            };
          }
        }),
      ),
      options.includeNonce
        ? rpc('eth_getTransactionCount', [owner, tag])
            .then(uint)
            .then(String)
            .catch(() => null)
        : undefined,
    ]);
    const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
    if (canonical?.hash !== block.hash) throw new Error('BLOCK_REORG');
    return {
      chainId: chain.id,
      network: chain.name,
      address: owner,
      block: String(height),
      blockHash: block.hash,
      blockTimestamp: Number(timestamp),
      observedAt: Date.now(),
      ...(options.includeNonce ? { minedNonce } : {}),
      assets: [
        {
          kind: 'native',
          symbol: chain.nativeSymbol || 'ETH',
          decimals: 18,
          amountAtomic: balance === null ? null : String(balance),
          amount: balance === null ? null : formatUnits(balance, 18),
          ...(balance === null ? { error: 'WALLET_ASSET_UNAVAILABLE' } : {}),
        },
        ...assets,
      ],
    };
  }
  async portfolioHoldings(config, input, options = {}) {
    options.signal?.throwIfAborted();
    options = {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)])
        : AbortSignal.timeout(45000),
    };
    if (!Array.isArray(input.members) || !input.members.length || input.members.length > 16)
      throw new Error('WALLET_PORTFOLIO_INVALID');
    const members = input.members.map((member) => ({
      ...member,
      address: getAddress(member.address),
    }));
    if (
      new Set(members.map((m) => m.address)).size !== members.length ||
      new Set(members.map((m) => m.walletId)).size !== members.length ||
      members.some((m) => typeof m.walletId !== 'string' || !m.walletId) ||
      members.some((m) => m.address === ZeroAddress)
    )
      throw new Error('WALLET_PORTFOLIO_INVALID');
    const context = options.connection || (await this.connect(config, options));
    const limited = boundedRpc(context.rpc),
      cache = new Map();
    const connection = {
      ...context,
      rpc: (method, params) => {
        if (method !== 'eth_call') return limited(method, params);
        const key = JSON.stringify(params);
        if (!cache.has(key)) cache.set(key, limited(method, params));
        return cache.get(key);
      },
    };
    const snapshots = await Promise.all(
      members.map(async (member) => ({
        ...member,
        ...(await this.tokenHoldings(
          config,
          { address: member.address, tokens: input.tokens },
          { ...options, connection, partialNative: true, includeNonce: true },
        )),
      })),
    );
    const assets = snapshots[0].assets.map((first, index) => {
      const entries = snapshots.map((member) => ({
        walletId: member.walletId,
        asset: member.assets[index],
      }));
      const missingWalletIds = entries
        .filter(({ asset }) => asset.amountAtomic === null)
        .map(({ walletId }) => walletId);
      const known = entries.reduce((sum, { asset }) => sum + BigInt(asset.amountAtomic ?? '0'), 0n);
      const complete = missingWalletIds.length === 0;
      const metadata = entries.find(({ asset }) => asset.decimals !== null)?.asset ?? first;
      return {
        kind: first.kind,
        ...(first.address ? { address: first.address } : {}),
        symbol: first.symbol,
        decimals: metadata.decimals,
        complete,
        missingWalletIds,
        knownAmountAtomic: String(known),
        knownAmount: metadata.decimals === null ? null : formatUnits(known, metadata.decimals),
        amountAtomic: complete ? String(known) : null,
        amount:
          complete && metadata.decimals !== null ? formatUnits(known, metadata.decimals) : null,
      };
    });
    const priced =
      input.valuation === true
        ? await valuePortfolio({ ...context, rpc: connection.rpc }, assets, snapshots)
        : {};
    const canonical = await connection.rpc('eth_getBlockByNumber', [context.block.number, false]);
    if (canonical?.hash !== context.block.hash) throw new Error('BLOCK_REORG');
    return {
      chainId: context.chain.id,
      network: context.chain.name,
      block: String(context.height),
      blockHash: context.block.hash,
      blockTimestamp: Number(context.timestamp),
      observedAt: Date.now(),
      complete: assets.every((asset) => asset.complete),
      assets,
      members: snapshots,
      ...priced,
    };
  }
  async permit2SignatureNonce(config, input, options = {}) {
    const owner = getAddress(input.address);
    if (owner === ZeroAddress) throw new Error('INVALID_ADDRESS');
    const { nonce, wordPos, mask } = unorderedNonce(input.nonce);
    const { chain, rpc, block, height } = await this.connect(config, options);
    const result = await rpc('eth_call', [
      { to: PERMIT2, data: permit2.encodeFunctionData('nonceBitmap', [owner, wordPos]) },
      { blockHash: block.hash, requireCanonical: true },
    ]);
    if (typeof result !== 'string' || !hashPattern.test(result))
      throw new Error('INVALID_CONTRACT_RESPONSE');
    const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
    if (canonical?.hash !== block.hash) throw new Error('BLOCK_REORG');
    return {
      network: chain.name,
      address: owner,
      contract: PERMIT2,
      nonce: String(nonce),
      unavailable: Boolean(BigInt(result) & mask),
      block: String(height),
      blockHash: block.hash,
    };
  }
  async discoverTokenApprovals(config, input, options = {}) {
    const layered = usesPermit2(input.protocol);
    const owner = getAddress(input.address);
    const token = input.token === undefined ? null : getAddress(input.token);
    const allowed = options.tokens ? new Set(options.tokens.map(getAddress)) : null;
    const blocks = input.blocks ?? 1000;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;
    if (
      owner === ZeroAddress ||
      token === ZeroAddress ||
      !Number.isInteger(blocks) ||
      blocks < 1 ||
      blocks > 2000 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 2048 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (input.endBlock !== undefined &&
        (typeof input.endBlock !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(input.endBlock))) ||
      (input.anchorHash !== undefined &&
        (typeof input.anchorHash !== 'string' || !hashPattern.test(input.anchorHash))) ||
      (offset > 0 && (input.endBlock === undefined || input.anchorHash === undefined))
    )
      throw new Error('WALLET_APPROVAL_SCAN_RANGE');
    const { chain, rpc, block, height } =
      options.connection || (await this.connect(config, options));
    const end = input.endBlock === undefined ? height : BigInt(input.endBlock);
    if (end > height) throw new Error('WALLET_APPROVAL_SCAN_RANGE');
    const start = end < BigInt(blocks) ? 0n : end - BigInt(blocks) + 1n;
    const fromBlock = '0x' + start.toString(16);
    const toBlock = '0x' + end.toString(16);
    const anchor = end === height ? block : await rpc('eth_getBlockByNumber', [toBlock, false]);
    if (!anchor || !hashPattern.test(anchor.hash || '') || uint(anchor.number) !== end)
      throw new Error('INVALID_BLOCK');
    if (input.anchorHash && input.anchorHash !== anchor.hash) throw new Error('BLOCK_REORG');
    const ownerTopic = zeroPadValue(owner, 32).toLowerCase();
    const logs = await rpc('eth_getLogs', [
      {
        fromBlock,
        toBlock,
        topics: [layered ? permit2Topics : approvalTopic, ownerTopic],
        ...(layered
          ? { address: PERMIT2 }
          : token
            ? { address: token }
            : allowed
              ? { address: [...allowed] }
              : {}),
      },
    ]);
    if (!Array.isArray(logs)) throw new Error('INVALID_RPC_RESPONSE');
    if (logs.length > 2048) throw new Error('WALLET_APPROVAL_SCAN_DENSE');
    const records = [];
    const positions = new Set();
    for (const log of logs) {
      if (log?.removed === true) throw new Error('BLOCK_REORG');
      const topics = log?.topics;
      if (
        !Array.isArray(topics) ||
        typeof topics[0] !== 'string' ||
        !(layered ? permit2Topics : [approvalTopic]).includes(topics[0].toLowerCase()) ||
        typeof topics[1] !== 'string' ||
        topics[1].toLowerCase() !== ownerTopic
      )
        throw new Error('INVALID_RPC_RESPONSE');
      // ERC-721 Approval uses the same signature with a third indexed argument.
      if (!layered && topics.length === 4 && log.data === '0x') continue;
      if (!hashPattern.test(log.blockHash || '') || !hashPattern.test(log.transactionHash || ''))
        throw new Error('INVALID_RPC_RESPONSE');
      let contract = getAddress(log.address);
      let spender, amount, event;
      if (layered) {
        if (contract !== PERMIT2) throw new Error('INVALID_RPC_RESPONSE');
        try {
          const parsed = permit2.parseLog(log);
          const encoded = permit2.encodeEventLog(parsed.fragment, parsed.args);
          if (
            encoded.data !== log.data.toLowerCase() ||
            encoded.topics.length !== topics.length ||
            encoded.topics.some((topic, i) => topic !== topics[i].toLowerCase())
          )
            throw new Error('INVALID_RPC_RESPONSE');
          contract = parsed.args.token;
          spender = parsed.args.spender;
          amount = parsed.args.amount ?? 0n;
          event = parsed.name;
        } catch {
          throw new Error('INVALID_RPC_RESPONSE');
        }
      } else {
        if (
          topics.length !== 3 ||
          !/^0x0{24}[\da-f]{40}$/i.test(topics[2] || '') ||
          !hashPattern.test(log.data || '') ||
          (token && token !== contract) ||
          (allowed && !allowed.has(contract))
        )
          throw new Error('INVALID_RPC_RESPONSE');
        spender = getAddress('0x' + topics[2].slice(-40).toLowerCase());
        amount = BigInt(log.data);
      }
      const at = uint(log.blockNumber);
      const index = uint(log.logIndex);
      const position = `${at}:${index}`;
      if (at < start || at > end || positions.has(position))
        throw new Error('INVALID_RPC_RESPONSE');
      if (at === end && log.blockHash !== anchor.hash) throw new Error('BLOCK_REORG');
      positions.add(position);
      if (
        contract !== ZeroAddress &&
        spender !== ZeroAddress &&
        (!token || token === contract) &&
        (!allowed || allowed.has(contract))
      )
        records.push({ token: contract, spender, at, index, log, amount, event });
    }
    const canonical = await rpc('eth_getBlockByNumber', [toBlock, false]);
    if (canonical?.hash !== anchor.hash) throw new Error('BLOCK_REORG');
    records.sort((a, b) => (a.at === b.at ? (a.index > b.index ? -1 : 1) : a.at > b.at ? -1 : 1));
    const pairs = new Map();
    for (const record of records) {
      const key = record.token + record.spender;
      if (!pairs.has(key)) pairs.set(key, record);
    }
    return {
      network: chain.name,
      address: owner,
      fromBlock: String(start),
      toBlock: String(end),
      anchorHash: anchor.hash,
      nextEndBlock: start > 0n ? String(start - 1n) : null,
      nextOffset: offset + limit < pairs.size ? offset + limit : null,
      total: pairs.size,
      items: [...pairs.values()].slice(offset, offset + limit).map((entry) => ({
        token: entry.token,
        spender: entry.spender,
        block: String(entry.at),
        transactionHash: entry.log.transactionHash,
        eventAmountAtomic: String(entry.amount),
        ...(entry.event ? { event: entry.event } : {}),
      })),
    };
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
        if (options.observeReceipt) {
          if (typeof receipt.blockHash === 'string' && hashPattern.test(receipt.blockHash))
            result.transaction.observedBlockHash = receipt.blockHash.toLowerCase();
          if (confirmation === 'finalized')
            result.transaction.evidence = options.observeReceipt(receipt, chain);
        }
      }
    }
    return result;
  }
  async baseOperatorFee(config, chainId, blockHash, gasUsed, signal) {
    if (CHAINS[config.venue]?.id !== chainId || !hashPattern.test(blockHash))
      throw Error('WALLET_OPERATOR_FEE_UNAVAILABLE');
    const rpc = (method, params) =>
      this.rpc(config.venue, config.rpcUrl, method, params, { signal });
    if (uint(await rpc('eth_chainId', [])) !== BigInt(chainId)) throw Error('CHAIN_ID_MISMATCH');
    return readOperatorFee(rpc, gasUsed, { blockHash, requireCanonical: true });
  }
  async baseFeeQuote(config, height, blockHash, signal) {
    const chain = CHAINS[config.venue];
    if (chain?.id !== 8453 || !hashPattern.test(blockHash) || !/^\d{1,20}$/.test(height))
      throw Error('WALLET_PRICE_NETWORK');
    const rpc = boundedRpc((method, params) =>
      this.rpc(config.venue, config.rpcUrl, method, params, { signal }),
    );
    if (uint(await rpc('eth_chainId', [])) !== 8453n) throw Error('CHAIN_ID_MISMATCH');
    const number = '0x' + BigInt(height).toString(16);
    const [block, finalized] = await Promise.all([
      rpc('eth_getBlockByNumber', [number, false]),
      rpc('eth_getBlockByNumber', ['finalized', false]),
    ]);
    if (block?.hash !== blockHash || uint(block.number) !== BigInt(height))
      throw Error('BLOCK_REORG');
    if (!finalized || !hashPattern.test(finalized.hash) || uint(finalized.number) < BigInt(height))
      throw Error('WALLET_PRICE_BLOCK_UNFINALIZED');
    if (uint(finalized.number) === BigInt(height) && finalized.hash !== blockHash)
      throw Error('BLOCK_REORG');
    const timestamp = uint(block.timestamp);
    if (!timestamp || timestamp > BigInt(Math.floor(Date.now() / 1000)))
      throw Error('WALLET_PRICE_INVALID');
    const source = await prices({ chain, rpc, block, timestamp }, { historical: true });
    const canonical = await rpc('eth_getBlockByNumber', [number, false]);
    if (canonical?.hash !== blockHash) throw Error('BLOCK_REORG');
    if (source.sequencer.status !== 'up') throw Error(source.sequencer.error);
    const { eth, usdc } = source.prices;
    if (eth?.status !== 'available' || usdc?.status !== 'available')
      throw Error(eth?.error || usdc?.error || 'WALLET_PRICE_UNAVAILABLE');
    return {
      version: 1,
      blockHash,
      blockNumber: height,
      timestamp: Number(timestamp),
      source: source.source,
      eth,
      usdc,
    };
  }
  async basePool(config, chain, call) {
    const fee = config.poolFee ?? 500;
    if (!Number.isInteger(fee) || fee < 1 || fee >= 1000000) throw new Error('BASE_POOL_FEE_RANGE');
    const tokens = [chain.weth.slice(2), chain.usdc.slice(2)].sort();
    const data =
      '0x1698ee82' +
      tokens.map((token) => token.padStart(64, '0')).join('') +
      BigInt(fee).toString(16).padStart(64, '0');
    const pool = contractAddress(await call(chain.factory, data));
    if (/^0x0{40}$/.test(pool)) throw new Error('BASE_POOL_NOT_FOUND');
    if (config.pool && address(config.pool) !== pool) throw new Error('BASE_POOL_NOT_CANONICAL');
    const [zero, one] = await Promise.all([call(pool, '0x0dfe1681'), call(pool, '0xd21220a7')]);
    const token0 = contractAddress(zero),
      token1 = contractAddress(one);
    // This first adapter is intentionally WETH/native USDC, not arbitrary unverified token ABIs.
    if (![token0, token1].includes(chain.weth) || ![token0, token1].includes(chain.usdc))
      throw new Error('BASE_POOL_REQUIRES_WETH_USDC');
    return { pool, token0, token1 };
  }
  async base(config, options = {}) {
    const { chain, rpc, block, height, timestamp } = await this.connect(config, options);
    const at = options.priceEvidence
      ? { blockHash: block.hash, requireCanonical: true }
      : block.number;
    const call = (to, data) => rpc('eth_call', [{ to, data }, at]);
    const { pool, token0, token1 } = await this.basePool(config, chain, call);
    const [slot, liquidity, d0, d1] = await Promise.all([
      call(pool, '0x3850c7bd'),
      call(pool, '0x1a686502'),
      call(token0, '0x313ce567'),
      call(token1, '0x313ce567'),
    ]);
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
      ...(options.priceEvidence
        ? {
            sqrtPriceX96: String(sqrt),
            wethIsToken0: token0 === chain.weth,
          }
        : {}),
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
module.exports = {
  MarketData,
  boundedRpc,
  CHAINS,
  INTERVALS,
  address,
  endpoint,
  formatUnits,
  baseGasOracle,
  readOperatorFee,
};
