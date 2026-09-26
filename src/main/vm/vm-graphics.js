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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellQuote } = require('./vm-paths');

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
    // 电脑控制/剪贴板/截图（VM 模式下这些必须作用于虚拟机，而不是宿主机）
    if (!(await this._has('xdotool'))) need.push('xdotool');
    if (!(await this._has('xclip'))) need.push('xclip');
    if (!(await this._has('ffmpeg')) && !(await this._has('import'))) need.push('imagemagick');
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

  /** 屏幕几何（去掉色深） */
  screenSize() {
    const [w, h] = String(this.geometry).split('x').map((n) => parseInt(n, 10) || 0);
    return { width: w || 1280, height: h || 800 };
  }

  /** 选择截图工具：ffmpeg（x11grab）优先，其次 ImageMagick import */
  async _captureTool() {
    if (await this._has('ffmpeg')) return 'ffmpeg';
    if (await this._has('import')) return 'import';
    return null;
  }

  /**
   * VM 屏幕截图：Xvfb → PNG。返回 { path(宿主镜像路径), vmPath, width, height }。
   * 有工作区时写入工作区（宿主镜像 + VM 双写），否则落到 <mount>/_uploads 并返回宿主临时镜像。
   */
  async capture({ workspacePath = '', filename = '' } = {}) {
    const inst = this._inst();
    await this.start();
    let tool = await this._captureTool();
    if (!tool) {
      await this.ensureGuestPackages();
      tool = await this._captureTool();
    }
    if (!tool) throw new Error('虚拟机内缺少截图工具（ffmpeg / imagemagick），无法抓取虚拟机屏幕');
    const ts = Date.now();
    const name = filename || `screenshot-${ts}.png`;
    const vmTmp = `/tmp/cibyp-shot-${ts}.png`;
    const geom = String(this.geometry).split('x').slice(0, 2).join('x');
    const cmd = tool === 'ffmpeg'
      ? `DISPLAY=${this.display} ffmpeg -hide_banner -loglevel error -y -f x11grab -video_size ${geom} -i ${this.display} -frames:v 1 ${shellQuote(vmTmp)}`
      : `DISPLAY=${this.display} import -display ${this.display} -window root ${shellQuote(vmTmp)}`;
    const r = await inst.exec(cmd, { timeoutMs: 60000 });
    if (!r.ok) throw new Error('虚拟机截图失败: ' + (r.stderr || r.stdout || '').slice(-200));
    const { VmFs } = require('./vm-fs');
    const vmFs = new VmFs({ vmService: this.vmService });
    const buf = await vmFs.readBuffer(vmTmp);
    const size = this.screenSize();
    let target = null;
    if (workspacePath) {
      const t = vmFs.resolveVmPath(workspacePath);
      if (t.ok) {
        const hostDir = vmFs.toHost(t.vm) || workspacePath;
        try { fs.mkdirSync(hostDir, { recursive: true }); } catch { /* ignore */ }
        target = { hostFile: path.join(hostDir, name), vmFile: `${t.vm.replace(/\/+$/, '')}/${name}` };
      }
    }
    if (target) {
      fs.writeFileSync(target.hostFile, buf);
      await vmFs.pushFromHost(target.hostFile, target.vmFile).catch(() => {});
      return { path: target.hostFile, vmPath: target.vmFile, width: size.width, height: size.height, tool };
    }
    const vmPath = `${vmFs.mountRoot()}/_uploads/${name}`;
    await vmFs.writeBuffer(vmPath, buf);
    const tmp = path.join(os.tmpdir(), name);
    try { fs.writeFileSync(tmp, buf); } catch { /* ignore */ }
    return { path: tmp, vmPath, width: size.width, height: size.height, tool };
  }

  /** 在 VM 内执行 xdotool 命令（缺包时自动安装） */
  async _xdotool(args, timeoutMs = 30000) {
    const inst = this._inst();
    await this.start();
    if (!(await this._has('xdotool'))) await this.ensureGuestPackages();
    const r = await inst.exec(`DISPLAY=${this.display} xdotool ${args}`, { timeoutMs });
    if (!r.ok) throw new Error('虚拟机输入注入失败: ' + (r.stderr || r.stdout || '').slice(-200));
    return r.stdout;
  }

  async mouseMove(x, y) {
    await this._xdotool(`mousemove --sync ${Math.round(Number(x) || 0)} ${Math.round(Number(y) || 0)}`);
    return { ok: true, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) };
  }

  async click(button, x, y, doubleClick = false) {
    const b = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
    const move = (x != null && y != null) ? `mousemove --sync ${Math.round(Number(x) || 0)} ${Math.round(Number(y) || 0)} ` : '';
    await this._xdotool(`${move}click ${doubleClick ? '--repeat 2 --delay 80 ' : ''}${b}`);
    return { ok: true };
  }

  async drag(startX, startY, endX, endY) {
    const r = (n) => Math.round(Number(n) || 0);
    await this._xdotool(`mousemove --sync ${r(startX)} ${r(startY)} mousedown 1 mousemove --sync ${r(endX)} ${r(endY)} mouseup 1`);
    return { ok: true };
  }

  async typeText(text) {
    await this._xdotool(`type --delay 15 -- ${shellQuote(String(text == null ? '' : text))}`);
    return { ok: true };
  }

  async pressKey(keyStr) {
    // 归一化常见写法：Control+c / CTRL+C / ctrl-c → ctrl+c
    const key = String(keyStr || '')
      .split('+').map((k) => k.trim().toLowerCase()
        .replace(/^control$/, 'ctrl').replace(/^escape$/, 'Escape').replace(/^enter$/, 'Return'))
      .join('+');
    if (!key) return { ok: false, error: '按键为空' };
    await this._xdotool(`key --clearmodifiers ${shellQuote(key)}`);
    return { ok: true };
  }

  async scroll(x, y, direction, amount = 3) {
    const button = direction === 'up' ? 4 : 5;
    const n = Math.max(1, Math.min(50, parseInt(amount, 10) || 3));
    await this._xdotool(`mousemove --sync ${Math.round(Number(x) || 0)} ${Math.round(Number(y) || 0)} click --repeat ${n} --delay 30 ${button}`);
    return { ok: true };
  }

  async cursorPosition() {
    const out = await this._xdotool('getmouselocation --shell');
    const mx = /X=(\d+)/.exec(out);
    const my = /Y=(\d+)/.exec(out);
    return { ok: true, x: mx ? Number(mx[1]) : 0, y: my ? Number(my[1]) : 0 };
  }

  /** VM 剪贴板（X11 selection，走 xclip；不触碰宿主剪贴板） */
  async clipboardGet() {
    const inst = this._inst();
    await this.start();
    if (!(await this._has('xclip'))) await this.ensureGuestPackages();
    const r = await inst.exec(`DISPLAY=${this.display} xclip -selection clipboard -o 2>/dev/null || true`, { timeoutMs: 20000 });
    return { ok: true, text: r.stdout || '' };
  }

  async clipboardSet(text) {
    const inst = this._inst();
    await this.start();
    if (!(await this._has('xclip'))) await this.ensureGuestPackages();
    const r = await inst.exec(`printf %s ${shellQuote(String(text == null ? '' : text))} | DISPLAY=${this.display} xclip -selection clipboard -i`, { timeoutMs: 20000 });
    if (!r.ok) throw new Error('写入虚拟机剪贴板失败: ' + (r.stderr || '').slice(-200));
    return { ok: true };
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
