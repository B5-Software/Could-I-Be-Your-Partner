  const sessionPricingCache = new Map();
  function computeSessionCostForModel(agentInstance, model, usage) {
    const pricing = getSessionPricing(agentInstance, model);
    if (!pricing) return null;
    return { ...calculateTokenCost(usage || {}, pricing, agentInstance?.settings?.budget?.peakHours,
      Date.now(), agentInstance?.settings?.budget?.timezone), pricing };
  }

  // 获取当前会话所用模型的单价配置（来自 settings.budget.models）
  // 支持新格式（inputPerM/cacheReadPerM/outputPerM/cacheWritePerM/hasCacheWrite）
  // 和旧格式（promptPerK/completionPerK）回退
  function getSessionPricing(agentInstance, modelId) {
    try {
      const model = modelId || agentInstance?.settings?.llm?.model;
      if (!model) return null;
      const prices = agentInstance?.settings?.budget?.models || {};
      const provider = agentInstance?.llmOverride?.provider || agentInstance?.settings?.llm?.provider;
      const cacheKey = provider + ':' + model;
      const cached = sessionPricingCache.get(cacheKey);
      if (!cached || Date.now() - cached.at > 60000) {
        sessionPricingCache.set(cacheKey, { at: Date.now(), price: cached?.price });
        window.api.llmPricing(model, provider).then(result => {
          sessionPricingCache.set(cacheKey, { at: Date.now(), price: result.source === 'unknown' ? null : result.price });
        }).catch(() => {});
      }
      const p = cached?.price || prices[model];
      if (!p) return null;
      // 优先识别新格式字段
      const hasNew = p.inputPerM != null || p.outputPerM != null || p.cacheReadPerM != null || p.cacheWritePerM != null;
      const hasOld = p.promptPerK != null || p.completionPerK != null;
      if (!hasNew && !hasOld) return null;
      // hasCacheWrite 显式配置优先，否则按模型名推断（Claude 系默认 true）
      const hasCacheWrite = p.hasCacheWrite != null ? !!p.hasCacheWrite : /claude/i.test(model);
      return {
        model,
        inputPerM: p.inputPerM,
        cacheReadPerM: p.cacheReadPerM,
        outputPerM: p.outputPerM,
        cacheWritePerM: p.cacheWritePerM,
        // 旧字段保留以便回退
        promptPerK: p.promptPerK,
        completionPerK: p.completionPerK,
        hasCacheWrite
      };
    } catch { return null; }
  }

  // 模式 agent 未初始化时，用主 agent 的共享系统指导 + 工具定义估算上下文占用，
  // 并渲染完整的上下文 tooltip（对齐 Chat 模式，避免显示 0）
