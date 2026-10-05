/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const express = require('express');
const expressWs = require('express-ws');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { TOTP, Secret } = require('otpauth');

const ROOT = path.resolve(__dirname, '../../..');

class BackendServer {
  constructor({ dispatch, eventBus, token = '', ui = false, config = {}, codeoss }) {
    this.dispatch = dispatch;
    this.eventBus = eventBus;
    this.token = token;
    this.ui = ui;
    this.config = config;
    this.codeoss = codeoss;
    this.sequence = 0;
    this.events = [];
    this.eventBytes = 0;
    this.clients = new Set();
    this.upgradedSockets = new Set();
    this.sessions = new Map();
    this.requests = new Map();
    this.attempts = new Map();
  }

  authorized(req) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const cookie = /(?:^|;\s*)cibyp_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const candidate = bearer || cookie || '';
    if (
      this.token &&
      candidate.length === this.token.length &&
      crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token))
    )
      return true;
    const session = this.sessions.get(candidate);
    if (!session || session.expires < Date.now()) {
      this.sessions.delete(candidate);
      return false;
    }
    return true;
  }

  revoke(token) {
    this.sessions.delete(token);
    for (const socket of this.clients)
      if (socket.authToken === token) socket.close(1008, 'Session ended');
  }

  validOrigin(req) {
    if (!req.headers.origin) return true;
    try {
      return new URL(req.headers.origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  publish(channel, payload) {
    // Raw model transport is internal; clients receive the normalized Agent
    // callbacks instead. Do not retain two copies of each streamed token.
    if (/^llm:/.test(channel)) return;
    let encoded;
    try {
      encoded = JSON.stringify({ sequence: ++this.sequence, channel, payload });
    } catch {
      return;
    }
    this.events.push({ sequence: this.sequence, encoded });
    this.eventBytes += Buffer.byteLength(encoded);
    while (this.events.length > 2048 || this.eventBytes > 4 * 1024 * 1024)
      this.eventBytes -= Buffer.byteLength(this.events.shift().encoded);
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue;
      if (ws.bufferedAmount > 4 * 1024 * 1024) ws.close(1013, 'Reconnect to refresh');
      else ws.send(encoded);
    }
  }

  async start({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.server) return this.address;
    const app = express();
    const ws = expressWs(app);
    app.disable('x-powered-by');
    if (this.codeoss)
      app.use('/codeoss', (req, res) => {
        req.url = req.originalUrl;
        this.codeoss.proxy(req, res);
      });
    app.use(express.json({ limit: '16mb' }));
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!this.validOrigin(req)) return res.status(403).json({ error: 'Untrusted origin' });
      next();
    });
    app.get('/api/health', (_req, res) =>
      res.json({ ok: true, service: 'cibyp-backend', protocol: 1 }),
    );
    app.post('/api/login', async (req, res) => {
      const ip = req.socket.remoteAddress;
      const attempt = this.attempts.get(ip) || { count: 0, until: Date.now() + 60000 };
      if (attempt.until < Date.now()) {
        attempt.count = 0;
        attempt.until = Date.now() + 60000;
      }
      if (++attempt.count > 10)
        return res.status(429).json({ error: 'Too many login attempts; try again in one minute' });
      this.attempts.set(ip, attempt);
      const { password, code } = req.body || {};
      let valid =
        typeof password === 'string' &&
        password.length < 4096 &&
        !!this.config.passwordHash &&
        (await bcrypt.compare(password, this.config.passwordHash));
      if (valid && this.config.enable2FA) {
        try {
          valid =
            new TOTP({
              secret: Secret.fromBase32(this.config.totpSecret),
              digits: 6,
              period: 30,
            }).validate({ token: String(code || ''), window: 1 }) !== null;
        } catch {
          valid = false;
        }
      }
      if (!valid) return res.status(401).json({ error: 'Invalid password or verification code' });
      const token = crypto.randomBytes(32).toString('hex');
      for (const [key, value] of this.sessions)
        if (value.expires < Date.now()) this.sessions.delete(key);
      if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value);
      this.sessions.set(token, { expires: Date.now() + 86400000 });
      this.attempts.delete(ip);
      res.setHeader(
        'Set-Cookie',
        'cibyp_session=' +
          token +
          '; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400' +
          (req.secure ? '; Secure' : ''),
      );
      res.json({ ok: true, token });
    });
    app.post('/api/logout', (req, res) => {
      const token =
        String(req.headers.authorization || '').replace(/^Bearer /, '') ||
        /cibyp_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      this.revoke(token);
      res.setHeader('Set-Cookie', 'cibyp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      res.json({ ok: true });
    });
    app.post('/api/rpc', async (req, res) => {
      if (!this.authorized(req)) return res.status(401).json({ error: 'Authentication required' });
      if (req.headers['x-cibyp-client'] !== '1')
        return res.status(403).json({ error: 'Client header required' });
      const body = req.body || {};
      if (typeof body.id !== 'string' || body.id.length > 160)
        return res.status(400).json({ error: 'Request ID required' });
      // Include the payload in the identity check. A reused ID must not silently
      // turn a different command into the result of an earlier command.
      const signature = JSON.stringify([body.method, body.args]);
      const prior = this.requests.get(body.id);
      if (prior && prior.signature !== signature)
        return res.status(409).json({ error: 'Request ID reused with different arguments' });
      let entry = prior;
      if (!entry) {
        if ([...this.requests.values()].filter((value) => value.pending).length >= 64)
          return res.status(429).json({ error: 'Too many pending requests' });
        const sequence = this.sequence;
        entry = { signature, at: Date.now(), pending: true };
        entry.promise = Promise.resolve()
          .then(() => this.dispatch(body))
          .then(
            (result) => ({ result: body.method === 'snapshot' ? { ...result, sequence } : result }),
            (error) => ({ error: error.message }),
          )
          .finally(() => {
            entry.pending = false;
          });
        this.requests.set(body.id, entry);
        for (const [id, value] of this.requests)
          if (!value.pending && (this.requests.size > 512 || value.at < Date.now() - 600000))
            this.requests.delete(id);
      }
      res.json(await entry.promise);
    });
    app.ws('/api/events', (socket, req) => {
      if (!this.validOrigin(req)) return socket.close(1008, 'Untrusted origin');
      let authenticated = false;
      const authenticate = () => {
        if (authenticated || !this.authorized(req)) return;
        authenticated = true;
        socket.authToken =
          String(req.headers.authorization || '').replace(/^Bearer /, '') ||
          /(?:^|;\s*)cibyp_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        clearTimeout(timer);
        const after = Math.max(0, Number(req.query.after) || 0);
        if (after > this.sequence || (this.events.length && after < this.events[0].sequence - 1))
          socket.send(JSON.stringify({ type: 'reset' }));
        else
          for (const event of this.events) if (event.sequence > after) socket.send(event.encoded);
        this.clients.add(socket);
        socket.send(JSON.stringify({ type: 'connected' }));
      };
      const timer = setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
      const expiryTimer = setInterval(() => {
        if (authenticated && !this.authorized(req)) socket.close(1008, 'Session expired');
      }, 30000);
      expiryTimer.unref();
      authenticate();
      socket.on('message', (data) => {
        if (authenticated || data.length > 4096) return;
        try {
          const value = JSON.parse(String(data));
          if (value.type === 'auth') {
            req.headers.authorization = 'Bearer ' + value.token;
            authenticate();
          }
        } catch {
          socket.close(1008);
        }
      });
      socket.on('close', () => {
        clearTimeout(timer);
        clearInterval(expiryTimer);
        this.clients.delete(socket);
      });
    });
    if (this.ui) {
      app.get('/src/renderer/css/motion.css', (_req, res) =>
        res.sendFile(path.join(ROOT, 'src/renderer/css/motion.css')),
      );
      app.get('/login', (_req, res) =>
        res.sendFile(path.join(ROOT, 'src/renderer/pages/backend-login.html')),
      );
      app.get('/', (_req, res) => res.redirect('/src/renderer/pages/index.html'));
      app.use((req, res, next) => (this.authorized(req) ? next() : res.redirect('/login')));
      app.get('/src/renderer/pages/index.html', (_req, res) => {
        const html = fs
          .readFileSync(path.join(ROOT, 'src/renderer/pages/index.html'), 'utf8')
          .replace(
            '<head>',
            '<head>\n<script>window.cibypPlatform=' +
              JSON.stringify(process.platform) +
              ';</script><script src="/src/preload/generated/browser-preload.js"></script>',
          );
        res.type('html').send(html);
      });
      for (const directory of [
        'src/renderer',
        'src/shared',
        'src/agent',
        'src/data',
        'src/preload/generated',
        'assets/fonts',
        'assets/ui-fonts',
        'assets/webfonts',
        'assets/icons',
        'assets/geogebra',
      ])
        app.use('/' + directory, express.static(path.join(ROOT, directory), { dotfiles: 'deny' }));
      // Only browser dependencies, never the backend source or native modules.
      for (const directory of [
        'katex/dist',
        '@xterm/xterm',
        '@xterm/addon-fit',
        'monaco-editor/min',
      ])
        app.use(
          '/node_modules/' + directory,
          express.static(path.join(ROOT, 'node_modules', directory)),
        );
    }
    app.use((error, _req, res, _next) => res.status(400).json({ error: error.message }));
    await new Promise((resolve, reject) => {
      const server = app.listen(port, host, resolve);
      server.once('error', reject);
      this.server = server;
      if (this.codeoss) {
        const handlers = server.listeners('upgrade');
        server.removeAllListeners('upgrade');
        server.on('upgrade', (req, socket, head) => {
          if (req.url.startsWith('/codeoss/')) {
            this.upgradedSockets.add(socket);
            socket.once('close', () => this.upgradedSockets.delete(socket));
            this.codeoss.upgrade(req, socket, head);
          } else for (const handler of handlers) handler.call(server, req, socket, head);
        });
      }
    });
    this.wss = ws.getWss();
    this.address = {
      host,
      port: this.server.address().port,
      url:
        'http://' +
        (host.includes(':') ? '[' + host + ']' : host) +
        ':' +
        this.server.address().port,
    };
    this.unsubscribe = this.eventBus.addSink((channel, payload) => this.publish(channel, payload));
    return this.address;
  }

  async stop() {
    this.unsubscribe?.();
    for (const socket of this.wss?.clients || []) socket.terminate();
    for (const socket of this.upgradedSockets) socket.destroy();
    this.upgradedSockets.clear();
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((resolve) => this.server.close(resolve));
    }
    this.server = null;
    this.sessions.clear();
    this.requests.clear();
    this.events.length = 0;
    this.eventBytes = 0;
  }
}

module.exports = { BackendServer };
