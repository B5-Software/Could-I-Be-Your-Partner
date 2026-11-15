/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Interface, parseUnits, zeroPadValue } = require('ethers');
const { CHAINS } = require('./market-data');
const transfer = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]).getEvent('Transfer').topicHash;
const quantity = (value) =>
  typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)
    ? BigInt(value)
    : null;
const hash = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
const address = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const finalized = (intent) =>
  intent.status === 'finalized' ||
  (intent.status === 'reverted' && intent.confirmation === 'finalized');

function tokenDeltas(logs, chain, receipt, owner) {
  if (!Array.isArray(logs) || logs.length > 256) return null;
  const tokens = new Map([
    [chain.usdc, 0n],
    [chain.weth, 0n],
  ]);
  const positions = new Set();
  const ownerTopic = zeroPadValue(owner, 32);
  for (const log of logs) {
    const token = address(log?.address);
    if (!tokens.has(token) || log.topics?.[0]?.toLowerCase?.() !== transfer) continue;
    const position = quantity(log.logIndex);
    if (
      log.removed ||
      hash(log.transactionHash) !== hash(receipt.transactionHash) ||
      hash(log.blockHash) !== hash(receipt.blockHash) ||
      position === null ||
      positions.has(position) ||
      !Array.isArray(log.topics) ||
      log.topics.length !== 3 ||
      !log.topics
        .slice(1)
        .every((topic) => typeof topic === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(topic)) ||
      typeof log.data !== 'string' ||
      !/^0x[0-9a-f]{64}$/i.test(log.data)
    )
      return null;
    positions.add(position);
    const amount = BigInt(log.data);
    const sent = log.topics[1].toLowerCase() === ownerTopic;
    const received = log.topics[2].toLowerCase() === ownerTopic;
    tokens.set(token, tokens.get(token) + (received ? amount : 0n) - (sent ? amount : 0n));
  }
  return tokens;
}

function observe(intent, receipt, chain, decodeCall) {
  const txHash = hash(intent.hash);
  const blockHash = hash(receipt.blockHash);
  const owner = address(intent.address);
  const receiptStatus = quantity(receipt.status);
  if (
    !txHash ||
    !blockHash ||
    !owner ||
    chain.id !== intent.chainId ||
    hash(receipt.transactionHash) !== txHash ||
    address(receipt.from) !== owner ||
    address(receipt.to) !== address(intent.transaction.to) ||
    (receiptStatus !== 1n && receiptStatus !== 0n)
  )
    return null;
  const used = quantity(receipt.gasUsed);
  const price = quantity(receipt.effectiveGasPrice);
  const l1DataFee = quantity(receipt.l1Fee);
  const evidence = {
    version: 1,
    txHash,
    blockHash,
    gasUsed: used !== null && used > 0n && used < 2n ** 64n ? String(used) : null,
    l2GasWei: used === null || price === null ? null : String(used * price),
    l1DataFeeWei: l1DataFee === null ? null : String(l1DataFee),
    operatorFeeWei: null,
    fill: null,
  };
  if (receiptStatus === 0n || !intent.commandId.endsWith(':swap')) return evidence;
  const description = decodeCall(
    intent.transaction.to,
    intent.transaction.data,
    BigInt(intent.transaction.value),
    intent.chainId,
  );
  if (description?.kind !== 'uniswap-v3-swap' || address(description.recipient) !== owner)
    return evidence;
  const buying = description.tokenIn === 'USDC' && description.tokenOut === 'WETH';
  if (!buying && !(description.tokenIn === 'WETH' && description.tokenOut === 'USDC'))
    return evidence;
  const deltas = tokenDeltas(receipt.logs, chain, receipt, owner);
  if (!deltas) return evidence;
  const input = -deltas.get(buying ? chain.usdc : chain.weth);
  const output = deltas.get(buying ? chain.weth : chain.usdc);
  if (
    input > 0n &&
    input <= parseUnits(description.amountIn, buying ? 6 : 18) &&
    output >= parseUnits(description.minimumAmountOut, buying ? 18 : 6) &&
    output > 0n
  )
    evidence.fill = { inputAtoms: String(input), outputAtoms: String(output) };
  return evidence;
}

const atoms = (value) =>
  typeof value === 'string' && /^(?:0|[1-9]\d{0,154})$/.test(value) ? BigInt(value) : null;
function evidenceOf(intent) {
  const evidence = intent.executionReceipt;
  if (evidence?.version === 1 && evidence.txHash === hash(intent.hash) && hash(evidence.blockHash))
    return evidence;
  return null;
}
const isFill = (intent) => intent.status === 'finalized' && intent.commandId.endsWith(':swap');
const hasFill = (evidence) =>
  atoms(evidence?.fill?.inputAtoms) > 0n && atoms(evidence?.fill?.outputAtoms) > 0n;
function needsBackfill(intent) {
  if (!finalized(intent) || !hash(intent.hash) || intent.submissionMayHaveOccurred === false)
    return false;
  const evidence = evidenceOf(intent);
  return (
    atoms(evidence?.l2GasWei) === null ||
    evidence?.gasUsed === undefined ||
    (isFill(intent) && !hasFill(evidence))
  );
}

function operatorFeeTarget(intent) {
  if (!finalized(intent) || intent.submissionMayHaveOccurred === false) return null;
  const evidence = evidenceOf(intent);
  const gasUsed = atoms(evidence?.gasUsed);
  if (
    gasUsed === null ||
    gasUsed <= 0n ||
    gasUsed >= 2n ** 64n ||
    atoms(evidence.operatorFeeWei) !== null
  )
    return null;
  return { txHash: evidence.txHash, blockHash: evidence.blockHash, gasUsed };
}

function summarize(intents) {
  const seen = new Set();
  let input = 0n,
    output = 0n,
    gas = 0n,
    data = 0n,
    operator = 0n;
  let fills = 0,
    swaps = 0,
    transactions = 0,
    receipts = 0,
    gasReceipts = 0,
    dataReceipts = 0,
    operatorReceipts = 0;
  for (const intent of intents) {
    const txHash = hash(intent.hash);
    if (
      !finalized(intent) ||
      !txHash ||
      seen.has(txHash) ||
      intent.submissionMayHaveOccurred === false
    )
      continue;
    seen.add(txHash);
    transactions++;
    const swap = isFill(intent);
    if (swap) swaps++;
    if (!needsBackfill(intent)) receipts++;
    const evidence = evidenceOf(intent);
    if (!evidence) continue;
    const l2 = atoms(evidence.l2GasWei);
    const l1 = atoms(evidence.l1DataFeeWei);
    const op = atoms(evidence.operatorFeeWei);
    if (l2 !== null) {
      gas += l2;
      gasReceipts++;
    }
    if (l1 !== null) {
      data += l1;
      dataReceipts++;
    }
    if (op !== null) {
      operator += op;
      operatorReceipts++;
    }
    const filledInput = atoms(evidence.fill?.inputAtoms);
    const filledOutput = atoms(evidence.fill?.outputAtoms);
    if (swap && filledInput > 0n && filledOutput > 0n) {
      input += filledInput;
      output += filledOutput;
      fills++;
    }
  }
  return {
    receiptsMissing: transactions - receipts,
    fill: {
      inputAtoms: String(input),
      outputAtoms: String(output),
      observed: fills,
      finalized: swaps,
    },
    fees: {
      l2GasWei: gasReceipts ? String(gas) : null,
      l1DataFeeWei: dataReceipts ? String(data) : null,
      operatorFeeWei: operatorReceipts ? String(operator) : null,
      totalWei:
        transactions &&
        [gasReceipts, dataReceipts, operatorReceipts].every((n) => n === transactions)
          ? String(gas + data + operator)
          : null,
      l2Receipts: gasReceipts,
      l1Receipts: dataReceipts,
      operatorReceipts,
      finalizedTransactions: transactions,
    },
  };
}
module.exports = {
  observe,
  summarize,
  finalized,
  needsBackfill,
  operatorFeeTarget,
  supportedChain: (id) => Object.values(CHAINS).some((chain) => chain.id === id),
};
