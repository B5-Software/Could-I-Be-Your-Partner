/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 * This file is part of Could I Be Your Partner.
 *
 * 拼音输入引擎（纯逻辑，无 DOM 依赖）。
 * 数据来源：雾凇拼音 (iDvel/rime-ice)，GPL-3.0。
 * 结构：
 *   window.ImeZhDict = {
 *     v: 1,
 *     syll: ['a','ai',...],            // 完整音节（排序）
 *     chars: { 'ni': [['你',w],...] }, // 单字候选（按权重降序）
 *     words: { 'nihao': [['你好',w]] },// 词语候选（code 为无空格拼音）
 *     codes: ['a','ai',...],           // 全部 code（排序，用于前缀查找）
 *     abbr: { 'nh': [['你好',w]] }     // 简拼（声母缩写）
 *   }
 */
(function (global) {
  'use strict';

  const SYLLABLE_LENGTHS = [6, 5, 4, 3, 2, 1];

  function ImeEngine() {
    this._zh = null;
    this._en = [];
    this._de = [];
  }

  ImeEngine.prototype.initZh = function (dict) {
    if (!dict || !dict.words) return false;
    this._zh = dict;
    if (!Array.isArray(dict.syll)) {
      dict.syll = Object.keys(dict.chars || {}).sort();
    }
    if (!Array.isArray(dict.codes)) {
      dict.codes = Object.keys(dict.words || {}).sort();
    }
    if (!dict._syllSet) dict._syllSet = new Set(dict.syll);
    return true;
  };

  ImeEngine.prototype.initEn = function (list) { this._en = list || []; };
  ImeEngine.prototype.initDe = function (list) { this._de = list || []; };

  ImeEngine.prototype.hasZh = function () { return !!this._zh; };

  /* ---------- 通用：预测补全（英/德） ---------- */
  // list 为按词频降序的单词数组。返回匹配 prefix 的前 n 个。
  function predictFrom(list, prefix, n) {
    if (!list || !list.length || !prefix) return [];
    const out = [];
    const low = prefix.toLowerCase();
    for (let i = 0; i < list.length && out.length < n; i++) {
      const w = list[i];
      if (w.toLowerCase().startsWith(low)) out.push(w);
    }
    return out;
  }

  ImeEngine.prototype.predictEn = function (prefix, n) {
    return predictFrom(this._en, prefix, n || 6);
  };
  ImeEngine.prototype.predictDe = function (prefix, n) {
    return predictFrom(this._de, prefix, n || 6);
  };

  /* ---------- 拼音 ---------- */

  // 返回 [{ word, weight, type, code }]
  // type: 'exact' 完整词 / 'prefix' 拼音前缀 / 'char' 单字 / 'abbr' 简拼 / 'combo' 字组合
  ImeEngine.prototype.getCandidates = function (input, opts) {
    if (!this._zh) return [];
    opts = opts || {};
    const q = String(input || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!q) return [];
    const maxLen = opts.maxLength || 6; // 最长候选字数
    const result = new Map();           // word -> {word, weight, type, code}

    const put = (word, weight, type, code) => {
      if (!word || word.length > maxLen) return;
      const cur = result.get(word);
      if (!cur) {
        result.set(word, { word, weight, type, code });
        return;
      }
      // 组合候选（每音节首字拼成）只是兜底：绝不覆盖已存在的完整/前缀匹配
      if (type === 'combo' && cur.type !== 'combo') return;
      if (weight > cur.weight) {
        result.set(word, { word, weight, type, code });
      }
    };

    // 1) 完整词精确匹配
    this._lookupWords(q, (word, weight) => put(word, weight, 'exact', q));

    // 2) 拼音前缀匹配（code 以 q 开头）
    const codes = this._codesWithPrefix(q);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      const arr = this._zh.words[code];
      if (!arr) continue;
      for (let j = 0; j < arr.length; j++) {
        const w = arr[j];
        if (w[0].length > 1 && w[0].length <= maxLen) put(w[0], w[1], 'prefix', code);
      }
    }

    // 3) 简拼（声母缩写）
    const abbrArr = this._zh.abbr ? this._zh.abbr[q] : null;
    if (abbrArr) {
      for (let i = 0; i < abbrArr.length; i++) {
        const w = abbrArr[i];
        if (w[0].length > 1 && w[0].length <= maxLen) put(w[0], w[1], 'abbr', q);
      }
    }

    // 4) 单字候选（按音节切分）
    const segs = this._segment(q);
    const singleSyll = this._isSyllable(q);
    const seenChars = new Set();
    for (let i = 0; i < segs.length && i < 8; i++) {
      const seg = segs[i];              // 形如 ['ni','hao'] 或 ['ni','ha']（末位可为音节前缀）
      // 单个完整音节时，跳过拆分片段（ai 只取 [ai]，避免 啊/阿 混入）
      if (singleSyll && seg.length > 1) continue;
      for (let k = 0; k < seg.length; k++) {
        const s = seg[k];
        const isLast = k === seg.length - 1;
        if (isLast && !this._isSyllable(s)) {
          // 末位是音节前缀：展开所有以此开头的完整音节
          const cands = this._singleForPrefix(s, seg.slice(0, -1));
          for (let m = 0; m < cands.length && m < 12; m++) {
            const c = cands[m];
            if (c && !seenChars.has(c[0])) {
              seenChars.add(c[0]);
              put(c[0], c[1], 'char', seg.join(''));
            }
          }
        } else if (this._isSyllable(s)) {
          const arr = this._zh.chars[s];
          if (arr) {
            for (let m = 0; m < arr.length && m < 6; m++) {
              const c = arr[m];
              if (!seenChars.has(c[0])) {
                seenChars.add(c[0]);
                put(c[0], c[1], 'char', s);
              }
            }
          }
        }
      }
    }

    // 5) 字组合候选（每个音节取首字拼成一个词，如 ni hao -> 你好）
    for (let i = 0; i < segs.length && i < 4; i++) {
      const seg = segs[i];
      if (seg.length < 2) continue;
      const combo = this._comboWord(seg);
      if (combo) put(combo.word, combo.weight, 'combo', seg.join(''));
    }

    // 排序：type 优先级 + 权重
    // 单个完整音节时，单字应优先于词语前缀（wo -> 我 而非 我爱…）
    const typeOrder = singleSyll
      ? { char: 0, exact: 1, combo: 2, prefix: 3, abbr: 4 }
      : { exact: 0, prefix: 1, combo: 2, abbr: 3, char: 4 };
    const arr = Array.from(result.values());
    arr.sort((a, b) => {
      const ta = typeOrder[a.type] === undefined ? 5 : typeOrder[a.type];
      const tb = typeOrder[b.type] === undefined ? 5 : typeOrder[b.type];
      if (ta !== tb) return ta - tb;
      return b.weight - a.weight;
    });
    return arr.slice(0, opts.limit || 9);
  };

  // 查找 code 精确匹配的词语
  ImeEngine.prototype._lookupWords = function (code, cb) {
    const arr = this._zh.words[code];
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) cb(arr[i][0], arr[i][1]);
  };

  // 二分查找所有以 prefix 开头的 code（返回 code 数组）
  ImeEngine.prototype._codesWithPrefix = function (prefix) {
    const codes = this._zh.codes;
    if (!codes || !codes.length) return [];
    let lo = 0, hi = codes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (codes[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < codes.length; i++) {
      if (!codes[i].startsWith(prefix)) break;
      if (out.length >= 30) break;
      out.push(codes[i]);
    }
    return out;
  };

  ImeEngine.prototype._isSyllable = function (s) {
    return this._zh._syllSet ? this._zh._syllSet.has(s) : false;
  };

  // 根据音节对，返回单字候选（用于末位前缀展开）
  ImeEngine.prototype._singleForPrefix = function (partial, prev) {
    const out = [];
    const z = this._zh;
    for (let i = 0; i < z.syll.length; i++) {
      const s = z.syll[i];
      if (s.length <= partial.length || !s.startsWith(partial)) continue;
      const arr = z.chars[s];
      if (arr) {
        for (let j = 0; j < arr.length && j < 4; j++) {
          const w = arr[j][0];
          if (w.length === 1) out.push(arr[j]);
        }
      }
      if (out.length >= 20) break;
    }
    return out;
  };

  // 由音节数组组合出"每音节首字"的词（取各音节权重最高的单字）
  ImeEngine.prototype._comboWord = function (seg) {
    const parts = [];
    let total = 0;
    for (let i = 0; i < seg.length; i++) {
      const s = seg[i];
      if (!this._isSyllable(s)) return null;
      const arr = this._zh.chars[s];
      if (!arr || !arr.length) return null;
      parts.push(arr[0][0]);
      total += arr[0][1];
    }
    return { word: parts.join(''), weight: total };
  };

  // 把输入切分成音节序列；末位可为不完整音节（前缀）。
  // 返回数组的数组，如 'nihao' -> [['ni','hao'], ['ni','ha','o']]（截断至 max）
  ImeEngine.prototype._segment = function (q) {
    const z = this._zh;
    const results = [];
    const maxResults = 24;

    const dfs = (pos, acc) => {
      if (results.length >= maxResults) return;
      if (pos >= q.length) {
        if (acc.length) results.push(acc.slice());
        return;
      }
      for (let li = 0; li < SYLLABLE_LENGTHS.length; li++) {
        const len = SYLLABLE_LENGTHS[li];
        if (pos + len > q.length) continue;
        const s = q.slice(pos, pos + len);
        if (z._syllSet.has(s)) {
          acc.push(s);
          dfs(pos + len, acc);
          acc.pop();
        }
      }
      // 剩余部分作为末位前缀（仅当余下不足完整音节时，或不匹配任何音节时）
      if (pos > 0 || results.length === 0) {
        const rest = q.slice(pos);
        if (rest.length > 0 && !this._startsWithAnySyllable(rest)) {
          results.push(acc.concat(rest));
        }
      }
    };

    dfs(0, []);
    if (!results.length && q.length > 0) results.push([q]); // 兜底：整体视为一个前缀
    return results;
  };

  ImeEngine.prototype._startsWithAnySyllable = function (s) {
    const z = this._zh;
    for (let li = 0; li < SYLLABLE_LENGTHS.length; li++) {
      const len = SYLLABLE_LENGTHS[li];
      if (len <= s.length && z._syllSet.has(s.slice(0, len))) return true;
    }
    return false;
  };

  global.ImeEngine = ImeEngine;
  global.ImeEngineInstance = global.ImeEngineInstance || new ImeEngine();
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window.ImeEngine : globalThis.ImeEngine);
}
