/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 资源下载器：优先复用应用内置 aria2（多连接 + 断点续传），失败回退流式 fetch。
 * 与 voice-model-manager 的下载策略一致，但额外做 sha256 校验（CIBYP-VM-OS 清单提供）。
 *
 * 约定：
 *   - 目标文件已存在且校验通过 → 直接跳过（幂等）
 *   - 半成品统一 .part / aria2 控制文件，失败清理
 *   - 进度通过回调上报 { downloaded, total, percent, speed }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const POLL_MS = 500;
const STALL_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60 * 60 * 1000; // 镜像最大 1.3GB，给足 1 小时

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    // eslint-disable-next-line no-cond-assign
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

class DownloadCancelled extends Error {
  constructor() { super('已取消'); this.code = 'DOWNLOAD_CANCELLED'; }
}

/**
 * 下载单个文件（幂等 + 校验）。
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.dest
 * @param {string} [opts.sha256]      期望的 sha256（小写十六进制）
 * @param {number} [opts.size]        期望字节数（用于快速判定/进度）
 * @param {object} [opts.aria2]       aria2 管理器（可选，缺省走 fetch）
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.isCancelled]
 */
async function downloadFile({ url, dest, sha256, size, aria2, onProgress, isCancelled } = {}) {
  const cancelled = () => !!(isCancelled && isCancelled());

  // 幂等：已存在且校验通过则跳过
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (size && st.size !== size) {
      // 大小不符 → 重新下载
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    } else if (sha256) {
      if (sha256File(dest) === sha256.toLowerCase()) {
        if (onProgress) onProgress({ downloaded: st.size, total: st.size, percent: 100, skipped: true });
        return { ok: true, skipped: true, file: dest, bytes: st.size };
      }
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    } else {
      if (onProgress) onProgress({ downloaded: st.size, total: st.size, percent: 100, skipped: true });
      return { ok: true, skipped: true, file: dest, bytes: st.size };
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (cancelled()) throw new DownloadCancelled();

  let usedAria2 = false;
  if (aria2) {
    try {
      usedAria2 = await downloadViaAria2({ url, dest, aria2, onProgress, cancelled });
    } catch (e) {
      if (e instanceof DownloadCancelled) throw e;
      // aria2 失败 → 回退 fetch（清理半成品）
      for (const f of [dest, dest + '.aria2']) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
      usedAria2 = false;
    }
  }
  if (!usedAria2) {
    await downloadViaFetch({ url, dest, onProgress, cancelled });
  }

  // 校验
  const finalSize = fs.statSync(dest).size;
  if (size && finalSize !== size) {
    throw new Error(`下载完成但大小不符：期望 ${size} 实际 ${finalSize}`);
  }
  if (sha256) {
    const actual = sha256File(dest);
    if (actual !== sha256.toLowerCase()) {
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      throw new Error(`sha256 校验失败：期望 ${sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
    }
  }
  if (onProgress) onProgress({ downloaded: finalSize, total: finalSize, percent: 100 });
  return { ok: true, skipped: false, file: dest, bytes: finalSize };
}

async function downloadViaAria2({ url, dest, aria2, onProgress, cancelled }) {
  if (typeof aria2.isAlive === 'function' && !aria2.isAlive()) {
    const ok = await aria2.ensureStarted();
    if (!ok) return false;
  }
  const gid = await aria2.addUri(url, {
    dir: path.dirname(dest),
    out: path.basename(dest),
    split: 8,
    maxConnections: 8,
    continue: true,
  });
  let last = -1;
  let lastProgressAt = Date.now();
  for (;;) {
    if (cancelled()) {
      await aria2.cancel(gid, true).catch(() => {});
      throw new DownloadCancelled();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    let st = null;
    try { st = await aria2.tellStatus(gid); } catch { continue; }
    if (!st) continue;
    const total = parseInt(st.totalLength || '0', 10);
    const done = parseInt(st.completedLength || '0', 10);
    if (onProgress && done !== last) {
      onProgress({ downloaded: done, total, percent: total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0, speed: parseInt(st.downloadSpeed || '0', 10) });
      last = done;
      lastProgressAt = Date.now();
    }
    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
      await aria2.cancel(gid, true).catch(() => {});
      throw new Error('aria2 长时间无进度');
    }
    if (st.status === 'complete') {
      try { await aria2.removeDownloadResult(gid); } catch { /* ignore */ }
      if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error('aria2 完成但文件为空');
      return true;
    }
    if (st.status === 'error' || st.status === 'removed') {
      throw new Error(st.errorMessage || `aria2 下载失败（${st.status}）`);
    }
  }
}

async function downloadViaFetch({ url, dest, onProgress, cancelled }) {
  const tmp = dest + '.part';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const poll = setInterval(() => { if (cancelled()) ctrl.abort(); }, 1000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
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
        onProgress({ downloaded, total, percent: total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0 });
      }
    });
    await new Promise((resolve, reject) => {
      body.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      body.on('error', reject);
      ctrl.signal.addEventListener('abort', () => reject(new DownloadCancelled()), { once: true });
    });
    if (cancelled()) throw new DownloadCancelled();
    fs.renameSync(tmp, dest);
    if (onProgress) onProgress({ downloaded, total: total || downloaded, percent: 100 });
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (e.name === 'AbortError') throw new DownloadCancelled();
    throw e;
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
  }
}

module.exports = { downloadFile, sha256File, DownloadCancelled };
