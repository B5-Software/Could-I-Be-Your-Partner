/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { BackendServer } = require('./core/backend-server');
const bcrypt = require('bcryptjs');
const { TOTP, Secret } = require('otpauth');

class WebControlService {
  constructor() { this.running = false; this.port = 0; }
  attach(dispatch, eventBus, codeoss, lifecycle = {}) { this.dispatch = dispatch; this.eventBus = eventBus; this.codeoss = codeoss; this.lifecycle = lifecycle; }
  configure(config = {}) {
    const credentialsChanged = this.config && ['passwordHash', 'enable2FA', 'totpSecret'].some(key => this.config[key] !== config[key]);
    this.config = { ...config, host: config.host || '127.0.0.1', port: Number(config.port) || 3456 };
    if (this.backend) {
      this.backend.config = this.config;
      if (credentialsChanged) {
        this.backend.sessions.clear();
        for (const socket of this.backend.clients) socket.close(1008, 'Please sign in again');
      }
    }
  }
  async reconfigure(config) {
    const changed = (this.running || this.starting) && (this.config.host !== (config.host || '127.0.0.1') || this.config.port !== Number(config.port || 3456));
    if (changed) await this.stop();
    this.configure(config);
    return changed ? this.start() : this.status();
  }
  hashPassword(value) { return bcrypt.hash(value, 10); }
  async generateTOTPSecret() {
    const secret = new Secret({ size: 20 });
    const uri = new TOTP({ issuer: 'CIBYP', label: 'WebUI', secret }).toString();
    return { secret: secret.base32, uri, qrDataUrl: await require('qrcode').toDataURL(uri) };
  }
  verifyTOTP(code) {
    if (!this.config?.totpSecret) return false;
    return new TOTP({ secret: Secret.fromBase32(this.config.totpSecret) }).validate({ token: String(code), window: 1 }) !== null;
  }
  async start() {
    if (this.running) return this.status();
    if (this.starting) return this.starting;
    this.starting = this.startServer().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startServer() {
    if (!this.dispatch) throw new Error('Backend is still initializing');
    if (!this.config?.passwordHash && !this.config?.password) throw new Error('Set a WebUI access password first');
    this.startAbort = new AbortController();
    const signal = this.startAbort.signal;
    this.lifecycle?.onStarting?.();
    try {
      if (!this.config.passwordHash) this.config.passwordHash = await this.hashPassword(this.config.password);
      signal.throwIfAborted();
      await this.lifecycle?.waitUntilReady?.(signal);
      signal.throwIfAborted();
    } catch (error) {
      this.lifecycle?.onFailed?.(error);
      throw error;
    }
    this.backend = new BackendServer({ dispatch: this.dispatch, eventBus: this.eventBus, ui: true, config: this.config, codeoss: this.codeoss });
    try {
      this.address = await this.backend.start(this.config);
      signal.throwIfAborted();
      this.running = true; this.port = this.address.port;
      this.lifecycle?.onStarted?.(this.status());
      return this.status();
    } catch (error) { await this.backend.stop(); this.backend = null; this.lifecycle?.onFailed?.(error); throw error; }
  }
  async stop() { this.startAbort?.abort(); if (this.starting) await this.starting.catch(() => {}); await this.backend?.stop(); this.backend = null; this.running = false; this.lifecycle?.onStopped?.(); return this.status(); }
  status() { return { ok: true, running: this.running, starting: !!this.starting && !this.running, boot: this.lifecycle?.bootState?.(), port: this.port, host: this.config?.host || '127.0.0.1', url: this.running ? this.address.url : '', clients: this.backend?.clients.size || 0, backendPid: process.pid, addresses: this.running ? this.connectionAddresses() : [] }; }
  connectionAddresses() {
    if (this.config.host !== '0.0.0.0' && this.config.host !== '::') return [this.address.url];
    const hosts = Object.values(require('node:os').networkInterfaces()).flat().filter(row => row.family === 'IPv4' && !row.internal).map(row => row.address);
    return ['127.0.0.1', ...hosts].map(host => `http://${host}:${this.port}`);
  }
  pushVoiceEvent(channel, payload) { this.eventBus?.publish(channel, payload); }
  setVoiceCapabilities(value) { this.eventBus?.publish('voice:capabilities', value); }
}
module.exports = { WebControlService };
