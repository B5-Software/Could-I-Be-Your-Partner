/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Interface, getAddress, keccak256, parseEther } = require('ethers');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RESULT_BYTES = 2 * 1024 * 1024;
function resultDirectory(service) {
  const directory = path.join(service.directory, 'contract-results');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CONTRACT_ARCHIVE_UNAVAILABLE');
  return directory;
}
function storeResult(service, result, writeAtomic) {
  const directory = resultDirectory(service),
    ref = digest(result);
  if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES) fail('CONTRACT_RESULT_LIMIT');
  const files = fs.readdirSync(directory).filter((name) => /^[a-f\d]{64}\.json$/.test(name));
  let bytes = 0;
  for (const name of files) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RESULT_BYTES)
      fail('CONTRACT_ARCHIVE_UNAVAILABLE');
    bytes += stat.size;
  }
  if (files.length >= 512 || bytes + Buffer.byteLength(JSON.stringify(result)) > 128 * 1024 * 1024)
    fail('CONTRACT_ARCHIVE_LIMIT');
  writeAtomic(path.join(directory, ref + '.json'), result);
  return ref;
}
function loadResult(service, workspaceId, ref) {
  if (typeof ref !== 'string' || !/^[a-f\d]{64}$/.test(ref)) fail('CONTRACT_RESULT_REF');
  const file = path.join(resultDirectory(service), ref + '.json');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    fail(error.code === 'ENOENT' ? 'CONTRACT_RESULT_NOT_FOUND' : 'CONTRACT_ARCHIVE_UNAVAILABLE');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RESULT_BYTES)
    fail('CONTRACT_ARCHIVE_UNAVAILABLE');
  let result;
  try {
    result = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail('CONTRACT_RESULT_FORMAT');
  }
  if (digest(result) !== ref) fail('CONTRACT_RESULT_HASH_MISMATCH');
  if (result.version !== 1 || typeof result.text !== 'string') fail('CONTRACT_RESULT_FORMAT');
  if (result.workspaceId !== workspaceId) fail('CONTRACT_RESULT_NOT_IN_WORKSPACE');
  return result;
}
function resultPage(result, ref, input) {
  const { text, workspaceId: _workspaceId, version: _version, ...metadata } = result;
  return { ...metadata, ref, ...page(text, input) };
}
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
async function contractRequest(service, workspaceId, input, writeAtomic, options = {}) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  const check = () => {
    signal.throwIfAborted();
    if (service.disposed) fail('QUANT_STOPPED');
  };
  check();
  page('', input);
  service.workspace(workspaceId);
  if (input.action === 'result')
    return resultPage(loadResult(service, workspaceId, input.ref), input.ref, input);
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
  const { market, config, chain } = service.evmContext(workspaceId, input.chainId);
  if (!chain) fail('CONTRACT_NETWORK_UNAVAILABLE');
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
  if (
    typeof block !== 'string' ||
    (!['latest', 'safe', 'finalized'].includes(block) && !/^0x[\da-f]{1,16}$/i.test(block))
  )
    fail('CONTRACT_BLOCK');
  const context = await market.connect(config, { signal });
  check();
  const selected =
    block === 'latest' ? context.block : await context.rpc('eth_getBlockByNumber', [block, false]);
  if (
    !selected ||
    !/^0x[\da-f]{64}$/i.test(selected.hash || '') ||
    !/^0x[\da-f]{1,64}$/i.test(selected.number || '') ||
    !/^0x[\da-f]{1,64}$/i.test(selected.timestamp || '') ||
    BigInt(selected.number) > context.height ||
    (block.startsWith('0x') && BigInt(selected.number) !== BigInt(block))
  )
    fail('CONTRACT_BLOCK');
  if (BigInt(selected.timestamp) > BigInt(Math.floor(Date.now() / 1000) + 120))
    fail('BLOCK_CLOCK_SKEW');
  const call = { to, data };
  if (input.from) call.from = getAddress(input.from);
  if (input.action === 'simulate' && input.value !== undefined) {
    const value = parseEther(input.value);
    if (value < 0n) fail('CONTRACT_VALUE');
    call.value = '0x' + value.toString(16);
  }
  const raw = await context.rpc('eth_call', [
    call,
    { blockHash: selected.hash, requireCanonical: true },
  ]);
  check();
  const canonical = await context.rpc('eth_getBlockByNumber', [selected.number, false]);
  check();
  if (canonical?.hash?.toLowerCase() !== selected.hash.toLowerCase()) fail('BLOCK_REORG');
  if (
    chain.revision !== undefined &&
    service.getWallet().networks.profile(config.venue).revision !== chain.revision
  )
    fail('WALLET_NETWORK_CHANGED');
  const decoded = abi.decodeFunctionResult(fragment, raw);
  let decodedBytes = 0;
  const text = JSON.stringify([...decoded], (_key, value) => {
    if (typeof value === 'bigint') value = value.toString();
    if (typeof value === 'string') {
      decodedBytes += Buffer.byteLength(value);
      if (decodedBytes > RESULT_BYTES) fail('CONTRACT_RESULT_LIMIT');
    }
    return value;
  });
  const result = {
    version: 1,
    workspaceId,
    chainId: chain.id,
    to,
    function: fragment.format('sighash'),
    dataHash: keccak256(data),
    abiVerified: false,
    from: call.from ?? null,
    valueWei: call.value ? BigInt(call.value).toString() : '0',
    block,
    blockNumber: BigInt(selected.number).toString(),
    blockHash: selected.hash,
    blockTimestamp: Number(BigInt(selected.timestamp)),
    observedAt: Date.now(),
    ...(chain.genesisHash ? { genesisHash: chain.genesisHash } : {}),
    readOnly: true,
    simulated: input.action === 'simulate',
    text,
  };
  check();
  return resultPage(result, storeResult(service, result, writeAtomic), input);
}
module.exports = { contractRequest, loadCall, page };
