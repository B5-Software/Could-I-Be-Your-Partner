/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
const TokenPolicy = require('../../shared/token-policy');

module.exports = function registerLlmIpc({
  path,
  dataDir,
  loadJSON,
  fs,
  ipcMain,
  getSettings,
  LLMProviders,
  logTs,
  maskLogUrl,
  logSnippet,
  recordTokenUsage,
  resetDailyUsageIfNeeded,
  checkBudgetExceeded,
  normalizeMessagesForThinking,
  getMainWindow,
  publishEvent,
  fetchLLMWithRetry,
  estimateTokens,
  persistSettings,
  broadcastUsageChanged,
  consumeSSEStream,
  ocHeaders,
}) {
  function budgetFailure() {
    resetDailyUsageIfNeeded();
    const check = checkBudgetExceeded(getSettings().budget || {});
    if (!check.exceeded || check.action === 'warn') return null;
    const error =
      check.kind === 'tokens'
        ? `每日 Token 用量已达上限（${check.cost} / ${check.limit}）。可在「消费与用量上限」中调整；下一预算日恢复。`
        : `预算超限（${check.period}周期已用 $${check.cost.toFixed(4)} / $${check.limit.toFixed(2)}），已停止接受新请求`;
    return { ok: false, code: 'usage_limit_exceeded', error, limit: check };
  }
  // ---- 模型能力/元数据缓存 + 变体解析（Anthropic /v1/models + models.dev） ----
  const modelCapabilityCache = new Map(); // key -> { capabilities, metadata, ts }
  const MODEL_CAPABILITY_TTL = 10 * 60 * 1000;
  const modelsDevCache = { data: null, fetchedAt: 0 };
  const MODELS_DEV_TTL = 24 * 60 * 60 * 1000;

  function modelsDevCacheFile() {
    return path.join(dataDir, 'models-dev.json');
  }

  async function fetchModelsDevData(force = false) {
    if (!force && modelsDevCache.data && Date.now() - modelsDevCache.fetchedAt < MODELS_DEV_TTL) {
      return modelsDevCache.data;
    }
    if (!force) {
      const cached = loadJSON(modelsDevCacheFile(), null);
      if (
        cached &&
        cached.fetchedAt &&
        cached.data &&
        Date.now() - cached.fetchedAt < MODELS_DEV_TTL
      ) {
        modelsDevCache.data = cached.data;
        modelsDevCache.fetchedAt = cached.fetchedAt;
        return cached.data;
      }
    }
    try {
      const resp = await fetch('https://models.dev/api.json', {
        headers: { 'User-Agent': 'cibyp/1.0' },
        signal: AbortSignal.timeout(12000),
      });
      if (!resp.ok) return modelsDevCache.data || null;
      const data = await resp.json();
      modelsDevCache.data = data;
      modelsDevCache.fetchedAt = Date.now();
      try {
        fs.writeFileSync(
          modelsDevCacheFile(),
          JSON.stringify({ fetchedAt: modelsDevCache.fetchedAt, data }),
          'utf8',
        );
      } catch {
        /* ignore */
      }
      return data;
    } catch {
      return modelsDevCache.data || null;
    }
  }

  function lookupModelsDevModel(data, modelId, provider) {
    if (!data || typeof data !== 'object') return null;
    const wanted = String(modelId || '').toLowerCase();
    if (!wanted) return null;
    const providerKeys =
      provider === 'opencode-go' ? ['opencode-go', 'opencode'] : ['opencode', 'opencode-go'];
    for (const pk of providerKeys) {
      const prov = data[pk];
      const models = prov && (prov.models || null);
      if (!models || typeof models !== 'object') continue;
      if (models[wanted]) return { providerKey: pk, model: models[wanted] };
    }
    for (const [pk, prov] of Object.entries(data)) {
      const models = prov && prov.models;
      if (!models || typeof models !== 'object') continue;
      if (models[wanted]) return { providerKey: pk, model: models[wanted] };
    }
    return null;
  }

  function normalizeAnthropicThinkingCapability(raw) {
    if (!raw) return null;
    const t = raw.thinking || raw.extended_thinking || raw.extendedThinking || null;
    if (!t) return null;
    const out = {};
    if (typeof t.supported === 'boolean') out.supported = t.supported;
    if (
      t.adaptive === true ||
      t.type === 'adaptive' ||
      (Array.isArray(t.supported_types) && t.supported_types.includes('adaptive'))
    ) {
      out.adaptive = true;
      out.type = 'adaptive';
    } else if (t.type === 'legacy' || t.budgetTokens === true || t.budget_tokens === true) {
      out.type = 'legacy';
    }
    return out;
  }

  // 解析 Anthropic /v1/models capabilities.effort（新版官方字段），兼容多种形状
  function normalizeAnthropicEffortCapability(raw) {
    if (!raw) return null;
    const e = raw.effort || raw.reasoning_effort || raw.reasoningEffort || null;
    if (!e) return null;
    const values = Array.isArray(e)
      ? e
      : Array.isArray(e.values)
        ? e.values
        : Array.isArray(e.supported)
          ? e.supported
          : Array.isArray(e.supported_values)
            ? e.supported_values
            : Array.isArray(e.types)
              ? e.types
              : null;
    if (!values || !values.length) return null;
    return { type: 'effort', values };
  }

  /**
   * 拉取模型元数据（models.dev + Anthropic /models），返回 { capabilities, metadata }。
   * 非 Anthropic 端点主要依赖 models.dev；两者都拿不到时返回 null（走硬编码表）。
   */
  async function fetchModelMetadata(provider, model, apiUrl, apiKey) {
    const out = { capabilities: null, metadata: null };
    // 1) models.dev（覆盖 Zen/Go 与常见模型生态）：
    //    有缓存直接用；无缓存最多等 1.5s，其余在后台完成并落盘，避免阻塞设置页
    try {
      let dev = modelsDevCache.data;
      if (!dev) {
        dev = await Promise.race([
          fetchModelsDevData(),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
      }
      const entry = lookupModelsDevModel(dev, model, provider);
      if (entry) {
        const m = entry.model || {};
        out.metadata = {
          reasoning: m.reasoning,
          reasoningOptions: m.reasoning_options || m.reasoningOptions || null,
          contextLength:
            (m.limit && (m.limit.context || m.limit.input)) || m.context_length || null,
          maxOutput: (m.limit && m.limit.output) || null,
          source: `models.dev:${entry.providerKey}`,
        };
      }
    } catch {
      /* ignore */
    }
    // 2) Anthropic /v1/models：thinking 模式 + effort 档位 + 上下文长度
    if (provider === 'anthropic-compat' && apiUrl) {
      try {
        const base = String(apiUrl)
          .replace(/\/messages\/?$/, '')
          .replace(/\/$/, '');
        const modelsUrl = `${base}/models`;
        const headers = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        };
        if (apiKey) headers['x-api-key'] = apiKey;
        const resp = await fetch(modelsUrl, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const data = await resp.json();
          const list = data.data || data.models || data || [];
          const entry =
            (Array.isArray(list) ? list : []).find((x) => String(x.id) === String(model)) ||
            (Array.isArray(list) ? list[0] : null);
          if (entry && entry.capabilities) {
            const thinking = normalizeAnthropicThinkingCapability(entry.capabilities);
            if (thinking) out.capabilities = { thinking };
            const effort = normalizeAnthropicEffortCapability(entry.capabilities);
            out.metadata = out.metadata || {};
            if (effort) out.metadata.reasoningOptions = effort;
            const ctx = (entry.limit && entry.limit.context) || entry.context_length || null;
            if (ctx && !out.metadata.contextLength) out.metadata.contextLength = ctx;
            if (!out.metadata.source) out.metadata.source = 'anthropic:/models';
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (!out.capabilities && !out.metadata) return null;
    return out;
  }

  function getCachedModelMetadata(model, provider, apiUrl, apiKey) {
    const key = `${provider}|${model}|${apiUrl}`;
    const hit = modelCapabilityCache.get(key);
    if (hit && Date.now() - hit.ts < MODEL_CAPABILITY_TTL) return hit;
    // 不阻塞请求：异步预热缓存；首次请求先用模型名推断/硬编码兜底
    fetchModelMetadata(provider, model, apiUrl, apiKey)
      .then((res) => {
        modelCapabilityCache.set(key, {
          capabilities: res ? res.capabilities : null,
          metadata: res ? res.metadata : null,
          ts: Date.now(),
        });
      })
      .catch(() => {});
    return null;
  }

  // ---- IPC: 模型变体能力查询（设置页/命令面板用） ----
  ipcMain.handle('llm:capabilities', async (_, provider, model, apiUrl, apiKey) => {
    try {
      const effectiveProvider = provider || getSettings().llm.provider || 'openai-compat';
      const effectiveModel = model || getSettings().llm.model || '';
      const effectiveUrl = apiUrl || getSettings().llm.apiUrl || '';
      const effectiveKey =
        apiKey !== undefined
          ? apiKey
          : effectiveProvider === 'opencode-zen'
            ? getSettings().llm.zenApiKey
            : getSettings().llm.apiKey;
      const key = `${effectiveProvider}|${effectiveModel}|${effectiveUrl}`;
      let hit = modelCapabilityCache.get(key);
      if (!hit || Date.now() - hit.ts >= MODEL_CAPABILITY_TTL) {
        const res = await fetchModelMetadata(
          effectiveProvider,
          effectiveModel,
          effectiveUrl,
          effectiveKey,
        );
        hit = {
          capabilities: res ? res.capabilities : null,
          metadata: res ? res.metadata : null,
          ts: Date.now(),
        };
        modelCapabilityCache.set(key, hit);
      }
      const table = LLMProviders.resolveReasoningVariants(
        effectiveModel,
        effectiveProvider,
        hit.capabilities,
        hit.metadata,
      );
      return {
        ok: true,
        model: effectiveModel,
        provider: effectiveProvider,
        capabilities: hit.capabilities || null,
        metadata: hit.metadata || null,
        contextLength: (hit.metadata && hit.metadata.contextLength) || null,
        variants: table.variants,
        defaultId: table.defaultId,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- IPC: 外置视觉（纯文本模型的眼睛）----
  // 当主模型不支持多模态时，通过独立配置的 VLM API 描述图片，结果作为文本返回给 Agent。
  // usage 走 recordTokenUsage → 价格表/预算控制/上下文模态框自动纳入。
  ipcMain.handle('vision:describeImage', async (_, { dataUrl, prompt }) => {
    const blocked = budgetFailure();
    if (blocked) return blocked;
    try {
      const ev = getSettings().llm?.externalVision;
      if (!ev || !ev.apiUrl || !ev.model)
        return {
          ok: false,
          error: '外置视觉未配置（需要在 LLM 设置中填写 API URL 和模型名）',
        };
      if (!dataUrl || typeof dataUrl !== 'string') return { ok: false, error: '缺少图片数据' };
      const userText =
        typeof prompt === 'string' && prompt.trim()
          ? prompt.trim()
          : '详细描述这张图片的全部内容（界面元素、文字、图表、物体、布局），供无法直接看图的文本模型使用。';
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ];
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ev.apiKey || ''}`,
      };
      const body = JSON.stringify({
        model: ev.model,
        messages,
        max_tokens: TokenPolicy.requestOutput(getSettings(), { max_tokens: 4096 }),
      });
      // 智能拼接：如果 apiUrl 已含 /chat/completions 则直接用，否则追加
      let url = ev.apiUrl.replace(/\/+$/, '');
      if (!url.endsWith('/chat/completions')) url += '/chat/completions';
      console.log(
        `[VLM ${logTs()}] → POST ${maskLogUrl(url)} model=${ev.model} img:${Math.round(dataUrl.length / 1024)}KB prompt:"${logSnippet(userText, 80)}"`,
      );
      const vlmStartedAt = Date.now();
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const preview = errText.startsWith('<') ? `[HTML ${resp.status}]` : errText.slice(0, 200);
        console.error(
          `[VLM ${logTs()}] ✗ ${resp.status} (${Date.now() - vlmStartedAt}ms) model=${ev.model}: ${preview}`,
        );
        return { ok: false, error: `VLM API ${resp.status}: ${preview}` };
      }
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';
      const usage =
        data.usage?.total_tokens || data.usage?.prompt_tokens || data.usage?.completion_tokens
          ? data.usage
          : {
              prompt_tokens: estimateTokens(userText),
              completion_tokens: estimateTokens(content),
              _estimated: true,
            };
      recordTokenUsage(usage, ev.model);
      console.log(
        `[VLM ${logTs()}] ✓ ${resp.status} (${Date.now() - vlmStartedAt}ms) model=${ev.model} → ${content.length}chars tokens:${usage?.prompt_tokens || '?'}+${usage?.completion_tokens || '?'}=${usage?.total_tokens || '?'}`,
      );
      return {
        ok: true,
        description: content,
        usage: usage
          ? {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
            }
          : null,
      };
    } catch (e) {
      console.error(`[VLM ${logTs()}] ✗ request failed:`, e.message);
      return { ok: false, error: e.message };
    }
  });

  // ---- IPC: LLM API Call (with retry/backoff/timeout) ----
  // 会话级模型覆盖：模型池条目在会话创建时锁定，随每次请求携带 provider/apiUrl/apiKey
  function applySessionModelOverrides(baseLlm, options) {
    if (!options || typeof options !== 'object') return baseLlm;
    const out = { ...baseLlm };
    if (options.contextLength) out.maxContextLength = options.contextLength;
    if (options.provider) out.provider = options.provider;
    if (options.apiUrl) out.apiUrl = options.apiUrl;
    if (options.apiKey !== undefined && options.apiKey !== null && options.apiKey !== '') {
      out.apiKey = options.apiKey;
      if (out.provider === 'opencode-zen' || out.provider === 'opencode-go')
        out.zenApiKey = options.apiKey;
    }
    return out;
  }

  ipcMain.handle('llm:chat', async (event, messages, options = {}) => {
    try {
      const llm = applySessionModelOverrides(getSettings().llm, options);
      if (llm.provider === 'opencode-zen' || llm.provider === 'opencode-go') {
        if (!llm.zenApiKey || !llm.model)
          return { ok: false, error: '请先在设置中配置OpenCode API Key和模型' };
      } else if (!llm.apiUrl || !llm.model) {
        return { ok: false, error: '请先在设置中配置LLM API' };
      }

      const blocked = budgetFailure();
      if (blocked) return blocked;

      // 会话级覆盖优先：/model 或会话锁定的模型池条目（options.model/provider/apiUrl/apiKey）
      const requestModel = options.model || llm.model;
      const requestEffort =
        options.reasoningEffort !== undefined
          ? options.reasoningEffort
          : llm.reasoningEffort || 'off';
      const modelMeta = getCachedModelMetadata(requestModel, llm.provider, llm.apiUrl, llm.apiKey);
      const capabilities = modelMeta ? modelMeta.capabilities : null;
      const variantCheck = LLMProviders.validateReasoningEffort(
        requestEffort,
        requestModel,
        llm.provider,
        capabilities,
        modelMeta ? modelMeta.metadata : null,
      );
      const llmForRequest = { ...llm, model: requestModel, capabilities };
      const req = LLMProviders.buildLLMRequest(llmForRequest, {
        poolEntryId: options.poolEntryId,
        contextLength: options.contextLength,
        messages: normalizeMessagesForThinking(messages),
        tools: options.tools,
        tool_choice: options.tool_choice,
        temperature: options.temperature ?? llm.temperature,
        max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
        response_format: options.response_format || null,
        reasoningEffort: variantCheck.resolved,
        stream: false,
        // OpenCode 官方头组（x-opencode-session/request）所需的会话与请求标识
        sessionKey: options.sessionKey || null,
        requestId: options.requestId || null,
      });

      const retryOpts = {
        maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
        timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
        requestId: options.requestId || null,
        sessionKey: options.sessionKey || null,
      };
      const onRetry = (info) => {
        // 带上 sessionKey，渲染进程各 Agent 据此过滤，避免其他会话的重试气泡串到当前会话
        try {
          publishEvent('llm:retry', {
            ...info,
            sessionKey: options.sessionKey || null,
          });
        } catch {
          /* ignore */
        }
      };

      const result = await fetchLLMWithRetry({
        label: 'LLM:chat',
        apiUrl: req.url,
        apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
        headers: req.headers,
        body: req.body,
        options: retryOpts,
        onRetry,
      });
      if (!result.ok) {
        console.error(
          `[LLM:chat ${logTs()}] ✗ ${llmForRequest.model} ← ${maskLogUrl(req.url)}: ${result.error}`,
        );
        return { ok: false, error: result.error, kind: result.kind };
      }

      let rawData;
      try {
        rawData = await result.response.json();
      } finally {
        if (typeof result.releaseController === 'function') result.releaseController();
      }
      if (rawData.error) {
        console.error(
          `[LLM] ${llmForRequest.model} API error:`,
          JSON.stringify(rawData.error).slice(0, 200),
        );
        return {
          ok: false,
          error: rawData.error.message || JSON.stringify(rawData.error),
        };
      }
      const data = LLMProviders.parseLLMResponse(rawData, req.transport);
      let usage = data.usage || {};
      // API 未返回 usage 时估算并标记（前端用 ~ 前缀显示）
      if (!usage.total_tokens && !usage.prompt_tokens && !usage.completion_tokens) {
        const estPrompt = estimateTokens(JSON.stringify(req.body));
        const estCompletion = estimateTokens(data.choices?.[0]?.message?.content || '');
        usage = {
          prompt_tokens: estPrompt,
          completion_tokens: estCompletion,
          total_tokens: estPrompt + estCompletion,
          _estimated: true,
        };
        data.usage = usage;
      }
      // 终端日志：请求摘要 + 结果截断 + token 用量
      {
        const content = data.choices?.[0]?.message?.content || '';
        const toolCalls = data.choices?.[0]?.message?.tool_calls;
        const reasoning =
          data.choices?.[0]?.message?.reasoning ||
          data.choices?.[0]?.message?.reasoning_content ||
          '';
        const preview =
          typeof content === 'string'
            ? content.slice(0, 120)
            : JSON.stringify(content || '').slice(0, 120);
        const suffix = content.length > 120 ? `…[${content.length} 字符]` : '';
        console.log(
          `[LLM:chat ${logTs()}] ✓ ${llmForRequest.model} finish=${data.choices?.[0]?.finish_reason || '-'} tokens:${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}${usage._estimated ? '(est)' : ''} reasoning=${reasoning.length}chars → "${preview}${suffix}"${toolCalls ? ` | tool_calls:${toolCalls.length}` : ''}`,
        );
      }
      // 按实际请求模型归属（含会话级覆盖）
      recordTokenUsage(usage, llmForRequest.model);
      persistSettings();
      broadcastUsageChanged();
      // 游戏窗口/子窗口调用 LLM 时，把 usage 推送给主渲染器，让其累计到当前会话统计
      // 游戏窗口/子窗口的 LLM 调用回流 usage，供界面侧按会话累计当前统计。
      // 事件经事件总线发布：GUI 窗口 sink 投递给渲染层，无头运行时由订阅者接收；
      // 主窗口自己发起的调用不重复回流。
      const senderWebContents =
        getMainWindow() && !getMainWindow().isDestroyed() ? getMainWindow().webContents : null;
      if (!senderWebContents || event.sender !== senderWebContents) {
        try {
          publishEvent('llm:external-usage', {
            usage,
            model: llmForRequest.model,
            sessionKey: options.sessionKey || null,
          });
        } catch {
          /* ignore */
        }
      }
      // 回填实际模型/变体，供渲染层按模型累计会话统计
      data._meta = {
        model: llmForRequest.model,
        reasoningEffort: variantCheck.resolved,
        variantChanged: variantCheck.changed,
      };
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- IPC: LLM Streaming (with retry/backoff/timeout) ----
  ipcMain.handle('llm:chatStream', async (_, messages, options = {}) => {
    try {
      const llm = applySessionModelOverrides(getSettings().llm, options);
      if (llm.provider === 'opencode-zen' || llm.provider === 'opencode-go') {
        if (!llm.zenApiKey || !llm.model)
          return { ok: false, error: '请先在设置中配置OpenCode API Key和模型' };
      } else if (!llm.apiUrl || !llm.model) {
        return { ok: false, error: '请先在设置中配置LLM API' };
      }

      const blocked = budgetFailure();
      if (blocked) return blocked;
      // 会话级覆盖优先：/model 或会话锁定的模型池条目
      const requestModel = options.model || llm.model;
      const requestEffort =
        options.reasoningEffort !== undefined
          ? options.reasoningEffort
          : llm.reasoningEffort || 'off';
      const modelMeta = getCachedModelMetadata(requestModel, llm.provider, llm.apiUrl, llm.apiKey);
      const capabilities = modelMeta ? modelMeta.capabilities : null;
      const variantCheck = LLMProviders.validateReasoningEffort(
        requestEffort,
        requestModel,
        llm.provider,
        capabilities,
        modelMeta ? modelMeta.metadata : null,
      );
      const llmForRequest = { ...llm, model: requestModel, capabilities };

      const req = LLMProviders.buildLLMRequest(llmForRequest, {
        poolEntryId: options.poolEntryId,
        contextLength: options.contextLength,
        messages: normalizeMessagesForThinking(messages),
        tools: options.tools,
        tool_choice: options.tool_choice,
        temperature: options.temperature ?? llm.temperature,
        max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
        reasoningEffort: variantCheck.resolved,
        stream: true,
        // OpenCode 官方头组（x-opencode-session/request）所需的会话与请求标识
        sessionKey: options.sessionKey || null,
        requestId: options.requestId || null,
      });

      const retryOpts = {
        maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
        timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
        requestId: options.requestId || null,
        sessionKey: options.sessionKey || null,
      };
      const onRetry = (info) => {
        // 带上 sessionKey，渲染进程各 Agent 据此过滤，避免其他会话的重试气泡串到当前会话
        try {
          publishEvent('llm:retry', {
            ...info,
            sessionKey: options.sessionKey || null,
          });
        } catch {
          /* ignore */
        }
      };

      const result = await fetchLLMWithRetry({
        label: 'LLM:stream',
        apiUrl: req.url,
        apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
        headers: req.headers,
        body: req.body,
        options: retryOpts,
        onRetry,
      });
      if (!result.ok) return { ok: false, error: result.error, kind: result.kind };

      let streamResult;
      let lastChunkKey = null;
      const streamStartedAt = Date.now();
      try {
        streamResult = await consumeSSEStream(
          result.response.body,
          (chunk) => {
            try {
              if (chunk.content || chunk.reasoning) {
                const chunkKey =
                  String(chunk.content || '') + '\u0000' + String(chunk.reasoning || '');
                // 丢弃与上一 chunk 完全相同的连续重复（防御流式传输双发导致的逐字/逐词重复）
                if (chunkKey === lastChunkKey) return;
                lastChunkKey = chunkKey;
                publishEvent('llm:stream-chunk', {
                  content: chunk.content || '',
                  reasoning: chunk.reasoning || '',
                  streamTimeout: chunk.streamTimeout || false,
                  requestId: options.requestId,
                  sessionKey: options.sessionKey || null,
                });
              }
            } catch {
              /* ignore */
            }
          },
          options.requestId,
          req.transport,
          120000,
          {
            label: 'LLM:stream',
            model: llmForRequest.model,
          },
        );
      } finally {
        // 流读取结束（正常完成或被 abort）后释放 controller
        if (typeof result.releaseController === 'function') result.releaseController();
      }

      publishEvent('llm:stream-end', {
        requestId: options.requestId,
        sessionKey: options.sessionKey || null,
      });
      let usage = streamResult.usage || {};
      let estimated = false;
      // API 未返回 usage 时估算并标记
      if (!usage.total_tokens && !usage.prompt_tokens && !usage.completion_tokens) {
        const estPrompt = estimateTokens(JSON.stringify(req.body));
        const estCompletion = estimateTokens(streamResult.content || '');
        usage = {
          prompt_tokens: estPrompt,
          completion_tokens: estCompletion,
          total_tokens: estPrompt + estCompletion,
          _estimated: true,
        };
        estimated = true;
      }
      recordTokenUsage(usage, llmForRequest.model);
      persistSettings();
      broadcastUsageChanged();
      return {
        ok: true,
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: streamResult.content,
                reasoning: streamResult.reasoning || undefined,
                tool_calls: streamResult.toolCalls,
              },
              finish_reason: streamResult.finishReason,
            },
          ],
          usage: { ...usage, _estimated: estimated },
          _meta: {
            model: llmForRequest.model,
            reasoningEffort: variantCheck.resolved,
            variantChanged: variantCheck.changed,
          },
        },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- IPC: LLM Summary (one-shot, no tools, for context compaction) ----
  ipcMain.handle('llm:summarize', async (_, messages, options = {}) => {
    try {
      const blocked = budgetFailure();
      if (blocked) return blocked;
      const llm = applySessionModelOverrides(getSettings().llm, options);
      if (llm.provider === 'opencode-zen' || llm.provider === 'opencode-go') {
        if (!llm.zenApiKey || !llm.model) return { ok: false, error: '请先配置OpenCode' };
      } else if (!llm.apiUrl || !llm.model) {
        return { ok: false, error: '请先在设置中配置LLM API' };
      }

      // 会话级覆盖：压缩摘要与主请求同模型/同变体，复用暖前缀缓存
      const requestModel = options.model || llm.model;
      const requestEffort =
        options.reasoningEffort !== undefined
          ? options.reasoningEffort
          : llm.reasoningEffort || 'off';
      const modelMeta = getCachedModelMetadata(requestModel, llm.provider, llm.apiUrl, llm.apiKey);
      const capabilities = modelMeta ? modelMeta.capabilities : null;
      const variantCheck = LLMProviders.validateReasoningEffort(
        requestEffort,
        requestModel,
        llm.provider,
        capabilities,
        modelMeta ? modelMeta.metadata : null,
      );
      const llmForRequest = { ...llm, model: requestModel, capabilities };
      const req = LLMProviders.buildLLMRequest(llmForRequest, {
        poolEntryId: options.poolEntryId,
        contextLength: options.contextLength,
        messages: normalizeMessagesForThinking(messages),
        temperature: options.temperature ?? 0.3,
        max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
        stream: false,
        // 上下文压缩的"会话回放"：携带与主请求一致的 tools，复用暖前缀缓存
        // （DeepSeek 按输入前缀逐字节匹配；tools 位于前缀内）。
        tools: Array.isArray(options.tools) && options.tools.length > 0 ? options.tools : undefined,
        // purpose 仅作归属标记（对应 dsh 的 x-deepseek-harness-compact 语义），
        // 不改动模型可见内容，各 provider 忽略即可。
        purpose: options.purpose || undefined,
        reasoningEffort: variantCheck.resolved,
        // OpenCode 官方头组所需的会话与请求标识
        sessionKey: options.sessionKey || null,
        requestId: options.requestId || null,
      });
      const retryOpts = {
        maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
        timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
        sessionKey: options.sessionKey || null,
      };
      const result = await fetchLLMWithRetry({
        label: 'LLM:summarize',
        apiUrl: req.url,
        apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
        headers: req.headers,
        body: req.body,
        options: retryOpts,
      });
      if (!result.ok) return { ok: false, error: result.error, kind: result.kind };
      let rawData;
      try {
        rawData = await result.response.json();
      } finally {
        if (typeof result.releaseController === 'function') result.releaseController();
      }
      if (rawData.error)
        return {
          ok: false,
          error: rawData.error.message || JSON.stringify(rawData.error),
        };
      const data = LLMProviders.parseLLMResponse(rawData, req.transport);
      const content = data.choices?.[0]?.message?.content || '';
      let usage = data.usage || {};
      if (!usage.total_tokens && !usage.prompt_tokens && !usage.completion_tokens) {
        const estPrompt = estimateTokens(JSON.stringify(req.body));
        const estCompletion = estimateTokens(content);
        usage = {
          prompt_tokens: estPrompt,
          completion_tokens: estCompletion,
          total_tokens: estPrompt + estCompletion,
          _estimated: true,
        };
      }
      console.log(
        `[LLM:summarize ${logTs()}] ✓ ${llmForRequest.model} tokens:${usage.prompt_tokens || 0}+${usage.completion_tokens || 0}=${usage.total_tokens || 0}${usage._estimated ? '(est)' : ''} summary=${content.length}chars`,
      );
      recordTokenUsage(usage, llmForRequest.model);
      persistSettings();
      broadcastUsageChanged();
      data._meta = {
        model: llmForRequest.model,
        reasoningEffort: variantCheck.resolved,
        variantChanged: variantCheck.changed,
      };
      return { ok: true, content, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- IPC: 精确 token 计数（Tier1，Anthropic messages 协议支持 count_tokens）----
  const _countTokensUnsupported = new Set();
  ipcMain.handle('llm:countTokens', async (_, payload = {}) => {
    try {
      const llm = getSettings().llm || {};
      const provider = llm.provider || '';
      const model = payload.model || llm.model || '';
      const apiUrl = payload.apiUrl || llm.apiUrl || '';
      if (!apiUrl || !model) return { ok: false, unsupported: true, error: 'missing apiUrl/model' };
      const isMessagesEndpoint = /\/messages(\?|$)/.test(apiUrl);
      const looksAnthropic =
        isMessagesEndpoint ||
        provider === 'anthropic-compat' ||
        provider === 'opencode-zen' ||
        provider === 'opencode-go';
      if (!looksAnthropic)
        return {
          ok: false,
          unsupported: true,
          error: 'count_tokens unsupported for this provider',
        };
      let countUrl;
      if (isMessagesEndpoint)
        countUrl = apiUrl.replace(/\/messages(\?.*)?$/, '/messages/count_tokens');
      else if (/\/chat\/completions(\?|$)/.test(apiUrl))
        countUrl = apiUrl.replace(/\/chat\/completions(\?.*)?$/, '/messages/count_tokens');
      else countUrl = apiUrl.replace(/\/+$/, '') + '/messages/count_tokens';
      if (_countTokensUnsupported.has(countUrl))
        return { ok: false, unsupported: true, error: 'cached unsupported' };
      const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      const apiKey = payload.apiKey || llm.apiKey || llm.zenApiKey || '';
      if (provider === 'opencode-zen' || provider === 'opencode-go')
        headers['Authorization'] = `Bearer ${apiKey || 'public'}`;
      else if (apiKey) headers['x-api-key'] = apiKey;
      const finalHeaders = ocHeaders.applyProviderHeaders({
        url: countUrl,
        headers,
        llm: { ...llm, customHeaders: llm.customHeaders || [] },
        sessionKey: payload.sessionKey || 'count',
      });
      const body = {
        model,
        messages: Array.isArray(payload.messages) ? payload.messages : [],
      };
      if (payload.system) body.system = String(payload.system);
      if (Array.isArray(payload.tools) && payload.tools.length) body.tools = payload.tools;
      const resp = await fetch(countUrl, {
        method: 'POST',
        headers: finalHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (
        resp.status === 404 ||
        resp.status === 400 ||
        resp.status === 405 ||
        resp.status === 501
      ) {
        _countTokensUnsupported.add(countUrl);
        return { ok: false, unsupported: true, error: `HTTP ${resp.status}` };
      }
      const data = await resp.json().catch(() => null);
      const tokens = data && (data.input_tokens ?? data.tokens ?? data.total_tokens);
      if (!resp.ok || !Number.isFinite(Number(tokens))) {
        return {
          ok: false,
          error: (data && data.error && data.error.message) || `HTTP ${resp.status}`,
        };
      }
      return { ok: true, tokens: Number(tokens), model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- IPC: OpenCode models list（mode: 'zen'（默认）| 'go'）----
  ipcMain.handle('zen:fetchModels', async (_, mode) => {
    try {
      const isGo = mode === 'go' || mode === 'opencode-go';
      const base = isGo ? LLMProviders.OC_GO_BASE : LLMProviders.ZEN_BASE;
      const modelsUrl = `${base}/models`;
      const apiKey = getSettings().llm.zenApiKey;
      const baseHeaders = { 'Content-Type': 'application/json' };
      if (apiKey) baseHeaders['Authorization'] = `Bearer ${apiKey}`;
      // 自动附加 OpenCode 官方头组 + 用户自定义头
      const headers = ocHeaders.applyProviderHeaders({
        url: modelsUrl,
        headers: baseHeaders,
        llm: getSettings().llm,
      });
      // 10 秒超时，避免网络挂起导致向导永远卡在"正在获取模型列表..."
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      let resp;
      try {
        resp = await fetch(modelsUrl, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return {
          ok: false,
          error: `HTTP ${resp.status}: ${txt.slice(0, 200)}`,
        };
      }
      const data = await resp.json();
      return { ok: true, models: data.data || data.models || data };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, error: '请求超时（10s），请检查网络连接' };
      return { ok: false, error: e.message };
    }
  });

  // ---- IPC: Generic LLM models list (OpenAI/Anthropic compatible) ----
  ipcMain.handle('llm:fetchModels', async (_, provider, apiUrl, apiKey) => {
    try {
      if (!provider || !apiUrl) return { ok: false, error: '缺少 provider 或 apiUrl' };
      let modelsUrl = '';
      const headers = { 'Content-Type': 'application/json' };
      if (provider === 'anthropic-compat') {
        // Anthropic: 从 /v1/messages 推导 /v1/models
        const base = apiUrl.replace(/\/messages\/?$/, '');
        modelsUrl = base.replace(/\/$/, '') + '/models';
        headers['x-api-key'] = apiKey || '';
        headers['anthropic-version'] = '2023-06-01';
      } else if (provider === 'openai-responses') {
        // OpenAI Responses API: 从 /v1/responses 推导 /v1/models
        let base = apiUrl;
        base = base.replace(/\/responses\/?$/, '');
        if (!/\/v\d+\/?$/.test(base)) base = base.replace(/\/$/, '') + '/v1';
        modelsUrl = base.replace(/\/$/, '') + '/models';
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      } else {
        // OpenAI 兼容: 从 /chat/completions 推导 /models
        let base = apiUrl;
        // 去掉 /chat/completions 后缀
        base = base.replace(/\/chat\/completions\/?$/, '');
        base = base.replace(/\/completions\/?$/, '');
        // 如果没有 /v1 后缀，加上
        if (!/\/v\d+\/?$/.test(base)) base = base.replace(/\/$/, '') + '/v1';
        modelsUrl = base.replace(/\/$/, '') + '/models';
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      }
      // 统一套用：用户自定义请求头 + URL 命中 opencode.ai 时自动官方头组
      const finalHeaders = ocHeaders.applyProviderHeaders({
        url: modelsUrl,
        headers,
        llm: getSettings().llm,
      });
      const resp = await fetch(modelsUrl, {
        headers: finalHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return {
          ok: false,
          error: `HTTP ${resp.status}: ${txt.slice(0, 200)}`,
        };
      }
      const data = await resp.json();
      return { ok: true, models: data.data || data.models || data };
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError')
        return { ok: false, error: '请求超时（10s），请检查网络或 API URL' };
      return { ok: false, error: e.message };
    }
  });

  return { fetchModelsDevData };
};
