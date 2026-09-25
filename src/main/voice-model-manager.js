/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 语音模型运行时下载管理器：
 *   - 优先复用内置 aria2（多连接加速 + 断点续传），不可用时回退普通流式下载；
 *   - 支持 CN 镜像（hf-mirror.com）/ 官方源（huggingface.co）切换；
 *   - 不自动下载：全部由用户在设置 → 资源下载中手动触发；
 *   - 进度通过 EventEmitter('progress'|'done'|'error') 上报给主进程转发渲染进程。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { aria2Manager } = require('./aria2-manager');
const vm = require('./voice-models');

const FETCH_TIMEOUT_MS = 10 * 60 * 1000; // 大文件（100MB+）允许 10 分钟
const POLL_INTERVAL_MS = 500;

class VoiceModelManager extends EventEmitter {
  /**
   * @param {object} opts { app, getSettings, persistSettings? }
   */
  constructor(opts) {
    super();
    this.app = opts.app;
    this.getSettings = opts.getSettings || (() => ({}));
    this._jobs = new Map(); // id -> { cancelled, gid, controller }
  }

  get dir() {
    return vm.resolveVoiceModelDir(this.app, this.getSettings());
  }

  get mirror() {
    const s = this.getSettings();
    return (s.resources && s.resources.mirror) || 'cn';
  }

  roots() {
    return vm.searchRoots(this.app, this.getSettings());
  }

  /** 全部模型状态（UI 用） */
  status() {
    const roots = this.roots();
    const downloadRoot = this.dir;
    return {
      dir: downloadRoot,
      mirror: this.mirror,
      aria2: aria2Manager.isAlive ? aria2Manager.isAlive() : false,
      models: vm.CATALOG.map((m) => {
        const st = vm.modelStatus(roots, m, downloadRoot);
        const running = this._jobs.get(m.id);
        return {
          id: m.id,
          label: m.label,
          kind: m.kind,
          size: m.size,
          required: !!m.required,
          installed: st.installed,
          missingFiles: st.missingFiles,
          bytes: st.bytes,
          downloading: !!running && !running.cancelled,
        };
      }),
    };
  }

  isDownloading(id) {
    const job = id ? this._jobs.get(id) : null;
    if (job && !job.cancelled) return true;
    return [...this._jobs.values()].some(j => !j.cancelled);
  }

  cancel(id) {
    const job = this._jobs.get(id);
    if (!job) return { ok: false, error: '没有进行中的下载' };
    job.cancelled = true;
    try { if (job.controller) job.controller.abort(); } catch (_) {}
    if (job.gid) {
      Promise.resolve().then(() => aria2Manager.cancel(job.gid, true).catch(() => {}));
    }
    return { ok: true };
  }

  _progress(payload) {
    this.emit('progress', payload);
  }

  /**
   * 下载单个模型（幂等：已安装文件自动跳过）。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async download(id) {
    const model = vm.CATALOG.find(m => m.id === id);
    if (!model) return { ok: false, error: '未知模型: ' + id };
    if (this.isDownloading(id)) return { ok: false, error: '该模型正在下载中' };
    const job = { cancelled: false, gid: null, controller: null };
    this._jobs.set(id, job);
    try {
      const dir = this.dir;
      fs.mkdirSync(dir, { recursive: true });
      if (model.tar) {
        await this._downloadTarModel(model, dir, job);
      } else {
        await this._downloadFilesModel(model, dir, job);
      }
      if (job.cancelled) return { ok: false, error: '已取消' };
      // 完整性校验
      const st = vm.modelStatus(this.roots(), model, dir);
      if (!st.installed) {
        return { ok: false, error: '下载完成但文件不完整: ' + st.missingFiles.join(', ') };
      }
      this._progress({ modelId: id, phase: 'done', percent: 100 });
      this.emit('done', { modelId: id });
      return { ok: true };
    } catch (e) {
      if (job.cancelled) return { ok: false, error: '已取消' };
      this.emit('error', { modelId: id, error: e.message });
      return { ok: false, error: e.message };
    } finally {
      this._jobs.delete(id);
    }
  }

  async _downloadFilesModel(model, dir, job) {
    const fileCount = model.files.length + (model.dirs || []).length;
    let index = 0;
    for (const file of model.files) {
      if (job.cancelled) return;
      index++;
      const rel = vm.fileRelPath(model, file);
      const dest = path.join(dir, rel);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        this._progress({ modelId: model.id, file: rel, fileIndex: index, fileCount, percent: 100, phase: 'skip' });
        continue;
      }
      const url = vm.resolveFileUrl(file, this.mirror);
      await this._downloadOne(url, dest, (p) => {
        this._progress({ modelId: model.id, file: rel, fileIndex: index, fileCount, ...p, phase: 'download' });
      }, job);
    }
    for (const sub of model.dirs || []) {
      if (job.cancelled) return;
      index++;
      await this._downloadHfDir(model, sub, dir, index, fileCount, job);
    }
  }

  /** HF 目录递归下载（Tree API → 逐文件） */
  async _downloadHfDir(model, subDir, dir, dirIndex, fileCount, job) {
    const origin = vm.mirrorOrigin(this.mirror);
    const repo = model.files.find(f => f.type === 'hf' && f.repo)?.repo;
    if (!repo) throw new Error('目录下载缺少 HF repo 信息');
    const listing = await this._fetchTree(repo, subDir, origin);
    const total = listing.length;
    let done = 0;
    for (const entry of listing) {
      if (job.cancelled) return;
      const rel = `${subDir}/${entry.path}`;
      const dest = path.join(dir, rel);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { done++; continue; }
      const url = `${origin}/${repo}/resolve/main/${rel.split('/').map(encodeURIComponent).join('/')}`;
      await this._downloadOne(url, dest, (p) => {
        this._progress({
          modelId: model.id, file: rel, fileIndex: dirIndex, fileCount,
          dirFileIndex: done, dirFileCount: total, ...p, phase: 'download',
        });
      }, job);
      done++;
    }
  }

  async _fetchTree(repo, dirPath, origin) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 50; page++) {
      const url = `${origin}/api/models/${repo}/tree/main/${dirPath}?recursive=true&limit=128` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error(`目录清单获取失败 HTTP ${resp.status}（${dirPath}）`);
      const items = await resp.json();
      for (const it of items) {
        if (it.type !== 'file' || !it.path) continue;
        if (!it.path.startsWith(dirPath + '/')) continue;
        out.push({ path: it.path.slice(dirPath.length + 1), size: it.size || 0 });
      }
      const link = resp.headers.get('link') || '';
      const m = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
      if (!m) break;
      let next = null;
      try { next = new URL(m[1]).searchParams.get('cursor'); } catch (_) { next = null; }
      if (!next || next === cursor) break;
      cursor = next;
    }
    if (!out.length) throw new Error(`目录清单为空: ${dirPath}`);
    return out;
  }

  /** GitHub tar 包下载 + 系统 tar 解压（KWS） */
  async _downloadTarModel(model, dir, job) {
    const tar = model.tar;
    const archive = path.join(dir, `.tmp-${model.id}.tar.bz2`);
    this._progress({ modelId: model.id, file: archive, fileIndex: 1, fileCount: 2, percent: 0, phase: 'download' });
    await this._downloadOne(tar.url, archive, (p) => {
      this._progress({ modelId: model.id, file: model.id + '.tar.bz2', fileIndex: 1, fileCount: 2, ...p, phase: 'download' });
    }, job);
    if (job.cancelled) return;
    this._progress({ modelId: model.id, phase: 'extract', percent: 100 });
    const destDir = path.join(dir, tar.destDir);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    await this._extractTar(archive, path.dirname(destDir));
    // 清理压缩包与无用文件（keepExtracted 语义：只保留引擎需要的文件）
    try { fs.unlinkSync(archive); } catch (_) {}
    const keep = new Set(tar.keep || []);
    try {
      for (const name of fs.readdirSync(destDir)) {
        if (!keep.has(name)) {
          const p = path.join(destDir, name);
          fs.rmSync(p, { recursive: true, force: true });
        }
      }
    } catch (_) {}
  }

  _extractTar(archive, cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xjf', archive], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => reject(new Error('系统 tar 不可用: ' + e.message)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`解压失败（tar 退出码 ${code}）${err ? ': ' + err.slice(0, 200) : ''}`));
      });
    });
  }

  /**
   * 单文件下载：优先 aria2，失败自动回退普通下载。
   */
  async _downloadOne(url, dest, onProgress, job) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const useAria2 = await this._canUseAria2();
    if (useAria2) {
      try {
        await this._downloadViaAria2(url, dest, onProgress, job);
        return;
      } catch (e) {
        if (job.cancelled) throw new Error('已取消');
        // aria2 失败：清掉半成品（含 .aria2 控制文件）后回退
        try { fs.unlinkSync(dest); } catch (_) {}
        try { fs.unlinkSync(dest + '.aria2'); } catch (_) {}
      }
    }
    await this._downloadViaFetch(url, dest, onProgress, job);
  }

  async _canUseAria2() {
    try {
      if (typeof aria2Manager.isAlive === 'function' && aria2Manager.isAlive()) return true;
      return await aria2Manager.ensureStarted();
    } catch (_) {
      return false;
    }
  }

  async _downloadViaAria2(url, dest, onProgress, job) {
    const gid = await aria2Manager.addUri(url, {
      dir: path.dirname(dest),
      out: path.basename(dest),
      split: 8,
      maxConnections: 8,
    });
    job.gid = gid;
    if (job.cancelled) { await aria2Manager.cancel(gid, true).catch(() => {}); throw new Error('已取消'); }
    let last = null;
    let lastProgressAt = Date.now();
    const STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟无进度视为 aria2 卡死 → 回退普通下载
    for (;;) {
      if (job.cancelled) {
        await aria2Manager.cancel(gid, true).catch(() => {});
        throw new Error('已取消');
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      let st;
      try {
        st = await aria2Manager.tellStatus(gid);
      } catch (_) { continue; }
      if (!st) continue;
      const total = parseInt(st.totalLength || '0', 10);
      const done = parseInt(st.completedLength || '0', 10);
      const percent = total > 0 ? Math.min(99, Math.round(done / total * 100)) : 0;
      if (onProgress && (done !== last)) {
        onProgress({ downloaded: done, total, percent, speed: parseInt(st.downloadSpeed || '0', 10) });
        last = done;
        lastProgressAt = Date.now();
      }
      if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        await aria2Manager.cancel(gid, true).catch(() => {});
        throw new Error('aria2 长时间无进度');
      }
      if (st.status === 'complete') {
        try { await aria2Manager.removeDownloadResult(gid); } catch (_) {}
        if (!fs.existsSync(dest) || fs.statSync(dest).size <= 0) throw new Error('aria2 下载完成但文件为空');
        if (total > 0 && fs.statSync(dest).size < total * 0.99) throw new Error('aria2 下载文件不完整');
        if (onProgress) onProgress({ downloaded: fs.statSync(dest).size, total: fs.statSync(dest).size, percent: 100 });
        return;
      }
      if (st.status === 'error' || st.status === 'removed') {
        throw new Error(st.errorMessage || `aria2 下载失败（${st.status}）`);
      }
    }
  }

  async _downloadViaFetch(url, dest, onProgress, job) {
    const controller = new AbortController();
    job.controller = controller;
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const tmp = dest + '.part';
    try {
      const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const total = parseInt(resp.headers.get('content-length') || '0', 10);
      const out = fs.createWriteStream(tmp);
      const { Readable } = require('stream');
      const body = Readable.fromWeb(resp.body);
      let downloaded = 0;
      let lastTick = 0;
      body.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (onProgress && now - lastTick > 300) {
          lastTick = now;
          onProgress({ downloaded, total, percent: total > 0 ? Math.min(99, Math.round(downloaded / total * 100)) : 0 });
        }
      });
      await new Promise((resolve, reject) => {
        body.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        body.on('error', reject);
        controller.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
      });
      if (job.cancelled) throw new Error('已取消');
      fs.renameSync(tmp, dest);
      if (onProgress) onProgress({ downloaded, total: total || downloaded, percent: 100 });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    } finally {
      clearTimeout(timeout);
      job.controller = null;
    }
  }

  /** 删除一个模型的全部文件（仅删除下载目录内该模型的文件/目录） */
  deleteModel(id) {
    const model = vm.CATALOG.find(m => m.id === id);
    if (!model) return { ok: false, error: '未知模型' };
    if (this.isDownloading(id)) return { ok: false, error: '下载进行中，无法删除' };
    const dir = this.dir;
    const targets = new Set();
    for (const f of model.files) targets.add(vm.fileRelPath(model, f));
    if (model.tar) {
      for (const keep of model.tar.keep || []) targets.add(path.join(model.tar.destDir, keep).split(path.sep).join('/'));
    }
    for (const sub of model.dirs || []) targets.add(path.join(vm.modelDirOf(model), sub).split(path.sep).join('/'));
    for (const rel of targets) {
      const p = path.join(dir, rel);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
    }
    return { ok: true };
  }
}

module.exports = { VoiceModelManager };
