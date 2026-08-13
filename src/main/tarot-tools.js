/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 塔罗牌抽取与 TRNG（硬件随机数）实现。entropy 配置由调用方显式传入，
 * 本模块不依赖主进程全局状态。
 */

'use strict';

const tarotCards = require('../data/tarot.js');
const tarotSpreads = require('../data/tarot-spreads.js');

function drawTarotCSPRNG() {
  const crypto = require('crypto');
  const range = tarotCards.length;
  const max = Math.floor(0x100000000 / range) * range;
  let val;
  do {
    val = crypto.randomBytes(4).readUInt32BE(0);
  } while (val >= max);
  const card = tarotCards[val % range];
  const isReversed = crypto.randomBytes(1)[0] < 128;
  return {
    ...card,
    isReversed,
    orientation: isReversed ? 'reversed' : 'upright',
    meaningOfUpright: card.meaningOfUpright,
    meaningOfReversed: card.meaningOfReversed,
    entropySource: 'CSPRNG'
  };
}

async function drawTarotTRNG(entropy = {}) {
  const raw = await getTrngDraw(entropy);
  // raw should be { cardIndex, isReversed } from the TRNG device
  const card = tarotCards[raw.cardIndex % tarotCards.length];
  const isReversed = raw.isReversed;
  return {
    ...card,
    isReversed,
    orientation: isReversed ? 'reversed' : 'upright',
    meaningOfUpright: card.meaningOfUpright,
    meaningOfReversed: card.meaningOfReversed,
    entropySource: 'TRNG'
  };
}

// Draw N cards using CSPRNG, ensuring no duplicates
function drawTarotSpreadCSPRNG(count) {
  const crypto = require('crypto');
  const range = tarotCards.length;
  const drawn = new Set();
  const cards = [];
  while (cards.length < count && cards.length < range) {
    const max = Math.floor(0x100000000 / range) * range;
    let val;
    do {
      val = crypto.randomBytes(4).readUInt32BE(0);
    } while (val >= max);
    const idx = val % range;
    if (drawn.has(idx)) continue;
    drawn.add(idx);
    const card = tarotCards[idx];
    const isReversed = crypto.randomBytes(1)[0] < 128;
    cards.push({
      ...card,
      isReversed,
      orientation: isReversed ? 'reversed' : 'upright',
      meaningOfUpright: card.meaningOfUpright,
      meaningOfReversed: card.meaningOfReversed,
      entropySource: 'CSPRNG'
    });
  }
  return cards;
}

// Draw N cards using TRNG, ensuring no duplicates
async function drawTarotSpreadTRNG(count, entropy = {}) {
  const mode = entropy.trngMode || 'network';
  const drawn = new Set();
  const cards = [];
  for (let i = 0; i < count; i++) {
    let raw;
    if (mode === 'serial') {
      raw = await getTRNGFromSerial(entropy.trngSerialPort, entropy.trngSerialBaud || 115200);
    } else {
      raw = await getTRNGFromNetwork(entropy.trngNetworkHost || '192.168.4.1', entropy.trngNetworkPort || 80);
    }
    let idx = raw.cardIndex % tarotCards.length;
    // Avoid duplicates (try a few times)
    let attempts = 0;
    while (drawn.has(idx) && attempts < 5) {
      if (mode === 'serial') {
        raw = await getTRNGFromSerial(entropy.trngSerialPort, entropy.trngSerialBaud || 115200);
      } else {
        raw = await getTRNGFromNetwork(entropy.trngNetworkHost || '192.168.4.1', entropy.trngNetworkPort || 80);
      }
      idx = raw.cardIndex % tarotCards.length;
      attempts++;
    }
    drawn.add(idx);
    const card = tarotCards[idx];
    const isReversed = raw.isReversed;
    cards.push({
      ...card,
      isReversed,
      orientation: isReversed ? 'reversed' : 'upright',
      meaningOfUpright: card.meaningOfUpright,
      meaningOfReversed: card.meaningOfReversed,
      entropySource: 'TRNG'
    });
  }
  return cards;
}

// 根据 entropy 配置从 TRNG 设备取一次原始抽取结果（串口或网络）
async function getTrngDraw(entropy = {}) {
  const mode = entropy.trngMode || 'network';
  if (mode === 'serial') {
    return getTRNGFromSerial(entropy.trngSerialPort, entropy.trngSerialBaud || 115200);
  }
  return getTRNGFromNetwork(entropy.trngNetworkHost || '192.168.4.1', entropy.trngNetworkPort || 80);
}

async function getTRNGFromSerial(portPath, baud) {
  return new Promise((resolve, reject) => {
    if (!portPath) return reject(new Error('未配置TRNG串口'));
    let { SerialPort } = {};
    try { ({ SerialPort } = require('serialport')); } catch {
      return reject(new Error('serialport 模块未安装，请运行 npm install serialport'));
    }

    const port = new SerialPort({ path: portPath, baudRate: baud });
    let responded = false;

    function safeClose() {
      try { if (port.isOpen) port.close(); } catch {}
    }

    const globalTimeout = setTimeout(() => {
      safeClose();
      if (!responded) { responded = true; reject(new Error('TRNG串口超时')); }
    }, 12000);

    port.on('error', (e) => {
      clearTimeout(globalTimeout);
      if (!responded) { responded = true; reject(e); }
    });

    port.once('open', () => {
      // --- Phase 1: flush phase ---
      // Discard ALL data received in the first 600 ms.
      // This eliminates the ESP32/Arduino bootloader startup log that sits in
      // the OS USB-CDC buffer and would otherwise cause a parse failure.
      let flushing = true;
      let responseBuf = '';

      port.on('data', (chunk) => {
        if (flushing) return; // silently discard startup-log bytes

        responseBuf += chunk.toString();
        // Look for complete JSON line (device sends one JSON object per line)
        const lines = responseBuf.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            clearTimeout(globalTimeout);
            safeClose();
            try {
              const json = JSON.parse(trimmed);
              if (!responded) {
                responded = true;
                resolve({ cardIndex: json.cardIndex, isReversed: json.isReversed });
              }
            } catch (e) {
              if (!responded) {
                responded = true;
                reject(new Error('TRNG串口JSON解析失败: ' + trimmed));
              }
            }
            return;
          }
        }
      });

      // --- Phase 2: after flush window, send command ---
      setTimeout(() => {
        flushing = false;
        responseBuf = '';
        port.write('DRAW\n', (err) => {
          if (err && !responded) {
            clearTimeout(globalTimeout);
            responded = true;
            safeClose();
            reject(new Error('TRNG串口写入失败: ' + err.message));
          }
        });
      }, 600); // 600 ms is enough for typical ESP32 boot log to drain
    });
  });
}

async function getTRNGFromNetwork(host, port) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('TRNG网络超时')), 10000);
    const req = http.get(`http://${host}:${port}/api/draw`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(data);
          resolve({ cardIndex: json.cardIndex, isReversed: json.isReversed });
        } catch (e) { reject(new Error('TRNG网络数据解析失败: ' + data)); }
      });
    });
    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('TRNG网络请求超时')); });
  });
}

module.exports = {
  tarotCards,
  tarotSpreads,
  drawTarotCSPRNG,
  drawTarotTRNG,
  drawTarotSpreadCSPRNG,
  drawTarotSpreadTRNG,
  getTrngDraw,
  getTRNGFromSerial,
  getTRNGFromNetwork
};
