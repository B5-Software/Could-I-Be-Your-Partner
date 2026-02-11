/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const path = require('path');
const { pathToFileURL } = require('url');

async function run() {
  const { createWorker, OEM } = require('tesseract.js');
  const langPath = pathToFileURL(path.join(__dirname, '..', 'assets', 'ocr')).href;
  const imagePath = path.join(__dirname, '..', 'assets', 'icons', 'icon.png');
  const languages = 'chi_sim+eng';
  const worker = await createWorker(languages, OEM.LSTM_ONLY, { langPath, gzip: false });
  try {
    const { data } = await worker.recognize(imagePath);
    const text = (data && data.text) ? data.text.trim() : '';
    console.log('[OCR] success');
    console.log('[OCR] text length:', text.length);
    process.exit(0);
  } catch (e) {
    console.error('[OCR] failed:', e.message);
    process.exit(1);
  } finally {
    try { await worker.terminate(); } catch {}
  }
}

run();
