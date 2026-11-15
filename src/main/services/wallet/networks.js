/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseEther, formatEther } = require('ethers');
const { MarketData, CHAINS, endpoint } = require('../quant/market-data');
const { validEvmChainId: validChainId } = require('../../../shared/wallet-chain');
const fail = (code) => {
  throw Error(code);
};
const copy = (value) => structuredClone(value);
class WalletNetworks {
  constructor(wallet, write, fetcher) {
    this.wallet = wallet;
    this.write = write;
    this.fetcher = fetcher;
    this.file = path.join(wallet.directory, 'networks.json');
    this.challenges = new Map();
    this.profiles = new Map(
      Object.entries(CHAINS).map(([key, chain]) => [
        key,
        {
          ...chain,
          key,
          builtin: true,
          revision: 1,
          nativeSymbol: 'ETH',
          nativeDecimals: 18,
          feeModel: 'op-stack',
          additionalFeeNative: '0',
          supportsType2: true,
          genesisHash: null,
          archived: false,
        },
      ]),
    );
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw Error();
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 18)
        throw Error();
      const seen = new Set();
      for (const profile of value.profiles) {
        const normalized = this.normalize(profile);
        if (
          profile.key !== normalized.key ||
          !Number.isSafeInteger(profile.revision) ||
          profile.revision < 1 ||
          profile.revision > 1000000000 ||
          typeof profile.archived !== 'boolean' ||
          typeof profile.supportsType2 !== 'boolean' ||
          !/^0x[\da-f]{64}$/i.test(profile.genesisHash || '') ||
          seen.has(profile.key) ||
          [...this.profiles.values()].some((p) => p.id === profile.id && p.key !== profile.key)
        )
          throw Error();
        seen.add(profile.key);
        this.profiles.set(profile.key, {
          ...normalized,
          revision: profile.revision,
          archived: profile.archived,
          supportsType2: profile.supportsType2,
          genesisHash: profile.genesisHash,
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') fail('WALLET_NETWORK_STORE_CORRUPT');
    }
  }
  normalize(input) {
    if (
      !input ||
      !validChainId(input.id) ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 80 ||
      /[\x00-\x1f\x7f]/.test(input.name) ||
      typeof input.nativeSymbol !== 'string' ||
      !/^[A-Za-z][A-Za-z\d]{0,11}$/.test(input.nativeSymbol) ||
      typeof input.rpc !== 'string' ||
      input.rpc.length > 2048
    )
      fail('WALLET_NETWORK_INVALID');
    let rpc, additionalFeeNative;
    try {
      rpc = endpoint(input.rpc);
      const fee = input.additionalFeeNative ?? '0';
      if (typeof fee !== 'string' || !/^\d{1,16}(?:\.\d{1,18})?$/.test(fee)) throw Error();
      additionalFeeNative = formatEther(parseEther(fee));
    } catch {
      fail('WALLET_NETWORK_INVALID');
    }
    if (input.nativeDecimals !== undefined && input.nativeDecimals !== 18)
      fail('WALLET_NETWORK_DECIMALS');
    const known = Object.entries(CHAINS).find(([, p]) => p.id === input.id);
    if (known && input.nativeSymbol !== 'ETH') fail('WALLET_NETWORK_INVALID');
    return {
      ...(known ? known[1] : {}),
      key: known ? known[0] : 'evm-' + input.id,
      id: input.id,
      name: known ? known[1].name : input.name.trim(),
      rpc,
      nativeSymbol: input.nativeSymbol,
      nativeDecimals: 18,
      feeModel: known ? 'op-stack' : 'eip1559',
      additionalFeeNative,
      builtin: !!known,
    };
  }
  profile(key, active = false) {
    const profile = this.profiles.get(key);
    if (!profile || (active && profile.archived)) fail('WALLET_CHAIN_UNAVAILABLE');
    return copy(profile);
  }
  has(key) {
    return this.profiles.has(key);
  }
  byId(id, active = false) {
    if (!validChainId(id)) fail('WALLET_CHAIN_UNAVAILABLE');
    const found = [...this.profiles.values()].find((p) => p.id === id);
    if (!found) fail('WALLET_CHAIN_UNAVAILABLE');
    return this.profile(found.key, active);
  }
  assert(key, revision) {
    const profile = this.profile(key, true);
    if (revision !== undefined && profile.revision !== revision) fail('WALLET_NETWORK_CHANGED');
    return profile;
  }
  public(profile) {
    const { rpc, ...safe } = copy(profile);
    return {
      ...safe,
      rpcOrigin: new URL(rpc).origin,
      capabilities: {
        observe: true,
        erc20: true,
        signType2: profile.supportsType2 && !profile.archived,
        broadcast: profile.supportsType2 && !profile.archived,
        autonomous: profile.supportsType2 && !profile.archived,
        permit2: profile.builtin,
        swap: profile.builtin,
      },
    };
  }
  list() {
    return { items: [...this.profiles.values()].map((p) => this.public(p)) };
  }
  async probe(input, { signal } = {}) {
    const normalized = this.normalize(input);
    const market = new MarketData(this.fetcher, (key) =>
      key === normalized.key ? normalized : null,
    );
    const context = await market.connect(
      { venue: normalized.key },
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      },
    );
    const genesis = await context.rpc('eth_getBlockByNumber', ['0x0', false]);
    if (!/^0x[\da-f]{64}$/i.test(genesis?.hash || '') || !/^0x0$/i.test(genesis?.number || ''))
      fail('WALLET_NETWORK_INVALID');
    const existing = [...this.profiles.values()].find((p) => p.id === normalized.id);
    if (existing?.genesisHash && existing.genesisHash.toLowerCase() !== genesis.hash.toLowerCase())
      fail('WALLET_NETWORK_GENESIS');
    const supportsType2 =
      typeof context.block.baseFeePerGas === 'string' &&
      /^0x[\da-f]{1,64}$/i.test(context.block.baseFeePerGas);
    return {
      ...normalized,
      genesisHash: genesis.hash.toLowerCase(),
      supportsType2,
      archived: false,
      revision: existing?.revision ?? 0,
      block: String(context.height),
    };
  }
  persist(next) {
    this.write(this.file, {
      version: 1,
      profiles: [...next.values()].filter((p) => !p.builtin || p.revision > 1),
    });
    this.profiles = next;
  }
  save(probed) {
    if (this.wallet.disposed) fail('WALLET_STOPPED');
    const old = this.profiles.get(probed.key);
    if ((old?.revision ?? 0) !== probed.revision) fail('WALLET_NETWORK_CHANGED');
    if ((old?.revision ?? 0) >= 1000000000) fail('WALLET_NETWORK_LIMIT');
    if (!old && this.profiles.size - Object.keys(CHAINS).length >= 16) fail('WALLET_NETWORK_LIMIT');
    const { block: _block, ...profile } = probed;
    profile.revision++;
    const next = new Map(this.profiles);
    next.set(profile.key, profile);
    this.persist(next);
    for (const operation of this.wallet.inFlight.values())
      if (operation.network === profile.key)
        operation.controller.abort(Error('WALLET_NETWORK_CHANGED'));
    this.wallet.emit();
    return this.public(profile);
  }
  async request(action, input = {}) {
    if (this.wallet.disposed) fail('WALLET_STOPPED');
    if (action === 'list') return this.list();
    if (action === 'config') {
      const profile = this.profile(input.key);
      return profile;
    }
    if (action === 'probe') return this.public(await this.probe(input));
    if (action === 'challenge') {
      for (const [id, c] of this.challenges)
        if (c.expiresAt <= Date.now()) this.challenges.delete(id);
      if (this.challenges.size >= 50) fail('WALLET_NETWORK_LIMIT');
      const profile = await this.probe(input);
      if (this.wallet.disposed) fail('WALLET_STOPPED');
      const existing = this.profiles.get(profile.key);
      if (input.revision !== undefined && input.revision !== (existing?.revision ?? 0))
        fail('WALLET_NETWORK_CHANGED');
      if (!existing && this.profiles.size - Object.keys(CHAINS).length >= 16)
        fail('WALLET_NETWORK_LIMIT');
      const challenge = { id: randomUUID(), profile, expiresAt: Date.now() + 120000 };
      this.challenges.set(challenge.id, challenge);
      return { id: challenge.id, profile: this.public(profile), expiresAt: challenge.expiresAt };
    }
    if (action === 'confirm') {
      const challenge = this.challenges.get(input.challengeId);
      this.challenges.delete(input.challengeId);
      if (
        !challenge ||
        challenge.expiresAt <= Date.now() ||
        input.confirmed !== true ||
        input.ack !== 'SAVE NETWORK'
      )
        fail('WALLET_CONFIRMATION_REQUIRED');
      return this.save(challenge.profile);
    }
    if (action === 'archive') {
      const profile = this.profile(input.key);
      if (profile.builtin) fail('WALLET_NETWORK_BUILTIN');
      if (input.revision !== profile.revision) fail('WALLET_NETWORK_CHANGED');
      if (profile.revision >= 1000000000) fail('WALLET_NETWORK_LIMIT');
      const next = new Map(this.profiles);
      next.set(profile.key, { ...profile, archived: true, revision: profile.revision + 1 });
      this.persist(next);
      for (const operation of this.wallet.inFlight.values())
        if (operation.network === profile.key)
          operation.controller.abort(Error('WALLET_NETWORK_CHANGED'));
      this.wallet.emit();
      return this.public(this.profile(profile.key));
    }
    fail('UNKNOWN_WALLET_ACTION');
  }
}
module.exports = { WalletNetworks, validChainId };
