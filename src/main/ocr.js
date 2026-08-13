/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Tesseract OCR（中英混合）。打包环境会把 traineddata 从 asar 解包目录
 * 复制到 userData 真实文件系统后再加载。
 */

'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

async function recognizeImageWithTesseract(imagePath) {
  const { createWorker, OEM } = require('tesseract.js');
  // 打包后 traineddata 位于 app.asar.unpacked/assets/ocr（因 asarUnpack 配置），
  // tesseract worker（worker_threads）使用原生 fs 无法读 asar，故先复制到 userData 真实文件系统。
  // 同时设置 cachePath 和 langPath 为该目录，使 tesseract 优先从缓存命中，完全跳过 fetch 路径。
  const ocrCacheDir = path.join(app.getPath('userData'), 'ocr-data');
  try {
    if (!fs.existsSync(ocrCacheDir)) fs.mkdirSync(ocrCacheDir, { recursive: true });
    // 定位打包后的 traineddata：优先 app.asar.unpacked（asarUnpack），回退 app.asar
    const resourcesPath = process.resourcesPath || app.getAppPath();
    const candidates = [
      path.join(resourcesPath, 'app.asar.unpacked', 'assets', 'ocr'),
      path.join(app.getAppPath(), 'assets', 'ocr'),
      path.join(resourcesPath, 'assets', 'ocr'),
    ];
    let bundledOcrDir = null;
    for (const c of candidates) {
      try { if (fs.existsSync(c)) { bundledOcrDir = c; break; } } catch (_) {}
    }
    if (bundledOcrDir) {
      const files = fs.readdirSync(bundledOcrDir);
      for (const file of files) {
        if (file.endsWith('.traineddata') || file.endsWith('.gz')) {
          const destPath = path.join(ocrCacheDir, file);
          if (!fs.existsSync(destPath)) {
            try { fs.copyFileSync(path.join(bundledOcrDir, file), destPath); } catch (_) {}
          }
        }
      }
    } else {
      console.warn('OCR: bundled traineddata directory not found in any candidate path');
    }
  } catch (e) {
    console.warn('OCR lang dir setup failed:', e.message);
  }
  const languages = 'chi_sim+eng';
  // cachePath 优先命中（worker 先读 cachePath/lang.traineddata），langPath 作为回退；
  // 两者均为普通路径（非 file:// URL），确保 tesseract 走 adapter.readCache（fs.readFile）而非 fetch。
  const worker = await createWorker(languages, OEM.LSTM_ONLY, {
    langPath: ocrCacheDir,
    cachePath: ocrCacheDir,
    cacheMethod: 'write',
    gzip: false,
  });
  try {
    const { data: { text } } = await worker.recognize(imagePath);
    return text;
  } finally {
    await worker.terminate();
  }
}

module.exports = { recognizeImageWithTesseract };
