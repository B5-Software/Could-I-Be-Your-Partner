/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const {
  Interface,
  parseUnits,
  formatUnits,
  MaxUint256,
  keccak256,
  toUtf8Bytes,
} = require('ethers');
const { deployments, routerAbi, quoteAbi } = require('./base-swap');
const { historySource } = require('./vwap-profile');
const { loadTape } = require('./amm-replay');
const { readSlot0, MIN_SQRT, MAX_SQRT, Q192 } = require('./amm-replay-cost');

const CODE_VERSION = 'base-amm-scenario-1';
const TOKEN = new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
  'function deposit() payable',
]);
const blockHashPattern = /^0x[\da-f]{64}$/i;
const hex = (n) => '0x' + n.toString(16);
const success = (call) => call?.status === '0x1';

function scenarioParameters(input = {}) {
  const amount = (value, decimals) => {
    if (
      typeof value !== 'string' ||
      !/^\d{1,12}(?:\.\d{1,18})?$/.test(value) ||
      (value.split('.')[1]?.length ?? 0) > decimals
    )
      throw Error('AMM_SCENARIO_PARAMETERS');
    return formatUnits(parseUnits(value, decimals), decimals);
  };
  if (
    !Array.isArray(input.legs) ||
    input.legs.length < 1 ||
    input.legs.length > 8 ||
    (input.anchorBlock !== undefined &&
      (!Number.isSafeInteger(input.anchorBlock) || input.anchorBlock < 0))
  )
    throw Error('AMM_SCENARIO_PARAMETERS');
  const initialWeth = amount(input.initialWeth ?? '1', 18);
  if (parseUnits(initialWeth, 18) <= 0n) throw Error('AMM_SCENARIO_PARAMETERS');
  return {
    strategy: 'amm-stateful-scenario',
    initialWeth,
    ...(input.anchorBlock !== undefined && { anchorBlock: input.anchorBlock }),
    legs: input.legs.map((leg) => {
      if (!leg || !['buy', 'sell'].includes(leg.side)) throw Error('AMM_SCENARIO_PARAMETERS');
      const buy = leg.side === 'buy';
      const amountIn = amount(leg.amountIn, buy ? 6 : 18);
      if (parseUnits(amountIn, buy ? 6 : 18) <= 0n) throw Error('AMM_SCENARIO_PARAMETERS');
      return { side: leg.side, amountIn, minimumOut: amount(leg.minimumOut ?? '0', buy ? 18 : 6) };
    }),
  };
}

function resultWord(call, slot = false) {
  const width = slot ? 448 : 64;
  if (
    !success(call) ||
    typeof call.returnData !== 'string' ||
    call.returnData.length !== width + 2 ||
    !/^0x[\da-f]+$/i.test(call.returnData)
  )
    throw Error('AMM_SCENARIO_RESPONSE');
  const value = BigInt(call.returnData.slice(0, 66));
  if (slot && (value < MIN_SQRT || value >= MAX_SQRT)) throw Error('AMM_SCENARIO_RESPONSE');
  return value;
}

async function runScenario({ dataset, datasetId, load, market, marketConfig, config, signal }) {
  const { first, groups } = await loadTape(datasetId, dataset, load, 1);
  const anchor =
    config.anchorBlock === undefined
      ? groups.at(-1)
      : groups.find(({ block }) => block === config.anchorBlock);
  if (!anchor) throw Error('AMM_SCENARIO_ANCHOR');
  const source = { ...marketConfig, pool: first.pool, poolFee: first.fee };
  const { chain, rpc, header, finalized } = await historySource(market, source, signal);
  if (chain.id !== first.chainId || !deployments[source.venue]) throw Error('AMM_SCENARIO_SOURCE');
  if (anchor.block > finalized.number) throw Error('AMM_SCENARIO_UNFINALIZED');
  const at = hex(anchor.block),
    tag = { blockHash: anchor.blockHash, requireCanonical: true };
  const { router, quoter } = deployments[source.venue];
  const verify = async () => {
    const block = await header(at);
    if (block.hash !== anchor.blockHash || block.time !== anchor.time)
      throw Error('AMM_SCENARIO_ANCHOR_CHANGED');
  };
  await verify();
  const { pool, token0 } = await market.basePool(source, chain, (to, data) =>
    rpc('eth_call', [{ to, data }, tag]),
  );
  const anchorSqrt = await readSlot0(rpc, pool, tag, 'AMM_SCENARIO_RESPONSE');
  const sender =
    '0x' +
    keccak256(toUtf8Bytes(`cibyp-amm-scenario:${chain.id}:${datasetId}:${anchor.blockHash}`)).slice(
      -40,
    );
  const initialWeth = parseUnits(config.initialWeth, 18);
  const call = (to, data, value = 0n) => ({
    from: sender,
    to,
    input: data,
    value: hex(value),
    gas: to === router ? '0x7a120' : '0x249f0',
  });
  const balance = (token) => call(token, TOKEN.encodeFunctionData('balanceOf', [sender]));
  const approve = (token) => call(token, TOKEN.encodeFunctionData('approve', [router, MaxUint256]));
  const spot = () => call(pool, '0x3850c7bd');
  const setup = [
    balance(chain.weth),
    balance(chain.usdc),
    call(chain.weth, TOKEN.encodeFunctionData('deposit'), initialWeth),
    approve(chain.weth),
    approve(chain.usdc),
    balance(chain.weth),
    balance(chain.usdc),
  ];
  const legs = config.legs.map((leg) => {
    const buy = leg.side === 'buy';
    const tokenIn = buy ? chain.usdc : chain.weth,
      tokenOut = buy ? chain.weth : chain.usdc;
    const amountIn = parseUnits(leg.amountIn, buy ? 6 : 18),
      minimumOut = parseUnits(leg.minimumOut, buy ? 18 : 6);
    const data = routerAbi.encodeFunctionData('exactInputSingle', [
      [tokenIn, tokenOut, first.fee, sender, amountIn, minimumOut, 0],
    ]);
    return {
      buy,
      tokenIn,
      tokenOut,
      amountIn,
      minimumOut,
      calls: [spot(), call(router, data), spot(), balance(chain.weth), balance(chain.usdc)],
    };
  });
  // Base RPC can reuse the anchor timestamp when no block time is supplied.
  const blockStateCalls = legs.map((leg, index) => ({
    blockOverrides: { timestamp: hex(anchor.time + (index + 1) * 2) },
    ...(index === 0 && {
      stateOverrides: { [sender]: { balance: hex(initialWeth + 10n ** 18n) } },
    }),
    calls: index === 0 ? [...setup, ...leg.calls] : leg.calls,
  }));
  let simulated;
  try {
    simulated = await rpc('eth_simulateV1', [
      { blockStateCalls, validation: false, traceTransfers: false },
      at,
    ]);
  } catch (error) {
    if (error.message === 'BASE_RPC_ERROR_-32601') throw Error('AMM_SCENARIO_RPC_UNAVAILABLE');
    throw error;
  }
  await verify();
  if (!Array.isArray(simulated) || simulated.length !== legs.length)
    throw Error('AMM_SCENARIO_RESPONSE');
  let parent = anchor.blockHash;
  for (const [i, block] of simulated.entries()) {
    if (
      !blockHashPattern.test(block?.hash) ||
      block.parentHash?.toLowerCase() !== parent ||
      block.number !== hex(anchor.block + i + 1) ||
      block.timestamp !== blockStateCalls[i].blockOverrides.timestamp ||
      block.calls?.length !== blockStateCalls[i].calls.length
    )
      throw Error('AMM_SCENARIO_RESPONSE');
    parent = block.hash.toLowerCase();
  }
  const [oldWeth, oldUsdc, wrap, approveWeth, approveUsdc, newWeth, newUsdc] = simulated[0].calls;
  if (
    resultWord(oldWeth) ||
    resultWord(oldUsdc) ||
    !success(wrap) ||
    resultWord(approveWeth) !== 1n ||
    resultWord(approveUsdc) !== 1n ||
    resultWord(newWeth) !== initialWeth ||
    resultWord(newUsdc) !== 0n
  )
    throw Error('AMM_SCENARIO_SETUP');

  const wethIsToken0 = token0 === chain.weth;
  const valueAt = (weth, usdc, sqrt) =>
    usdc + (wethIsToken0 ? (weth * sqrt * sqrt) / Q192 : (weth * Q192) / (sqrt * sqrt));
  let weth = initialWeth,
    usdc = 0n;
  let sqrt = resultWord(simulated[0].calls[setup.length], true);
  if (sqrt !== anchorSqrt) throw Error('AMM_SCENARIO_ANCHOR_CHANGED');
  const startSqrt = sqrt,
    startValue = valueAt(weth, usdc, sqrt);
  const equity = [{ time: anchor.time, value: Number(formatUnits(startValue, 6)) }];
  const reports = [];
  let peak = startValue,
    maxDraw = 0n,
    settled = 0,
    gas = 0n,
    value = startValue;
  for (const [i, leg] of legs.entries()) {
    signal?.throwIfAborted();
    const block = simulated[i];
    const [pre, swap, post, wethBalance, usdcBalance] = block.calls.slice(i ? 0 : setup.length);
    const before = resultWord(pre, true),
      after = resultWord(post, true);
    const nextWeth = resultWord(wethBalance),
      nextUsdc = resultWord(usdcBalance);
    if (
      before !== sqrt ||
      !/^0x[\da-f]{1,16}$/i.test(swap?.gasUsed) ||
      !['0x0', '0x1'].includes(swap?.status)
    )
      throw Error('AMM_SCENARIO_RESPONSE');
    const gasUsed = BigInt(swap.gasUsed);
    gas += gasUsed;
    const report = {
      index: i + 1,
      side: config.legs[i].side,
      amountInAtoms: String(leg.amountIn),
      simulatedBlock: block.hash,
      blockNumber: Number(block.number),
      timestamp: Number(block.timestamp),
      sqrtBeforeX96: String(before),
      sqrtAfterX96: String(after),
      gasUsed: String(gasUsed),
      wethBalanceAtoms: String(nextWeth),
      usdcBalanceAtoms: String(nextUsdc),
    };
    if (!success(swap)) {
      if (after !== before || nextWeth !== weth || nextUsdc !== usdc)
        throw Error('AMM_SCENARIO_RESPONSE');
      reports.push({ ...report, status: 'reverted' });
      break;
    }
    const amountOut = resultWord(swap);
    const spent = leg.buy ? usdc - nextUsdc : weth - nextWeth;
    const received = leg.buy ? nextWeth - weth : nextUsdc - usdc;
    if (
      spent <= 0n ||
      spent > leg.amountIn ||
      received <= 0n ||
      received !== amountOut ||
      received < leg.minimumOut
    )
      throw Error('AMM_SCENARIO_RESPONSE');
    reports.push({
      ...report,
      status: spent === leg.amountIn ? 'filled' : 'partial-input',
      spentAtoms: String(spent),
      amountOutAtoms: String(received),
    });
    settled++;
    weth = nextWeth;
    usdc = nextUsdc;
    sqrt = after;
    value = valueAt(weth, usdc, sqrt);
    if (value > peak) peak = value;
    const draw = peak ? ((peak - value) * 1000000n) / peak : 0n;
    if (draw > maxDraw) maxDraw = draw;
    equity.push({ time: Number(BigInt(block.timestamp)), value: Number(formatUnits(value, 6)) });
  }
  await Promise.all(
    reports
      .filter(({ status }) => status === 'filled')
      .map(async (report) => {
        const leg = legs[report.index - 1];
        try {
          const data = quoteAbi.encodeFunctionData('quoteExactInputSingle', [
            [leg.tokenIn, leg.tokenOut, leg.amountIn, first.fee, 0],
          ]);
          const [baseline, sqrtAfter] = quoteAbi.decodeFunctionResult(
            'quoteExactInputSingle',
            await rpc('eth_call', [{ to: quoter, data }, tag]),
          );
          if (baseline <= 0n || sqrtAfter <= MIN_SQRT + 1n || sqrtAfter >= MAX_SQRT - 1n)
            throw Error('AMM_SCENARIO_BASELINE');
          report.baselineOutAtoms = String(baseline);
          report.deltaOutAtoms = String(BigInt(report.amountOutAtoms) - baseline);
        } catch {
          signal?.throwIfAborted();
          report.baselineUnavailable = true;
        }
      }),
  );
  await verify();
  return {
    config,
    equity,
    metrics: {
      finalEquity: Number(formatUnits(value, 6)),
      cash: formatUnits(usdc, 6),
      position: formatUnits(weth, 18),
      returnPct: startValue ? Number(((value - startValue) * 1000000n) / startValue) / 10000 : 0,
      maxDrawdownPct: Number(maxDraw) / 10000,
      fees: '—',
      fills: settled,
      bars: 0,
    },
    ammScenario: {
      anchor: { block: anchor.block, blockHash: anchor.blockHash, time: anchor.time },
      pool,
      sender,
      wethIsToken0,
      startSqrtPriceX96: String(startSqrt),
      finalSqrtPriceX96: String(sqrt),
      status: reports.at(-1).status === 'reverted' ? 'stopped-on-revert' : 'completed',
      totalSwapGas: String(gas),
      legs: reports,
    },
    assumptions: [
      'single-finalized-anchor',
      'ordered-virtual-router-swaps-carry-state-across-simulated-blocks',
      'virtual-native-funded-weth-within-simulation',
      'original-anchor-quotes-use-same-input',
      'replay-stops-at-first-reverted-leg',
      'gas-measured-network-cost-not-deducted',
      'no-external-trades-between-legs',
    ],
  };
}

module.exports = { CODE_VERSION, scenarioParameters, runScenario };
