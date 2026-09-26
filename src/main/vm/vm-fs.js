/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 文件系统路由层：运行位置=虚拟机时，所有文件类工具操作都作用于虚拟机内的文件。
 *
 * 与 fs:* IPC 处理器的返回结构严格一致（调用方无感）：
 *   readFile / writeFile / createFile / getFileInfo / convertFileEncoding /
 *   deleteFile / moveFile / copyFile / listDirectory / makeDirectory / deleteDirectory /
 *   localSearch / searchInFiles / readFileBase64 / saveUploadedFile
 *
 * 路径约定：
 *   - 宿主路径（如 D:\...\Documents\Could-I-Be-Your-Partner\abc\a.py）→ VM 内 /workspace/abc/a.py
 *   - 已是 VM 路径（/workspace/... 等）→ 原样使用
 * 编码/换行语义复用宿主同款实现（file-encoding 的 detectEncodingName / detectEolFromBuffer /
 * normalizeEncodingName + iconv-lite），保证两个位置行为一致。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const fileEncoding = require('../file-encoding');

const B64_RE = /^[A-Za-z0-9+/=\s]+$/;

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class VmFs {
  /** @param {object} opts { vmService } */
  constructor(opts = {}) {
    this.vmService = opts.vmService;
  }

  // ---------------------------------------------------------------- 基础

  get instance() {
    const inst = this.vmService && this.vmService.instance;
    if (!inst || inst.state !== 'ready') {
      const e = new Error('虚拟机未就绪（运行位置=虚拟机，但 VM 不可用）');
      e.code = 'VM_NOT_READY';
      throw e;
    }
    return inst;
  }

  /** 宿主路径 → VM 路径（已是 VM 路径则原样返回） */
  toVm(p) {
    const s = String(p || '');
    if (!s) return s;
    const mount = (this.vmService && this.vmService.runtime && this.vmService.runtime.vm.workspaceMount) || '/workspace';
    if (s.startsWith('/')) return s; // POSIX 绝对路径（/workspace、/tmp…）视为已在 VM 内
    try { return this.vmService.toVmPath(s); } catch { return s; }
  }

  /** VM 路径 → 宿主路径（宿主镜像用；映射不到返回 null） */
  toHost(p) {
    try { return this.vmService.toHostPath(p); } catch { return null; }
  }

  async sftp() { return this.instance.sftp(); }

  async exec(cmd, timeoutMs = 60000) { return this.instance.exec(cmd, { timeoutMs }); }

  // ---------------------------------------------------------------- 读

  async readBuffer(filePath) {
    const sftp = await this.sftp();
    return sftp.readFile(this.toVm(filePath));
  }

  async writeBuffer(filePath, buf) {
    const vm = this.toVm(filePath);
    const sftp = await this.sftp();
    await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(vm))}`, 20000);
    await sftp.writeFile(vm, buf);
    return vm;
  }

  async exists(filePath) {
    const r = await this.exec(`test -e ${shellQuote(this.toVm(filePath))} && echo yes || echo no`, 20000);
    return r.stdout.trim() === 'yes';
  }

  async stat(filePath) {
    const vm = this.toVm(filePath);
    const sftp = await this.sftp();
    try {
      const st = await sftp.stat(vm);
      return {
        size: st.size,
        isDirectory: st.isDirectory(),
        isFile: st.isFile(),
        mtimeMs: (st.mtime || 0) * 1000,
        mode: st.mode,
      };
    } catch {
      return null;
    }
  }

  /** fs:readFile 语义 */
  async readFile(filePath, encoding) {
    try {
      const buf = await this.readBuffer(filePath);
      const iconv = require('iconv-lite');
      if (encoding) {
        const encName = fileEncoding.normalizeEncodingName(encoding);
        if (iconv.encodingExists(encName)) {
          return { ok: true, content: iconv.decode(buf, encName), encoding: encName, eol: fileEncoding.detectEolFromBuffer(buf) };
        }
        return { ok: true, content: buf.toString('utf-8'), encoding: 'utf-8', eol: fileEncoding.detectEolFromBuffer(buf) };
      }
      const enc = fileEncoding.detectEncodingName(buf);
      return { ok: true, content: iconv.decode(buf, enc), encoding: enc, eol: fileEncoding.detectEolFromBuffer(buf) };
    } catch (e) {
      return { ok: false, error: '虚拟机文件读取失败: ' + e.message };
    }
  }

  /** fs:readFileBase64 语义 */
  async readFileBase64(filePath) {
    try {
      const buf = await this.readBuffer(filePath);
      const ext = path.posix.extname(this.toVm(filePath)).toLowerCase();
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
      const mime = mimeMap[ext] || 'application/octet-stream';
      return { ok: true, data: `data:${mime};base64,${buf.toString('base64')}`, mime };
    } catch (e) {
      return { ok: false, error: '虚拟机文件读取失败: ' + e.message };
    }
  }

  // ---------------------------------------------------------------- 写

  /**
   * 编码/换行处理：与宿主 writeTextFileWithEncoding 等价（缺省沿用 VM 内现有文件的编码/换行）。
   */
  async _encodeForWrite(filePath, content, options = {}) {
    const iconv = require('iconv-lite');
    let encoding = options && options.encoding ? fileEncoding.normalizeEncodingName(options.encoding) : '';
    let eol = options && options.eol ? String(options.eol).toLowerCase() : '';
    if (!encoding || !eol) {
      try {
        const existing = await this.readBuffer(filePath);
        if (!encoding) encoding = fileEncoding.detectEncodingName(existing) || 'utf-8';
        if (!eol) eol = fileEncoding.detectEolFromBuffer(existing) || 'lf';
      } catch { /* 新文件 */ }
    }
    if (!encoding) encoding = 'utf-8';
    if (!eol) eol = 'lf';
    let text = String(content == null ? '' : content);
    const unified = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = eol === 'crlf' ? unified.replace(/\n/g, '\r\n') : unified;
    const buf = iconv.encodingExists(encoding) ? iconv.encode(text, encoding) : Buffer.from(text, 'utf8');
    return { buf, encoding, eol };
  }

  /** fs:writeFile 语义 */
  async writeFile(filePath, content, options = {}) {
    try {
      const { buf, encoding, eol } = await this._encodeForWrite(filePath, content, options);
      await this.writeBuffer(filePath, buf);
      return { ok: true, encoding, eol };
    } catch (e) {
      return { ok: false, error: '虚拟机文件写入失败: ' + e.message };
    }
  }

  /** fs:createFile 语义（自动建目录） */
  async createFile(filePath, content, options = {}) {
    try {
      const vm = this.toVm(filePath);
      await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(vm))}`, 20000);
      return await this.writeFile(filePath, content || '', options);
    } catch (e) {
      return { ok: false, error: '虚拟机文件创建失败: ' + e.message };
    }
  }

  /** fs:getFileInfo 语义 */
  async getFileInfo(filePath) {
    try {
      const buf = await this.readBuffer(filePath);
      const st = await this.stat(filePath);
      return {
        ok: true,
        encoding: fileEncoding.detectEncodingName(buf),
        eol: fileEncoding.detectEolFromBuffer(buf),
        size: st ? st.size : buf.length,
        exists: true,
      };
    } catch (e) {
      return { ok: false, error: '文件不存在（虚拟机内）: ' + e.message };
    }
  }

  /** fs:convertFileEncoding 语义（读 VM → 转码 → 写回 VM） */
  async convertFileEncoding(filePath, options = {}) {
    try {
      const encoding = options && options.encoding ? String(options.encoding) : '';
      const eol = options && options.eol ? String(options.eol).toLowerCase() : '';
      if (!encoding && !eol) return { ok: false, error: '至少需要指定 encoding 或 eol 之一' };
      const buf = await this.readBuffer(filePath);
      const from = { encoding: fileEncoding.detectEncodingName(buf), eol: fileEncoding.detectEolFromBuffer(buf) };
      const iconv = require('iconv-lite');
      const content = iconv.decode(buf, from.encoding);
      const meta = await this._encodeForWrite(filePath, content, { encoding: encoding || from.encoding, eol: eol || from.eol });
      await this.writeBuffer(filePath, meta.buf);
      return { ok: true, from, to: { encoding: meta.encoding, eol: meta.eol } };
    } catch (e) {
      return { ok: false, error: '虚拟机文件转码失败: ' + e.message };
    }
  }

  // ---------------------------------------------------------------- 目录与删除

  async deleteFile(filePath) {
    try {
      const r = await this.exec(`rm -f ${shellQuote(this.toVm(filePath))}`);
      if (!r.ok) throw new Error(r.stderr || 'rm 失败');
      return { ok: true };
    } catch (e) { return { ok: false, error: '虚拟机删除失败: ' + e.message }; }
  }

  async moveFile(src, dest) {
    try {
      const r = await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(this.toVm(dest)))} && mv -f ${shellQuote(this.toVm(src))} ${shellQuote(this.toVm(dest))}`);
      if (!r.ok) throw new Error(r.stderr || 'mv 失败');
      return { ok: true };
    } catch (e) { return { ok: false, error: '虚拟机移动失败: ' + e.message }; }
  }

  async copyFile(src, dest) {
    try {
      const r = await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(this.toVm(dest)))} && cp -f ${shellQuote(this.toVm(src))} ${shellQuote(this.toVm(dest))}`);
      if (!r.ok) throw new Error(r.stderr || 'cp 失败');
      return { ok: true };
    } catch (e) { return { ok: false, error: '虚拟机复制失败: ' + e.message }; }
  }

  async listDirectory(dirPath) {
    try {
      const vm = this.toVm(dirPath);
      const sftp = await this.sftp();
      const list = await sftp.readdir(vm);
      return {
        ok: true,
        entries: list.map((it) => {
          const isDir = it.attrs && typeof it.attrs.isDirectory === 'function' ? it.attrs.isDirectory() : false;
          const isFile = it.attrs && typeof it.attrs.isFile === 'function' ? it.attrs.isFile() : !isDir;
          return { name: it.filename, isDirectory: !!isDir, isFile: !!isFile };
        }),
      };
    } catch (e) {
      return { ok: false, error: '虚拟机目录读取失败: ' + e.message };
    }
  }

  async makeDirectory(dirPath) {
    try {
      const r = await this.exec(`mkdir -p ${shellQuote(this.toVm(dirPath))}`);
      if (!r.ok) throw new Error(r.stderr || 'mkdir 失败');
      return { ok: true };
    } catch (e) { return { ok: false, error: '虚拟机建目录失败: ' + e.message }; }
  }

  async deleteDirectory(dirPath) {
    try {
      const r = await this.exec(`rm -rf ${shellQuote(this.toVm(dirPath))}`);
      if (!r.ok) throw new Error(r.stderr || 'rm -rf 失败');
      return { ok: true };
    } catch (e) { return { ok: false, error: '虚拟机删目录失败: ' + e.message }; }
  }

  // ---------------------------------------------------------------- 搜索

  /** fs:localSearch 语义（在 VM 内按文件名 glob/正则搜索，返回 VM 路径） */
  async localSearch(dirPath, pattern, options = {}) {
    try {
      const { ignoreCase = true, maxResults = 200, fileOnly = false, dirOnly = false, regex = false, depth = -1 } = options;
      const globToRegex = (glob) => glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      let searchRegex;
      try {
        searchRegex = regex ? new RegExp(pattern, ignoreCase ? 'i' : '') : new RegExp('^' + globToRegex(pattern) + '$', ignoreCase ? 'i' : '');
      } catch (e) {
        return { ok: false, error: `Invalid ${regex ? 'regex' : 'glob'} pattern: ${e.message}` };
      }
      const vmDir = this.toVm(dirPath);
      const depthArg = depth >= 0 ? ` -maxdepth ${Number(depth) + 1}` : '';
      const typeArg = fileOnly ? ' -type f' : dirOnly ? ' -type d' : '';
      const r = await this.exec(`find ${shellQuote(vmDir)} -mindepth 1${depthArg}${typeArg} -printf '%y\\t%p\\n' 2>/dev/null | head -${Math.max(1, Number(maxResults)) * 3}`, 60000);
      const results = [];
      for (const line of r.stdout.split('\n')) {
        if (!line) continue;
        const [type, full] = line.split('\t');
        if (!full) continue;
        if (fileOnly && type !== 'f') continue;
        if (dirOnly && type !== 'd') continue;
        if (searchRegex.test(path.posix.basename(full))) {
          results.push(full);
          if (results.length >= maxResults) break;
        }
      }
      return { ok: true, results, count: results.length };
    } catch (e) {
      return { ok: false, error: '虚拟机搜索失败: ' + e.message };
    }
  }

  /**
   * fs:searchInFiles 语义：在 VM 内用 grep -rIn 搜索内容，返回与宿主一致的结构。
   * 上下文行用 grep -C 获取（`-` 为上下文、`:` 为命中，`--` 为组分隔）。
   */
  async searchInFiles(paths, pattern, options = {}) {
    try {
      if (!Array.isArray(paths) || paths.length === 0) return { ok: false, error: 'paths 参数必须是非空数组' };
      if (!pattern || typeof pattern !== 'string') return { ok: false, error: 'pattern 参数必须是非空字符串' };
      const {
        ignoreCase = false, regex = false, maxResults = 200,
        include = null, exclude = null, contextLines = 0, encoding = '',
      } = options;
      const vmPaths = paths.map((p) => this.toVm(p));
      const args = ['grep', '-rIn', '--binary-files=without-match'];
      if (ignoreCase) args.push('-i');
      if (!regex) args.push('-F');
      if (contextLines > 0) args.push(`-C${Number(contextLines)}`);
      if (include) args.push(`--include=${shellQuote(include)}`);
      if (exclude) args.push(`--exclude=${shellQuote(exclude)}`);
      args.push('-e', shellQuote(pattern), ...vmPaths.map(shellQuote));
      const cmd = `LC_ALL=C ${args.join(' ')} 2>/dev/null | head -${Math.max(1, Number(maxResults)) * (contextLines > 0 ? 8 : 2)}`;
      const r = await this.exec(cmd, 120000);
      const files = new Map();
      let totalMatches = 0;
      let current = null;
      for (const raw of r.stdout.split('\n')) {
        if (!raw) continue;
        if (raw === '--') { current = null; continue; }
        const m = /^([^:]+):(\d+):(.*)$/.exec(raw);
        const mc = /^([^-]+)-(\d+)-(.*)$/.exec(raw);
        if (m) {
          const file = m[1];
          if (!files.has(file)) files.set(file, []);
          const text = m[3];
          const idx = (() => {
            try {
              const re = regex ? new RegExp(pattern, ignoreCase ? 'i' : '') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '');
              const mm = re.exec(text);
              return mm ? mm.index : 0;
            } catch { return 0; }
          })();
          current = { file, item: { line: parseInt(m[2], 10), column: idx + 1, text, contextBefore: [], contextAfter: [] } };
          files.get(file).push(current.item);
          totalMatches++;
        } else if (mc && current && mc[1] === current.file) {
          const lineNo = parseInt(mc[2], 10);
          if (lineNo < current.item.line) current.item.contextBefore.push(mc[3]);
          else current.item.contextAfter.push(mc[3]);
        }
      }
      const results = [...files.entries()].map(([file, matches]) => ({ file, matches }));
      return { ok: true, results, totalMatches, filesWithMatches: results.length };
    } catch (e) {
      return { ok: false, error: '虚拟机内容搜索失败: ' + e.message };
    }
  }

  // ---------------------------------------------------------------- 上传

  /** fs:saveUploadedFile 语义：上传文件落到 VM 工作区（/workspace/_uploads 或 /workspace/_images） */
  async saveUploadedFile(fileName, data) {
    try {
      const ext = path.posix.extname(String(fileName || '')).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
      const dir = isImage ? '/workspace/_images' : '/workspace/_uploads';
      const target = `${dir}/${Date.now()}_${String(fileName || 'upload.bin')}`;
      let buf;
      if (Buffer.isBuffer(data)) buf = data;
      else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
      else if (typeof data === 'string' && data.startsWith('data:')) buf = Buffer.from(data.split(',')[1] || '', 'base64');
      else if (typeof data === 'string' && B64_RE.test(data) && data.length > 64) buf = Buffer.from(data, 'base64');
      else buf = Buffer.from(String(data == null ? '' : data), 'utf8');
      await this.writeBuffer(target, buf);
      return { ok: true, path: target, isImage };
    } catch (e) {
      return { ok: false, error: '虚拟机保存上传文件失败: ' + e.message };
    }
  }

  // ---------------------------------------------------------------- 宿主库暂存（文档/媒体工具用）

  /** 把 VM 内文件拉到宿主临时文件（供 docx/ocr/ffmpeg 等宿主库使用） */
  async pullToTemp(vmOrHostPath, suffix = '') {
    const vm = this.toVm(vmOrHostPath);
    const base = path.basename(vm);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vm-stage-'));
    const target = path.join(dir, suffix ? base.replace(/(\.[^.]*)?$/, suffix) : base);
    const sftp = await this.sftp();
    await sftp.fastGet(vm, target);
    return { dir, file: target, vmPath: vm };
  }

  /** 把宿主文件推到 VM 指定路径（返回 VM 路径） */
  async pushFromHost(hostPath, vmTargetPath) {
    const vm = this.toVm(vmTargetPath);
    const sftp = await this.sftp();
    await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(vm))}`, 20000);
    await sftp.fastPut(hostPath, vm);
    return vm;
  }

  /** 递归把宿主目录内容推到 VM 目录 */
  async pushDir(hostDir, vmDir) {
    const vm = this.toVm(vmDir);
    const sftp = await this.sftp();
    const walk = async (from, to) => {
      await this.exec(`mkdir -p ${shellQuote(to)}`, 20000);
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, e.name);
        const dst = path.posix.join(to, e.name);
        if (e.isDirectory()) await walk(src, dst);
        else await sftp.fastPut(src, dst);
      }
    };
    await walk(hostDir, vm);
    return vm;
  }

  /** 把 VM 目录内容拉回宿主目录 */
  async pullDir(vmDir, hostDir) {
    const sftp = await this.sftp();
    const walk = async (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const it of await sftp.readdir(from)) {
        const src = path.posix.join(from, it.filename);
        const dst = path.join(to, it.filename);
        if (it.attrs && typeof it.attrs.isDirectory === 'function' && it.attrs.isDirectory()) await walk(src, dst);
        else await sftp.fastGet(src, dst);
      }
    };
    await walk(this.toVm(vmDir), hostDir);
    return hostDir;
  }
}

module.exports = { VmFs };
