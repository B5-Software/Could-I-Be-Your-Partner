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

const BATCH_MAX_BYTES = 16 * 1024 * 1024;
const BATCH_MAX_FILES = 2000;
const CONFLICT_SUFFIX = '.conflict-';
/** 冲突备份目录（位于工作区内但被排除同步，用户可见可查） */
const CONFLICT_DIR = '.cibyp-conflicts';
const DEFAULT_EXCLUDES = {
  segments: ['node_modules', 'dist', 'out', '.cache', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.pytest_cache', '.idea', '.vs', CONFLICT_DIR],
  suffixes: ['.qcow2', '.img', '.vmdk', '.vhdx', '.iso', '.tar.gz', '.zip.tmp', '.log'],
  prefixes: ['.git/objects/pack/tmp_', '.git/index.lock'],
};

function nowMs() { return Date.now(); }

function toPosix(p) { return String(p).split(path.sep).join('/'); }

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

  _saveBaseline(files) {
    this.baseline = { version: 1, savedAt: new Date().toISOString(), files };
    if (!this.baselineFile) return;
    try {
      fs.mkdirSync(path.dirname(this.baselineFile), { recursive: true });
      fs.writeFileSync(this.baselineFile, JSON.stringify(this.baseline));
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
    if (!p.startsWith(this.vmMount)) return null;
    const rel = p.slice(this.vmMount.length).replace(/^\/+/, '');
    if (!rel) return this.hostRoot;
    return this.hostRoot ? path.join(this.hostRoot, ...rel.split('/')) : null;
  }

  // ---------------------------------------------------------------- 扫描

  /** 排除判定 */
  shouldExclude(rel) {
    const r = toPosix(rel);
    const segs = r.split('/');
    for (const s of DEFAULT_EXCLUDES.segments) {
      if (segs.includes(s)) return true;
    }
    if (!this.syncGit && (segs[0] === '.git' || segs.includes('.git'))) return true;
    for (const suf of DEFAULT_EXCLUDES.suffixes) {
      if (r.endsWith(suf)) return true;
    }
    for (const pre of DEFAULT_EXCLUDES.prefixes) {
      if (r.startsWith(pre)) return true;
    }
    if (this.excludes) {
      for (const pat of this.excludes) {
        try {
          if (pat instanceof RegExp ? pat.test(r) : r.includes(String(pat))) return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  }

  /** 宿主侧清单：rel → { size, mtimeMs } */
  scanHost() {
    const files = {};
    if (!this.hostRoot || !fs.existsSync(this.hostRoot)) return files;
    const walk = (dir, relBase) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        if (this.shouldExclude(rel)) continue;
        const abs = path.join(dir, e.name);
        let st = null;
        try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) continue;      // 符号链接不同步（跨平台语义差异大）
        if (st.isDirectory()) { walk(abs, rel); continue; }
        if (!st.isFile()) continue;
        if (st.size > this.maxFileMB * 1024 * 1024) { this._stats.skipped.push(`${rel}（超过 ${this.maxFileMB}MB）`); continue; }
        files[rel] = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
      }
    };
    walk(this.hostRoot, '');
    return files;
  }

  /** VM 侧清单（find -printf，一次扫描拿全部；用 guest 当前时间校正时钟偏移） */
  async scanVm() {
    const inst = this._instance();
    const cmd = `date +%s; find ${JSON.stringify(this.vmMount)} -mindepth 1 \\( -type f -o -type d \\) -printf '%y\\t%P\\t%s\\t%T@\\n' 2>/dev/null`;
    const r = await inst.exec(cmd, { timeoutMs: 120000 });
    const files = {};
    if (!r.ok) return files;
    const lines = r.stdout.split('\n');
    // 第一行是 guest 的 epoch（秒）：宿主与 guest 常有几百毫秒~几秒的时钟偏移，
    // 直接比较 mtime 会把"较新的一方"判反（实测：VM 后写的内容被判为更旧）
    const guestEpoch = parseFloat(lines[0]);
    if (Number.isFinite(guestEpoch) && guestEpoch > 0) {
      this._vmClockOffsetMs = Date.now() - guestEpoch * 1000;
    }
    const offset = this._vmClockOffsetMs || 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const [type, rel, size, mtime] = line.split('\t');
      if (!rel) continue;
      if (this.shouldExclude(rel)) continue;
      if (type === 'd') continue;               // 目录由 tar 的目录条目兜底
      const sz = parseInt(size, 10) || 0;
      if (sz > this.maxFileMB * 1024 * 1024) { this._stats.skipped.push(`${rel}（VM 侧超过 ${this.maxFileMB}MB）`); continue; }
      files[rel] = { size: sz, mtimeMs: Math.round((parseFloat(mtime) || 0) * 1000 + offset) };
    }
    return files;
  }

  // ---------------------------------------------------------------- diff

  static sameEntry(a, b) {
    if (!a || !b) return false;
    return a.size === b.size && Math.abs((a.mtimeMs || 0) - (b.mtimeMs || 0)) < 1500;
  }

  diff(host, vm) {
    const base = this.baseline.files || {};
    const toVm = [], toHost = [], conflicts = [], deletesVm = [], deletesHost = [];
    const all = new Set([...Object.keys(host), ...Object.keys(vm), ...Object.keys(base)]);
    for (const rel of all) {
      if (this.shouldExclude(rel)) continue;
      const b = base[rel], h = host[rel], v = vm[rel];
      const hostChanged = !WorkspaceSync.sameEntry(h, b);
      const vmChanged = !WorkspaceSync.sameEntry(v, b);
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
  async push(rels) {
    if (!rels.length) return { files: 0, bytes: 0 };
    const inst = this._instance();
    const sizes = this.scanHost();
    let files = 0, bytes = 0;
    for (const batch of WorkspaceSync.batches(rels, sizes)) {
      const entries = [...dirEntriesFor(batch)];
      for (const rel of batch) {
        const abs = path.join(this.hostRoot, ...rel.split('/'));
        let data = null;
        try { data = fs.readFileSync(abs); } catch (e) { this.emit('warn', `读取失败 ${rel}: ${e.message}`); continue; }
        entries.push({ name: rel, data, mtime: Math.floor((sizes[rel] || {}).mtimeMs / 1000) });
        files++; bytes += data.length;
      }
      if (!entries.length) continue;
      const tar = writeTar(entries);
      await this._execWithStdin(inst, `tar -x -f - -C ${JSON.stringify(this.vmMount)} --no-same-owner --no-same-permissions`, tar, 300000);
      this.emit('progress', { direction: 'push', files, bytes });
    }
    return { files, bytes };
  }

  /** 从 VM 拉回若干文件；targetMap 可把某个 rel 落到别的宿主相对路径（冲突备份用） */
  async pull(rels, targetMap = null) {
    if (!rels.length) return { files: 0, bytes: 0 };
    const inst = this._instance();
    const sizes = await this.scanVm();
    let files = 0, bytes = 0;
    for (const batch of WorkspaceSync.batches(rels, sizes)) {
      const list = batch.map((r) => JSON.stringify(r)).join(' ');
      const cmd = `tar -c -f - -C ${JSON.stringify(this.vmMount)} --format=pax -- ${list}`;
      const buf = await this._execWithStdout(inst, cmd, 300000);
      if (!buf || !buf.length) continue;
      const { entries, warnings } = parseTar(buf);
      for (const w of warnings) this.emit('warn', 'pull: ' + w);
      for (const e of entries) {
        if (e.type !== '0') continue;
        const rel = e.name.replace(/^\.\//, '');
        const targetRel = (targetMap && targetMap.get(rel)) || rel;
        const abs = path.join(this.hostRoot, ...targetRel.split('/'));
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, e.data);
          files++; bytes += e.data.length;
        } catch (err) {
          this.emit('warn', `写入失败 ${targetRel}: ${err.message}`);
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
    const list = rels.map((r) => JSON.stringify(path.posix.join(this.vmMount, r))).join(' ');
    await inst.exec(`rm -f -- ${list}`, { timeoutMs: 60000 });
    return rels.length;
  }

  deleteInHost(rels) {
    let n = 0;
    for (const rel of rels) {
      try { fs.rmSync(path.join(this.hostRoot, ...rel.split('/')), { force: true }); n++; } catch { /* ignore */ }
    }
    return n;
  }

  /** 冲突备份的宿主相对路径（放在 .cibyp-conflicts/ 下，不进同步） */
  conflictPathFor(rel, stamp) {
    return `${CONFLICT_DIR}/${rel}${CONFLICT_SUFFIX}${stamp}`;
  }

  /** 冲突：败方另存（保数据，不静默丢） */
  preserveConflict(rel, loserSide, hostSnapshot, stamp) {
    const relSafe = this.conflictPathFor(rel, stamp || new Date().toISOString().replace(/[:.]/g, '-'));
    try {
      if (loserSide === 'host' && hostSnapshot) {
        const abs = path.join(this.hostRoot, ...relSafe.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, hostSnapshot);
      }
      this.emit('warn', `冲突保留（${loserSide === 'host' ? '宿主' : 'VM'}侧副本）: ${relSafe}`);
    } catch (e) { this.emit('warn', '冲突保留失败: ' + e.message); }
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
    if (!this.hostRoot || !fs.existsSync(this.hostRoot)) {
      return { ok: false, error: '工作区目录不存在: ' + this.hostRoot };
    }
    const t0 = nowMs();
    this.emit('sync-start', { direction, reason });
    try {
      const host = this.scanHost();
      const vm = await this.scanVm();
      const d = this.diff(host, vm);

      let toVm = d.toVm, toHost = d.toHost;
      if (direction === 'push') toHost = [];
      if (direction === 'pull') toVm = [];

      const beforePull = toHost.length ? new Map(toHost.map((rel) => [rel, this._readHostFileSafe(rel)])) : new Map();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');

      // 冲突处理：无论哪一方胜出，败方内容都保留到 .cibyp-conflicts/（不静默丢数据）
      const hostWins = d.conflicts.filter((c) => c.winner === 'host' && direction !== 'pull');
      if (hostWins.length) {
        const targetMap = new Map(hostWins.map((c) => [c.rel, this.conflictPathFor(c.rel, stamp)]));
        await this.pull(hostWins.map((c) => c.rel), targetMap);
        for (const c of hostWins) this.emit('warn', `冲突保留（VM 侧副本）: ${this.conflictPathFor(c.rel, stamp)}`);
      }

      let pushRes = { files: 0, bytes: 0 }, pullRes = { files: 0, bytes: 0 };
      if (toVm.length) pushRes = await this.push(toVm);
      if (toHost.length) {
        for (const c of d.conflicts) {
          if (c.winner === 'vm' && beforePull.has(c.rel)) this.preserveConflict(c.rel, 'host', beforePull.get(c.rel), stamp);
        }
        pullRes = await this.pull(toHost);
      }
      const deletedVm = this.dryRun ? 0 : await this.deleteInVm(d.deletesVm);
      const deletedHost = this.dryRun ? 0 : this.deleteInHost(d.deletesHost);

      // 重新扫描并落 baseline（只记录"两侧都成功"的文件，失败的下次重试）
      const hostAfter = this.scanHost();
      const vmAfter = await this.scanVm();
      const files = {};
      for (const rel of Object.keys(hostAfter)) {
        if (vmAfter[rel] && WorkspaceSync.sameEntry(hostAfter[rel], vmAfter[rel])) {
          files[rel] = { size: hostAfter[rel].size, mtimeMs: hostAfter[rel].mtimeMs };
        }
      }
      this._saveBaseline(files);

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

  _readHostFileSafe(rel) {
    try {
      const abs = path.join(this.hostRoot, ...rel.split('/'));
      const st = fs.statSync(abs);
      if (st.size > 4 * 1024 * 1024) return null; // 冲突备份上限 4MB
      return fs.readFileSync(abs);
    } catch { return null; }
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
