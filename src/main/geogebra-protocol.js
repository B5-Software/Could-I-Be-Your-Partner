/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * GeoGebra 完整离线静态服务：
 * 构建期下载的官方 Math Apps Bundle（assets/geogebra-app/GeoGebra/HTML5/5.0/）
 * 经自定义特权协议 ggb:// 提供给渲染层，GWT 的 web3d/webSimple/web 编译产物
 * 及其 deferredjs 分片、字体全部从本地文件系统加载，不访问 www.geogebra.org。
 */

'use strict';

const { app, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveGeogebraRoot() {
  // 协议根为 Math Apps Bundle 解压根（GeoGebra/HTML5/5.0/... 位于其下）
  const sub = path.join('assets', 'geogebra-app');
  const candidates = [];
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', sub));
      candidates.push(path.join(process.resourcesPath, sub));
    }
  } catch (_) {}
  try { candidates.push(path.join(app.getAppPath(), sub)); } catch (_) {}
  candidates.push(path.join(__dirname, '..', '..', sub));
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'GeoGebra', 'HTML5', '5.0', 'web3d', 'web3d.nocache.js'))) return c;
    } catch (_) {}
  }
  return null;
}

function registerGeogebraProtocol() {
  const root = resolveGeogebraRoot();
  if (!root) {
    console.warn('[GeoGebra] 未找到离线包 assets/geogebra-app，GeoGebra 将不可用（请运行 scripts/download-voice-models.js）');
    return null;
  }
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  protocol.handle('ggb', (request) => {
    try {
      const u = new URL(request.url);
      let rel = decodeURIComponent(u.pathname || '').replace(/^\/+/, '');
      if (!rel) rel = path.join('GeoGebra', 'HTML5', '5.0', 'GeoGebra.html');
      const target = path.normalize(path.join(root, rel));
      // 防目录穿越：只允许 root 及其子路径
      if (target !== root && !target.startsWith(rootPrefix)) {
        return new Response('Not Found', { status: 404 });
      }
      const stat = fs.statSync(target);
      if (!stat.isFile()) return new Response('Not Found', { status: 404 });
      const ext = path.extname(target).toLowerCase();
      const headers = {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-cache',
      };
      // 用 Node 流构造 Web 流，避免大分片（deferredjs 最大 ~10MB）整体读入内存。
      // net.fetch(file://) 在自定义协议上下文会返回 ERR_FILE_NOT_FOUND，故不走该路径。
      const buffer = fs.readFileSync(target);
      const body = new Uint8Array(buffer);
      return new Response(body, { status: 200, headers });
    } catch (e) {
      console.error('[GeoGebra] ggb:// 协议处理失败:', e && e.stack || e);
      return new Response('Bad Request', { status: 400 });
    }
  });
  console.log('[GeoGebra] 离线协议 ggb:// 已注册，根目录:', root);
  return root;
}

module.exports = { resolveGeogebraRoot, registerGeogebraProtocol };
