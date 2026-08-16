/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

(function (root) {
  'use strict';

  /**
   * 截断消息序列到第 n 条用户消息（含）。
   * @param {Array} messages 消息数组
   * @param {number} n 目标用户消息序号（1 起）；<=0 表示不截断
   * @returns {{ truncated: Array, lastUserText: string, userCount: number }}
   */
  function truncateToUserMessage(messages, n) {
    const arr = Array.isArray(messages) ? messages : [];
    const target = Math.max(0, Math.floor(Number(n) || 0));
    let count = 0;
    let cutAt = arr.length;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].role === 'user') {
        count++;
        if (target > 0 && count === target) { cutAt = i + 1; break; }
      }
    }
    const truncated = target > 0 ? arr.slice(0, cutAt) : arr.slice();
    let lastUserText = '';
    for (let i = truncated.length - 1; i >= 0; i--) {
      const m = truncated[i];
      if (m && m.role === 'user') {
        lastUserText = typeof m.content === 'string' ? m.content : '';
        break;
      }
    }
    return { truncated, lastUserText, userCount: count };
  }

  /** 提取最后一条用户消息的纯文本（字符串 content），无则返回空串 */
  function extractLastUserText(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user') {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
        }
        return '';
      }
    }
    return '';
  }

  const api = { truncateToUserMessage, extractLastUserText };
  root.CIBYPForkUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
