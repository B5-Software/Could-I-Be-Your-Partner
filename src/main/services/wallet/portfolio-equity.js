/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { parseUnits } = require('ethers');
const { CHAINS, formatUnits } = require('../quant/market-data');
const { portfolioCapital, pendingEquityRecipients } = require('./capital');

function equityFloor(value, chainId) {
  if (value === null || value === '') return null;
  if (chainId !== 8453 || typeof value !== 'string' || !/^\d{1,16}(?:\.\d{1,8})?$/.test(value))
    throw Error('WALLET_PORTFOLIO_EQUITY_INVALID');
  const floor = parseUnits(value, 8);
  return floor === 0n ? null : String(floor);
}

async function assessEquity(market, config, guard, intents, signal) {
  const bounded = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  try {
    const snapshot = await market.portfolioHoldings(
      config,
      { members: guard.members, tokens: [], valuation: true },
      { signal: bounded },
    );
    const now = Date.now();
    const age = now - snapshot.blockTimestamp * 1000;
    if (
      snapshot.chainId !== 8453 ||
      !snapshot.complete ||
      !Number.isFinite(age) ||
      age > 120000 ||
      age < -120000 ||
      snapshot.valuation?.sequencer.status !== 'up' ||
      !/^0x[\da-f]{64}$/i.test(snapshot.blockHash)
    )
      throw Error('WALLET_PORTFOLIO_EQUITY_UNAVAILABLE');
    const prices = snapshot.valuation.prices;
    if (['eth', 'usdc'].some((key) => prices[key]?.status !== 'available'))
      throw Error('WALLET_PORTFOLIO_EQUITY_UNAVAILABLE');
    const tokens = new Set([CHAINS.base.weth, CHAINS.base.usdc]);
    const recipients = pendingEquityRecipients(snapshot, intents, tokens, now);
    const rpc = (method, params) =>
      market.rpc(config.venue, config.rpcUrl, method, params, { signal: bounded });
    if (recipients.size) {
      const tag = { blockHash: snapshot.blockHash, requireCanonical: true };
      const codes = await Promise.all(
        [...recipients].map((address) => rpc('eth_getCode', [address, tag])),
      );
      if (codes.some((code) => code !== '0x')) throw Error('WALLET_PORTFOLIO_EQUITY_UNKNOWN');
      const block = await rpc('eth_getBlockByNumber', [
        '0x' + BigInt(snapshot.block).toString(16),
        false,
      ]);
      if (block?.hash !== snapshot.blockHash) throw Error('WALLET_PORTFOLIO_EQUITY_UNAVAILABLE');
    }
    const reserved = portfolioCapital(snapshot, intents, now, recipients);
    let available = 0n;
    for (const member of reserved.members) {
      for (const asset of member.assets) {
        const key =
          asset.kind === 'native' || asset.address?.toLowerCase() === CHAINS.base.weth
            ? 'eth'
            : asset.address?.toLowerCase() === CHAINS.base.usdc
              ? 'usdc'
              : null;
        if (!key || !asset.capital.complete || asset.capital.shortfallAtomic !== '0')
          throw Error('WALLET_PORTFOLIO_EQUITY_UNAVAILABLE');
        available +=
          (BigInt(asset.capital.availableAtomic) * BigInt(prices[key].priceAtomic)) /
          10n ** BigInt(asset.decimals);
      }
    }
    bounded.throwIfAborted();
    const checkedAt = Date.now();
    if (checkedAt - snapshot.blockTimestamp * 1000 > 120000)
      throw Error('WALLET_PORTFOLIO_EQUITY_UNAVAILABLE');
    return {
      portfolioId: guard.id,
      revision: guard.revision,
      floorUsdAtomic: guard.floorUsdAtomic,
      floorUsd: formatUnits(BigInt(guard.floorUsdAtomic), 8),
      availableUsdAtomic: String(available),
      availableUsd: formatUnits(available, 8),
      status: available >= BigInt(guard.floorUsdAtomic) ? 'satisfied' : 'below',
      block: snapshot.block,
      blockHash: snapshot.blockHash,
      checkedAt,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.message === 'WALLET_PORTFOLIO_EQUITY_UNKNOWN') throw error;
    throw Error('WALLET_PORTFOLIO_EQUITY_UNAVAILABLE', { cause: error });
  }
}

module.exports = { equityFloor, assessEquity };
