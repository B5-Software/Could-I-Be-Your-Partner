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
const { StringDecoder } = require('node:string_decoder');

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
  exec(command, { timeoutMs = 300000, maxBuffer = 64 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) return reject(new Error('SSH 未连接'));
      let stdout = '', stderr = '', bytes = 0, channel, settled = false;
      const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error.stdout = stdout; error.stderr = stderr;
        reject(error);
        try { channel?.close(); } catch { /* closed */ }
      };
      const timer = timeoutMs > 0 ? setTimeout(() => {
        const error = new Error(`命令超时（${timeoutMs}ms）: ${command.slice(0, 120)}`);
        error.code = 'VM_EXEC_TIMEOUT'; fail(error);
      }, timeoutMs) : null;
      this.client.exec(command, { pty: false }, (err, stream) => {
        if (err) return fail(err);
        channel = stream;
        if (settled) { stream.on('error', () => {}); stream.close(); return; }
        const done = (code, signal) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          stdout += outDecoder.end(); stderr += errDecoder.end();
          resolve({ code, signal, stdout, stderr, ok: code === 0 });
        };
        const collect = (d, errorStream) => {
          if (settled) return;
          bytes += d.length;
          if (bytes > maxBuffer) { const error = new Error('VM command output exceeded maxBuffer; use a stream or bounded output'); error.code = 'VM_OUTPUT_LIMIT'; fail(error); return; }
          if (errorStream) stderr += errDecoder.write(d); else stdout += outDecoder.write(d);
        };
        stream.on('data', d => collect(d, false));
        stream.stderr.on('data', d => collect(d, true));
        stream.on('close', (code, signal) => done(code, signal));
        stream.on('error', fail);
      });
    });
  }

  /** 流式执行：返回 { stream, stdin, stdout, stderr, done }，用于 tar 管道等大数据传输 */
  execStream(command, {maxStderrBytes = 1024 * 1024} = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) return reject(new Error('SSH 未连接'));
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stderr = Buffer.alloc(0);
        stream.stderr.on('data', (d) => { stderr = Buffer.concat([stderr,d]); if(stderr.length > maxStderrBytes) stderr = stderr.subarray(stderr.length-maxStderrBytes); });
        const done = new Promise((res) => stream.on('close', (code) => res({ code, stderr:stderr.toString('utf8') })));
        resolve({ stream, done });
      });
    });
  }

  /**
   * 打开交互式 shell（真 PTY）。
   * @returns {Promise<{ write, resize, close, onData, onClose, ptyModes }>}
   */
  shell({ cols = 120, rows = 30, term = 'xterm-256color', cwd, shell, args } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) return reject(new Error('SSH 未连接'));
      const attach = (err, stream) => {
        if (err) return reject(err);
        resolve({
          stream,
          write: (data) => stream.write(data),
          resize: (c, r) => { try { stream.setWindow(r, c, 0, 0); } catch { /* ignore */ } },
          close: () => { try { stream.close(); } catch { /* ignore */ } },
          onData: (cb) => stream.on('data', cb),
          onClose: (cb) => stream.on('close', cb),
        });
      };
      if (cwd || shell) {
        const { shellQuote } = require('./vm-paths');
        // Start the shell in its directory before the first prompt. A missing cwd
        // fails visibly instead of silently falling back to a different directory.
        const executable = shell || 'bash';
        const parameters = args || ['-l'];
        const command = `${cwd ? `cd -- ${shellQuote(cwd)} && ` : ''}exec ${[executable, ...parameters].map(shellQuote).join(' ')}`;
        this.client.exec(command, { pty: { term, cols, rows } }, attach);
      } else this.client.shell({ term, cols, rows }, attach);
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
      // 本地 socket / SSH 通道的错误绝不能冒泡成未捕获异常：
      // 实测 VNC 客户端断开后 guest 继续推数据 → sock.write EPIPE → 打断主进程、桌面打不开。
      sock.on('error', () => { try { sock.destroy(); } catch { /* ignore */ } });
      try { sock.setNoDelay(true); } catch { /* ignore */ }
      this.client.forwardOut('127.0.0.1', sock.remotePort || 0, '127.0.0.1', guestPort, (err, stream) => {
        if (err) { try { sock.destroy(); } catch { /* ignore */ } return; }
        // ssh2 通道也会 emit 'error'（channel 被对端关闭等）——同样要兜住
        stream.on('error', () => { try { sock.destroy(); } catch { /* ignore */ } });
        sock.on('error', () => { try { stream.close(); } catch { /* ignore */ } });
        sock.pipe(stream);
        stream.pipe(sock);
        stream.on('close', () => { try { sock.destroy(); } catch { /* ignore */ } });
        sock.on('close', () => { try { stream.close(); } catch { /* ignore */ } });
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(hostPort || 0, '127.0.0.1', resolve);
    });
    // listen 成功后的服务器级错误（socket 处理之外的）同样兜住，避免未捕获异常
    server.on('error', () => { /* ignore */ });
    const actual = server.address().port;
    const entry = { hostPort: actual, close: () => { try { server.close(); } catch { /* ignore */ } this._forwards.delete(entry); } };
    this._forwards.add(entry);
    return entry;
  }
}

module.exports = { VmSsh };
