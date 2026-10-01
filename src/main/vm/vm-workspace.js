/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 工作区同步内核（shared 模式：宿主为准 + 双向增量同步）。
 *
 * 语义：
 *   - 宿主工作区是"文件权威"；VM 侧 /workspace 是镜像，供 Agent 在隔离环境里读写
 *   - 每次同步基于三方比较：baseline（上次同步后的共识）、host 现状、vm 现状
 *       host 变 + vm 未变      → 推送
 *       vm 变 + host 未变      → 拉回
 *       两侧都变且内容不同      → 冲突：较新一方胜出，败方另存 <name>.conflict-<ts>
 *       一侧删除 + 另一侧未变   → 同步删除
 *       新增（baseline 无）     → 复制到另一侧
 *   - 大文件/排除项不同步（node_modules、dist、.cache、*.qcow2 等），可配置
 *
 * 传输：tar over SSH（vm-tar 编解码，分批，单批上限 16MB/2000 文件），
 * 不做逐文件 SFTP——小文件多时这样快得多。
 *
 * 触发：VM 就绪（全量）、工具调用前（推）/ 后（拉）、手动同步按钮。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { writeTar, parseTar, dirEntriesFor } = require('./vm-tar');
const { shellQuote } = require('./vm-paths');
const { scanDirectory, guestScanScript } = require('./workspace-manifest');

const BATCH_MAX_BYTES = 16 * 1024 * 1024;
const BATCH_MAX_FILES = 2000;
const CONFLICT_SUFFIX = '.conflict-';
/** 冲突备份目录（位于工作区内但被排除同步，用户可见可查） */
const CONFLICT_DIR = '.cibyp-conflicts';
const DEFAULT_EXCLUDES = {
  segments: ['node_modules', 'dist', 'out', '.cache', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.pytest_cache', '.idea', '.vs', CONFLICT_DIR],
  suffixes: ['.qcow2', '.img', '.vmdk', '.vhdx', '.iso', '.tar.gz', '.zip.tmp', '.log'],
  prefixes: ['.git/objects/pack/tmp_', '.git/index.lock', '.cibyp-ready'],
};

function nowMs() { return Date.now(); }

function toPosix(p) {
  const s = String(p);
  return path.sep === '\\' ? s.replace(/\\+/g, '/') : s;
}

class WorkspaceSync extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.vmService   提供 instance（含 exec/execStream/sftp）
   * @param {string} opts.hostRoot    宿主工作区根目录
   * @param {string} [opts.vmMount]   VM 内挂载点（默认 /workspace）
   * @param {string} [opts.instanceDir] baseline 落盘位置
   * @param {object} [opts.options]   { excludes, maxFileMB, syncGit, dryRun }
   */
  constructor(opts = {}) {
    super();
    this.vmService = opts.vmService;
    this.hostRoot = opts.hostRoot ? path.resolve(opts.hostRoot) : null;
    this.vmMount = opts.vmMount || '/workspace';
    this.instanceDir = opts.instanceDir || null;
    const o = opts.options || {};
    this.maxFileMB = Number(o.maxFileMB) || 64;
    this.syncGit = !!o.syncGit;
    this.dryRun = !!o.dryRun;
    this.excludes = o.excludes && o.excludes.length ? o.excludes : null; // 额外正则/字符串
    this.baselineFile = this.instanceDir ? path.join(this.instanceDir, 'sync-baseline.json') : null;
    this.baseline = this._loadBaseline();
    this._chain = Promise.resolve();
    this._hostCache = {};
    this._stats = { lastSyncAt: null, lastReason: null, pushed: 0, pulled: 0, conflicts: 0, skipped: [], deleted: 0 };
  }

  get stats() { return { ...this._stats, baselineFiles: Object.keys(this.baseline.files || {}).length }; }

  // ---------------------------------------------------------------- baseline

  _loadBaseline() {
    try {
      if (this.baselineFile && fs.existsSync(this.baselineFile)) {
        const j = JSON.parse(fs.readFileSync(this.baselineFile, 'utf8'));
        if (j && j.files && typeof j.files === 'object') return j;
      }
    } catch { /* 损坏则重建 */ }
    return { version: 1, savedAt: null, files: {} };
  }

  async _saveBaseline(files) {
    this.baseline = { version: 2, savedAt: new Date().toISOString(), files };
    if (!this.baselineFile) return;
    try {
      await fs.promises.mkdir(path.dirname(this.baselineFile), { recursive: true });
      // 原子写：异常中断也不会留下截断的 JSON
      const tmp = `${this.baselineFile}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(this.baseline));
      await fs.promises.rename(tmp, this.baselineFile);
    } catch (e) {
      this.emit('warn', '保存同步基线失败: ' + e.message);
    }
  }

  // ---------------------------------------------------------------- 路径映射

  toVmPath(hostPath) {
    if (!this.hostRoot) return this.vmMount;
    try {
      const rel = path.relative(this.hostRoot, path.resolve(hostPath));
      if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) return this.vmMount;
      return path.posix.join(this.vmMount, toPosix(rel));
    } catch { return this.vmMount; }
  }

  toHostPath(vmPath) {
    const p = String(vmPath || '');
    const mount = String(this.vmMount || '/workspace').replace(/\/+$/, '');
    if (p !== mount && !p.startsWith(mount + '/')) return null;
    const rel = p.slice(mount.length).replace(/^\/+/, '');
    if (!rel) return this.hostRoot;
    return this.hostRoot ? path.join(this.hostRoot, ...rel.split('/')) : null;
  }

  // ---------------------------------------------------------------- 扫描

  /** 排除判定（大小写不敏感：Windows/macOS 文件系统默认不区分大小写） */
  shouldExclude(rel) {
    const r = toPosix(rel).toLowerCase();
    const segs = r.split('/');
    for (const s of DEFAULT_EXCLUDES.segments) {
      if (segs.includes(String(s).toLowerCase())) return true;
    }
    if (!this.syncGit && (segs[0] === '.git' || segs.includes('.git'))) return true;
    for (const suf of DEFAULT_EXCLUDES.suffixes) {
      if (r.endsWith(String(suf).toLowerCase())) return true;
    }
    for (const pre of DEFAULT_EXCLUDES.prefixes) {
      if (r.startsWith(String(pre).toLowerCase())) return true;
    }
    if (this.excludes) {
      for (const pat of this.excludes) {
        try {
          if (pat instanceof RegExp) { if (pat.test(r)) return true; continue; }
          const needle = String(pat).replace(/\\/g, '/').toLowerCase();
          if (needle && r.includes(needle)) return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  }

  _scanOptions() {
    return {
      excludes: DEFAULT_EXCLUDES, syncGit: this.syncGit,
      maxBytes: this.maxFileMB * 1024 * 1024,
      extra: (this.excludes || []).map(value => value instanceof RegExp
        ? { regex: value.source, flags: value.flags.replace(/[gy]/g, '') }
        : { text: String(value).replace(/\\/g, '/').toLowerCase() }).filter(value => value.regex || value.text),
    };
  }

  async scanHost() {
    const files = await scanDirectory(this.hostRoot, this._scanOptions(), this._hostCache);
    this._hostCache = files;
    return files;
  }

  async scanVm() {
    const inst = this._instance();
    const identity = require('node:crypto').createHash('sha256').update(this.vmMount).digest('hex');
    const script = guestScanScript(this.vmMount, this._scanOptions(), '/tmp/cibyp-sync-' + identity + '.json');
    const result = await inst.exec('node -e ' + shellQuote(script), { timeoutMs: 120000 });
    if (!result.ok) throw new Error('VM 工作区扫描失败: ' + (result.stderr || result.code));
    const files = JSON.parse(result.stdout);
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('VM 工作区清单无效');
    return files;
  }

  // ---------------------------------------------------------------- diff

  static sameEntry(a, b) {
    if (!a || !b) return false;
    if (a.hash && b.hash) return a.hash === b.hash;
    return a.size === b.size && Math.abs((a.mtimeMs || 0) - (b.mtimeMs || 0)) < 1500;
  }

  diff(host, vm) {
    const base = this.baseline.files || {};
    const toVm = [], toHost = [], conflicts = [], deletesVm = [], deletesHost = [];
    const all = new Set([...Object.keys(host), ...Object.keys(vm), ...Object.keys(base)]);
    for (const rel of all) {
      if (this.shouldExclude(rel)) continue;
      const b = base[rel], h = host[rel], v = vm[rel];
      const hostChanged = !WorkspaceSync.sameEntry(h, b?.host || b);
      const vmChanged = !WorkspaceSync.sameEntry(v, b?.vm || b);
      if (h && !v) {
        if (hostChanged) toVm.push(rel);           // 宿主改 + VM 删 → 以宿主为准（复活到 VM）
        else if (b) deletesHost.push(rel);         // 宿主未变、VM 删除 → 把删除同步到宿主
        continue;
      }
      if (!h && v) {
        if (vmChanged) toHost.push(rel);           // VM 改 + 宿主删 → 保留 VM 的修改（拉回宿主）
        else if (b) deletesVm.push(rel);           // VM 未变、宿主删除 → 把删除同步到 VM
        continue;
      }
      if (!h && !v) continue;                     // 两侧都没了 → 只是从 baseline 移除
      // 两侧都有
      if (hostChanged && vmChanged) {
        if (WorkspaceSync.sameEntry(h, v)) continue; // 内容一致（可能都改了一样）
        const winner = (h.mtimeMs || 0) >= (v.mtimeMs || 0) ? 'host' : 'vm';
        conflicts.push({ rel, winner });
        if (winner === 'host') toVm.push(rel); else toHost.push(rel);
        continue;
      }
      if (hostChanged) toVm.push(rel);
      else if (vmChanged) toHost.push(rel);
    }
    return { toVm, toHost, conflicts, deletesVm, deletesHost };
  }

  // ---------------------------------------------------------------- 传输

  _instance() {
    const inst = this.vmService && this.vmService.instance;
    if (!inst || inst.state !== 'ready') {
      const e = new Error('虚拟机未就绪，无法同步工作区');
      e.code = 'VM_NOT_READY';
      throw e;
    }
    return inst;
  }

  /** 分批：按字节与文件数切分 */
  static batches(rels, sizes, maxBytes = BATCH_MAX_BYTES, maxFiles = BATCH_MAX_FILES) {
    const out = [];
    let cur = [], bytes = 0;
    for (const rel of rels) {
      const sz = (sizes && sizes[rel] && sizes[rel].size) || 0;
      if (cur.length && (bytes + sz > maxBytes || cur.length >= maxFiles)) {
        out.push(cur); cur = []; bytes = 0;
      }
      cur.push(rel); bytes += sz;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** 推送若干文件到 VM（tar over ssh） */
  async push(rels, sizes) {
    if (!rels.length) return { files: 0, bytes: 0 };
    const inst = this._instance();
    sizes = sizes || await this.scanHost();
    let files = 0, bytes = 0;
    for (const batch of WorkspaceSync.batches(rels, sizes)) {
      const entries = [...dirEntriesFor(batch)];
      for (const rel of batch) {
        const abs = path.join(this.hostRoot, ...rel.split('/'));
        let data = null;
        data = await fs.promises.readFile(abs);
        if (sizes[rel]?.hash && require('crypto').createHash('sha256').update(data).digest('hex') !== sizes[rel].hash)
          throw new Error('推送期间宿主文件发生变化: ' + rel);
        entries.push({ name: rel, data, mtime: Math.floor((sizes[rel] || {}).mtimeMs / 1000) });
        files++; bytes += data.length;
      }
      if (!entries.length) continue;
      const tar = writeTar(entries);
      await this._execWithStdin(inst, `tar -x -f - -C ${shellQuote(this.vmMount)} --no-same-owner --no-same-permissions`, tar, 300000);
      this.emit('progress', { direction: 'push', files, bytes });
    }
    return { files, bytes };
  }

  /** 从 VM 拉回若干文件；targetMap 可把某个 rel 落到别的宿主相对路径（冲突备份用） */
  async pull(rels, targetMap = null, sizes = null, expectedHost = null) {
    if (!rels.length) return { files: 0, bytes: 0 };
    const inst = this._instance();
    sizes = sizes || await this.scanVm();
    let files = 0, bytes = 0;
    for (const batch of WorkspaceSync.batches(rels, sizes)) {
      const list = batch.map((r) => shellQuote(r)).join(' ');
      const cmd = `tar -c -f - -C ${shellQuote(this.vmMount)} --format=pax -- ${list}`;
      const buf = await this._execWithStdout(inst, cmd, 300000);
      if (!buf || !buf.length) continue;
      const { entries, warnings } = parseTar(buf);
      for (const w of warnings) this.emit('warn', 'pull: ' + w);
      for (const e of entries) {
        if (e.type !== '0') continue;
        const rel = e.name.replace(/^\.\//, '');
        if (!batch.includes(rel)) throw new Error('VM 返回了未请求的文件: ' + rel);
        const digest = require('crypto').createHash('sha256').update(e.data).digest('hex');
        if (sizes[rel]?.hash && digest !== sizes[rel].hash) throw new Error('拉取期间 VM 文件发生变化: ' + rel);
        const targetRel = (targetMap && targetMap.get(rel)) || rel;
        const abs = path.join(this.hostRoot, ...targetRel.split('/'));
        if (expectedHost) {
          let current = null;
          try { current = await fs.promises.readFile(abs); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (current === null ? !!expectedHost[rel] : !expectedHost[rel] || require('crypto').createHash('sha256').update(current).digest('hex') !== expectedHost[rel].hash)
            throw new Error('拉取期间宿主文件发生变化，保留两端文件等待下次同步: ' + rel);
        }
        try {
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, e.data);
          // 保留 mtime（tar 记录的是整秒）：否则拉回后宿主 mtime=now，下次 diff 会误判"宿主改了"
          if (e.mtime) {
            const t = new Date(Number(e.mtime) * 1000);
            try { await fs.promises.utimes(abs, t, t); } catch { /* ignore */ }
          }
          files++; bytes += e.data.length;
        } catch (err) {
          throw new Error(`写入失败 ${targetRel}: ${err.message}`);
        }
      }
      this.emit('progress', { direction: 'pull', files, bytes });
    }
    return { files, bytes };
  }

  /** 删除（同步删除语义） */
  async deleteInVm(rels) {
    if (!rels.length) return 0;
    const inst = this._instance();
    const list = rels.map((r) => shellQuote(path.posix.join(this.vmMount, r))).join(' ');
    const result = await inst.exec(`rm -f -- ${list}`, { timeoutMs: 60000 });
    if (!result.ok) throw new Error('VM 删除同步失败: ' + result.stderr);
    return rels.length;
  }

  async deleteInHost(rels) {
    let n = 0;
    for (const rel of rels) {
      await fs.promises.rm(path.join(this.hostRoot, ...rel.split('/')), { force: true }); n++;
    }
    return n;
  }

  /** 冲突备份的宿主相对路径（放在 .cibyp-conflicts/ 下，不进同步） */
  conflictPathFor(rel, stamp) {
    return `${CONFLICT_DIR}/${rel}${CONFLICT_SUFFIX}${stamp}`;
  }

  /** 冲突：败方另存（保数据，不静默丢） */
  async preserveConflict(rel, loserSide, hostSnapshot, stamp) {
    const relSafe = this.conflictPathFor(rel, stamp || new Date().toISOString().replace(/[:.]/g, '-'));
    try {
      if (loserSide === 'host' && hostSnapshot) {
        const abs = path.join(this.hostRoot, ...relSafe.split('/'));
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, hostSnapshot);
      }
      this.emit('warn', `冲突保留（${loserSide === 'host' ? '宿主' : 'VM'}侧副本）: ${relSafe}`);
    } catch (e) { throw new Error('冲突保留失败: ' + e.message); }
  }

  // ---------------------------------------------------------------- 主入口

  /**
   * 同步（默认双向）。
   * @param {object} opts { direction: 'both'|'push'|'pull', reason }
   */
  sync(opts = {}) {
    // 串行化：同一时间只跑一次，后到的排队（避免并发 tar 互相覆盖）
    const run = () => this._syncOnce(opts);
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  async _syncOnce({ direction = 'both', reason = 'manual' } = {}) {
    if (!this.hostRoot) {
      return { ok: false, error: '工作区目录不存在: ' + this.hostRoot };
    }
    const t0 = nowMs();
    this.emit('sync-start', { direction, reason });
    try {
      this._stats.skipped = [];
      const [host, vm] = await Promise.all([this.scanHost(), this.scanVm()]);
      const d = this.diff(host, vm);

      let toVm = d.toVm, toHost = d.toHost;
      if (direction === 'push') toHost = [];
      if (direction === 'pull') toVm = [];

      const beforePull = new Map();
      for (const conflict of d.conflicts.filter(c => c.winner === 'vm' && toHost.includes(c.rel))) {
        beforePull.set(conflict.rel, await fs.promises.readFile(path.join(this.hostRoot, ...conflict.rel.split('/'))));
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');

      // 冲突处理：无论哪一方胜出，败方内容都保留到 .cibyp-conflicts/（不静默丢数据）
      const hostWins = d.conflicts.filter((c) => c.winner === 'host' && direction !== 'pull');
      if (hostWins.length) {
        const targetMap = new Map(hostWins.map((c) => [c.rel, this.conflictPathFor(c.rel, stamp)]));
        if (!this.dryRun) await this.pull(hostWins.map((c) => c.rel), targetMap, vm);
        for (const c of hostWins) this.emit('warn', `冲突保留（VM 侧副本）: ${this.conflictPathFor(c.rel, stamp)}`);
      }

      let pushRes = { files: 0, bytes: 0 }, pullRes = { files: 0, bytes: 0 };
      if (toVm.length && !this.dryRun) pushRes = await this.push(toVm, host);
      if (toHost.length && !this.dryRun) {
        for (const c of d.conflicts) {
          if (c.winner === 'vm' && beforePull.has(c.rel)) await this.preserveConflict(c.rel, 'host', beforePull.get(c.rel), stamp);
        }
        pullRes = await this.pull(toHost, null, vm, host);
      }
      const deletedVm = this.dryRun || direction === 'pull' ? 0 : await this.deleteInVm(d.deletesVm);
      const deletedHost = this.dryRun || direction === 'push' ? 0 : await this.deleteInHost(d.deletesHost);

      // 重新扫描并落 baseline（只记录"两侧都成功"的文件，失败的下次重试）
      const [hostAfter, vmAfter] = await Promise.all([this.scanHost(), this.scanVm()]);
      // A directional sync must retain the last consensus for changes awaiting
      // the other direction. Dropping it turns the next legitimate edit into a conflict.
      const files = Object.assign(Object.create(null), this.baseline.files);
      for (const rel of Object.keys(files)) if (!hostAfter[rel] && !vmAfter[rel]) delete files[rel];
      for (const rel of Object.keys(hostAfter)) {
        if (vmAfter[rel] && WorkspaceSync.sameEntry(hostAfter[rel], vmAfter[rel])) {
          files[rel] = { host: hostAfter[rel], vm: vmAfter[rel] };
        }
      }
      if (!this.dryRun) await this._saveBaseline(files);

      this._stats = {
        ...this._stats,
        lastSyncAt: new Date().toISOString(),
        lastReason: reason,
        pushed: pushRes.files,
        pulled: pullRes.files,
        conflicts: d.conflicts.length,
        deleted: deletedVm + deletedHost,
      };
      const out = {
        ok: true,
        reason,
        direction,
        pushed: pushRes.files,
        pulled: pullRes.files,
        deleted: deletedVm + deletedHost,
        conflicts: d.conflicts.map((c) => ({ rel: c.rel, winner: c.winner })),
        skipped: this._stats.skipped.slice(-20),
        ms: nowMs() - t0,
        hostFiles: Object.keys(hostAfter).length,
        vmFiles: Object.keys(vmAfter).length,
      };
      this.emit('sync-done', out);
      return out;
    } catch (e) {
      const out = { ok: false, error: e.message, reason, ms: nowMs() - t0 };
      this.emit('sync-error', out);
      return out;
    }
  }

  // ---------------------------------------------------------------- SSH 管道

  _execWithStdin(inst, cmd, buffer, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('推送超时: ' + cmd.slice(0, 80))), timeoutMs);
      inst.ssh.execStream(cmd).then(({ stream, done }) => {
        let stderr = '';
        stream.on('data', () => { /* 消费 stdout，避免背压 */ });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        done.then(({ code }) => {
          clearTimeout(timer);
          if (code === 0) resolve({ code });
          else reject(new Error(`tar 解包失败(${code}): ${stderr.slice(0, 300)}`));
        }).catch((e) => { clearTimeout(timer); reject(e); });
        stream.end(buffer);
      }).catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  _execWithStdout(inst, cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('拉取超时: ' + cmd.slice(0, 80))), timeoutMs);
      inst.ssh.execStream(cmd).then(({ stream, done }) => {
        const chunks = [];
        let total = 0;
        let stderr = '';
        const CAP = 512 * 1024 * 1024; // 单批 512MB 上限（分批已保证 16MB）
        stream.on('data', (d) => {
          total += d.length;
          if (total > CAP) {
            try { stream.close(); } catch { /* ignore */ }
            clearTimeout(timer);
            reject(new Error('拉取数据超过上限'));
            return;
          }
          chunks.push(d);
        });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        done.then(({ code }) => {
          clearTimeout(timer);
          if (code === 0) resolve(Buffer.concat(chunks));
          else reject(new Error(`tar 打包失败(${code}): ${stderr.slice(0, 300)}`));
        }).catch((e) => { clearTimeout(timer); reject(e); });
      }).catch((e) => { clearTimeout(timer); reject(e); });
    });
  }
}

module.exports = { WorkspaceSync, DEFAULT_EXCLUDES, BATCH_MAX_BYTES, BATCH_MAX_FILES, CONFLICT_DIR };
