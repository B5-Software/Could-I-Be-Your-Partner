/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Interface, getAddress, keccak256, parseEther } = require('ethers');
const { CHAINS } = require('./market-data');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code) {
  throw new Error(code);
}
function page(text, input) {
  const offset = input.offset ?? 0,
    maximum = input.maxChars ?? 6000;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(maximum) ||
    maximum < 0 ||
    maximum > 200000
  )
    fail('CONTRACT_READ_RANGE');
  const length = maximum === 0 ? text.length : maximum;
  return {
    text: text.slice(offset, offset + length),
    totalChars: text.length,
    offset,
    nextOffset: offset + length < text.length ? offset + length : null,
  };
}
function loadCall(service, workspaceId, callId) {
  if (!/^[a-f\d]{64}$/.test(String(callId))) fail('CONTRACT_CALL_ID');
  const call = JSON.parse(
    fs.readFileSync(path.join(service.directory, 'contract-calls', callId + '.json'), 'utf8'),
  );
  if (digest(call) !== callId) fail('CONTRACT_CALL_HASH_MISMATCH');
  if (call.workspaceId !== workspaceId) fail('CONTRACT_CALL_NOT_IN_WORKSPACE');
  return call;
}
async function contractRequest(service, workspaceId, input, writeAtomic) {
  const workspace = service.workspace(workspaceId),
    chain = CHAINS[workspace.market.venue];
  if (!chain) fail('CONTRACT_NETWORK_UNAVAILABLE');
  if (input.action === 'get') {
    const call = loadCall(service, workspaceId, input.callId);
    return {
      callId: input.callId,
      chainId: call.chainId,
      to: call.to,
      function: call.function,
      dataHash: keccak256(call.data),
      dataBytes: (call.data.length - 2) / 2,
      ...page(call.data, input),
    };
  }
  if (!['read', 'simulate', 'encode'].includes(input.action)) fail('CONTRACT_ACTION');
  if (
    !Array.isArray(input.abi) ||
    !input.abi.length ||
    input.abi.length > 12 ||
    input.abi.some(
      (line) => typeof line !== 'string' || !line.startsWith('function ') || line.length > 1024,
    )
  )
    fail('CONTRACT_FUNCTION_ABI_REQUIRED');
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || Buffer.byteLength(JSON.stringify(args)) > 32768)
    fail('CONTRACT_ARGUMENTS_LIMIT');
  if (typeof input.function !== 'string' || input.function.length > 200)
    fail('CONTRACT_FUNCTION_REQUIRED');
  const abi = new Interface(input.abi),
    fragment = abi.getFunction(input.function);
  if (!fragment) fail('CONTRACT_FUNCTION_NOT_FOUND');
  const to = getAddress(input.to),
    data = abi.encodeFunctionData(fragment, args);
  if (input.action === 'encode') {
    const call = {
      version: 1,
      workspaceId,
      chainId: chain.id,
      to,
      data,
      function: fragment.format('sighash'),
      mutability: fragment.stateMutability,
      abi: input.abi,
      abiVerified: false,
    };
    const callId = digest(call);
    writeAtomic(path.join(service.directory, 'contract-calls', callId + '.json'), call);
    return {
      callId,
      chainId: chain.id,
      to,
      function: call.function,
      abiVerified: false,
      dataHash: keccak256(data),
      dataBytes: (data.length - 2) / 2,
      note: 'Encoded only; no signature or broadcast. Pass callId to quant_live_transaction. ABI labels are supplied, not verified contract identity.',
    };
  }
  if (input.action === 'read' && !['view', 'pure'].includes(fragment.stateMutability))
    fail('CONTRACT_VIEW_REQUIRED');
  const block = input.block ?? 'latest';
  if (!['latest', 'safe', 'finalized'].includes(block) && !/^0x[\da-f]{1,16}$/i.test(block))
    fail('CONTRACT_BLOCK');
  const rpc = (method, params) =>
    service.market.rpc(workspace.market.venue, workspace.market.rpcUrl, method, params);
  if (BigInt(await rpc('eth_chainId', [])) !== BigInt(chain.id)) fail('CHAIN_ID_MISMATCH');
  const call = { to, data };
  if (input.from) call.from = getAddress(input.from);
  if (input.action === 'simulate' && input.value !== undefined) {
    const value = parseEther(input.value);
    if (value < 0n) fail('CONTRACT_VALUE');
    call.value = '0x' + value.toString(16);
  }
  const raw = await rpc('eth_call', [call, block]);
  const decoded = abi.decodeFunctionResult(fragment, raw);
  const text = JSON.stringify([...decoded], (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  return {
    chainId: chain.id,
    to,
    function: fragment.format('sighash'),
    block,
    readOnly: true,
    simulated: input.action === 'simulate',
    ...page(text, input),
  };
}
module.exports = { contractRequest, loadCall, page };
