/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Interface, ZeroAddress, MaxUint256 } = require('ethers');

// Uniswap's published Base and Base Sepolia deployments.
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const MAX_ORDERED_NONCE = (1n << 48n) - 1n;
const permit2 = new Interface([
  'function allowance(address owner,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)',
  'function lockdown((address token,address spender)[] approvals)',
  'function invalidateNonces(address token,address spender,uint48 newNonce)',
  'function nonceBitmap(address owner,uint256 wordPos) view returns(uint256)',
  'function invalidateUnorderedNonces(uint256 wordPos,uint256 mask)',
  'event Approval(address indexed owner,address indexed token,address indexed spender,uint160 amount,uint48 expiration)',
  'event Permit(address indexed owner,address indexed token,address indexed spender,uint160 amount,uint48 expiration,uint48 nonce)',
  'event Lockdown(address indexed owner,address token,address spender)',
]);
const permit2Topics = ['Approval', 'Permit', 'Lockdown'].map(
  (name) => permit2.getEvent(name).topicHash,
);

function usesPermit2(protocol) {
  if (protocol === undefined || protocol === 'erc20') return false;
  if (protocol === 'permit2') return true;
  throw new Error('WALLET_ALLOWANCE_PROTOCOL');
}

function isPermit2(to, chainId) {
  return [8453, 84532].includes(chainId) && to.toLowerCase() === PERMIT2.toLowerCase();
}

const orderedSelector = permit2.getFunction('invalidateNonces').selector;
const unorderedSelector = permit2.getFunction('invalidateUnorderedNonces').selector;
function nonceMaintenance(to, data, chainId) {
  return (
    isPermit2(to, chainId) &&
    [orderedSelector, unorderedSelector].includes(data.slice(0, 10).toLowerCase())
  );
}

function nonceValue(input, max = MaxUint256) {
  if (typeof input !== 'string' || !/^(?:0|[1-9]\d{0,77}|0x[\da-f]{1,64})$/i.test(input))
    throw new Error('WALLET_PERMIT2_NONCE_INVALID');
  const value = BigInt(input);
  if (value > max) throw new Error('WALLET_PERMIT2_NONCE_INVALID');
  return value;
}

function unorderedNonce(input) {
  const nonce = nonceValue(input);
  return { nonce, wordPos: nonce >> 8n, mask: 1n << (nonce & 255n) };
}

function describePermit2(to, data, value, chainId) {
  if (!isPermit2(to, chainId) || value !== 0n) return null;
  try {
    const selector = data.slice(0, 10).toLowerCase();
    const method =
      selector === orderedSelector
        ? 'invalidateNonces'
        : selector === unorderedSelector
          ? 'invalidateUnorderedNonces'
          : 'lockdown';
    if (
      data.length !==
      { lockdown: 266, invalidateNonces: 202, invalidateUnorderedNonces: 138 }[method]
    )
      return null;
    const args = permit2.decodeFunctionData(method, data);
    if (permit2.encodeFunctionData(method, args) !== data.toLowerCase()) return null;
    if (method === 'invalidateUnorderedNonces') {
      const [wordPos, mask] = args;
      if (wordPos >> 248n || mask === 0n || mask & (mask - 1n)) return null;
      const bit = BigInt(mask.toString(2).length - 1);
      return {
        kind: 'permit2-signature-invalidate',
        contract: to,
        permitNonce: String((wordPos << 8n) | bit),
      };
    }
    if (method === 'lockdown' && args[0].length !== 1) return null;
    const [token, spender, nextNonce] = method === 'lockdown' ? args[0][0] : args;
    if (token === ZeroAddress || spender === ZeroAddress) return null;
    const pair = { contract: to, tokenContract: token, recipient: spender };
    return method === 'lockdown'
      ? { ...pair, kind: 'permit2-lockdown', rawTokenAmount: '0' }
      : nextNonce > 0n
        ? { ...pair, kind: 'permit2-allowance-invalidate', nextNonce: String(nextNonce) }
        : null;
  } catch {
    return null;
  }
}

module.exports = {
  PERMIT2,
  MAX_ORDERED_NONCE,
  permit2,
  permit2Topics,
  usesPermit2,
  nonceValue,
  unorderedNonce,
  nonceMaintenance,
  describePermit2,
};
