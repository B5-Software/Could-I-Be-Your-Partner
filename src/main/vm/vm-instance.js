/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 实例生命周期（P1 核心）：
 *   start()  —— 检查资产 → 建 overlay → 起 cloud-init 服务 → 起 QEMU → 等 SSH → 等 cloud-init → ready
 *   stop()   —— SSH 优雅关机，超时兜底杀进程
 *   reset()  —— 删除 overlay（回到出厂态；shared 模式下工作区数据在宿主，不受影响）
 *   exec/shell/sftp —— 代理到 vm-ssh
 *
 * 状态机：idle → checking → booting → preparing → ready → stopping → idle | failed
 * 事件：'state'（含进度百分比与文本）、'serial'（串口行）、'error'
 *
 * 串口缓冲区常驻内存（环形），供 Splash/设置页的排障面板展示。
 */

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const qemuRuntime = require('./qemu-runtime');
const provision = require('./vm-provision');
const { VmSsh } = require('./vm-ssh');

const SERIAL_RING_BYTES = 64 * 1024;
const STATES = ['idle', 'checking', 'booting', 'preparing', 'ready', 'stopping', 'failed'];

class VmInstance extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.assetsDir    资源根目录（QEMU pack / 镜像 / overlay 都在这下面）
   * @param {string} opts.imagePath    基础镜像 qcow2
   * @param {string} opts.kernelPath   内核 vmlinuz
   * @param {string} opts.initrdPath   initrd
   * @param {string} [opts.variant]    镜像变体（base/desktop/full），仅记录用途
   * @param {string} [opts.version]    镜像版本，仅记录用途
   * @param {object} [opts.config]     运行参数：smp/memMB/netMode/shutdownOnExit/timezone
   * @param {number} [opts.sshPort]    固定 SSH 端口（默认自动分配）
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.assetsDir = opts.assetsDir;
    this.config = Object.assign({
      smp: 4,
      memMB: 4096,
      netMode: 'nat',
      timezone: provision.DEFAULT_TIMEZONE,
      bootTimeoutMs: 180000,
      cloudInitTimeoutMs: 300000,
      shutdownOnExit: true,
      tcg: false,
    }, opts.config || {});

    this.state = 'idle';
    this.stateDetail = null;
    this.progress = 0;
    this.child = null;
    this.exit = null;
    this.ssh = null;
    this.accel = null;
    this.ciServer = null;
    this.serialBuf = '';
    this.serialClient = null;
    this.startedAt = null;
    this.lastError = null;
    this._accelCache = null;
    this._starting = null;
    this.ports = { ssh: null, serial: null };

    this.guestArch = qemuRuntime.guestArchOf(process.arch);
    this.dir = this.assetsDir ? path.join(this.assetsDir, 'instances', this.opts.instanceName || 'default') : null;
    this.overlayPath = this.dir ? path.join(this.dir, 'overlay.qcow2') : null;
    this.instanceFile = this.dir ? path.join(this.dir, 'instance.json') : null;
  }

  // ---------------------------------------------------------------- 状态

  _setState(state, detail = null, progress = null) {
    if (!STATES.includes(state)) throw new Error('未知状态: ' + state);
    this.state = state;
    this.stateDetail = detail;
    if (progress !== null) this.progress = progress;
    this.emit('state', this.status());
  }

  status() {
    return {
      state: this.state,
      detail: this.stateDetail,
      progress: this.progress,
      accel: this.accel ? this.accel.backend : null,
      hardwareAccel: this.accel ? this.accel.hardware : null,
      accelDetail: this.accel ? this.accel.detail : null,
      pid: this.child ? this.child.pid : null,
      ports: { ...this.ports },
      guestArch: this.guestArch,
      variant: this.opts.variant || null,
      imageVersion: this.opts.version || null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      overlay: this.overlayPath,
      sshReady: !!(this.ssh && this.ssh.connected),
      lastError: this.lastError,
      serialTail: this.serialBuf.slice(-4096),
    };
  }

  // ---------------------------------------------------------------- 资产检查

  /**
   * 检查运行所需资产是否齐备（QEMU pack + 镜像 + 内核 + initrd）。
   * @returns {{ok: boolean, missing: string[], qemu?: object}}
   */
  async ensureAssets() {
    const missing = [];
    const qemuDir = qemuRuntime.resolveQemuDir({
      assetsDir: this.assetsDir,
      resourcesPath: process.resourcesPath,
      appPath: this.opts.appPath || null,
    });
    let qemu = null;
    if (!qemuDir) {
      missing.push('qemu');
    } else {
      qemu = qemuRuntime.inspectQemuDir(qemuDir.dir, this.guestArch);
      if (!qemu) missing.push('qemu-binary');
    }
    for (const [key, p] of [['image', this.opts.imagePath], ['kernel', this.opts.kernelPath], ['initrd', this.opts.initrdPath]]) {
      if (!p || !fs.existsSync(p)) missing.push(key);
    }
    return { ok: missing.length === 0, missing, qemu };
  }

  // ---------------------------------------------------------------- 加速

  _detectAccel(qemu) {
    if (this._accelCache) return this._accelCache;
    const result = qemuRuntime.detectAccel({
      exe: qemu.exe,
      guestArch: this.guestArch,
      dataDir: qemu.dataDir,
      allowTcg: this.config.tcg !== false,
    });
    this._accelCache = result;
    this.accel = result;
    return result;
  }

  // ---------------------------------------------------------------- 启动

  start() {
    if (this.state === 'ready') return Promise.resolve(this.status());
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start() {
    this.lastError = null;
    try {
      // 1) 资产
      this._setState('checking', '检查运行时资源', 2);
      const assets = await this.ensureAssets();
      if (!assets.ok) {
        const err = new Error(`缺少运行时资源: ${assets.missing.join(', ')}`);
        err.code = qemuRuntime.VM_SANDBOX_UNAVAILABLE;
        throw err;
      }
      const qemu = assets.qemu;
      const ver = qemuRuntime.qemuVersion(qemu.exe);
      this.emit('serial', `[host] ${ver || 'QEMU'} | guest=${this.guestArch}`);

      // 2) 加速器
      this._setState('checking', '探测硬件加速', 6);
      const accel = this._detectAccel(qemu);
      this.emit('serial', `[host] accel=${accel.backend || 'none'} (${accel.detail})`);
      if (!accel.available) {
        const err = new Error(accel.detail);
        err.code = qemuRuntime.VM_SANDBOX_UNAVAILABLE;
        throw err;
      }

      // 3) overlay
      this._setState('checking', '准备磁盘', 10);
      await this._cleanupStaleInstance();
      fs.mkdirSync(this.dir, { recursive: true });
      qemuRuntime.createOverlay(qemu.img, this.opts.imagePath, this.overlayPath);

      // 4) cloud-init 服务
      this._setState('booting', '准备首次启动配置', 14);
      const prov = await provision.provision({
        dir: path.join(this.dir, 'cloud-init'),
        timezone: this.config.timezone,
        instanceId: this.opts.instanceName || undefined,
      });
      this.ciServer = prov;
      this.sshKey = prov.keys.privateKey;

      // 5) 端口 + 启动 QEMU
      const sshPort = this.opts.sshPort || await provision.findFreePort();
      const serialPort = await provision.findFreePort();
      this.ports = { ssh: sshPort, serial: serialPort };
      const argv = qemuRuntime.buildArgv({
        exe: qemu.exe, dataDir: qemu.dataDir, guestArch: this.guestArch,
        accel: accel.backend, smp: this.config.smp, memMB: this.config.memMB,
        overlay: this.overlayPath, kernel: this.opts.kernelPath, initrd: this.opts.initrdPath,
        sshPort, serialPort, ciPort: prov.port, netMode: this.config.netMode,
        name: 'cibyp-vmos',
        // 内核命令行可覆盖（自产镜像用 root=LABEL=cibyp-root；第三方镜像可传 PARTUUID 等）
        cmdline: this.config.kernelCmdline || undefined,
      });
      this._setState('booting', '启动虚拟机', 18);
      this.emit('serial', `[host] ${qemu.exe} ${argv.join(' ')}`);
      this._spawn(qemu, argv);
      this.startedAt = Date.now();
      this._attachSerial(serialPort);
      this._writeInstanceFile(qemu);

      // 6) 等 SSH
      this.ssh = new VmSsh({ port: sshPort, privateKey: prov.keys.privateKey });
      this.ssh.on('error', (e) => {
        // 连接期错误由 waitReady 重试；这里只记录，不打断启动流程
        this.emit('serial', '[host] SSH 连接尝试失败: ' + (e && e.message ? e.message : String(e)));
      });
      this.ssh.on('close', () => {
        if (this.state === 'ready') this.emit('serial', '[host] SSH 连接断开');
      });
      const bootDeadline = this.config.bootTimeoutMs;
      await this._withProgress('booting', '等待 SSH 就绪', 22, 55, () => this.ssh.waitReady({ timeoutMs: bootDeadline }));
      this._setState('preparing', '等待首启配置完成', 60);

      // 7) 等 cloud-init
      await this.ssh.exec('cloud-init status --wait >/dev/null 2>&1 || true', { timeoutMs: this.config.cloudInitTimeoutMs });
      this._setState('preparing', '等待工作区就绪', 80);
      const ready = await this._waitWorkspace(60000);
      if (!ready) this.emit('serial', '[host] 警告: /workspace 就绪标记未出现（继续启动）');

      // 8) 就绪
      this._setState('ready', '虚拟机就绪', 100);
      this.emit('ready', this.status());
      return this.status();
    } catch (e) {
      this.lastError = e.message;
      this._setState('failed', e.message, 0);
      this.emit('error', e);
      await this._cleanupAfterFailure();
      throw e;
    }
  }

  /** 把长步骤映射成进度事件（阶段内 0→1 线性） */
  async _withProgress(state, detail, from, to, fn) {
    this._setState(state, detail, from);
    const timer = setInterval(() => {
      if (this.progress < to - 1) this._setState(state, detail, Math.min(to - 1, this.progress + 1));
    }, 1200);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  _spawn(qemu, argv) {
    const logFile = path.join(this.dir, 'qemu.log');
    this._logStream = fs.createWriteStream(logFile, { flags: 'w' });
    this._logStream.write(`# ${qemu.exe} ${argv.join(' ')}\n`);
    this.child = spawn(qemu.exe, argv, {
      cwd: qemu.dir, windowsHide: true, detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d) => this._logStream.write(d));
    this.child.stderr.on('data', (d) => {
      this._logStream.write(d);
      this.emit('serial', '[qemu] ' + d.toString('utf8').trim());
    });
    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal, at: Date.now() };
      try { this._logStream.end(); } catch { /* ignore */ }
      if (this.state === 'ready' || this.state === 'booting' || this.state === 'preparing') {
        this._setState('failed', `QEMU 退出（code=${code}）`, this.progress);
        this.emit('exit', { code, signal });
      }
    });
    this.child.on('error', (e) => {
      this.lastError = e.message;
      this.emit('error', e);
    });
  }

  _attachSerial(port) {
    let attempts = 0;
    const connect = () => {
      if (this.exit || this._serialStopped) return;
      if (attempts++ > 120) { // 最多重试 2 分钟，避免 QEMU 已死时空转
        this.emit('serial', '[host] 串口连接放弃（重试超限）');
        return;
      }
      const sock = net.connect({ host: '127.0.0.1', port });
      this.serialClient = sock;
      // 关键：error 与 close 可能同时触发，必须用一次性闸门，
      // 否则每个失败 socket 会分裂出两个重连 → 指数级增长 → OOM（实测踩坑）
      let retried = false;
      const retry = () => {
        if (retried) return;
        retried = true;
        if (!this.exit && !this._serialStopped) setTimeout(connect, 1000);
      };
      sock.on('connect', () => { attempts = 0; this.emit('serial', `[host] 串口已连接 :${port}`); });
      sock.on('data', (d) => {
        const text = d.toString('utf8');
        this.serialBuf = (this.serialBuf + text).slice(-SERIAL_RING_BYTES);
        this.emit('serial', text);
      });
      sock.on('error', retry);
      sock.on('close', retry);
    };
    connect();
  }

  async _waitWorkspace(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await this.ssh.exec('test -f /workspace/.cibyp-ready && echo ok', { timeoutMs: 15000 });
        if (r.ok && r.stdout.includes('ok')) return true;
      } catch { /* 继续等 */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  /**
   * 清理上次异常退出（崩溃 / 被强杀）残留的 QEMU 进程。
   * 不做这一步的话，旧进程仍持有 overlay.qcow2 的写锁 → qemu-img create / QEMU 启动都会失败。
   */
  async _cleanupStaleInstance() {
    const info = this.readInstanceFile();
    if (!info || !info.pid) return;
    let alive = false;
    try { process.kill(info.pid, 0); alive = true; } catch { alive = false; }
    if (!alive) return;
    this.emit('serial', `[host] 检测到上次残留的虚拟机进程 pid=${info.pid}，先清理再启动`);
    try { process.kill(info.pid); } catch { /* ignore */ }
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      try { process.kill(info.pid, 0); } catch { return; } // 已退出
    }
    try { process.kill(info.pid, 'SIGKILL'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  _writeInstanceFile(qemu) {
    try {
      fs.writeFileSync(this.instanceFile, JSON.stringify({
        pid: this.child.pid,
        instanceId: this.ciServer ? this.ciServer.instanceId : null,
        ports: this.ports,
        accel: this.accel ? this.accel.backend : null,
        guestArch: this.guestArch,
        variant: this.opts.variant || null,
        imageVersion: this.opts.version || null,
        imagePath: this.opts.imagePath,
        startedAt: this.startedAt,
        qemuDir: qemu.dir,
      }, null, 2));
    } catch (e) {
      this.emit('serial', '[host] 写入 instance.json 失败: ' + e.message);
    }
  }

  readInstanceFile() {
    try {
      if (!this.instanceFile || !fs.existsSync(this.instanceFile)) return null;
      return JSON.parse(fs.readFileSync(this.instanceFile, 'utf8'));
    } catch { return null; }
  }

  /** 复用上次运行留下的实例（仍在跑则直连） */
  async reconnect() {
    const info = this.readInstanceFile();
    if (!info || !info.pid || !info.ports || !info.ports.ssh) return false;
    try {
      process.kill(info.pid, 0); // 只探活
    } catch { return false; }
    if (!this.sshKey) return false; // 私钥不落盘，无法重连（P2 可加密落盘）
    this.ssh = new VmSsh({ port: info.ports.ssh, privateKey: this.sshKey });
    try {
      await this.ssh.waitReady({ timeoutMs: 8000, intervalMs: 1500 });
      this.child = { pid: info.pid };
      this.accel = { backend: info.accel, hardware: info.accel !== 'tcg', detail: '复用已运行实例' };
      this.startedAt = info.startedAt || Date.now();
      this._setState('ready', '已复用运行中的虚拟机', 100);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- 执行通道

  /** 命令执行（要求 ready） */
  async exec(command, opts) {
    if (!this.ssh || !this.ssh.connected) throw new Error('虚拟机未就绪');
    return this.ssh.exec(command, opts);
  }

  /** 交互式 PTY */
  async shell(opts) {
    if (!this.ssh || !this.ssh.connected) throw new Error('虚拟机未就绪');
    return this.ssh.shell(opts);
  }

  async sftp() {
    if (!this.ssh || !this.ssh.connected) throw new Error('虚拟机未就绪');
    return this.ssh.sftp();
  }

  // ---------------------------------------------------------------- 停止 / 重置

  async stop({ timeoutMs = 30000, force = false } = {}) {
    if (!this.child) { this._setState('idle', null, 0); return; }
    this._setState('stopping', '关闭虚拟机', this.progress);
    if (!force && this.ssh && this.ssh.connected) {
      try { await this.ssh.exec('sudo systemctl poweroff', { timeoutMs: 10000 }); } catch { /* ignore */ }
    }
    const deadline = Date.now() + timeoutMs;
    while (!this.exit && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    if (!this.exit && this.child.pid) {
      try { process.kill(this.child.pid); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this._serialStopped = true;
    if (this.ssh) { this.ssh.disconnect(); this.ssh = null; }
    if (this.ciServer) { this.ciServer.close(); this.ciServer = null; }
    this.child = null;
    this.exit = null;
    this.startedAt = null;
    this._setState('idle', null, 0);
  }

  /** 重置：回出厂态（删除 overlay）。工作区数据在宿主侧不受影响。 */
  async reset() {
    await this.stop({ force: true });
    if (this.overlayPath && fs.existsSync(this.overlayPath)) fs.rmSync(this.overlayPath, { force: true });
    // 清掉上次的实例信息，避免误复用
    try { if (this.instanceFile && fs.existsSync(this.instanceFile)) fs.rmSync(this.instanceFile, { force: true }); } catch { /* ignore */ }
    this._setState('idle', '已重置为出厂状态', 0);
    return { ok: true };
  }

  async _cleanupAfterFailure() {
    try { if (this.ssh) { this.ssh.disconnect(); this.ssh = null; } } catch { /* ignore */ }
    try { if (this.ciServer) { this.ciServer.close(); this.ciServer = null; } } catch { /* ignore */ }
    try {
      if (this.child && this.child.pid) {
        process.kill(this.child.pid);
        this.child = null;
        this.exit = null;
      }
    } catch { /* ignore */ }
    this._serialStopped = true;
  }
}

module.exports = { VmInstance, STATES };
