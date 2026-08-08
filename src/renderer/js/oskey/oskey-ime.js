/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 * This file is part of Could I Be Your Partner.
 *
 * IME 管理器：维护拼音输入缓冲区，协调 ImeEngine 与 OSK 候选条，
 * 并负责向聚焦控件提交文本（中/英/德 模式切换）。
 */
(function (global) {
  'use strict';

  const zhCase = (s) => String(s || '');

  // 德语变音符大写映射（ß 用正式大写 ẞ）
  const DE_UPPER = { 'ä': 'Ä', 'ö': 'Ö', 'ü': 'Ü', 'ß': 'ẞ' };

  function OskIme() {
    this.mode = 'zh';          // 'zh' | 'en' | 'de'
    this.shift = false;
    this.buffer = '';          // 拼音输入缓冲区（小写）
    this.candidates = [];
    this.selected = 0;
    this.onChange = null;      // (state) => void
    this.maxCandidates = 9;
  }

  /* ---------- 状态 ---------- */

  OskIme.prototype.getState = function () {
    // zh 模式下 v 仅代表 ü（拼音 ü），展示时显示 ü，内部仍以 v 存 buffer 供引擎匹配
    let buffer = this.buffer;
    if (this.mode === 'zh' && buffer) buffer = buffer.replace(/v/g, 'ü');
    return {
      mode: this.mode,
      buffer: buffer,
      candidates: this.candidates,
      selected: this.selected,
    };
  };

  OskIme.prototype._emit = function () {
    if (this.onChange) this.onChange(this.getState());
  };

  OskIme.prototype.reset = function () {
    this.buffer = '';
    this.candidates = [];
    this.selected = 0;
    this._emit();
  };

  OskIme.prototype.clearBuffer = function () {
    this.reset();
  };

  OskIme.prototype.setMode = function (mode) {
    if (mode !== 'zh' && mode !== 'en' && mode !== 'de') mode = 'zh';
    this.mode = mode;
    this.reset();
  };

  OskIme.prototype.setMaxCandidates = function (n) {
    this.maxCandidates = Math.max(3, Math.min(15, n || 9));
  };

  /* ---------- 字母输入 ---------- */

  // 处理一个按键（letter: 单字符）。返回 true 表示已消费（进入拼音缓冲）。
  OskIme.prototype.typeLetter = function (letter) {
    letter = String(letter || '');
    if (!/^[a-zA-Z]$/.test(letter) && letter !== 'ü') return false;

    if (this.mode === 'zh') {
      // v 当 ü：接受 ü 键并统一存为 v，以便引擎按 lv/nv/lve/nve 匹配
      let c = letter.toLowerCase();
      if (c === 'Ü') c = 'ü';
      if (c === 'ü') c = 'v';
      if (!/^[a-z]$/.test(c)) return false;
      this.buffer += c;
      this._refreshZh();
      return true;
    }
    return false; // en/de 模式：直接输出字母
  };

  // 返回在 en/de 模式下应插入的字符（大小写规则，含德语变符）
  OskIme.prototype.letterForInsert = function (letter) {
    const s = String(letter || '');
    if (s.length !== 1) return s;
    if (this.shift) return DE_UPPER[s] || s.toUpperCase();
    return s.toLowerCase();
  };

  OskIme.prototype._refreshZh = function () {
    if (this.mode !== 'zh') return;
    const engine = global.ImeEngineInstance;
    this.candidates = engine && engine.hasZh()
      ? engine.getCandidates(this.buffer, { limit: this.maxCandidates })
      : [];
    this.selected = 0;
    this._emit();
  };

  // en/de 模式：根据当前输入前缀刷新预测候选
  OskIme.prototype._refreshLatin = function () {
    if (this.mode === 'zh') return;
    const preds = this.predict(this.buffer);
    this.candidates = preds.map((w) => ({ word: w, weight: 0, type: 'predict', code: this.buffer }));
    this.selected = 0;
    this._emit();
  };

  // 供 OSK 同步 en/de 当前单词前缀并更新预测
  OskIme.prototype.setLatinBuffer = function (prefix) {
    if (this.mode === 'zh') return;
    this.buffer = String(prefix || '');
    this._refreshLatin();
  };

  /* ---------- 退格 ---------- */

  // 返回 null（无缓冲）或已删后的状态；有缓冲时始终删除一个字符
  OskIme.prototype.backspace = function () {
    if (!this.buffer) return null;
    this.buffer = this.buffer.slice(0, -1);
    if (this.mode === 'zh') this._refreshZh();
    else this._refreshLatin();
    return null;
  };

  // 完全退格：清空缓冲区
  OskIme.prototype.clearInput = function () {
    this.reset();
  };

  /* ---------- 上屏 ---------- */

  OskIme.prototype.commitSelected = function (idx) {
    if (this.mode !== 'zh') return null;
    const i = idx === undefined ? this.selected : idx;
    const cand = this.candidates[i];
    if (!cand) return null;
    this.reset();
    return cand.word;
  };

  OskIme.prototype.select = function (idx) {
    if (this.mode !== 'zh') return;
    if (idx >= 0 && idx < this.candidates.length) {
      this.selected = idx;
      this._emit();
    }
  };

  OskIme.prototype.cycleNext = function () {
    if (this.mode !== 'zh' || !this.candidates.length) return;
    this.selected = (this.selected + 1) % this.candidates.length;
    this._emit();
  };

  OskIme.prototype.cyclePrev = function () {
    if (this.mode !== 'zh' || !this.candidates.length) return;
    this.selected = (this.selected - 1 + this.candidates.length) % this.candidates.length;
    this._emit();
  };

  OskIme.prototype.commitBuffer = function () {
    if (this.mode !== 'zh' || !this.buffer) return '';
    const raw = this.buffer;
    this.reset();
    return raw; // 拼音不匹配时直接上屏原字母
  };

  /* ---------- 英文/德文预测补全 ---------- */

  OskIme.prototype.predict = function (prefix) {
    if (this.mode === 'en') return global.ImeEngineInstance.predictEn(prefix, this.maxCandidates);
    if (this.mode === 'de') return global.ImeEngineInstance.predictDe(prefix, this.maxCandidates);
    return [];
  };

  global.OskIme = OskIme;
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window.OskIme : globalThis.OskIme);
}
