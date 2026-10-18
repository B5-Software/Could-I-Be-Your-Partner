/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { setTimeout: delay } = require('node:timers/promises');

/** Private parent/child stdio channel: no unauthenticated monitor listener. */
class QmpClient {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.ready = new Promise((resolve, reject) => {
      this.greeting = { resolve, reject };
    }).then(() => this._send('qmp_capabilities', {}, 10000));
    this.ready.catch(() => {});
    this.greetingTimer = setTimeout(() => this.close(new Error('QMP greeting timed out')), 15000);
    this.onData = (chunk) => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 4 * 1024 * 1024)
        return this.close(new Error('QMP response exceeded the buffer limit'));
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return this.close(new Error('Invalid QMP response'));
        }
        if (message.QMP) {
          clearTimeout(this.greetingTimer);
          this.greeting.resolve();
        } else if (message.id !== undefined) {
          const request = this.pending.get(message.id);
          if (!request) continue;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.desc || message.error.class));
          else request.resolve(message.return);
        }
      }
    };
    this.onClose = () => this.close(new Error('QMP channel closed'));
    this.onError = (error) => this.close(error);
    input.on('data', this.onData);
    input.on('end', this.onClose);
    input.on('error', this.onError);
    output.on('error', this.onError);
  }

  _send(execute, args, timeoutMs) {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QMP ${execute} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.output.write(JSON.stringify({ execute, arguments: args, id }) + '\n', (error) => {
        if (error) this.close(error);
      });
    });
  }

  async command(execute, args = {}, timeoutMs = 10000) {
    await this.ready;
    return this._send(execute, args, timeoutMs);
  }

  /** QMP snapshot commands start jobs; their initial reply is not completion. */
  async snapshot(action, tag, { timeoutMs = 60000, onProgress } = {}) {
    const blocks = await this.command('query-block');
    const disks = blocks.filter((block) => block.inserted && !block.inserted.ro);
    const vmstate = disks.find((block) => block.inserted.image?.format === 'qcow2');
    if (!vmstate || disks.some((block) => block.inserted.image?.format !== 'qcow2'))
      throw new Error('VM state saving requires snapshot-capable writable disks');
    const devices = disks.map((block) => block.inserted['node-name']);
    if (devices.some((name) => !name)) throw new Error('QEMU did not expose snapshot disk nodes');
    const id = 'cibyp-' + action + '-' + ++this.sequence;
    const args = { 'job-id': id, tag, devices };
    if (action !== 'delete') args.vmstate = vmstate.inserted['node-name'];
    await this.command('snapshot-' + action, args);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = (await this.command('query-jobs')).find((row) => row.id === id);
      if (!job) throw new Error('QEMU snapshot job disappeared before completion');
      if (job.status === 'concluded') {
        await this.command('job-dismiss', { id });
        if (job.error) throw new Error(job.error);
        return;
      }
      if (job['total-progress'] && onProgress)
        onProgress(job['current-progress'] / job['total-progress']);
      await delay(100);
    }
    // Do not resume a guest while a timed-out save/load job can still mutate it.
    throw new Error('QEMU snapshot job timed out');
  }

  close(error = new Error('QMP client disposed')) {
    if (this.closed) return;
    this.closed = error;
    clearTimeout(this.greetingTimer);
    this.greeting.reject(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.input.off('data', this.onData);
    this.input.off('end', this.onClose);
    // Keep error handlers until streams close, including broken child stdin.
  }
}

module.exports = { QmpClient };
