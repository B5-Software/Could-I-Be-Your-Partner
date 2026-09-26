/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 工具路由：运行位置=虚拟机时，让**所有文件类工具**都作用于虚拟机。
 *
 * 两类接入方式：
 *   1. 纯文件操作（fs:*）→ 直接在 VM 内执行（vm-fs.js，SFTP/SSH）
 *   2. 宿主库工具（word/ppt/spreadsheet/ocr/image/file:download/ffmpeg）
 *      → "路径暂存"：把 VM 内的输入文件拉到宿主临时目录，用宿主库处理，
 *        再把产物推回 VM 对应路径，并把返回值里的宿主临时路径回映成 VM 路径。
 *        这样工具语义（库能力）不变，但**效果落在虚拟机里**。
 *
 * 安装方式：在 main.js 里先记录原始处理器（__ipcHandlers），在所有处理器注册完成后调用
 * installVmToolRouting() 覆盖同名通道：VM 模式走 VM 实现，否则透传原处理器。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { VmFs } = require('./vm-fs');

/** 宿主库工具的路径参数位置表（read=读入、writeFile=写出单文件、writeDir=输出目录） */
const TOOL_ROUTES = {
  'word:extractText': { read: [0] },
  'word:create': { writeDir: [1] },
  'word:fillTemplate': { read: [0], writeFile: [1], writeDir: [3] },
  'word:getMetadata': { read: [0] },
  'word:listStyles': { read: [0] },
  'ppt:create': { writeDir: [1] },
  'spreadsheet:importFile': { read: [0] },
  'spreadsheet:exportFile': { writeFile: [0] },
  'ocr:recognize': { read: [0] },
  'image:generate': { writeDir: [1] },
  'file:download': { writeDir: [2] },
  // ffmpeg：params 里可能含输入/输出路径 → 递归翻译（见 translateDeep）
  'ffmpeg:invoke': { deep: [1], writeDir: [2] },
};

const FS_ROUTES = {
  'fs:readFile': (v, a) => v.readFile(a[0], a[1]),
  'fs:writeFile': (v, a) => v.writeFile(a[0], a[1], a[2]),
  'fs:createFile': (v, a) => v.createFile(a[0], a[1], a[2]),
  'fs:getFileInfo': (v, a) => v.getFileInfo(a[0]),
  'fs:convertFileEncoding': (v, a) => v.convertFileEncoding(a[0], a[1]),
  'fs:deleteFile': (v, a) => v.deleteFile(a[0]),
  'fs:moveFile': (v, a) => v.moveFile(a[0], a[1]),
  'fs:copyFile': (v, a) => v.copyFile(a[0], a[1]),
  'fs:listDirectory': (v, a) => v.listDirectory(a[0]),
  'fs:makeDirectory': (v, a) => v.makeDirectory(a[0]),
  'fs:deleteDirectory': (v, a) => v.deleteDirectory(a[0]),
  'fs:localSearch': (v, a) => v.localSearch(a[0], a[1], a[2]),
  'fs:searchInFiles': (v, a) => v.searchInFiles(a[0], a[1], a[2]),
  'fs:readFileBase64': (v, a) => v.readFileBase64(a[0]),
  'fs:saveUploadedFile': (v, a) => v.saveUploadedFile(a[0], a[1]),
};

function isPathLike(s) {
  if (typeof s !== 'string' || s.length < 2) return false;
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\');
}

/** 递归把对象/数组里的宿主路径翻译成 VM 路径（ffmpeg params 用） */
function translateDeep(value, toVm) {
  if (typeof value === 'string') return isPathLike(value) ? toVm(value) : value;
  if (Array.isArray(value)) return value.map((v) => translateDeep(v, toVm));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = translateDeep(v, toVm);
    return out;
  }
  return value;
}

/** 递归把返回值里的宿主临时路径替换成 VM 路径 */
function remapResult(value, mapping) {
  if (typeof value === 'string') {
    for (const [hostPrefix, vmPrefix] of mapping) {
      if (value === hostPrefix || value.startsWith(hostPrefix)) {
        const rest = value.slice(hostPrefix.length).replace(/^[\\/]/, '');
        return rest ? `${vmPrefix.replace(/[\\/]$/, '')}/${rest.split(/[\\/]/).join('/')}` : vmPrefix;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => remapResult(v, mapping));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = remapResult(v, mapping);
    return out;
  }
  return value;
}

/**
 * 安装 VM 工具路由（须在原始处理器注册之后调用）。
 * @param {object} opts { ipcMain, handlers, getVmService, isLocationVm, originalHandle }
 *   handlers: Map<channel, fn>（main.js 用包装后的 ipcMain.handle 记录）
 *   originalHandle: 未包装的 ipcMain.handle（用于覆盖注册）
 * @returns {{ installed: string[], vmFs: VmFs }}
 */
function installVmToolRouting({ ipcMain, handlers, getVmService, isLocationVm, originalHandle }) {
  if (typeof isLocationVm !== 'function') throw new Error('installVmToolRouting 需要 isLocationVm()');
  const vmFs = new VmFs({
    vmService: {
      get instance() { const s = getVmService(); return s && s.instance; },
      get runtime() { const s = getVmService(); return s && s.runtime; },
      toVmPath: (p) => getVmService().toVmPath(p),
      toHostPath: (p) => getVmService().toHostPath(p),
    },
  });
  const installed = [];

  const register = (channel, impl) => {
    originalHandle(channel, impl);
    installed.push(channel);
  };

  // ---- 1) 纯文件操作：直接在 VM 内执行 ----
  for (const [channel, impl] of Object.entries(FS_ROUTES)) {
    if (!handlers.has(channel)) continue;
    register(channel, async (_e, ...args) => {
      if (!isLocationVm()) return handlers.get(channel)(_e, ...args);
      try { return await impl(vmFs, args); } catch (e) { return { ok: false, error: '虚拟机文件操作失败: ' + e.message }; }
    });
  }

  // ---- 2) 宿主库工具：路径暂存 ----
  for (const [channel, route] of Object.entries(TOOL_ROUTES)) {
    const original = handlers.get(channel);
    if (!original) continue;
    register(channel, async (_e, ...args) => {
      if (!isLocationVm()) return original(_e, ...args);
      const staging = { pulls: new Map(), tmpDirs: [], mappings: [] };
      try {
        const hostArgs = [...args];
        // 读入：VM → 宿主临时
        for (const idx of route.read || []) {
          const p = hostArgs[idx];
          if (!isPathLike(p)) continue;
          const pulled = await vmFs.pullToTemp(p);
          staging.tmpDirs.push(pulled.dir);
          staging.pulls.set(pulled.file, vmFs.toVm(p));
          staging.mappings.push([pulled.file, vmFs.toVm(p)]);
          hostArgs[idx] = pulled.file;
        }
        // 写出单文件：VM 路径 → 临时文件（调用后推回）
        const writeFiles = [];
        for (const idx of route.writeFile || []) {
          const p = hostArgs[idx];
          if (!isPathLike(p)) continue;
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vmtool-'));
          staging.tmpDirs.push(tmpDir);
          const tmpFile = path.join(tmpDir, path.basename(vmFs.toVm(p)));
          writeFiles.push({ tmpFile, vmPath: vmFs.toVm(p) });
          staging.mappings.push([tmpFile, vmFs.toVm(p)]);
          hostArgs[idx] = tmpFile;
        }
        // 输出目录：宿主临时目录，调用后整目录推回
        const writeDirs = [];
        for (const idx of route.writeDir || []) {
          const p = hostArgs[idx];
          const vmDir = vmFs.toVm(p || '/workspace');
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vmtool-'));
          staging.tmpDirs.push(tmpDir);
          writeDirs.push({ tmpDir, vmDir });
          staging.mappings.push([tmpDir, vmDir]);
          hostArgs[idx] = tmpDir;
        }
        // 深度翻译（ffmpeg params 等）：存在的文件→拉到宿主临时；不存在的→视为输出，落到临时后推回
        for (const idx of route.deep || []) {
          staging.outputs = staging.outputs || [];
          hostArgs[idx] = await stageDeepValue(hostArgs[idx], vmFs, staging);
        }

        const result = await original(null, ...hostArgs);

        // 推回产物
        for (const w of writeFiles) {
          if (fs.existsSync(w.tmpFile)) await vmFs.pushFromHost(w.tmpFile, w.vmPath).catch(() => {});
        }
        for (const w of writeDirs) {
          const produced = fs.readdirSync(w.tmpDir).filter((f) => !staging.pulls.has(path.join(w.tmpDir, f)));
          if (produced.length) await vmFs.pushDir(w.tmpDir, w.vmDir).catch(() => {});
        }
        for (const o of staging.outputs || []) {
          if (fs.existsSync(o.tmpFile)) await vmFs.pushFromHost(o.tmpFile, o.vmPath).catch(() => {});
        }
        // ffmpeg 等：写出目录里的产物（输出路径可能是临时文件，已含在 tmpDir 内）
        return remapResult(result, staging.mappings);
      } catch (e) {
        return { ok: false, error: '虚拟机工具执行失败: ' + e.message };
      } finally {
        for (const d of staging.tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
      }
    });
  }

  return { installed, vmFs };
}

/**
 * 深度暂存（ffmpeg params 等）：
 *   存在的 VM 文件 → 拉到宿主临时（输入）
 *   不存在的 VM 路径 → 视为输出，给宿主临时路径，调用后推回（staging.outputs）
 */
async function stageDeepValue(value, vmFs, staging) {
  if (typeof value === 'string') {
    if (!isPathLike(value) || !value.startsWith('/')) return value;
    try {
      const exists = await vmFs.exists(value);
      if (exists) {
        const pulled = await vmFs.pullToTemp(value);
        staging.tmpDirs.push(pulled.dir);
        staging.pulls.set(pulled.file, value);
        staging.mappings.push([pulled.file, value]);
        return pulled.file;
      }
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vmtool-'));
      staging.tmpDirs.push(tmpDir);
      const tmpFile = path.join(tmpDir, path.basename(value));
      staging.outputs.push({ tmpFile, vmPath: value });
      staging.mappings.push([tmpFile, value]);
      return tmpFile;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await stageDeepValue(v, vmFs, staging));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await stageDeepValue(v, vmFs, staging);
    return out;
  }
  return value;
}

module.exports = { installVmToolRouting, TOOL_ROUTES, FS_ROUTES, translateDeep, remapResult, stageDeepValue };
