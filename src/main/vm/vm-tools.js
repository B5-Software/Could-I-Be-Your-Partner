/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 工具路由：运行位置=虚拟机时，让**所有文件类工具**都作用于虚拟机。
 *
 * 文件 CRUD 经 SFTP/SSH，Office/OCR/二维码/音视频经 Linux Node worker，
 * CAD/EDA/GeoGebra 的界面保留在 App，文件接口直接访问 VM。
 * VM 失败时返回错误，禁止调用宿主处理器或在宿主暂存工程文件。
 * 工具工作区同步仅用于 shared 模式的显式镜像。
 */

'use strict';

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
  // Office 硬解（officeHard* 系列）：输入可能是文件或目录，输出目录/文件按映射回推
  'office:unpack': { read: [0] },
  'office:listContents': { read: [0] },
  'office:repack': { read: [0], writeFile: [1] },
  'office:getSlideTexts': { read: [0] },
  'office:setSlideTexts': { read: [0] },
  'office:wordExtract': { read: [0] },
  'office:wordApplyTexts': { read: [0] },
  'office:wordGetStyles': { read: [0] },
  'office:wordFillTemplate': { read: [0] },
  // ffmpeg：params 里可能含输入/输出路径 → 递归翻译（见 translateDeep）
  'ffmpeg:invoke': { deep: [1], writeDir: [2] },
  // CAD / PCB-EDA 原生窗口：运行位置=虚拟机时，工程与导出文件必须落到虚拟机
  // （此前直写宿主，且宿主镜像上的产物会在下一次 pull 同步中被删除）。
  // writeDirOf：参数是文件路径，调用后把整个暂存目录推回该文件的所在目录（多文件工程用）。
  'cipypcad:saveProject': { writeFile: [0] },
  'cipypcad:loadProject': { read: [0] },
  'cipypcad:exportDxf': { writeFile: [0] },
  'cipypcad:exportImage': { writeFile: [0] },
  'pcbeda:saveProject': { writeDirOf: [0] },
  'pcbeda:loadProject': { read: [0] },
  'pcbeda:exportFiles': { writeDir: [0] },
  'pcbeda:writeFile': { writeFile: [0] },
  'pcbeda:writeFileBase64': { writeFile: [0] },
  'pcbeda:exportGerber': { writeDir: [0] },
  'pcbeda:exportTextFile': { writeFile: [1] },
  'pcbeda:importFile': { read: [0] },
};

const GUEST_ROUTES = Object.fromEntries(
  Object.entries(TOOL_ROUTES).filter(([name]) =>
    /^(word|ppt|spreadsheet|office|ffmpeg):/.test(name),
  ),
);
GUEST_ROUTES['word:create'].deep = [0];
GUEST_ROUTES['word:create'].pathKeys = ['path'];
GUEST_ROUTES['ppt:create'].deep = [0];
GUEST_ROUTES['ppt:create'].pathKeys = ['path', 'imagePath', 'imagePaths', 'gallery', 'cover'];
Object.assign(GUEST_ROUTES, {
  'qr:generate': { writeDir: [1] },
  'qr:scan': { read: [0] },
  'knowledge:importFile': { read: [0], writeDir: [1] },
  'ocr:recognize': { read: [0] },
  'ffmpeg:available': {},
  'eslint:isLintable': { read: [0] },
  'eslint:lint': { read: [0], deep: [1] },
  'eslint:lintFile': { read: [0] },
  'eslint:clearCache': { read: [0] },
  'system:info': {},
  'system:fullInfo': {},
  'system:network': {},
  'net:httpRequest': {},
  'net:httpFormPost': { deep: [0], pathKeys: ['filePath'] },
  'net:dnsLookup': {},
  'net:ping': {},
  'net:urlShorten': {},
  'net:urlEncodeDecode': {},
  'net:checkSSLCert': {},
  'net:traceroute': {},
  'net:portScan': {},
});

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
const DIRECT_ROUTES = Object.fromEntries(
  Object.entries(TOOL_ROUTES).filter(([name]) => /^(cipypcad|pcbeda):/.test(name)),
);
Object.assign(DIRECT_ROUTES, {
  'cipypcad:agentClose': {},
  'pcbeda:agentClose': {},
  'geogebra:exportPNG': { writeDir: [0] },
  'geogebra:save': { writeDir: [0] },
  'geogebra:load': { read: [0] },
});

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

/** 递归把返回值里的宿主临时路径替换成 VM 路径（同时支持 file:// 前缀，供图片预览 url 用） */
function remapResult(value, mapping) {
  if (typeof value === 'string') {
    const norm = (s) => String(s).replace(/\\/g, '/');
    const isFileUrl = /^file:\/\//i.test(value);
    const bare = isFileUrl ? value.replace(/^file:\/\//i, '') : value;
    const cand = norm(bare);
    for (const [hostPrefix, vmPrefix] of mapping) {
      const hp = norm(hostPrefix).replace(/\/+$/, '');
      if (!hp) continue;
      if (cand === hp || cand.startsWith(hp + '/')) {
        const rest = cand.slice(hp.length).replace(/^\/+/, '');
        const vm = rest ? `${String(vmPrefix).replace(/\/+$/, '')}/${rest}` : vmPrefix;
        return isFileUrl ? `file://${vm}` : vm;
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

/** fs:* 写/删类通道 → 调用后需要把 VM 新状态拉回宿主镜像（外部挂载目录用） */
const PULL_AFTER_INDEX = {
  'fs:writeFile': [0],
  'fs:createFile': [0],
  'fs:convertFileEncoding': [0],
  'fs:deleteFile': [0],
  'fs:deleteDirectory': [0],
  'fs:moveFile': [0, 1],
  'fs:copyFile': [1],
  'fs:makeDirectory': [0],
};

/** 需要 VM 路由的通道集合（供 main.js 在注册时就地包装，兼容 whenReady 里注册的处理器） */
const VM_UNSUPPORTED = new Set([
  'serial:listPorts',
  'serial:openPort',
  'serial:writePort',
  'serial:readPort',
  'serial:closePort',
  'serial:setSignals',
]);
const ROUTE_CHANNELS = new Set([
  ...Object.keys(FS_ROUTES),
  ...Object.keys(GUEST_ROUTES),
  ...Object.keys(DIRECT_ROUTES),
  ...VM_UNSUPPORTED,
]);

/**
 * 为一个通道创建 VM 感知的处理器（VM 模式走 VM 实现，否则透传原实现）。
 * @param {string} channel
 * @param {Function} original 原处理器
 * @param {object} deps { getVmService, isLocationVm }
 */
function createRoutedHandler(channel, original, deps) {
  if (VM_UNSUPPORTED.has(channel))
    return (event, ...args) =>
      deps.isLocationVm()
        ? {
            ok: false,
            location: 'vm',
            error: '虚拟机暂未配置串口设备透传，不能使用宿主串口；请在本机模式使用此工具',
          }
        : original(event, ...args);
  const direct = DIRECT_ROUTES[channel];
  if (direct)
    return async (event, ...args) => {
      if (!deps.isLocationVm()) return original(event, ...args);
      try {
        const service = deps.getVmService();
        if (!service.instance || service.instance.state !== 'ready') await service.start();
        const io = new VmFs({ vmService: service });
        for (const index of [
          ...(direct.read || []),
          ...(direct.writeFile || []),
          ...(direct.writeDir || []),
          ...(direct.writeDirOf || []),
        ]) {
          if (!args[index]) continue;
          const resolved = io.resolveVmPath(args[index]);
          if (!resolved.ok) throw new Error(resolved.error);
          args[index] = resolved.vm;
        }
        return { ...(await original(event, ...args)), location: 'vm' };
      } catch (error) {
        return { ok: false, location: 'vm', error: error.message };
      }
    };
  const guest = GUEST_ROUTES[channel];
  if (guest)
    return async (event, ...args) => {
      if (!deps.isLocationVm()) return original(event, ...args);
      try {
        return await require('./vm-tool-runtime').runGuestTool(
          deps.getVmService(),
          channel,
          args,
          guest,
        );
      } catch (error) {
        return { ok: false, location: 'vm', error: '虚拟机工具执行失败: ' + error.message };
      }
    };
  const fsImpl = FS_ROUTES[channel];
  if (fsImpl) {
    const vmFs = new VmFs({ vmService: deps.getVmService() });
    return async (_e, ...args) => {
      if (!deps.isLocationVm()) return original(_e, ...args);
      try {
        const r = await fsImpl(vmFs, args);
        // 外部挂载目录：写入/删除后把 VM 新状态拉回宿主镜像（文件树/ESLint/资源管理器读宿主镜像）
        const idxs = PULL_AFTER_INDEX[channel];
        if (idxs && r && r.ok !== false && deps.getVmService().runtime.workspaceMode === 'shared') {
          const svc = deps.getVmService();
          for (const i of idxs) {
            const p = args[i];
            if (p && svc && typeof svc.pullExternalDir === 'function') {
              await svc.pullExternalDir(p, { deleted: /delete/i.test(channel) }).catch(() => {});
            }
          }
        }
        return r;
      } catch (e) {
        return { ok: false, error: '虚拟机文件操作失败: ' + e.message };
      }
    };
  }
  return original;
}

/**
 * 兼容接口：在处理器注册完成后统一覆盖（测试与旧调用点用）。
 * 生产路径改用 createRoutedHandler 在 main.js 的 ipcMain.handle 包装里就地安装。
 */
function installVmToolRouting({ ipcMain, handlers, getVmService, isLocationVm, originalHandle }) {
  if (typeof isLocationVm !== 'function')
    throw new Error('installVmToolRouting 需要 isLocationVm()');
  const deps = { getVmService, isLocationVm };
  const installed = [];
  for (const channel of ROUTE_CHANNELS) {
    const original = handlers.get(channel);
    if (!original) continue;
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* 假 ipcMain 无此方法 */
    }
    originalHandle(channel, createRoutedHandler(channel, original, deps));
    installed.push(channel);
  }
  return { installed };
}

module.exports = {
  installVmToolRouting,
  createRoutedHandler,
  ROUTE_CHANNELS,
  TOOL_ROUTES,
  GUEST_ROUTES,
  DIRECT_ROUTES,
  FS_ROUTES,
  translateDeep,
  remapResult,
};
