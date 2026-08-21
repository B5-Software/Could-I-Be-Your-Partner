// CIBYP-IM Service — 让 AI 伙伴直接使用 CIBYP-IM（端到端加密即时通讯）。
// 模式与 fedikitten-service.js 相同：登录后 token 与密钥保存在本机 settings，
// 工具调用经 window.api.cibypImCall(name, args) 路由到此服务的 call()。
// 加密实现与 web/js/e2ee.js 完全一致（X3DH + 简化双棘轮 + AES-256-GCM），
// 这里用 Node 原生 crypto（X25519 JWK + WebCrypto）实现，零外部依赖。

const fs = require('fs');
const path = require('path');
const { createECDH, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify } = require('crypto');

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const REQUEST_TIMEOUT = 20000;
// 与服务端 MAX_MEDIA_BYTES（默认 10MB）对齐；密文比明文略长（GCM tag），留出余量
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 - 64;

const TE = new TextEncoder();
const TD = new TextDecoder();
const b64url = (b) => Buffer.from(b).toString('base64url');
const unb64url = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

// ---------- E2EE primitives (mirror web/js/e2ee.js) ----------
function genX25519() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    priv: pkcs8.subarray(pkcs8.length - 32).toString('base64url'),
    pub: spki.subarray(spki.length - 32).toString('base64url'),
  };
}
function genEd25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    priv: pkcs8.subarray(pkcs8.length - 32).toString('base64url'),
    pub: spki.subarray(spki.length - 32).toString('base64url'),
  };
}
function edSign(privB64, msg) {
  const privBytes = Buffer.from(privB64, 'base64url');
  const pk = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), privBytes]), format: 'der', type: 'pkcs8' });
  return b64url(sign(null, Buffer.from(msg), pk));
}
function edVerify(pubB64, msg, sigB64) {
  try {
    if (!pubB64 || !sigB64) return false; // 与 web 端一致：缺失签名拒绝
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubB64, 'base64url')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(msg), pub, Buffer.from(sigB64, 'base64url'));
  } catch { return false; }
}
function xdh(privB64, pubB64) {
  const privBytes = Buffer.from(typeof privB64 === 'object' ? privB64.d : privB64, 'base64url');
  const pk = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privBytes]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(pubB64, 'base64url')]), format: 'der', type: 'spki' });
  return b64url(diffieHellman({ privateKey: pk, publicKey: pub }));
}
function concatBytes(arrs) { return Buffer.concat(arrs.map((a) => Buffer.from(a))); }
async function sha256(data) { return new Uint8Array(await crypto.subtle.digest('SHA-256', data)); }
async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF', hash: 'SHA-256' }, false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
async function aesEncrypt(keyBytes, data, aad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, data));
  return { iv, ct };
}
async function aesDecrypt(keyBytes, iv, ct, aad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct));
}
async function x3dhInit(myIkPriv, peerIkPub, ekPriv, peerSpkPub, peerOpkPub) {
  const a = await xdh(myIkPriv, peerIkPub);
  const b = await xdh(ekPriv, peerIkPub);
  const terms = [unb64url(a), unb64url(b)];
  if (peerSpkPub) terms.splice(1, 0, unb64url(await xdh(ekPriv, peerSpkPub)));
  terms.push(unb64url(await xdh(ekPriv, peerOpkPub)));
  return concatBytes(terms);
}
async function x3dhResp(myIkPriv, mySpkPriv, myOpkPriv, peerIkPub, peerEkPub) {
  const a = await xdh(myIkPriv, peerIkPub);
  const b = await xdh(myIkPriv, peerEkPub);
  const terms = [unb64url(a), unb64url(b)];
  if (mySpkPriv) terms.splice(1, 0, unb64url(await xdh(mySpkPriv, peerEkPub)));
  terms.push(unb64url(await xdh(myOpkPriv, peerEkPub)));
  return concatBytes(terms);
}
async function deriveRootKey(ss) {
  return await hkdf(ss, new Uint8Array(32), TE.encode('CIBYP-IM:X3DH:v1'), 32);
}
async function kdfRk(rk, dhOut) {
  const out = await hkdf(concatBytes([rk, dhOut]), new Uint8Array(32), TE.encode('CIBYP-IM:RK:v1'), 64);
  return { rk: out.slice(0, 32), ck: out.slice(32) };
}
async function kdfCk(ck) {
  const out = await hkdf(ck, new Uint8Array(32), TE.encode('CIBYP-IM:CK:v1'), 64);
  return { ck: out.slice(0, 32), mk: out.slice(32) };
}

class Session {
  constructor(s) { this.s = s; }
  static async initiator(ikPrivB64, peerIkPub, peerSpk, peerOpkPub) {
    const ek = genX25519();
    const ss = await x3dhInit(ikPrivB64, peerIkPub, ek.priv, peerSpk ? peerSpk.pub : null, peerOpkPub);
    const rk = await deriveRootKey(ss);
    return new Session({
      v: 2, id: crypto.randomUUID(), peer: null, ik: ikPrivB64,
      dhS: ek, dhR: peerIkPub, rk, sending: null, receiving: null,
      sendCount: 0, recvCount: 0, peerIk: peerIkPub, initiator: true, everSentInit: false,
      peerEd: null, peerOpk: peerOpkPub || null,
    });
  }
  static async responder(ikPrivB64, spkPrivB64, opkPrivB64, initEnv) {
    const ss = await x3dhResp(ikPrivB64, spkPrivB64, opkPrivB64, initEnv.ik, initEnv.ek);
    let rk = await deriveRootKey(ss);
    const dhOut = await xdh(ikPrivB64, initEnv.ek);
    const r1 = await kdfRk(rk, unb64url(dhOut));
    rk = r1.rk;
    return new Session({
      v: 2, id: crypto.randomUUID(), peer: null, ik: ikPrivB64,
      dhS: null, dhR: initEnv.ek, rk, sending: null, receiving: { key: r1.ck, count: 0 },
      sendCount: 0, recvCount: 0, peerIk: initEnv.ik, initiator: false, everSentInit: false,
      peerEd: initEnv.ed || null,
    });
  }
  async encrypt(msgBytes) {
    if (!this.s.dhS) this.s.dhS = genX25519();
    if (!this.s.sending) {
      const dhOut = await xdh(this.s.dhS.priv, this.s.dhR);
      const r = await kdfRk(this.s.rk, unb64url(dhOut));
      this.s.rk = r.rk;
      this.s.sending = { key: r.ck, count: 0 };
      this.s.sendCount = 0;
    }
    const r = await kdfCk(this.s.sending.key);
    this.s.sending = { key: r.ck, count: this.s.sending.count + 1 };
    const header = { dh: this.s.dhS.pub, count: this.s.sending.count - 1, pn: this.s.recvCount };
    const aad = TE.encode(JSON.stringify({ dh: header.dh, count: header.count, pn: header.pn }));
    const e = await aesEncrypt(r.mk, msgBytes, aad);
    this.s.sendCount = this.s.sending.count;
    return { header, iv: b64url(e.iv), ct: b64url(e.ct) };
  }
  async decrypt(header, ivB64, ctB64) {
    // 与 web/js/e2ee.js 一致：自己（本会话 dhS）发出的消息不走 ratchet 分支，
    // 否则会用 dhS.priv 对自己的公钥做 DH，派生出错误密钥
    const ownMessage = this.s.dhS && header.dh === this.s.dhS.pub;
    if (!ownMessage && header.dh !== this.s.dhR) {
      const dhOut = await xdh(this.s.dhS.priv, header.dh);
      const r = await kdfRk(this.s.rk, unb64url(dhOut));
      this.s.rk = r.rk;
      this.s.receiving = { key: r.ck, count: 0 };
      this.s.dhR = header.dh;
      this.s.dhS = genX25519();
      const dhOut2 = await xdh(this.s.dhS.priv, this.s.dhR);
      const r2 = await kdfRk(this.s.rk, unb64url(dhOut2));
      this.s.rk = r2.rk;
      this.s.sending = { key: r2.ck, count: 0 };
      this.s.sendCount = 0;
      this.s.recvCount = 0;
    }
    if (!this.s.receiving) throw new Error('no receiving chain');
    let chain = this.s.receiving;
    while (chain.count < header.count) {
      const r = await kdfCk(chain.key);
      chain = { key: r.ck, count: chain.count + 1 };
    }
    const r = await kdfCk(chain.key);
    this.s.receiving = { key: r.ck, count: chain.count + 1 };
    this.s.recvCount = this.s.receiving.count;
    const aad = TE.encode(JSON.stringify({ dh: header.dh, count: header.count, pn: header.pn }));
    return await aesDecrypt(r.mk, unb64url(ivB64), unb64url(ctB64), aad);
  }
}

// ---------- service ----------
class CibypImService {
  constructor() {
    this.active = null;        // { url, username, token }
    this.keys = null;          // { ik: {priv,pub}, opks: [{priv,pub}] }
    this.sessions = [];        // [Session.state]
    this.groups = [];          // [{ id, name, key, wraps }]
    this.identity = null;      // current user from /me
    this._msgCache = new Map(); // msgId → 解密结果（避免轮询全量重复解密推进 ratchet）
  }

  configure(cfg) {
    const c = cfg || {};
    const active = c.active || {};
    if (active.url && active.token && active.username) {
      this.active = {
        url: String(active.url).replace(/\/+$/, ''),
        username: String(active.username),
        token: String(active.token),
      };
    } else {
      this.active = null;
    }
    if (Array.isArray(c.keys)) this.keys = c.keys[0] || null;
    if (Array.isArray(c.sessions)) this.sessions = c.sessions;
    if (Array.isArray(c.groups)) this.groups = c.groups;
    this.identity = c.identity || null;
    return this;
  }

  getState() {
    if (!this.active) return { ok: true, loggedIn: false };
    return { ok: true, loggedIn: true, url: this.active.url, username: this.active.username, displayName: (this.identity && (this.identity.display_name || this.identity.username)) || this.active.username };
  }

  async login({ url, username, password, forceTakeover } = {}) {
    if (!url || !username || !password) return { ok: false, error: '缺少服务器地址、用户名或密码' };
    const baseUrl = String(url).trim().replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data && data.error) || `登录失败 (${res.status})` };
    this.active = { url: baseUrl, username: username.trim(), token: data.token };
    try {
      // 密钥初始化失败（含多设备身份冲突）视为登录失败，避免半登录态发出无法解密的消息
      await this._ensureKeys({ forceTakeover: !!forceTakeover });
      await this._refillOpks().catch((e) => console.error('[CIBYP-IM] OPK refill failed:', e.message));
      await this._syncIdentity();
    } catch (e) {
      this.active = null;
      throw e;
    }
    return this.getState();
  }

  async logout() {
    try { if (this.active) await this.api('/api/v1/logout', { method: 'POST' }); } catch { /* ignore */ }
    this.active = null;
    return { ok: true, loggedIn: false };
  }

  // ---- auth helpers ----
  async _syncIdentity() {
    const res = await this.api('/api/v1/me');
    this.identity = res.user;
  }

  async _ensureKeys(opts = {}) {
    await this._syncIdentity();
    const serverIk = this.identity && this.identity.identity_pub ? String(this.identity.identity_pub) : null;
    if (this.keys && this.keys.ik) {
      // 本机已有身份：校验服务端身份仍归属本机（未被其他设备接管）
      if (serverIk && serverIk !== this.keys.ik.pub) {
        const err = new Error('本机加密身份与服务端不一致：该账号已在其他设备重新初始化。'
          + '为避免会话错乱，请勿在多台设备同时使用同一账号；如确认要以本机为准，请勾选“接管身份”后重新登录（旧设备的会话将无法解密新消息）。');
        err.code = 'IDENTITY_MISMATCH';
        throw err;
      }
      await this._refillOpks();
      return;
    }
    // 全新设备：若服务端已有身份且未显式接管，拒绝覆盖（防止静默顶掉其他设备）
    if (serverIk && !opts.forceTakeover) {
      const err = new Error('TAKEOVER_REQUIRED::该账号已在其他设备初始化过端到端加密身份。直接登录会让旧设备无法解密新消息。'
        + '如确认只在本次设备使用（或愿意作废旧设备会话），请勾选“接管身份”后重试。');
      err.code = 'TAKEOVER_REQUIRED';
      throw err;
    }
    const ik = genX25519();
    const ed = genEd25519();
    const spk = genX25519();
    spk.sig = edSign(ed.priv, spk.pub);
    const opks = [];
    for (let i = 0; i < 30; i++) opks.push(genX25519());
    this.keys = { ik, ed, spk, opks, uploaded: [], spkUploaded: false };
    // 身份上传失败必须中止（否则后续 init 消息对方无法解密）
    await this.api('/api/v1/me', {
      method: 'PATCH',
      body: JSON.stringify({ identityPub: ik.pub, identityEdPub: ed.pub }),
    });
    const toUpload = opks.slice(0, 20);
    await this.api('/api/v1/device/register', {
      method: 'POST',
      body: JSON.stringify({
        oneTime: toUpload.map((o, i) => ({ pub: o.pub, keyId: 'k' + i })),
        identityPub: ik.pub,
        identityEdPub: ed.pub,
        spk: { pub: spk.pub, sig: spk.sig },
      }),
    });
    this.keys.uploaded = toUpload.map((o) => o.pub);
    this.keys.spkUploaded = true;
  }

  async _refillOpks() {
    if (!this.keys || !this.keys.ik) return;
    const opks = this.keys.opks || [];
    if (opks.length >= 15) return;
    const uploaded = this.keys.uploaded || [];
    while (opks.length < 30) opks.push(genX25519());
    const fresh = opks.filter((o) => !uploaded.includes(o.pub));
    if (fresh.length) {
      await this.api('/api/v1/device/register', {
        method: 'POST',
        body: JSON.stringify({ oneTime: fresh.map((o, i) => ({ pub: o.pub, keyId: 'k' + i })) }),
      });
      this.keys.uploaded = uploaded.concat(fresh.map((o) => o.pub));
    }
  }

  _opkByPub(pub) {
    if (!this.keys || !this.keys.opks) return null;
    const i = this.keys.opks.findIndex((o) => o.pub === pub);
    if (i < 0) return null;
    return { key: this.keys.opks[i], idx: i };
  }

  async api(pathname, { method = 'GET', body = null, headers = {}, timeout = REQUEST_TIMEOUT, raw = false } = {}) {
    if (!this.active) throw new Error('尚未登录 CIBYP-IM，请在设置页完成登录');
    const res = await fetch(`${this.active.url}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.active.token}`, ...headers },
      body: body || undefined,
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 401) {
      this.active = null;
      throw new Error('登录已失效，请在设置页重新登录');
    }
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  // ---- tool dispatcher ----
  async call(toolName, args = {}) {
    if (!toolName || typeof toolName !== 'string') return { ok: false, error: '缺少工具名称' };
    const fn = TOOL_HANDLERS[toolName];
    if (!fn) return { ok: false, error: `未知工具: ${toolName}` };
    try {
      return await fn.call(this, args);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- encryption helpers ----
  async _getPeerKeys(peerId) {
    const data = await this.api(`/api/v1/users/${peerId}/keys`);
    if (!data.identityPub) throw new Error('对方尚未完成密钥注册');
    if (!data.oneTimePub) throw new Error('对方加密密钥已耗尽，请其重新登录');
    return data;
  }

  async _peerEdPub(userId) {
    if (this._edCache && this._edCache[userId]) return this._edCache[userId];
    try {
      const d = await this.api(`/api/v1/users/${userId}`);
      const ed = (d && d.user && d.user.identity_ed_pub) || null;
      if (!this._edCache) this._edCache = {};
      this._edCache[userId] = ed;
      return ed;
    } catch { return null; }
  }

  async _sessionForDirect(convId, peerId) {
    let s = this.sessions.find((x) => x.peer === peerId);
    if (s) return Session.deserialize(s);
    const keys = await this._getPeerKeys(peerId);
    if (keys.spk && keys.identityEdPub && !edVerify(keys.identityEdPub, keys.spk.pub, keys.spk.sig)) {
      throw new Error('对方身份密钥校验失败，会话已拒绝');
    }
    // 优先 claim 一次性密钥（服务端标记已用，避免同一 OPK 被多会话复用）；失败则退回 GET 返回的 key
    let oneTimePub = keys.oneTimePub;
    try {
      const claim = await this.api(`/api/v1/users/${peerId}/keys/claim`, { method: 'POST' });
      if (claim && claim.pub) oneTimePub = claim.pub;
    } catch { /* fallback to GET key */ }
    if (!oneTimePub) throw new Error('对方加密密钥已耗尽，请其重新登录');
    const sess = await Session.initiator(this.keys.ik.priv, keys.identityPub, keys.spk, oneTimePub);
    sess.s.peer = peerId;
    sess.s.peerEd = keys.identityEdPub || null;
    this.sessions.push(sess.s);
    return sess;
  }

  async _decryptMessage(conv, msg) {
    let env;
    try { env = JSON.parse(msg.ciphertext || ''); } catch { return null; }
    if (!env || !env.k) return null;
    if (env.k === 'gk') {
      const wrap = (env.wraps || {})[this.identity.id];
      if (!wrap) return null;
      const key = await this._unwrapGroupKey(wrap);
      const g = this.groups.find((x) => x.id === env.gid);
      if (g) g.key = key; else this.groups.push({ id: env.gid, name: env.name || '', key, wraps: env.wraps || {} });
      return '🔑 群密钥已建立';
    }
    if (env.k === 'group') {
      const g = this.groups.find((x) => x.id === env.gid);
      if (!g || !g.key) return null;
      const r = await this._groupDecrypt(g.key, env);
      if (r.sig) {
        const ed = await this._peerEdPub(msg.sender_id);
        if (!ed || !edVerify(ed, concatBytes([unb64url(r.iv), unb64url(r.ct)]), r.sig)) return null; // 群消息签名校验失败
      }
      return this._parsePayload(r.plain);
    }
    let s = this.sessions.find((x) => x.id === env.s);
    if (!s) {
      if (env.k === 'init') {
        const opk = this._opkByPub(env.opk);
        if (!opk) return null;
        const spk = this.keys && this.keys.spk ? this.keys.spk : null;
        const sess = await Session.responder(this.keys.ik.priv, spk ? spk.priv : null, opk.key.priv, env);
        sess.s.id = env.s;
        sess.s.peer = msg.sender_id;
        this.keys.opks.splice(opk.idx, 1);
        this.sessions.push(sess.s);
        s = sess.s;
      } else {
        return null;
      }
    }
    try {
      const sess = Session.deserialize(s);
      if (sess.s.peerEd && !edVerify(sess.s.peerEd, env.ct, env.sig)) {
        return null; // signature check failed
      }
      const plain = await sess.decrypt(env.header, env.iv, env.ct);
      s = sess.s;
      return this._parsePayload(plain);
    } catch { return null; }
  }

  // 带缓存的解密：同一消息不重复解密（避免每次轮询全量解密 + ratchet 状态无谓推进）
  async _decryptCached(msg) {
    const id = msg && msg.id;
    if (id && this._msgCache.has(id)) return this._msgCache.get(id);
    let payload = null;
    try { payload = await this._decryptMessage(null, msg); } catch { payload = null; }
    if (id) {
      this._msgCache.set(id, payload);
      if (this._msgCache.size > 500) {
        const oldest = this._msgCache.keys().next().value;
        this._msgCache.delete(oldest);
      }
    }
    return payload;
  }

  _parsePayload(plain) {
    const text = TD.decode(plain);
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { text }; }
    return payload;
  }

  async _encryptForConv(conv, msgType, text, media = []) {
    const payload = JSON.stringify({ text: text || '', media });
    const mediaIds = media.map((m) => m.id);
    if (conv.type === 'group') {
      const g = this.groups.find((x) => x.id === conv.id);
      if (!g || !g.key) throw new Error('群密钥未就绪');
      const e = await this._groupEncrypt(g.key, TE.encode(payload), this.keys.ed ? this.keys.ed.priv : null);
      return { msgType, ciphertext: JSON.stringify({ v: 2, k: 'group', gid: conv.id, iv: e.iv, ct: e.ct, sig: e.sig }), mediaIds };
    }
    const other = (conv.members || []).find((m) => m.id !== this.identity.id);
    if (!other) throw new Error('未找到会话对方');
    const sess = await this._sessionForDirect(conv.id, other.id);
    const first = !sess.s.everSentInit;
    if (first) sess.s.everSentInit = true;
    const enc = await sess.encrypt(TE.encode(payload));
    return {
      msgType,
      ciphertext: JSON.stringify({
        v: 2, k: first ? 'init' : 'msg', s: sess.s.id,
        ik: this.keys.ik.pub, ed: first ? this.keys.ed.pub : undefined,
        ek: first ? sess.s.dhS.pub : undefined, opk: first ? (sess.s.peerOpk || null) : undefined,
        header: enc.header, iv: enc.iv, ct: enc.ct,
        sig: edSign(this.keys.ed.priv, enc.ct),
      }),
      mediaIds,
    };
  }

  async _groupEncrypt(gk, bytes, edPriv) {
    const e = await aesEncrypt(unb64url(gk), bytes, TE.encode('CIBYP-IM:GMSG:v1'));
    let sig = null;
    if (edPriv) sig = edSign(edPriv, concatBytes([e.iv, e.ct]));
    return { iv: b64url(e.iv), ct: b64url(e.ct), sig };
  }
  async _groupDecrypt(gk, env) {
    const plain = await aesDecrypt(unb64url(gk), unb64url(env.iv), unb64url(env.ct), TE.encode('CIBYP-IM:GMSG:v1'));
    return { plain, iv: env.iv, ct: env.ct, sig: env.sig || null };
  }
  async _wrapGroupKey(gk, memberIdentityPub) {
    const ek = genX25519();
    const ss = await xdh(ek.priv, memberIdentityPub);
    const wrapKey = await hkdf(unb64url(ss), new Uint8Array(32), TE.encode('CIBYP-IM:GROUP-WRAP:v1'), 32);
    const e = await aesEncrypt(wrapKey, unb64url(gk), TE.encode('CIBYP-IM:GROUP:v1'));
    return { ek: ek.pub, iv: b64url(e.iv), ct: b64url(e.ct) };
  }
  async _unwrapGroupKey(wrap) {
    const ss = await xdh(this.keys.ik.priv, wrap.ek);
    const wrapKey = await hkdf(unb64url(ss), new Uint8Array(32), TE.encode('CIBYP-IM:GROUP-WRAP:v1'), 32);
    const gk = await aesDecrypt(wrapKey, unb64url(wrap.iv), unb64url(wrap.ct), TE.encode('CIBYP-IM:GROUP:v1'));
    return b64url(gk);
  }

  // ---- tools ----
  async listConversations() {
    const data = await this.api('/api/v1/conversations');
    const convs = data.conversations || [];
    return {
      ok: true,
      conversations: convs.map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name || (c.type === 'direct' ? '私聊' : '群聊'),
        unread: c.unread || 0,
        lastAt: c.last_at || c.created_at,
        role: c.role,
      })),
    };
  }

  async readMessages({ conversationId, limit = 30, markRead = true } = {}) {
    if (!conversationId) return { ok: false, error: '缺少 conversationId' };
    const data = await this.api(`/api/v1/conversations/${conversationId}/messages?limit=${Math.min(Number(limit) || 30, 100)}`);
    const membersData = await this.api(`/api/v1/conversations/${conversationId}/members`).catch(() => ({ members: [] }));
    const members = (membersData.members || []).map((m) => ({ id: m.user.id, username: m.user.username, displayName: m.user.display_name, role: m.role }));
    const raw = data.messages || [];
    // ratchet 必须按 seq 升序解密（乱序会因 chain.count 跳跃导致小 count 消息永久失败），
    // 解密后再按服务端返回顺序（新→旧）呈现
    const decById = new Map();
    for (const m of [...raw].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))) {
      decById.set(m.id, await this._decryptCached(m));
    }
    const messages = [];
    for (const m of raw) {
      const dec = decById.get(m.id);
      const sender = members.find((x) => x.id === m.sender_id);
      messages.push({
        id: m.id,
        seq: m.seq,
        sender: sender ? (sender.displayName || sender.username) : m.sender_id,
        senderId: m.sender_id,
        type: m.msg_type,
        createdAt: m.created_at,
        text: dec ? (dec.text || '') : `[无法解密] ${m.msg_type}`,
        media: dec ? (dec.media || []) : [],
      });
    }
    if (markRead) {
      const last = data.messages && data.messages[0];
      if (last) await this.api(`/api/v1/conversations/${conversationId}/read`, {
        method: 'POST', body: JSON.stringify({ lastMessageId: last.id }),
      }).catch(() => {});
    }
    return { ok: true, conversationId, members, messages };
  }

  async sendMessage({ conversationId, text = '', msgType = 'text', media = [] } = {}) {
    if (!conversationId) return { ok: false, error: '缺少 conversationId' };
    const convs = (await this.api('/api/v1/conversations')).conversations || [];
    const conv = convs.find((c) => c.id === conversationId);
    if (!conv) return { ok: false, error: '会话不存在' };
    if (conv.type === 'group') {
      const membersData = await this.api(`/api/v1/conversations/${conversationId}/members`);
      conv.members = (membersData.members || []).map((m) => m.user);
    }
    if (conv.type === 'direct') {
      const membersData = await this.api(`/api/v1/conversations/${conversationId}/members`);
      conv.members = (membersData.members || []).map((m) => m.user);
    }
    const body = await this._encryptForConv(conv, msgType, String(text || ''), media || []);
    const res = await this.api(`/api/v1/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify(body) });
    return { ok: true, messageId: res.message.id, seq: res.message.seq, conversationId };
  }

  async searchUsers({ query, limit = 10 } = {}) {
    if (!query) return { ok: false, error: '缺少 query' };
    const data = await this.api(`/api/v1/users/search?q=${encodeURIComponent(String(query))}&limit=${Math.min(Number(limit) || 10, 50)}`);
    return { ok: true, users: (data.users || []).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, hasKeys: !!u.identity_pub })) };
  }

  async listContacts() {
    const data = await this.api('/api/v1/contacts');
    const map = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, hasKeys: !!u.identity_pub });
    return { ok: true, friends: (data.friends || []).map(map), requests: (data.requests || []).map(map), sent: (data.sent || []).map(map) };
  }

  async sendFriendRequest({ username } = {}) {
    if (!username) return { ok: false, error: '缺少对方用户名' };
    const data = await this.api('/api/v1/contacts', { method: 'POST', body: JSON.stringify({ username: String(username) }) });
    return { ok: true, mutual: !!data.mutual, message: data.mutual ? '对方也申请了你，已互加好友' : '好友申请已发送，等待对方确认' };
  }

  async acceptFriendRequest({ userId } = {}) {
    if (!userId) return { ok: false, error: '缺少 userId' };
    await this.api(`/api/v1/contacts/${userId}/accept`, { method: 'POST' });
    return { ok: true, message: '已同意好友申请' };
  }

  async getChatLog({ peer, tail = 30, markRead = true } = {}) {
    if (!peer) return { ok: false, error: '缺少对方用户名 peer' };
    const limit = Math.min(Number(tail) || 30, 100);
    const search = await this.searchUsers({ query: String(peer), limit: 50 });
    const target = (search.users || []).find((u) => u.username.toLowerCase() === String(peer).toLowerCase());
    if (!target) return { ok: false, error: `未找到用户 @${peer}` };
    const convs = (await this.api('/api/v1/conversations')).conversations || [];
    let convId = null;
    let name = '';
    for (const c of convs) {
      if (c.type !== 'direct') continue;
      const membersData = await this.api(`/api/v1/conversations/${c.id}/members`).catch(() => ({ members: [] }));
      const other = (membersData.members || []).find((m) => m.user.id === target.id);
      if (other) { convId = c.id; name = other.user.display_name || other.user.username; break; }
    }
    if (!convId) {
      return { ok: false, error: `尚未与 @${peer} 建立会话，请先使用 cibypimSendFriendRequest 加好友后通过 cibypimStartDirect 开始聊天` };
    }
    const read = await this.readMessages({ conversationId: convId, limit, markRead });
    if (!read.ok) return read;
    return { ok: true, peer: { id: target.id, username: target.username, displayName: name }, tail: limit, conversationId: convId, messages: read.messages };
  }

  async startDirect({ userId } = {}) {
    if (!userId) return { ok: false, error: '缺少 userId' };
    const data = await this.api('/api/v1/conversations', { method: 'POST', body: JSON.stringify({ type: 'direct', userIds: [userId] }) });
    return { ok: true, conversationId: data.conversation.id };
  }

  async createGroup({ name, userIds = [] } = {}) {
    if (!name) return { ok: false, error: '缺少群名称' };
    const data = await this.api('/api/v1/conversations', { method: 'POST', body: JSON.stringify({ type: 'group', name, userIds }) });
    const convId = data.conversation.id;
    // 建立群密钥并封装给所有成员
    const gk = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const wraps = {};
    const membersData = await this.api(`/api/v1/conversations/${convId}/members`);
    for (const m of (membersData.members || [])) {
      if (m.user.id === this.identity.id) continue;
      const k = await this.api(`/api/v1/users/${m.user.id}/keys`).catch(() => null);
      if (k && k.identityPub) wraps[m.user.id] = await this._wrapGroupKey(gk, k.identityPub);
    }
    this.groups.push({ id: convId, name: String(name), key: gk, wraps });
    await this.api(`/api/v1/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ msgType: 'system', ciphertext: JSON.stringify({ v: 1, k: 'gk', gid: convId, name, wraps }), mediaIds: [] }),
    });
    return { ok: true, conversationId: convId, name };
  }

  async listMembers({ conversationId } = {}) {
    if (!conversationId) return { ok: false, error: '缺少 conversationId' };
    const data = await this.api(`/api/v1/conversations/${conversationId}/members`);
    return { ok: true, members: (data.members || []).map((m) => ({ id: m.user.id, username: m.user.username, displayName: m.user.display_name, role: m.role })) };
  }

  async addMember({ conversationId, userId } = {}) {
    if (!conversationId || !userId) return { ok: false, error: '缺少 conversationId 或 userId' };
    await this.api(`/api/v1/conversations/${conversationId}/members`, { method: 'POST', body: JSON.stringify({ userId }) });
    // 为新成员封装群密钥
    const g = this.groups.find((x) => x.id === conversationId);
    if (g) {
      const k = await this.api(`/api/v1/users/${userId}/keys`).catch(() => null);
      if (k && k.identityPub) {
        g.wraps[userId] = await this._wrapGroupKey(g.key, k.identityPub);
        await this.api(`/api/v1/conversations/${conversationId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ msgType: 'system', ciphertext: JSON.stringify({ v: 1, k: 'gk', gid: conversationId, name: g.name, wraps: g.wraps }), mediaIds: [] }),
        });
      }
    }
    return { ok: true, conversationId, userId };
  }

  async removeMember({ conversationId, userId } = {}) {
    if (!conversationId || !userId) return { ok: false, error: '缺少 conversationId 或 userId' };
    await this.api(`/api/v1/conversations/${conversationId}/members/${userId}`, { method: 'DELETE' });
    const g = this.groups.find((x) => x.id === conversationId);
    if (g) {
      delete g.wraps[userId];
      // 成员变动后轮换群密钥，重新封装给剩余成员
      const membersData = await this.api(`/api/v1/conversations/${conversationId}/members`);
      const newKey = b64url(crypto.getRandomValues(new Uint8Array(32)));
      g.key = newKey;
      g.wraps = {};
      for (const m of (membersData.members || [])) {
        if (m.user.id === this.identity.id) continue;
        const k = await this.api(`/api/v1/users/${m.user.id}/keys`).catch(() => null);
        if (k && k.identityPub) g.wraps[m.user.id] = await this._wrapGroupKey(newKey, k.identityPub);
      }
      await this.api(`/api/v1/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ msgType: 'system', ciphertext: JSON.stringify({ v: 1, k: 'gk', gid: conversationId, name: g.name, wraps: g.wraps }), mediaIds: [] }),
      });
    }
    return { ok: true, conversationId, userId };
  }

  async leaveGroup({ conversationId } = {}) {
    if (!conversationId) return { ok: false, error: '缺少 conversationId' };
    await this.api(`/api/v1/conversations/${conversationId}`, { method: 'DELETE' });
    this.groups = this.groups.filter((g) => g.id !== conversationId);
    return { ok: true, conversationId };
  }

  async markRead({ conversationId, lastMessageId } = {}) {
    if (!conversationId) return { ok: false, error: '缺少 conversationId' };
    let lastId = lastMessageId;
    if (!lastId) {
      const data = await this.api(`/api/v1/conversations/${conversationId}/messages?limit=1`);
      const msgs = data.messages || [];
      if (msgs.length) lastId = msgs[0].id;
    }
    if (!lastId) return { ok: true, conversationId, alreadyEmpty: true };
    await this.api(`/api/v1/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ lastMessageId: lastId }) });
    return { ok: true, conversationId };
  }

  async getOnline({ userIds = [] } = {}) {
    if (!userIds.length) return { ok: false, error: '缺少 userIds' };
    const data = await this.api(`/api/v1/presence?userIds=${encodeURIComponent(userIds.join(','))}`);
    return { ok: true, presence: data.online || {} };
  }

  async uploadMedia({ filePath, name } = {}) {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_UPLOAD_BYTES) return { ok: false, error: '文件超过 10MB 上限（与服务端限制一致）' };
    // 客户端加密后上传（服务端只见密文）
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = TE.encode('CIBYP-IM:FILE:v1');
    const plain = fs.readFileSync(filePath);
    const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, plain));
    const fd = new FormData();
    fd.append('file', new Blob([ct], { type: 'application/octet-stream' }), 'enc.bin');
    const res = await this.api('/api/v1/media', { method: 'POST', body: fd });
    return {
      ok: true,
      media: {
        id: res.media.id,
        name: name || path.basename(filePath),
        size: stats.size,
        kind: 'file',
        key: b64url(key),
        iv: b64url(iv),
      },
    };
  }

  async downloadMedia({ mediaId, savePath, key = null, iv = null } = {}) {
    if (!mediaId) return { ok: false, error: '缺少 mediaId' };
    if (!savePath) return { ok: false, error: '缺少 savePath' };
    const res = await this.api(`/media/${mediaId}`, { raw: true });
    if (!res.ok) return { ok: false, error: '媒体下载失败' };
    const encBytes = new Uint8Array(await res.arrayBuffer());
    if (key) {
      const aesKey = await crypto.subtle.importKey('raw', unb64url(key), { name: 'AES-GCM' }, false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: unb64url(iv || ''),
        additionalData: TE.encode('CIBYP-IM:FILE:v1'),
      }, aesKey, encBytes));
      fs.writeFileSync(savePath, plain);
    } else {
      fs.writeFileSync(savePath, encBytes);
    }
    return { ok: true, savedTo: savePath, size: fs.statSync(savePath).size };
  }

  async sendFile({ conversationId, filePath, text = '' } = {}) {
    const up = await this.uploadMedia({ filePath });
    if (!up.ok) return up;
    const res = await this.sendMessage({ conversationId, msgType: 'file', text, media: [up.media] });
    return res;
  }

  async sendVoiceMessage({ conversationId, filePath, duration } = {}) {
    if (!filePath) return { ok: false, error: '缺少 filePath（语音文件，如 mp3/ogg/webm）' };
    const up = await this.uploadMedia({ filePath });
    if (!up.ok) return up;
    up.media.kind = 'voice';
    const dur = Math.max(0, Math.round(Number(duration) || 0));
    if (dur) up.media.dur = dur;
    const res = await this.sendMessage({ conversationId, msgType: 'voice', text: '', media: [up.media] });
    return res;
  }

  async searchMessages({ conversationId, keyword, limit = 50 } = {}) {
    if (!conversationId || !keyword) return { ok: false, error: '缺少 conversationId 或 keyword' };
    const data = await this.api(`/api/v1/conversations/${conversationId}/messages?limit=${Math.min(Number(limit) || 50, 100)}`);
    const membersData = await this.api(`/api/v1/conversations/${conversationId}/members`).catch(() => ({ members: [] }));
    const kw = String(keyword).toLowerCase();
    const hits = [];
    for (const m of (data.messages || [])) {
      const dec = await this._decryptCached(m);
      const text = dec ? (dec.text || '') : '';
      if (text.toLowerCase().includes(kw)) {
        const sender = (membersData.members || []).find((x) => x.user.id === m.sender_id);
        hits.push({ id: m.id, seq: m.seq, sender: sender ? (sender.user.display_name || sender.user.username) : m.sender_id, createdAt: m.created_at, text: text.slice(0, 200) });
      }
    }
    return { ok: true, keyword, hits };
  }

  async getProfile({ userId } = {}) {
    if (!userId) return { ok: false, error: '缺少 userId' };
    const data = await this.api(`/api/v1/users/${userId}`);
    const u = data.user;
    return { ok: true, user: { id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, hasKeys: !!u.identity_pub, createdAt: u.created_at } };
  }

  async updateProfile({ displayName, bio } = {}) {
    const body = {};
    if (displayName !== undefined) body.displayName = String(displayName).slice(0, 64);
    if (bio !== undefined) body.bio = String(bio).slice(0, 500);
    if (!Object.keys(body).length) return { ok: false, error: '没有可更新的字段' };
    const data = await this.api('/api/v1/me', { method: 'PATCH', body: JSON.stringify(body) });
    this.identity = data.user;
    return { ok: true, user: { id: data.user.id, username: data.user.username, displayName: data.user.display_name } };
  }

  getExportedConfig() {
    return {
      active: this.active,
      identity: this.identity,
      keys: this.keys ? [this.keys] : [],
      sessions: this.sessions,
      groups: this.groups,
    };
  }
}

Session.deserialize = (s) => new Session(s);

const TOOL_HANDLERS = {
  cibypimListConversations: CibypImService.prototype.listConversations,
  cibypimReadMessages: CibypImService.prototype.readMessages,
  cibypimSendMessage: CibypImService.prototype.sendMessage,
  cibypimSearchUsers: CibypImService.prototype.searchUsers,
  cibypimListContacts: CibypImService.prototype.listContacts,
  cibypimSendFriendRequest: CibypImService.prototype.sendFriendRequest,
  cibypimAcceptFriendRequest: CibypImService.prototype.acceptFriendRequest,
  cibypimGetChatLog: CibypImService.prototype.getChatLog,
  cibypimStartDirect: CibypImService.prototype.startDirect,
  cibypimCreateGroup: CibypImService.prototype.createGroup,
  cibypimListMembers: CibypImService.prototype.listMembers,
  cibypimAddMember: CibypImService.prototype.addMember,
  cibypimRemoveMember: CibypImService.prototype.removeMember,
  cibypimLeaveGroup: CibypImService.prototype.leaveGroup,
  cibypimMarkRead: CibypImService.prototype.markRead,
  cibypimGetOnline: CibypImService.prototype.getOnline,
  cibypimUploadMedia: CibypImService.prototype.uploadMedia,
  cibypimDownloadMedia: CibypImService.prototype.downloadMedia,
  cibypimSendFile: CibypImService.prototype.sendFile,
  cibypimSendVoiceMessage: CibypImService.prototype.sendVoiceMessage,
  cibypimSearchMessages: CibypImService.prototype.searchMessages,
  cibypimGetProfile: CibypImService.prototype.getProfile,
  cibypimUpdateProfile: CibypImService.prototype.updateProfile,
};

module.exports = { CibypImService, _crypto: { Session, genX25519, genEd25519, edSign, edVerify, xdh, b64url, unb64url } };