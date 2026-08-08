/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 * This file is part of Could I Be Your Partner.
 *
 * 屏幕软键盘核心：悬浮键盘 + 候选条 + 焦点追踪 + 文本注入。
 * - 自动识别聚焦的 input/textarea/contenteditable
 * - 中文（雾凇拼音词库）/ 英文 / 德文 输入模式
 * - 通过 window.api 与设置页、WebUI 同步
 */
(function (global) {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: false,
    mode: 'zh',           // 默认输入模式 zh / en / de
    candidateCount: 9,
    opacity: 1,           // 键盘整体透明度 0.2-1（默认不透明）
  };

  const LAYOUTS = {
    zh: [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
      ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
    ],
    en: [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
      ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
    ],
    de: [
      ['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö'],
      ['y', 'x', 'c', 'v', 'b', 'n', 'm', 'ä', 'ü', 'ß'],
    ],
  };

  // 大写映射（德语变音符；ß 用正式大写 ẞ）
  const DE_UPPER = { 'ä': 'Ä', 'ö': 'Ö', 'ü': 'Ü', 'ß': 'ẞ' };
  const upperKey = (s) => (s.length === 1 ? (DE_UPPER[s] || s.toUpperCase()) : s);

  // 数字 / 符号键盘
  const NUM_LAYOUT = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '/', ':', ';', '(', ')', '€', '&', '@', '"'],
    ['.', ',', '?', '!', "'", '¿', '¡', '#'],
  ];
  const SYM_LAYOUT = [
    ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='],
    ['_', '\\', '|', '~', '<', '>', '€', '£', '¥', '·'],
    ['.', ',', '?', '!', "'", '"', '(', ')'],
  ];

  function OskCore() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.ime = new global.OskIme();
    this.visible = false;
    this.dictLoaded = false;
    this._focused = null;
    this._root = null;
    this._candBar = null;
    this._keyboard = null;
    this._modeBtn = null;
    this._dictPromise = null;
    this._stateAttr = {};
    this._numPad = false;         // 数字/符号键盘是否显示
    this._symPad = false;         // 数字键盘内二级符号页

    this.ime.onChange = (state) => this._onImeChange(state);
  }

  /* ---------- 初始化 ---------- */

  OskCore.prototype.init = async function () {
    if (this._root) return;
    this._buildDom();
    this._bindFocusTracking();
    window.addEventListener('languagechange', () => this._refreshI18n());
    await this._loadSettings();
    this._restoreGeometry();
    if (this.settings.enabled) {
      this._ensureDict().catch(() => {});
      this.show();
    }
  };

  OskCore.prototype._loadSettings = async function () {
    try {
      if (global.window?.api?.getSettings) {
        const s = await global.window.api.getSettings();
        if (s && s.ime) this.settings = Object.assign({}, DEFAULT_SETTINGS, s.ime);
      }
    } catch (_) { /* 忽略：子页面可能无 getSettings */ }
    this.ime.setMaxCandidates(this.settings.candidateCount);
    this.ime.setMode(this.settings.mode);
    this._applyStyleSettings();
  };

  // 应用透明度 / 高斯模糊到键盘面板
  OskCore.prototype._applyStyleSettings = function () {
    if (!this._root) return;
    this._root.style.setProperty('--oskey-opacity',
      String(Math.max(0.2, Math.min(1, parseFloat(this.settings.opacity) || 1))));
  };

  /* ---------- 字典加载（懒加载 assets/ime/*.js） ---------- */

  OskCore.prototype._ensureDict = function () {
    if (this.dictLoaded) return Promise.resolve(true);
    if (this._dictPromise) return this._dictPromise;

    const files = [
      ['../../../assets/ime/ime-dict-zh.js', 'ImeZhDict', (d) => global.ImeEngineInstance.initZh(d)],
      ['../../../assets/ime/ime-dict-en.js', 'ImeEnWords', (d) => global.ImeEngineInstance.initEn(d)],
      ['../../../assets/ime/ime-dict-de.js', 'ImeDeWords', (d) => global.ImeEngineInstance.initDe(d)],
    ];
    const loadOne = (src) => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error('dict load failed: ' + src));
      document.head.appendChild(script);
    });

    this._dictPromise = Promise.all(files.map((f) => loadOne(f[0])))
      .then(() => {
        for (const [, varName, init] of files) {
          const data = global[varName];
          if (data) init(data);
        }
        this.dictLoaded = !!global.ImeZhDict;
        this._dictPromise = null;
        return this.dictLoaded;
      })
      .catch((err) => { this._dictPromise = null; throw err; });
    return this._dictPromise;
  };

  /* ---------- DOM 构建 ---------- */

  OskCore.prototype._buildDom = function () {
    const cssId = 'oskey-css';
    if (!document.getElementById(cssId)) {
      const link = document.createElement('link');
      link.id = cssId;
      link.rel = 'stylesheet';
      link.href = '../css/oskey.css';
      document.head.appendChild(link);
    }

    const root = document.createElement('div');
    root.id = 'oskey';
    root.className = 'oskey hidden';
    root.innerHTML =
      '<div class="oskey-titlebar" id="oskey-titlebar">' +
        '<span class="oskey-title">' + this._L('oskey.title', '屏幕软键盘') + '</span>' +
        '<div class="oskey-func-group">' +
          '<button type="button" class="oskey-func" data-act="mode" id="oskey-mode">中</button>' +
          '<button type="button" class="oskey-func" data-act="backspace" id="oskey-backspace" title="' + this._L('oskey.backspace', '退格') + '"><i class="fa-solid fa-delete-left"></i></button>' +
          '<button type="button" class="oskey-func" data-act="clear" title="' + this._L('oskey.clear', '清空') + '"><i class="fa-solid fa-eraser"></i></button>' +
          '<button type="button" class="oskey-func" data-act="close" title="' + this._L('oskey.close', '关闭') + '"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="oskey-candidate-bar" id="oskey-candidates">' +
        '<div class="oskey-buffer" id="oskey-buffer"></div>' +
        '<div class="oskey-cand-list" id="oskey-cand-list"></div>' +
      '</div>' +
      '<div class="oskey-keyboard">' +
        '<div class="oskey-rows" id="oskey-rows"></div>' +
        '<div class="oskey-nav-row">' +
          '<button type="button" class="oskey-key oskey-key-pad" data-act="numpad" id="oskey-numpad">?123</button>' +
          '<button type="button" class="oskey-key oskey-key-shift" data-act="shift" id="oskey-shift"><i class="fa-solid fa-arrow-up"></i></button>' +
          '<button type="button" class="oskey-key oskey-key-space" data-act="space" id="oskey-space">' + this._L('oskey.space', '空格') + '</button>' +
          '<button type="button" class="oskey-key oskey-key-enter" data-act="enter" title="' + this._L('oskey.enter', '换行/发送') + '"><i class="fa-solid fa-arrow-turn-down"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="oskey-resize-handle" id="oskey-resize-handle" title="' + this._L('oskey.resize', '拖拽调整大小') + '"></div>';
    document.body.appendChild(root);

    this._root = root;
    this._candBar = root.querySelector('#oskey-candidates');
    this._keyboard = root.querySelector('#oskey-rows');
    this._modeBtn = root.querySelector('#oskey-mode');

    this._buildLayout();
    this._bindDragResize();
    this._applyStyleSettings();

    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.getAttribute('data-act');
      const letter = el.getAttribute('data-key');
      this._handleAction(act, letter);
    });

    // 候选条点击
    this._candBar.addEventListener('pointerdown', (e) => {
      const item = e.target.closest('.oskey-cand-item');
      if (item) {
        e.preventDefault();
        const idx = parseInt(item.getAttribute('data-idx'), 10);
        this._commitCandidate(idx);
      }
    });
  };

  /* ---------- 国际化 ---------- */

  // 有 t()（i18n.js）时翻译，否则用中文回退文本
  OskCore.prototype._L = function (key, fallback) {
    return (typeof t === 'function') ? t(key, fallback) : fallback;
  };

  // 语言切换后刷新软键盘可翻译文案
  OskCore.prototype._refreshI18n = function () {
    if (!this._root) return;
    const title = this._root.querySelector('.oskey-title');
    if (title) title.textContent = this._L('oskey.title', '屏幕软键盘');
    const space = this._root.querySelector('#oskey-space');
    if (space) space.textContent = this._L('oskey.space', '空格');
    const bs = this._root.querySelector('[data-act="backspace"]');
    if (bs) bs.setAttribute('title', this._L('oskey.backspace', '退格'));
    const clear = this._root.querySelector('[data-act="clear"]');
    if (clear) clear.setAttribute('title', this._L('oskey.clear', '清空'));
    const close = this._root.querySelector('[data-act="close"]');
    if (close) close.setAttribute('title', this._L('oskey.close', '关闭'));
    const enter = this._root.querySelector('[data-act="enter"]');
    if (enter) enter.setAttribute('title', this._L('oskey.enter', '换行/发送'));
    const handle = this._root.querySelector('#oskey-resize-handle');
    if (handle) handle.setAttribute('title', this._L('oskey.resize', '拖拽调整大小'));
  };

  /* ---------- 拖拽移动 / 缩放 ---------- */

  OskCore.prototype._bindDragResize = function () {
    const root = this._root;
    if (!root) return;

    // 标题栏拖拽移动
    const titlebar = root.querySelector('#oskey-titlebar');
    if (titlebar) {
      titlebar.addEventListener('pointerdown', (e) => {
        if (e.target.closest('[data-act]')) return; // 不拦截按钮
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const rect = root.getBoundingClientRect();
        const startLeft = rect.left, startTop = rect.top;
        const onMove = (ev) => {
          const nl = startLeft + (ev.clientX - startX);
          const nt = startTop + (ev.clientY - startY);
          const maxL = Math.max(0, window.innerWidth - root.offsetWidth);
          const maxT = Math.max(0, window.innerHeight - root.offsetHeight);
          root.style.left = Math.max(0, Math.min(nl, maxL)) + 'px';
          root.style.top = Math.max(0, Math.min(nt, maxT)) + 'px';
          root.style.right = 'auto';
          root.style.bottom = 'auto';
        };
        const onUp = () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          this._saveGeometry();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    }

    // 右下角手柄缩放
    const handle = root.querySelector('#oskey-resize-handle');
    if (handle) {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const rect = root.getBoundingClientRect();
        const startW = rect.width, startH = rect.height;
        const onMove = (ev) => {
          const nw = Math.max(300, startW + (ev.clientX - startX));
          const nh = Math.max(220, startH + (ev.clientY - startY));
          root.style.width = Math.min(nw, window.innerWidth - rect.left - 8) + 'px';
          root.style.height = Math.min(nh, window.innerHeight - rect.top - 8) + 'px';
        };
        const onUp = () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          this._saveGeometry();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    }
  };

  // 位置/大小持久化（localStorage，跨页面生效；有 setSettings 时同步设置）
  OskCore.prototype._saveGeometry = function () {
    const root = this._root;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const geom = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    try {
      localStorage.setItem('oskey-geom', JSON.stringify(geom));
    } catch (_) {}
    try {
      if (global.window?.api?.setSettings) {
        global.window.api.setSettings({ ime: Object.assign({}, this.settings, { geom }) });
      }
    } catch (_) {}
  };

  OskCore.prototype._restoreGeometry = function () {
    let geom = null;
    try {
      const raw = localStorage.getItem('oskey-geom');
      if (raw) geom = JSON.parse(raw);
    } catch (_) {}
    if (!geom && this.settings.geom) geom = this.settings.geom;
    if (!geom) return;
    const root = this._root;
    if (!root) return;
    const w = Math.max(300, Math.min(geom.w || 560, window.innerWidth - 16));
    const h = Math.max(220, Math.min(geom.h || 300, window.innerHeight - 16));
    root.style.width = w + 'px';
    root.style.height = h + 'px';
    if (typeof geom.x === 'number') {
      const maxL = Math.max(0, window.innerWidth - root.offsetWidth);
      root.style.left = Math.max(0, Math.min(geom.x, maxL)) + 'px';
      root.style.right = 'auto';
    }
    if (typeof geom.y === 'number') {
      const maxT = Math.max(0, window.innerHeight - root.offsetHeight);
      root.style.top = Math.max(0, Math.min(geom.y, maxT)) + 'px';
      root.style.bottom = 'auto';
    }
  };

  OskCore.prototype._buildLayout = function () {
    if (!this._keyboard) return;
    const rows = this._currentRows();
    const showShifted = this.ime.shift && !this._numPad;
    let html = '';
    for (const row of rows) {
      html += '<div class="oskey-row">';
      for (const k of row) {
        const key = String(k);
        const isDigit = this._numPad ? /^[0-9]$/.test(key) : false;
        const act = isDigit ? 'digit' : 'letter';
        const label = (this.ime.mode !== 'zh' && showShifted && /^[A-Za-z\u00C0-\u024F]$/.test(key)) ? upperKey(key) : key;
        const safeKey = key.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const safeLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        html += `<button type="button" class="oskey-key" data-key="${safeKey}" data-act="${act}">${safeLabel}</button>`;
      }
      html += '</div>';
    }
    this._keyboard.innerHTML = html;
    this._refreshModeBtn();
    this._refreshPadBtn();
  };

  // 依据当前状态返回按键行
  OskCore.prototype._currentRows = function () {
    if (this._numPad) return this._symPad ? SYM_LAYOUT : NUM_LAYOUT;
    return LAYOUTS[this.ime.mode] || LAYOUTS.zh;
  };

  // 数字/符号键盘切换：字母 → 数字 → 符号 → 字母
  OskCore.prototype._toggleNumPad = function () {
    if (!this._numPad) {
      this._numPad = true;
      this._symPad = false;
    } else if (!this._symPad) {
      this._symPad = true;
    } else {
      this._numPad = false;
      this._symPad = false;
    }
    this._buildLayout();
    this._renderIme();
  };

  OskCore.prototype._refreshPadBtn = function () {
    const btn = this._root && this._root.querySelector('#oskey-numpad');
    if (!btn) return;
    if (!this._numPad) {
      btn.textContent = '?123';
    } else if (this._symPad) {
      btn.textContent = 'abc';
    } else {
      btn.textContent = '#+=';
    }
  };

  OskCore.prototype._refreshModeBtn = function () {
    if (!this._modeBtn) return;
    const m = this.ime.mode;
    this._modeBtn.textContent = m === 'zh' ? '中' : (m === 'en' ? 'EN' : 'DE');
    this._modeBtn.setAttribute('data-mode', m);
  };

  /* ---------- 焦点追踪 ---------- */

  OskCore.prototype._isEditable = function (el) {
    if (!el || !el.isConnected) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      return !['button', 'checkbox', 'radio', 'file', 'submit', 'range', 'color', 'hidden'].includes(t);
    }
    if (el.isContentEditable) return true;
    return false;
  };

  OskCore.prototype._bindFocusTracking = function () {
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (this._isEditable(t)) {
        this._focused = t;
      }
    });
    document.addEventListener('focusout', (e) => {
      const t = e.target;
      if (t === this._focused) {
        // 若焦点转移到 OSK 内部，不解除
        if (e.relatedTarget && this._root && this._root.contains(e.relatedTarget)) return;
        this._focused = null;
      }
    });
  };

  OskCore.prototype._focusedEl = function () {
    const el = this._focused;
    if (el && el.isConnected && this._isEditable(el)) return el;
    const active = document.activeElement;
    if (active && this._isEditable(active)) return active;
    return null;
  };

  /* ---------- 文本注入 ---------- */

  OskCore.prototype._insertText = function (text) {
    const el = this._focusedEl();
    if (!el) return;
    if (el.isContentEditable) {
      document.execCommand('insertText', false, text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const pos = start + text.length;
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  /* ---------- 动作处理 ---------- */

  OskCore.prototype._handleAction = function (act, letter) {
    switch (act) {
      case 'letter':
        this._onLetter(letter);
        break;
      case 'mode':
        this._cycleMode();
        break;
      case 'backspace':
        this._onBackspace();
        break;
      case 'clear':
        this.ime.clearInput();
        this._renderIme();
        break;
      case 'close':
        this.hide();
        break;
      case 'shift':
        this.ime.shift = !this.ime.shift;
        this._buildLayout();
        this._refreshShiftBtn();
        break;
      case 'space':
        this._onSpace();
        break;
      case 'enter':
        this._onEnter();
        break;
      case 'numpad':
        this._toggleNumPad();
        break;
      case 'digit':
        this._onDigit(letter);
        break;
    }
  };

  // 数字键：模式缓冲非空时选中候选词；其余直接输出
  OskCore.prototype._onDigit = function (digit) {
    if (this.ime.buffer) {
      const n = parseInt(digit, 10);
      if (n >= 1 && n <= this.ime.candidates.length) {
        this._commitCandidate(n - 1);
        return;
      }
    }
    this._insertText(digit);
  };

  OskCore.prototype._onLetter = function (letter) {
    if (!this._focusedEl()) return;
    if (this.ime.mode === 'zh') {
      if (this.ime.typeLetter(letter)) {
        this._renderIme();
        return;
      }
    } else {
      // en/de：直接输出字母，并根据光标前单词更新预测
      this._insertText(this.ime.letterForInsert(letter));
      this._syncLatinBuffer();
      return;
    }
    this._insertText(this.ime.letterForInsert(letter));
  };

  OskCore.prototype._onBackspace = function () {
    if (this.ime.buffer && this.ime.mode === 'zh') {
      this.ime.backspace();
      this._renderIme();
      return;
    }
    this._insertDelete();
    if (this.ime.mode !== 'zh') this._syncLatinBuffer();
  };

  OskCore.prototype._insertDelete = function () {
    const el = this._focusedEl();
    if (!el) return;
    if (el.isContentEditable) {
      document.execCommand('delete');
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (start === end) {
      if (start <= 0) return;
      el.value = el.value.slice(0, start - 1) + el.value.slice(end);
      const pos = Math.max(0, start - 1);
      el.setSelectionRange(pos, pos);
    } else {
      el.value = el.value.slice(0, start) + el.value.slice(end);
      el.setSelectionRange(start, start);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  OskCore.prototype._onSpace = function () {
if (this.ime.buffer) {
      if (this.ime.mode === 'zh') {
        this._commitCandidate(this.ime.selected);
      } else {
        // en/de：有单词前缀时上屏当前（或选中）词并补空格
        this._commitLatin(this.ime.selected, ' ');
      }
      return;
    }
    this._insertText(' ');
  };

  OskCore.prototype._onEnter = function () {
    if (this.ime.buffer && this.ime.mode === 'zh' && this.ime.candidates.length) {
      this._commitCandidate(0);
      return;
    }
    if (this.ime.buffer && this.ime.mode !== 'zh') {
      if (this.ime.candidates.length) this._commitCandidate(this.ime.selected);
      else this._commitLatin(this.ime.selected, ' ');
    }
    const el = this._focusedEl();
    if (!el) return;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') {
      this._insertText('\n');
    } else {
      const form = el.closest('form');
      if (form) form.requestSubmit?.();
    }
  };

  OskCore.prototype._cycleMode = function () {
    const order = ['zh', 'en', 'de'];
    const next = order[(order.indexOf(this.ime.mode) + 1) % order.length];
    this._numPad = false;
    this._symPad = false;
    this.ime.shift = false;
    this.ime.setMode(next);
    this._buildLayout();
    this._refreshShiftBtn();
    this._renderIme();
  };

  OskCore.prototype._refreshShiftBtn = function () {
    const btn = this._root.querySelector('#oskey-shift');
    if (btn) btn.classList.toggle('active', this.ime.shift);
  };

  /* ---------- 候选上屏 ---------- */

  OskCore.prototype._commitCandidate = function (idx) {
    if (this.ime.mode !== 'zh') {
      this._commitLatin(idx);
      return;
    }
    const word = this.ime.commitSelected(idx);
    if (word !== null && word !== undefined) {
      this._insertText(word);
    } else if (this.ime.mode === 'zh' && this.ime.buffer) {
      // 无候选时上屏拼音原文
      const raw = this.ime.commitBuffer();
      if (raw) this._insertText(raw);
    }
    this._renderIme();
  };

  // 英/德候选上屏：替换光标前的当前单词，然后重置缓冲
  OskCore.prototype._commitLatin = function (_idx, suffix) {
    const el = this._focusedEl();
    const cand = this.ime.candidates[_idx];
    if (el && !el.isContentEditable) {
      const text = el.value || '';
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? text.length;
      const m = text.slice(0, start).match(/[A-Za-z\u00C0-\u024F'\\-]*$/);
      const prefix = m ? m[0] : '';
      const word = cand ? cand.word : prefix;
      const wStart = start - prefix.length;
      const insert = word + (suffix || '');
      el.value = text.slice(0, wStart) + insert + text.slice(end);
      const pos = wStart + insert.length;
      el.setSelectionRange(pos, pos);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (cand) {
      this._insertText(cand.word + (suffix || ''));
    }
    // 对齐 zh：上屏后强制清空候选状态
    this.ime.reset();
    this._renderIme();
  };

  /* ---------- en/de 预测辅助 ---------- */

  // 光标前的当前英/德单词前缀（input/textarea）
  OskCore.prototype._latinPrefix = function () {
    const el = this._focusedEl();
    if (!el || el.isContentEditable) return '';
    const text = el.value || '';
    const start = el.selectionStart ?? text.length;
    const m = text.slice(0, start).match(/[A-Za-z\u00C0-\u024F'\\-]*$/);
    return m ? m[0] : '';
  };

  // 输入字母后同步当前单词前缀到 IME 缓冲
  OskCore.prototype._syncLatinBuffer = function () {
    if (this.ime.mode === 'zh') return;
    const prefix = this._latinPrefix();
    if (prefix !== this.ime.buffer) {
      this.ime.setLatinBuffer(prefix);
    }
  };

  /* ---------- 渲染 ---------- */

  OskCore.prototype._onImeChange = function (state) {
    this._renderIme(state);
    this._pushWebState();
  };

  OskCore.prototype._renderIme = function (state) {
    if (!this._root) return;
    state = state || this.ime.getState();
    const bufferEl = this._root.querySelector('#oskey-buffer');
    const listEl = this._root.querySelector('#oskey-cand-list');
    if (!bufferEl || !listEl) return;

    bufferEl.textContent = state.buffer;
    listEl.innerHTML = '';

    const cands = state.candidates || [];
    for (let i = 0; i < cands.length; i++) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'oskey-cand-item' + (i === state.selected ? ' selected' : '');
      item.setAttribute('data-idx', String(i));
      item.innerHTML = `<span class="oskey-cand-idx">${i + 1}</span><span class="oskey-cand-word">${cands[i].word}</span>`;
      listEl.appendChild(item);
    }

    // 候选条固定高度：无缓冲时清空内容，保持视觉统一
    const showCands = !!state.buffer;
    if (!showCands) {
      bufferEl.textContent = '';
      listEl.innerHTML = '';
    }
    this._refreshModeBtn();
  };

  /* ---------- 显隐 ---------- */

  OskCore.prototype.show = function () {
    if (!this._root) return;
    this._root.classList.remove('hidden');
    this.visible = true;
    this._pushWebState();
  };

  OskCore.prototype.hide = function () {
    if (!this._root) return;
    this._root.classList.add('hidden');
    this.visible = false;
    this.ime.reset();
    this._renderIme();
    this._pushWebState();
  };

  OskCore.prototype.toggle = function () {
    if (this.visible) this.hide();
    else this.show();
  };

  /* ---------- WebUI 同步 ---------- */

  OskCore.prototype._pushWebState = function () {
    try {
      if (global.window?.api?.webControlPushOskState) {
        global.window.api.webControlPushOskState({ visible: this.visible, mode: this.ime.mode });
      }
    } catch (_) {}
  };

  /* ---------- 设置同步 ---------- */

  OskCore.prototype.applySettings = function (imeSettings) {
    if (!imeSettings) return;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, imeSettings);
    this.ime.setMaxCandidates(this.settings.candidateCount);
    this.ime.setMode(this.settings.mode || 'zh');
    this._buildLayout();
    this._renderIme();
    this._applyStyleSettings();
    if (this.settings.enabled && !this.visible) this.show();
    if (!this.settings.enabled && this.visible) this.hide();
  };

  global.OskCore = OskCore;

  // 子页面（CAD/EDA/小游戏）通过 window.oskey 暴露的轻量接口
  global.OskGlobal = {
    toggle: () => {
      const osk = global.OskCoreInstance;
      if (!osk) return;
      if (osk.visible) osk.hide();
      else {
        osk._ensureDict().catch(() => {});
        osk.show();
      }
    },
    show: () => {
      const osk = global.OskCoreInstance;
      if (osk) { osk._ensureDict().catch(() => {}); osk.show(); }
    },
    hide: () => { global.OskCoreInstance && global.OskCoreInstance.hide(); },
    isVisible: () => !!(global.OskCoreInstance && global.OskCoreInstance.visible),
  };

  // 页面加载完成自动初始化（主窗口与子页面共用）
  function bootOsk() {
    if (global.OskCoreInstance) return;
    const osk = new OskCore();
    global.OskCoreInstance = osk;
    osk.init();
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootOsk);
    } else {
      bootOsk();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
