/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Explicit public-testnet acceptance. Never loads the user's normal wallets.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { spawnSync } = require('node:child_process'),
  { randomBytes } = require('node:crypto');
const { Interface, formatEther, formatUnits } = require('ethers');
const { WalletService } = require('../src/main/services/wallet');
const { MarketData, CHAINS } = require('../src/main/services/quant/market-data');
const { deployments } = require('../src/main/services/quant/base-swap');
const { writeAtomic } = require('../src/main/services/quant');
const directory = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'CIBYP-Testnet',
  'base-sepolia',
);
const markerFile = path.join(directory, 'test-profile.json'),
  credentialFile = path.join(directory, 'password.dpapi.json');
const venue = 'base-sepolia',
  chain = CHAINS[venue],
  market = new MarketData();
const rpc = (method, params = []) => market.rpc(venue, undefined, method, params);
function dpapi(text, decrypt = false) {
  if (process.platform !== 'win32')
    throw Error('This local acceptance profile requires Windows DPAPI');
  const command = decrypt
    ? "$taskCipher=[Console]::In.ReadToEnd();$taskSecure=ConvertTo-SecureString -String $taskCipher;[Console]::Out.Write(([System.Net.NetworkCredential]::new('', $taskSecure)).Password)"
    : '$taskPlain=[Console]::In.ReadToEnd();$taskSecure=ConvertTo-SecureString -String $taskPlain -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString -SecureString $taskSecure))';
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      input: text,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 65536,
      env: {
        ...process.env,
        PSModulePath: path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'Modules',
        ),
      },
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) throw Error('TESTNET_DPAPI_UNAVAILABLE');
  return result.stdout.trim();
}
async function identity() {
  const id = await rpc('eth_chainId');
  if (BigInt(id) !== 84532n) throw Error('TESTNET_CHAIN_MISMATCH');
  return rpc('eth_getBlockByNumber', ['latest', false]);
}
function marker() {
  const value = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (value.chainId !== 84532 || value.testnetOnly !== true || typeof value.walletId !== 'string')
    throw Error('INVALID_TESTNET_PROFILE');
  return value;
}
async function initialize() {
  await identity();
  if (fs.existsSync(markerFile)) return inspect();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const wallet = new WalletService({ directory: path.join(directory, 'wallet') });
  try {
    if ((await wallet.request('list')).wallets.length) throw Error('UNRECOGNIZED_TESTNET_PROFILE');
    let password;
    if (fs.existsSync(credentialFile)) {
      const saved = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
      password = dpapi(saved.ciphertext, true);
    } else {
      password = randomBytes(32).toString('base64url');
      writeAtomic(credentialFile, {
        version: 1,
        provider: 'windows-dpapi-current-user',
        ciphertext: dpapi(password),
      });
    }
    const { id, address } = await wallet.request('create', {
      name: 'CIBYP Base Sepolia acceptance · TESTNET ONLY',
      password,
    });
    password = '';
    writeAtomic(markerFile, {
      version: 1,
      testnetOnly: true,
      chainId: 84532,
      walletId: id,
      address,
      createdAt: new Date().toISOString(),
    });
  } finally {
    wallet.dispose();
  }
  return inspect();
}
async function inspect() {
  const target = marker(),
    block = await identity();
  const erc20 = new Interface(['function balanceOf(address) view returns(uint256)']);
  const tokenBalance = async (token) =>
    erc20.decodeFunctionResult(
      'balanceOf',
      await rpc('eth_call', [
        { to: token, data: erc20.encodeFunctionData('balanceOf', [target.address]) },
        'latest',
      ]),
    )[0];
  const [eth, usdc, weth] = await Promise.all([
    rpc('eth_getBalance', [target.address, 'latest']),
    tokenBalance(chain.usdc),
    tokenBalance(chain.weth),
  ]);
  return {
    testnetOnly: true,
    chainId: 84532,
    profile: directory,
    address: target.address,
    explorer: chain.explorer + '/address/' + target.address,
    observedAt: new Date().toISOString(),
    block: block.number,
    blockHash: block.hash,
    balances: {
      ETH: formatEther(BigInt(eth)),
      USDC: formatUnits(usdc, 6),
      WETH: formatUnits(weth, 18),
    },
    contracts: {
      factory: chain.factory,
      ...deployments[venue],
      USDC: chain.usdc,
      WETH: chain.weth,
    },
  };
}
async function main() {
  const action = process.argv[2] || 'inspect';
  const result =
    action === 'init' ? await initialize() : action === 'inspect' ? await inspect() : null;
  if (!result) throw Error('Use init or inspect');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { directory, marker, identity, inspect, dpapi, credentialFile };
