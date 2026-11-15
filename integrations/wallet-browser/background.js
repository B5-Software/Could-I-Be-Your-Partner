/* SPDX-License-Identifier: GPL-3.0-or-later */
const api = globalThis.browser || chrome;
const enc = new TextEncoder(),
  links = new Map();
let keyPromise, pairing, forgetting;
let generation = 0;
const error = (message = 'Wallet unavailable; open the extension to pair', code = 4900) =>
  Object.assign(Error(message), { code });
const b64 = (bytes) => {
  let s = '';
  for (const v of new Uint8Array(bytes)) s += String.fromCharCode(v);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const un64 = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const wireBytes = (direction, session, seq, payload) =>
  enc.encode(`CIBYP-WALLET-BROWSER/1\0${direction}\0${session}\0${seq}\0${payload}`);
const pub = (v) => {
  if (
    !v ||
    v.kty !== 'EC' ||
    v.crv !== 'P-256' ||
    typeof v.x !== 'string' ||
    typeof v.y !== 'string' ||
    !/^[\w-]{43}$/.test(v.x) ||
    !/^[\w-]{43}$/.test(v.y) ||
    v.d
  )
    throw error('Invalid pairing identity');
  return { crv: 'P-256', kty: 'EC', x: v.x, y: v.y };
};
async function identity() {
  keyPromise ||= (async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('cibyp-wallet-browser-v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('keys');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(error('Browser key storage is unavailable'));
    });
    try {
      let value = await new Promise((resolve, reject) => {
        const r = db.transaction('keys').objectStore('keys').get('identity');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(error('Cannot read browser identity'));
      });
      if (!value) {
        const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
          'sign',
          'verify',
        ]);
        value = {
          privateKey: key.privateKey,
          publicKey: pub(await crypto.subtle.exportKey('jwk', key.publicKey)),
        };
        await new Promise((resolve, reject) => {
          const t = db.transaction('keys', 'readwrite');
          t.objectStore('keys').put(value, 'identity');
          t.oncomplete = resolve;
          t.onerror = () => reject(error('Cannot save browser identity'));
        });
      }
      if (value.privateKey.extractable || value.privateKey.type !== 'private')
        throw error('Unsafe browser identity');
      return value;
    } finally {
      db.close();
    }
  })();
  return keyPromise;
}
async function config() {
  return (await api.storage.local.get('cibypWalletConnection')).cibypWalletConnection;
}
function endpoint(input) {
  const u = new URL(input);
  if (
    u.protocol !== 'ws:' ||
    u.hostname !== '127.0.0.1' ||
    !u.port ||
    u.username ||
    u.password ||
    u.pathname !== '/v1/wallet' ||
    u.search ||
    u.hash
  )
    throw error('Only a local CIBYP wallet endpoint is allowed');
  return u.href;
}
function parsePair(input) {
  if (typeof input !== 'string' || input.length > 4096)
    throw error('Paste a pairing address from CIBYP');
  const u = new URL(input);
  if (u.protocol !== 'cibyp-wallet:' || u.hostname !== 'pair' || u.search || u.pathname)
    throw error('Paste a pairing address from CIBYP');
  const d = JSON.parse(new TextDecoder().decode(un64(u.hash.slice(1))));
  if (
    typeof d.serverId !== 'string' ||
    !/^[\da-f-]{36}$/.test(d.serverId) ||
    typeof d.code !== 'string' ||
    !/^[\w-]{32}$/.test(d.code)
  )
    throw error('Invalid pairing address');
  return {
    endpoint: endpoint(d.endpoint),
    serverId: d.serverId,
    publicKey: pub(d.publicKey),
    code: d.code,
  };
}
class Channel {
  constructor(saved) {
    this.saved = saved;
    this.lastIn = 0;
    this.lastOut = 0;
    this.pending = new Map();
    this.outgoing = Promise.resolve();
    this.incoming = Promise.resolve();
    this.closed = false;
  }
  async connect() {
    this.identity = await identity();
    this.serverKey = await crypto.subtle.importKey(
      'jwk',
      pub(this.saved.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    if (this.closed) throw error();
    const nonce = b64(crypto.getRandomValues(new Uint8Array(32)));
    this.nonce = Array.from(un64(nonce), (n) => n.toString(16).padStart(2, '0')).join('');
    const socket = new WebSocket(endpoint(this.saved.endpoint));
    const connected = new Promise((resolve, reject) => {
      this.challengeResolve = resolve;
      this.challengeReject = reject;
    });
    this.socket = socket;
    this.timer = setTimeout(() => this.close(error('Local wallet did not respond')), 15000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'challenge', nonce: this.nonce }));
    socket.onmessage = (e) => {
      this.incoming = this.incoming.then(() => this.receive(e.data)).catch((e) => this.close(e));
    };
    socket.onerror = () => this.close(error('Cannot connect to the local wallet'));
    socket.onclose = () =>
      this.close(error('Wallet connection ended; inspect the wallet before retrying'));
    await connected;
    clearTimeout(this.timer);
    return this;
  }
  async send(body) {
    this.outgoing = this.outgoing.then(async () => {
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw error();
      const payload = JSON.stringify({ ...body, serverNonce: this.serverNonce }),
        seq = ++this.lastOut;
      if (enc.encode(payload).length > 67584) throw error('Request too large', -32602);
      const signature = b64(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          this.identity.privateKey,
          wireBytes('client', this.session, seq, payload),
        ),
      );
      this.socket.send(JSON.stringify({ session: this.session, seq, payload, signature }));
    });
    return this.outgoing.catch((e) => {
      this.close(e);
      throw e;
    });
  }
  async receive(raw) {
    if (typeof raw !== 'string' || enc.encode(raw).length > 4198400)
      throw error('Invalid wallet response');
    const frame = JSON.parse(raw);
    if (
      !Number.isSafeInteger(frame.seq) ||
      frame.seq !== this.lastIn + 1 ||
      typeof frame.session !== 'string' ||
      (this.session && this.session !== frame.session) ||
      typeof frame.payload !== 'string' ||
      typeof frame.signature !== 'string' ||
      !/^[\w-]{86}$/.test(frame.signature)
    )
      throw error('Invalid wallet response');
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.serverKey,
        un64(frame.signature),
        wireBytes('server', frame.session, frame.seq, frame.payload),
      ))
    )
      throw error('The local wallet identity changed');
    const body = JSON.parse(frame.payload);
    this.lastIn = frame.seq;
    if (!this.session) {
      if (
        body.type !== 'challenge' ||
        body.version !== 1 ||
        body.clientNonce !== this.nonce ||
        body.serverId !== this.saved.serverId ||
        !/^[a-f\d]{64}$/.test(body.serverNonce)
      )
        throw error('Wallet identity mismatch');
      this.session = frame.session;
      this.serverNonce = body.serverNonce;
      this.challengeResolve();
      return;
    }
    if (body.type === 'ping') {
      await this.send({ type: 'pong', clientId: this.saved.clientId });
      return;
    }
    if (body.type === 'response') {
      const p = this.pending.get(body.id);
      if (!p) return;
      this.pending.delete(body.id);
      clearTimeout(p.timer);
      p.resolve(body);
      return;
    }
    await this.control?.(body);
  }
  async pair(code) {
    const b = await this.exchange(
      {
        type: 'pair',
        code,
        publicKey: this.identity.publicKey,
        name: this.saved.name || api.runtime.getManifest().name,
      },
      'paired',
      120000,
    );
    if (
      b.serverId !== this.saved.serverId ||
      typeof b.clientId !== 'string' ||
      !/^[\da-f-]{36}$/.test(b.clientId)
    )
      throw error('Invalid paired identity');
    const { endpoint, serverId, publicKey } = this.saved;
    return { endpoint, serverId, publicKey, clientId: b.clientId };
  }
  async open(document) {
    await this.exchange({ type: 'open', clientId: this.saved.clientId, document }, 'opened');
    this.ready = true;
    return this;
  }
  async probe() {
    const result = await this.exchange({ type: 'probe', clientId: this.saved.clientId }, 'probed');
    if (result.clientId !== this.saved.clientId) throw error('Invalid paired identity');
  }
  async exchange(request, reply, timeout = 15000) {
    if (this.closed || this.control) throw error();
    try {
      return await new Promise((resolve, reject) => {
        this.controlReject = reject;
        this.control = (b) => {
          if (b.type === reply) resolve(b);
        };
        this.controlTimer = setTimeout(
          () => this.close(error('Local wallet did not respond')),
          timeout,
        );
        this.send(request).catch(reject);
      });
    } finally {
      clearTimeout(this.controlTimer);
      this.control = this.controlReject = null;
    }
  }
  request(input) {
    if (this.closed || !this.ready) return Promise.reject(error());
    if (this.pending.size >= 8)
      return Promise.resolve({
        ok: false,
        error: { code: -32002, message: 'Too many active requests' },
      });
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close(error('Request interrupted; inspect the wallet before retrying'));
      }, 600000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'request', id, input, clientId: this.saved.clientId }).catch((e) =>
        this.close(e),
      );
    });
  }
  close(reason = error()) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.controlTimer);
    this.socket?.close();
    this.challengeReject?.(reason);
    this.controlReject?.(reason);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }
}
function resetEntry(entry) {
  entry.channel?.close();
  entry.channel = entry.opening = null;
}
api.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (
    port.name !== 'cibyp-wallet-document-v1' ||
    sender?.id !== api.runtime.id ||
    !sender.tab ||
    sender.frameId !== 0 ||
    typeof sender.url !== 'string'
  ) {
    port.disconnect();
    return;
  }
  const url = new URL(sender.url);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  ) {
    port.disconnect();
    return;
  }
  const entry = {
    tab: sender.tab.id,
    documentId: sender.documentId || crypto.randomUUID(),
    url: sender.url,
    closed: false,
  };
  links.set(port, entry);
  const close = () => {
    entry.closed = true;
    resetEntry(entry);
    links.delete(port);
  };
  port.onDisconnect.addListener(close);
  port.onMessage.addListener((message) => {
    void (async () => {
      let result;
      try {
        if (entry.closed || forgetting) throw error();
        if (entry.channel?.closed) resetEntry(entry);
        const epoch = generation;
        const opening = (entry.opening ||= (async () => {
          const saved = await config();
          if (!saved || entry.closed || epoch !== generation) throw error();
          const c = new Channel(saved);
          entry.channel = c;
          await c.connect();
          if (entry.closed || epoch !== generation) throw error();
          return c.open({ tabId: entry.tab, frameId: 0, id: entry.documentId, url: entry.url });
        })());
        let c;
        try {
          c = await opening;
        } catch (e) {
          if (entry.opening === opening) resetEntry(entry);
          throw e;
        }
        if (c.closed || entry.closed || epoch !== generation) throw error();
        result = await c.request(message.input);
      } catch (e) {
        result = {
          ok: false,
          error: {
            code: Number.isInteger(e.code) ? e.code : 4900,
            message: e.message || 'Wallet unavailable',
          },
        };
      }
      if (!entry.closed)
        try {
          port.postMessage({ id: message.id, value: result });
        } catch {
          close();
        }
    })();
  });
});
api.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  for (const [port, e] of links)
    if (e.tab === details.tabId && (!details.documentId || details.documentId !== e.documentId)) {
      e.closed = true;
      resetEntry(e);
      port.disconnect();
      links.delete(port);
    }
});
api.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    sender.id !== api.runtime.id ||
    typeof sender.url !== 'string' ||
    !sender.url.startsWith(api.runtime.getURL(''))
  )
    return false;
  void (async () => {
    if (message.action === 'identity') {
      if (forgetting) throw error();
      const key = (await identity()).publicKey;
      const digest = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(key)));
      return {
        fingerprint: Array.from(new Uint8Array(digest), (v) =>
          v.toString(16).padStart(2, '0'),
        ).join(''),
      };
    }
    if (message.action === 'status') {
      const connection = await config();
      let available = false,
        c;
      if (connection)
        try {
          c = await new Channel(connection).connect();
          await c.probe();
          available = true;
        } catch {
          /* Retain the saved pairing for an offline app. */
        } finally {
          c?.close();
        }
      return { connection, pending: !!pairing, available };
    }
    if (message.action === 'pair') {
      if (pairing || forgetting) throw error('A pairing operation is already pending');
      const pair = parsePair(message.uri);
      if (typeof message.name === 'string') pair.name = message.name.trim().slice(0, 80);
      const channel = new Channel(pair);
      const epoch = generation;
      const operation = {
        channel,
        result: (async () => {
          if (await config()) throw error('Forget the existing pairing first');
          await channel.connect();
          const saved = await channel.pair(pair.code);
          if (epoch !== generation) throw error();
          await api.storage.local.set({ cibypWalletConnection: saved });
          for (const e of links.values()) resetEntry(e);
          return { connection: saved };
        })(),
      };
      pairing = operation;
      try {
        return await operation.result;
      } finally {
        if (pairing === operation) pairing = null;
        channel.close();
      }
    }
    if (message.action === 'forget') {
      if (!forgetting) {
        generation++;
        const old = pairing;
        old?.channel.close();
        for (const e of links.values()) resetEntry(e);
        forgetting = (async () => {
          await Promise.allSettled([old?.result, keyPromise]);
          await api.storage.local.remove('cibypWalletConnection');
          await new Promise((resolve, reject) => {
            const r = indexedDB.deleteDatabase('cibyp-wallet-browser-v1');
            r.onsuccess = resolve;
            r.onerror = () => reject(error('Cannot delete browser identity'));
          });
          keyPromise = null;
          return { connection: null };
        })().finally(() => (forgetting = null));
      }
      return forgetting;
    }
    throw error('Unknown extension action');
  })().then(
    (value) => reply({ ok: true, ...value }),
    (e) => reply({ ok: false, error: e.message || 'Wallet unavailable' }),
  );
  return true;
});
