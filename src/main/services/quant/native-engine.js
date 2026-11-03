/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// One owned native PAPER process per shared backend. Never sign, connect a
// socket, retry a mutation, or inherit model/provider/wallet credentials here.
const fs = require('node:fs'),
  path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const MAX_FRAME = 1024 * 1024;
const mutations = new Set([
  'execution.create',
  'execution.start',
  'execution.stop',
  'execution.claim',
  'execution.report',
  'market.trade',
  'strategy.define',
  'strategy.start',
  'strategy.stop',
  'order.submit',
  'order.cancel',
  'account.create',
  'account.enable',
  'account.pause',
  'account.halt',
  'account.reset-halt',
  'instrument.register',
  'enable',
  'pause',
]);
const publicMethods = new Set([
  'instrument.get',
  'strategy.view',
  'strategy.define',
  'strategy.get',
  'strategy.list',
  'strategy.start',
  'strategy.stop',
  'strategy.runs',
  'strategy.decisions',
  'status',
  'instrument.register',
  'account.create',
  'account.get',
  'portfolio.view',
  'accounts',
  'executions',
  'account.enable',
  'account.pause',
  'account.halt',
  'account.reset-halt',
  'order.submit',
  'order.cancel',
  'order.get',
  'orders',
  'book',
  'enable',
  'pause',
]);
const error = (code) => Object.assign(new Error(code), { code });
class NativeEngine {
  constructor({
    directory,
    publish = () => {},
    binaryPath,
    spawnImpl = spawn,
    timeout = 30000,
    replay = false,
  } = {}) {
    this.directory = directory;
    this.publish = publish;
    this.binaryPath = binaryPath;
    this.spawnImpl = spawnImpl;
    this.timeout = timeout;
    this.replay = replay === true;
    this.feedObservers = new Set();
    this.state = 'stopped';
    this.child = null;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.lastError = null;
    this.handshake = null;
    this.disposed = false;
  }
  resolve() {
    let binary = this.binaryPath || process.env.CIBYP_QUANT_ENGINE_BIN;
    const resources = process.resourcesPath || process.env.CIBYP_PACKAGED_RESOURCES;
    if (!binary && resources) {
      const folder = path.join(resources, 'quant-engine');
      if (fs.existsSync(folder)) {
        try {
          return require('./native-binary').resolveManaged(
            resources,
            path.join(this.directory, 'runtime-cache'),
          );
        } catch (e) {
          throw error(/^NATIVE_[A-Z_]+$/.test(e.code || '') ? e.code : 'NATIVE_MANIFEST_INVALID');
        }
      }
      if (process.env.CIBYP_PACKAGED_RESOURCES || fs.existsSync(path.join(resources, 'app.asar')))
        throw error('NATIVE_BINARY_UNAVAILABLE');
    }
    if (!binary) {
      const root =
        path.basename(__dirname) === 'node-core'
          ? path.resolve(__dirname, '../..')
          : path.resolve(__dirname, '../../../..');
      if (fs.existsSync(path.join(root, 'native/quant-engine/Cargo.toml'))) {
        binary = require('./native-binary').developmentBinary(root);
      }
    }
    if (!binary || !fs.existsSync(binary)) throw error('NATIVE_BINARY_UNAVAILABLE');
    binary = path.resolve(binary);
    const stat = fs.lstatSync(binary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw error('NATIVE_BINARY_INVALID');
    const sha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    return { binary, development: true, sha256 };
  }
  inspect() {
    let executable;
    try {
      executable = this.resolve();
    } catch (e) {
      return {
        available: false,
        state: this.state,
        reason: e.code || 'NATIVE_BINARY_UNAVAILABLE',
        lastError: this.lastError,
        mode: this.replay ? 'replay' : 'paper',
        liveExecution: false,
      };
    }
    return {
      available: true,
      state: this.state,
      development: executable.development,
      sha256: executable.sha256,
      protocol: 1,
      mode: this.replay ? 'replay' : 'paper',
      liveExecution: false,
      ...(this.handshake
        ? { version: this.handshake.version, ...(this.child ? { pid: this.handshake.pid } : {}) }
        : {}),
      lastError: this.lastError,
    };
  }
  emit() {
    try {
      this.publish({ type: 'quant-native-changed', native: this.inspect() });
    } catch {
      /* A disconnected observer cannot interrupt the execution process. */
    }
  }
  async start() {
    if (this.disposed) throw error('NATIVE_DISPOSED');
    if (this.starting) return this.starting;
    if (this.state === 'connected') return this.inspect();
    if (this.state === 'stopping') throw error('NATIVE_STOPPING');
    this.starting = Promise.resolve().then(() => this.launch());
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  async launch() {
    if (this.disposed) throw error('NATIVE_DISPOSED');
    const executable = this.resolve();
    if (!this.directory || !path.isAbsolute(this.directory)) throw error('NATIVE_STORAGE_INVALID');
    const token = randomBytes(32).toString('hex'),
      environment = { CIBYP_ENGINE_TOKEN: token };
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'])
      if (process.env[key]) environment[key] = process.env[key];
    this.state = 'starting';
    this.lastError = null;
    this.buffer = Buffer.alloc(0);
    this.handshake = null;
    this.emit();
    let child;
    try {
      child = this.spawnImpl(
        executable.binary,
        [...(this.replay ? ['--replay'] : []), '--data-dir', this.directory],
        {
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
          cwd: path.dirname(executable.binary),
        },
      );
    } catch {
      this.state = 'failed';
      this.lastError = 'NATIVE_START_FAILED';
      this.emit();
      throw error(this.lastError);
    }
    this.child = child;
    child.stdin.on('error', () => this.fail(child, 'NATIVE_CONNECTION_LOST'));
    child.stdout.on('error', () => this.fail(child, 'NATIVE_CONNECTION_LOST'));
    child.stderr.on('error', () => {});
    child.stdout.on('data', (bytes) => this.receive(child, bytes));
    child.stderr.on('data', () => {}); // Do not leak native diagnostics or data to an LLM.
    child.on('error', () => this.fail(child, 'NATIVE_START_FAILED'));
    child.on('exit', () => {
      if (this.child !== child) return;
      if (this.state === 'stopping') {
        this.child = null;
        this.state = 'stopped';
        this.rejectPending('NATIVE_CONNECTION_LOST');
        this.emit();
      } else this.fail(child, 'NATIVE_PROCESS_EXITED');
    });
    try {
      const hello = await this.request('hello', { protocol: 1, token }, true);
      if (
        hello.protocol !== 1 ||
        hello.mode !== (this.replay ? 'replay' : 'paper') ||
        hello.liveExecution !== false
      )
        throw error('NATIVE_PROTOCOL_MISMATCH');
      if (executable.manifest && hello.version !== executable.manifest.engineVersion)
        throw error('NATIVE_PROTOCOL_MISMATCH');
      if (this.child !== child || this.disposed) throw error('NATIVE_CONNECTION_LOST');
      this.handshake = hello;
      this.state = 'connected';
      this.emit();
      return this.inspect();
    } catch (e) {
      this.fail(child, e.code || 'NATIVE_START_FAILED');
      throw e;
    }
  }
  receive(child, bytes) {
    if (this.child !== child) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    let end;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      const frame = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (frame.length > MAX_FRAME) {
        this.fail(child, 'NATIVE_FRAME_LIMIT');
        return;
      }
      let message;
      try {
        message = JSON.parse(frame.toString('utf8'));
        if (
          ['strategy', 'execution'].includes(message?.event) &&
          message.protocol === 1 &&
          /^\d{1,20}$/.test(message.generation) &&
          typeof message.faulted === 'boolean'
        ) {
          if (message.faulted && this.lastError !== 'NATIVE_STORAGE_FAULT') {
            this.lastError = 'NATIVE_STORAGE_FAULT';
            this.emit();
          }
          try {
            this.publish({
              type:
                message.event === 'execution'
                  ? 'quant-native-execution-changed'
                  : 'quant-native-strategies-changed',
              generation: message.generation,
              faulted: message.faulted,
            });
          } catch {
            /* Observers do not own execution. */
          }
          continue;
        }
        if (!message || typeof message.id !== 'string' || typeof message.ok !== 'boolean')
          throw Error();
      } catch {
        this.fail(child, 'NATIVE_PROTOCOL_ERROR');
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.fail(child, 'NATIVE_UNEXPECTED_RESPONSE');
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else {
        const code = /^[A-Z_0-9]{1,80}$/.test(message.error?.code || '')
          ? message.error.code
          : 'NATIVE_OPERATION_FAILED';
        if (code === 'DURABLE_COMMIT_FAILED') {
          this.lastError = 'NATIVE_STORAGE_FAULT';
          pending.reject(
            error(
              mutations.has(pending.method) ? 'NATIVE_OUTCOME_UNKNOWN' : 'NATIVE_STORAGE_FAULT',
            ),
          );
          this.emit();
        } else pending.reject(Object.assign(error(code), { definitive: true }));
      }
    }
    if (this.buffer.length > MAX_FRAME) this.fail(child, 'NATIVE_FRAME_LIMIT');
  }
  rejectPending(code) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error(mutations.has(entry.method) ? 'NATIVE_OUTCOME_UNKNOWN' : code));
    }
    this.pending.clear();
  }
  fail(child, code) {
    if (this.child !== child) return;
    this.child = null;
    this.state = 'failed';
    this.lastError = code;
    this.handshake = null;
    this.rejectPending(code);
    this.buffer = Buffer.alloc(0);
    child.stdin.destroy();
    try {
      child.kill();
    } catch {
      /* Already gone; pending mutations still remain unknown. */
    }
    this.emit();
  }
  request(method, params = {}, internal = false) {
    const child = this.child;
    if (!child || (!internal && this.state !== 'connected'))
      return Promise.reject(error('NATIVE_NOT_RUNNING'));
    if (this.pending.size >= 128) return Promise.reject(error('NATIVE_BACKPRESSURE'));
    let frame;
    const id = randomUUID();
    try {
      frame = Buffer.from(JSON.stringify({ id, method, params }) + '\n');
    } catch {
      return Promise.reject(error('NATIVE_INVALID_PARAMS'));
    }
    if (frame.length > MAX_FRAME) return Promise.reject(error('NATIVE_FRAME_LIMIT'));
    if (child.stdin.writableLength + frame.length > 4 * MAX_FRAME)
      return Promise.reject(error('NATIVE_BACKPRESSURE'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, 'NATIVE_REQUEST_TIMEOUT'), this.timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(frame, (e) => {
        if (e) this.fail(child, 'NATIVE_CONNECTION_LOST');
      });
    });
  }
  call(method, params) {
    if (!publicMethods.has(method)) return Promise.reject(error('NATIVE_METHOD_UNAVAILABLE'));
    return this.request(method, params);
  }
  // Private control-plane capability. Financial reports are intentionally absent
  // from call(), frontend requests, Agent tools and the offline replay protocol.
  execution(action, params) {
    if (this.replay) return Promise.reject(error('REPLAY_EXECUTION_DISABLED'));
    if (action === 'hold' && this.handshake?.executionHalt !== 1)
      return Promise.reject(error('NATIVE_LIVE_STOP_UNAVAILABLE'));
    if (
      ![
        'create',
        'get',
        'list',
        'pending',
        'commands',
        'start',
        'stop',
        'claim',
        'report',
        'hold',
      ].includes(action)
    )
      return Promise.reject(error('NATIVE_METHOD_UNAVAILABLE'));
    if (![1, 2].includes(this.handshake?.executionOutbox))
      return Promise.reject(error('NATIVE_EXECUTION_OUTBOX_UNAVAILABLE'));
    return this.request('execution.' + action, params);
  }
  feed(method, params) {
    if (!['market.snapshot', 'market.delta', 'market.trade', 'market.invalidate'].includes(method))
      return Promise.reject(error('NATIVE_FEED_UNAVAILABLE'));
    for (const observer of this.feedObservers) {
      try {
        observer(method, params);
      } catch {
        /* Recorder reports its own failure. */
      }
    }
    return this.request(method, params);
  }
  onFeed(observer) {
    this.feedObservers.add(observer);
    return () => this.feedObservers.delete(observer);
  }
  replayStep(params) {
    if (!this.replay) return Promise.reject(error('REPLAY_CLOCK_REQUIRED'));
    return this.request('replay.step', params);
  }
  async stop() {
    if (this.starting) {
      try {
        await this.starting;
      } catch {}
    }
    if (!this.child || this.state === 'stopping') return this.inspect();
    this.state = 'stopping';
    this.emit();
    const child = this.child;
    try {
      await this.request('shutdown', {}, true);
      child.stdin.end();
    } catch {
      this.fail(child, 'NATIVE_STOP_FAILED');
    }
    return this.inspect();
  }
  dispose() {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    void this.stop();
    const timer = setTimeout(() => this.fail(child, 'NATIVE_SHUTDOWN_TIMEOUT'), 5000);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  }
}
module.exports = { NativeEngine, MAX_FRAME };
