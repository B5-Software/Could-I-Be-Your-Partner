/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { formatUnits } = require('../quant/market-data');
const receipts = require('../quant/execution-receipt');
const { digest, page } = require('../quant/event-files');

const txHash = (value) =>
  typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value) ? value.toLowerCase() : null;
const unresolved = new Set(['submit-unknown', 'submitted', 'included', 'safe', 'reorged']);
const quantity = (value) =>
  typeof value === 'string' && /^[1-9]\d{0,77}$/.test(value) ? BigInt(value) : 0n;
const text = (value, places) =>
  value < 0n ? '-' + formatUnits(-value, places) : formatUnits(value, places);
const amount = (value, places) => ({ atomic: String(value), amount: text(value, places) });
const blank = () => ({
  buys: 0,
  sells: 0,
  missing: 0,
  matched: 0n,
  unmatched: 0n,
  invalidated: 0n,
  held: 0n,
  heldCost: 0n,
  cost: 0n,
  proceeds: 0n,
  matchedSales: 0,
  pricedSales: 0,
  swapFees: 0n,
});
const format = (total) => ({
  buyCount: total.buys,
  sellCount: total.sells,
  missingCount: total.missing,
  matchedWeth: amount(total.matched, 18),
  unmatchedSaleWeth: amount(total.unmatched, 18),
  interruptedBasisWeth: amount(total.invalidated, 18),
  openWeth: amount(total.held, 18),
  openCostUsdc: amount(total.heldCost, 6),
  matchedCostUsdc: amount(total.cost, 6),
  matchedProceedsUsdc: amount(total.proceeds, 6),
  realizedGrossUsdc: total.matched > 0n ? amount(total.proceeds - total.cost, 6) : null,
  matchedSaleCount: total.matchedSales,
  pricedSaleCount: total.pricedSales,
  matchedSwapFeesUsdc:
    total.matchedSales && total.matchedSales === total.pricedSales
      ? amount(total.swapFees, 6)
      : null,
  realizedAfterSwapFeesUsdc:
    total.matchedSales && total.matchedSales === total.pricedSales
      ? amount(total.proceeds - total.cost - total.swapFees, 6)
      : null,
});
function feeEvidence(intent) {
  const evidence = intent.executionReceipt;
  const hash = txHash(intent.hash);
  return receipts.finalized(intent) &&
    evidence?.version === 1 &&
    hash &&
    txHash(evidence.txHash) === hash &&
    txHash(evidence.blockHash)
    ? evidence
    : null;
}
function feeQuote(intent) {
  const evidence = feeEvidence(intent),
    quote = evidence?.feeQuote;
  if (
    intent.chainId !== 8453 ||
    quote?.version !== 1 ||
    quote.source !== 'Chainlink' ||
    quote.blockHash !== evidence.blockHash ||
    quote.blockNumber !== intent.block ||
    !quantity(quote.eth?.priceAtomic) ||
    !quantity(quote.usdc?.priceAtomic)
  )
    return null;
  return quote;
}
function feeUsdc(intent) {
  const quote = feeQuote(intent);
  if (!quote) return null;
  const evidence = intent.executionReceipt;
  const parts = [evidence.l2GasWei, evidence.l1DataFeeWei, evidence.operatorFeeWei];
  if (!parts.every((value) => typeof value === 'string' && /^(?:0|[1-9]\d{0,77})$/.test(value)))
    return null;
  const wei = parts.reduce((sum, value) => sum + BigInt(value), 0n);
  return (wei * BigInt(quote.eth.priceAtomic)) / (10n ** 12n * BigInt(quote.usdc.priceAtomic));
}
function fill(intent) {
  const evidence = intent.executionReceipt;
  const description = intent.description;
  if (
    evidence?.version !== 1 ||
    txHash(evidence.txHash) !== txHash(intent.hash) ||
    !txHash(evidence.blockHash) ||
    description?.kind !== 'uniswap-v3-swap' ||
    description.recipient?.toLowerCase() !== intent.address.toLowerCase()
  )
    return null;
  const input = quantity(evidence.fill?.inputAtoms),
    output = quantity(evidence.fill?.outputAtoms);
  if (!input || !output || input >= 1n << 256n || output >= 1n << 256n) return null;
  if (description.tokenIn === 'USDC' && description.tokenOut === 'WETH')
    return { side: 'buy', weth: output, usdc: input };
  if (description.tokenIn === 'WETH' && description.tokenOut === 'USDC')
    return { side: 'sell', weth: input, usdc: output };
  return null;
}

function walletLedger(records, feesByIntent) {
  const totals = blank(),
    lots = [],
    rows = [];
  let cursor = 0;
  const nonce = ({ transaction }) => transaction?.nonce;
  const finalNonces = new Set(records.filter(receipts.finalized).map(nonce));
  let lastFinal = -1;
  for (const value of finalNonces)
    if (Number.isSafeInteger(value) && value > lastFinal) lastFinal = value;
  const swaps = records.filter(
    (intent) =>
      intent.commandId?.endsWith(':swap') &&
      (intent.status === 'finalized' ||
        (unresolved.has(intent.status) &&
          nonce(intent) < lastFinal &&
          !finalNonces.has(nonce(intent)))),
  );
  const ordered = swaps.every((row) => Number.isSafeInteger(nonce(row)) && nonce(row) >= 0);
  if (ordered) swaps.sort((a, b) => nonce(a) - nonce(b));
  for (let index = 0; index < swaps.length; index++) {
    const intent = swaps[index];
    const details = {
      intentId: intent.id,
      walletId: intent.walletId,
      txHash: intent.hash,
      blockHash: txHash(intent.executionReceipt?.blockHash),
      block: intent.block ?? null,
      nonce: nonce(intent) ?? null,
    };
    const ambiguous =
      !ordered ||
      nonce(swaps[index - 1] ?? {}) === nonce(intent) ||
      nonce(swaps[index + 1] ?? {}) === nonce(intent);
    const trade = ambiguous || intent.status !== 'finalized' ? null : fill(intent);
    if (!trade) {
      totals.missing++;
      totals.invalidated += totals.held;
      totals.held = totals.heldCost = 0n;
      lots.length = cursor = 0;
      rows.push({ ...details, side: 'unknown' });
      continue;
    }
    const fee = feesByIntent.get(intent.id) ?? null;
    const quote = feeQuote(intent);
    const feeDetails = {
      transactionFeeUsdc: fee === null ? null : amount(fee, 6),
      ...(quote && { feeQuote: quote }),
    };
    if (trade.side === 'buy') {
      totals.buys++;
      totals.held += trade.weth;
      totals.heldCost += trade.usdc;
      lots.push({ weth: trade.weth, usdc: trade.usdc, fee, used: 0n });
      rows.push({
        ...details,
        ...feeDetails,
        side: 'buy',
        boughtWeth: amount(trade.weth, 18),
        paidUsdc: amount(trade.usdc, 6),
      });
      continue;
    }
    totals.sells++;
    let remaining = trade.weth,
      cost = 0n;
    let completeFee = fee !== null,
      matchedBuyFees = 0n;
    while (remaining && cursor < lots.length) {
      const lot = lots[cursor];
      const available = lot.weth - lot.used;
      const taken = remaining < available ? remaining : available;
      const used = lot.used + taken;
      // Allocate cumulative cost so consuming the final atom releases the original lot's full cost.
      cost += (used * lot.usdc) / lot.weth - (lot.used * lot.usdc) / lot.weth;
      if (lot.fee === null) completeFee = false;
      else matchedBuyFees += (used * lot.fee) / lot.weth - (lot.used * lot.fee) / lot.weth;
      lot.used = used;
      remaining -= taken;
      if (used === lot.weth) cursor++;
    }
    const matched = trade.weth - remaining;
    const proceeds = (matched * trade.usdc) / trade.weth;
    const matchedFees =
      matched && completeFee ? matchedBuyFees + (fee * matched) / trade.weth : null;
    if (matched) totals.matchedSales++;
    if (matchedFees !== null) {
      totals.pricedSales++;
      totals.swapFees += matchedFees;
    }
    totals.cost += cost;
    totals.proceeds += proceeds;
    totals.matched += matched;
    totals.unmatched += remaining;
    totals.held -= matched;
    totals.heldCost -= cost;
    rows.push({
      ...details,
      ...feeDetails,
      side: 'sell',
      matchedWeth: amount(matched, 18),
      unmatchedSaleWeth: amount(remaining, 18),
      matchedCostUsdc: amount(cost, 6),
      matchedProceedsUsdc: amount(proceeds, 6),
      realizedGrossUsdc: matched ? amount(proceeds - cost, 6) : null,
      matchedSwapFeesUsdc: matchedFees === null ? null : amount(matchedFees, 6),
      realizedAfterSwapFeesUsdc:
        matchedFees === null ? null : amount(proceeds - cost - matchedFees, 6),
    });
  }
  return { totals, rows };
}

function performanceRecords(portfolio, intents, input) {
  if (![8453, 84532].includes(portfolio.chainId)) throw Error('WALLET_PORTFOLIO_PERFORMANCE_CHAIN');
  const members = portfolio.members.filter(
    ({ walletId }) => input.walletId === undefined || walletId === input.walletId,
  );
  if (!members.length) throw Error('WALLET_PORTFOLIO_INVALID');
  const byWallet = new Map(
    members.map(({ walletId, address }) => [
      walletId,
      { address: address.toLowerCase(), records: [] },
    ]),
  );
  const seen = new Set();
  for (const intent of intents) {
    const owner = byWallet.get(intent.walletId);
    const hash = txHash(intent.hash);
    if (
      !owner ||
      intent.address?.toLowerCase() !== owner.address ||
      intent.chainId !== portfolio.chainId ||
      !intent.execution?.planId ||
      (!receipts.finalized(intent) && !unresolved.has(intent.status)) ||
      intent.submissionMayHaveOccurred === false ||
      !hash ||
      seen.has(hash)
    )
      continue;
    seen.add(hash);
    owner.records.push(intent);
  }
  return byWallet;
}

function portfolioPerformance(portfolio, revision, intents, input) {
  const byWallet = performanceRecords(portfolio, intents, input);
  const combined = blank(),
    records = [],
    rows = [];
  const feesByIntent = new Map();
  let knownUsdc = 0n,
    priced = 0;
  for (const { records: walletRecords } of byWallet.values()) {
    records.push(...walletRecords);
    for (const intent of walletRecords) {
      const fee = feeUsdc(intent);
      if (fee === null) continue;
      priced++;
      knownUsdc += fee;
      feesByIntent.set(intent.id, fee);
    }
    const result = walletLedger(walletRecords, feesByIntent);
    for (const key of Object.keys(combined)) combined[key] += result.totals[key];
    rows.push(...result.rows);
  }
  const block = (row) => (/^\d{1,20}$/.test(row.block ?? '') ? BigInt(row.block) : 0n);
  rows.sort((a, b) =>
    block(a) === block(b)
      ? b.walletId.localeCompare(a.walletId) || (b.nonce ?? -1) - (a.nonce ?? -1)
      : block(a) > block(b)
        ? -1
        : 1,
  );
  const totals = format(combined),
    fees = receipts.summarize(records).fees;
  const historicalFees = {
    available: portfolio.chainId === 8453,
    priced,
    transactions: fees.finalizedTransactions,
    knownUsdc: priced ? amount(knownUsdc, 6) : null,
    totalUsdc: priced && priced === fees.finalizedTransactions ? amount(knownUsdc, 6) : null,
  };
  const snapshotId = digest([
    portfolio.id,
    revision,
    portfolio.chainId,
    input.walletId ?? null,
    totals,
    fees,
    historicalFees,
    rows,
  ]);
  if (input.snapshotId !== undefined && input.snapshotId !== snapshotId)
    throw Error('WALLET_PORTFOLIO_PERFORMANCE_CHANGED');
  return {
    portfolioId: portfolio.id,
    chainId: portfolio.chainId,
    revision,
    scope: 'local-live-plans',
    method: 'fifo-by-wallet',
    snapshotId,
    totals,
    fees,
    historicalFees,
    ...page(rows, input),
  };
}

module.exports = { portfolioPerformance, performanceRecords, feeEvidence, feeQuote };
