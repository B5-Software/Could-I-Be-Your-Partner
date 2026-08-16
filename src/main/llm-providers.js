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
// legacy Anthropic extended thinking 的 token 预算映射（adaptive thinking 直接透传 effort）
const REASONING_BUDGET_MAP = { off: 0, low: 8000, medium: 16000, high: 32000 };
// 向后兼容导出：历史上外部只认 low/medium/high 三档
const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high'];

// ---- Reasoning variant（变体 / 思考强度）引擎 ----
// 统一档位 ID + 中文显示名。wire 字段即实际发送给 provider 的 effort 值。
const VARIANT_LABELS = {
  off: '关闭',
  auto: '自动（模型默认）',
  none: '无推理',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高'
};

function makeVariantTable(ids, defaultId) {
  const variants = (Array.isArray(ids) ? ids : []).map(id => ({
    id,
    label: VARIANT_LABELS[id] || id,
    wire: id
  }));
  let def = defaultId;
  if (!def || !variants.some(v => v.id === def)) {
    def = variants.some(v => v.id === 'auto') ? 'auto'
      : variants.some(v => v.id === 'medium') ? 'medium'
      : (variants[0]?.id || 'off');
  }
  return { variants, defaultId: def };
}

/**
 * 判断 Anthropic 模型的思考模式：'none'（不支持）| 'adaptive' | 'legacy'。
 * 优先使用 /v1/models 返回的 capabilities（若提供），否则按模型名推断。
 */
function anthropicThinkingMode(model, capabilities) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : null;
  if (caps) {
    const t = caps.thinking || caps.extended_thinking || null;
    if (t && typeof t === 'object') {
      if (t.supported === false) return 'none';
      if (t.adaptive === true || t.type === 'adaptive') return 'adaptive';
      if (Array.isArray(t.supported_types) && t.supported_types.includes('adaptive')) return 'adaptive';
      if (t.type === 'legacy' || t.budgetTokens === true || t.budget_tokens === true) return 'legacy';
      if (t.supported === true) return 'legacy';
    }
  }
  const m = String(model || '').toLowerCase();
  // Claude 4.6+ / 5 系列使用 adaptive thinking；其余 Claude 为 legacy budget_tokens。
  if (/(opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|fable-5|mythos-5)/.test(m)) return 'adaptive';
  if (/claude/.test(m)) return 'legacy';
  return 'legacy';
}

/**
 * 解析给定模型可用的变体档位表。
 * @param {string} model 模型 ID
 * @param {string} provider openai-compat | openai-responses | anthropic-compat | opencode-zen
 * @param {object} [capabilities] Anthropic /v1/models 的 capabilities（可选）
 * @returns {{ variants: Array<{id,label,wire}>, defaultId: string }}
 */
function resolveReasoningVariants(model, provider, capabilities) {
  const m = String(model || '').toLowerCase();
  let p = provider || 'openai-compat';
  if (p === 'opencode-zen') {
    const pt = zenModelProviderType(m);
    p = pt === 'anthropic' ? 'anthropic-compat'
      : pt === 'openai-responses' ? 'openai-responses'
      : 'openai-compat';
  }

  // Anthropic：capabilities 优先，模型名推断兜底
  if (p === 'anthropic-compat') {
    const mode = anthropicThinkingMode(m, capabilities);
    if (mode === 'none') return makeVariantTable(['off', 'auto'], 'auto');
    if (mode === 'adaptive') return makeVariantTable(['off', 'minimal', 'low', 'medium', 'high'], 'medium');
    return makeVariantTable(['off', 'auto', 'low', 'medium', 'high'], 'auto');
  }

  // OpenAI Responses API
  if (p === 'openai-responses') {
    if (/^gpt-5\.1/.test(m)) return makeVariantTable(['off', 'none', 'low', 'medium', 'high'], 'medium');
    if (/^(gpt-5|o[134])(?:[.-]|$)/.test(m)) return makeVariantTable(['off', 'none', 'minimal', 'low', 'medium', 'high'], 'medium');
    return makeVariantTable(['off', 'auto'], 'auto');
  }

  // OpenAI 兼容 chat/completions
  if (/^deepseek-v4/.test(m)) {
    // 官方映射：low→low, medium→high, high→high, xhigh→high(flash)/max(pro), max→max
    return makeVariantTable(['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'auto');
  }
  if (/^deepseek/.test(m)) return makeVariantTable(['off', 'auto'], 'auto');
  if (/^(qwen|grok-|kimi|glm-|minimax|mimo)/.test(m)) {
    return makeVariantTable(['off', 'auto', 'low', 'medium', 'high'], 'auto');
  }
  if (/^(o[134]|gpt-5)(?:[.-]|$)/.test(m)) {
    if (/^gpt-5\.1/.test(m)) return makeVariantTable(['off', 'none', 'low', 'medium', 'high'], 'medium');
    return makeVariantTable(['off', 'minimal', 'low', 'medium', 'high'], 'medium');
  }
  // 未知 openai-compat 模型：保守五档（off/auto/low/medium/high）
  return makeVariantTable(['off', 'auto', 'low', 'medium', 'high'], 'auto');
}

/**
 * 校验一个 effort 值对给定模型是否合法；不合法时收敛到该模型默认档。
 * @returns {{ valid: boolean, resolved: string, changed: boolean }}
 */
function validateReasoningEffort(effort, model, provider, capabilities) {
  const table = resolveReasoningVariants(model, provider, capabilities);
  const ids = table.variants.map(v => v.id);
  const input = effort == null || effort === '' ? table.defaultId : String(effort);
  if (ids.includes(input)) return { valid: true, resolved: input, changed: false, variants: table.variants, defaultId: table.defaultId };
  return { valid: false, resolved: table.defaultId, changed: true, variants: table.variants, defaultId: table.defaultId };
}

/**
 * 请求构造前的最后一道防线：把 effort 收敛到该模型合法档位。
 * @returns {{ effort: string, variants: Array<{id,label,wire}>, defaultId: string }}
 */
function resolveVariantForRequest(llm, effort) {
  const provider = llm.provider || 'openai-compat';
  const caps = llm.capabilities || null;
  const table = resolveReasoningVariants(llm.model, provider, caps);
  const ids = table.variants.map(v => v.id);
  let eff = effort == null || effort === '' ? table.defaultId : String(effort);
  if (!ids.includes(eff)) eff = table.defaultId;
  return { effort: eff, variants: table.variants, defaultId: table.defaultId };
}

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
  if (provider === 'openai-responses') {
    return buildResponsesRequest(llm, opts, reasoningEffort);
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
  // 流式请求附带 usage 统计（include_usage）→ 流式 Token 统计不再依赖估算
  // 兼容端点不支持时仅回退到估算，不影响请求本身
  if (opts.stream) body.stream_options = { include_usage: true };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  }
  // JSON mode: force the model to emit valid JSON (OpenAI-compat standard).
  // Helps with thinking models that would otherwise dump reasoning into content.
  if (opts.response_format) body.response_format = opts.response_format;
  // Reasoning effort：按模型能力表收敛后注入。
  // 'off'/'auto' 不注入 effort 字段（模型默认行为）；
  // DeepSeek V4 的 'off' 显式发 thinking.type=disabled 以真正关闭思考。
  const resolvedVariant = resolveVariantForRequest(llm, reasoningEffort);
  if (resolvedVariant.effort && resolvedVariant.effort !== 'auto') {
    const m = (llm.model || '').toLowerCase();
    if (resolvedVariant.effort === 'off') {
      if (/^deepseek-v4/.test(m)) body.thinking = { type: 'disabled' };
    } else {
      body.reasoning_effort = resolvedVariant.effort;
    }
  }
  // 当未配置 API Key（如 llama.cpp 等本地无 key 端点）时，不发送 Authorization 头
  const openaiHeaders = { 'Content-Type': 'application/json' };
  if (llm.apiKey) openaiHeaders['Authorization'] = `Bearer ${llm.apiKey}`;
  return {
    url,
    headers: openaiHeaders,
    body,
    transport: 'openai'
  };
}

// ---- OpenAI Responses API (v1/responses) ----
// 新版 OpenAI Responses API：input items 替代 messages，instructions 替代 system。
// 输出为 output items（message/reasoning/function_call），usage 用 input/output_tokens。
function buildResponsesRequest(llm, opts, reasoningEffort) {
  const url = llm.apiUrl; // full URL to /v1/responses
  const converted = convertMessagesToResponses(opts.messages);
  const body = {
    model: llm.model,
    input: converted.input,
    max_output_tokens: opts.max_tokens ?? llm.maxResponseTokens ?? 8192,
    stream: !!opts.stream,
    // 无状态请求：不写入服务端历史，避免会话上下文污染与隐私残留
    store: false
  };
  if (converted.instructions) body.instructions = converted.instructions;
  if (opts.temperature != null || llm.temperature != null) {
    body.temperature = opts.temperature ?? llm.temperature;
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map(t => ({
      type: 'function',
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      parameters: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
    }));
    if (opts.tool_choice) {
      // OpenAI 兼容 tool_choice（'auto' | 'none' | 'required' | {type:'function',function:{name}}）
      // → Responses API 格式（{type} 或 {type:'function', name}）
      if (typeof opts.tool_choice === 'string') {
        body.tool_choice = { type: opts.tool_choice };
      } else if (opts.tool_choice.function?.name) {
        body.tool_choice = { type: 'function', name: opts.tool_choice.function.name };
      } else {
        body.tool_choice = { type: 'auto' };
      }
    }
  }
  // response_format（如 {type:'json_object'} / {type:'json_schema',...}）→ text.format
  if (opts.response_format) {
    if (opts.response_format.type === 'json_schema') {
      body.text = { format: { type: 'json_schema', name: 'output', schema: opts.response_format.json_schema?.schema || opts.response_format.json_schema, strict: !!opts.response_format.strict } };
    } else if (opts.response_format.type === 'json_object') {
      body.text = { format: { type: 'json_object' } };
    } else {
      body.text = { format: opts.response_format };
    }
  }
  // Reasoning effort：按模型能力表收敛后注入（'off'/'auto' 不注入）
  const resolvedVariant = resolveVariantForRequest(llm, reasoningEffort);
  if (resolvedVariant.effort && resolvedVariant.effort !== 'off' && resolvedVariant.effort !== 'auto') {
    body.reasoning = { effort: resolvedVariant.effort };
  }
  const responsesHeaders = { 'Content-Type': 'application/json' };
  if (llm.apiKey) responsesHeaders['Authorization'] = `Bearer ${llm.apiKey}`;
  return {
    url,
    headers: responsesHeaders,
    body,
    transport: 'responses'
  };
}

// OpenAI 风格消息 → Responses API input items（system 单独提取为 instructions）
// 参考 https://platform.openai.com/docs/guides/conversation-state#examples-for-storing-conversations
function convertMessagesToResponses(messages) {
  let instructions = '';
  const input = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      instructions += (instructions ? '\n\n' : '') + text;
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id || '',
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || ''
          });
        }
        // 官方会话存储示例：带工具调用的 assistant 消息只存 function_call item（不含 output_text）
        continue;
      }
      if (m.content) {
        input.push({ type: 'output_text', text: m.content, role: 'assistant' });
      }
      continue;
    }
    // user
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text' && part.text) {
          input.push({ type: 'input_text', text: part.text, role: 'user' });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          input.push({ type: 'input_image', image_url: part.image_url.url, role: 'user' });
        }
      }
    } else if (typeof m.content === 'string' && m.content) {
      input.push({ type: 'input_text', text: m.content, role: 'user' });
    } else {
      input.push({ type: 'input_text', text: JSON.stringify(m.content), role: 'user' });
    }
  }
  return { instructions, input };
}

// Responses API 非流式响应 → 统一 OpenAI-compatible shape
function parseResponsesResponse(data) {
  const output = Array.isArray(data.output) ? data.output : [];
  const textParts = [];
  const toolCalls = [];
  let reasoning = '';
  for (const item of output) {
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === 'output_text') textParts.push(block.text || '');
      }
    } else if (item.type === 'reasoning') {
      const summary = item.summary && item.summary.map(s => s?.text || '').join('');
      if (summary) reasoning += (reasoning ? '\n' : '') + summary;
      else if (item.text) reasoning += (reasoning ? '\n' : '') + item.text;
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || '',
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '{}' }
      });
    }
  }
  let finishReason = 'stop';
  if (data.status === 'incomplete') finishReason = 'length';
  else if (data.status === 'failed') finishReason = 'error';
  const usage = data.usage || {};
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: textParts.join(''),
        reasoning: reasoning || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      },
      finish_reason: finishReason
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      // 透传 Responses API 缓存 / 推理明细，供 computeUsageCost 计费
      cache_read_input_tokens: usage.input_tokens_details?.cached_tokens || 0,
      reasoning_output_tokens: usage.output_tokens_details?.reasoning_tokens || 0
    }
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
  // Reasoning：Anthropic 按模型能力自适应。
  // - adaptive 模型（Claude 4.6+/5 系）：thinking.type=adaptive + effort(minimal/low/medium/high)
  // - legacy 模型：thinking.type=enabled + budget_tokens(8k/16k/32k)
  // - 'off'/'auto'：不注入 thinking（模型默认行为）
  const resolvedVariant = resolveVariantForRequest(llm, reasoningEffort);
  if (resolvedVariant.effort && resolvedVariant.effort !== 'off' && resolvedVariant.effort !== 'auto') {
    const mode = anthropicThinkingMode(llm.model, llm.capabilities);
    if (mode === 'adaptive') {
      body.thinking = { type: 'adaptive', effort: resolvedVariant.effort };
    } else {
      const budget = REASONING_BUDGET_MAP[resolvedVariant.effort] || 0;
      if (budget > 0) {
        body.thinking = { type: 'enabled', budget_tokens: budget };
        // Anthropic requires max_tokens > budget_tokens
        if (body.max_tokens <= budget) body.max_tokens = budget + 4096;
      }
    }
  }
  // 当未配置 API Key 时，不发送 x-api-key 头（兼容无 key 的 Anthropic 兼容端点）
  const anthropicHeaders = {
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json'
  };
  if (llm.apiKey) anthropicHeaders['x-api-key'] = llm.apiKey;
  return {
    url,
    headers: anthropicHeaders,
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
  if (transport === 'responses') {
    return parseResponsesResponse(data);
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
  VARIANT_LABELS,
  makeVariantTable,
  anthropicThinkingMode,
  resolveReasoningVariants,
  validateReasoningEffort,
  resolveVariantForRequest,
  zenModelProviderType,
  buildLLMRequest,
  parseLLMResponse,
  parseAnthropicResponse,
  parseResponsesResponse,
  convertMessagesToAnthropic,
  convertMessagesToResponses,
  buildResponsesRequest
};
