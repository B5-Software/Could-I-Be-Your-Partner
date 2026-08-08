/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 唤醒词文本 → sherpa-onnx KWS keywords 文件编码器。
 * KWS 模型（zipformer-zh-en）使用 phone+ppinyin 建模单元：
 *   - 英文单词 → CMU 音素（查模型包内置的 en.phone 词典）
 *   - 中文字符 → ppinyin（声母 + 带调韵母，如 "伙伴" → "h uǒ b àn"）
 * 每行格式: <tokens 空格分隔> :<boost> #<threshold> @<原始词>
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ppinyin 声母表（两字母优先）
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

let _cmuDict = null; // Map<WORD, 'L AY1 T'>
let _pinyinLib = null;

function loadCmuDict(enPhonePath) {
  if (_cmuDict) return _cmuDict;
  _cmuDict = new Map();
  try {
    const content = fs.readFileSync(enPhonePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sp = trimmed.indexOf(' ');
      if (sp <= 0) continue;
      const word = trimmed.slice(0, sp).toUpperCase();
      const phones = trimmed.slice(sp + 1).trim();
      if (word && phones && !_cmuDict.has(word)) _cmuDict.set(word, phones);
    }
  } catch (e) {
    console.warn('[voice-kws-encoder] en.phone 加载失败:', e.message);
  }
  return _cmuDict;
}

function getPinyinLib() {
  if (!_pinyinLib) {
    _pinyinLib = require('pinyin-pro');
  }
  return _pinyinLib;
}

/**
 * 中文字符串 → ppinyin token 数组
 * 例: "伙伴" → ['h', 'uǒ', 'b', 'àn']
 */
function hanziToPpinyin(text) {
  const { pinyin } = getPinyinLib();
  const tokens = [];
  for (const ch of text) {
    if (!/[\u4e00-\u9fff]/.test(ch)) continue;
    // toneType: 'symbol' → 带调号拼音（如 huǒ）；multiple: false 取第一个读音
    const py = pinyin(ch, { toneType: 'symbol', type: 'array', multiple: false, v: true })[0];
    if (!py) continue;
    const lower = py.toLowerCase();
    let matched = false;
    for (const ini of INITIALS) {
      if (lower.startsWith(ini) && lower.length > ini.length) {
        // 需保证剩余部分是合法韵母（简单校验：以元音开头）
        const rest = lower.slice(ini.length);
        if (/^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(rest)) {
          tokens.push(ini, rest);
          matched = true;
          break;
        }
      }
    }
    if (!matched) tokens.push(lower); // 零声母整体
  }
  return tokens;
}

/**
 * 英文短语 → CMU phone token 数组
 * 例: "hey partner" → ['HH', 'EY1', 'P', 'AA1', ...]
 * 未登录词返回 null（由调用方降级处理）
 */
function englishToPhones(phrase, dict) {
  const tokens = [];
  for (const rawWord of phrase.trim().split(/\s+/)) {
    const word = rawWord.toUpperCase().replace(/[^A-Z']/g, '');
    if (!word) continue;
    const phones = dict.get(word);
    if (!phones) return null;
    tokens.push(...phones.split(/\s+/));
  }
  return tokens;
}

/**
 * 将一条唤醒词编码为 keywords 文件行。
 * @param {string} phrase 原始唤醒词（可为中文/英文/混合，空格分词）
 * @param {object} opts { boost, threshold, cmuDict }
 * @returns {{ line: string|null, error?: string }}
 */
function encodeKeyword(phrase, opts = {}) {
  const boost = opts.boost != null ? opts.boost : 2.0;
  const threshold = opts.threshold != null ? opts.threshold : 0.35;
  const dict = opts.cmuDict;
  if (!phrase || !phrase.trim()) return { line: null, error: 'empty' };

  const safePhrase = phrase.trim().replace(/\s+/g, ' ').replace(/[:#@]/g, '');
  const original = safePhrase.replace(/\s/g, '_'); // @原文不含空格
  const tokens = [];

  // 按"连续中文字符段"与"连续英文/字母段"切分
  const segments = safePhrase.match(/[\u4e00-\u9fff]+|[A-Za-z']+/g) || [];
  if (segments.length === 0) return { line: null, error: 'no-encodable-content' };

  for (const seg of segments) {
    if (/^[\u4e00-\u9fff]+$/.test(seg)) {
      tokens.push(...hanziToPpinyin(seg));
    } else {
      if (!dict) return { line: null, error: 'cmu-dict-missing' };
      const phones = englishToPhones(seg, dict);
      if (!phones) return { line: null, error: `en-oov:${seg}` };
      tokens.push(...phones);
    }
  }

  if (tokens.length === 0) return { line: null, error: 'no-tokens' };
  return { line: `${tokens.join(' ')} :${boost} #${threshold} @${original}` };
}

/**
 * 生成完整 keywords 文件内容。
 * @param {Array<{phrase:string, boost?:number, threshold?:number}>} keywords
 * @param {string} enPhonePath KWS 模型包内 en.phone 路径
 * @returns {{ content: string, errors: Array<{phrase:string,error:string}> }}
 */
function buildKeywordsFile(keywords, enPhonePath) {
  const dict = loadCmuDict(enPhonePath);
  const lines = [];
  const errors = [];
  for (const kw of keywords || []) {
    const { line, error } = encodeKeyword(kw.phrase, { boost: kw.boost, threshold: kw.threshold, cmuDict: dict });
    if (line) lines.push(line);
    else errors.push({ phrase: kw.phrase, error });
  }
  return { content: lines.join('\n') + '\n', errors };
}

module.exports = { buildKeywordsFile, encodeKeyword, hanziToPpinyin, loadCmuDict };
