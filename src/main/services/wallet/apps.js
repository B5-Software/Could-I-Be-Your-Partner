/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { getAddress, formatEther } = require('ethers');
const fail = (code, message) => {
  throw Object.assign(Error(message), { code });
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originOf = (value) => {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.origin === 'null' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    fail(4100, 'A secure, host-verified site origin is required');
  return url.origin;
};
const quantity = (value) => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value))
    fail(-32602, 'Invalid hexadecimal quantity');
  return BigInt(value);
};
const READS = new Set([
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByNumber',
]);
const MESSAGE_SIGNS = new Set(['personal_sign', 'eth_signTypedData_v4', 'eth_signTypedData']);
const scopeKey = (c) => (c.clientId ? c.clientId + ':' + c.origin : c.origin);
const displayName = (value) =>
  typeof value === 'string' &&
  value.length <= 80 &&
  value.trim() &&
  !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
function siteUrls(values, required = false) {
  if (values === undefined && !required) return [];
  if (!Array.isArray(values) || values.length > 8 || (required && !values.length))
    fail(-32602, 'Expected a list of HTTPS URLs');
  return values.map((v) => {
    if (typeof v !== 'string' || v.length > 2048 || /\s/.test(v)) fail(-32602, 'Invalid HTTPS URL');
    let url;
    try {
      url = new URL(v);
    } catch {
      fail(-32602, 'Invalid HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      fail(-32602, 'Only credential-free HTTPS URLs are accepted in site proposals');
    return url.origin;
  });
}
class WalletApps {
  constructor(wallet, write) {
    this.wallet = wallet;
    this.write = write;
    this.file = path.join(wallet.directory, 'app-connections.json');
    this.connections = new Map();
    this.sessions = new Map();
    this.pending = new Map();
    this.activeRequests = 0;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw Error();
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 128)
        throw Error();
      for (const c of data.items) {
        if (
          originOf(c.origin) !== c.origin ||
          this.connections.has(scopeKey(c)) ||
          (c.clientId !== undefined && !/^[\da-f-]{36}$/.test(c.clientId)) ||
          !/^[\da-f-]{36}$/.test(c.id) ||
          !Number.isSafeInteger(c.revision) ||
          c.revision < 1 ||
          !Number.isSafeInteger(c.expiresAt) ||
          c.expiresAt < 0 ||
          typeof c.walletId !== 'string' ||
          !/^[\da-f-]{36}$/.test(c.walletId) ||
          !wallet.networks.has(c.chain)
        )
          throw Error();
        this.connections.set(scopeKey(c), c);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('WALLET_APP_STORE_CORRUPT');
    }
  }
  list() {
    return {
      connections: [...this.connections.values()].map((c) => ({
        ...c,
        expired: c.expiresAt <= Date.now(),
      })),
      pending: [...this.pending.values()].map((p) => ({
        id: p.id,
        origin: p.origin,
        clientId: p.clientId,
        clientName: p.clientName,
        extensionOrigin: p.extensionOrigin,
        desiredChain: p.desiredChain,
        walletId: p.previous?.walletId,
        network: p.network ? structuredClone(p.network) : undefined,
        expiresAt: p.expiresAt,
      })),
    };
  }
  persist(next) {
    this.write(this.file, { version: 1, items: [...next.values()] });
    this.connections = next;
  }
  // Only a trusted host adapter calls this method; no JSON/RPC action creates a session.
  createSession({ url, valid = () => false, id, source }) {
    const origin = originOf(url);
    if (id !== undefined && (!/^[\w:-]{1,64}$/.test(id) || this.sessions.has(id)))
      fail(4900, 'Wallet document identity is already active');
    if (
      source &&
      (!/^[\da-f-]{36}$/.test(source.clientId) ||
        typeof source.clientName !== 'string' ||
        source.clientName.length > 80)
    )
      fail(4100, 'Invalid browser identity');
    if (this.sessions.size >= 64) fail(4900, 'Too many wallet browser sessions');
    const s = {
      id: id ?? randomUUID(),
      origin,
      ...(source
        ? {
            clientId: source.clientId,
            clientName: source.clientName,
            extensionOrigin: source.extensionOrigin,
          }
        : {}),
      valid,
      closed: false,
      operations: new Map(),
      controllers: new Set(),
    };
    this.sessions.set(s.id, s);
    return Object.freeze({
      request: (input) => this.request(s, input),
      snapshot: () => this.snapshot(s),
      close: () => this.close(s),
    });
  }
  assert(s) {
    if (s.closed || this.wallet.disposed || this.sessions.get(s.id) !== s || s.valid() !== true)
      fail(4900, 'Wallet browser document is disconnected');
  }
  grant(s) {
    this.assert(s);
    const c = this.connections.get(scopeKey(s));
    if (!c || c.expiresAt <= Date.now()) fail(4100, 'Connect this site in the wallet first');
    this.wallet.wallet(c.walletId);
    return c;
  }
  connection(s) {
    const c = this.grant(s);
    this.wallet.networks.profile(c.chain, true);
    return c;
  }
  snapshot(s) {
    this.assert(s);
    const configured = this.connections.get(scopeKey(s))?.chain ?? s.lastChain ?? 'base';
    if (this.wallet.networks.has(configured)) s.lastChain = configured;
    const chainId = '0x' + this.wallet.networks.profile(s.lastChain ?? 'base').id.toString(16);
    try {
      const c = this.connection(s),
        p = this.wallet.networks.profile(c.chain);
      return {
        accounts: [this.wallet.wallet(c.walletId).address],
        chainId: '0x' + p.id.toString(16),
      };
    } catch {
      return { accounts: [], chainId };
    }
  }
  close(s) {
    s.closed = true;
    if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
    for (const controller of s.controllers) controller.abort(Error('WALLET_APP_DISCONNECTED'));
    for (const [id, p] of this.pending)
      if (p.session === s) this.finish(id, null, 4001, 'The requesting document closed');
  }
  finish(id, result, code, message) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.controller.abort(Error('WALLET_APP_CHANGED'));
    code ? p.reject(Object.assign(Error(message), { code })) : p.resolve(result);
    this.wallet.emit();
  }
  async ask(s, details = {}) {
    this.assert(s);
    if (this.pending.size >= 32 || [...this.pending.values()].some((p) => p.session === s))
      fail(-32002, 'A connection request is already pending');
    return new Promise((resolve, reject) => {
      const id = randomUUID(),
        expiresAt = Date.now() + 120000;
      const timer = setTimeout(
        () => this.finish(id, null, 4001, 'Wallet connection request expired'),
        120000,
      );
      timer.unref?.();
      this.pending.set(id, {
        id,
        origin: s.origin,
        ...(s.clientId
          ? { clientId: s.clientId, clientName: s.clientName, extensionOrigin: s.extensionOrigin }
          : {}),
        ...details,
        expiresAt,
        session: s,
        resolve,
        reject,
        timer,
        controller: new AbortController(),
      });
      this.wallet.emit();
    });
  }
  async requestNetwork(s, params) {
    const value = params[0];
    if (params.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value))
      fail(-32602, 'Invalid network proposal');
    const id = quantity(value.chainId);
    if (id === 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) fail(-32602, 'Unsupported chain ID');
    const rpcOrigins = [...new Set(siteUrls(value.rpcUrls, true))];
    siteUrls(value.blockExplorerUrls);
    if (siteUrls(value.iconUrls).length) fail(4200, 'Network icon downloads are not supported');
    const currency = value.nativeCurrency;
    if (
      (value.chainName !== undefined && !displayName(value.chainName)) ||
      (currency !== undefined &&
        (!currency ||
          !displayName(currency.name) ||
          typeof currency.symbol !== 'string' ||
          !/^[A-Za-z][A-Za-z\d]{0,11}$/.test(currency.symbol) ||
          currency.decimals !== 18))
    )
      fail(-32602, 'Invalid name or unsupported native currency');
    let known;
    try {
      known = this.wallet.networks.byId(Number(id));
    } catch (e) {
      if (e.message !== 'WALLET_CHAIN_UNAVAILABLE') throw e;
    }
    if (known) {
      if (known.archived) fail(4902, 'The configured chain is disabled');
      if (currency && currency.symbol !== known.nativeSymbol)
        fail(-32602, 'Native currency differs from the configured chain');
      return null;
    }
    if (!currency || !value.chainName)
      fail(-32602, 'A new chain needs a name and an 18-decimal native currency');
    await this.ask(s, {
      network: {
        id: Number(id),
        name: value.chainName.trim(),
        nativeSymbol: currency.symbol,
        rpcOrigins,
      },
    });
    return null;
  }
  async request(s, input) {
    this.assert(s);
    if (
      !input ||
      typeof input.method !== 'string' ||
      input.method.length > 80 ||
      !Array.isArray(input.params ?? []) ||
      Buffer.byteLength(JSON.stringify(input)) > 65536
    )
      fail(-32602, 'Invalid wallet request');
    const method = input.method,
      params = input.params ?? [];
    if (method === 'eth_accounts') return this.snapshot(s).accounts;
    if (method === 'eth_chainId') return this.snapshot(s).chainId;
    if (method === 'net_version') return String(BigInt(this.snapshot(s).chainId));
    if (method === 'eth_requestAccounts') {
      try {
        return [this.wallet.wallet(this.connection(s).walletId).address];
      } catch (error) {
        if (error.code !== 4100 && error.message !== 'WALLET_CHAIN_UNAVAILABLE') throw error;
      }
      await this.ask(s);
      return [this.wallet.wallet(this.connection(s).walletId).address];
    }
    if (method === 'wallet_addEthereumChain') return this.requestNetwork(s, params);
    if (method === 'wallet_switchEthereumChain') {
      if (
        params.length !== 1 ||
        !params[0] ||
        typeof params[0] !== 'object' ||
        Array.isArray(params[0]) ||
        Object.keys(params[0]).some((k) => k !== 'chainId')
      )
        fail(-32602, 'Invalid chain selection');
      const id = quantity(params[0].chainId);
      if (id === 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) fail(-32602, 'Unsupported chain ID');
      let p;
      try {
        p = this.wallet.networks.byId(Number(id), true);
      } catch (e) {
        if (e.message !== 'WALLET_CHAIN_UNAVAILABLE') throw e;
        fail(4902, 'Register or enable this chain in the wallet first');
      }
      const c = this.grant(s);
      if (c.chain === p.key) return null;
      await this.ask(s, { desiredChain: p.key, networkRevision: p.revision, previous: c });
      return null;
    }
    if (!READS.has(method) && method !== 'eth_sendTransaction' && !MESSAGE_SIGNS.has(method))
      fail(4200, 'This wallet method is not supported');
    const c = this.connection(s),
      p = this.wallet.networks.profile(c.chain, true);
    if (s.controllers.size >= 8 || this.activeRequests >= 64)
      fail(-32002, 'Too many active wallet requests');
    this.activeRequests++;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(
        method === 'eth_sendTransaction' || MESSAGE_SIGNS.has(method) ? 600000 : 30000,
      ),
    ]);
    const authority = () => {
      this.assert(s);
      signal.throwIfAborted();
      if (this.connection(s).id !== c.id || this.connection(s).revision !== c.revision)
        fail(4100, 'Site connection changed');
      this.wallet.networks.assert(c.chain, p.revision);
    };
    s.controllers.add(controller);
    try {
      if (READS.has(method)) {
        const context = await this.wallet.market.connect({ venue: c.chain }, { signal });
        authority();
        const result = await context.rpc(method, params);
        authority();
        return result;
      }
      if (typeof input.id !== 'string' || !/^[\w:-]{1,64}$/.test(input.id))
        fail(-32602, 'A stable request ID is required');
      const fingerprint = hash({ method, params });
      const previous = s.operations.get(input.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail(-32602, 'Request ID already binds another transaction');
        if (previous.chain !== c.chain || previous.networkRevision !== p.revision)
          fail(4901, 'This request belongs to a different network configuration');
        return await previous.promise;
      }
      const operation = { fingerprint, chain: c.chain, networkRevision: p.revision };
      if (s.operations.size >= 64) fail(-32002, 'Too many transaction requests in this document');
      if (MESSAGE_SIGNS.has(method)) {
        if (params.length !== 2) fail(-32602, 'Expected message and connected account');
        const personal = method === 'personal_sign';
        const account = personal ? params[1] : params[0];
        if (getAddress(account) !== this.wallet.wallet(c.walletId).address)
          fail(4100, 'The requested signer is not connected to this site');
        authority();
        const promise = this.wallet.messages
          .request(personal ? 'personal' : 'typed', personal ? params[0] : params[1], {
            walletId: c.walletId,
            chain: c.chain,
            origin: s.origin,
            connectionId: c.id,
            ...(s.clientId
              ? {
                  requestId: hash({ clientId: s.clientId, document: s.id, id: input.id }),
                  sourceBrowser: { clientId: s.clientId, clientName: s.clientName },
                }
              : {}),
            signal,
            checkAuthority: authority,
          })
          .catch((error) => {
            if (error.message === 'WALLET_LOCKED')
              fail(4100, 'Unlock the selected wallet before requesting a signature');
            if (/^WALLET_MESSAGE_(CANCELLED|EXPIRED)$/.test(error.message))
              fail(4001, 'Message signature was not released');
            if (error.message === 'WALLET_MESSAGE_RETRY')
              fail(4001, 'This signature request already exists; check the wallet history');
            if (/^WALLET_MESSAGE_(INVALID|LOGIN|CHAIN)$/.test(error.message))
              fail(
                -32602,
                error.message === 'WALLET_MESSAGE_LOGIN'
                  ? 'Login message does not match this site, account, network or validity period'
                  : 'Invalid structured message or chain',
              );
            throw error;
          });
        s.operations.set(input.id, { ...operation, promise });
        return await promise;
      }
      const tx = params[0];
      if (
        params.length !== 1 ||
        !tx ||
        typeof tx !== 'object' ||
        Array.isArray(tx) ||
        Object.keys(tx).some((k) => !['from', 'to', 'value', 'data', 'chainId'].includes(k))
      )
        fail(
          -32602,
          'Only from, to, value, data and chainId are supported; wallet fees are reviewed separately',
        );
      const wallet = this.wallet.wallet(c.walletId);
      if (getAddress(tx.from) !== wallet.address)
        fail(4100, 'The requested sender is not connected to this site');
      if (tx.chainId !== undefined && quantity(tx.chainId) !== BigInt(p.id))
        fail(4901, 'Wrong transaction chain');
      authority();
      const promise = this.wallet
        .transact(
          { venue: c.chain },
          {
            walletId: c.walletId,
            commandId: 'app:' + s.id + ':' + input.id,
            to: tx.to,
            value: formatEther(quantity(tx.value ?? '0x0')),
            data: tx.data ?? '0x',
          },
          {
            actor: 'frontend',
            signal,
            checkAuthority: authority,
            sourceApp: {
              origin: s.origin,
              connectionId: c.id,
              ...(s.clientId ? { clientId: s.clientId, clientName: s.clientName } : {}),
            },
          },
        )
        .then((intent) => {
          if (intent.hash && intent.submissionMayHaveOccurred !== false) return intent.hash;
          if (['denied', 'cancelled', 'expired'].includes(intent.status))
            fail(4001, 'Transaction was not approved');
          fail(-32000, intent.error || 'Transaction outcome requires wallet reconciliation');
        });
      s.operations.set(input.id, { ...operation, promise });
      return await promise;
    } finally {
      s.controllers.delete(controller);
      this.activeRequests--;
    }
  }
  reviewRequest(id) {
    const p = this.pending.get(id);
    if (!p || p.expiresAt <= Date.now()) throw Error('WALLET_APP_CHANGED');
    this.assert(p.session);
    return p;
  }
  async probeNetwork(input) {
    const p = this.reviewRequest(input.id);
    if (!p.network) throw Error('WALLET_APP_CHANGED');
    if (p.probing) throw Error('WALLET_APP_PROBING');
    const key = 'evm-' + p.network.id;
    if (this.wallet.networks.has(key)) throw Error('WALLET_NETWORK_CHANGED');
    p.review = null;
    p.probing = true;
    try {
      const profile = await this.wallet.networks.probe(
        {
          id: p.network.id,
          name: p.network.name,
          nativeSymbol: p.network.nativeSymbol,
          rpc: input.rpc,
          additionalFeeNative: input.additionalFeeNative,
        },
        { signal: p.controller.signal },
      );
      this.reviewRequest(p.id);
      if (profile.revision !== 0) throw Error('WALLET_NETWORK_CHANGED');
      p.review = { id: randomUUID(), profile };
      return { id: p.review.id, profile: this.wallet.networks.public(profile) };
    } finally {
      p.probing = false;
    }
  }
  invalidateScope(connection, except) {
    const key = scopeKey(connection);
    for (const s of this.sessions.values())
      if (scopeKey(s) === key)
        for (const controller of s.controllers) controller.abort(Error('WALLET_APP_CHANGED'));
    for (const p of this.pending.values())
      if (p.id !== except && scopeKey(p) === key)
        this.finish(p.id, null, 4001, 'The site connection changed');
  }
  async action(action, input = {}) {
    if (action === 'list') return this.list();
    if (action === 'probeNetwork') return this.probeNetwork(input);
    if (action === 'addNetwork') {
      const p = this.reviewRequest(input.id);
      if (!p.review || p.review.id !== input.reviewId || input.confirmed !== true)
        throw Error('WALLET_CONFIRMATION_REQUIRED');
      const result = this.wallet.networks.save(p.review.profile);
      this.finish(p.id, null);
      return result;
    }
    if (action === 'deny') {
      this.finish(input.id, null, 4001, 'User rejected the connection');
      return { ok: true };
    }
    if (action === 'revoke') {
      const c = [...this.connections.values()].find((c) => c.id === input.id);
      if (!c || c.revision !== input.revision) throw Error('WALLET_APP_CHANGED');
      const next = new Map(this.connections);
      next.delete(scopeKey(c));
      this.persist(next);
      this.invalidateScope(c);
      this.wallet.emit();
      return { ok: true };
    }
    if (action === 'allow') {
      const request = this.pending.get(input.id);
      if (
        !request ||
        request.network ||
        request.expiresAt <= Date.now() ||
        input.confirmed !== true
      )
        throw Error('WALLET_CONFIRMATION_REQUIRED');
      this.assert(request.session);
      const wallet = this.wallet.wallet(input.walletId),
        p = this.wallet.networks.profile(input.chain, true);
      const previous = this.connections.get(scopeKey(request));
      if (
        request.desiredChain &&
        (request.desiredChain !== p.key ||
          request.networkRevision !== p.revision ||
          request.previous !== previous ||
          previous?.expiresAt <= Date.now() ||
          request.previous.walletId !== wallet.id)
      )
        throw Error('WALLET_APP_CHANGED');
      if (this.connections.size >= 128 && !this.connections.has(scopeKey(request)))
        throw Error('WALLET_APP_LIMIT');
      const c = {
        id: previous?.id ?? randomUUID(),
        origin: request.origin,
        ...(request.clientId
          ? {
              clientId: request.clientId,
              clientName: request.clientName,
              extensionOrigin: request.extensionOrigin,
            }
          : {}),
        walletId: wallet.id,
        chain: p.key,
        revision: (previous?.revision ?? 0) + 1,
        expiresAt: Date.now() + 86400000,
      };
      const next = new Map(this.connections);
      next.set(scopeKey(c), c);
      this.persist(next);
      this.invalidateScope(c, request.id);
      this.finish(request.id, c);
      return c;
    }
    throw Error('UNKNOWN_WALLET_ACTION');
  }
  dispose() {
    for (const s of [...this.sessions.values()]) this.close(s);
  }
  revokeClient(clientId) {
    for (const s of [...this.sessions.values()]) if (s.clientId === clientId) this.close(s);
    this.persist(new Map([...this.connections].filter(([, c]) => c.clientId !== clientId)));
    this.wallet.emit();
  }
}
module.exports = { WalletApps, originOf };
