/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * PaddleOCR (PP-OCRv4 ONNX) 模型预下载/暂存：
 *   1) 优先从已安装的 @repeato/ocr 包内 assets 复制（npm ci 已含模型，离线可用）
 *   2) 包内缺失时尝试从镜像/官方源下载（HF / ModelScope），支持 --mirror
 * 输出到 assets/ocr-paddle，供打包 asarUnpack 与运行时加载。
 *
 * 用法：
 *   node scripts/download-ocr-paddle.js [--force] [--mirror <base>]
 *   环境变量：CIBYP_OCR_MIRROR
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'assets', 'ocr-paddle');
const args = process.argv.slice(2);
const force = args.includes('--force');
const mirrorArg = (() => {
  const i = args.indexOf('--mirror');
  return i >= 0 && args[i + 1] ? args[i + 1].replace(/\/$/, '') : (process.env.CIBYP_OCR_MIRROR || '').replace(/\/$/, '');
})();

const MODELS = [
  { name: 'ch_PP-OCRv4_det_infer.onnx', minBytes: 1024 * 1024, remote: [
    'https://huggingface.co/deepghs/paddleocr/resolve/main/ch_PP-OCRv4_det_infer/model.onnx',
    'https://raw.githubusercontent.com/jingsongliujing/OnnxOCR/main/models/ch_PP-OCRv4_det_infer.onnx',
  ] },
  { name: 'ch_PP-OCRv4_rec_infer.onnx', minBytes: 1024 * 1024, remote: [
    'https://huggingface.co/deepghs/paddleocr/resolve/main/ch_PP-OCRv4_rec_infer/model.onnx',
    'https://raw.githubusercontent.com/jingsongliujing/OnnxOCR/main/models/ch_PP-OCRv4_rec_infer.onnx',
  ] },
  { name: 'ppocr_keys_v1.txt', minBytes: 10 * 1024, remote: [
    'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt',
  ] },
];

function log(msg) { console.log('[ocr-paddle] ' + msg); }
function warn(msg) { console.warn('[ocr-paddle] ' + msg); }

function packageAssetsDir() {
  try {
    const pkg = require.resolve('@repeato/ocr/package.json');
    return path.join(path.dirname(pkg), 'build', 'node', 'assets');
  } catch {
    return '';
  }
}

function isValid(file, minBytes) {
  try { return fs.existsSync(file) && fs.statSync(file).size >= minBytes; } catch { return false; }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) { reject(new Error('too many redirects')); return; }
    const req = https.get(url, { headers: { 'User-Agent': 'cibyp-build/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        download(next, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const tmp = dest + '.part';
      const stream = fs.createWriteStream(tmp);
      res.pipe(stream);
      stream.on('finish', () => {
        try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); }
      });
      stream.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
  });
}

function mirrorUrls(url) {
  const list = [url];
  if (mirrorArg) {
    list.unshift(`${mirrorArg}/${url}`);
  }
  return list;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const pkgDir = packageAssetsDir();
  if (pkgDir) log(`package assets: ${pkgDir}`);
  else warn('@repeato/ocr not installed; will try remote download only');

  let failed = 0;
  for (const model of MODELS) {
    const dest = path.join(outDir, model.name);
    if (!force && isValid(dest, model.minBytes)) {
      log(`${model.name}: already present (${Math.round(fs.statSync(dest).size / 1024)} KB)`);
      continue;
    }
    let done = false;
    if (pkgDir) {
      const src = path.join(pkgDir, model.name);
      if (isValid(src, model.minBytes)) {
        fs.copyFileSync(src, dest);
        log(`${model.name}: copied from @repeato/ocr package`);
        done = true;
      }
    }
    if (!done) {
      for (const url of model.remote) {
        const candidates = mirrorUrls(url);
        for (const candidate of candidates) {
          try {
            log(`${model.name}: downloading ${candidate}`);
            await download(candidate, dest);
            if (isValid(dest, model.minBytes)) {
              log(`${model.name}: downloaded (${Math.round(fs.statSync(dest).size / 1024)} KB)`);
              done = true;
              break;
            }
            warn(`${model.name}: downloaded file too small, discarding`);
            try { fs.unlinkSync(dest); } catch {}
          } catch (e) {
            warn(`${model.name}: ${candidate} -> ${e.message}`);
          }
        }
        if (done) break;
      }
    }
    if (!done) {
      warn(`${model.name}: unavailable (offline and not bundled)`);
      failed++;
    }
  }

  if (failed > 0) {
    warn(`${failed} model file(s) missing; PaddleOCR will fall back to Tesseract at runtime`);
    process.exitCode = 1;
  } else {
    log('all PaddleOCR models ready in assets/ocr-paddle');
  }
}

main().catch((e) => {
  warn(`fatal: ${e.message}`);
  process.exitCode = 1;
});
