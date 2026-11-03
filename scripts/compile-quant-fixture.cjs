/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Optional reproduction only. CI/runtime consume the source-hashed artifact.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const solc = require(path.join(root, '.cache/quant-solc/node_modules/solc'));
if (!solc.version().startsWith('0.8.30+')) throw Error('Pinned solc 0.8.30 required');
const file = path.join(root, 'tests/fixtures/quant/ExecutionFixture.sol'),
  source = fs.readFileSync(file, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'ExecutionFixture.sol': { content: source } },
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: false },
    metadata: { appendCBOR: false },
    outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } },
  },
};
const result = JSON.parse(solc.compile(JSON.stringify(input)));
if (result.errors?.some((error) => error.severity === 'error'))
  throw Error(result.errors.map((e) => e.formattedMessage).join('\n'));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const contracts = Object.fromEntries(
  Object.entries(result.contracts['ExecutionFixture.sol']).map(([name, value]) => {
    const runtime = '0x' + value.evm.deployedBytecode.object;
    return [name, { abi: value.abi, runtime, sha256: sha(Buffer.from(runtime.slice(2), 'hex')) }];
  }),
);
fs.writeFileSync(
  file.replace('.sol', '.json'),
  JSON.stringify(
    {
      compiler: solc.version(),
      sourceSha256: sha(source),
      evmVersion: 'paris',
      optimizer: false,
      contracts,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  '[quant-fixture] Rebuilt pinned local-chain fixtures; never deploy these contracts with real assets',
);
