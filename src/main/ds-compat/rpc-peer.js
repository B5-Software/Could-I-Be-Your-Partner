/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const PREFIX = 'CIBYP_PLUGIN_RPC ';
// Symmetric, multiplexed transport over an SSH channel or ordinary process pipes.
// Cancelling one call never terminates unrelated plugin jobs or retries a mutation.
class RpcPeer {
  constructor(input, output, { request, event, close } = {}) {
    this.input = input;
    this.output = output;
    this.requestHandler = request;
    this.eventHandler = event;
    this.onClose = close;
    this.pending = new Map();
    this.active = new Map();
    this.events = Promise.resolve();
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.closed = false;
    this.receive = (bytes) => {
      this.buffer += this.decoder.write(bytes);
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024)
        return this.close(new Error('Plugin RPC frame exceeded 32 MiB'));
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.startsWith(PREFIX)) continue;
        try {
          void this.frame(JSON.parse(line.slice(PREFIX.length))).catch((error) =>
            this.close(error),
          );
        } catch (error) {
          this.close(error);
        }
      }
    };
    this.ended = () => this.close(new Error('Plugin runtime disconnected'));
    this.failed = (error) => this.close(error);
    input.on('data', this.receive);
    input.on('end', this.ended);
    input.on('error', this.failed);
    output.on('error', this.failed);
  }
  write(frame) {
    if (this.closed) throw new Error('Plugin runtime disconnected');
    this.output.write(PREFIX + JSON.stringify(frame) + '\n');
  }
  emit(name, value) {
    this.write({ type: 'event', name, value });
  }
  ask(method, args, { signal, timeoutMs = 120000 } = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let timer;
      const settle = (error, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        try {
          this.write({ type: 'cancel', id });
        } catch {}
        settle(
          signal?.reason || Object.assign(new Error('Plugin RPC timed out'), { code: 'TIMEOUT' }),
        );
      };
      this.pending.set(id, { settle });
      signal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(abort, timeoutMs);
      try {
        this.write({ type: 'request', id, method, args });
      } catch (error) {
        settle(error);
      }
    });
  }
  async frame(frame) {
    if (frame.type === 'event') {
      const delivered = this.events.then(() => {
        if (!this.closed) return this.eventHandler?.(frame.name, frame.value);
      });
      this.events = delivered.catch(() => {});
      await delivered;
      return;
    }
    if (frame.type === 'response') {
      this.pending
        .get(frame.id)
        ?.settle(
          frame.error
            ? Object.assign(new Error(frame.error.message), { code: frame.error.code })
            : null,
          frame.value,
        );
      return;
    }
    if (frame.type === 'cancel') {
      this.active.get(frame.id)?.abort(new Error('Plugin request cancelled'));
      return;
    }
    if (
      frame.type !== 'request' ||
      typeof frame.id !== 'string' ||
      typeof frame.method !== 'string'
    )
      return;
    const controller = new AbortController();
    this.active.set(frame.id, controller);
    let response;
    try {
      await this.events;
      if (this.closed) return;
      controller.signal.throwIfAborted();
      response = {
        value: await this.requestHandler?.(frame.method, frame.args, controller.signal),
      };
    } catch (error) {
      response = { error: { message: error.message || String(error), code: error.code } };
    } finally {
      this.active.delete(frame.id);
    }
    if (!this.closed) this.write({ type: 'response', id: frame.id, ...response });
  }
  close(error = new Error('Plugin runtime closed')) {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.receive);
    this.input.off('end', this.ended);
    for (const { settle } of this.pending.values()) settle(error);
    for (const controller of this.active.values()) controller.abort(error);
    this.active.clear();
    this.buffer = '';
    this.onClose?.(error);
  }
}
module.exports = { RpcPeer };
