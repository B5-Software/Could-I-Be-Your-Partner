#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 * This file is part of Could I Be Your Partner.
 *
 * 生成屏幕软键盘/输入法所需词库（assets/ime/*.js）：
 *   - 中文拼音词库：雾凇拼音 (iDvel/rime-ice) —— GPL-3.0
 *       cn_dicts/8105.dict.yaml  常用汉字（单字）
 *       cn_dicts/base.dict.yaml  基础词库（词语）
 *       cn_dicts/ext.dict.yaml   扩展词库（词语）
 *   - 英文预测词库：同上 en_dicts/en.dict.yaml —— GPL-3.0
 *   - 德文预测词库：Leipzig Wortschatz deu_news 词频表 —— CC BY 4.0
 *
 * 输出：
 *   assets/ime/ime-dict-zh.js    window.ImeZhDict
 *   assets/ime/ime-dict-en.js    window.ImeEnWords
 *   assets/ime/ime-dict-de.js    window.ImeDeWords
 *   assets/ime/LICENSES.md       数据来源与许可证说明
 *
 * 生成文件不入版本库：assets/ime/ime-dict-*.js 已在 .gitignore 中忽略
 *（体积 50MB+，且由上游数据在线生成）。LICENSES.md 保留提交。
 * 新克隆仓库后运行一次本脚本即可恢复词库，无需手工拷贝。
 *
 * 用法：node scripts/build-ime-dicts.js [--mirror <url>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'ime');

const RIME_ICE = 'https://raw.githubusercontent.com/iDvel/rime-ice/main';
const LEIPZIG_DEU = 'https://downloads.wortschatz-leipzig.de/corpora/deu_news_2022_10K.tar.gz';

const LIMITS = {
  zhMaxWordLen: 6,       // 中文候选最长字数
  zhMaxWordsPerCode: 40, // 每个拼音最多保留候选数
  zhMinWeight: 0,        // 最低权重
  enTop: 20000,          // 英文词表数量
  deTop: 20000,          // 德文词表数量
};

/* ---------- 下载工具 ---------- */

function fetch(url, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetch(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

function downloadText(url, enc = 'utf8') {
  return fetch(url).then((buf) => buf.toString(enc));
}

// 下载 tar.gz 并返回内层文件（简单 tar 解析，仅支持普通文件条目）
function downloadTarGz(url, filename) {
  return fetch(url).then((buf) => {
    const gunz = zlib.gunzipSync(buf);
    const entries = parseTar(gunz);
    const want = filename.toLowerCase();
    const target = entries.find((e) => e.name.toLowerCase().endsWith(want));
    if (!target) throw new Error(`tar 内未找到 ${filename}`);
    return target.data.toString('utf8');
  });
}

function parseTar(buf) {
  const out = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512);
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    let size = parseInt(header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim(), 8) || 0;
    offset += 512;
    const data = buf.slice(offset, offset + size);
    if (!name.endsWith('/')) out.push({ name, data });
    offset += Math.ceil(size / 512) * 512;
  }
  return out;
}

/* ---------- 解析 Rime .dict.yaml ---------- */

// 行格式：词条<TAB>拼音（空格分隔）[<TAB>权重]
// 头信息：--- ... ---（YAML 文档以 ... 结束）
function parseRimeDict(text, opts = {}) {
  const items = []; // { word, code, weight }
  const lines = text.split(/\r?\n/);
  let inHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === '---') { inHeader = !inHeader; continue; }
    if (trimmed === '...') { inHeader = false; continue; }
    if (inHeader) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const word = parts[0];
    const rawCode = (parts[1] || '').trim();
    const weight = parseFloat(parts[2]);
    if (!word || !rawCode) continue;
    if (opts.maxLen && word.length > opts.maxLen) continue;
    const sylls = rawCode.split(/\s+/).map((s) => s.toLowerCase()).filter(Boolean);
    if (!sylls.length) continue;
    items.push({ word, sylls, code: sylls.join(''), weight: isFinite(weight) ? weight : 1 });
  }
  return items;
}

/* ---------- 中文词库 ---------- */

async function buildZh() {
  console.log('[IME] 下载雾凇拼音词库...');
  const [charText, baseText, extText] = await Promise.all([
    downloadText(`${RIME_ICE}/cn_dicts/8105.dict.yaml`),
    downloadText(`${RIME_ICE}/cn_dicts/base.dict.yaml`),
    downloadText(`${RIME_ICE}/cn_dicts/ext.dict.yaml`),
  ]);

  const chars = parseRimeDict(charText, { maxLen: 1 }); // 单字
  const base = parseRimeDict(baseText, { maxLen: LIMITS.zhMaxWordLen });
  const ext = parseRimeDict(extText, { maxLen: LIMITS.zhMaxWordLen });

  console.log(`[IME] 单字 ${chars.length}，基础词 ${base.length}，扩展词 ${ext.length}`);

  // 合并：后写入的覆盖（ext 优先级高，多音字注音更准）
  const wordMap = new Map(); // code -> Map(word -> weight)
  const wordSylls = new Map(); // word -> sylls（取权重最高条目的注音）
  const merge = (items, priority) => {
    for (const it of items) {
      if (!(it.weight > LIMITS.zhMinWeight)) continue;
      if (!wordMap.has(it.code)) wordMap.set(it.code, new Map());
      const m = wordMap.get(it.code);
      const cur = m.get(it.word);
      if (cur === undefined || it.weight > cur) {
        m.set(it.word, it.weight + priority);
        wordSylls.set(it.word, it.sylls);
      }
    }
  };
  merge(base, 0);
  merge(ext, 100000); // 保证 ext 词条在相同 code 下排更前

  // 排序：code 排序 + 每个 code 内按权重降序
  const codes = Array.from(wordMap.keys()).sort();
  const words = {};
  const syllSet = new Set();
  const charCodeMap = new Map(); // word -> code 集合（多音字）

  for (const code of codes) {
    const m = wordMap.get(code);
    const arr = Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIMITS.zhMaxWordsPerCode)
      .map(([word, weight]) => [word, weight]);
    if (!arr.length) continue;
    words[code] = arr;
    for (const [word] of arr) {
      if (!charCodeMap.has(word)) charCodeMap.set(word, new Set());
      charCodeMap.get(word).add(code);
      const wSylls = wordSylls.get(word);
      if (wSylls) for (const s of wSylls) syllSet.add(s);
    }
  }

  // 单字：char -> [word, weight]
  const charMap = new Map(); // code -> Map(word -> weight)
  for (const it of chars) {
    if (!(it.weight > LIMITS.zhMinWeight)) continue;
    if (!charMap.has(it.code)) charMap.set(it.code, new Map());
    const m = charMap.get(it.code);
    const cur = m.get(it.word);
    if (cur === undefined || it.weight > cur) m.set(it.word, it.weight);
  }
  const charsObj = {};
  const charCodes = Array.from(charMap.keys()).sort();
  for (const code of charCodes) {
    const m = charMap.get(code);
    charsObj[code] = Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([word, weight]) => [word, weight]);
    syllSet.add(code);
  }

  // 简拼：取每个词条各音节的声母
  const abbrMap = new Map(); // abbr -> Map(word -> weight)
  const initialOf = (s) => s[0];
  for (const code of codes) {
    const syls = wordSylls.get((words[code][0] || [])[0]) || [];
    if (syls.length < 2) continue;
    const abbr = syls.map(initialOf).join('');
    for (const [word, weight] of words[code]) {
      if (word.length < 2) continue;
      if (!abbrMap.has(abbr)) abbrMap.set(abbr, new Map());
      const m = abbrMap.get(abbr);
      const cur = m.get(word);
      if (cur === undefined || weight > cur) m.set(word, weight);
    }
  }
  const abbr = {};
  for (const [ab, m] of abbrMap) {
    abbr[ab] = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word, weight]) => [word, weight]);
  }

  const syll = Array.from(syllSet).sort();

  console.log(`[IME] 拼音码 ${Object.keys(words).length} 个，单字码 ${Object.keys(charsObj).length} 个，简拼 ${Object.keys(abbr).length} 个`);

  return {
    v: 1,
    syll,
    chars: charsObj,
    words,
    codes,
    abbr,
  };
}

/* ---------- 英文词库（rime-ice en_dicts/en.dict.yaml） ---------- */

async function buildEn() {
  console.log('[IME] 下载雾凇拼音英文词库...');
  const text = await downloadText(`${RIME_ICE}/en_dicts/en.dict.yaml`);
  const items = parseRimeDict(text, { maxLen: 32 });
  // en.dict.yaml 每行是 词<TAB>词（code==词本身），按文件顺序即词频顺序
  const words = [];
  const seen = new Set();
  for (const it of items) {
    const w = it.word;
    if (seen.has(w)) continue;
    if (!/^[a-zA-Z][a-zA-Z'’\-]*$/.test(w)) continue;
    seen.add(w);
    words.push(w);
    if (words.length >= LIMITS.enTop) break;
  }
  console.log(`[IME] 英文词 ${words.length}`);
  return words;
}

/* ---------- 德文词库（Leipzig deu_news 词频表，CC BY 4.0） ---------- */

async function buildDe() {
  console.log('[IME] 下载 Leipzig 德文词频表...');
  const text = await downloadTarGz(LEIPZIG_DEU, 'deu_news_2022_10k-words.txt');
  const words = [];
  const seen = new Set();
  // 格式：rank<TAB>word（或用空格分隔），按词频降序
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t');
    let w = parts.length >= 2 ? parts[1] : null;
    if (!w) {
      const m = line.match(/^\d+\s+(.+)$/);
      if (m) w = m[1];
    }
    if (!w) continue;
    w = w.trim();
    if (!/^[a-zA-ZäöüÄÖÜß][a-zA-ZäöüÄÖÜß'’\-]*$/.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    words.push(w);
    if (words.length >= LIMITS.deTop) break;
  }
  console.log(`[IME] 德文词 ${words.length}`);
  return words;
}

/* ---------- 输出 ---------- */

function writeJs(file, content) {
  const out = path.join(OUT_DIR, file);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(out, content, 'utf8');
  console.log(`[IME] 写入 ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
}

async function main() {
  const mirror = process.argv.includes('--mirror') ? process.argv[process.argv.indexOf('--mirror') + 1] : null;
  if (mirror) process.env.IME_MIRROR = mirror;

  try {
    const [zh, en, de] = await Promise.all([buildZh(), buildEn(), buildDe()]);

    writeJs('ime-dict-zh.js',
      '/* 中文拼音词库 —— 数据来源：雾凇拼音 iDvel/rime-ice (GPL-3.0)。由 scripts/build-ime-dicts.js 自动生成，请勿手改。 */\n' +
      'window.ImeZhDict = ' + JSON.stringify(zh) + ';\n');

    writeJs('ime-dict-en.js',
      '/* 英文预测词库 —— 数据来源：雾凇拼音 iDvel/rime-ice en_dicts/en.dict.yaml (GPL-3.0)。自动生成。 */\n' +
      'window.ImeEnWords = ' + JSON.stringify(en) + ';\n');

    writeJs('ime-dict-de.js',
      '/* 德文预测词库 —— 数据来源：Leipzig Wortschatz deu_news_2022 词频表 (CC BY 4.0)。自动生成。 */\n' +
      'window.ImeDeWords = ' + JSON.stringify(de) + ';\n');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'LICENSES.md'), `# IME 词库数据来源与许可证

由 \`scripts/build-ime-dicts.js\` 下载生成，自动生成的文件请勿手改。

## 中文拼音词库（ime-dict-zh.js）
- 来源：[雾凇拼音](https://github.com/iDvel/rime-ice) \`cn_dicts/8105.dict.yaml\`、\`cn_dicts/base.dict.yaml\`、\`cn_dicts/ext.dict.yaml\`
- 许可证：GPL-3.0（与主程序一致）
- 上游作者：Dvel 等，见 https://github.com/iDvel/rime-ice

## 英文预测词库（ime-dict-en.js）
- 来源：[雾凇拼音](https://github.com/iDvel/rime-ice) \`en_dicts/en.dict.yaml\`
- 许可证：GPL-3.0

## 德文预测词库（ime-dict-de.js）
- 来源：[Leipzig Wortschatz Corpora](https://wortschatz.uni-leipzig.de/en/download) \`deu_news_2022_10k\`
- 许可证：CC BY 4.0

## 生成方式
\`\`\`bash
node scripts/build-ime-dicts.js
\`\`\`
`);
    console.log('[IME] 完成。');
  } catch (e) {
    console.error('[IME] 失败:', e.message);
    process.exit(1);
  }
}

main();
