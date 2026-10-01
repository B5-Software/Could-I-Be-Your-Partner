/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function createBudgetService({ calculateTokenCost, getSettings }) {
  function getTodayKey(date) {
    return date.toISOString().slice(0, 10);
  }

  // ---- 预算周期：时区感知的日期计算 ----
  // 返回指定时区下当前日期的 YYYY-MM-DD
  function getTodayKeyTZ(timezone, date = new Date()) {
    try {
      const fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return fmt.format(date);
    } catch {
      return getTodayKey(date);
    }
  }

  // 将预算时区的日历日期映射到 UTC，用 UTC 运算避免宿主时区与夏令时影响。
  function getDateAtMidnightTZ(timezone, date) {
    const ref = date || new Date();
    try {
      const todayKey = getTodayKeyTZ(timezone, ref);
      const [y, m, d] = todayKey.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    } catch {
      return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
    }
  }

  // 计算预算周期的 [startKey, endKey]
  // period: 'daily' | 'weekly' | 'monthly'
  // 返回 { startKey, endKey } (YYYY-MM-DD)
  function getBudgetPeriodKeys(period, budget, now = new Date()) {
    const tz = budget?.timezone || 'UTC';
    const weekMode = budget?.weekMode || 'natural'; // 'natural' | 'rolling'
    const monthMode = budget?.monthMode || 'natural'; // 'natural' | 'rolling'
    const todayKey = getTodayKeyTZ(tz, now);
    const todayMidnight = getDateAtMidnightTZ(tz, now);

    if (period === 'daily') {
      return { startKey: todayKey, endKey: todayKey };
    }

    if (period === 'weekly') {
      if (weekMode === 'rolling') {
        // 滚动 7 天：从今天往前推 6 天
        const start = new Date(todayMidnight.getTime() - 6 * 86400000);
        return { startKey: start.toISOString().slice(0, 10), endKey: todayKey };
      } else {
        // 自然周：以预算时区的日历日期找到本周一。
        const dow = todayMidnight.getUTCDay();
        const offset = dow === 0 ? 6 : dow - 1; // 周日=6天前, 周一=0, 周二=1...
        const monday = new Date(todayMidnight.getTime() - offset * 86400000);
        return {
          startKey: monday.toISOString().slice(0, 10),
          endKey: todayKey,
        };
      }
    }

    if (period === 'monthly') {
      if (monthMode === 'rolling') {
        // 滚动 30 天
        const start = new Date(todayMidnight.getTime() - 29 * 86400000);
        return { startKey: start.toISOString().slice(0, 10), endKey: todayKey };
      } else {
        // 自然月：当月 1 日
        const [y, m] = todayKey.split('-').map(Number);
        return {
          startKey: `${y}-${String(m).padStart(2, '0')}-01`,
          endKey: todayKey,
        };
      }
    }

    return { startKey: todayKey, endKey: todayKey };
  }

  // 检查累计限额，返回 { exceeded, kind?, period, level, action }。
  function checkBudgetExceeded(budget) {
    if (!budget) return { exceeded: false };
    const tokenLimit = Number(budget.dailyTokenLimit ?? getSettings().llm?.dailyMaxTokens) || 0;
    const tokensUsed = Number(getSettings().llm?.dailyTokensUsed) || 0;
    if (tokenLimit > 0 && tokensUsed >= tokenLimit)
      return {
        exceeded: true,
        kind: 'tokens',
        period: 'daily',
        cost: tokensUsed,
        limit: tokenLimit,
        level: 'danger',
        action: 'stop',
      };
    const warn = Number(budget.warningThreshold) || 0.8;
    const action = budget.overLimitAction || 'warn';

    const periods = [
      {
        name: 'daily',
        limit: Number(budget.dailyLimitUSD) || 0,
        keys: getBudgetPeriodKeys('daily', budget),
      },
      {
        name: 'weekly',
        limit: Number(budget.weeklyLimitUSD) || 0,
        keys: getBudgetPeriodKeys('weekly', budget),
      },
      {
        name: 'monthly',
        limit: Number(budget.monthlyLimitUSD) || 0,
        keys: getBudgetPeriodKeys('monthly', budget),
      },
    ];

    let warning = null;
    for (const p of periods) {
      if (p.limit <= 0) continue;
      const agg = aggregateUsage(p.keys.startKey, p.keys.endKey);
      const cost = agg.costUSD || 0;
      if (cost >= p.limit) {
        return {
          exceeded: true,
          period: p.name,
          cost,
          limit: p.limit,
          level: 'danger',
          action,
        };
      }
      if (!warning && cost >= p.limit * warn) {
        warning = {
          exceeded: false,
          period: p.name,
          cost,
          limit: p.limit,
          level: 'warn',
          action,
        };
      }
    }
    return warning || { exceeded: false };
  }

  function estimateTokens(text) {
    if (!text) return 0;
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const otherCount = text.length - cjkCount;
    return Math.ceil(cjkCount * 1.5 + otherCount * 0.4);
  }

  /**
   * Record real token usage from API response into per-day history.
   * Stores: { [dateKey]: { totalTokens, promptTokens, completionTokens, requestCount, models, hours: { [0..23]: {...} } } }
   * 支持解析缓存命中 token（OpenAI: prompt_tokens_details.cached_tokens；Anthropic: cache_read_input_tokens + cache_creation_input_tokens）
   * 同时按 settings.budget 中的价格表计算金钱消耗（inputPerM/cacheReadPerM/outputPerM/cacheWritePerM），
   * 并应用峰谷时段倍率（peakHours）。
   */
  function computeUsageCost(usage, model, ts) {
    return calculateTokenCost(
      {
        prompt: usage?.prompt_tokens,
        completion: usage?.completion_tokens,
        cached: usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens,
        cacheCreation: usage?.cache_creation_input_tokens,
      },
      getSettings().budget?.models?.[model || ''] || {},
      getSettings().budget?.peakHours,
      ts ?? Date.now(),
      getSettings().budget?.timezone,
    );
  }

  function recordTokenUsage(usage, model) {
    if (!usage) return;
    // 使用时区感知的日期键，确保与预算周期计算一致
    const tz = getSettings().budget?.timezone || 'UTC';
    const today = getTodayKeyTZ(tz);
    if (!getSettings().llm.usageHistory) getSettings().llm.usageHistory = {};
    if (!getSettings().llm.usageHistory[today]) {
      getSettings().llm.usageHistory[today] = {
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        requestCount: 0,
        models: {},
        hours: {},
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        inputCost: 0,
        cacheReadCost: 0,
        outputCost: 0,
        cacheWriteCost: 0,
      };
    }
    const day = getSettings().llm.usageHistory[today];
    // Older usage records may predate per-model counters.
    day.models ||= {};
    for (const key of ['totalTokens', 'promptTokens', 'completionTokens', 'requestCount'])
      day[key] ||= 0;
    const pt = usage.prompt_tokens || 0;
    const ct = usage.completion_tokens || 0;
    const tt = usage.total_tokens || pt + ct;
    if (getSettings().llm.dailyTokenDate !== today) {
      getSettings().llm.dailyTokenDate = today;
      getSettings().llm.dailyTokensUsed = 0;
    }
    getSettings().llm.dailyTokensUsed = (getSettings().llm.dailyTokensUsed || 0) + tt;
    // 解析缓存命中 token：
    // - OpenAI: usage.prompt_tokens_details.cached_tokens（已命中的 prompt 缓存）
    // - Anthropic: usage.cache_read_input_tokens（已命中） + cache_creation_input_tokens（缓存写入，按 1.25x 计费）
    const cachedTokens =
      usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    // 计算金钱消耗
    const cost = computeUsageCost(usage, model);
    day.totalTokens += tt;
    day.promptTokens += pt;
    day.completionTokens += ct;
    day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
    day.cacheCreationTokens = (day.cacheCreationTokens || 0) + cacheCreationTokens;
    day.inputCost = (day.inputCost || 0) + cost.inputCost;
    day.cacheReadCost = (day.cacheReadCost || 0) + cost.cacheReadCost;
    day.outputCost = (day.outputCost || 0) + cost.outputCost;
    day.cacheWriteCost = (day.cacheWriteCost || 0) + cost.cacheWriteCost;
    day.costUSD = (day.costUSD || 0) + cost.totalCost;
    day.requestCount += 1;
    if (model) {
      if (!day.models[model])
        day.models[model] = {
          total: 0,
          prompt: 0,
          completion: 0,
          count: 0,
          cached: 0,
          cacheCreation: 0,
          costUSD: 0,
          inputCost: 0,
          cacheReadCost: 0,
          outputCost: 0,
          cacheWriteCost: 0,
        };
      day.models[model].total += tt;
      day.models[model].prompt += pt;
      day.models[model].completion += ct;
      day.models[model].cached = (day.models[model].cached || 0) + cachedTokens;
      day.models[model].cacheCreation =
        (day.models[model].cacheCreation || 0) + cacheCreationTokens;
      day.models[model].inputCost = (day.models[model].inputCost || 0) + cost.inputCost;
      day.models[model].cacheReadCost = (day.models[model].cacheReadCost || 0) + cost.cacheReadCost;
      day.models[model].outputCost = (day.models[model].outputCost || 0) + cost.outputCost;
      day.models[model].cacheWriteCost =
        (day.models[model].cacheWriteCost || 0) + cost.cacheWriteCost;
      day.models[model].costUSD = (day.models[model].costUSD || 0) + cost.totalCost;
      day.models[model].count += 1;
    }
    // 按小时统计（用于 daily 周期的按小时图表）
    const hour = new Date().getHours();
    if (!day.hours) day.hours = {};
    if (!day.hours[hour])
      day.hours[hour] = {
        total: 0,
        prompt: 0,
        completion: 0,
        count: 0,
        cached: 0,
        cacheCreation: 0,
        costUSD: 0,
      };
    day.hours[hour].total += tt;
    day.hours[hour].prompt += pt;
    day.hours[hour].completion += ct;
    day.hours[hour].cached = (day.hours[hour].cached || 0) + cachedTokens;
    day.hours[hour].cacheCreation = (day.hours[hour].cacheCreation || 0) + cacheCreationTokens;
    day.hours[hour].costUSD = (day.hours[hour].costUSD || 0) + cost.totalCost;
    day.hours[hour].count += 1;
    // Prune entries older than 90 days to avoid unbounded growth.
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    for (const k of Object.keys(getSettings().llm.usageHistory)) {
      if (k < cutoff) delete getSettings().llm.usageHistory[k];
    }
  }

  /**
   * Aggregate usage over a date range (inclusive of both ends).
   * Returns { totalTokens, promptTokens, completionTokens, requestCount, days: [{date, total, prompt, completion, count, costUSD}], models, cachedTokens, cacheCreationTokens, costUSD, inputCost, cacheReadCost, outputCost, cacheWriteCost }
   */
  function aggregateUsage(startDate, endDate) {
    const result = {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
      days: [],
      models: {},
      cachedTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      inputCost: 0,
      cacheReadCost: 0,
      outputCost: 0,
      cacheWriteCost: 0,
    };
    const hist = getSettings().llm.usageHistory || {};
    const d = new Date(startDate);
    while (d.toISOString().slice(0, 10) <= endDate) {
      const key = d.toISOString().slice(0, 10);
      const entry = hist[key];
      result.days.push({
        date: key,
        total: entry?.totalTokens || 0,
        prompt: entry?.promptTokens || 0,
        completion: entry?.completionTokens || 0,
        count: entry?.requestCount || 0,
        cached: entry?.cachedTokens || 0,
        cacheCreation: entry?.cacheCreationTokens || 0,
        costUSD: entry?.costUSD || 0,
      });
      if (entry) {
        result.totalTokens += entry.totalTokens || 0;
        result.promptTokens += entry.promptTokens || 0;
        result.completionTokens += entry.completionTokens || 0;
        result.requestCount += entry.requestCount || 0;
        result.cachedTokens += entry.cachedTokens || 0;
        result.cacheCreationTokens += entry.cacheCreationTokens || 0;
        result.costUSD += entry.costUSD || 0;
        result.inputCost += entry.inputCost || 0;
        result.cacheReadCost += entry.cacheReadCost || 0;
        result.outputCost += entry.outputCost || 0;
        result.cacheWriteCost += entry.cacheWriteCost || 0;
        for (const [model, m] of Object.entries(entry.models || {})) {
          if (!result.models[model])
            result.models[model] = {
              total: 0,
              prompt: 0,
              completion: 0,
              count: 0,
              cached: 0,
              cacheCreation: 0,
              costUSD: 0,
              inputCost: 0,
              cacheReadCost: 0,
              outputCost: 0,
              cacheWriteCost: 0,
            };
          result.models[model].total += m.total || 0;
          result.models[model].prompt += m.prompt || 0;
          result.models[model].completion += m.completion || 0;
          result.models[model].cached += m.cached || 0;
          result.models[model].cacheCreation += m.cacheCreation || 0;
          result.models[model].costUSD += m.costUSD || 0;
          result.models[model].inputCost += m.inputCost || 0;
          result.models[model].cacheReadCost += m.cacheReadCost || 0;
          result.models[model].outputCost += m.outputCost || 0;
          result.models[model].cacheWriteCost += m.cacheWriteCost || 0;
          result.models[model].count += m.count || 0;
        }
      }
      d.setDate(d.getDate() + 1);
    }
    return result;
  }

  function resetDailyUsageIfNeeded() {
    const tz = getSettings().budget?.timezone || 'UTC';
    const today = getTodayKeyTZ(tz);
    if (getSettings().llm.dailyTokenDate !== today) {
      getSettings().llm.dailyTokenDate = today;
      getSettings().llm.dailyTokensUsed = 0;
    }
    if (getSettings().imageGen.dailyImageDate !== today) {
      getSettings().imageGen.dailyImageDate = today;
      getSettings().imageGen.dailyImagesUsed = 0;
    }
  }

  return {
    getTodayKeyTZ,
    getBudgetPeriodKeys,
    checkBudgetExceeded,
    estimateTokens,
    recordTokenUsage,
    aggregateUsage,
    resetDailyUsageIfNeeded,
  };
};
