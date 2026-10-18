/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const URL = 'https://chatgpt.com/backend-api/wham/usage';
function window(value, now) {
  if (!value || !Number.isFinite(value.used_percent)) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, value.used_percent)),
    windowDurationMins: Number.isFinite(value.limit_window_seconds)
      ? value.limit_window_seconds / 60
      : null,
    resetsAt: Number.isFinite(value.reset_at)
      ? value.reset_at
      : Number.isFinite(value.reset_after_seconds)
        ? Math.floor(now / 1000) + value.reset_after_seconds
        : null,
  };
}
function normalizeCodexUsage(data, now = Date.now()) {
  if (!data || typeof data !== 'object') throw new Error('Invalid Codex usage response');
  const rows = [
    { limit_name: 'codex', rate_limit: data.rate_limit },
    ...(data.additional_rate_limits || []),
  ];
  const rateLimitsByLimitId = {};
  for (const row of rows) {
    const id = row.limit_name || row.metered_feature;
    if (!id || ['__proto__', 'prototype', 'constructor'].includes(id)) continue;
    const limit = row.rate_limit;
    if (!limit) continue;
    rateLimitsByLimitId[id] = {
      limitId: id,
      limitName: row.limit_name || id,
      primary: window(limit.primary_window, now),
      secondary: window(limit.secondary_window, now),
      planType: data.plan_type || null,
      allowed: limit.allowed,
      credits: data.credits || null,
    };
  }
  if (!Object.keys(rateLimitsByLimitId).length)
    throw new Error('This account returned no readable Codex quota windows');
  return {
    ok: true,
    rateLimitsByLimitId,
    rateLimits: rateLimitsByLimitId.codex || Object.values(rateLimitsByLimitId)[0],
    rateLimitResetCredits: data.rate_limit_reset_credits
      ? {
          availableCount:
            data.rate_limit_reset_credits.available_count ??
            data.rate_limit_reset_credits.availableCount,
          credits: data.rate_limit_reset_credits.credits?.map((card) => ({
            ...card,
            expiresAt:
              typeof card.expires_at === 'string'
                ? Date.parse(card.expires_at) / 1000
                : (card.expires_at ?? card.expiresAt),
          })),
        }
      : null,
    fetchedAt: now,
    source: 'codex-subscription',
  };
}
async function readCodexUsageHttp({
  token,
  accountId,
  signal,
  fetchImpl = globalThis.fetch,
  consume,
}) {
  if (consume && !/^[a-f0-9-]{36}$/i.test(consume.idempotencyKey || ''))
    throw new Error('Invalid reset request');
  const response = await fetchImpl(
    consume ? URL.replace(/usage$/, 'rate-limit-reset-credits/consume') : URL,
    {
      method: consume ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'User-Agent': 'CIBYP/' + require('../../../package.json').version,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        ...(consume ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(consume
        ? {
            body: JSON.stringify({
              redeem_request_id: consume.idempotencyKey,
              ...(consume.creditId ? { credit_id: consume.creditId } : {}),
            }),
          }
        : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    const error = new Error(
      response.status === 401
        ? 'Codex quota authorization expired; reconnect it in account settings'
        : `Codex usage request failed (HTTP ${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  if (!consume) return normalizeCodexUsage(await response.json());
  // A redemption is never retried, even if the subsequent read fails.
  const redemption = await response.json();
  const limits = await readCodexUsageHttp({ token, accountId, signal, fetchImpl }).catch(
    () => null,
  );
  return { ok: true, redemption, limits };
}
module.exports = { readCodexUsageHttp, normalizeCodexUsage };
