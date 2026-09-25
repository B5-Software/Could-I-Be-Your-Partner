/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 的 SSH 通道（ssh2，纯 JS 无原生依赖）：
 *   exec     —— 命令执行（stdout/stderr/退出码），也支持流式管道（tar 同步用）
 *   shell    —— 真 PTY（支持窗口大小变更），终端面板用
 *   sftp     —— 文件读写/列举/删除（isolated 模式按需拉取、shared 模式单文件补传）
 *   forward  —— 把 guest 内服务映射到宿主（端口预览）
 *
 * 与 QEMU hostfwd 的关系：QEMU 把 guest:22 转发到宿主 127.0.0.1:<port>，
 * 本模块只连 loopback，不感知虚拟机内部网络。
 */

'use strict';

const { EventEmitter } = require('events');
const { Client } = require('ssh2');

class VmSsh extends EventEmitter {
  /**
   * @param {object} opts { host, port, username, privateKey, readyTimeoutMs, keepaliveMs }
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port;
    this.username = opts.username || 'cibyp';
    this.privateKey = opts.privateKey;
    this.readyTimeoutMs = opts.readyTimeoutMs || 20000;
    this.keepaliveMs = opts.keepaliveMs || 15000;
    this.client = null;
    this.connected = false;
    this._lastError = null;
    this._forwards = new Set();
  }

  get lastError() { return this._lastError; }

  /** 建立连接（幂等：已连接直接返回） */
  connect() {
    if (this.connected) return Promise.resolve(this);
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      const c = new Client();
      this.client = c;
      c.on('ready', () => {
        this.connected = true;
        this.emit('ready');
        resolve(this);
      });
      c.on('error', (err) => {
        this._lastError = err;
        // 只有在有人监听时才转发 error：EventEmitter 对无监听的 'error' 会直接抛出
        if (this.listenerCount('error') > 0) this.emit('error', err);
        if (!this.connected) reject(err);
      });
      c.on('close', () => {
        this.connected = false;
        this.emit('close');
      });
      c.on('end', () => this.emit('end'));
      c.connect({
        host: this.host,
        port: this.port,
        username: this.username,
        privateKey: this.privateKey,
        readyTimeout: this.readyTimeoutMs,
        keepaliveInterval: this.keepaliveMs,
        keepaliveCountMax: 4,
        // 只做密钥认证
        tryKeyboard: false,
      });
    }).finally(() => { this._connecting = null; });
    return this._connecting;
  }

  disconnect() {
    for (const f of this._forwards) { try { f.close(); } catch { /* ignore */ } }
    this._forwards.clear();
    try { this.client && this.client.end(); } catch { /* ignore */ }
    this.connected = false;
  }

  /** 等待连接可用（内部做指数退避重试，用于开机等待） */
  async waitReady({ timeoutMs = 120000, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let lastErr = null;
    while (Date.now() < deadline) {
      attempt++;
      try {
        await this.connect();
        return true;
      } catch (e) {
        lastErr = e;
        this.connected = false;
        await new Promise((r) => setTimeout(r, Math.min(intervalMs * attempt, 4000)));
      }
    }
    const err = new Error(`SSH 未在 ${timeoutMs}ms 内就绪: ${lastErr ? lastErr.message : 'unknown'}`);
    err.code = 'VM_SSH_TIMEOUT';
    throw err;
  }

  /** 执行命令，收集输出 */
  exec(command, { timeoutMs = 300000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) return reject(new Error('SSH 未连接'));
      this.client.exec(command, { pty: false }, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let timer = null;
        const done = (code, signal) => {
          if (timer) clearTimeout(timer);
          resolve({ code, signal, stdout, stderr, ok: code === 0 });
        };
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try { stream.close(); } catch { /* ignore */ }
            const e = new Error(`命令超时（${timeoutMs}ms）: ${command.slice(0, 120)}`);
            e.code = 'VM_EXEC_TIMEOUT';
            e.stdout = stdout;
            e.stderr = stderr;
            reject(e);
          }, timeoutMs);
        }
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        stream.on('close', (code, signal) => done(code, signal));
        stream.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
      });
    });
  }

  /** 流式执行：返回 { stream, stdin, stdout, stderr, done }，用于 tar 管道等大数据传输 */
  execStream(command) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) return reject(new Error('SSH 未连接'));
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stderr = '';
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        const done = new Promise((res) => stream.on('close', (code) => res({ code, stderr })));
        resolve({ stream, done });
      });
    });
  }

  /**
   * 打开交互式 shell（真 PTY）。
   * @returns {Promise<{ write, resize, close, onData, onClose, ptyModes }>}
   */
  shell({ cols = 120, rows = 30, term = 'xterm-256color' } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) return reject(new Error('SSH 未连接'));
      this.client.shell({ term, cols, rows }, (err, stream) => {
        if (err) return reject(err);
        resolve({
          stream,
          write: (data) => stream.write(data),
          resize: (c, r) => { try { stream.setWindow(r, c, 0, 0); } catch { /* ignore */ } },
          close: () => { try { stream.close(); } catch { /* ignore */ } },
          onData: (cb) => stream.on('data', cb),
          onClose: (cb) => stream.on('close', cb),
        });
      });
    });
  }

  /** 惰性获取 sftp 会话（Promise 化常用操作） */
  async sftp() {
    if (this._sftp) return this._sftp;
    const raw = await new Promise((resolve, reject) => {
      if (!this.client || !this.connected) return reject(new Error('SSH 未连接'));
      this.client.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    const wrap = (fn) => (...args) => new Promise((resolve, reject) => {
      raw[fn](...args, (err, result) => (err ? reject(err) : resolve(result)));
    });
    this._sftp = {
      raw,
      readFile: wrap('readFile'),
      writeFile: wrap('writeFile'),
      readdir: wrap('readdir'),
      stat: wrap('stat'),
      lstat: wrap('lstat'),
      unlink: wrap('unlink'),
      mkdir: wrap('mkdir'),
      rmdir: wrap('rmdir'),
      rename: wrap('rename'),
      realpath: wrap('realpath'),
      fastPut: wrap('fastPut'),
      fastGet: wrap('fastGet'),
      createReadStream: (p, o) => raw.createReadStream(p, o),
      createWriteStream: (p, o) => raw.createWriteStream(p, o),
      end: () => { try { raw.end(); } catch { /* ignore */ } this._sftp = null; },
    };
    return this._sftp;
  }

  /**
   * 把 guest 内服务映射到宿主 loopback（端口预览）。
   * @param {number} guestPort
   * @param {number|null} hostPort 为空时由系统分配
   * @returns {Promise<{ hostPort, close() }>}
   */
  async forwardToHost(guestPort, hostPort = null) {
    const net = require('net');
    const server = net.createServer((sock) => {
      this.client.forwardOut('127.0.0.1', sock.remotePort || 0, '127.0.0.1', guestPort, (err, stream) => {
        if (err) { sock.destroy(); return; }
        sock.pipe(stream).pipe(sock);
        stream.on('close', () => sock.destroy());
        sock.on('close', () => stream.close());
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(hostPort || 0, '127.0.0.1', resolve);
    });
    const actual = server.address().port;
    const entry = { hostPort: actual, close: () => { try { server.close(); } catch { /* ignore */ } this._forwards.delete(entry); } };
    this._forwards.add(entry);
    return entry;
  }
}

module.exports = { VmSsh };
