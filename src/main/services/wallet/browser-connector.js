/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { AccountVault } = require('../account-vault');
const fail = (code) => {
  throw Error(code);
};
const sha = (v) =>
  crypto
    .createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex');
const id = (v) => typeof v === 'string' && /^[\da-f-]{36}$/.test(v);
const extensionOrigin = (v) =>
  typeof v === 'string' &&
  /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[\da-f-]{36})$/.test(v);
function publicKey(v) {
  if (
    !v ||
    v.kty !== 'EC' ||
    v.crv !== 'P-256' ||
    typeof v.x !== 'string' ||
    typeof v.y !== 'string' ||
    !/^[\w-]{43}$/.test(v.x) ||
    !/^[\w-]{43}$/.test(v.y) ||
    Object.keys(v).some((k) => !['kty', 'crv', 'x', 'y', 'key_ops', 'ext'].includes(k))
  )
    fail('WALLET_BROWSER_KEY');
  const result = { crv: 'P-256', kty: 'EC', x: v.x, y: v.y };
  crypto.createPublicKey({ key: result, format: 'jwk' });
  return result;
}
const bytes = (direction, session, seq, payload) =>
  Buffer.from(`CIBYP-WALLET-BROWSER/1\0${direction}\0${session}\0${seq}\0${payload}`);
const closeListener = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
function readControl(file) {
  try {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 262144) fail('WALLET_BROWSER_STORE');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      c.version !== 1 ||
      typeof c.disabled !== 'boolean' ||
      !Array.isArray(c.revoked) ||
      c.revoked.length > 2048 ||
      c.revoked.some((v) => !id(v)) ||
      new Set(c.revoked).size !== c.revoked.length
    )
      fail('WALLET_BROWSER_STORE');
    return c;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, disabled: true, revoked: [] };
    throw e;
  }
}
class WalletBrowserConnector {
  constructor(wallet, write, { vault } = {}) {
    this.wallet = wallet;
    this.write = write;
    this.file = path.join(wallet.directory, 'browser-control.json');
    this.vault = vault || new AccountVault(path.join(wallet.directory, 'browser-identity.json'));
    this.connections = new Set();
    this.pairings = new Map();
    this.documents = new Map();
    this.state = 'stopped';
    this.error = null;
    this.closed = false;
    this.generation = 0;
    this.pendingRevokes = new Set();
  }
  static shouldStart(directory) {
    try {
      return !readControl(path.join(directory, 'browser-control.json')).disabled;
    } catch {
      return true;
    }
  }
  async load() {
    if (this.data) return;
    this.loading ||= (async () => {
      this.control ||= readControl(this.file);
      let data;
      try {
        data = await this.vault.load();
      } catch {
        fail('WALLET_BROWSER_CREDENTIALS');
      }
      if (!data) {
        if (!this.control.disabled || this.control.revoked.length) fail('WALLET_BROWSER_STORE');
        const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        data = {
          version: 1,
          id: crypto.randomUUID(),
          privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
          publicKey: publicKey(keys.publicKey.export({ format: 'jwk' })),
          port: 0,
          clients: [],
        };
        try {
          await this.vault.save(data);
        } catch {
          fail('WALLET_BROWSER_CREDENTIALS');
        }
      }
      if (
        data.version !== 1 ||
        !id(data.id) ||
        !Number.isInteger(data.port) ||
        data.port < 0 ||
        data.port > 65535 ||
        !Array.isArray(data.clients) ||
        data.clients.length > 64
      )
        fail('WALLET_BROWSER_STORE');
      const privateKey = crypto.createPrivateKey(data.privateKey),
        pub = publicKey(crypto.createPublicKey(privateKey).export({ format: 'jwk' }));
      if (sha(pub) !== sha(publicKey(data.publicKey))) fail('WALLET_BROWSER_STORE');
      const seen = new Set();
      for (const c of data.clients) {
        if (
          !id(c.id) ||
          seen.has(c.id) ||
          !extensionOrigin(c.origin) ||
          typeof c.name !== 'string' ||
          c.name.length > 80 ||
          !Number.isSafeInteger(c.createdAt) ||
          c.revision !== 1
        )
          fail('WALLET_BROWSER_STORE');
        publicKey(c.publicKey);
        seen.add(c.id);
      }
      this.data = data;
      this.key = privateKey;
    })();
    try {
      await this.loading;
    } catch (e) {
      this.error = /^WALLET_BROWSER_[A-Z_]+$/.test(e.message) ? e.message : 'WALLET_BROWSER_STORE';
      throw Error(this.error);
    }
  }
  commitControl(next, fence = false) {
    if (fence) this.control = next;
    try {
      this.write(this.file, next);
      this.control = next;
      this.controlError = null;
    } catch {
      if (fence) this.controlError = 'WALLET_BROWSER_PERSIST';
      fail('WALLET_BROWSER_PERSIST');
    }
  }
  emit() {
    this.wallet.emit();
  }
  pendingIds() {
    return [...this.pairings.keys()];
  }
  status() {
    return {
      state: this.state,
      error: this.controlError || this.error,
      enabled: this.control ? !this.control.disabled : false,
      endpoint: this.address ? `ws://127.0.0.1:${this.address.port}/v1/wallet` : null,
      fingerprint: this.data ? sha(this.data.publicKey) : null,
      clients: (this.data?.clients || []).map((c) => ({
        id: c.id,
        name: c.name,
        origin: c.origin,
        fingerprint: sha(c.publicKey),
        createdAt: c.createdAt,
        revision: c.revision,
        revoked: this.control.revoked.includes(c.id),
        revocationPending: this.pendingRevokes.has(c.id),
      })),
      pending: [...this.pairings.values()].filter((p) => p.request).map((p) => p.request),
    };
  }
  async start(resume = false) {
    const generation = this.generation;
    if (this.stopping) await this.stopping.catch(() => {});
    const current = () => {
      if (this.closed || this.generation !== generation) fail('WALLET_STOPPED');
    };
    current();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.load();
      current();
      if (resume && this.control.disabled) return this.status();
      if (this.controlError || this.pendingRevokes.size) fail('WALLET_BROWSER_PERSIST');
      if (this.server) return this.status();
      this.state = 'starting';
      this.emit();
      const server = http.createServer((_req, res) => {
        res.writeHead(404, { 'cache-control': 'no-store', connection: 'close' });
        res.end();
      });
      server.maxConnections = 80;
      const ws = new WebSocketServer({
        noServer: true,
        maxPayload: 262144,
        perMessageDeflate: false,
      });
      server.on('upgrade', (req, socket, head) => {
        if (
          this.server !== server ||
          this.state !== 'listening' ||
          this.control.disabled ||
          req.url !== '/v1/wallet' ||
          req.headers.host !== `127.0.0.1:${server.address()?.port}` ||
          !extensionOrigin(req.headers.origin) ||
          this.connections.size >= 64
        ) {
          socket.destroy();
          return;
        }
        ws.handleUpgrade(req, socket, head, (s) => this.connect(s, req.headers.origin));
      });
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(this.data.port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        current();
        const next = { ...this.data, port: server.address().port };
        if (next.port !== this.data.port) {
          try {
            await this.vault.save(next);
          } catch {
            fail('WALLET_BROWSER_CREDENTIALS');
          }
          this.data = next;
        }
        current();
        if (!resume) this.commitControl({ ...this.control, disabled: false });
        this.server = server;
        this.ws = ws;
        this.address = server.address();
        this.state = 'listening';
        this.error = null;
        server.on('error', () => {
          this.error = 'WALLET_BROWSER_LISTEN';
          void this.stop(false);
          this.emit();
        });
        this.emit();
        return this.status();
      } catch (e) {
        await closeListener(server);
        ws.close();
        throw e;
      }
    })()
      .catch((e) => {
        if (this.closed || generation !== this.generation) throw Error('WALLET_STOPPED');
        this.error = /^(WALLET_|QUANT_)/.test(e.message) ? e.message : 'WALLET_BROWSER_LISTEN';
        this.state = 'error';
        this.emit();
        throw Error(this.error);
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  connect(socket, origin) {
    const state = {
      socket,
      origin,
      id: crypto.randomUUID(),
      nonce: crypto.randomBytes(32).toString('hex'),
      lastIn: 0,
      lastOut: 0,
      ready: false,
      closed: false,
    };
    const drop = () => {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(state.timer);
      clearInterval(state.heartbeat);
      state.session?.close();
      if (state.document && this.documents.get(state.document) === state)
        this.documents.delete(state.document);
      let pairingEnded = false;
      for (const [id, p] of this.pairings)
        if (p.channel === state) {
          clearTimeout(p.timer);
          this.pairings.delete(id);
          pairingEnded = true;
        }
      this.connections.delete(state);
      socket.terminate();
      if (pairingEnded) this.emit();
    };
    state.drop = drop;
    this.connections.add(state);
    state.timer = setTimeout(drop, 15000);
    state.timer.unref?.();
    socket.on('error', drop);
    socket.on('close', drop);
    socket.on('message', (frame, binary) => {
      void this.receive(state, frame, binary).catch(() => drop());
    });
  }
  send(s, value) {
    if (s.closed || s.socket.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > 2099200) {
      s.drop();
      return;
    }
    const seq = ++s.lastOut,
      signature = crypto
        .sign('sha256', bytes('server', s.id, seq, payload), {
          key: this.key,
          dsaEncoding: 'ieee-p1363',
        })
        .toString('base64url');
    if (s.socket.bufferedAmount > 4194304) {
      s.drop();
      return;
    }
    s.socket.send(JSON.stringify({ session: s.id, seq, payload, signature }));
  }
  async receive(s, frame, binary) {
    if (binary || s.closed || Buffer.byteLength(frame) > 262144) fail('WALLET_BROWSER_FRAME');
    const wire = JSON.parse(frame.toString());
    if (!s.challenged) {
      if (
        wire.type !== 'challenge' ||
        typeof wire.nonce !== 'string' ||
        !/^[a-f\d]{64}$/.test(wire.nonce)
      )
        fail('WALLET_BROWSER_FRAME');
      s.challenged = true;
      this.send(s, {
        type: 'challenge',
        version: 1,
        serverId: this.data.id,
        clientNonce: wire.nonce,
        serverNonce: s.nonce,
      });
      return;
    }
    if (
      !Number.isSafeInteger(wire.seq) ||
      wire.seq !== s.lastIn + 1 ||
      wire.session !== s.id ||
      typeof wire.payload !== 'string' ||
      Buffer.byteLength(wire.payload) > 67584 ||
      typeof wire.signature !== 'string' ||
      !/^[\w-]{86}$/.test(wire.signature)
    )
      fail('WALLET_BROWSER_FRAME');
    const body = JSON.parse(wire.payload);
    if (body.serverNonce !== s.nonce) fail('WALLET_BROWSER_FRAME');
    const key =
      s.client?.publicKey ||
      s.pairKey ||
      this.data.clients.find(
        (c) =>
          c.id === body.clientId && c.origin === s.origin && !this.control.revoked.includes(c.id),
      )?.publicKey ||
      (body.type === 'pair' ? publicKey(body.publicKey) : null);
    if (
      !key ||
      !crypto.verify(
        'sha256',
        bytes('client', s.id, wire.seq, wire.payload),
        { key: crypto.createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(wire.signature, 'base64url'),
      )
    )
      fail('WALLET_BROWSER_KEY');
    s.lastIn = wire.seq;
    if (s.closed || this.state !== 'listening' || this.control.disabled) {
      s.drop();
      return;
    }
    if (body.type === 'pair' && !s.ready && !s.pairing) {
      const p = this.offer;
      if (
        !p ||
        p.expiresAt <= Date.now() ||
        typeof body.code !== 'string' ||
        sha(body.code) !== p.codeHash ||
        this.pairings.size ||
        this.data.clients.length >= 64
      )
        fail('WALLET_BROWSER_PAIR');
      this.offer = null;
      s.pairKey = key;
      s.pairing = true;
      clearTimeout(s.timer);
      const request = {
        id: crypto.randomUUID(),
        name:
          (typeof body.name === 'string' &&
            body.name
              .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
              .trim()
              .slice(0, 80)) ||
          'Browser extension',
        origin: s.origin,
        fingerprint: sha(key),
        expiresAt: Date.now() + 120000,
      };
      request.digest = sha(request);
      const timer = setTimeout(() => s.drop(), 120000);
      timer.unref?.();
      this.pairings.set(request.id, { request, publicKey: key, channel: s, timer });
      s.heartbeat = setInterval(() => this.send(s, { type: 'ping' }), 20000);
      s.heartbeat.unref?.();
      this.send(s, { type: 'pair-pending', id: request.id });
      this.emit();
      return;
    }
    if (body.type === 'open' && !s.ready && !s.pairing) {
      const c = this.data.clients.find(
        (c) =>
          c.id === body.clientId && c.origin === s.origin && !this.control.revoked.includes(c.id),
      );
      const d = body.document;
      if (
        !c ||
        !d ||
        d.frameId !== 0 ||
        !Number.isSafeInteger(d.tabId) ||
        typeof d.id !== 'string' ||
        !/^[-\w]{1,128}$/.test(d.id) ||
        typeof d.url !== 'string' ||
        d.url.length > 4096
      )
        fail('WALLET_BROWSER_FRAME');
      const document = sha(c.id + ':' + d.tabId + ':' + d.id);
      this.documents.get(document)?.drop();
      s.document = document;
      s.client = c;
      s.session = this.wallet.apps.createSession({
        id: document,
        url: d.url,
        source: { clientId: c.id, clientName: c.name, extensionOrigin: c.origin },
        valid: () =>
          !s.closed && this.state === 'listening' && !this.control.revoked.includes(c.id),
      });
      this.documents.set(document, s);
      s.ready = true;
      clearTimeout(s.timer);
      s.heartbeat = setInterval(() => this.send(s, { type: 'ping' }), 20000);
      s.heartbeat.unref?.();
      this.send(s, { type: 'opened', snapshot: s.session.snapshot() });
      return;
    }
    if (body.type === 'pong' && (s.ready || s.pairing)) return;
    if (body.type === 'probe' && !s.ready && !s.pairing) {
      const client = this.data.clients.find(
        (c) =>
          c.id === body.clientId && c.origin === s.origin && !this.control.revoked.includes(c.id),
      );
      if (!client) fail('WALLET_BROWSER_KEY');
      this.send(s, { type: 'probed', clientId: client.id });
      return;
    }
    if (
      !s.ready ||
      body.type !== 'request' ||
      !id(body.id) ||
      !body.input ||
      typeof body.input !== 'object'
    )
      fail('WALLET_BROWSER_FRAME');
    if (s.active >= 8) {
      this.send(s, {
        type: 'response',
        id: body.id,
        ok: false,
        error: { code: -32002, message: 'Too many active requests' },
      });
      return;
    }
    s.active = (s.active || 0) + 1;
    try {
      const value =
        body.input.method === '__cibyp_snapshot' ? null : await s.session.request(body.input);
      this.send(s, {
        type: 'response',
        id: body.id,
        ok: true,
        value,
        snapshot: s.session.snapshot(),
      });
    } catch (e) {
      this.send(s, {
        type: 'response',
        id: body.id,
        ok: false,
        error: {
          code: Number.isInteger(e.code) ? e.code : -32000,
          message: Number.isInteger(e.code)
            ? e.message
            : 'Wallet request failed; inspect the wallet for details',
        },
      });
    } finally {
      s.active--;
    }
  }
  async action(action, input = {}) {
    if (this.closed) fail('WALLET_STOPPED');
    if (action === 'stop') {
      await this.stop(true);
      return this.status();
    }
    if (['status', 'revoke', 'deny'].includes(action)) return this.adminAction(action, input);
    const generation = this.generation;
    const result = (this.adminQueue || Promise.resolve()).then(() => {
      if (this.closed || this.generation !== generation) fail('WALLET_STOPPED');
      return this.adminAction(action, input, generation);
    });
    this.adminQueue = result.catch(() => {});
    return result;
  }
  async adminAction(action, input = {}, generation = this.generation) {
    await this.load();
    if (this.closed || this.generation !== generation) fail('WALLET_STOPPED');
    if (action === 'status') return this.status();
    if (action === 'start') return this.start();
    if (action === 'pair') {
      await this.start();
      if (generation !== this.generation || this.state !== 'listening') fail('WALLET_STOPPED');
      if (this.data.clients.filter((c) => !this.control.revoked.includes(c.id)).length >= 16)
        fail('WALLET_BROWSER_LIMIT');
      for (const p of this.pairings.values()) p.channel.drop();
      const code = crypto.randomBytes(24).toString('base64url'),
        expiresAt = Date.now() + 120000;
      this.offer = { codeHash: sha(code), expiresAt };
      return {
        uri: `cibyp-wallet://pair#${Buffer.from(JSON.stringify({ endpoint: this.status().endpoint, serverId: this.data.id, publicKey: this.data.publicKey, code })).toString('base64url')}`,
        expiresAt,
      };
    }
    if (action === 'confirm') {
      const p = this.pairings.get(input.id);
      if (
        !p ||
        p.request.expiresAt <= Date.now() ||
        p.channel.closed ||
        input.digest !== p.request.digest ||
        input.confirmed !== true
      )
        fail('WALLET_CONFIRMATION_REQUIRED');
      if (this.controlError || this.pendingRevokes.size) fail('WALLET_BROWSER_PERSIST');
      const active = this.data.clients.filter((c) => !this.control.revoked.includes(c.id));
      if (active.length >= 16 || active.length + this.control.revoked.length >= 2048)
        fail('WALLET_BROWSER_LIMIT');
      const client = {
        id: crypto.randomUUID(),
        name: p.request.name,
        origin: p.request.origin,
        publicKey: p.publicKey,
        createdAt: Date.now(),
        revision: 1,
      };
      const next = {
        ...this.data,
        clients: [...active, client],
      };
      try {
        await this.vault.save(next);
      } catch {
        fail('WALLET_BROWSER_CREDENTIALS');
      }
      this.data = next;
      if (
        p.channel.closed ||
        p.request.expiresAt <= Date.now() ||
        this.closed ||
        generation !== this.generation ||
        this.control.disabled
      ) {
        // The key was explicitly approved, but no client ID was released.
        // Revoke the unclaimed record even if its acknowledgement could not be sent.
        this.fenceClient(client);
        fail('WALLET_BROWSER_PAIR');
      }
      clearTimeout(p.timer);
      this.pairings.delete(input.id);
      this.send(p.channel, { type: 'paired', clientId: client.id, serverId: this.data.id });
      p.channel.pairing = false;
      p.channel.timer = setTimeout(() => p.channel.drop(), 10000);
      p.channel.timer.unref?.();
      this.emit();
      return this.status();
    }
    if (action === 'deny') {
      this.pairings.get(input.id)?.channel.drop();
      return this.status();
    }
    if (action === 'revoke') {
      const client = this.data.clients.find((c) => c.id === input.id);
      if (!client || client.revision !== input.revision) fail('WALLET_BROWSER_CHANGED');
      this.fenceClient(client);
      return this.status();
    }
    fail('UNKNOWN_WALLET_ACTION');
  }
  fenceClient(client) {
    const revoked = this.control.revoked;
    if (!revoked.includes(client.id) && revoked.length >= 2048) {
      // Refuse new pairings before this limit; existing pairings always remain revocable.
      fail('WALLET_BROWSER_LIMIT');
    }
    this.pendingRevokes.add(client.id);
    this.control = { ...this.control, revoked: [...new Set([...revoked, client.id])] };
    for (const c of [...this.connections]) if (c.client?.id === client.id) c.drop();
    try {
      this.commitControl(this.control, true);
      this.wallet.apps.revokeClient(client.id);
      this.pendingRevokes.delete(client.id);
    } catch {
      fail('WALLET_BROWSER_PERSIST');
    } finally {
      this.emit();
    }
  }
  async stop(persist = false) {
    this.generation++;
    this.state = 'stopped';
    this.offer = null;
    for (const p of this.pairings.values()) clearTimeout(p.timer);
    this.pairings.clear();
    for (const c of [...this.connections]) c.drop();
    const server = this.server;
    this.server = null;
    this.address = null;
    this.ws?.close();
    this.ws = null;
    let error;
    if (persist) {
      try {
        this.control ||= readControl(this.file);
        this.commitControl({ ...this.control, disabled: true }, true);
        this.error = null;
      } catch {
        this.controlError = 'WALLET_BROWSER_PERSIST';
        error = Error(this.controlError);
      }
    }
    const closing = Promise.allSettled([
      this.stopping,
      this.starting,
      server && closeListener(server),
    ]);
    this.stopping = closing;
    this.emit();
    await closing;
    if (this.stopping === closing) this.stopping = null;
    if (error) throw error;
  }
  async dispose() {
    this.closed = true;
    await this.stop(false);
  }
}
module.exports = { WalletBrowserConnector, publicKey, extensionOrigin, bytes };
