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

// ---- Constants ----
const DEFAULT_MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32000;
const MAX_529_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 300000; // 5 min
const JITTER_RATIO = 0.25;

// Error kinds: 'rate_limit' | 'overloaded' | 'server' | 'timeout' | 'network' | 'auth' | 'client' | 'unknown'

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

  let lastError = null;
  let consecutive529 = 0;
  let currentModel = cfg.body.model;
  let usingFallback = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reqBody = { ...cfg.body, model: currentModel };
      const headers = customHeaders
        ? { ...customHeaders, 'Content-Type': 'application/json' }
        : { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: controller.signal
      });
      clearTimeout(timer);

      const cls = classifyHttpResponse(resp);

      if (!cls.retry) {
        if (resp.ok) {
          return { ok: true, response: resp };
        }
        // Non-retryable client/auth error — read body for message.
        let errBody = null;
        try { errBody = await resp.json(); } catch { /* ignore */ }
        const errMsg = errBody?.error?.message || errBody?.message ||
          (typeof errBody?.error === 'string' ? errBody.error : null) ||
          `HTTP ${resp.status}`;
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
        if (consecutive529 >= MAX_529_RETRIES && fallbackModel && !usingFallback) {
          usingFallback = true;
          currentModel = fallbackModel;
          consecutive529 = 0;
          onRetry({
            attempt, status: resp.status, kind: cls.kind,
            reason: 'fallback_to_' + fallbackModel, requestId
          });
          continue; // skip sleep on first fallback switch
        }
      } else {
        consecutive529 = 0;
      }

      const errText = await resp.text().catch(() => '');
      lastError = new LLMError(
        `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        { status: resp.status, retryAfter: cls.retryAfter, kind: cls.kind }
      );
      const delay = getRetryDelay(attempt, cls.retryAfter);
      onRetry({
        attempt, status: resp.status, kind: cls.kind, delayMs: delay,
        requestId, error: lastError.message
      });
      await sleep(delay, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      const cls = classifyThrownError(err);
      if (!cls.retry || attempt >= maxRetries) {
        lastError = new LLMError(err.message || String(err), { kind: cls.kind });
        break;
      }
      const delay = getRetryDelay(attempt, null);
      lastError = new LLMError(err.message || String(err), { kind: cls.kind });
      onRetry({
        attempt, kind: cls.kind, delayMs: delay, requestId, error: err.message
      });
      try {
        await sleep(delay);
      } catch {
        break; // aborted during sleep
      }
    }
  }

  return {
    ok: false,
    error: lastError?.message || 'unknown error after retries',
    kind: lastError?.kind || 'unknown',
    status: lastError?.status
  };
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
async function consumeSSEStream(bodyStream, onChunk, requestId, transport = 'openai', streamTimeoutMs = 120000) {
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let fullReasoning = '';
  let toolCalls = [];
  let finishReason = null;
  let usage = null;
  let buffer = '';
  let anthropicToolBlocks = {};

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
  return {
    content: fullContent,
    reasoning: fullReasoning,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason,
    usage
  };
}

module.exports = {
  LLMError,
  fetchLLMWithRetry,
  consumeSSEStream,
  getRetryDelay,
  classifyHttpResponse,
  classifyThrownError,
  DEFAULT_MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_529_RETRIES,
  DEFAULT_TIMEOUT_MS
};
