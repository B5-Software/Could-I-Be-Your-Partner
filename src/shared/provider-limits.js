/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  function resolve(llm = {}) {
    const freeZen = llm.provider === 'opencode-zen' && llm.providerLimits?.free !== false &&
      (llm.providerLimits?.free === true || /-free$/.test(llm.model || '') || llm.model === 'big-pickle');
    if (!freeZen) return llm.providerLimits || {};
    // A channel's quota is different from the underlying model's advertised window.
    // Unknown free channels use conservative limits until channel metadata is available.
    const limit = llm.providerLimits || {};
    const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
    const context = Math.min(positive(limit.context, 200000), 200000);
    return { ...limit, free: true, conservative: positive(limit.context, 200000) > 200000 || !limit.context, context,
      input: Math.min(positive(limit.input, Math.min(context, 160000)), context),
      output: positive(limit.output, 32000) };
  }
  const api = { resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ProviderLimits = api;
})(typeof window !== 'undefined' ? window : globalThis);
