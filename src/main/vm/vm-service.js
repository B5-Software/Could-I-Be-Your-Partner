/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 沙盒门面（main.js 只依赖这一层）：
 *   - 把 settings.runtime 翻译成 VmInstance 的构造参数
 *   - 资源状态 / manifest / 下载（aria2）/ 变体切换
 *   - 事件向上冒泡：state / progress / serial / ready / error
 *   - 提供 probe()：给设置页与 Splash 展示"这台机器能不能跑 VM"
 *
 * 注意：真正的实例生命周期在 vm-instance.js；本文件不做业务判断，
 * 只做"配置 ↔ 运行时"的翻译与聚合。
 */

'use strict';

/** 依次尝试多个镜像前缀拉取清单（CN 网络下 GitHub 直连/单一镜像常失败） */
async function fetchWithFallback(fetchFn, preferred) {
  const order = [...new Set([preferred, 'cn', 'cn2', 'cn3', 'official'].filter(Boolean))];
  let lastErr = null;
  for (const mirror of order) {
    try {
      const data = await fetchFn(mirror);
      if (mirror !== preferred) console.log('[vm] 清单拉取回退到镜像:', mirror);
      return { data, mirror };
    } catch (e) { lastErr = e; console.warn('[vm] 清单拉取失败（' + mirror + '）:', e.message); }
  }
  throw lastErr || new Error('清单拉取失败');
}
const fetchManifestWithFallback = (mirror) => fetchWithFallback((m) => images.fetchManifest({ mirror: m }), mirror);
const fetchQemuManifestWithFallback = (mirror) => fetchWithFallback((m) => images.fetchQemuPackManifest({ mirror: m }), mirror);

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const images = require('./vm-images');
const qemuRuntime = require('./qemu-runtime');
const { VmInstance } = require('./vm-instance');
const { downloadFile, DownloadCancelled } = require('./vm-download');
const { WorkspaceSync } = require('./vm-workspace');
const { VmGraphics } = require('./vm-graphics');

class VmService extends EventEmitter {
  /**
   * @param {object} opts { app, getSettings, persistSettings, aria2 }
   */
  constructor(opts = {}) {
    super();
    this.app = opts.app;
    this.getSettings = opts.getSettings || (() => ({}));
    this.persistSettings = opts.persistSettings || (() => {});
    this.aria2 = opts.aria2 || null;
    this.instance = null;
    this.emergencyHost = false;
    this._download = null; // { cancelled, current }
  }

  // ---------------------------------------------------------------- 配置

  get runtime() {
    const s = this.getSettings();
    const r = s.runtime || {};
    return {
      location: r.location === 'vm' ? 'vm' : 'host',
      workspaceMode: r.workspaceMode === 'isolated' ? 'isolated' : 'shared',
      vm: Object.assign({
        variant: 'base', imageVersion: null, assetsDir: '', mirror: 'cn',
        accel: 'auto', allowTcg: true, smp: 4, memMB: 4096, netMode: 'nat', shutdownOnExit: true,
      }, r.vm || {}),
    };
  }

  /** 资源根目录（用户可覆盖；默认 userData/vm） */
  get assetsDir() {
    const custom = this.runtime.vm.assetsDir;
    if (custom && String(custom).trim()) return path.resolve(String(custom).trim());
    return path.join(this.app.getPath('userData'), 'vm');
  }

  /** 工作区根目录（宿主侧权威副本；默认 文档/Could-I-Be-Your-Partner） */
  get workspaceRoot() {
    const custom = this.runtime.vm.workspaceRoot;
    if (custom && String(custom).trim()) return path.resolve(String(custom).trim());
    try { return path.join(this.app.getPath('documents'), 'Could-I-Be-Your-Partner'); } catch { return null; }
  }

  // ---------------------------------------------------------------- 工作区同步

  /** 惰性创建同步器（宿主工作区 ↔ VM /workspace） */
  _workspaceSync() {
    const root = this.workspaceRoot;
    if (!root) return null;
    if (this.sync && this.sync.hostRoot === root) return this.sync;
    const inst = this.instance;
    const sync = new WorkspaceSync({
      vmService: this,
      hostRoot: root,
      vmMount: (this.runtime.vm.workspaceMount || '/workspace'),
      instanceDir: inst && inst.dir ? inst.dir : null,
      options: {
        maxFileMB: this.runtime.vm.syncMaxFileMB || 64,
        syncGit: !!this.runtime.vm.syncGit,
      },
    });
    sync.on('warn', (w) => this.emit('sync-warn', w));
    sync.on('progress', (p) => this.emit('sync-progress', p));
    sync.on('sync-done', (r) => this.emit('sync-done', r));
    this.sync = sync;
    return sync;
  }

  /**
   * 把宿主任意目录挂载进 VM：<dir> → /workspace/_external/<name>。
   * 用于 Code 模式打开的项目目录：之后所有 fs/终端/工具都按该映射作用于 VM。
   * 跳过 node_modules/.git/dist 等，单文件默认上限 20MB。
   */
  async mountExternalDir(hostDir, { maxFileMB = 20 } = {}) {
    const hostRoot = path.resolve(String(hostDir || ''));
    if (!hostRoot || !fs.existsSync(hostRoot)) return { ok: false, error: '目录不存在: ' + hostRoot };
    const name = path.basename(hostRoot).replace(/[^\w.-]+/g, '_') || 'ws';
    const vmRoot = `/workspace/_external/${name}`;
    this._externMounts = this._externMounts || new Map();
    this._externMounts.set(hostRoot, vmRoot);
    const { VmFs } = require('./vm-fs');
    const vmFs = new VmFs({ vmService: this });
    const skip = new Set(['node_modules', '.git', 'dist', 'out', '.cache', '.venv', '__pycache__', '.next']);
    const maxBytes = Math.max(1, Number(maxFileMB) || 20) * 1024 * 1024;
    const push = async (from, to) => {
      await vmFs.exec(`mkdir -p ${JSON.stringify(to)}`, 20000);
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const src = path.join(from, e.name);
        const dst = to + '/' + e.name;
        if (e.isDirectory()) { await push(src, dst); continue; }
        try { if (fs.statSync(src).size > maxBytes) continue; } catch { continue; }
        await vmFs.pushFromHost(src, dst).catch(() => {});
      }
    };
    await push(hostRoot, vmRoot);
    console.log('[vm] 已挂载外部目录:', hostRoot, '→', vmRoot);
    return { ok: true, hostRoot, vmRoot };
  }

  /** 宿主路径 → VM 路径（未同步/未就绪时退化为 /workspace） */
  toVmPath(hostPath) {
    try {
      const raw = String(hostPath || '');
      if (!raw) return raw;
      if (raw.startsWith('/')) return raw; // 已是 VM 内 POSIX 路径（幂等）
      if (this._externMounts && this._externMounts.size) {
        const p = path.resolve(String(hostPath || ''));
        for (const [hostRoot, vmRoot] of this._externMounts) {
          if (p === hostRoot || p.startsWith(hostRoot + path.sep)) {
            const rel = path.relative(hostRoot, p).split(path.sep).join('/');
            return rel ? `${vmRoot}/${rel}` : vmRoot;
          }
        }
      }
      const sync = this._workspaceSync();
      return sync ? sync.toVmPath(hostPath) : '/workspace';
    } catch { return '/workspace'; }
  }

  /** VM 路径 → 宿主路径 */
  toHostPath(vmPath) {
    try {
      if (this._externMounts && this._externMounts.size) {
        const p = String(vmPath || '');
        for (const [hostRoot, vmRoot] of this._externMounts) {
          if (p === vmRoot || p.startsWith(vmRoot + '/')) {
            const rel = p.slice(vmRoot.length).replace(/^\/+/, '');
            return rel ? path.join(hostRoot, ...rel.split('/')) : hostRoot;
          }
        }
      }
      const sync = this._workspaceSync();
      return sync ? sync.toHostPath(vmPath) : null;
    } catch { return null; }
  }

  /**
   * 同步工作区（shared 模式）。
   * @param {object} opts { direction: 'both'|'push'|'pull', reason }
   */
  async syncWorkspace(opts = {}) {
    if (this.runtime.workspaceMode !== 'shared') {
      return { ok: false, error: '当前为独立工作区模式（不自动同步）', mode: 'isolated' };
    }
    const sync = this._workspaceSync();
    if (!sync) return { ok: false, error: '工作区根目录未就绪' };
    if (!this.instance || this.instance.state !== 'ready') return { ok: false, error: '虚拟机未就绪' };
    return sync.sync(opts);
  }

  syncStats() {
    return this.sync ? this.sync.stats : { lastSyncAt: null, baselineFiles: 0 };
  }

  get variant() {
    return images.variantById(this.runtime.vm.variant).id;
  }

  /** 当前变体已安装的镜像版本（取最新可用） */
  installedVersion() {
    const st = images.localStatus(this.assetsDir, { variant: this.variant });
    return st.selected ? st.selected.version : null;
  }

  // ---------------------------------------------------------------- 状态

  /** 资源与加速探测（设置页 / Splash 展示） */
  async probe() {
    const paths = images.assetPaths(this.assetsDir, { variant: this.variant });
    const qemuDir = qemuRuntime.resolveQemuDir({
      assetsDir: this.assetsDir,
      resourcesPath: process.resourcesPath,
      appPath: this.app.getAppPath(),
    });
    const ga = images.guestArch(process.arch);
    const qemu = qemuDir ? qemuRuntime.inspectQemuDir(qemuDir.dir, ga) : null;
    const out = {
      assetsDir: this.assetsDir,
      qemuDir: qemuDir ? qemuDir.dir : null,
      qemuSource: qemuDir ? qemuDir.source : null,
      qemuVersion: qemu ? qemuRuntime.qemuVersion(qemu.exe) : null,
      guestArch: ga,
      accel: null,
      variants: images.VARIANTS.map((v) => ({ ...v, status: images.localStatus(this.assetsDir, { variant: v.id }) })),
    };
    if (qemu) {
      const allowTcg = this.runtime.vm.allowTcg !== false;
      out.accel = qemuRuntime.detectAccel({ exe: qemu.exe, guestArch: ga, dataDir: qemu.dataDir, allowTcg });
    }
    return out;
  }

  status() {
    const inst = this.instance;
    const base = {
      location: this.runtime.location,
      workspaceMode: this.runtime.workspaceMode,
      variant: this.variant,
      assetsDir: this.assetsDir,
      workspaceRoot: this.workspaceRoot,
      sync: this.syncStats(),
      emergencyHost: this.emergencyHost,
      inst: inst ? inst.status() : { state: 'idle', progress: 0, detail: null },
    };
    return base;
  }

  // ---------------------------------------------------------------- 生命周期

  _ensureInstance() {
    if (this.instance) return this.instance;
    const st = images.localStatus(this.assetsDir, { variant: this.variant });
    const selected = this.runtime.vm.imageVersion
      ? st.versions.find((v) => v.version === this.runtime.vm.imageVersion && v.ok) || st.selected
      : st.selected;
    if (!selected) {
      const err = new Error('CIBYP-VM-OS 镜像未下载（设置 → 虚拟机沙盒 → 下载）');
      err.code = qemuRuntime.VM_SANDBOX_UNAVAILABLE;
      throw err;
    }
    const inst = new VmInstance({
      assetsDir: this.assetsDir,
      imagePath: selected.image,
      kernelPath: selected.kernel,
      initrdPath: selected.initrd,
      variant: this.variant,
      version: selected.version,
      appPath: this.app.getAppPath(),
      instanceName: 'default',
      config: {
        smp: this.runtime.vm.smp,
        memMB: this.runtime.vm.memMB,
        netMode: this.runtime.vm.netMode,
        tcg: this.runtime.vm.allowTcg !== false,
        shutdownOnExit: this.runtime.vm.shutdownOnExit !== false,
        kernelCmdline: this.runtime.vm.kernelCmdline || null,
      },
    });
    for (const ev of ['state', 'serial', 'ready', 'error', 'exit']) {
      inst.on(ev, (payload) => this.emit(ev, payload));
    }
    // shared 模式：VM 就绪后做一次全量双向同步（后台执行，不阻塞启动）
    inst.on('ready', () => {
      if (this.runtime.workspaceMode !== 'shared') return;
      setTimeout(() => {
        this.syncWorkspace({ direction: 'both', reason: 'boot' }).catch(() => {});
      }, 500);
    });
    this.instance = inst;
    return inst;
  }

  async start() {
    const inst = this._ensureInstance();
    return inst.start();
  }

  async stop() {
    if (!this.instance) return { ok: true };
    await this.instance.stop();
    return { ok: true };
  }

  async reset() {
    const inst = this._ensureInstance();
    await inst.reset();
    return { ok: true };
  }

  /** 执行命令（VM 内） */
  async exec(command, opts) {
    const inst = this._ensureInstance();
    return inst.exec(command, opts);
  }

  /** 打开 VM PTY（终端面板用） */
  async shell(opts) {
    const inst = this._ensureInstance();
    return inst.shell(opts);
  }

  // ---------------------------------------------------------------- 图形环境（P4）

  /** 惰性创建图形环境控制器（Xvfb + x11vnc + 可选 Chromium/CDP） */
  graphicsController() {
    if (!this._graphics || this._graphics.vmService !== this) {
      this._graphics = new VmGraphics({ vmService: this });
      this._graphics.vmService = this;
    }
    return this._graphics;
  }

  async graphicsStart(opts = {}) {
    const g = this.graphicsController();
    return g.start({ onProgress: (p) => this.emit('graphics-progress', p) });
  }

  async graphicsStop() {
    if (!this._graphics) return { ok: true };
    return this._graphics.stop();
  }

  graphicsStatus() {
    return this._graphics ? this._graphics.status : { running: false, chromium: false };
  }

  async graphicsChromium(opts = {}) {
    const g = this.graphicsController();
    return g.startChromium(opts);
  }

  // ---------------------------------------------------------------- 虚拟机内下载（aria2 + GitHub 加速镜像）

  /**
   * 把远程文件下载并落到虚拟机里（宿主用 aria2 下载 → 推入 VM）。
   * @param {object} opts { url, dir（VM 内目录，默认 /workspace）、filename、mirror、sha256 }
   */
  async downloadFileToVm(opts = {}) {
    const url = String(opts.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '请填写 http(s) 链接' };
    if (this._download) return { ok: false, error: '已有下载任务进行中（资源下载或文件下载）' };
    const mirror = opts.mirror || this.runtime.vm.mirror || 'official';
    const finalUrl = images.applyMirrorToUrl(url, mirror);
    const dir = String(opts.dir || '/workspace').replace(/\/+$/, '') || '/workspace';
    let filename = String(opts.filename || '').trim();
    if (!filename) {
      try {
        const u = new URL(finalUrl);
        filename = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || `download-${Date.now()}`);
      } catch { filename = `download-${Date.now()}`; }
    }
    filename = filename.replace(/[\\/]/g, '_');
    const task = { cancelled: false };
    this._download = task;
    const tmpDir = path.join(this.assetsDir, 'downloads', 'vm-files');
    const tmpFile = path.join(tmpDir, `${Date.now()}_${filename}`);
    try {
      this.emit('progress', { phase: 'start', kind: 'vm-file', filename, url: finalUrl, variant: 'vm-file' });
      await downloadFile({
        url: finalUrl,
        dest: tmpFile,
        sha256: opts.sha256 || undefined,
        aria2: this.aria2,
        isCancelled: () => !!task.cancelled,
        onProgress: (p) => this.emit('progress', { phase: 'download', kind: 'vm-file', filename, ...p }),
      });
      if (task.cancelled) throw new DownloadCancelled();
      // 推入虚拟机
      const { VmFs } = require('./vm-fs');
      const vmFs = new VmFs({ vmService: this });
      const vmPath = await vmFs.pushFromHost(tmpFile, `${dir}/${filename}`);
      const size = fs.statSync(tmpFile).size;
      this.emit('progress', { phase: 'done', kind: 'vm-file', filename, percent: 100, path: vmPath });
      return { ok: true, path: vmPath, size, filename, url: finalUrl, mirror };
    } catch (e) {
      if (e instanceof DownloadCancelled || e.code === 'DOWNLOAD_CANCELLED') return { ok: false, error: '已取消' };
      return { ok: false, error: e.message };
    } finally {
      this._download = null;
      try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- 端口预览

  /**
   * 把 VM 内服务端口映射到宿主 loopback（用于在宿主浏览器/内置浏览器预览）。
   * @param {number} guestPort
   * @param {number|null} hostPort
   */
  async forwardPort(guestPort, hostPort = null) {
    const inst = this._ensureInstance();
    if (!inst.ssh || !inst.ssh.connected) throw new Error('虚拟机未就绪');
    const entry = await inst.ssh.forwardToHost(guestPort, hostPort);
    this._forwards = this._forwards || new Map();
    this._forwards.set(entry.hostPort, { guestPort, hostPort: entry.hostPort, createdAt: Date.now(), close: entry.close });
    this.emit('forward-added', { guestPort, hostPort: entry.hostPort });
    return { guestPort, hostPort: entry.hostPort, url: `http://127.0.0.1:${entry.hostPort}/` };
  }

  unforwardPort(hostPort) {
    if (!this._forwards || !this._forwards.has(hostPort)) return { ok: false, error: '该端口未在转发列表中' };
    const e = this._forwards.get(hostPort);
    try { e.close(); } catch { /* ignore */ }
    this._forwards.delete(hostPort);
    this.emit('forward-removed', { guestPort: e.guestPort, hostPort });
    return { ok: true };
  }

  listForwards() {
    if (!this._forwards) return [];
    return [...this._forwards.values()].map(({ close, ...rest }) => rest);
  }

  /** 紧急切回本机（本次运行生效；不写 settings） */
  emergencyHostMode() {
    this.emergencyHost = true;
    this.emit('emergency-host');
    return { ok: true };
  }

  // ---------------------------------------------------------------- 资源

  variants() {
    const current = this.variant;
    return images.VARIANTS.map((v) => ({
      id: v.id,
      label: v.label,
      desc: v.desc,
      limitMB: v.limitMB,
      diskGB: v.diskGB,
      default: !!v.default,
      installed: images.localStatus(this.assetsDir, { variant: v.id }).installed,
    }));
  }

  assetsStatus(variant) {
    return images.localStatus(this.assetsDir, { variant: variant || this.variant });
  }

  async manifest(opts = {}) {
    const mirror = opts.mirror || this.runtime.vm.mirror || 'official';
    const manifest = await images.fetchManifest({ mirror, timeoutMs: opts.timeoutMs || 20000 });
    return { ok: true, manifest };
  }

  cancelDownload() {
    if (this._download) {
      this._download.cancelled = true;
      return { ok: true };
    }
    return { ok: false, error: '没有进行中的下载' };
  }

  /** 当前平台是否已安装 QEMU 运行时包 */
  qemuPackInstalled() {
    const dir = qemuRuntime.resolveQemuDir({
      assetsDir: this.assetsDir,
      resourcesPath: process.resourcesPath,
      appPath: this.app.getAppPath(),
    });
    if (!dir) return null;
    const info = qemuRuntime.inspectQemuDir(dir.dir, images.guestArch(process.arch));
    return info ? { ...info, source: dir.source } : null;
  }

  /**
   * 下载并安装 QEMU 运行时包（裁剪版 zip，含 sha256 校验与解压自检）。
   * @param {object} opts { mirror, manifest }
   */
  async downloadQemuPack(opts = {}) {
    const mirror = opts.mirror || this.runtime.vm.mirror || 'official';
    const task = opts.task || { cancelled: false };
    const manifest = opts.manifest || await images.fetchQemuPackManifest({ mirror });
    const pack = images.pickQemuPack(manifest, { mirror });
    const key = images.platformKey(process.platform, process.arch);
    const zipPath = path.join(this.assetsDir, 'downloads', path.basename(new URL(pack.downloadUrl).pathname) || `cibyp-qemu-${key}.zip`);
    this.emit('progress', { phase: 'start', kind: 'qemu', version: pack.qemuVersion, variant: 'qemu-pack' });
    await downloadFile({
      url: pack.downloadUrl,
      dest: zipPath,
      sha256: pack.sha256,
      aria2: this.aria2,
      isCancelled: () => !!task.cancelled,
      onProgress: (p) => this.emit('progress', { phase: 'download', kind: 'qemu', version: pack.qemuVersion, ...p }),
    });
    if (task.cancelled) throw new DownloadCancelled();

    // 解压到 <assetsDir>/qemu/<platform-arch>/（先解压到临时目录，成功后再替换，避免半成品）
    this.emit('progress', { phase: 'extract', kind: 'qemu', percent: 100 });
    const targetDir = path.join(this.assetsDir, 'qemu', key);
    const tmpDir = path.join(this.assetsDir, 'qemu', `.tmp-${key}-${Date.now()}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(tmpDir, true);
      // 自检：确认二进制可执行且能用
      const info = qemuRuntime.inspectQemuDir(tmpDir, images.guestArch(process.arch));
      if (!info) throw new Error('解压后未找到 qemu-system-* / qemu-img（包结构异常）');
      const ver = qemuRuntime.qemuVersion(info.exe);
      if (!ver) throw new Error('解压后的 QEMU 无法运行（缺少依赖 DLL？）');
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.renameSync(tmpDir, targetDir);
      this.emit('progress', { phase: 'done', kind: 'qemu', percent: 100, version: ver });
      return { ok: true, dir: targetDir, version: ver, qemuVersion: ver };
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * 一键准备运行时：QEMU 包（缺则下载）+ 镜像变体（缺则下载）。
   * @param {object} opts { variant, mirror, manifest }
   */
  async downloadAll(opts = {}) {
    if (this._download) return { ok: false, error: '已有下载任务进行中' };
    const task = opts.task || { cancelled: false, current: null };
    if (!opts.task) this._download = task;
    try {
      const mirror = opts.mirror || this.runtime.vm.mirror || 'official';
      const results = { qemu: null, image: null };
      // 1) QEMU 运行时
      const qemu = this.qemuPackInstalled();
      if (!qemu || opts.forceQemu) {
        task.current = 'qemu';
        const packManifest = opts.qemuManifest || (await fetchQemuManifestWithFallback(mirror)).data;
        results.qemu = await this.downloadQemuPack({ mirror, manifest: packManifest, task });
      } else {
        results.qemu = { ok: true, skipped: true, dir: qemu.dir };
        this.emit('progress', { phase: 'done', kind: 'qemu', percent: 100, skipped: true });
      }
      if (task.cancelled) throw new DownloadCancelled();
      // 2) 镜像
      task.current = 'image';
      results.image = await this.download({ variant: opts.variant, mirror, manifest: opts.manifest, task });
      if (!results.image.ok && !(results.image.error || '').includes('已取消')) {
        return { ok: false, error: results.image.error, results };
      }
      if (task.cancelled) throw new DownloadCancelled();
      return { ok: true, results, version: results.image.version, variant: results.image.variant };
    } catch (e) {
      if (e instanceof DownloadCancelled || e.code === 'DOWNLOAD_CANCELLED') return { ok: false, error: '已取消' };
      return { ok: false, error: e.message };
    } finally {
      this._download = null;
    }
  }

  /**
   * 下载指定变体的镜像 + 内核 + initrd（幂等，sha256 校验）。
   * @param {object} opts { variant, version, mirror, manifest }
   */
  async download(opts = {}) {
    // opts.task：由 downloadAll 传入（共享同一个任务，避免"已有下载任务进行中"误挡）
    if (!opts.task && this._download) return { ok: false, error: '已有下载任务进行中' };
    const variant = images.variantById(opts.variant || this.variant).id;
    const mirror = opts.mirror || this.runtime.vm.mirror || 'official';
    const task = { cancelled: false, current: null };
    this._download = task;
    try {
      const manifest = opts.manifest || (await fetchManifestWithFallback(mirror)).data;
      const picked = images.pickArtifacts(manifest, { variant, mirror });
      const verDir = path.join(this.assetsDir, 'images', variant, picked.version);
      fs.mkdirSync(verDir, { recursive: true });
      const ga = picked.arch;
      const targets = [
        { kind: 'image', url: picked.image.downloadUrl, dest: path.join(verDir, `cibyp-vmos-${picked.version}-${variant}-${ga}.qcow2`), sha256: picked.image.sha256, size: picked.image.size, weight: 0.9 },
        { kind: 'kernel', url: picked.kernel.downloadUrl, dest: path.join(verDir, `vmlinuz-${ga}`), sha256: picked.kernel.sha256, size: picked.kernel.size, weight: 0.05 },
        { kind: 'initrd', url: picked.initrd.downloadUrl, dest: path.join(verDir, `initrd-${ga}.img`), sha256: picked.initrd.sha256, size: picked.initrd.size, weight: 0.05 },
      ];
      for (const t of targets) {
        if (task.cancelled) throw new DownloadCancelled();
        task.current = t.kind;
        this.emit('progress', { phase: 'start', kind: t.kind, version: picked.version, variant });
        await downloadFile({
          url: t.url,
          dest: t.dest,
          sha256: t.sha256,
          size: t.size,
          aria2: this.aria2,
          isCancelled: () => task.cancelled,
          onProgress: (p) => this.emit('progress', { phase: 'download', kind: t.kind, version: picked.version, variant, ...p }),
        });
        this.emit('progress', { phase: 'done', kind: t.kind, version: picked.version, variant, percent: 100 });
      }
      // 记录 manifest 快照，便于离线查看版本信息
      try {
        fs.writeFileSync(path.join(verDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      } catch { /* ignore */ }
      return { ok: true, version: picked.version, variant, dir: verDir };
    } catch (e) {
      if (e instanceof DownloadCancelled || e.code === 'DOWNLOAD_CANCELLED') return { ok: false, error: '已取消' };
      return { ok: false, error: e.message };
    } finally {
      if (!opts.task) this._download = null;
    }
  }

  /** 切换镜像变体（需重启 VM 生效；调用方负责提示） */
  setVariant(variant) {
    const v = images.variantById(variant);
    const s = this.getSettings();
    s.runtime = s.runtime || {};
    s.runtime.vm = Object.assign({}, s.runtime.vm, { variant: v.id, imageVersion: null });
    this.persistSettings();
    return { ok: true, variant: v.id };
  }
}

module.exports = { VmService };
