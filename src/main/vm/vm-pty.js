/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM PTY 适配器：让"终端跑在虚拟机里"对上层（terminal-service / xterm）完全透明。
 *
 * 与 node-pty 的接口对齐（terminal-service 只用到这几个）：
 *   pid / onData(cb) / onExit(cb) / write(data) / resize(cols, rows) / kill()
 *
 * 实现要点：
 *   - 后端起 ssh2 shell 通道（真 PTY，支持窗口大小变更）
 *   - 通道就绪前的写入先入队（终端创建后立刻可能收到 write/resize/run）
 *   - 路径映射：宿主工作区路径 → VM 内 /workspace/...（工作区同步见 P2）
 */

'use strict';

const path = require('path');

/** 宿主路径 → VM 内路径（默认映射到 /workspace 下） */
function mapHostPathToVm(hostPath, { hostRoot, vmMount = '/workspace' } = {}) {
  if (!hostPath || typeof hostPath !== 'string') return vmMount;
  if (!hostRoot) return vmMount;
  try {
    const rel = path.relative(path.resolve(hostRoot), path.resolve(hostPath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return vmMount;
    return path.posix.join(vmMount, rel.split(path.sep).join('/'));
  } catch {
    return vmMount;
  }
}

/** POSIX 单引号转义（用于 cd 到含空格/特殊字符的目录） */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class VmPtyAdapter {
  /**
   * @param {object} opts { vmService, cols, rows, cwd（VM 内路径）, term }
   */
  constructor(opts = {}) {
    this.vmService = opts.vmService;
    this.cols = opts.cols || 120;
    this.rows = opts.rows || 30;
    this.term = opts.term || 'xterm-256color';
    this.cwd = opts.cwd || '/workspace';
    this.pid = 0; // 无本地 pid；VM 内进程由 ssh 通道管理
    this.closed = false;
    this.channel = null;
    this._dataCbs = [];
    this._exitCbs = [];
    this._pendingWrites = [];
    this._pendingResize = null;
    this._ready = this._open().catch((e) => {
      const msg = `\r\n\x1b[31m[虚拟机终端不可用] ${e.message}\x1b[0m\r\n`;
      this._emitData(msg);
      this._emitExit(1);
      throw e;
    });
    // 避免未处理的 rejection 噪音（_open 内部已把错误送到终端）
    this._ready.catch(() => {});
  }

  async _open() {
    const svc = this.vmService;
    if (!svc) throw new Error('虚拟机服务不可用');
    const inst = svc.instance || (await svc.start());
    if (!inst || inst.state !== 'ready') throw new Error('虚拟机未就绪');
    const channel = await inst.shell({ cols: this.cols, rows: this.rows, term: this.term });
    if (this.closed) { try { channel.close(); } catch { /* ignore */ } return; }
    this.channel = channel;
    channel.onData((d) => this._emitData(d.toString('utf8')));
    channel.onClose(() => this._emitExit(0));
    // 定位到工作目录（失败则退回 /workspace）
    channel.write(`cd ${shellQuote(this.cwd)} 2>/dev/null || cd /workspace\n`);
    // 冲刷就绪前的写入
    for (const w of this._pendingWrites) channel.write(w);
    this._pendingWrites = [];
    if (this._pendingResize) {
      const { cols, rows } = this._pendingResize;
      this._pendingResize = null;
      try { channel.resize(cols, rows); } catch { /* ignore */ }
    }
  }

  _emitData(s) {
    if (!s) return;
    for (const cb of this._dataCbs) { try { cb(s); } catch { /* ignore */ } }
  }

  _emitExit(code) {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this._exitCbs) { try { cb({ exitCode: code }); } catch { /* ignore */ } }
  }

  onData(cb) { if (typeof cb === 'function') this._dataCbs.push(cb); }
  onExit(cb) { if (typeof cb === 'function') this._exitCbs.push(cb); }

  write(data) {
    if (this.closed) return;
    if (this.channel) { try { this.channel.write(data); } catch { /* ignore */ } }
    else this._pendingWrites.push(data);
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    if (this.channel) { try { this.channel.resize(cols, rows); } catch { /* ignore */ } }
    else this._pendingResize = { cols, rows };
  }

  kill() {
    this.closed = true;
    try { if (this.channel) this.channel.close(); } catch { /* ignore */ }
    this._emitExit(0);
  }
}

module.exports = { VmPtyAdapter, mapHostPathToVm, shellQuote };
