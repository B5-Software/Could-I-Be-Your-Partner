/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
let catalog = null;
let fetchedAt = null;
function update(data, timestamp = Date.now()) {
  catalog = data;
  fetchedAt = timestamp;
}
function resolve(model, provider, overrides = {}, billingMode, apiUrl) {
  overrides = overrides || {};
  const keys =
    provider === 'opencode-zen'
      ? ['opencode']
      : provider === 'opencode-go'
        ? ['opencode-go']
        : provider === 'chatgpt-codex'
          ? ['openai']
          : [];
  if (!keys.length && apiUrl) {
    let hostname;
    try {
      hostname = new URL(apiUrl).hostname;
    } catch {
      /* invalid endpoint */
    }
    for (const [key, value] of Object.entries(catalog || {})) {
      try {
        if (new URL(value.api).hostname === hostname) keys.push(key);
      } catch {
        /* catalog without an API endpoint */
      }
    }
  }
  if (!keys.length && !apiUrl) keys.push(provider === 'anthropic-compat' ? 'anthropic' : 'openai');
  const exact = keys.map((key) => catalog?.[key]?.models?.[model]).find(Boolean);
  // Avoid taking another gateway's pricing merely because its model ID matches.
  const cost = exact?.cost;
  const automatic = cost
    ? {
        inputPerM: cost.input,
        outputPerM: cost.output,
        cacheReadPerM: cost.cache_read ?? cost.input,
        cacheWritePerM: cost.cache_write ?? cost.input,
        hasCacheWrite: cost.cache_write != null,
      }
    : {};
  const manual = Object.fromEntries(
    Object.entries(overrides || {})
      .filter(([key, value]) =>
        key === 'hasCacheWrite'
          ? typeof value === 'boolean'
          : ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'].includes(key) &&
            value !== '' &&
            value != null &&
            Number.isFinite(Number(value)) &&
            Number(value) >= 0,
      )
      .map(([key, value]) => [key, key === 'hasCacheWrite' ? value : Number(value)]),
  );
  if (manual.inputPerM == null && Number.isFinite(overrides.promptPerK))
    manual.inputPerM = Math.max(0, overrides.promptPerK * 1000);
  if (manual.outputPerM == null && Number.isFinite(overrides.completionPerK))
    manual.outputPerM = Math.max(0, overrides.completionPerK * 1000);
  const price = { ...automatic, ...manual };
  return {
    price,
    source: Object.keys(manual).length ? 'override' : cost ? 'models.dev' : 'unknown',
    fetchedAt,
    billingMode: billingMode || (provider === 'chatgpt-codex' ? 'subscription' : 'api'),
    apiReference: provider === 'chatgpt-codex',
  };
}
module.exports = { update, resolve };
