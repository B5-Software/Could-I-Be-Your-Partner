/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const crypto = require('node:crypto');
const MODES = ['api-equivalent', '5hour', 'weekly', 'monthly', 'urgent'];
function normalizeCodex(result) {
  if (!result?.ok)
    return { ok: false, error: result?.error || 'Subscription usage is unavailable', windows: [] };
  const windows = [];
  const buckets =
    result.rateLimitsByLimitId || (result.rateLimits ? { codex: result.rateLimits } : {});
  for (const [id, bucket] of Object.entries(buckets))
    for (const item of [bucket?.primary, bucket?.secondary].filter(Boolean)) {
      if (!Number.isFinite(item.usedPercent)) continue;
      const minutes = item.windowDurationMins;
      windows.push({
        id,
        label: bucket.limitName || id,
        period:
          minutes === 300
            ? '5hour'
            : minutes === 10080
              ? 'weekly'
              : minutes >= 40320
                ? 'monthly'
                : 'other',
        minutes,
        usedPercent: Math.max(0, Math.min(100, item.usedPercent)),
        resetsAt: Number.isFinite(item.resetsAt) ? item.resetsAt * 1000 : null,
      });
    }
  return { ok: true, windows, fetchedAt: result.fetchedAt };
}
function selectWindow(windows, mode) {
  const list = windows.filter(
    (w) => Number.isFinite(w.usedPercent) && (mode === 'urgent' || w.period === mode),
  );
  return (
    list.sort(
      (a, b) => b.usedPercent - a.usedPercent || (b.resetsAt || 0) - (a.resetsAt || 0),
    )[0] || null
  );
}
class GoUsage {
  constructor(fetchImpl = (...args) => fetch(...args)) {
    this.fetch = fetchImpl;
    this.cache = null;
    this.pending = new Map();
  }
  async read(key, force = false) {
    if (!key)
      return {
        ok: false,
        error: 'Add your OpenCode Go API key in Model & connection settings',
        windows: [],
      };
    const identity = crypto.createHash('sha256').update(key).digest('hex');
    if (!force && this.cache?.identity === identity && Date.now() - this.cache.at < 60000)
      return this.cache.value;
    if (this.pending.has(identity)) return this.pending.get(identity);
    const request = (async () => {
      let value;
      try {
        const response = await this.fetch('https://opencode.ai/zen/go/v1/usage', {
          headers: {
            Authorization: 'Bearer ' + key,
            'User-Agent': 'CIBYP/' + require('../../../package.json').version,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'OpenCode Go key is invalid'
              : response.status === 403
                ? 'OpenCode Go subscription is required'
                : `OpenCode Go usage request failed (${response.status})`,
          );
        const data = await response.json();
        const windows = [];
        for (const [name, period] of [
          ['rolling', '5hour'],
          ['weekly', 'weekly'],
          ['monthly', 'monthly'],
        ]) {
          const item = data.usage?.[name];
          if (
            !item ||
            !Number.isFinite(item.percent) ||
            !['ok', 'rate-limited'].includes(item.status)
          )
            continue;
          windows.push({
            id: 'opencode-go',
            label: 'OpenCode Go',
            period,
            usedPercent: Math.max(0, Math.min(100, item.percent)),
            resetsAt: Number.isFinite(Date.parse(item.resetsAt)) ? Date.parse(item.resetsAt) : null,
          });
        }
        if (!windows.length) throw new Error('OpenCode Go did not provide usage data');
        value = { ok: true, windows, fetchedAt: Date.now() };
      } catch (error) {
        value = { ok: false, error: error.message, windows: [] };
      }
      this.cache = { identity, value, at: Date.now() };
      return value;
    })();
    this.pending.set(identity, request);
    try {
      return await request;
    } finally {
      this.pending.delete(identity);
    }
  }
}
module.exports = { GoUsage, normalizeCodex, selectWindow, MODES };
