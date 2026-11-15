/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Interface, MaxUint256, ZeroAddress, getAddress } = require('ethers');
const { boundedRpc, formatUnits } = require('../quant/market-data');
const { PERMIT2 } = require('../quant/permit2');

const abi = new Interface(['function approve(address spender,uint256 amount) returns(bool)']);
const pending = new Set([
  'signing',
  'signing-unknown',
  'submit-unknown',
  'submitted',
  'included',
  'safe',
  'reorged',
]);
const max = (a, b) => (a > b ? a : b);
const capped = (amount) => (amount > MaxUint256 ? MaxUint256 : amount);
const fail = (kind) => {
  throw Error('WALLET_PORTFOLIO_ALLOWANCE_' + kind);
};

function approval(transaction) {
  if (
    !transaction?.data?.startsWith('0x095ea7b3') ||
    transaction.data.length !== 138 ||
    BigInt(transaction.value) !== 0n
  )
    return null;
  try {
    const [spender, amount] = abi.decodeFunctionData('approve', transaction.data);
    if (abi.encodeFunctionData('approve', [spender, amount]) !== transaction.data.toLowerCase())
      return null;
    return { token: getAddress(transaction.to), spender, amount };
  } catch {
    return null;
  }
}

function ceilingFromSnapshot(input, snapshot, current) {
  if (input === null) return null;
  if (
    !input ||
    ![8453, 84532].includes(current.portfolio.chainId) ||
    snapshot.portfolioRevision !== current.revision ||
    snapshot.coverage.mode !== 'recent' ||
    snapshot.coverage.window?.toBlock !== snapshot.block ||
    snapshot.coverage.scanIncomplete ||
    snapshot.coverage.unreadablePairs ||
    snapshot.coverage.unknownBalances
  )
    fail('BASELINE');
  let token;
  try {
    token = getAddress(input.token);
  } catch {
    fail('INVALID');
  }
  const asset = snapshot.totals.find((row) => row.token === token);
  const amount = input.amount;
  if (
    token === ZeroAddress ||
    !asset ||
    !Number.isInteger(asset.decimals) ||
    typeof amount !== 'string' ||
    !/^\d{1,78}(?:\.\d{1,255})?$/.test(amount)
  )
    fail('INVALID');
  const [whole, fraction = ''] = amount.split('.');
  const precise = fraction.replace(/0+$/, '');
  if (precise.length > asset.decimals) fail('INVALID');
  const atoms = BigInt(whole + precise.padEnd(asset.decimals, '0'));
  if (atoms >= MaxUint256) fail('INVALID');
  return {
    token,
    atoms: String(atoms),
    decimals: asset.decimals,
    baselineReportId: snapshot.reportId,
  };
}

async function assessCeiling(
  wallet,
  config,
  guard,
  anchor,
  intent,
  change,
  intents,
  requestSignal,
) {
  const { rule, members } = guard;
  const token = getAddress(rule.token);
  const memberIds = members.map(({ walletId }) => walletId).sort();
  if (
    !anchor.coverage.tokens.includes(token) ||
    JSON.stringify(anchor.coverage.memberIds) !== JSON.stringify(memberIds)
  )
    fail('BASELINE');
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(30000)]);
  const connected = await wallet.market.connect(config, { signal });
  const rpc = boundedRpc(connected.rpc);
  const connection = { ...connected, rpc };
  const anchorHeight = BigInt(anchor.block);
  const remaining = connection.height - anchorHeight;
  const recent = () => Math.abs(Date.now() - Number(connection.timestamp) * 1000) <= 120000;
  if (!recent()) fail('UNAVAILABLE');
  if (remaining < 0n || remaining > 2000n) fail('STALE');
  const canonical = async (height, hash) => {
    const block = await rpc('eth_getBlockByNumber', ['0x' + height.toString(16), false]);
    if (block?.hash !== hash) fail('UNAVAILABLE');
  };
  await canonical(anchorHeight, anchor.blockHash);
  const addresses = new Map(
    members.map(({ walletId, address }) => [walletId, getAddress(address)]),
  );
  if (addresses.get(intent.walletId) !== getAddress(intent.address)) fail('UNAVAILABLE');
  const pairs = new Map();
  const put = (walletId, value) => {
    const spender = getAddress(value);
    if (spender === ZeroAddress || !addresses.has(walletId)) fail('UNAVAILABLE');
    const key = `${walletId}:${spender}`;
    const previous = pairs.get(key);
    if (previous) return previous;
    if (pairs.size >= 256) fail('UNAVAILABLE');
    const entry = { walletId, spender, outstanding: 0n };
    pairs.set(key, entry);
    return entry;
  };
  for (const row of anchor.rows)
    if (row.token === token && row.protocol === 'erc20') put(row.walletId, row.spender);
  const current = await wallet.portfolios.get(guard.id);
  if (current.revision !== guard.revision) fail('UNAVAILABLE');
  const configured = [
    ...(current.portfolio.limits.tokens ?? []),
    ...(current.portfolio.limits.period?.tokens ?? []),
  ];
  for (const { walletId } of members) {
    put(walletId, PERMIT2);
    for (const entry of configured)
      if (getAddress(entry.address) === token)
        for (const spender of entry.spenders ?? []) put(walletId, spender);
  }
  if (remaining) {
    const found = await Promise.all(
      members.map(({ walletId, address }) =>
        wallet.market
          .discoverTokenApprovals(
            config,
            {
              address,
              token,
              blocks: Number(remaining),
              endBlock: String(connection.height),
              anchorHash: connection.block.hash,
              limit: 50,
            },
            { signal, connection },
          )
          .then((result) => ({ walletId, result })),
      ),
    );
    for (const { walletId, result } of found) {
      if (result.nextOffset !== null) fail('UNAVAILABLE');
      for (const row of result.items) put(walletId, row.spender);
    }
  }
  const unresolved = intents.flatMap((other) => {
    if (
      other.id === intent.id ||
      other.chainId !== intent.chainId ||
      !addresses.has(other.walletId) ||
      other.nativeSignatureAbsent === true ||
      (!pending.has(other.status) &&
        !(other.nativeSigning && other.submissionMayHaveOccurred !== false))
    )
      return [];
    const effect = approval(other.transaction);
    return effect?.token === token && effect.amount ? [{ other, effect }] : [];
  });
  const tag = { blockHash: connection.block.hash, requireCanonical: true };
  const nonces = new Map(
    await Promise.all(
      [...new Set(unresolved.map(({ other }) => other.walletId))].map(async (walletId) => {
        const nonce = await rpc('eth_getTransactionCount', [addresses.get(walletId), tag]);
        if (!/^0x[\da-f]+$/i.test(nonce || '')) fail('UNAVAILABLE');
        return [walletId, BigInt(nonce)];
      }),
    ),
  );
  for (const { other, effect } of unresolved) {
    if (!Number.isSafeInteger(other.transaction.nonce) || other.transaction.nonce < 0)
      fail('UNAVAILABLE');
    if (BigInt(other.transaction.nonce) < nonces.get(other.walletId)) continue;
    const row = put(other.walletId, effect.spender);
    row.outstanding = max(row.outstanding, effect.amount);
  }
  const target = put(intent.walletId, change.spender);
  const positions = await Promise.all(
    [...pairs.values()].map(async (row) => {
      const read = await wallet.market.tokenAllowance(
        config,
        { token, spender: row.spender, address: addresses.get(row.walletId) },
        { signal, connection },
      );
      return { row, granted: BigInt(read.amountAtomic) };
    }),
  );
  await canonical(anchorHeight, anchor.blockHash);
  await canonical(connection.height, connection.block.hash);
  signal.throwIfAborted();
  if (!recent()) fail('UNAVAILABLE');
  let previousPairAtoms = 0n,
    before = 0n,
    projected = 0n;
  for (const { row, granted } of positions) {
    before += max(granted, row.outstanding);
    projected += max(row === target ? change.amount : granted, row.outstanding);
    if (row === target) previousPairAtoms = granted;
  }
  const allowed = change.amount <= previousPairAtoms || projected <= BigInt(rule.atoms);
  return {
    portfolioId: guard.id,
    revision: guard.revision,
    token,
    status: allowed ? 'satisfied' : 'exceeded',
    checkedAt: Date.now(),
    block: String(connection.height),
    blockHash: connection.block.hash,
    previousPairAtoms: String(previousPairAtoms),
    projectedAtoms: String(capped(projected)),
    before: formatUnits(capped(before), rule.decimals),
    projected: formatUnits(capped(projected), rule.decimals),
    ceiling: formatUnits(BigInt(rule.atoms), rule.decimals),
  };
}

module.exports = { approval, ceilingFromSnapshot, assessCeiling };
