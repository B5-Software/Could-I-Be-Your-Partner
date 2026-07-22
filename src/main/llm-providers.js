/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * LLM provider abstraction: supports OpenAI-compatible, Anthropic-compatible,
 * and OpenCode Zen (auto-routes by model ID).
 * Each provider builds the request URL/body, parses the response, and applies
 * reasoning intensity settings when the model supports it.
 */

'use strict';

const ZEN_BASE = 'https://opencode.ai/zen/v1';

// ---- Reasoning intensity → provider-specific params ----
// off / low / medium / high
const REASONING_BUDGET_MAP = { off: 0, low: 8000, medium: 16000, high: 32000 };
const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high'];

/**
 * Determine the provider type for a given model ID on OpenCode Zen.
 * Returns one of: 'openai-responses' | 'anthropic' | 'openai-compat' | 'google'
 */
function zenModelProviderType(modelId) {
  // Based on the Zen endpoint table.
  // Claude / Qwen3.x → Anthropic messages API
  // GPT-5.x → OpenAI responses API (we map to chat/completions for compatibility)
  // Gemini → Google (we map to chat/completions for compatibility)
  // DeepSeek / MiniMax / GLM / Kimi / Grok / Big Pickle / *-free → OpenAI-compat chat/completions
  const m = (modelId || '').toLowerCase();
  if (/^(claude-|qwen3\.)/.test(m)) return 'anthropic';
  if (/^gpt-5/.test(m)) return 'openai-responses';
  if (/^gemini/.test(m)) return 'google';
  return 'openai-compat';
}

/**
 * Build the full request URL + headers + body for a given provider config.
 * @param {object} llm - settings.llm (with provider, apiUrl, apiKey, model, etc.)
 * @param {object} opts - { messages, tools, tool_choice, temperature, max_tokens, stream, reasoningEffort }
 * @returns {{ url, headers, body, transport }} transport: 'openai' | 'anthropic'
 */
function buildLLMRequest(llm, opts) {
  const provider = llm.provider || 'openai-compat';
  const model = llm.model;
  // 允许调用方（如游戏）通过 opts.reasoningEffort 覆盖全局设置，
  // 避免思考模型把所有 token 都花在 reasoning 上导致 content 为空。
  const reasoningEffort = opts.reasoningEffort || llm.reasoningEffort || 'off';

  if (provider === 'opencode-zen') {
    return buildZenRequest(llm, opts, reasoningEffort);
  }
  if (provider === 'anthropic-compat') {
    return buildAnthropicRequest(llm, opts, reasoningEffort);
  }
  // default: openai-compat
  return buildOpenAIRequest(llm, opts, reasoningEffort);
}

// ---- OpenAI-compatible (chat/completions) ----
function buildOpenAIRequest(llm, opts, reasoningEffort) {
  const url = llm.apiUrl; // full URL to chat/completions
  const body = {
    model: llm.model,
    messages: opts.messages,
    temperature: opts.temperature ?? llm.temperature,
    max_tokens: opts.max_tokens ?? llm.maxResponseTokens ?? 8192,
    stream: !!opts.stream
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  }
  // JSON mode: force the model to emit valid JSON (OpenAI-compat standard).
  // Helps with thinking models that would otherwise dump reasoning into content.
  if (opts.response_format) body.response_format = opts.response_format;
  // Reasoning effort: OpenAI o-series + GPT-5 use reasoning_effort field.
  // DeepSeek / Qwen 系列也支持 reasoning_effort 参数。
  // 注意：'off' 值大多数 provider 不支持，会导致 400 错误。
  // 因此 reasoningEffort='off' 时不注入字段，让模型用默认行为（不传 reasoning_effort）。
  // 游戏通过足够大的 max_tokens（用户配置的 maxResponseTokens）确保思考后仍有空间输出答案。
  if (reasoningEffort && reasoningEffort !== 'off') {
    const m = (llm.model || '').toLowerCase();
    // OpenAI reasoning models: o1, o3, o4, gpt-5*
    if (/^o[134]-|^gpt-5/.test(m)) {
      body.reasoning_effort = reasoningEffort;
    }
    // DeepSeek 全系列 + Qwen 全系列（包括 r1, v4, flash, think 等变体）
    if (/deepseek|qwen/.test(m)) {
      body.reasoning_effort = reasoningEffort;
    }
  }
  return {
    url,
    headers: {
      'Authorization': `Bearer ${llm.apiKey}`,
      'Content-Type': 'application/json'
    },
    body,
    transport: 'openai'
  };
}

// ---- Anthropic-compatible (messages) ----
function buildAnthropicRequest(llm, opts, reasoningEffort) {
  // Anthropic messages API: POST /v1/messages
  // Different auth header (x-api-key), different body shape, different tool format.
  const url = llm.apiUrl; // should point to /v1/messages
  const messages = convertMessagesToAnthropic(opts.messages);
  const body = {
    model: llm.model,
    messages: messages.messages,
    system: messages.system,
    max_tokens: opts.max_tokens ?? llm.maxResponseTokens ?? 8192,
    stream: !!opts.stream
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
    }));
    if (opts.tool_choice) {
      body.tool_choice = { type: 'auto' };
    }
  }
  // Reasoning: Anthropic uses "thinking" object with budget_tokens.
  if (reasoningEffort && reasoningEffort !== 'off') {
    const budget = REASONING_BUDGET_MAP[reasoningEffort] || 0;
    if (budget > 0) {
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic requires max_tokens > budget_tokens
      if (body.max_tokens <= budget) body.max_tokens = budget + 4096;
    }
  }
  return {
    url,
    headers: {
      'x-api-key': llm.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body,
    transport: 'anthropic'
  };
}

// ---- OpenCode Zen (auto-route by model ID) ----
function buildZenRequest(llm, opts, reasoningEffort) {
  const modelId = llm.model;
  const ptype = zenModelProviderType(modelId);
  // Zen uses a shared API key (Bearer). We clone llm and override apiUrl.
  const zenLlm = { ...llm, apiKey: llm.zenApiKey || llm.apiKey };

  if (ptype === 'anthropic') {
    // Claude / Qwen3.x on Zen use the Anthropic messages API format
    // but with Bearer auth (not x-api-key).
    const req = buildAnthropicRequest(zenLlm, opts, reasoningEffort);
    req.url = `${ZEN_BASE}/messages`;
    // Zen uses Bearer auth even for Anthropic-style endpoints
    req.headers = {
      'Authorization': `Bearer ${zenLlm.apiKey}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    };
    return req;
  }
  // openai-responses, google, openai-compat → all use Zen's chat/completions for compatibility
  // (Zen exposes /chat/completions that handles routing internally for non-Anthropic models)
  const req = buildOpenAIRequest(zenLlm, opts, reasoningEffort);
  req.url = `${ZEN_BASE}/chat/completions`;
  req.headers = {
    'Authorization': `Bearer ${zenLlm.apiKey}`,
    'Content-Type': 'application/json'
  };
  return req;
}

// Convert OpenAI-style messages to Anthropic format.
// OpenAI: [{role, content, tool_calls, tool_call_id, reasoning}]
// Anthropic: { system: string, messages: [{role: 'user'|'assistant', content}] }
// Tool calls in Anthropic use a different format (content blocks).
function convertMessagesToAnthropic(messages) {
  let system = '';
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === 'tool') {
      // Convert tool result to a user message with tool_result content block
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: m.content || '' }]
      });
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      if (m.reasoning) {
        content.push({ type: 'thinking', thinking: m.reasoning });
      }
      if (m.content) {
        content.push({ type: 'text', text: m.content });
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
        }
      }
      out.push({ role: 'assistant', content: content.length === 1 ? content[0] : content });
      continue;
    }
    // user — 支持 content 是字符串或数组（多模态 vision format）
    if (Array.isArray(m.content)) {
      const blocks = [];
      for (const part of m.content) {
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          // OpenAI vision format → Anthropic format
          const match = part.image_url.url.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
          if (match) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] }
            });
          }
        }
      }
      out.push({ role: 'user', content: blocks.length > 0 ? blocks : '' });
    } else {
      out.push({ role: 'user', content: m.content || '' });
    }
  }
  return { system, messages: out };
}

/**
 * Parse a response from any provider into a unified OpenAI-compatible shape.
 * So downstream code (agent.js) doesn't need to know the provider type.
 */
function parseLLMResponse(data, transport) {
  if (transport === 'anthropic') {
    return parseAnthropicResponse(data);
  }
  // OpenAI-compatible: expose reasoning_content/reasoning for UI display,
  // but DO NOT merge into content — that would leak raw thinking text into
  // downstream consumers (games, agents) that expect only the final answer.
  // Models like DeepSeek R1 return thinking in reasoning_content and the
  // final answer in content. When content is empty, the model produced no
  // final answer — leave content empty so callers can handle the absence.
  if (data?.choices && Array.isArray(data.choices)) {
    for (const choice of data.choices) {
      const msg = choice?.message;
      if (!msg) continue;
      const reasoningContent = msg.reasoning_content || msg.reasoning;
      // Expose reasoning for UI (streaming path already does this)
      if (reasoningContent && !msg.reasoning) {
        msg.reasoning = reasoningContent;
      }
    }
  }
  return data;
}

function parseAnthropicResponse(data) {
  // Anthropic response: { id, type: 'message', role: 'assistant', content: [{type:'text',text},{type:'tool_use',...}], stop_reason, usage }
  const content = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const toolCalls = (data.content || [])
    .filter(b => b.type === 'tool_use')
    .map(b => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
    }));
  const reasoning = (data.content || [])
    .filter(b => b.type === 'thinking')
    .map(b => b.thinking)
    .join('');
  return {
    choices: [{
      message: {
        role: 'assistant',
        content,
        reasoning: reasoning || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      },
      finish_reason: data.stop_reason === 'end_turn' ? 'stop' : (data.stop_reason || 'stop')
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      // 透传 Anthropic 原生缓存字段，供 computeUsageCost 计算缓存费用
      cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0
    }
  };
}

/**
 * Parse an SSE chunk from any provider into a unified delta.
 * Returns { content?, reasoning?, toolCallDelta?, finishReason?, usage? }
 */
function parseStreamChunk(raw, transport) {
  if (transport === 'anthropic') {
    return parseAnthropicStreamChunk(raw);
  }
  return raw; // OpenAI shape already handled by consumeSSEStream
}

function parseAnthropicStreamChunk(raw) {
  // Anthropic SSE events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  // We convert to OpenAI-style delta for consumeSSEStream compatibility.
  // This is a simplified adapter — if raw is already OpenAI-shaped, pass through.
  if (raw && raw.choices) return raw;
  // For Anthropic, the streaming adapter in main.js will handle conversion directly.
  return raw;
}

module.exports = {
  ZEN_BASE,
  REASONING_BUDGET_MAP,
  REASONING_EFFORT_LEVELS,
  zenModelProviderType,
  buildLLMRequest,
  parseLLMResponse,
  parseAnthropicResponse,
  convertMessagesToAnthropic
};
