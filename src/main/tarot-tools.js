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
    entropySource: 'CSPRNG',
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
    entropySource: 'TRNG',
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
      entropySource: 'CSPRNG',
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
      raw = await getTRNGFromNetwork(
        entropy.trngNetworkHost || '192.168.4.1',
        entropy.trngNetworkPort || 80,
      );
    }
    let idx = raw.cardIndex % tarotCards.length;
    // Avoid duplicates (try a few times)
    let attempts = 0;
    while (drawn.has(idx) && attempts < 5) {
      if (mode === 'serial') {
        raw = await getTRNGFromSerial(entropy.trngSerialPort, entropy.trngSerialBaud || 115200);
      } else {
        raw = await getTRNGFromNetwork(
          entropy.trngNetworkHost || '192.168.4.1',
          entropy.trngNetworkPort || 80,
        );
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
      entropySource: 'TRNG',
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
  return getTRNGFromNetwork(
    entropy.trngNetworkHost || '192.168.4.1',
    entropy.trngNetworkPort || 80,
  );
}

async function getTRNGFromSerial(portPath, baud) {
  if (!portPath) throw new Error('未配置 TRNG 串口');
  const { readDeviceCommand, isDraw } = require('./services/firmware/device-protocol');
  const reply = await readDeviceCommand({
    path: portPath,
    baudRate: baud,
    command: 'DRAW',
    accept: isDraw,
  });
  return { cardIndex: reply.cardIndex, isReversed: reply.isReversed };
}

async function getTRNGFromNetwork(host, port) {
  const http = require('node:http');
  const { isDraw } = require('./services/firmware/device-protocol');
  if (
    typeof host !== 'string' ||
    !host.trim() ||
    !Number.isInteger(Number(port)) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw new Error('TRNG 网络地址或端口无效');
  return new Promise((resolve, reject) => {
    let settled = false,
      req;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      req?.destroy();
      finish(new Error('TRNG 网络超时'));
    }, 10000);
    try {
      req = http.get({ hostname: host, port, path: '/api/draw' }, (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          finish(new Error('TRNG 网络状态异常: ' + res.statusCode));
          return;
        }
        let data = '',
          size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 8192) {
            req.destroy();
            finish(new Error('TRNG 网络响应过大'));
          } else data += chunk;
        });
        res.on('error', () => finish(new Error('TRNG 网络连接中断')));
        res.on('end', () => {
          try {
            const value = JSON.parse(data);
            if (!isDraw(value)) throw new Error();
            finish(null, { cardIndex: value.cardIndex, isReversed: value.isReversed });
          } catch {
            finish(new Error('TRNG 网络返回了无效牌面'));
          }
        });
      });
      req.on('error', () => finish(new Error('TRNG 网络请求失败')));
    } catch {
      finish(new Error('TRNG 网络地址或请求无效'));
    }
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
  getTRNGFromNetwork,
};
