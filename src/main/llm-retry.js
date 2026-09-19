/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * LLM API retry wrapper: exponential backoff + error classification +
 * timeout + Retry-After header + 529 model fallback + autoCompact circuit breaker hook.
 * Inspired by claude-code-ref/src/services/api/withRetry.ts and errors.ts.
 */

'use strict';

const { ts, maskUrl, lastUserSnippet, bodyMeta } = require('./req-log');

// ---- Constants ----
const DEFAULT_MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32000;
const MAX_529_RETRIES = 3;
const MAX_PAYMENT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 300000; // 5 min
const JITTER_RATIO = 0.25;

// 全局活跃请求控制器集合：停止按钮可一次性 abort 所有正在进行的 LLM 请求
const _activeControllers = new Set();

// Error kinds: 'rate_limit' | 'overloaded' | 'server' | 'payment' | 'timeout' | 'network' | 'auth' | 'client' | 'unknown'

class LLMError extends Error {
  constructor(message, { status, retryAfter, kind, headers } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.kind = kind;
    this.headers = headers;
  }
}

/**
 * Compute retry delay using exponential backoff with jitter.
 * Honors Retry-After header (in seconds) when present.
 */
function getRetryDelay(attempt, retryAfterHeader, maxDelayMs = MAX_DELAY_MS) {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      // Allow Retry-After to exceed maxDelay (server explicitly told us to wait).
      return Math.min(seconds * 1000, maxDelayMs * 8);
    }
  }
  const baseDelay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), maxDelayMs);
  const jitter = Math.random() * JITTER_RATIO * baseDelay;
  return baseDelay + jitter;
}

function classifyHttpResponse(resp) {
  const status = resp.status;
  const retryAfter = resp.headers.get('retry-after') || resp.headers.get('Retry-After');
  if (status === 429) return { kind: 'rate_limit', retryAfter, retry: true };
  if (status === 529) return { kind: 'overloaded', retryAfter, retry: true };
  if (status === 402) return { kind: 'payment', retryAfter, retry: true };
  if (status >= 500) return { kind: 'server', retryAfter, retry: true };
  if (status === 408 || status === 409 || status === 425) return { kind: 'timeout', retryAfter, retry: true };
  if (status === 401 || status === 403) return { kind: 'auth', retryAfter, retry: false };
  if (status >= 400) return { kind: 'client', retryAfter, retry: false };
  return { kind: 'ok', retryAfter, retry: false };
}

function classifyThrownError(err) {
  if (!err) return { kind: 'unknown', retry: false };
  const msg = String(err.message || err);
  const code = err.code;
  if (err.name === 'AbortError' || /timeout/i.test(msg)) return { kind: 'timeout', retry: true };
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENETUNREACH' ||
      code === 'EAI_AGAIN' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { kind: 'network', retry: true };
  }
  if (err.name === 'TypeError' && /fetch|network/i.test(msg)) return { kind: 'network', retry: true };
  if (/fetch failed|network|socket hang up|getaddrinfo/i.test(msg)) return { kind: 'network', retry: true };
  return { kind: 'unknown', retry: false };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    }
  });
}

/**
 * 当请求返回 404 时，说明用户配置的 API URL 路径可能不完整。
 * 基于原始 URL 生成候选端点列表（按常见 chat/completions 或 messages 路径补全）。
 * @param {string} originalUrl
 * @param {string} transport - 'openai' | 'anthropic'
 * @returns {string[]} 候选 URL 列表（含原始 URL，已去重）
 */
function buildEndpointCandidates(originalUrl, transport) {
  const seen = new Set();
  const out = [];
  const push = (u) => {
    if (!u) return;
    let norm;
    try { norm = new URL(u).href; } catch { norm = u; }
    if (!seen.has(norm)) { seen.add(norm); out.push(norm); }
  };
  push(originalUrl);
  let url;
  try { url = new URL(originalUrl); } catch { return out; }
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, '');
  const suffixes = transport === 'anthropic'
    ? ['/v1/messages', '/messages']
    : ['/v1/chat/completions', '/chat/completions'];
  // 直接在 origin 后拼接常见路径
  for (const s of suffixes) push(origin + s);
  // 用户可能填写了基础路径前缀（如 /api、/proxy），在其后补全；重复项由 seen 去重
  if (path && !suffixes.includes(path)) {
    for (const s of suffixes) push(origin + path + s);
  }
  return out;
}

/**
 * Perform a fetch to the LLM API with retry/backoff/timeout/fallback.
 * Returns { ok: true, response } on success — caller consumes response.json() or response.body.
 * Returns { ok: false, error, kind, status } on terminal failure.
 *
 * @param {object} cfg
 * @param {string} cfg.apiUrl
 * @param {string} cfg.apiKey
 * @param {object} cfg.body - request body (will be cloned per attempt; .model may be swapped)
 * @param {object} [cfg.options]
 * @param {number} [cfg.options.maxRetries]
 * @param {number} [cfg.options.timeoutMs]
 * @param {string|null} [cfg.options.fallbackModel] - model to switch to after MAX_529_RETRIES consecutive 529s
 * @param {string|null} [cfg.options.requestId]
 * @param {function} [cfg.onRetry] - callback({ attempt, status, kind, delayMs, requestId, error, reason })
 */
async function fetchLLMWithRetry(cfg) {
  const apiUrl = cfg.apiUrl;
  const apiKey = cfg.apiKey;
  // Optional custom headers from provider config (e.g. Anthropic uses x-api-key + anthropic-version).
  // When provided, these REPLACE the default Authorization header.
  const customHeaders = cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : null;
  // 推断传输协议（用于 404 端点探索时选择正确的路径后缀）
  const transport = cfg.transport ||
    (customHeaders && (customHeaders['x-api-key'] || customHeaders['anthropic-version']) ? 'anthropic' : 'openai');
  // 404 端点探索：用户可能配置了不完整的 API URL，预生成候选端点
  const endpointCandidates = buildEndpointCandidates(apiUrl, transport);
  let endpointIdx = 0;
  let currentEndpoint = endpointCandidates[0] || apiUrl;
  const opts = cfg.options || {};
  const maxRetries = (opts.maxRetries && opts.maxRetries > 0) ? opts.maxRetries : DEFAULT_MAX_RETRIES;
  // 0 / negative / non-number → fall back to default. Previously `??` accepted 0
  // and caused setTimeout(abort, 0) → "This operation was aborted" on every call.
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const fallbackModel = opts.fallbackModel || null;
  const requestId = opts.requestId || null;
  const onRetry = typeof cfg.onRetry === 'function' ? cfg.onRetry : () => {};
  const label = cfg.label || 'LLM';

  let lastError = null;
  let consecutive529 = 0;
  let consecutivePayment = 0;
  let currentModel = cfg.body.model;
  let usingFallback = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    controller._requestId = requestId || null;
    controller._sessionKey = opts.sessionKey || null;
    _activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    // 请求日志：所有 LLM 调用（chat/chatStream/summarize/子代理/游戏/DS 插件）都会经过这里
    if (attempt === 1) {
      const meta = bodyMeta(cfg.body);
      console.log(`[${label} ${ts()}] → POST ${maskUrl(currentEndpoint)} model=${currentModel} msgs=${meta.msgs} tools=${meta.tools} stream=${meta.stream} max=${meta.max == null ? '-' : meta.max} retries=${maxRetries} timeout=${Math.round(timeoutMs / 1000)}s msg="${lastUserSnippet(cfg.body?.messages)}"`);
    } else {
      console.log(`[${label} ${ts()}] ↻ attempt ${attempt}/${maxRetries} model=${currentModel} endpoint=${maskUrl(currentEndpoint)}`);
    }
    let success = false;
    try {
      const reqBody = { ...cfg.body, model: currentModel };
      const headers = customHeaders
        ? { ...customHeaders, 'Content-Type': 'application/json' }
        : { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const resp = await fetch(currentEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: controller.signal
      });
      clearTimeout(timer);
      const dur = Date.now() - startedAt;

      const cls = classifyHttpResponse(resp);

      if (!cls.retry) {
        if (resp.ok) {
          // 成功返回：controller 保留在 _activeControllers 中（流式响应仍在读取时需可被 abort）
          // 调用方读取完流后应调用 releaseController() 释放
          success = true;
          console.log(`[${label} ${ts()}] ← ${resp.status} (${dur}ms) model=${currentModel} type=${String(resp.headers.get('content-type') || '').split(';')[0] || 'json'}`);
          return {
            ok: true,
            response: augmentSSEResponse(resp, transport),
            controller,
            releaseController: () => _activeControllers.delete(controller)
          };
        }
        // 404 端点探索：用户可能配置了不完整的 API URL，依次尝试候选端点
        if (resp.status === 404 && endpointIdx + 1 < endpointCandidates.length) {
          endpointIdx++;
          currentEndpoint = endpointCandidates[endpointIdx];
          // 消费响应体避免连接泄漏
          try { await resp.text(); } catch { /* ignore */ }
          onRetry({
            attempt, status: 404, kind: 'client', delayMs: 0, requestId,
            reason: '探索端点: ' + currentEndpoint
          });
          continue; // 尝试下一个候选端点
        }
        // Non-retryable client/auth error — read body for message.
        let errBody = null;
        try { errBody = await resp.json(); } catch { /* ignore */ }
        // 兼容多种 OpenAI-compat 错误格式，避免只显示 "HTTP 400"
        const errMsg = errBody?.error?.message || errBody?.message ||
          (typeof errBody?.error === 'string' ? errBody.error : null) ||
          (typeof errBody?.detail === 'string' ? errBody.detail : null) ||
          (Array.isArray(errBody?.detail) && errBody.detail[0]?.msg) ||
          errBody?.error?.code ||
          `HTTP ${resp.status}`;
        console.error(`[${label} ${ts()}] ✗ ${resp.status} (${dur}ms) model=${currentModel} kind=${cls.kind}: ${String(errMsg).slice(0, 300)}`);
        return {
          ok: false,
          error: errMsg,
          status: resp.status,
          kind: cls.kind
        };
      }

      // Retryable HTTP status.
      if (cls.kind === 'overloaded') {
        consecutive529++;
        // 已移除 529 自动降级模型：会话锁定后不自动切换（保护提示词缓存），仅退避重试
      } else if (cls.kind === 'payment') {
        // 402 计费不足：仅重试有限次数（用户可能中途充值/切换模型），超过上限则终止
        consecutivePayment++;
        if (consecutivePayment >= MAX_PAYMENT_RETRIES) {
          const errText = await resp.text().catch(() => '');
          lastError = new LLMError(
            `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
            { status: resp.status, retryAfter: cls.retryAfter, kind: cls.kind }
          );
          console.error(`[${label} ${ts()}] ✗ ${resp.status} (${dur}ms) model=${currentModel} kind=${cls.kind}（计费不足重试次数用尽）: ${lastError.message.slice(0, 200)}`);
          break;
        }
      } else {
        consecutive529 = 0;
        consecutivePayment = 0;
      }

      const errText = await resp.text().catch(() => '');
      lastError = new LLMError(
        `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        { status: resp.status, retryAfter: cls.retryAfter, kind: cls.kind }
      );
      const delay = getRetryDelay(attempt, cls.retryAfter);
      console.warn(`[${label} ${ts()}] ↻ ${resp.status} (${dur}ms) model=${currentModel} kind=${cls.kind} → ${Math.round(delay / 1000)}s 后重试（${attempt}/${maxRetries}）: ${String(errText).replace(/\s+/g, ' ').slice(0, 200)}`);
      onRetry({
        attempt, status: resp.status, kind: cls.kind, delayMs: delay,
        requestId, error: lastError.message
      });
      await sleep(delay, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      const dur = Date.now() - startedAt;
      // 用户主动停止（abortAllRequests 触发）— 不重试、不通知 UI 重试
      if (controller._userAborted) {
        lastError = new LLMError(err.message || String(err), { kind: 'aborted' });
        console.warn(`[${label} ${ts()}] ✗ 已取消 (${dur}ms) model=${currentModel}`);
        break;
      }
      const cls = classifyThrownError(err);
      if (!cls.retry || attempt >= maxRetries) {
        lastError = new LLMError(err.message || String(err), { kind: cls.kind });
        console.error(`[${label} ${ts()}] ✗ ${err.name || 'Error'} (${dur}ms) model=${currentModel} kind=${cls.kind}: ${err.message}`);
        break;
      }
      const delay = getRetryDelay(attempt, null);
      lastError = new LLMError(err.message || String(err), { kind: cls.kind });
      console.warn(`[${label} ${ts()}] ↻ ${err.name || 'Error'} (${dur}ms) model=${currentModel} kind=${cls.kind} → ${Math.round(delay / 1000)}s 后重试（${attempt}/${maxRetries}）: ${err.message}`);
      onRetry({
        attempt, kind: cls.kind, delayMs: delay, requestId, error: err.message
      });
      try {
        await sleep(delay);
      } catch {
        break; // aborted during sleep
      }
    } finally {
      // 成功返回路径保留 controller（流仍在读取，需可被 abort）；其他路径立即删除
      if (!success) _activeControllers.delete(controller);
    }
  }

  console.error(`[${label} ${ts()}] ✗ 最终失败 model=${currentModel} kind=${lastError?.kind || 'unknown'}: ${lastError?.message || 'unknown error after retries'}`);
  return {
    ok: false,
    error: lastError?.message || 'unknown error after retries',
    kind: lastError?.kind || 'unknown',
    status: lastError?.status
  };
}

/**
 * 处理 OpenAI Responses API 的单个 SSE 事件（纯函数，便于单测）。
 * state 结构：{ fullContent, fullReasoning, toolCalls, finishReason, usage, responsesToolBuffer, finalizedToolIds, onChunk?, requestId? }
 * 事件类型：response.output_text.delta / response.reasoning_summary_text.delta /
 *          response.function_call_arguments.delta(.done) / response.output_item.done / response.completed
 * @param {object} state - 聚合状态（会被就地修改）
 * @param {object} parsed - 已解析的 SSE 事件 JSON
 */
function processResponsesEvent(state, parsed) {
  const type = parsed && parsed.type;
  if (type === 'response.output_text.delta' && parsed.delta) {
    state.fullContent += parsed.delta;
    if (state.onChunk) state.onChunk({ content: parsed.delta, parsed, requestId: state.requestId });
  } else if (type === 'response.reasoning_summary_text.delta' && parsed.delta) {
    state.fullReasoning += parsed.delta;
    if (state.onChunk) state.onChunk({ reasoning: parsed.delta, parsed, requestId: state.requestId });
  } else if (type === 'response.function_call_arguments.delta') {
    const id = parsed.item_id;
    if (!state.responsesToolBuffer[id]) state.responsesToolBuffer[id] = { call_id: '', name: '', argsBuffer: '' };
    state.responsesToolBuffer[id].argsBuffer += parsed.delta || '';
  } else if (type === 'response.function_call_arguments.done') {
    const id = parsed.item_id;
    const entry = state.responsesToolBuffer[id] || (state.responsesToolBuffer[id] = { call_id: '', name: '', argsBuffer: '' });
    if (!entry.call_id) entry.call_id = parsed.call_id || '';
    if (!entry.name) entry.name = parsed.name || '';
    if (parsed.arguments) entry.argsBuffer = parsed.arguments;
    finalizeResponsesToolCall(state, id);
  } else if (type === 'response.output_item.done' && parsed.item && parsed.item.type === 'function_call') {
    const item = parsed.item;
    const id = item.id;
    const entry = state.responsesToolBuffer[id] || (state.responsesToolBuffer[id] = { call_id: '', name: '', argsBuffer: '' });
    if (!entry.call_id) entry.call_id = item.call_id || '';
    if (!entry.name) entry.name = item.name || '';
    // 部分实现直接带完整 arguments（无 delta 流），此时补全
    if (item.arguments && !state.finalizedToolIds.has(id)) {
      entry.argsBuffer = item.arguments;
      finalizeResponsesToolCall(state, id);
    }
  } else if (type === 'response.completed') {
    const resp = parsed.response || {};
    if (resp.status === 'incomplete') state.finishReason = 'length';
    else if (resp.status === 'failed') state.finishReason = 'error';
    else if (resp.status) state.finishReason = 'stop';
    const u = resp.usage || {};
    if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
      state.usage = {
        prompt_tokens: u.input_tokens || 0,
        completion_tokens: u.output_tokens || 0,
        total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
        // 透传缓存/推理明细，供 computeUsageCost 计费
        cache_read_input_tokens: u.input_tokens_details?.cached_tokens || 0,
        reasoning_output_tokens: u.output_tokens_details?.reasoning_tokens || 0
      };
    }
  }
}

function finalizeResponsesToolCall(state, id) {
  if (state.finalizedToolIds.has(id)) return;
  state.finalizedToolIds.add(id);
  const entry = state.responsesToolBuffer[id];
  if (!entry) return;
  state.toolCalls.push({
    id: entry.call_id || id,
    type: 'function',
    function: { name: entry.name || '', arguments: entry.argsBuffer || '{}' }
  });
  if (state.onChunk) state.onChunk({ toolCallDelta: state.toolCalls[state.toolCalls.length - 1], parsed: { type: 'function_call_done' }, requestId: state.requestId });
}

/**
 * Parse an SSE-streamed LLM response. Returns { content, reasoning, toolCalls, finishReason, usage }.
 * Supports both OpenAI-format (choices/delta) and Anthropic-format (content_block_delta) SSE.
 * @param {ReadableStream} bodyStream
 * @param {function} [onChunk] - callback({ content?, reasoning?, toolCallDelta?, parsed?, requestId })
 * @param {string|null} [requestId]
 * @param {string} [transport='openai'] - 'openai' or 'anthropic'
 * @param {number} [streamTimeoutMs=120000] - max idle time between chunks before aborting
 */
async function consumeSSEStream(bodyStream, onChunk, requestId, transport = 'openai', streamTimeoutMs = 120000, info = {}) {
  const _logStart = info && info.label ? Date.now() : 0;
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let fullReasoning = '';
  let toolCalls = [];
  let finishReason = null;
  let usage = null;
  let buffer = '';
  let anthropicToolBlocks = {};
  let responsesToolBuffer = {};
  let finalizedToolIds = new Set();

  async function readWithTimeout() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reader.cancel('stream-idle-timeout').catch(() => {});
        resolve({ done: true, value: undefined, timedOut: true });
      }, streamTimeoutMs);
      reader.read().then(
        (r) => { clearTimeout(timer); resolve({ ...r, timedOut: false }); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  function processEvent(jsonStr) {
    if (!jsonStr || jsonStr === '[DONE]') return;
    const parsed = JSON.parse(jsonStr);
    if (transport === 'anthropic') {
      processAnthropicEvent(parsed);
    } else if (transport === 'responses') {
      const state = {
        fullContent, fullReasoning, toolCalls, finishReason, usage,
        responsesToolBuffer, finalizedToolIds, onChunk, requestId
      };
      processResponsesEvent(state, parsed);
      // processResponsesEvent 就地修改 state 的字符串字段（fullContent/fullReasoning/
      // finishReason/usage 均为值语义），必须回写到闭包变量；只有 toolCalls 数组、
      // responsesToolBuffer 对象与 finalizedToolIds Set 是引用共享。
      // 不回写会导致 finishReason 恒为 null → agentLoop 永远等不到 'stop' 而无限循环。
      fullContent = state.fullContent;
      fullReasoning = state.fullReasoning;
      finishReason = state.finishReason;
      usage = state.usage;
    } else {
      processOpenAIEvent(parsed);
    }
  }

  function processOpenAIEvent(parsed) {
    const choice = parsed.choices?.[0];
    const delta = choice?.delta;
    if (delta?.reasoning_content) {
      fullReasoning += delta.reasoning_content;
      if (onChunk) onChunk({ reasoning: delta.reasoning_content, parsed, requestId });
    }
    if (delta?.reasoning && typeof delta.reasoning === 'string') {
      fullReasoning += delta.reasoning;
      if (onChunk) onChunk({ reasoning: delta.reasoning, parsed, requestId });
    }
    if (delta?.content) {
      fullContent += delta.content;
      if (onChunk) onChunk({ content: delta.content, parsed, requestId });
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.index !== undefined) {
          while (toolCalls.length <= tc.index) {
            toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
          }
          if (tc.id) toolCalls[tc.index].id = tc.id;
          if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
          if (onChunk) onChunk({ toolCallDelta: tc, parsed, requestId });
        }
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (parsed.usage) usage = parsed.usage;
  }

  function processAnthropicEvent(parsed) {
    const type = parsed.type;
    if (type === 'content_block_start') {
      const idx = parsed.index;
      const block = parsed.content_block || {};
      anthropicToolBlocks[idx] = { id: block.id, name: block.name, argsBuffer: '', type: block.type };
      if (block.type === 'tool_use') {
        while (toolCalls.length <= idx) {
          toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
        }
        toolCalls[idx].id = block.id;
        toolCalls[idx].function.name = block.name;
      }
    } else if (type === 'content_block_delta') {
      const d = parsed.delta || {};
      if (d.type === 'text_delta' && d.text) {
        fullContent += d.text;
        if (onChunk) onChunk({ content: d.text, parsed, requestId });
      } else if (d.type === 'thinking_delta' && d.thinking) {
        fullReasoning += d.thinking;
        if (onChunk) onChunk({ reasoning: d.thinking, parsed, requestId });
      } else if (d.type === 'input_json_delta' && d.partial_json) {
        const idx = parsed.index;
        if (anthropicToolBlocks[idx]) {
          anthropicToolBlocks[idx].argsBuffer += d.partial_json;
        }
      }
    } else if (type === 'content_block_stop') {
      const idx = parsed.index;
      const block = anthropicToolBlocks[idx];
      if (block && block.type === 'tool_use' && toolCalls[idx]) {
        toolCalls[idx].function.arguments = block.argsBuffer || '{}';
        if (onChunk) onChunk({ toolCallDelta: toolCalls[idx], parsed, requestId });
      }
    } else if (type === 'message_delta') {
      if (parsed.delta?.stop_reason) finishReason = parsed.delta.stop_reason === 'end_turn' ? 'stop' : parsed.delta.stop_reason;
      if (parsed.usage) {
        if (!usage) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        usage.completion_tokens = parsed.usage.output_tokens || usage.completion_tokens;
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      }
    } else if (type === 'message_start') {
      const msg = parsed.message || {};
      if (msg.usage?.input_tokens) {
        if (!usage) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        usage.prompt_tokens = msg.usage.input_tokens;
        // 透传 Anthropic 原生缓存字段，供 computeUsageCost 计算缓存费用
        usage.cache_read_input_tokens = msg.usage.cache_read_input_tokens || 0;
        usage.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens || 0;
      }
    }
  }

  while (true) {
    const { done, value, timedOut } = await readWithTimeout();
    if (timedOut) {
      if (onChunk) onChunk({ reasoning: '', content: '', parsed: null, requestId, streamTimeout: true });
      break;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const eventBlock = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = eventBlock.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const jsonStr = line.slice(6).trim();
        try { processEvent(jsonStr); } catch { /* ignore malformed SSE line */ }
      }
    }
  }
  if (buffer.trim()) {
    const lines = buffer.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const jsonStr = line.slice(6).trim();
      try { processEvent(jsonStr); } catch { /* ignore */ }
    }
  }
  // 兜底：某些网关正常关流却不发 response.completed（finishReason 仍为 null），
  // 此时按"有工具调用→tool_calls，否则→stop"收敛，绝不把 null 抛给 agentLoop。
  if (!finishReason) {
    finishReason = toolCalls.length ? 'tool_calls' : 'stop';
  }
  if (info && info.label) {
    const u = usage || {};
    const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
    const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
    const durMs = info.durationMs != null ? info.durationMs : (_logStart ? Date.now() - _logStart : null);
    const dr = durMs != null ? ` (${durMs}ms)` : '';
    console.log(`[${info.label} ${ts()}] ✓ stream${dr} model=${info.model || ''} finish=${finishReason} content=${fullContent.length}字 reasoning=${fullReasoning.length}字 tools=${toolCalls.length} usage=in:${inTok}/out:${outTok}`);
  }
  return {
    content: fullContent,
    reasoning: fullReasoning,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason,
    usage
  };
}

/**
 * 瞬间中止所有正在进行的 LLM 请求（停止按钮调用）
 * 返回被中止的请求数量
 * 标记 _userAborted 让 fetchLLMWithRetry 知道这是用户主动停止而非超时
 */
function abortAllRequests() {
  const count = _activeControllers.size;
  for (const c of _activeControllers) {
    try { c._userAborted = true; c.abort(); } catch { /* ignore */ }
  }
  _activeControllers.clear();
  return count;
}

/**
 * 定向中止一个会话的 LLM 请求。
 * @param {{sessionKey?: string, requestId?: string}} filter
 * @returns {number}
 */
function abortRequests(filter = {}) {
  const sessionKey = filter.sessionKey || null;
  const requestId = filter.requestId || null;
  let count = 0;
  for (const c of _activeControllers) {
    if (sessionKey && c._sessionKey !== sessionKey) continue;
    if (requestId && c._requestId !== requestId) continue;
    try { c._userAborted = true; c.abort(); } catch { /* ignore */ }
    _activeControllers.delete(c);
    count++;
  }
  return count;
}

// ---- SSE → JSON 聚合 ----
// 匿名 Zen 免费池会强制流式（见 llm-providers.js），非流式调用方拿到的响应是 SSE。
// augmentSSEResponse 给 Response 挂一个惰性 json()：只在调用 .json() 时读取并聚合，
// 流式调用方照常使用 .body，不受影响。
function aggregateSSEToJSON(text, transport = 'openai') {
  const events = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === '[DONE]') continue;
    try { events.push(JSON.parse(payload)); } catch (_) { /* skip */ }
  }

  if (transport === 'responses') {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && ev.type === 'response.completed' && ev.response) return ev.response;
    }
    let out = '';
    let usage = null;
    let model = null;
    for (const ev of events) {
      if (ev && ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') out += ev.delta;
      if (ev && ev.response && ev.response.usage) usage = ev.response.usage;
      if (ev && ev.response && ev.response.model) model = ev.response.model;
    }
    return {
      id: 'sse_aggregated', object: 'response', status: 'completed', model,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: out }] }],
      usage: usage || {}
    };
  }

  if (transport === 'anthropic') {
    let id = null;
    let model = null;
    let usage = null;
    let stopReason = null;
    let text = '';
    const blocks = [];
    for (const ev of events) {
      if (!ev || typeof ev.type !== 'string') continue;
      if (ev.type === 'message_start' && ev.message) {
        id = ev.message.id || id;
        model = ev.message.model || model;
        usage = ev.message.usage || usage;
      } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        blocks[ev.index] = { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, input: '' };
      } else if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta') text += ev.delta.text || '';
        else if (ev.delta.type === 'input_json_delta') {
          if (!blocks[ev.index]) blocks[ev.index] = { type: 'tool_use', id: '', name: '', input: '' };
          blocks[ev.index].input += ev.delta.partial_json || '';
        }
      } else if (ev.type === 'message_delta') {
        stopReason = (ev.delta && ev.delta.stop_reason) || stopReason;
        if (ev.usage) usage = { ...(usage || {}), output_tokens: ev.usage.output_tokens ?? (usage || {}).output_tokens };
      }
    }
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue;
      let input = {};
      try { input = JSON.parse(b.input || '{}'); } catch (_) { /* keep empty */ }
      content.push({ type: 'tool_use', id: b.id, name: b.name, input });
    }
    return { id, type: 'message', role: 'assistant', model, content, stop_reason: stopReason || 'end_turn', usage: usage || { input_tokens: 0, output_tokens: 0 } };
  }

  // OpenAI chat.completion 流（默认）
  let id = null;
  let model = null;
  let usage = null;
  let finishReason = null;
  let content = '';
  let reasoning = '';
  const toolAcc = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.id) id = ev.id;
    if (ev.model) model = ev.model;
    if (ev.usage) usage = ev.usage;
    const choice = Array.isArray(ev.choices) ? ev.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    if (typeof d.content === 'string') content += d.content;
    if (typeof d.reasoning === 'string') reasoning += d.reasoning;
    else if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = toolAcc.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) cur.id = tc.id;
      if (tc.function && tc.function.name) cur.function.name = tc.function.name;
      if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
      toolAcc.set(idx, cur);
    }
  }
  const toolCalls = toolAcc.size
    ? [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    : undefined;
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning = reasoning;
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id: id || 'sse_aggregated',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    usage: usage || {}
  };
}

function augmentSSEResponse(resp, transport) {
  try {
    const ct = resp && resp.headers && typeof resp.headers.get === 'function'
      ? (resp.headers.get('content-type') || '')
      : '';
    if (!ct.includes('text/event-stream')) return resp;
    let cached = null;
    Object.defineProperty(resp, 'json', {
      configurable: true,
      value: async () => {
        if (cached) return cached;
        const text = await resp.text();
        cached = aggregateSSEToJSON(text, transport);
        return cached;
      }
    });
  } catch (_) { /* 保持原始 Response */ }
  return resp;
}

module.exports = {
  LLMError,
  fetchLLMWithRetry,
  consumeSSEStream,
  processResponsesEvent,
  aggregateSSEToJSON,
  augmentSSEResponse,
  getRetryDelay,
  classifyHttpResponse,
  classifyThrownError,
  abortAllRequests,
  abortRequests,
  DEFAULT_MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_529_RETRIES,
  MAX_PAYMENT_RETRIES,
  DEFAULT_TIMEOUT_MS
};
