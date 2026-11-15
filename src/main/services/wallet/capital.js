/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Transaction, keccak256, getAddress } = require('ethers');
const { formatUnits } = require('../quant/market-data');
const { createHash } = require('node:crypto');
const fail = () => {
  throw Error('WALLET_CAPITAL_UNAVAILABLE');
};
const quantity = (text) => {
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d{0,77})$/.test(text)) fail();
  const value = BigInt(text);
  if (value >= 1n << 256n) fail();
  return value;
};
const unsignedHash = (transaction) => keccak256(Transaction.from(transaction).unsignedSerialized);

function validateAnalysis(analysis, transaction) {
  if (
    !analysis ||
    typeof analysis.classified !== 'boolean' ||
    !Array.isArray(analysis.effects) ||
    analysis.effects.length > 16 ||
    typeof analysis.adapter !== 'string' ||
    analysis.adapter.length > 80 ||
    (!analysis.classified && analysis.effects.length)
  )
    fail();
  for (const effect of analysis.effects) {
    if (
      effect.chainId !== transaction.chainId ||
      !['approval', 'transfer', 'swap-input'].includes(effect.kind) ||
      getAddress(effect.token) === '0x0000000000000000000000000000000000000000'
    )
      fail();
    quantity(effect.amountAtoms);
  }
  return analysis;
}
async function captureCapital(signer, id, transaction) {
  const analysis =
    transaction.data === '0x'
      ? { classified: false, adapter: 'empty-calldata', effects: [] }
      : await signer('transaction.inspect', { id, transaction });
  validateAnalysis(analysis, transaction);
  return {
    version: 1,
    unsignedHash: unsignedHash(transaction),
    classified: analysis.classified,
    adapter: analysis.adapter,
    effects: structuredClone(analysis.effects),
  };
}
function analysisFor(intent) {
  if (!intent.capital) return { classified: false, adapter: 'legacy', effects: [] };
  if (
    intent.capital.version !== 1 ||
    intent.capital.unsignedHash !== unsignedHash(intent.transaction)
  )
    fail();
  return validateAnalysis(intent.capital, intent.transaction);
}
function requiresRecovery(intent) {
  return (
    intent.status === 'signing-unknown' ||
    (!!intent.nativeSigning &&
      !intent.hash &&
      intent.nativeSignatureAbsent !== true &&
      ['failed', 'cancelled', 'expired'].includes(intent.status))
  );
}
function outstanding(intent, now) {
  if (intent.nativeSignatureAbsent === true) return false;
  if (
    intent.hash ||
    intent.nativeSigning ||
    ['signing', 'signing-unknown', 'submit-unknown', 'submitted', 'reorged'].includes(intent.status)
  )
    return true;
  return ['approval-required', 'approved'].includes(intent.status) && intent.expiresAt > now;
}
function relevant(intents, members, chainId) {
  const ids = new Set(members.map((m) => m.walletId));
  return intents.filter((i) => ids.has(i.walletId) && i.chainId === chainId);
}
function fingerprint(intents, members, chainId) {
  const records = relevant(intents, members, chainId).map((i) => ({
    id: i.id,
    walletId: i.walletId,
    chainId: i.chainId,
    address: i.address,
    status: i.status,
    transaction: i.transaction,
    feeReserveWei: i.feeReserveWei,
    expiresAt: i.expiresAt,
    capital: i.capital,
    hash: i.hash,
    nativeSigning: i.nativeSigning,
    nativeSignatureAbsent: i.nativeSignatureAbsent,
  }));
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}
function memberCapital(member, intents, chainId, now, plainRecipients) {
  const mined = member.minedNonce == null ? null : quantity(member.minedNonce);
  const groups = new Map();
  let pendingCount = 0,
    unknownCount = 0,
    approvalCount = 0;
  for (const intent of intents) {
    if (
      intent.walletId !== member.walletId ||
      intent.chainId !== chainId ||
      !outstanding(intent, now)
    )
      continue;
    const tx = intent.transaction;
    if (
      !tx ||
      !Number.isSafeInteger(tx.nonce) ||
      tx.nonce < 0 ||
      tx.chainId !== chainId ||
      intent.address?.toLowerCase() !== member.address.toLowerCase()
    )
      fail();
    if (mined !== null && BigInt(tx.nonce) < mined) continue;
    pendingCount++;
    const analysis = analysisFor(intent);
    if (!analysis.classified && !(tx.data === '0x' && plainRecipients?.has(tx.to.toLowerCase())))
      unknownCount++;
    const one = new Map([['native', quantity(tx.value) + quantity(intent.feeReserveWei)]]);
    for (const effect of analysis.effects) {
      if (effect.kind === 'approval') {
        approvalCount++;
        continue;
      }
      const key = effect.token.toLowerCase();
      one.set(key, (one.get(key) ?? 0n) + quantity(effect.amountAtoms));
    }
    // Same-nonce replacements are alternatives. Reserve the largest input for
    // each asset instead of charging all alternatives as separate transactions.
    const group = groups.get(tx.nonce) ?? new Map();
    for (const [key, value] of one) if (value > (group.get(key) ?? 0n)) group.set(key, value);
    groups.set(tx.nonce, group);
  }
  const reserved = new Map();
  for (const group of groups.values())
    for (const [key, value] of group) reserved.set(key, (reserved.get(key) ?? 0n) + value);
  return {
    ...member,
    capital: {
      pendingCount,
      unknownCount,
      approvalCount,
      nonceGroups: groups.size,
      nonceAvailable: mined !== null,
    },
    assets: member.assets.map((asset) => {
      const amount =
        reserved.get(asset.kind === 'native' ? 'native' : asset.address.toLowerCase()) ?? 0n;
      const complete =
        mined !== null &&
        asset.amountAtomic !== null &&
        (asset.kind === 'native' || unknownCount === 0);
      const balance = asset.amountAtomic === null ? 0n : quantity(asset.amountAtomic);
      const available = balance > amount ? balance - amount : 0n;
      const shortfall = amount > balance ? amount - balance : 0n;
      const text = (value) => (asset.decimals === null ? null : formatUnits(value, asset.decimals));
      return {
        ...asset,
        capital: {
          complete,
          reservedAtomic: String(amount),
          reserved: text(amount),
          availableAtomic: complete ? String(available) : null,
          available: complete ? text(available) : null,
          shortfallAtomic: complete ? String(shortfall) : null,
        },
      };
    }),
  };
}
function portfolioCapital(snapshot, intents, now = Date.now(), plainRecipients) {
  const members = snapshot.members.map((member) =>
    memberCapital(member, intents, snapshot.chainId, now, plainRecipients),
  );
  const assets = snapshot.assets.map((asset, index) => {
    const rows = members.map((m) => m.assets[index].capital);
    const complete = rows.every((r) => r.complete);
    const sum = (key) => rows.reduce((total, r) => total + BigInt(r[key] ?? '0'), 0n);
    const amount = sum('reservedAtomic'),
      available = sum('availableAtomic'),
      shortfall = sum('shortfallAtomic');
    return {
      ...asset,
      capital: {
        complete,
        reservedAtomic: String(amount),
        reserved: asset.decimals === null ? null : formatUnits(amount, asset.decimals),
        availableAtomic: complete ? String(available) : null,
        available:
          complete && asset.decimals !== null ? formatUnits(available, asset.decimals) : null,
        shortfallAtomic: complete ? String(shortfall) : null,
      },
    };
  });
  return {
    ...snapshot,
    assets,
    members,
    capital: {
      scope: 'local-wallet-intents',
      pendingCount: members.reduce((n, m) => n + m.capital.pendingCount, 0),
      unknownCount: members.reduce((n, m) => n + m.capital.unknownCount, 0),
      approvalCount: members.reduce((n, m) => n + m.capital.approvalCount, 0),
      feeEstimateIsNotGuaranteed: true,
    },
  };
}
function pendingEquityRecipients(snapshot, intents, tracked, now) {
  const recipients = new Set();
  for (const member of snapshot.members) {
    if (member.minedNonce == null) throw Error('WALLET_PORTFOLIO_EQUITY_UNAVAILABLE');
    const mined = quantity(member.minedNonce);
    for (const intent of intents) {
      if (
        intent.walletId !== member.walletId ||
        intent.chainId !== snapshot.chainId ||
        !outstanding(intent, now)
      )
        continue;
      const tx = intent.transaction;
      if (!tx || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0) fail();
      if (BigInt(tx.nonce) < mined) continue;
      const analysis = analysisFor(intent);
      if (!analysis.classified) {
        if (tx.data !== '0x' || !/^0x[\da-f]{40}$/i.test(tx.to))
          throw Error('WALLET_PORTFOLIO_EQUITY_UNKNOWN');
        recipients.add(tx.to.toLowerCase());
      } else if (analysis.effects.some((effect) => !tracked.has(effect.token.toLowerCase()))) {
        throw Error('WALLET_PORTFOLIO_EQUITY_UNKNOWN');
      }
    }
  }
  if (recipients.size > 16) throw Error('WALLET_PORTFOLIO_EQUITY_UNKNOWN');
  return recipients;
}
async function checkCapital(market, config, intent, intents, signal) {
  const effects = analysisFor(intent).effects.filter(
    (effect) => effect.kind !== 'approval' && quantity(effect.amountAtoms) > 0n,
  );
  if (!effects.length) return;
  const tokens = [...new Set(effects.map((e) => e.token.toLowerCase()))];
  const boundedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  let snapshot;
  try {
    snapshot = await market.tokenHoldings(
      config,
      { address: intent.address, tokens },
      { signal: boundedSignal, includeNonce: true },
    );
  } catch (error) {
    if (boundedSignal.aborted && !signal?.aborted) throw Error('WALLET_ASSET_TIMEOUT');
    throw error;
  }
  if (Date.now() - snapshot.blockTimestamp * 1000 > 120000) throw Error('WALLET_CAPITAL_STALE');
  if (
    snapshot.minedNonce !== null &&
    BigInt(intent.transaction.nonce) < BigInt(snapshot.minedNonce)
  )
    throw Error('WALLET_NONCE_CHANGED');
  const member = memberCapital(
    { ...snapshot, walletId: intent.walletId },
    [...intents.filter((i) => i.id !== intent.id), intent],
    intent.chainId,
    Date.now(),
  );
  const amounts = new Map([
    ['native', quantity(intent.transaction.value) + quantity(intent.feeReserveWei)],
  ]);
  for (const effect of effects)
    amounts.set(
      effect.token.toLowerCase(),
      (amounts.get(effect.token.toLowerCase()) ?? 0n) + quantity(effect.amountAtoms),
    );
  for (const [key, amount] of amounts) {
    const asset = member.assets.find((a) =>
      key === 'native' ? a.kind === 'native' : a.address?.toLowerCase() === key,
    );
    if (!asset?.capital.complete)
      throw Error(
        member.capital.unknownCount ? 'WALLET_CAPITAL_UNKNOWN_CALL' : 'WALLET_CAPITAL_UNAVAILABLE',
      );
    if (amount > 0n && BigInt(asset.capital.shortfallAtomic) > 0n)
      throw Error(
        key === 'native' ? 'WALLET_INSUFFICIENT_BALANCE' : 'WALLET_TOKEN_CAPITAL_RESERVED',
      );
  }
  return true;
}
module.exports = {
  captureCapital,
  checkCapital,
  portfolioCapital,
  fingerprint,
  requiresRecovery,
  pendingEquityRecipients,
};
