/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * OCR 引擎层：
 *   - 主力 PaddleOCR（@repeato/ocr，PP-OCRv4 ONNX），返回带坐标的文本行
 *   - 兜底 Tesseract（tesseract.js），返回文本与行/词级 bbox
 *   - traineddata 定位覆盖开发/打包（asar.unpacked）/userData 缓存，绝不写到 cwd
 */

'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const languages = 'chi_sim+eng';
const PADDLE_MODEL_FILES = {
  detectionPath: 'ch_PP-OCRv4_det_infer.onnx',
  recognitionPath: 'ch_PP-OCRv4_rec_infer.onnx',
  dictionaryPath: 'ppocr_keys_v1.txt',
};

let tessWorker = null;
let tessWorkerKey = '';
let tessQueue = Promise.resolve();
let paddleEnginePromise = null;

function isFileOfSize(p, minBytes) {
  try { return fs.existsSync(p) && fs.statSync(p).size > (minBytes || 0); } catch { return false; }
}

function searchRoots() {
  const roots = [];
  const push = (p) => { try { if (p && !roots.includes(p)) roots.push(p); } catch { /* ignore */ } };
  try {
    const resourcesPath = process.resourcesPath;
    if (resourcesPath) {
      push(path.join(resourcesPath, 'app.asar.unpacked'));
      push(resourcesPath);
    }
  } catch { /* ignore */ }
  try { push(app.getAppPath()); } catch { /* ignore */ }
  try { push(path.join(app.getAppPath(), '..')); } catch { /* ignore */ }
  try { push(process.cwd()); } catch { /* ignore */ }
  return roots;
}

function findFirstExisting(relativePath) {
  for (const root of searchRoots()) {
    const candidate = path.join(root, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function bundledTessdataDirs() {
  const dirs = [];
  for (const root of searchRoots()) {
    dirs.push(path.join(root, 'assets', 'ocr'));
  }
  return dirs.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

function userDataOcrDir() {
  const dir = path.join(app.getPath('userData'), 'ocr-data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

/**
 * 确保 userData/ocr-data 下有可用 traineddata：
 * 优先直接使用；缺失时从 assets/ocr（开发目录 / asar.unpacked / resources）复制。
 * 返回 { dir, gzip, missing }，绝不抛异常。
 */
function ensureTraineddata() {
  const dir = userDataOcrDir();
  let gzip = false;
  const missing = [];
  const bundled = bundledTessdataDirs();
  for (const lang of ['chi_sim', 'eng']) {
    const plain = path.join(dir, `${lang}.traineddata`);
    const gz = path.join(dir, `${lang}.traineddata.gz`);
    if (isFileOfSize(plain, 1024 * 1024)) continue;
    if (isFileOfSize(gz, 512 * 1024)) { gzip = true; continue; }
    let copied = false;
    for (const sourceDir of bundled) {
      for (const name of [`${lang}.traineddata`, `${lang}.traineddata.gz`]) {
        const src = path.join(sourceDir, name);
        const minSize = name.endsWith('.gz') ? 512 * 1024 : 1024 * 1024;
        if (!isFileOfSize(src, minSize)) continue;
        try {
          fs.copyFileSync(src, path.join(dir, name));
          if (name.endsWith('.gz')) gzip = true;
          copied = true;
          break;
        } catch { /* try next source */ }
      }
      if (copied) break;
    }
    if (!copied) missing.push(lang);
  }
  return { dir, gzip, missing };
}

async function getTessWorker() {
  const { dir, gzip, missing } = ensureTraineddata();
  if (missing.length) {
    throw new Error(`OCR traineddata unavailable: ${missing.join(', ')} (searched assets/ocr, resources, userData)`);
  }
  const key = `${dir}|${gzip}`;
  if (tessWorker && tessWorkerKey === key) return tessWorker;
  if (tessWorker) {
    try { await tessWorker.terminate(); } catch { /* ignore */ }
    tessWorker = null;
    tessWorkerKey = '';
  }
  const { createWorker, OEM } = require('tesseract.js');
  // cachePath 优先命中（worker 先读 cachePath/lang.traineddata），langPath 作为回退；
  // 两者均为普通路径（非 file:// URL），确保 tesseract 走 adapter.readCache（fs.readFile）而非 fetch。
  const workerOptions = {
    langPath: dir,
    cachePath: dir,
    cacheMethod: 'write',
    gzip: false,
  };
  if (gzip) workerOptions.gzip = true;
  tessWorker = await createWorker(languages, OEM.LSTM_ONLY, workerOptions);
  tessWorkerKey = key;
  return tessWorker;
}

function withTessLock(fn) {
  const next = tessQueue.then(fn, fn);
  tessQueue = next.then(() => {}, () => {});
  return next;
}

function bboxToRect(bbox) {
  if (!bbox) return null;
  const x0 = Number(bbox.x0 ?? bbox.left ?? 0);
  const y0 = Number(bbox.y0 ?? bbox.top ?? 0);
  const x1 = Number(bbox.x1 ?? ((bbox.left ?? 0) + (bbox.width ?? 0)));
  const y1 = Number(bbox.y1 ?? ((bbox.top ?? 0) + (bbox.height ?? 0)));
  return { x: Math.round(x0), y: Math.round(y0), w: Math.max(0, Math.round(x1 - x0)), h: Math.max(0, Math.round(y1 - y0)) };
}

function polygonToRect(box) {
  if (!Array.isArray(box) || box.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of box) {
    const x = Number(point?.[0]);
    const y = Number(point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: Math.round(minX), y: Math.round(minY), w: Math.max(0, Math.round(maxX - minX)), h: Math.max(0, Math.round(maxY - minY)) };
}

async function recognizeWithTesseractDetailed(imagePath) {
  return withTessLock(async () => {
    const worker = await getTessWorker();
    const { data } = await worker.recognize(imagePath, undefined, { text: true, blocks: true });
    const lines = [];
    let id = 0;
    for (const block of (data.blocks || [])) {
      for (const paragraph of (block.paragraphs || [])) {
        for (const line of (paragraph.lines || [])) {
          lines.push({
            id: id++,
            text: String(line.text || '').trim(),
            confidence: Number(line.confidence || 0) / 100,
            bbox: bboxToRect(line.bbox),
            words: (line.words || []).map((word) => ({
              text: String(word.text || '').trim(),
              confidence: Number(word.confidence || 0) / 100,
              bbox: bboxToRect(word.bbox),
            })),
          });
        }
      }
    }
    return { engine: 'tesseract', text: String(data.text || ''), lines, width: 0, height: 0, resized: false };
  });
}

function isPaddleAvailable() {
  try { require.resolve('@repeato/ocr'); return true; } catch { return false; }
}

function resolvePaddleModels() {
  const dir = findFirstExisting(path.join('assets', 'ocr-paddle'));
  const candidates = [];
  if (dir) candidates.push(dir);
  try { candidates.push(path.join(path.dirname(require.resolve('@repeato/ocr/package.json')), 'build', 'node', 'assets')); } catch { /* ignore */ }
  for (const candidate of candidates) {
    const models = {
      detectionPath: path.join(candidate, PADDLE_MODEL_FILES.detectionPath),
      recognitionPath: path.join(candidate, PADDLE_MODEL_FILES.recognitionPath),
      dictionaryPath: path.join(candidate, PADDLE_MODEL_FILES.dictionaryPath),
    };
    if (isFileOfSize(models.detectionPath, 1024 * 1024) && isFileOfSize(models.recognitionPath, 1024 * 1024) && fs.existsSync(models.dictionaryPath)) {
      return models;
    }
  }
  return null;
}

async function getPaddleEngine() {
  if (!paddleEnginePromise) {
    paddleEnginePromise = (async () => {
      const Ocr = require('@repeato/ocr');
      const models = resolvePaddleModels();
      return models ? await Ocr.create({ models }) : await Ocr.create();
    })().catch((e) => {
      paddleEnginePromise = null;
      throw e;
    });
  }
  return paddleEnginePromise;
}

async function recognizeWithPaddleDetailed(imagePath) {
  const engine = await getPaddleEngine();
  const result = await engine.detect(imagePath);
  const lines = (result.texts || []).map((line, index) => ({
    id: index,
    text: String(line.text || '').trim(),
    confidence: Number.isFinite(Number(line.mean)) ? Number(line.mean) : 0,
    bbox: polygonToRect(line.box),
    words: [],
  }));
  return {
    engine: 'paddleocr',
    text: lines.map((l) => l.text).filter(Boolean).join('\n'),
    lines,
    width: Number(result.resizedImageWidth) || 0,
    height: Number(result.resizedImageHeight) || 0,
    resized: true,
  };
}

async function recognizeImageDetailed(imagePath, options = {}) {
  const preferred = options.engine || 'auto';
  if (preferred !== 'tesseract' && isPaddleAvailable()) {
    try {
      return await recognizeWithPaddleDetailed(imagePath);
    } catch (e) {
      try { console.warn('[ocr] paddleocr failed, falling back to tesseract:', e && e.message); } catch { /* ignore */ }
    }
  }
  return recognizeWithTesseractDetailed(imagePath);
}

async function recognizeImageWithTesseract(imagePath) {
  const result = await recognizeImageDetailed(imagePath, { engine: 'tesseract' });
  return result.text;
}

async function disposeOcrEngines() {
  try {
    if (tessWorker) {
      await tessWorker.terminate();
    }
  } catch { /* ignore */ }
  tessWorker = null;
  tessWorkerKey = '';
  try {
    const engine = await paddleEnginePromise;
    if (engine && typeof engine.release === 'function') await engine.release();
  } catch { /* ignore */ }
  paddleEnginePromise = null;
}

module.exports = {
  recognizeImageWithTesseract,
  recognizeImageDetailed,
  ensureTraineddata,
  disposeOcrEngines,
  isPaddleAvailable,
};
