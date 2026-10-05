/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  const integer = (value, fallback, min, max) => {
    const n = Number(value);
    return Math.max(
      min,
      Math.min(max, Number.isFinite(n) && value !== '' && value != null ? Math.floor(n) : fallback),
    );
  };
  function resolve(settings = {}, override = {}) {
    const llm = settings.llm || {};
    const pool = Array.isArray(llm.pool) ? llm.pool : [];
    const entry = override.poolEntryId
      ? pool.find((e) => e.id === override.poolEntryId)
      : override.model
        ? pool.find((e) => e.model === override.model && (!override.provider || e.provider === override.provider))
        : pool.find((e) => e.id === llm.activeEntryId && e.model === llm.model) ||
          pool.find((e) => e.model === llm.model);
    const providerLimits = (typeof module !== 'undefined' && module.exports
      ? require('./provider-limits') : root.ProviderLimits).resolve({ ...llm, ...(entry || {}), ...override });
    const contextTokens = Math.min(providerLimits.context || Infinity, integer(
      entry?.contextLength || override.contextLength || llm.maxContextLength,
      131072,
      1024,
      2000000,
    ));
    const requestedOutput = integer(llm.maxResponseTokens, 8192, 256, 100000);
    const minimumInput = Math.min(4096, Math.floor(contextTokens / 2));
    const outputTokens = Math.min(providerLimits.output || Infinity, requestedOutput, Math.max(256, contextTokens - minimumInput));
    const inputTokens = Math.min(providerLimits.input || Infinity, contextTokens - outputTokens);
    const requestedTools = integer(settings.toolExposure?.budgetTokens, 4000, 1000, 16000);
    const toolTokens = Math.min(requestedTools, Math.max(512, Math.floor(inputTokens * 0.2)));
    return {
      contextTokens,
      outputTokens,
      inputTokens,
      toolTokens,
      requestedOutput,
      requestedTools,
      providerLimits,
      summaryTokens: Math.min(
        integer(settings.contextCompaction?.summarizeMaxTokens, 2048, 512, 8192),
        outputTokens,
      ),
      source: entry?.contextLength ? 'pool' : override.contextLength ? 'session' : 'default',
    };
  }
  function requestOutput(settings, options = {}) {
    const limits = resolve(settings, options);
    return Math.min(
      limits.outputTokens,
      integer(options.max_tokens, limits.outputTokens, 1, 100000),
    );
  }
  function migratePatch(patch) {
    const result = { ...patch };
    if (patch.budget || patch.llm?.dailyMaxTokens !== undefined) {
      result.budget = { ...(patch.budget || {}) };
      if (result.budget.dailyTokenLimit === undefined && patch.llm?.dailyMaxTokens !== undefined)
        result.budget.dailyTokenLimit = patch.llm.dailyMaxTokens;
      if (result.budget.monthlyLimitUSD === undefined && result.budget.monthlyCapUsd !== undefined)
        result.budget.monthlyLimitUSD = result.budget.monthlyCapUsd;
      if (result.budget.overLimitAction === undefined && result.budget.overAction !== undefined)
        result.budget.overLimitAction = result.budget.overAction;
      if (result.budget.overLimitAction === 'fallback') result.budget.overLimitAction = 'stop';
      delete result.budget.monthlyCapUsd;
      delete result.budget.overAction;
      delete result.budget.fallbackModel;
    }
    if (patch.llm) {
      result.llm = { ...patch.llm };
      delete result.llm.dailyMaxTokens;
      delete result.llm.fallbackModel;
    }
    return result;
  }
  function normalize(settings) {
    const result = { ...settings };
    if (
      settings.llm &&
      ('maxContextLength' in settings.llm || 'maxResponseTokens' in settings.llm)
    ) {
      result.llm = {
        ...settings.llm,
        maxContextLength: integer(settings.llm.maxContextLength, 131072, 1024, 2000000),
        maxResponseTokens: integer(settings.llm.maxResponseTokens, 8192, 256, 100000),
        maxRetries: integer(settings.llm.maxRetries, 10, 0, 50),
        timeoutMs: integer(settings.llm.timeoutMs, 300000, 0, 3600000),
      };
      delete result.llm.dailyMaxTokens;
      delete result.llm.fallbackModel;
    }
    if (settings.budget) {
      result.budget = {
        ...settings.budget,
        dailyTokenLimit: integer(settings.budget.dailyTokenLimit, 0, 0, Number.MAX_SAFE_INTEGER),
      };
      for (const key of ['dailyLimitUSD', 'weeklyLimitUSD', 'monthlyLimitUSD']) {
        const n = Number(settings.budget[key]);
        result.budget[key] = Number.isFinite(n) ? Math.max(0, n) : 0;
      }
      result.budget.overLimitAction = settings.budget.overLimitAction === 'warn' ? 'warn' : 'stop';
      delete result.budget.monthlyCapUsd;
      delete result.budget.overAction;
      delete result.budget.fallbackModel;
    }
    if (settings.contextCompaction) {
      const c = settings.contextCompaction;
      const ratio = (value, fallback, min, max) =>
        Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
      result.contextCompaction = {
        ...c,
        thresholdRatio: ratio(c.thresholdRatio, 0.8, 0.6, 0.95),
        retainRatio: ratio(c.retainRatio, 0.16, 0.05, 0.4),
        compactionRetries: integer(c.compactionRetries, 1, 0, 5),
        summarizeMaxTokens: integer(c.summarizeMaxTokens, 2048, 512, 8192),
      };
    }
    if (settings.toolExposure)
      result.toolExposure = {
        ...settings.toolExposure,
        mode: settings.toolExposure.mode === 'all' ? 'all' : 'adaptive',
        budgetTokens: integer(settings.toolExposure.budgetTokens, 4000, 1000, 16000),
      };
    return result;
  }
  function syncActiveEntry(settings, patch) {
    if (!patch.llm || patch.llm.pool) return;
    const llm = settings.llm;
    const entry = llm.pool?.find((e) => e.id === llm.activeEntryId) || llm.pool?.[0];
    if (!entry) return;
    for (const [key, target] of Object.entries({
      provider: 'provider',
      apiUrl: 'apiUrl',
      apiKey: 'apiKey',
      zenApiKey: 'apiKey',
      model: 'model',
      providerLimits: 'providerLimits',
      reasoningEffort: 'effort',
      maxContextLength: 'contextLength',
    })) {
      const zen = ['opencode-zen', 'opencode-go'].includes(llm.provider);
      if ((key === 'apiKey' && zen) || (key === 'zenApiKey' && !zen)) continue;
      if (Object.hasOwn(patch.llm, key)) entry[target] = llm[key];
    }
  }
  const api = { resolve, requestOutput, migratePatch, normalize, syncActiveEntry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TokenPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
