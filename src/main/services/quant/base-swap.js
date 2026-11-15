/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Interface, parseUnits, formatUnits } = require('ethers');
const { createHash } = require('node:crypto');
const { CHAINS } = require('./market-data');
const deployments = {
  base: {
    router: '0x2626664c2603336e57b271c5c0b26f421741e481',
    quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
  },
  'base-sepolia': {
    router: '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4',
    quoter: '0xc5290058841028f1614f3a6f0f5816cad0df5e27',
  },
};
const erc20 = new Interface([
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
  'function balanceOf(address) view returns(uint256)',
]);
const quoteAbi = new Interface([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const routerAbi = new Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)',
  'function multicall(uint256,bytes[]) payable returns(bytes[])',
]);
function minimumOutputAtoms(value, buying) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{1,20}(?:\.\d{1,18})?$/.test(value))
    throw Error('EXECUTION_PRICE_LIMIT_RANGE');
  let atoms;
  try {
    atoms = parseUnits(value, buying ? 18 : 6);
  } catch {
    throw Error('EXECUTION_PRICE_LIMIT_RANGE');
  }
  if (atoms <= 0n) throw Error('EXECUTION_PRICE_LIMIT_RANGE');
  return atoms;
}
async function simulateBaseSwap(rpc, address, tx, minimum) {
  try {
    const encoded = await rpc('eth_call', [
      { from: address, to: tx.to, data: tx.data, value: '0x' + BigInt(tx.value).toString(16) },
      'latest',
    ]);
    const outer = routerAbi.parseTransaction({ data: tx.data });
    const [result] = routerAbi.decodeFunctionResult(outer.name, encoded);
    const amount =
      outer.name === 'multicall'
        ? routerAbi.decodeFunctionResult('exactInputSingle', result[0])[0]
        : result;
    if (amount < minimum) throw Error();
  } catch {
    throw Error('WALLET_SWAP_SIMULATION_FAILED');
  }
}
async function executeBaseSwap({
  market,
  walletService,
  config,
  input,
  commandId,
  workspaceId,
  agentContext,
  agentScopeBinding,
  signal,
  expectedPolicyId,
  execution,
  checkAuthority,
  windowEndsAt,
  arrivalLimit,
}) {
  const chain = CHAINS[config.venue],
    deployment = deployments[config.venue];
  if (!chain || !deployment) throw new Error('WALLET_CHAIN_UNAVAILABLE');
  const fee = config.poolFee ?? 500;
  if (!Number.isInteger(fee) || fee < 1 || fee >= 1000000) throw new Error('BASE_POOL_FEE_RANGE');
  if (!['buy', 'sell'].includes(input.side) || typeof input.amountIn !== 'string')
    throw new Error('INVALID_SWAP_INPUT');
  const slippage = input.slippageBps ?? 50;
  if (!Number.isInteger(slippage) || slippage < 0 || slippage > 500)
    throw new Error('SWAP_SLIPPAGE_RANGE');
  const wallet = walletService.wallet(input.walletId);
  const buying = input.side === 'buy',
    amountIn = parseUnits(input.amountIn, buying ? 6 : 18);
  const absolute = minimumOutputAtoms(input.minimumAmountOut, buying);
  const relative = arrivalLimit?.minimumAtoms ?? null;
  if (relative !== null && (relative <= 0n || relative >= 2n ** 256n))
    throw Error('EXECUTION_ARRIVAL_LIMIT');
  const arrivalIsStricter = relative !== null && (absolute === null || relative >= absolute);
  const priceFloor = arrivalIsStricter ? relative : absolute;
  const priceFloorError = arrivalIsStricter ? 'EXECUTION_ARRIVAL_LIMIT' : 'SWAP_PRICE_LIMIT';
  if (amountIn <= 0n) throw new Error('POSITIVE_AMOUNT_REQUIRED');
  const workflowDigest = createHash('sha256')
    .update(
      JSON.stringify({
        walletId: wallet.id,
        chainId: chain.id,
        side: input.side,
        amountIn: amountIn.toString(),
        slippage,
        fee,
        ...(priceFloor === null ? {} : { minimumAmountOutAtoms: String(priceFloor) }),
        ...(arrivalLimit ? { arrivalPool: arrivalLimit.pool } : {}),
        ...(agentScopeBinding
          ? { agentScope: { id: agentScopeBinding.id, subject: agentScopeBinding.subject } }
          : agentContext
            ? { agentSubject: agentContext.nodes.at(-1).subject }
            : {}),
      }),
    )
    .digest('hex');
  const previous = walletService.state.intents.find(
    (intent) => intent.commandId === commandId + ':swap',
  );
  if (previous) {
    if (previous.workflowDigest !== workflowDigest) throw new Error('WALLET_COMMAND_CONFLICT');
    return {
      complete: ['included', 'safe', 'finalized'].includes(previous.status),
      submitted: previous.status === 'submitted',
      resumed: true,
      steps: [walletService.publicIntent(previous)],
      note: 'This operation was already prepared. Reconcile its intent; do not issue another payment.',
    };
  }
  const context = {
    actor: 'agent',
    workspaceId,
    agentContext,
    agentScopeBinding,
    signal,
    workflowDigest,
    expectedPolicyId,
    execution,
    checkAuthority,
  };
  const rpc = (method, params) => {
    if (signal?.aborted) throw Error('WALLET_OPERATION_CANCELLED');
    checkAuthority?.();
    return market.rpc(config.venue, config.rpcUrl, method, params, { signal });
  };
  if (BigInt(await rpc('eth_chainId', [])) !== BigInt(chain.id))
    throw new Error('CHAIN_ID_MISMATCH');
  const tokenIn = buying ? chain.usdc : chain.weth,
    tokenOut = buying ? chain.weth : chain.usdc;
  const call = async (to, abi, name, args) =>
    abi.decodeFunctionResult(
      name,
      await rpc('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, 'latest']),
    );
  const [balance] = await call(tokenIn, erc20, 'balanceOf', [wallet.address]);
  if (balance < amountIn) throw new Error('WALLET_INSUFFICIENT_TOKEN_BALANCE');
  const [allowance] = await call(tokenIn, erc20, 'allowance', [wallet.address, deployment.router]);
  const steps = [];
  const factoryAbi = new Interface([
    'function getPool(address,address,uint24) view returns(address)',
  ]);
  const [canonicalPool] = await call(chain.factory, factoryAbi, 'getPool', [
    tokenIn,
    tokenOut,
    fee,
  ]);
  // Validate the intended deployment BEFORE requesting any token authorization.
  const initialPool = await market.base(config, { signal });
  if (
    canonicalPool.toLowerCase() !== initialPool.pool.toLowerCase() ||
    (arrivalLimit && arrivalLimit.pool !== canonicalPool.toLowerCase())
  )
    throw new Error('SWAP_POOL_NOT_CANONICAL');
  if (Date.now() - initialPool.time * 1000 > 30000) throw new Error('FRESH_MARKET_REQUIRED');
  if (windowEndsAt !== undefined && initialPool.time * 1000 >= windowEndsAt)
    throw Error('EXECUTION_WINDOW_EXPIRED');
  const quote = async () => {
    const [amount] = await call(deployment.quoter, quoteAbi, 'quoteExactInputSingle', [
      [tokenIn, tokenOut, amountIn, fee, 0],
    ]);
    if (amount <= 0n) throw new Error('SWAP_NO_QUOTE');
    if (priceFloor !== null && amount < priceFloor) throw Error(priceFloorError);
    if (priceFloor === null && (amount * BigInt(10000 - slippage)) / 10000n <= 0n)
      throw new Error('SWAP_AMOUNT_TOO_SMALL_FOR_PROTECTION');
    return amount;
  };
  const initialQuote = await quote();
  if (allowance < amountIn) {
    const approval = await walletService.transact(
      config,
      {
        walletId: wallet.id,
        commandId: commandId + ':approve',
        to: tokenIn,
        value: '0',
        data: erc20.encodeFunctionData('approve', [deployment.router, amountIn]),
        ...(windowEndsAt === undefined ? {} : { validUntil: windowEndsAt }),
      },
      context,
    );
    steps.push(approval);
    if (!approval.hash || !['submitted', 'included', 'safe', 'finalized'].includes(approval.status))
      return { complete: false, steps };
    const included = await walletService.waitForInclusion(approval.id, signal);
    if (!['included', 'safe', 'finalized'].includes(included.status))
      return {
        complete: false,
        steps: [included],
        next: 'Reconcile the approval before requesting another swap.',
      };
  }
  // Price/deadline are computed AFTER token approval, rather than reusing an old quote.
  const pool = allowance < amountIn ? await market.base(config, { signal }) : initialPool;
  if (Date.now() - pool.time * 1000 > 30000) throw new Error('FRESH_MARKET_REQUIRED');
  if (canonicalPool.toLowerCase() !== pool.pool.toLowerCase())
    throw new Error('SWAP_POOL_NOT_CANONICAL');
  let amountOut = initialQuote;
  if (allowance < amountIn) {
    try {
      amountOut = await quote();
    } catch (error) {
      if (error.message !== priceFloorError) throw error;
      return {
        complete: false,
        error: error.message,
        steps,
        note: 'The quote fell below the minimum after approval. The approval remains on chain.',
      };
    }
  }
  if (amountOut <= 0n) throw new Error('SWAP_NO_QUOTE');
  const slippageFloor = (amountOut * BigInt(10000 - slippage)) / 10000n;
  const minimum = priceFloor !== null && priceFloor > slippageFloor ? priceFloor : slippageFloor;
  if (minimum <= 0n) throw new Error('SWAP_AMOUNT_TOO_SMALL_FOR_PROTECTION');
  const deadline = Math.min(
    Math.floor(Date.now() / 1000) + 120,
    windowEndsAt === undefined ? Infinity : Math.floor((windowEndsAt - 1) / 1000),
  );
  if (windowEndsAt !== undefined && (Date.now() >= windowEndsAt || pool.time > deadline))
    throw Error('EXECUTION_WINDOW_EXPIRED');
  const swap = routerAbi.encodeFunctionData('exactInputSingle', [
    [tokenIn, tokenOut, fee, wallet.address, amountIn, minimum, 0],
  ]);
  const result = await walletService.transact(
    config,
    {
      walletId: wallet.id,
      commandId: commandId + ':swap',
      to: deployment.router,
      value: '0',
      data: routerAbi.encodeFunctionData('multicall', [deadline, [swap]]),
      validUntil:
        windowEndsAt === undefined
          ? deadline * 1000
          : Math.min(windowEndsAt, (deadline + 1) * 1000),
    },
    context,
  );
  steps.push(result);
  return {
    complete: ['included', 'safe', 'finalized'].includes(result.status),
    submitted: result.status === 'submitted',
    tokenIn,
    tokenOut,
    amountIn: input.amountIn,
    quotedAmountOut: formatUnits(amountOut, buying ? 18 : 6),
    minimumAmountOut: formatUnits(minimum, buying ? 18 : 6),
    slippageBps: slippage,
    deadline,
    steps,
    note: 'Submission is not a fill. Reconcile receipts and token balance changes. Existing ERC20 approvals survive application permission revocation.',
  };
}
module.exports = {
  executeBaseSwap,
  deployments,
  quoteAbi,
  routerAbi,
  minimumOutputAtoms,
  simulateBaseSwap,
};
