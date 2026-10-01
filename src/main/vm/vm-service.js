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
      if (mirror !== preferred) console.log('[vm] Manifest download switched to mirror:', mirror);
      return { data, mirror };
    } catch (e) { lastErr = e; console.warn('[vm] Manifest download failed (' + mirror + '):', e.message); }
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
const vmpaths = require('./vm-paths');
const { VmInstance } = require('./vm-instance');
const { downloadFile, DownloadCancelled } = require('./vm-download');
const { WorkspaceSync } = require('./vm-workspace');
const { VmGraphics } = require('./vm-graphics');
const { VmAppearanceSync } = require('./vm-theme');

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
    this.appearanceSync = new VmAppearanceSync({
      getInstance: () => this.instance,
      getTheme: () => this.getSettings().theme || {},
      getSystemDark: opts.getSystemDark || (() => false),
    });
    this.emergencyHost = false;
    this._download = null; // { cancelled, current }
    this.extraHostRoots = []; // 额外宿主根（如工作区基目录），映射到同一个 VM 挂载点
  }

  /** 登记额外宿主根（App 工作区基目录等），保证宿主路径 → VM 路径映射完整 */
  addHostRoot(p) {
    if (!p) return;
    try {
      const abs = path.resolve(String(p));
      if (!this.extraHostRoots.some((x) => path.resolve(x) === abs)) this.extraHostRoots.push(abs);
    } catch { /* ignore */ }
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
   * 跳过生成文件，单文件默认上限 20MB；IDE 导入保留 Git 并持久识别宿主来源。
   */
  async mountExternalDir(hostDir, { maxFileMB = 20, refresh = false, preserveGit = false } = {}) {
    const hostRoot = path.resolve(String(hostDir || ''));
    if (!hostRoot || !fs.existsSync(hostRoot)) return { ok: false, error: '目录不存在: ' + hostRoot };
    const name = path.basename(hostRoot).replace(/[^\w.-]+/g, '_') || 'ws';
    let vmRoot = `/workspace/_external/${name}`;
    const identity = require('node:crypto').createHash('sha256').update(process.platform === 'win32' ? hostRoot.toLowerCase() : hostRoot).digest('hex');
    if (preserveGit) vmRoot += '-' + identity.slice(0, 8);
    this._externMounts = this._externMounts || new Map();
    if (this._externMounts.has(hostRoot) && !refresh) {
      // 已挂载：不重复 push，避免用宿主旧副本覆盖 VM 内的新改动。
      return { ok: true, hostRoot, vmRoot: this._externMounts.get(hostRoot), reused: true };
    }
    if ([...this._externMounts.entries()].some(([other, target]) => other !== hostRoot && target === vmRoot)) {
      vmRoot += '-' + require('node:crypto').createHash('sha256').update(hostRoot).digest('hex').slice(0, 8);
    }
    if (preserveGit && fs.existsSync(path.join(hostRoot, '.git')) && !fs.statSync(path.join(hostRoot, '.git')).isDirectory()) {
      return { ok: false, error: 'Git worktree 的 .git 文件引用宿主目录，请在 VM 内克隆仓库后打开，避免导入失效的 Git 路径。' };
    }
    const { VmFs } = require('./vm-fs');
    const vmFs = new VmFs({ vmService: this });
    const marker = vmRoot + '/.cibyp-host-import';
    if (preserveGit && await vmFs.exists(vmRoot)) {
      let previous;
      try { previous = JSON.parse((await vmFs.readBuffer(marker)).toString('utf8')); } catch { /* Unknown or incomplete import stays untouched. */ }
      if (previous?.identity !== identity) return { ok: false, error: 'VM 导入目录已存在但来源无法确认。请直接在 IDE 中打开 ' + vmRoot + '，避免覆盖已有文件。' };
      this._externMounts.set(hostRoot, vmRoot);
      return { ok: true, hostRoot, vmRoot, reused: true };
    }
    const skip = new Set(['node_modules', '.git', 'dist', 'out', '.cache', '.venv', '__pycache__', '.next', '.cibyp-code-history']);
    if (preserveGit) skip.delete('.git');
    skip.add('.cibyp-host-import');
    const maxBytes = Math.max(1, Number(maxFileMB) || 20) * 1024 * 1024;
    const push = async (from, to) => {
      await vmFs.exec(`mkdir -p ${vmpaths.shellQuote(to)}`, 20000);
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const src = path.join(from, e.name);
        const dst = to + '/' + e.name;
        if (e.isDirectory()) { await push(src, dst); continue; }
        if (e.isSymbolicLink()) continue;
        if (!path.relative(hostRoot, src).split(path.sep).includes('.git') && fs.statSync(src).size > maxBytes) continue;
        await vmFs.pushFromHost(src, dst);
      }
    };
    await push(hostRoot, vmRoot);
    if (preserveGit) await vmFs.writeBuffer(marker, Buffer.from(JSON.stringify({ identity, hostRoot }) + '\n'));
    this._externMounts.set(hostRoot, vmRoot);
    console.log('[vm] External directory mounted:', hostRoot, '→', vmRoot);
    return { ok: true, hostRoot, vmRoot };
  }

  /**
   * 外部挂载目录：把 VM 内的新改动拉回宿主镜像（只在新/更新时覆盖，不删除宿主文件）。
   * 供 Code 模式文件树刷新、ESLint、打开资源管理器前调用，保证宿主镜像与 VM 一致。
   */
  async pullExternalDir(hostOrVmPath, { maxFileMB = 20, deleted = false } = {}) {
    if (this.runtime.workspaceMode !== 'shared') return {ok:true,pulled:0,skipped:'isolated'};
    if (!this.instance || this.instance.state !== 'ready') return { ok: false, error: '虚拟机未就绪' };
    if (!this._externMounts || !this._externMounts.size) return { ok: true, pulled: 0, skipped: 'no-mounts' };
    const paths = require('./vm-paths');
    const raw = String(hostOrVmPath || '');
    let hostRoot = null;
    let vmRoot = null;
    let sub = ''; // 相对挂载根的 VM 侧子路径
    if (this.isVmPath(raw)) {
      for (const [h, v] of this._externMounts) {
        if (raw === v || raw.startsWith(v + '/')) {
          hostRoot = h; vmRoot = v; sub = raw.slice(v.length).replace(/^\/+/, ''); break;
        }
      }
    } else {
      for (const [h, v] of this._externMounts) {
        const rel = paths.relUnder(h, raw);
        if (rel !== null) { hostRoot = h; vmRoot = v; sub = rel; break; }
      }
    }
    if (!hostRoot || !vmRoot) return { ok: true, pulled: 0, skipped: 'not-external' };
    const { VmFs } = require('./vm-fs');
    const vmFs = new VmFs({ vmService: this });
    const skip = new Set(['node_modules', '.git', 'dist', 'out', '.cache', '.venv', '__pycache__', '.next', '.cibyp-code-history']);
    const maxBytes = Math.max(1, Number(maxFileMB) || 20) * 1024 * 1024;
    let pulled = 0;
    let removed = 0;
    const targetVm = sub ? `${vmRoot}/${sub}` : vmRoot;
    const targetHost = sub ? path.join(hostRoot, ...sub.split('/')) : hostRoot;
    const stat = await vmFs.stat(targetVm).catch(() => null);
    if (!stat) {
      // VM 内已不存在：删除宿主镜像对应项（仅在明确的删除操作后执行）
      if (deleted) {
        try { fs.rmSync(targetHost, { recursive: true, force: true }); removed = 1; } catch { /* ignore */ }
      }
      return { ok: true, pulled: 0, removed, hostRoot, vmRoot };
    }
    if (stat.isFile) {
      try {
        let hostStat = null;
        try { hostStat = fs.statSync(targetHost); } catch { /* missing */ }
        if (!hostStat || stat.size !== hostStat.size || (Number(stat.mtimeMs) || 0) > hostStat.mtimeMs + 1000) {
          const sftp = await vmFs.sftp();
          fs.mkdirSync(path.dirname(targetHost), { recursive: true });
          await sftp.fastGet(targetVm, targetHost);
          if (stat.mtimeMs) { try { const t = new Date(stat.mtimeMs); fs.utimesSync(targetHost, t, t); } catch { /* ignore */ } }
          pulled = 1;
        }
      } catch { /* ignore */ }
      return { ok: true, pulled, hostRoot, vmRoot };
    }
    const walk = async (vmDir, hostDir) => {
      fs.mkdirSync(hostDir, { recursive: true });
      const r = await vmFs.listDirectory(vmDir).catch(() => null);
      if (!r || !r.ok || !Array.isArray(r.entries)) return;
      for (const e of r.entries) {
        const name = e && e.name;
        if (!name || skip.has(name)) continue;
        const vp = vmDir + '/' + name;
        const hp = path.join(hostDir, name);
        if (e.isDirectory) { await walk(vp, hp); continue; }
        try {
          const st = await vmFs.stat(vp);
          if (!st || st.size > maxBytes) continue;
          let hostStat = null;
          try { hostStat = fs.statSync(hp); } catch { /* missing */ }
          const vmMs = Number(st.mtimeMs) || 0;
          if (!hostStat || vmMs > hostStat.mtimeMs + 1000) {
            const sftp = await vmFs.sftp();
            fs.mkdirSync(path.dirname(hp), { recursive: true });
            await sftp.fastGet(vp, hp);
            if (vmMs) { try { const t = new Date(vmMs); fs.utimesSync(hp, t, t); } catch { /* ignore */ } }
            pulled++;
          }
        } catch { /* 单个文件失败不影响整体 */ }
      }
    };
    await walk(targetVm, targetHost);
    return { ok: true, pulled, removed, hostRoot, vmRoot };
  }

  /** 该路径是否应按"VM 内路径"处理（统一判定，见 vm-paths.js） */
  isVmPath(p) {
    const s = String(p || '');
    if (!s.startsWith('/')) return false;
    const paths = require('./vm-paths');
    // 1) 命中宿主映射根 → 必为宿主路径（新建文件也算，POSIX 上尤为重要）
    try {
      const hostRoots = [];
      const wsRoot = this.workspaceRoot;
      if (wsRoot) hostRoots.push(path.resolve(wsRoot));
      for (const extra of (this.extraHostRoots || [])) if (extra) hostRoots.push(path.resolve(extra));
      if (this._externMounts) for (const [h] of this._externMounts) hostRoots.push(path.resolve(h));
      for (const h of hostRoots) {
        if (paths.isUnder(h, s)) return false;
      }
    } catch { /* ignore */ }
    const mount = (this.runtime.vm && this.runtime.vm.workspaceMount) || '/workspace';
    const vmRoots = [];
    if (this._externMounts) for (const [, v] of this._externMounts) vmRoots.push(v);
    return paths.isVmPath(s, { mount, vmRoots });
  }

  /** 宿主路径 → VM 路径（未同步/未就绪时退化为 /workspace） */
  toVmPath(hostPath) {
    try {
      const raw = String(hostPath || '');
      if (!raw) return raw;
      if (this.isVmPath(raw)) return raw; // 已是 VM 内路径（幂等）
      const paths = require('./vm-paths');
      if (this._externMounts && this._externMounts.size) {
        for (const [hostRoot, vmRoot] of this._externMounts) {
          const rel = paths.relUnder(hostRoot, raw);
          if (rel !== null) return rel ? `${vmRoot}/${rel}` : vmRoot;
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

  /** Prepare the actual session directory before an interactive shell is opened. */
  async prepareTerminalDirectory(hostOrVmPath) {
    if (!this.instance || this.instance.state !== 'ready') await this.start();
    const { VmFs } = require('./vm-fs');
    const vmFs = new VmFs({ vmService: this });
    const mount = this.runtime.vm.workspaceMount || '/workspace';
    const raw = String(hostOrVmPath || mount);
    const target = vmFs.resolveVmPath(raw);
    if (!target.ok) throw new Error(target.error);
    if (this.runtime.workspaceMode === 'shared') {
      const extra = !vmFs.isVmPath(raw) && vmFs.mappingRoots().find(([root]) => vmpaths.isUnder(root, raw));
      let synced;
      if (extra && path.resolve(extra[0]) !== path.resolve(this.workspaceRoot)) {
        // Session workspaces are also registered by the app. Synchronize this
        // directory, with its own baseline, rather than the unrelated default root.
        if (!fs.statSync(raw).isDirectory()) throw new Error('终端工作目录不是文件夹: ' + raw);
        const key = require('crypto').createHash('sha256').update(path.resolve(raw) + '\0' + target.vm).digest('hex');
        this._terminalSyncs = this._terminalSyncs || new Map();
        let sync = this._terminalSyncs.get(key);
        if (!sync) {
          sync = new WorkspaceSync({
            vmService: this, hostRoot: raw, vmMount: target.vm,
            instanceDir: this.instance.dir ? path.join(this.instance.dir, 'terminal-sync', key) : null,
            options: { maxFileMB: this.runtime.vm.syncMaxFileMB || 64, syncGit: !!this.runtime.vm.syncGit },
          });
          this._terminalSyncs.set(key, sync);
        }
        synced = await sync.sync({ direction: 'both', reason: 'terminal-open' });
      } else synced = await this.syncWorkspace({ direction: 'both', reason: 'terminal-open' });
      if (!synced.ok) throw new Error(synced.error || '工作区同步失败');
    }
    // File synchronization does not transfer empty folders. Create mapped workspace
    // directories explicitly, but do not create arbitrary guest system directories.
    const isWorkspace = target.vm === mount || target.vm.startsWith(mount.replace(/\/+$/, '') + '/');
    const quoted = vmpaths.shellQuote(target.vm);
    const command = `${isWorkspace ? `mkdir -p -- ${quoted} && ` : ''}test -d ${quoted} && test -x ${quoted}`;
    const checked = await this.instance.exec(command, { timeoutMs: 20000 });
    if (!checked.ok) throw new Error(`无法进入虚拟机工作目录 ${target.vm}: ${checked.stderr || '目录不存在或没有访问权限'}`);
    return target.vm;
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
    if (this.instance && !['idle', 'failed'].includes(this.instance.state)) return this.instance;
    const st = images.localStatus(this.assetsDir, { variant: this.variant });
    const selected = this.runtime.vm.imageVersion
      ? st.versions.find((v) => v.version === this.runtime.vm.imageVersion && v.ok) || st.selected
      : st.selected;
    if (!selected) {
      const err = new Error('CIBYP-VM-OS 镜像未下载（设置 → 虚拟机沙盒 → 下载）');
      err.code = qemuRuntime.VM_SANDBOX_UNAVAILABLE;
      throw err;
    }
    if (this.instance && this.instance.opts.imagePath === selected.image && this.instance.assetsDir === this.assetsDir) return this.instance;
    // Each image gets a persistent disk. Keep compatible legacy instances, and
    // leave older image disks untouched when installing a new OS version.
    let instanceName = 'default-' + require('crypto').createHash('sha256').update(path.resolve(selected.image)).digest('hex').slice(0, 16);
    try {
      const legacy = JSON.parse(fs.readFileSync(path.join(this.assetsDir, 'instances', 'default', 'instance.json'), 'utf8'));
      if (legacy.imagePath && path.resolve(legacy.imagePath) === path.resolve(selected.image)) instanceName = 'default';
    } catch { /* No compatible legacy instance. */ }
    this.sync = null;
    this._terminalSyncs = new Map();
    this._externMounts = new Map();
    const inst = new VmInstance({
      assetsDir: this.assetsDir,
      imagePath: selected.image,
      kernelPath: selected.kernel,
      initrdPath: selected.initrd,
      variant: this.variant,
      version: selected.version,
      appPath: this.app.getAppPath(),
      instanceName,
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
      this.syncAppearance({ force: true }).catch((error) => console.warn('[vm] Appearance synchronization failed:', error.message));
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

  syncAppearance(options) {
    return this.appearanceSync.sync(options);
  }

  async stop() {
    if (!this.instance) return { ok: true };
    await this.graphicsStop();
    for (const port of [...(this._forwards || new Map()).keys()]) this.unforwardPort(port);
    await this.instance.stop();
    return { ok: true };
  }

  async reset() {
    const inst = this._ensureInstance();
    await this.graphicsStop();
    await inst.reset();
    this.sync = null;
    this._terminalSyncs = new Map();
    this._externMounts = new Map();
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

  /** 连接镜像内的 Wayland 桌面；旧镜像保留 X11 兼容路径。 */
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
    if (!this.instance || this.instance.state !== 'ready') await this.start();
    const g = this.graphicsController();
    await g.start();
    return g.startChromium(opts);
  }

  // ---------------------------------------------------------------- 虚拟机内下载（aria2 + GitHub 加速镜像）

  /**
   * 把远程文件下载并落到虚拟机里（宿主用 aria2 下载 → 推入 VM）。
   * @param {object} opts { url, dir（VM 内目录，默认 /workspace）、filename、mirror、sha256 }
   */
  downloadsController() {
    if (!this._guestDownloads) this._guestDownloads = new (require('./vm-download-manager').VmDownloadManager)(this);
    return this._guestDownloads;
  }

  async downloadFileToVm(opts = {}) {
    const url = String(opts.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '请填写 http(s) 链接' };
    const finalUrl = images.applyMirrorToUrl(url, opts.mirror || this.runtime.vm.mirror || 'official');
    const name = String(opts.filename || decodeURIComponent(new URL(finalUrl).pathname.split('/').pop()) || `download-${Date.now()}`).replace(/[\\/]/g, '_');
    const manager = this.downloadsController();
    if (this._download) return { ok: false, error: '已有下载任务进行中' };
    const task = { cancelled: false };
    this._download = task;
    try {
      const gid = await manager.addUri(finalUrl, { dir: opts.dir || '/workspace', out: name, checksum: opts.sha256 ? 'sha-256=' + opts.sha256 : undefined });
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        if (task.cancelled) { await manager.cancel(gid, true); throw new DownloadCancelled(); }
        const status = await manager.tellStatus(gid);
        this.emit('progress', { phase: 'download', kind: 'vm-file', filename: name, percent: Number(status.totalLength) ? Number(status.completedLength) / Number(status.totalLength) * 100 : 0 });
        if (status.status === 'complete') return { ok: true, location: 'vm', path: status.files[0].path, size: Number(status.completedLength), filename: name };
        if (status.status === 'error' || status.status === 'removed') throw new Error(status.errorMessage || status.status);
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      await manager.cancel(gid, true);
      throw new Error('VM 下载超时');
    } catch (error) { return { ok: false, location: 'vm', error: error instanceof DownloadCancelled ? '已取消' : error.message }; }
    finally { this._download = null; }
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
      // 第三个参数 keepOriginalPermission：macOS/Linux 必须保留 unix 执行位，否则 qemu 二进制 EACCES
      try { zip.extractAllTo(tmpDir, true, true); } catch { zip.extractAllTo(tmpDir, true); }
      if (process.platform !== 'win32') {
        // 兜底：Windows 打的 zip 通常没有 unix 权限位 → 显式给可执行位
        const fixExec = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { fixExec(p); continue; }
            if (/^(qemu-system-|qemu-img$)/.test(e.name) || e.name === 'qemu-img') {
              try { fs.chmodSync(p, 0o755); } catch { /* ignore */ }
            }
          }
        };
        fixExec(tmpDir);
        if (process.platform === 'darwin') {
          // Apple Silicon 上未签名的 Mach-O 会被内核拒绝；去 quarantine + ad-hoc 签名（失败不阻断）
          const { execFile } = require('child_process');
          try {
            execFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', tmpDir], () => {});
          } catch { /* ignore */ }
          try {
            execFile('/usr/bin/codesign', ['--force', '--sign', '-', tmpDir], () => {});
          } catch { /* ignore */ }
        }
      }
      // 自检：确认二进制可执行且能用
      const info = qemuRuntime.inspectQemuDir(tmpDir, images.guestArch(process.arch));
      if (!info) throw new Error('解压后未找到 qemu-system-* / qemu-img（包结构异常）');
      const ver = qemuRuntime.qemuVersion(info.exe);
      if (!ver) {
        const hint = process.platform === 'win32'
          ? '缺少依赖 DLL（Microsoft Visual C++ 运行库）'
          : process.platform === 'darwin'
            ? '二进制不可执行或缺少依赖（已被 Gatekeeper 拦截 / 依赖 dylib 缺失 / 需要 chmod +x）'
            : '二进制不可执行或缺少依赖（需要 chmod +x / glibc 版本或共享库缺失）';
        throw new Error('解压后的 QEMU 无法运行：' + hint);
      }
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.renameSync(tmpDir, targetDir);
      // rename 后再自检一次（跨设备/权限变化时能尽早发现）
      const finalInfo = qemuRuntime.inspectQemuDir(targetDir, images.guestArch(process.arch));
      if (finalInfo && !qemuRuntime.qemuVersion(finalInfo.exe)) {
        throw new Error('QEMU 安装后无法执行（权限/依赖问题），请查看设置页的自检输出');
      }
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
    const task = opts.task || { cancelled: false, current: null };
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
