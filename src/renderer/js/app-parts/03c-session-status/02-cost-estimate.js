  function computeSessionCostForModel(agentInstance, model, usage) {
    const pricing = getSessionPricing(agentInstance, model);
    if (!pricing) return null;
    const su = usage || {};
    const toPerM = (v, isPerK) => isPerK ? (Number(v) || 0) * 1000 : (Number(v) || 0);
    const inputPerM = toPerM(pricing.inputPerM ?? pricing.promptPerK, !pricing.inputPerM && !!pricing.promptPerK);
    const cacheReadPerM = pricing.cacheReadPerM != null ? Number(pricing.cacheReadPerM) : inputPerM * 0.1;
    const outputPerM = toPerM(pricing.outputPerM ?? pricing.completionPerK, !pricing.outputPerM && !!pricing.completionPerK);
    const cacheWritePerM = pricing.hasCacheWrite
      ? (pricing.cacheWritePerM != null ? Number(pricing.cacheWritePerM) : inputPerM * 1.25)
      : 0;
    const ph = agentInstance?.settings?.budget?.peakHours || {};
    let inMul = 1, crMul = 1, outMul = 1, cwMul = 1;
    if (ph.enabled) {
      const hour = new Date().getHours();
      const s = Number(ph.start) ?? 0;
      const e = Number(ph.end) ?? 24;
      const isPeak = s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e);
      if (isPeak) {
        inMul = Number(ph.inputMul) || 1;
        crMul = Number(ph.cacheReadMul) || 1;
        outMul = Number(ph.outputMul) || 1;
        cwMul = Number(ph.cacheWriteMul) || 1;
      }
    }
    const nonCachedPrompt = Math.max(0, (su.prompt || 0) - (su.cached || 0) - (su.cacheCreation || 0));
    const inputCost = (nonCachedPrompt / 1e6) * inputPerM * inMul;
    const cacheReadCost = ((su.cached || 0) / 1e6) * cacheReadPerM * crMul;
    const outputCost = ((su.completion || 0) / 1e6) * outputPerM * outMul;
    const cacheWriteCost = ((su.cacheCreation || 0) / 1e6) * cacheWritePerM * cwMul;
    return {
      inputCost, cacheReadCost, outputCost, cacheWriteCost,
      totalCost: inputCost + cacheReadCost + outputCost + cacheWriteCost,
      pricing
    };
  }

  // 获取当前会话所用模型的单价配置（来自 settings.budget.models）
  // 支持新格式（inputPerM/cacheReadPerM/outputPerM/cacheWritePerM/hasCacheWrite）
  // 和旧格式（promptPerK/completionPerK）回退
  function getSessionPricing(agentInstance, modelId) {
    try {
      const model = modelId || agentInstance?.settings?.llm?.model;
      if (!model) return null;
      const prices = agentInstance?.settings?.budget?.models || {};
      const p = prices[model];
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
