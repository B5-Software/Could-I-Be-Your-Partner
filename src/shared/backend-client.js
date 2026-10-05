/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

class BackendClient {
  constructor({ url, token = '', fetchImpl = globalThis.fetch, socketFactory, onError = () => {} }) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Invalid backend URL');
    this.url = target.origin;
    this.token = token;
    this.fetch = fetchImpl.bind(globalThis);
    this.socketFactory = socketFactory || (address => new WebSocket(address));
    this.onError = onError;
    this.listeners = new Set();
    this.sequence = 0;
    this.closed = false;
    this.retry = 0;
    this.clientId = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    this.requestNumber = 0;
  }

  async login(password, code = '') {
    const result = await this.http('/api/login', { password, code });
    if (!result.ok) throw new Error(result.error || 'Login failed');
    this.token = result.token || '';
    return result;
  }

  async http(route, body) {
    const response = await this.fetch(this.url + route, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CIBYP-Client': '1' } : {}), ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // An Agent turn may be awaiting a person or a persistent tool job. It
      // continues in the backend; an HTTP timer must not abort its UI contract.
      signal: ['sendMessage', 'inject', 'agentAction'].includes(body?.method) ? undefined : AbortSignal.timeout(120000),
    });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || 'Backend request failed: ' + response.status);
      error.status = response.status;
      if (response.status === 401) this.emit({ type: 'authentication-required' });
      throw error;
    }
    return value;
  }

  async request(method, ...args) {
    const result = await this.http('/api/rpc', { id: this.clientId + ':' + ++this.requestNumber, method, args });
    if (result.error) throw new Error(result.error);
    return result.result;
  }

  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) { try { listener(event); } catch(error) { this.onError(error); } } }

  async connect() {
    this.closed = false;
    const snapshot = await this.request('snapshot');
    this.snapshot = snapshot;
    // Replay starts at a server watermark, then catches anything that happened
    // between the HTTP snapshot and the WebSocket subscription.
    if (Number.isInteger(snapshot.sequence)) this.sequence = snapshot.sequence;
    this.openSocket();
    return snapshot;
  }

  openSocket() {
    if (this.closed) return;
    const address = this.url.replace(/^http/, 'ws') + '/api/events?after=' + this.sequence;
    const socket = this.socketFactory(address, this.token);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      if (this.token) socket.send(JSON.stringify({ type: 'auth', token: this.token }));
    };
    socket.onmessage = event => {
      try {
        const value = JSON.parse(String(event.data));
        if (value.type === 'reset') {
          this.request('snapshot').then(snapshot => { this.sequence = snapshot.sequence; this.snapshot = snapshot; this.emit({ type: 'snapshot', snapshot }); socket.close(); }).catch(this.onError);
        } else if (value.type === 'connected') {
          this.emit({ type: 'connection', connected: true });
        } else if (value.sequence > this.sequence) {
          this.sequence = value.sequence;
          this.emit(value);
        }
      } catch (error) { this.onError(error); }
    };
    socket.onerror = () => {};
    socket.onclose = event => {
      if (this.closed) return;
      this.emit({ type: 'connection', connected: false });
      if (event.code === 1008) {
        this.closed = true;
        this.emit({ type: 'authentication-required' });
        return;
      }
      this.timer = setTimeout(() => this.openSocket(), Math.min(10000, 300 * 2 ** this.retry++));
    };
  }

  close() { this.closed = true; clearTimeout(this.timer); this.socket?.close(); this.listeners.clear(); }
}

module.exports = { BackendClient };
