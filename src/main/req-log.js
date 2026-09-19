/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 请求日志工具：统一时间戳 / URL 脱敏 / 文本摘要 / 请求体概览。
 * 供 LLM（llm-retry）、生图（main.js image:generate）、决策模型（decision-service）复用。
 */

'use strict';

function pad(n) {
  return String(n).padStart(2, '0');
}

/** HH:MM:SS */
function ts() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 隐藏 URL query 中的密钥类参数，避免日志泄漏 */
function maskUrl(u) {
  try {
    const url = new URL(String(u));
    for (const k of ['key', 'api_key', 'api-key', 'access_token', 'token', 'apikey']) {
      if (url.searchParams.has(k)) url.searchParams.set(k, '***');
    }
    return url.toString();
  } catch (_) {
    return String(u || '').slice(0, 300);
  }
}

/** 单行摘要（去换行、截断） */
function snippet(text, max = 80) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 最近一条 user 消息摘要（兼容字符串/多模态数组） */
function lastUserSnippet(messages, max = 80) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return snippet(c, max);
    if (Array.isArray(c)) {
      const text = c.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join(' ');
      return snippet(text, max);
    }
  }
  return '';
}

/** 请求体概览：消息数 / 工具数 / 是否流式 / 输出上限 */
function bodyMeta(body) {
  const b = body || {};
  const inputCount = Array.isArray(b.input) ? b.input.length : (typeof b.input === 'string' ? 1 : 0);
  return {
    msgs: Array.isArray(b.messages) ? b.messages.length : inputCount,
    tools: Array.isArray(b.tools) ? b.tools.length : 0,
    stream: !!b.stream,
    max: b.max_tokens ?? b.max_output_tokens ?? b.max_completion_tokens ?? null,
  };
}

/** 生图响应/错误摘要 */
function errSnippet(err, max = 300) {
  if (!err) return '';
  if (typeof err === 'string') return snippet(err, max);
  try { return snippet(JSON.stringify(err), max); } catch (_) { return String(err).slice(0, max); }
}

module.exports = { ts, maskUrl, snippet, lastUserSnippet, bodyMeta, errSnippet };
