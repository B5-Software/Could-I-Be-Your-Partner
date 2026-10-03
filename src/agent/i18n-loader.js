/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 在 Node（无 DOM）里加载渲染层的 i18n 模块与语言包。
 *
 * src/renderer/js/i18n.js 与 i18n/{en,de}.js 是经典脚本：定义函数并挂到
 * window.*，语言包再调用 i18nRegister('en', DICT) 注册。这里用沙箱 + window 桩
 * 载入它们（加载期无 DOM 调用），把需要的函数暴露出来：
 *
 *   - Agent 内核：i18nToolReturn / i18nGetSystemPrompt 等是自由标识符，
 *     由 src/agent/index.js 挂到 globalThis 后自动生效
 *   - TUI 文案：t(key, fallback) —— 中文为源文（回退），en/de 走词典
 *
 * 于是"设置 → 语言"在无头/TUI 下与 GUI 完全一致。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const I18N_DIR = path.resolve(__dirname, '../renderer/js/i18n');
const CORE = path.resolve(__dirname, '../renderer/js/i18n.js');

/** 暴露给外部的 API（与 window.* 上的名字一致） */
const EXPORTS = [
  't',
  'i18nInit',
  'i18nSetLanguage',
  'i18nGetLanguage',
  'i18nRegister',
  'i18nGetSystemPrompt',
  'i18nGetToolDesc',
  'i18nGetToolSchemaDesc',
  'i18nGetCategory',
  'i18nToolReturn',
  'i18nApplyTextMap',
  'stripThinkingTags',
];

let cached = null;

function loadI18n() {
  if (cached) return cached;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // i18nSetLanguage 会写 document.documentElement.lang 并启动 MutationObserver；
    // 无 DOM 环境给最小桩，让语言切换逻辑完整跑通
    document: {
      documentElement: { lang: 'zh-CN', setAttribute() {}, style: {} },
      head: {},
      body: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    // i18nSetLanguage 会派发自定义事件；Node 19+ 自带这些构造器
    CustomEvent: globalThis.CustomEvent,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    navigator: { language: 'zh-CN' },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // i18nSetLanguage 通过 window.dispatchEvent 广播语言变更
  sandbox.dispatchEvent = () => true;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};

  const run = (file) => {
    const source = fs.readFileSync(file, 'utf8');
    vm.runInNewContext(source, sandbox, { filename: file });
  };

  run(CORE);
  // 语言包：en / de（zh-CN 是源文，不需要包）
  for (const name of ['en.js', 'de.js']) {
    const file = path.join(I18N_DIR, name);
    if (fs.existsSync(file)) {
      try {
        run(file);
      } catch (error) {
        console.warn('[i18n] 加载语言包失败:', name, error.message);
      }
    }
  }

  const api = {};
  for (const key of EXPORTS) {
    if (typeof sandbox[key] === 'function') api[key] = sandbox[key];
  }
  if (typeof api.t !== 'function') {
    // 兜底：永不因缺 i18n 而崩溃（保持中文源文）
    api.t = (key, fallback) => fallback;
    api.i18nSetLanguage = () => {};
    api.i18nGetLanguage = () => 'zh-CN';
  }
  cached = api;
  return api;
}

module.exports = { loadI18n, EXPORTS };
