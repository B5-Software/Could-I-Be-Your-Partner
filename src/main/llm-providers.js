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

const ocHeaders = require('./opencode-headers');

const ZEN_BASE = 'https://opencode.ai/zen/v1';
const OC_GO_BASE = 'https://opencode.ai/zen/go/v1';

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
  // Based on the Zen endpoint table (verified live 2026-09-04).
  // Claude / Qwen3.x → Anthropic messages API
  // GPT-5.x → OpenAI responses API (we map to chat/completions for compatibility)
  // muse-spark* → OpenAI Responses API ONLY: Zen's /chat/completions returns
  //   plain 500 for these models; /responses with `input` works (200).
  // Gemini → Google (we map to chat/completions for compatibility)
  // DeepSeek / MiniMax / GLM / Kimi / Grok / Big Pickle / other *-free → OpenAI-compat chat/completions
  const m = (modelId || '').toLowerCase();
  if (/^(claude-|qwen3\.)/.test(m)) return 'anthropic';
  if (/^gpt-5/.test(m)) return 'openai-responses';
  if (/muse-spark/.test(m)) return 'openai-responses';
  if (/^gemini/.test(m)) return 'google';
  return 'openai-compat';
}

// ---- OpenCode Zen 匿名免费池适配（2026-09-19 实测）----
// 匿名请求（Authorization: Bearer public）只接受“agent 形状”：stream:true + 工具名包含
// bash/edit/glob/grep/read 五个（仅名字参与校验，schema/描述可用最小占位）。缺任一项均返回
// 403 FreeTierError。带真实 Zen key 的请求不受此限制。
const FREE_TIER_CORE_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'];

const FREE_TIER_AGENT_TOOLS = {
  bash: { type: 'function', function: { name: 'bash', description: '在终端执行 shell 命令并返回输出', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] } } },
  read: { type: 'function', function: { name: 'read', description: '读取文件内容', parameters: { type: 'object', properties: { filePath: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['filePath'] } } },
  edit: { type: 'function', function: { name: 'edit', description: '按字符串替换编辑文件', parameters: { type: 'object', properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['filePath', 'oldString', 'newString'] } } },
  glob: { type: 'function', function: { name: 'glob', description: '按通配符查找文件', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  grep: { type: 'function', function: { name: 'grep', description: '在文件内容中检索', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] } } },
};

const FREE_TIER_STUB_TOOLS = (() => {
  const out = {};
  for (const name of FREE_TIER_CORE_TOOLS) {
    out[name] = { type: 'function', function: { name, description: 'Reserved compatibility tool; do not call.', parameters: { type: 'object', properties: {} } } };
  }
  return out;
})();

/** 是否匿名 Zen（public / 未配置 key） */
function isAnonymousZen(llm) {
  const key = String((llm && (llm.zenApiKey || llm.apiKey)) || '').trim();
  return !key || key === 'public';
}

/**
 * 合并免费池要求的核心工具：调用方已有工具 → 补全缺失项（真实描述）；
 * 无工具的辅助调用（标题/游戏/描述等）→ 注入占位定义，避免模型误用。
 */
function mergeFreeTierTools(tools) {
  const list = Array.isArray(tools) ? tools.slice() : [];
  const present = new Set(list.map(t => t && (t.function?.name || t.name)).filter(Boolean));
  const source = list.length > 0 ? FREE_TIER_AGENT_TOOLS : FREE_TIER_STUB_TOOLS;
  for (const name of FREE_TIER_CORE_TOOLS) {
    if (!present.has(name)) list.push(source[name]);
  }
  return list;
}

/**
 * Build the full request URL + headers + body for a given provider config.
 * @param {object} llm - settings.llm (with provider, apiUrl, apiKey, model, etc.)
 * @param {object} opts - { messages, tools, tool_choice, temperature, max_tokens, stream,
 *                          reasoningEffort, sessionKey, requestId }
 * @returns {{ url, headers, body, transport }} transport: 'openai' | 'anthropic' | 'responses'
 */
function buildLLMRequest(llm, opts) {
  const provider = llm.provider || 'openai-compat';
  const model = llm.model;
  // 允许调用方（如游戏）通过 opts.reasoningEffort 覆盖全局设置，
  // 避免思考模型把所有 token 都花在 reasoning 上导致 content 为空。
  const reasoningEffort = opts.reasoningEffort || llm.reasoningEffort || 'off';
  // 匿名 Zen：免费池强制 agent 形状（stream + 核心工具名），带 key 不受限
  const zenAnonymous = provider === 'opencode-zen' && isAnonymousZen(llm);
  const buildOpts = zenAnonymous
    ? { ...opts, stream: true, tools: mergeFreeTierTools(opts.tools) }
    : opts;

  let req;
  if (provider === 'opencode-zen') {
    req = buildZenRequest(llm, buildOpts, reasoningEffort);
  } else if (provider === 'opencode-go') {
    req = buildOpencodeGoRequest(llm, buildOpts, reasoningEffort);
  } else if (provider === 'anthropic-compat') {
    req = buildAnthropicRequest(llm, buildOpts, reasoningEffort);
  } else if (provider === 'openai-responses') {
    req = buildResponsesRequest(llm, buildOpts, reasoningEffort);
  } else {
    // default: openai-compat
    req = buildOpenAIRequest(llm, buildOpts, reasoningEffort);
  }

  // 匿名 Zen 兜底：强制 stream（部分 builder 只在 opts.stream 时带 stream_options）
  if (zenAnonymous) {
    req.body.stream = true;
    if (req.transport === 'openai' && !req.body.stream_options) {
      req.body.stream_options = { include_usage: true };
    }
    req.zenAnonymous = true;
  }

  // 统一请求头应用（所有种类 API 生效）：
  // 1) 自定义请求头（用户配置，可覆盖任何自动头）；
  // 2) OpenCode 官方头组（URL 命中 opencode.ai 时自动补齐并规范化为官方 ID 形状：
  //    免费模型 UA 门控、x-opencode-session 格式校验、无 key 时 Authorization: Bearer public）。
  req.headers = ocHeaders.applyProviderHeaders({
    url: req.url,
    headers: req.headers,
    llm,
    sessionKey: opts.sessionKey || null,
    requestId: opts.requestId || null
  });
  return req;
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
//
// 规范形状（2026-09-04 实测：Zen Console 系 provider 对形状做严格校验，
// 错一个即报 `input[N] did not match any supported type`）：
//   - 文本/图片消息必须是 { type:'message', role, content:[...] } 包裹的 item，
//     裸 { type:'input_text' } / { type:'output_text' } 不能出现在 input 顶层；
//   - assistant 文本放在 message.content 里用 output_text 块；user 文本用 input_text 块。
function convertMessagesToResponses(messages) {
  let instructions = '';
  const input = [];
  const textOf = (c) => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
  for (const m of messages || []) {
    if (m.role === 'system') {
      const text = textOf(m.content);
      instructions += (instructions ? '\n\n' : '') + text;
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: textOf(m.content)
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
            arguments: typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {})
          });
        }
        // 官方会话存储示例：带工具调用的 assistant 消息只存 function_call item（不含 output_text）
        continue;
      }
      const text = textOf(m.content);
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        });
      }
      continue;
    }
    // user（含 developer 兜底为 user）：content 可能是字符串或多模态数组
    const role = m.role === 'developer' ? 'developer' : 'user';
    const blocks = [];
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text' && part.text) {
          blocks.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'input_text' && part.text) {
          blocks.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          blocks.push({ type: 'input_image', image_url: part.image_url.url });
        } else if (part.type === 'input_image' && part.image_url) {
          blocks.push({ type: 'input_image', image_url: part.image_url });
        }
      }
    } else if (typeof m.content === 'string' && m.content) {
      blocks.push({ type: 'input_text', text: m.content });
    } else if (m.content != null) {
      blocks.push({ type: 'input_text', text: JSON.stringify(m.content) });
    }
    if (blocks.length > 0) {
      input.push({ type: 'message', role, content: blocks });
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
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    };
    if (zenLlm.apiKey) req.headers['Authorization'] = `Bearer ${zenLlm.apiKey}`;
    return req;
  }
  if (ptype === 'openai-responses') {
    // muse-spark 等仅支持 Responses 的模型：直调 Zen /responses。
    // 注意：Zen /chat/completions 对这类模型返回无意义的 500，
    // 而 /responses 要求 input 为规范 item 数组（见 convertMessagesToResponses）。
    const req = buildResponsesRequest(zenLlm, opts, reasoningEffort);
    req.url = `${ZEN_BASE}/responses`;
    req.headers = {
      'Authorization': `Bearer ${zenLlm.apiKey}`,
      'Content-Type': 'application/json'
    };
    return req;
  }
  // google, openai-compat → use Zen's chat/completions for compatibility
  // (Zen exposes /chat/completions that handles routing internally for non-Anthropic models)
  const req = buildOpenAIRequest(zenLlm, opts, reasoningEffort);
  req.url = `${ZEN_BASE}/chat/completions`;
  req.headers = { 'Content-Type': 'application/json' };
  if (zenLlm.apiKey) req.headers['Authorization'] = `Bearer ${zenLlm.apiKey}`;
  return req;
}

// ---- OpenCode Go（订阅版网关，按模型自动路由端点）----
// 端点表（opencode.ai/docs/go）：
//   chat/completions：GLM/Kimi/DeepSeek/MiMo/Hy 等（@ai-sdk/openai-compatible）
//   messages        ：MiniMax M* / Qwen3.x（Anthropic 形状，Bearer 认证）
//   responses       ：GPT-5.x Luna / Grok / Muse Spark（@ai-sdk/openai）
function buildOpencodeGoRequest(llm, opts, reasoningEffort) {
  const apiKey = llm.zenApiKey || llm.apiKey;
  const goLlm = { ...llm, apiKey };
  const m = (llm.model || '').toLowerCase();

  if (/^(minimax-|qwen3\.)/.test(m)) {
    const req = buildAnthropicRequest(goLlm, opts, reasoningEffort);
    req.url = `${OC_GO_BASE}/messages`;
    req.headers = {
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    };
    if (apiKey) req.headers['Authorization'] = `Bearer ${apiKey}`;
    return req;
  }
  if (/^(gpt-5|grok-|muse-spark|codex)/.test(m)) {
    const req = buildResponsesRequest(goLlm, opts, reasoningEffort);
    req.url = `${OC_GO_BASE}/responses`;
    req.headers = { 'Content-Type': 'application/json' };
    if (apiKey) req.headers['Authorization'] = `Bearer ${apiKey}`;
    return req;
  }
  // 默认：chat/completions
  const req = buildOpenAIRequest(goLlm, opts, reasoningEffort);
  req.url = `${OC_GO_BASE}/chat/completions`;
  req.headers = { 'Content-Type': 'application/json' };
  if (apiKey) req.headers['Authorization'] = `Bearer ${apiKey}`;
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
  OC_GO_BASE,
  REASONING_BUDGET_MAP,
  REASONING_EFFORT_LEVELS,
  VARIANT_LABELS,
  FREE_TIER_CORE_TOOLS,
  isAnonymousZen,
  mergeFreeTierTools,
  makeVariantTable,
  anthropicThinkingMode,
  resolveReasoningVariants,
  validateReasoningEffort,
  resolveVariantForRequest,
  zenModelProviderType,
  buildLLMRequest,
  buildOpencodeGoRequest,
  parseLLMResponse,
  parseAnthropicResponse,
  parseResponsesResponse,
  convertMessagesToAnthropic,
  convertMessagesToResponses,
  buildResponsesRequest
};
