/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * OCR engine smoke test (Electron main): verifies traineddata resolution
 * (must not be "missing") and that the detailed recognizer returns lines
 * with bounding boxes. Run: npm run test:ocr
 */

'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const ocr = require(path.join(ROOT, 'src/main/ocr.js'));
const IMAGE = path.join(ROOT, 'assets', 'icons', 'icon.png');

function fail(msg) {
  console.error('[ocr-engine-smoke] FAIL: ' + msg);
  app.exit(1);
}

app.whenReady().then(async () => {
  try {
    if (!fs.existsSync(IMAGE)) {
      fail('test image not found: ' + IMAGE);
      return;
    }

    const info = ocr.ensureTraineddata();
    if (info.missing && info.missing.length) {
      fail('traineddata missing: ' + info.missing.join(', ') + ' (dir=' + info.dir + ')');
      return;
    }
    console.log('[ocr-engine-smoke] traineddata dir=' + info.dir + ' gzip=' + info.gzip);

    const tess = await ocr.recognizeImageDetailed(IMAGE, { engine: 'tesseract' });
    if (tess.engine !== 'tesseract') fail('expected tesseract engine, got ' + tess.engine);
    if (!Array.isArray(tess.lines)) fail('tesseract lines is not an array');
    console.log('[ocr-engine-smoke] tesseract ok lines=' + tess.lines.length);

    if (ocr.isPaddleAvailable()) {
      const paddle = await ocr.recognizeImageDetailed(IMAGE, { engine: 'paddleocr' });
      if (paddle.engine !== 'paddleocr') fail('expected paddleocr engine, got ' + paddle.engine);
      if (!Array.isArray(paddle.lines)) fail('paddleocr lines is not an array');
      console.log('[ocr-engine-smoke] paddleocr ok lines=' + paddle.lines.length);
    } else {
      console.log('[ocr-engine-smoke] paddleocr not installed, skipped');
    }

    await ocr.disposeOcrEngines();
    console.log('[ocr-engine-smoke] OK');
    app.exit(0);
  } catch (e) {
    fail(e && e.stack ? e.stack : String(e));
  }
});
