/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 图形环境（P4）：在 VM 内起 X 虚拟显示 + x11vnc，宿主用 noVNC 内嵌显示；
 * 同时可把 VM 内的 Chromium 以 CDP 暴露给宿主 Playwright（安全浏览器沙盒）。
 *
 * 设计取舍：
 *   - 不需要在 Guest 装桌面环境（GNOME/XFCE），只起 Xvfb + 轻量 WM（openbox）+ 可选 Chromium，
 *     内存占用小、启动快；需要完整桌面时用户可在 VM 内自行 apt 安装
 *   - VNC 只监听 guest loopback（-localhost），宿主经 SSH 端口转发访问，不暴露到网络
 *   - 所有长驻进程用 `nohup setsid ... &` 启动，SSH 通道关闭不影响
 *   - base 变体也能用：缺包时按需 apt 安装（约 200MB，需要 guest 能出网）
 */

'use strict';

const DEFAULT_DISPLAY = ':99';
const DEFAULT_GEOMETRY = '1280x800x24';
const VNC_PORT = 5900;
const CDP_PORT = 9222;

class VmGraphics {
  /**
   * @param {object} opts { vmService, geometry, display }
   */
  constructor(opts = {}) {
    this.vmService = opts.vmService;
    this.display = opts.display || DEFAULT_DISPLAY;
    this.geometry = opts.geometry || DEFAULT_GEOMETRY;
    this.state = { x: false, vnc: false, chromium: false, vncForward: null, cdpForward: null, vncHostPort: null, cdpHostPort: null };
    this._log = [];
  }

  get status() {
    return {
      running: this.state.vnc,
      chromium: this.state.chromium,
      display: this.display,
      geometry: this.geometry,
      vncHostPort: this.state.vncHostPort,
      cdpHostPort: this.state.cdpHostPort,
      log: this._log.slice(-30),
    };
  }

  _inst() {
    const inst = this.vmService && this.vmService.instance;
    if (!inst || inst.state !== 'ready') {
      const e = new Error('虚拟机未就绪（图形环境需要运行中的 VM）');
      e.code = 'VM_NOT_READY';
      throw e;
    }
    return inst;
  }

  _logLine(line) {
    const s = String(line || '').trim();
    if (!s) return;
    this._log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
    this.vmService.emit('graphics-log', s);
  }

  /** 后台启动一条常驻命令 */
  async _startDetached(cmd, { logFile = '/tmp/cibyp-graphics.log' } = {}) {
    const inst = this._inst();
    const full = `nohup setsid ${cmd} >> ${logFile} 2>&1 & echo started`;
    const r = await inst.exec(full, { timeoutMs: 30000 });
    this._logLine(`$ ${cmd}`);
    if (!r.ok) throw new Error(`启动失败: ${r.stderr || r.stdout || ('退出码 ' + r.code)}`);
    return r;
  }

  async _has(cmd) {
    const inst = this._inst();
    const r = await inst.exec(`command -v ${cmd} >/dev/null && echo yes || echo no`, { timeoutMs: 20000 });
    return r.stdout.trim() === 'yes';
  }

  /** 确保图形环境所需软件包存在（缺则 apt 安装；base 变体也能用） */
  async ensureGuestPackages({ onProgress } = {}) {
    const need = [];
    if (!(await this._has('Xvfb'))) need.push('xvfb');
    if (!(await this._has('x11vnc'))) need.push('x11vnc');
    if (!(await this._has('openbox'))) need.push('openbox');
    if (!need.length) return { ok: true, installed: false };
    if (onProgress) onProgress({ phase: 'apt', packages: need });
    this._logLine(`安装图形依赖: ${need.join(' ')}`);
    const inst = this._inst();
    const r = await inst.exec(
      `sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${need.join(' ')}`,
      { timeoutMs: 900000 }
    );
    this._logLine(r.stdout.slice(-500));
    if (!r.ok) throw new Error('安装图形依赖失败: ' + (r.stderr || '').slice(-300));
    return { ok: true, installed: true, packages: need };
  }

  /** 启动 Xvfb + x11vnc（幂等） */
  async start({ onProgress } = {}) {
    const inst = this._inst();
    // 已在跑则直接复用（并确保端口转发仍在）
    if (this.state.vnc) {
      await this._ensureForward();
      return { ok: true, reused: true, ...this.status, url: this.vncLocalUrl };
    }
    await this.ensureGuestPackages({ onProgress });
    if (onProgress) onProgress({ phase: 'x' });
    // 1) X 虚拟显示
    await this._startDetached(`Xvfb ${this.display} -screen 0 ${this.geometry} -nolisten tcp`);
    this.state.x = true;
    await new Promise((r) => setTimeout(r, 800));
    // 2) 轻量窗口管理器（可选，失败不致命）
    try { await this._startDetached(`env DISPLAY=${this.display} openbox`); } catch (e) { this._logLine('openbox 启动失败（不影响）: ' + e.message); }
    // 3) x11vnc（仅监听 guest loopback，宿主经 SSH 转发访问）
    if (onProgress) onProgress({ phase: 'vnc' });
    await this._startDetached(`x11vnc -display ${this.display} -forever -shared -nopw -localhost -rfbport ${VNC_PORT} -quiet -bg -o /tmp/cibyp-x11vnc.log`);
    this.state.vnc = true;
    // 等 VNC 端口就绪
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      const r = await inst.exec(`(exec 3<>/dev/tcp/127.0.0.1/${VNC_PORT}) 2>/dev/null && echo up || echo down`, { timeoutMs: 10000 });
      if (r.stdout.includes('up')) { ready = true; break; }
      await new Promise((r2) => setTimeout(r2, 700));
    }
    if (!ready) throw new Error('x11vnc 未在 15s 内就绪（详见 /tmp/cibyp-x11vnc.log）');
    await this._ensureForward();
    if (onProgress) onProgress({ phase: 'ready' });
    return { ok: true, ...this.status, url: this.vncLocalUrl };
  }

  async _ensureForward() {
    if (this.state.vncForward && this.state.vncHostPort) return;
    const f = await this.vmService.forwardPort(VNC_PORT);
    this.state.vncForward = f;
    this.state.vncHostPort = f.hostPort;
    this._logLine(`VNC 已映射到宿主 127.0.0.1:${f.hostPort}`);
  }

  get vncLocalUrl() {
    return this.state.vncHostPort ? `http://127.0.0.1:${this.state.vncHostPort}/` : null;
  }

  get vncWsUrl() {
    return this.state.vncHostPort ? `ws://127.0.0.1:${this.state.vncHostPort}/` : null;
  }

  /** 在 VM 内启动 Chromium（CDP 暴露给宿主 Playwright），用于浏览器沙盒 */
  async startChromium({ url = 'about:blank', extraArgs = [] } = {}) {
    const inst = this._inst();
    if (!(await this._has('chromium')) && !(await this._has('chromium-browser'))) {
      this._logLine('安装 chromium（约 150MB）…');
      const r = await inst.exec('sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium', { timeoutMs: 900000 });
      if (!r.ok) throw new Error('安装 chromium 失败: ' + (r.stderr || '').slice(-300));
    }
    const bin = (await this._has('chromium')) ? 'chromium' : 'chromium-browser';
    const args = [
      `--display=${this.display}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=/tmp/cibyp-chrome',
      '--window-size=1280,800',
      url,
    ].join(' ');
    await this._startDetached(`env DISPLAY=${this.display} ${bin} ${args}`);
    this.state.chromium = true;
    // 等 CDP 就绪并映射到宿主
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const r = await inst.exec(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${CDP_PORT}/json/version || true`, { timeoutMs: 15000 });
      if ((r.stdout || '').includes('200')) break;
      await new Promise((r2) => setTimeout(r2, 800));
    }
    if (!this.state.cdpForward) {
      const f = await this.vmService.forwardPort(CDP_PORT);
      this.state.cdpForward = f;
      this.state.cdpHostPort = f.hostPort;
    }
    return {
      ok: true,
      cdpUrl: `http://127.0.0.1:${this.state.cdpHostPort}`,
      wsHint: 'Playwright: chromium.connectOverCDP(cdpUrl)',
    };
  }

  /** 停止图形环境（保留 VM 运行） */
  async stop() {
    const inst = this.vmService && this.vmService.instance;
    this.state = { x: false, vnc: false, chromium: false, vncForward: null, cdpForward: null, vncHostPort: null, cdpHostPort: null };
    if (!inst || inst.state !== 'ready') return { ok: true };
    try { await inst.exec('pkill -f "x11vnc -display" ; pkill -f "Xvfb :99" ; pkill -f "chromium" ; true', { timeoutMs: 30000 }); } catch { /* ignore */ }
    this._logLine('图形环境已停止');
    return { ok: true };
  }
}

module.exports = { VmGraphics, VNC_PORT, CDP_PORT, DEFAULT_DISPLAY, DEFAULT_GEOMETRY };
