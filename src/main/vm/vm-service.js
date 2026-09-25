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

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const images = require('./vm-images');
const qemuRuntime = require('./qemu-runtime');
const { VmInstance } = require('./vm-instance');
const { downloadFile, DownloadCancelled } = require('./vm-download');

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

  /** 紧急切回本机（本次运行生效；不写 settings） */
  emergencyHostMode() {
    this.emergencyHost = true;
    this.emit('emergency-host');
    return { ok: true };
  }

  // ---------------------------------------------------------------- 资源

  variants() {
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

  /**
   * 下载指定变体的镜像 + 内核 + initrd（幂等，sha256 校验）。
   * @param {object} opts { variant, version, mirror, manifest }
   */
  async download(opts = {}) {
    if (this._download) return { ok: false, error: '已有下载任务进行中' };
    const variant = images.variantById(opts.variant || this.variant).id;
    const mirror = opts.mirror || this.runtime.vm.mirror || 'official';
    const task = { cancelled: false, current: null };
    this._download = task;
    try {
      const manifest = opts.manifest || await images.fetchManifest({ mirror });
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
      this._download = null;
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
