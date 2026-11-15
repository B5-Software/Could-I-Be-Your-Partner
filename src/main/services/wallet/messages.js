/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const {
  TypedDataEncoder,
  concat,
  keccak256,
  hashMessage,
  getBytes,
  getAddress,
  recoverAddress,
} = require('ethers');
const fail = (code) => {
  throw Error(code);
};
const clone = (v) => structuredClone(v);
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const pending = new Set(['approval-required', 'approved', 'signing']);
function bounded(v, depth = 0, counter = { n: 0 }) {
  if (++counter.n > 4096 || depth > 32) fail('WALLET_MESSAGE_INVALID');
  if (typeof v === 'number' && !Number.isSafeInteger(v)) fail('WALLET_MESSAGE_INVALID');
  if (v && typeof v === 'object')
    Object.values(v).forEach((item) => bounded(item, depth + 1, counter));
}
function schemaSubset(types, root) {
  const subset = {};
  const visit = (type) => {
    if (Object.hasOwn(subset, type)) return;
    const schema = types[type];
    if (!Array.isArray(schema)) fail('WALLET_MESSAGE_INVALID');
    Object.defineProperty(subset, type, { value: schema, enumerable: true });
    for (const field of schema) {
      if (typeof field?.type !== 'string') fail('WALLET_MESSAGE_INVALID');
      const child = field.type.replace(/\[\d*\]/g, '');
      if (Object.hasOwn(types, child)) visit(child);
    }
  };
  visit(root);
  let expanded = 0;
  const check = (type, depth = 0) => {
    if (++expanded > 4096 || depth > 32) fail('WALLET_MESSAGE_INVALID');
    for (const field of subset[type]) {
      const child = field.type.replace(/\[\d*\]/g, '');
      if (Object.hasOwn(subset, child)) check(child, depth + 1);
    }
  };
  check(root);
  return subset;
}
function typedDigest(data) {
  bounded(data);
  if (!data || Object.keys(data).sort().join() !== 'domain,message,primaryType,types')
    fail('WALLET_MESSAGE_INVALID');
  if (
    !data.types ||
    typeof data.types !== 'object' ||
    Array.isArray(data.types) ||
    Object.keys(data.types).length > 64
  )
    fail('WALLET_MESSAGE_INVALID');
  const name = (v) =>
    typeof v === 'string' && v.length <= 128 && /^[A-Za-z_$][A-Za-z0-9_$:]*$/.test(v);
  let fields = 0;
  for (const [key, schema] of Object.entries(data.types)) {
    const names = new Set();
    if (!name(key) || !Array.isArray(schema) || (fields += schema.length) > 256)
      fail('WALLET_MESSAGE_INVALID');
    for (const field of schema) {
      if (
        !field ||
        Object.keys(field).sort().join() !== 'name,type' ||
        !name(field.name) ||
        names.has(field.name) ||
        typeof field.type !== 'string' ||
        field.type.length > 256 ||
        !/^[A-Za-z_$][A-Za-z0-9_$:]*(?:\[\d*\]){0,32}$/.test(field.type)
      )
        fail('WALLET_MESSAGE_INVALID');
      names.add(field.name);
    }
  }
  if (
    !data.message ||
    typeof data.message !== 'object' ||
    Array.isArray(data.message) ||
    typeof data.primaryType !== 'string' ||
    (data.primaryType === 'EIP712Domain' && Object.keys(data.message).length)
  )
    fail('WALLET_MESSAGE_INVALID');
  const domain = TypedDataEncoder.hashStruct(
    'EIP712Domain',
    schemaSubset(data.types, 'EIP712Domain'),
    data.domain,
  );
  const components = ['0x1901', domain];
  if (data.primaryType !== 'EIP712Domain')
    components.push(
      TypedDataEncoder.hashStruct(
        data.primaryType,
        schemaSubset(data.types, data.primaryType),
        data.message,
      ),
    );
  return keccak256(concat(components));
}
function siwe(text, address, origin, chainId) {
  if (!text.includes('wants you to sign in with your Ethereum account:')) return null;
  const lines = text.split('\n'),
    marker = lines.findIndex((s) => s.startsWith('URI: '));
  const first =
    /^(?:(https?):\/\/)?([^\s/?#]+) wants you to sign in with your Ethereum account:$/.exec(
      lines[0],
    );
  if (
    !first ||
    lines[2] !== '' ||
    ![4, 5].includes(marker) ||
    lines[marker - 1] !== '' ||
    (marker === 5 && !/^[\x20-\x7e]+$/.test(lines[3]))
  )
    fail('WALLET_MESSAGE_LOGIN');
  const loginOrigin = new URL((first[1] || 'https') + '://' + first[2]);
  if (
    loginOrigin.username ||
    loginOrigin.password ||
    loginOrigin.origin !== origin ||
    getAddress(lines[1]) !== getAddress(address)
  )
    fail('WALLET_MESSAGE_LOGIN');
  const names = ['URI', 'Version', 'Chain ID', 'Nonce', 'Issued At'],
    fields = {};
  for (let i = 0; i < names.length; i++) {
    const prefix = names[i] + ': ',
      line = lines[marker + i];
    if (!line?.startsWith(prefix)) fail('WALLET_MESSAGE_LOGIN');
    fields[names[i]] = line.slice(prefix.length);
  }
  let last = -1;
  const optional = ['Expiration Time', 'Not Before', 'Request ID', 'Resources'];
  for (let i = marker + 5; i < lines.length; i++) {
    if (lines[i] === 'Resources:') {
      if (last >= 3) fail('WALLET_MESSAGE_LOGIN');
      fields.Resources = lines.slice(i + 1).map((s) => {
        if (!s.startsWith('- ')) fail('WALLET_MESSAGE_LOGIN');
        return new URL(s.slice(2)).href;
      });
      break;
    }
    const name = lines[i].split(': ')[0],
      index = optional.indexOf(name);
    if (index < 0 || index <= last || index === 3 || !lines[i].startsWith(name + ': '))
      fail('WALLET_MESSAGE_LOGIN');
    last = index;
    fields[name] = lines[i].slice(name.length + 2);
  }
  new URL(fields.URI);
  if (
    fields.Version !== '1' ||
    !/^\d+$/.test(fields['Chain ID']) ||
    BigInt(fields['Chain ID']) !== BigInt(chainId) ||
    !/^[a-z\d]{8,256}$/i.test(fields.Nonce)
  )
    fail('WALLET_MESSAGE_LOGIN');
  const date = (value) => {
    const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(
      value,
    );
    if (!parts) fail('WALLET_MESSAGE_LOGIN');
    const [, year, month, day, hour, minute, second] = parts.map(Number);
    const days = [
      31,
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > days[month - 1] ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      !Number.isFinite(Date.parse(value))
    )
      fail('WALLET_MESSAGE_LOGIN');
    return Date.parse(value);
  };
  const issued = date(fields['Issued At']),
    expiry = fields['Expiration Time'] ? date(fields['Expiration Time']) : null;
  if (
    issued > Date.now() + 300000 ||
    (expiry !== null && (expiry <= Date.now() || expiry <= issued)) ||
    (fields['Not Before'] && date(fields['Not Before']) > Date.now())
  )
    fail('WALLET_MESSAGE_LOGIN');
  return { origin, address, ...fields };
}
function normalize(kind, payload, context) {
  let digest,
    preview,
    login = null;
  if (kind === 'personal') {
    if (
      typeof payload !== 'string' ||
      !/^0x(?:[\da-f]{2})*$/i.test(payload) ||
      payload.length > 32768
    )
      fail('WALLET_MESSAGE_INVALID');
    payload = payload.toLowerCase();
    digest = hashMessage(getBytes(payload));
    try {
      preview = new TextDecoder('utf-8', { fatal: true }).decode(getBytes(payload));
    } catch {
      preview = null;
    }
    if (preview !== null) login = siwe(preview, context.address, context.origin, context.chainId);
  } else if (kind === 'typed') {
    if (typeof payload === 'string' && Buffer.byteLength(payload) > 32768)
      fail('WALLET_MESSAGE_INVALID');
    const data = typeof payload === 'string' ? JSON.parse(payload) : clone(payload);
    digest = typedDigest(data);
    payload = JSON.stringify(data);
    preview = data;
  } else fail('WALLET_MESSAGE_INVALID');
  if (Buffer.byteLength(payload) > 32768) fail('WALLET_MESSAGE_INVALID');
  const message = {
    kind,
    payload,
    origin: context.origin,
    connectionId: context.connectionId,
    chainId: context.chainId,
  };
  return { message, digest, binding: hash(message), preview, login };
}
const reviewDigest = (r) =>
  hash({
    version: 1,
    id: r.id,
    walletId: r.walletId,
    address: r.address,
    message: r.message,
    digest: r.digest,
    binding: r.binding,
    expiresAt: r.expiresAt,
    networkRevision: r.networkRevision,
    emergencyGeneration: r.emergencyGeneration,
    ...(r.requestId ? { requestId: r.requestId, sourceBrowser: r.sourceBrowser } : {}),
  });
class WalletMessages {
  constructor(wallet, write) {
    this.wallet = wallet;
    this.write = write;
    this.file = path.join(wallet.directory, 'messages.json');
    this.items = [];
    this.queue = Promise.resolve();
    this.waiters = new Map();
    this.active = new Map();
    this.closed = false;
    this.missing = false;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16777216)
        fail('WALLET_MESSAGE_STORE');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.items) || saved.items.length > 2048)
        fail('WALLET_MESSAGE_STORE');
      this.items = saved.items;
      const ids = new Set();
      for (const r of this.items) {
        if (
          !r ||
          typeof r.id !== 'string' ||
          !/^[\da-f-]{36}$/.test(r.id) ||
          ids.has(r.id) ||
          r.reviewDigest !== reviewDigest(r)
        )
          fail('WALLET_MESSAGE_STORE');
        ids.add(r.id);
        if (['approval-required', 'approved'].includes(r.status)) r.status = 'expired';
        else if (r.status === 'signing') r.status = 'signing-unknown';
      }
      this.persist(this.items);
    } catch (error) {
      if (error.code !== 'ENOENT') fail('WALLET_MESSAGE_STORE');
      this.missing = true;
    }
  }
  async ensure() {
    if (!this.missing) return;
    this.initializing ||= (async () => {
      const status = await this.wallet.signer('message.status', { id: 'wallet-messages' });
      if (status.version !== 1 || !Number.isSafeInteger(status.count) || status.count !== 0)
        fail('WALLET_MESSAGE_STORE');
      this.persist(this.items);
      this.missing = false;
    })();
    return this.initializing;
  }
  persist(items) {
    const saved = { version: 1, items };
    if (Buffer.byteLength(JSON.stringify(saved)) > 16777216) fail('WALLET_MESSAGE_LIMIT');
    this.write(this.file, saved);
    this.items = items;
    this.wallet.emit();
  }
  edit(fn) {
    const p = this.queue.then(async () => {
      const next = clone(this.items),
        value = await fn(next);
      this.persist(next);
      return value;
    });
    this.queue = p.catch(() => {});
    return p;
  }
  get(id, items = this.items) {
    return items.find((r) => r.id === id) || fail('WALLET_MESSAGE_NOT_FOUND');
  }
  public(r, detail = false) {
    const { nativeStoreId: _store, ...result } = clone(r);
    if (!detail) {
      result.message = {
        ...result.message,
        payloadBytes: Buffer.byteLength(result.message.payload),
      };
      delete result.message.payload;
      delete result.preview;
      delete result.login;
    }
    return result;
  }
  list({ offset = 0, limit = 20, status } = {}) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      fail('WALLET_MESSAGE_INVALID');
    const rows = this.items
      .filter(
        (r) =>
          !status ||
          (status === 'pending'
            ? r.status === 'approval-required'
            : status === 'history'
              ? !pending.has(r.status)
              : r.status === status),
      )
      .toReversed();
    return {
      items: rows.slice(offset, offset + limit).map((r) => this.public(r)),
      total: rows.length,
      next: offset + limit < rows.length ? offset + limit : null,
    };
  }
  guard(r, context) {
    if (this.closed || this.wallet.disposed) fail('WALLET_STOPPED');
    this.wallet.emergency.assert(r.emergencyGeneration);
    this.wallet.networks.assert(r.chain, r.networkRevision);
    if (r.expiresAt <= Date.now()) fail('WALLET_MESSAGE_EXPIRED');
    context.signal?.throwIfAborted();
    context.checkAuthority?.();
  }
  async request(kind, payload, context) {
    await this.ensure();
    const wallet = this.wallet.signingWallet(context.walletId),
      network = this.wallet.networks.profile(context.chain, true);
    const emergencyGeneration = this.wallet.emergency.assert();
    if (!this.wallet.isUnlocked(wallet.id)) fail('WALLET_LOCKED');
    let data;
    try {
      data = normalize(kind, payload, {
        ...context,
        address: wallet.address,
        chainId: network.id,
      });
    } catch (error) {
      if (/^WALLET_[A-Z_]+$/.test(error.message)) throw error;
      fail('WALLET_MESSAGE_INVALID');
    }
    const inspected = await this.wallet.signer('message.inspect', {
      id: wallet.id,
      message: data.message,
    });
    if (inspected.digest !== data.digest || inspected.binding !== data.binding)
      fail('WALLET_MESSAGE_MISMATCH');
    if (context.requestId) {
      const old = this.items.find((r) => r.requestId === context.requestId);
      if (old) {
        if (old.digest !== data.digest || old.binding !== data.binding)
          fail('WALLET_MESSAGE_MISMATCH');
        fail('WALLET_MESSAGE_RETRY');
      }
    }
    const r = {
      id: randomUUID(),
      walletId: wallet.id,
      address: wallet.address,
      chain: network.key,
      networkRevision: network.revision,
      emergencyGeneration,
      createdAt: Date.now(),
      expiresAt: Math.min(
        Date.now() + 300000,
        data.login?.['Expiration Time'] ? Date.parse(data.login['Expiration Time']) : Infinity,
      ),
      status: 'approval-required',
      ...data,
      ...(context.requestId
        ? { requestId: context.requestId, sourceBrowser: clone(context.sourceBrowser) }
        : {}),
    };
    r.reviewDigest = reviewDigest(r);
    this.guard(r, context);
    await this.edit((items) => {
      if (r.requestId && items.some((old) => old.requestId === r.requestId))
        fail('WALLET_MESSAGE_RETRY');
      if (items.length >= 2048 || items.filter((r) => pending.has(r.status)).length >= 16)
        fail('WALLET_MESSAGE_LIMIT');
      this.guard(r, context);
      items.push(r);
    });
    const controller = new AbortController(),
      signal = AbortSignal.any([
        controller.signal,
        ...(context.signal ? [context.signal] : []),
        AbortSignal.timeout(Math.max(1, r.expiresAt - Date.now())),
      ]);
    context = { ...context, signal };
    const work = this.perform(r.id, context);
    this.active.set(r.id, { controller, work });
    try {
      return await work;
    } finally {
      this.active.delete(r.id);
    }
  }
  async perform(id, context) {
    let invoked = false,
      returned = false;
    try {
      this.guard(this.get(id), context);
      await new Promise((resolve, reject) => {
        const done = () => {
          context.signal.removeEventListener('abort', abort);
          this.waiters.delete(id);
          resolve();
        };
        const abort = () => {
          this.waiters.delete(id);
          context.signal.removeEventListener('abort', abort);
          reject(Error('WALLET_MESSAGE_CANCELLED'));
        };
        this.waiters.set(id, done);
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
        else if (this.get(id).status !== 'approval-required') done();
      });
      let r = this.get(id);
      if (r.status !== 'approved') fail('WALLET_MESSAGE_CANCELLED');
      this.guard(r, context);
      const epoch = this.wallet.unlockEpochs.get(r.walletId);
      if (!this.wallet.isUnlocked(r.walletId)) fail('WALLET_LOCKED');
      const guard = () => {
        this.guard(this.get(id), context);
        if (
          !this.wallet.isUnlocked(r.walletId) ||
          this.wallet.unlockEpochs.get(r.walletId) !== epoch
        )
          fail('WALLET_UNLOCK_CHANGED');
      };
      await this.edit((items) => {
        const record = this.get(id, items);
        guard();
        record.status = 'signing';
      });
      r = this.get(id);
      guard();
      invoked = true;
      const result = await this.wallet.signer('message.sign', {
        id: r.walletId,
        operationId: r.id,
        storeId: r.nativeStoreId,
        message: r.message,
        expiresAt: r.expiresAt,
      });
      returned = true;
      if (
        result.receipt?.digest !== r.digest ||
        result.receipt?.binding !== r.binding ||
        result.receipt?.storeId !== r.nativeStoreId ||
        result.receipt?.operationId !== r.id ||
        result.receipt?.walletId !== r.walletId ||
        getAddress(recoverAddress(r.digest, result.signature)) !== getAddress(r.address) ||
        keccak256(result.signature) !== result.receipt.signatureHash
      )
        fail('WALLET_MESSAGE_MISMATCH');
      guard();
      await this.edit((items) => {
        guard();
        const record = this.get(id, items);
        record.status = 'signed';
        record.signatureHash = result.receipt.signatureHash;
        record.signedAt = Date.now();
      });
      guard();
      return result.signature;
    } catch (error) {
      await this.edit((items) => {
        const r = this.get(id, items);
        if (!['rejected', 'expired', 'cancelled'].includes(r.status))
          r.status = returned
            ? 'signed-withheld'
            : invoked
              ? 'signing-unknown'
              : error.message === 'WALLET_MESSAGE_EXPIRED'
                ? 'expired'
                : 'cancelled';
        r.error = /^WALLET_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'WALLET_MESSAGE_CANCELLED';
      });
      throw error;
    }
  }
  async action(action, input = {}) {
    await this.ensure();
    if (action === 'list') return this.list(input);
    if (action === 'get') return this.public(this.get(input.id), true);
    if (action === 'reconcile') {
      const r = this.get(input.id);
      if (!r.nativeStoreId) return this.public(r, true);
      const observed = await this.wallet.signer('message.receipt', {
        id: r.walletId,
        operationId: r.id,
        storeId: r.nativeStoreId,
      });
      if (
        observed.found &&
        (observed.digest !== r.digest ||
          observed.binding !== r.binding ||
          observed.walletId !== r.walletId)
      )
        fail('WALLET_MESSAGE_MISMATCH');
      return this.edit((items) => {
        const record = this.get(input.id, items);
        if (observed.found) {
          record.signatureHash = observed.signatureHash;
          if (!['signed', 'signed-withheld'].includes(record.status) && !this.active.has(record.id))
            record.status = 'signed-withheld';
        } else if (record.status === 'signing-unknown') record.status = 'cancelled';
        return this.public(record, true);
      });
    }
    if (action === 'approve' || action === 'deny') {
      const r = this.get(input.id);
      if (r.reviewDigest !== input.digest || r.reviewDigest !== reviewDigest(r))
        fail('WALLET_MESSAGE_MISMATCH');
      if (action === 'deny') this.active.get(r.id)?.controller.abort();
      const result = await this.edit(async (items) => {
        const record = this.get(input.id, items);
        if (action === 'deny') {
          await this.wallet.signer('operation.deny', { id: r.walletId, operationId: r.id });
          if (!['signed', 'signed-withheld'].includes(record.status))
            record.status = record.status === 'signing' ? 'signing-unknown' : 'rejected';
        } else {
          if (input.confirmed !== true) fail('WALLET_CONFIRMATION_REQUIRED');
          if (record.status !== 'approval-required') return this.public(record, true);
          this.guard(record, {});
          const epoch = this.wallet.unlockEpochs.get(r.walletId),
            store = await this.wallet.signer('receipt.status', { id: r.walletId });
          const result = await this.wallet.signer('message.approve', {
            id: r.walletId,
            operationId: r.id,
            storeId: store.storeId,
            message: r.message,
            expiresAt: r.expiresAt,
          });
          if (
            result.storeId !== store.storeId ||
            !this.wallet.isUnlocked(r.walletId) ||
            this.wallet.unlockEpochs.get(r.walletId) !== epoch
          )
            fail('WALLET_UNLOCK_CHANGED');
          this.guard(record, {});
          record.nativeStoreId = store.storeId;
          record.status = 'approved';
        }
        return this.public(record, true);
      });
      this.waiters.get(r.id)?.();
      return result;
    }
    fail('UNKNOWN_WALLET_ACTION');
  }
  abort(walletId) {
    for (const [id, a] of this.active)
      if (!walletId || this.get(id).walletId === walletId) a.controller.abort();
  }
  dispose() {
    this.closed = true;
    this.abort();
    return Promise.allSettled([...this.active.values()].map((a) => a.work)).then(() => this.queue);
  }
}
module.exports = { WalletMessages, normalize, typedDigest, reviewDigest };
