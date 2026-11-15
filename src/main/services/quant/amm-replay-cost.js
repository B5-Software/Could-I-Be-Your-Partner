/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Interface, Transaction, parseUnits, keccak256 } = require('ethers');
const { routerAbi } = require('./base-swap');
const { readOperatorFee } = require('./market-data');
const { ceilDiv } = require('./decimal');

const oracle = '0x420000000000000000000000000000000000000f';
const l1FeeAbi = new Interface(['function getL1Fee(bytes unsignedTx) view returns(uint256)']);
// https://docs.base.org/upgrades/isthmus/overview
const isthmus = { 8453: 1746806401, 84532: 1744905600 };
const recipient = '0x111122223333444455556666777788889999aaaa';
const Q192 = 1n << 192n;
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

function blockQuantity(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,31})$/i.test(value))
    throw Error('AMM_REPLAY_FEE_HEADER');
  return BigInt(value);
}

async function readSlot0(rpc, pool, block, errorCode) {
  const slot = await rpc('eth_call', [{ to: pool, data: '0x3850c7bd' }, block]);
  if (typeof slot !== 'string' || !/^0x[\da-f]{448}$/i.test(slot)) throw Error(errorCode);
  const sqrt = BigInt(slot.slice(0, 66));
  if (sqrt < MIN_SQRT || sqrt >= MAX_SQRT) throw Error(errorCode);
  return sqrt;
}

async function historicalFee({
  rpc,
  group,
  header,
  chain,
  deployment,
  pool,
  token0,
  fee,
  config,
  quote,
}) {
  const baseFee = blockQuantity(header.baseFeePerGas);
  const gasUnits = quote.gas + BigInt(config.routerOverheadGas);
  if (gasUnits > blockQuantity(header.gasLimit) || gasUnits >= 2n ** 64n)
    throw Error('AMM_REPLAY_FEE_GAS_LIMIT');
  const priorityFee = parseUnits(config.tipGwei, 9);
  const gasPrice = baseFee + priorityFee;
  const block = { blockHash: group.blockHash, requireCanonical: true };
  const swap = routerAbi.encodeFunctionData('exactInputSingle', [
    [quote.tokenIn, quote.tokenOut, fee, recipient, quote.amountIn, quote.amountOut, 0],
  ]);
  const data = routerAbi.encodeFunctionData('multicall', [group.time + 180, [swap]]);
  const unsignedTx = Transaction.from({
    type: 2,
    chainId: chain.id,
    nonce: 0,
    gasLimit: gasUnits,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: priorityFee,
    to: deployment.router,
    data,
    value: 0,
  }).unsignedSerialized;
  const operatorActive = group.time >= isthmus[chain.id];
  const [encodedL1, operatorWei, sqrt] = await Promise.all([
    rpc('eth_call', [
      { to: oracle, data: l1FeeAbi.encodeFunctionData('getL1Fee', [unsignedTx]) },
      block,
    ]),
    operatorActive ? readOperatorFee(rpc, gasUnits, block) : 0n,
    readSlot0(rpc, pool, block, 'AMM_REPLAY_FEE_MARK'),
  ]);
  if (typeof encodedL1 !== 'string' || !/^0x[\da-f]{64}$/i.test(encodedL1))
    throw Error('AMM_REPLAY_L1_FEE');
  const l1Wei = BigInt(encodedL1),
    l2Wei = gasUnits * gasPrice;
  const totalWei = l1Wei + l2Wei + operatorWei;
  const ratio = sqrt * sqrt;
  const wethIsToken0 = token0 === chain.weth;
  const cost = wethIsToken0 ? ceilDiv(totalWei * ratio, Q192) : ceilDiv(totalWei * Q192, ratio);
  return {
    mode: 'historical',
    gasUnits: String(gasUnits),
    baseFeePerGasWei: String(baseFee),
    priorityFeePerGasWei: String(priorityFee),
    l2Wei: String(l2Wei),
    l1Wei: String(l1Wei),
    operatorWei: String(operatorWei),
    operatorActive,
    totalWei: String(totalWei),
    usdcAtoms: String(cost),
    sqrtPriceX96: String(sqrt),
    wethIsToken0,
    unsignedTxHash: keccak256(unsignedTx),
    unsignedTx,
  };
}

module.exports = { historicalFee, readSlot0, MIN_SQRT, MAX_SQRT, Q192 };
