/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
(function (root) {
  'use strict';
  const number = (value) =>
    Number.isFinite(Number(value)) && value != null ? Math.max(0, Number(value)) : 0;
  function normalize(usage, transport = '') {
    if (!usage || typeof usage !== 'object') return usage;
    const read =
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cache_read_input_tokens;
    const created = number(usage.cache_creation_input_tokens);
    const nativeAnthropic =
      usage.prompt_tokens == null &&
      usage.input_tokens != null &&
      (transport === 'anthropic' || (!usage.input_tokens_details && transport !== 'responses'));
    const prompt =
      number(usage.prompt_tokens ?? usage.input_tokens) +
      (nativeAnthropic ? number(read) + created : 0);
    const completion = number(usage.completion_tokens ?? usage.output_tokens);
    return {
      ...usage,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      ...(usage.output_tokens_details?.reasoning_tokens != null
        ? { reasoning_output_tokens: number(usage.output_tokens_details.reasoning_tokens) }
        : {}),
      ...(read != null
        ? {
            cache_read_input_tokens: number(read),
            prompt_tokens_details: { ...usage.prompt_tokens_details, cached_tokens: number(read) },
          }
        : {}),
      _cacheReported: usage._estimated
        ? false
        : (usage._cacheReported ?? (read != null && Number.isFinite(Number(read)))),
    };
  }
  const api = { normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TokenUsage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
