/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const crypto = require('node:crypto');
function candidates(address) {
  const url = new URL(address);
  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error('Use an HTTP or HTTPS API address');
  if (url.username || url.password)
    throw new Error('Place API credentials in the key field, not the URL');
  const exact = /\/responses\/?$/.test(url.pathname)
    ? 'openai-responses'
    : /\/messages\/?$/.test(url.pathname)
      ? 'anthropic-compat'
      : /\/chat\/completions\/?$/.test(url.pathname)
        ? 'openai-compat'
        : null;
  const base = url.pathname
    .replace(/\/(chat\/completions|responses|messages)\/?$/, '')
    .replace(/\/$/, '');
  const formats = exact
    ? [
        exact,
        ...['openai-compat', 'openai-responses', 'anthropic-compat'].filter(
          (item) => item !== exact,
        ),
      ]
    : /anthropic\.com$/.test(url.hostname)
      ? ['anthropic-compat', 'openai-compat', 'openai-responses']
      : ['openai-compat', 'openai-responses', 'anthropic-compat'];
  return formats.map((provider) => {
    const copy = new URL(url);
    copy.pathname =
      (base || '/v1') +
      {
        'openai-compat': '/chat/completions',
        'openai-responses': '/responses',
        'anthropic-compat': '/messages',
      }[provider];
    return { provider, apiUrl: copy.href };
  });
}
class ApiFormatDetector {
  constructor({ providers, fetchImpl = (...args) => fetch(...args), recordUsage = () => {} }) {
    this.providers = providers;
    this.fetch = fetchImpl;
    this.recordUsage = recordUsage;
    this.cache = new Map();
    this.pending = new Map();
  }
  async detect(config) {
    if (!config.apiUrl || !config.model)
      return { ok: false, error: 'Enter an API address and model first' };
    const key = crypto
      .createHash('sha256')
      .update(JSON.stringify([config.apiUrl, config.apiKey, config.model, config.customHeaders]))
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 86400000) return cached.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.probe(config);
    this.pending.set(key, promise);
    try {
      const value = await promise;
      if (value.ok) {
        if (this.cache.size > 100) this.cache.clear();
        this.cache.set(key, { at: Date.now(), value });
      }
      return value;
    } finally {
      this.pending.delete(key);
    }
  }
  async probe(config) {
    for (const candidate of candidates(config.apiUrl)) {
      const request = this.providers.buildLLMRequest(
        { ...config, ...candidate, reasoningEffort: 'off' },
        {
          messages: [{ role: 'user', content: 'Reply OK.' }],
          stream: false,
          max_tokens: 16,
          sessionKey: 'cibyp-format-probe',
        },
      );
      let response;
      try {
        response = await this.fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          redirect: 'error',
          signal: AbortSignal.timeout(12000),
        });
      } catch {
        return { ok: false, error: 'API format detection failed: connection unavailable' };
      }
      const body = await response.json().catch(() => null);
      if (response.ok) {
        const result = this.providers.parseLLMResponse(body, request.transport);
        const message = result?.choices?.[0]?.message;
        if (
          result?.error ||
          (!message?.content && !message?.reasoning_content && !message?.reasoning)
        )
          return { ok: false, error: 'API did not return a supported response' };
        if (result.usage) this.recordUsage(result.usage, config.model, candidate.provider);
        return { ok: true, ...candidate };
      }
      // Never retry an authentication, quota, model availability or ambiguous server error in another format.
      const error = body?.error?.message || body?.message || '';
      if (
        ![404, 405, 415].includes(response.status) &&
        !(
          response.status === 400 &&
          /(?:messages|input|prompt|body|schema|format|endpoint).*(?:required|missing|invalid|unsupported|unknown)|(?:required|missing).*(?:messages|input|prompt)/i.test(
            error,
          )
        )
      )
        return {
          ok: false,
          status: response.status,
          error: `API format detection failed (${response.status})`,
        };
    }
    return {
      ok: false,
      error: 'No supported Chat Completions, Responses or Messages endpoint was found',
    };
  }
}
module.exports = { ApiFormatDetector, candidates };
