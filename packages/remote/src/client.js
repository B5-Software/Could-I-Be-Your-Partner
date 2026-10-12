/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
class RemoteClient {
  constructor({
    url,
    token = '',
    fetchImpl = globalThis.fetch,
    socketFactory,
    onEvent = () => {},
    channels,
  }) {
    const address = new URL(url);
    if (
      address.username ||
      address.password ||
      address.search ||
      address.hash ||
      address.pathname !== '/' ||
      !['https:', 'http:'].includes(address.protocol) ||
      (address.protocol === 'http:' &&
        !['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname))
    )
      throw new Error('Use HTTPS for a remote instance');
    this.url = address.origin;
    this.token = token;
    this.fetch = fetchImpl;
    this.socketFactory = socketFactory;
    this.onEvent = onEvent;
    this.cursor = null;
    this.closed = true;
    this.generation = 0;
    this.retry = 0;
    this.channels = channels;
    if (channels !== undefined) this.subscribe(channels);
  }
  subscribe(channels) {
    if (
      !Array.isArray(channels) ||
      channels.length > 32 ||
      channels.some((v) => typeof v !== 'string' || v.length > 100)
    )
      throw new Error('Invalid event subscription');
    this.channels = [...channels];
    if (this.socket?.readyState === 1)
      this.socket.send(JSON.stringify({ type: 'subscribe', channels: this.channels }));
  }
  async call(method, params = {}, { id = globalThis.crypto.randomUUID(), signal } = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = await this.fetch(this.url + '/remote/v2/rpc', {
      method: 'POST',
      redirect: 'error',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      body,
      signal: signal || AbortSignal.timeout(30000),
    });
    const value = await response.json();
    if (response.status === 401) {
      this.close();
      this.onEvent({ type: 'authentication-required' });
    }
    if (!response.ok || value.error)
      throw Object.assign(new Error(value.error?.message || `HTTP ${response.status}`), {
        reason: value.error?.data?.reason,
        data: value.error?.data,
        status: response.status,
      });
    if (value.id !== id || value.jsonrpc !== '2.0') throw new Error('Invalid RPC response');
    return value.result;
  }
  async connect() {
    this.close();
    this.closed = false;
    const hello = await this.call('system.hello');
    if (hello.protocol?.major !== 2) {
      this.close();
      throw new Error('Remote v2 is required');
    }
    this.cursor = hello.cursor;
    this.open();
    return hello;
  }
  async upload(
    sessionId,
    name,
    bytes,
    { type = '', operationId = globalThis.crypto.randomUUID() } = {},
  ) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 8 * 1024 * 1024)
      throw new Error('Attachment must be bytes and at most 8 MiB');
    const sha256 = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    const query = new URLSearchParams({ sessionId, name, type, operationId, sha256 });
    const response = await this.fetch(this.url + '/remote/v2/blobs?' + query, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: 'Bearer ' + this.token,
      },
      credentials: 'include',
      redirect: 'error',
      body: bytes,
      signal: AbortSignal.timeout(60000),
    });
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error?.message || 'Upload failed'), {
        reason: value.error?.data?.reason,
      });
    return value;
  }
  async download(attachmentId) {
    const response = await this.fetch(
      this.url + '/remote/v2/blobs/' + encodeURIComponent(attachmentId),
      {
        headers: { Authorization: 'Bearer ' + this.token },
        credentials: 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok) throw new Error('Attachment download HTTP ' + response.status);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error('Attachment exceeds size limit');
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const sha256 = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    if (sha256 !== response.headers.get('X-CIBYP-SHA256'))
      throw new Error('Attachment SHA-256 mismatch');
    return bytes;
  }
  open() {
    if (this.closed || !this.socketFactory) return;
    const generation = ++this.generation;
    const parameters = new URLSearchParams();
    if (this.cursor) {
      parameters.set('streamId', this.cursor.streamId);
      parameters.set('after', this.cursor.sequence);
    }
    if (this.channels) parameters.set('channels', JSON.stringify(this.channels));
    const query = parameters.size ? '?' + parameters : '';
    const socket = this.socketFactory(
      this.url.replace(/^http/, 'ws') + '/remote/v2/events' + query,
      this.token,
    );
    this.socket = socket;
    socket.onopen = () => {
      if (generation === this.generation) this.retry = 0;
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      try {
        const value = JSON.parse(String(event.data));
        if (value.type === 'reset') {
          this.onEvent(value);
          this.cursor = value.cursor;
        } else if (value.type === 'event') {
          if (this.cursor?.streamId === value.streamId && value.sequence <= this.cursor.sequence)
            return;
          this.cursor = { streamId: value.streamId, sequence: value.sequence };
          this.onEvent(value);
        } else this.onEvent(value);
      } catch {
        this.onEvent({ type: 'protocol-error' });
        socket.close();
      }
    };
    socket.onclose = (event) => {
      if (this.closed || generation !== this.generation) return;
      if (event.code === 1008) {
        this.close();
        this.onEvent({ type: 'authentication-required' });
        return;
      }
      this.timer = setTimeout(
        () => this.open(),
        Math.min(10000, 500 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4),
      );
    };
    socket.onerror = () => {};
  }
  close() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.socket?.close();
  }
}
module.exports = { RemoteClient };
