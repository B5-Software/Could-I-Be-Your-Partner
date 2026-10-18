/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCodexUsage,
  readCodexUsageHttp,
} = require('../../src/main/services/codex-usage-http');

test('Codex subscription reader preserves each real window without inventing unavailable values', () => {
  const result = normalizeCodexUsage(
    {
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 24, limit_window_seconds: 18000, reset_at: 1800000000 },
        secondary_window: {
          used_percent: 70,
          limit_window_seconds: 604800,
          reset_after_seconds: 60,
        },
      },
      additional_rate_limits: [
        {
          limit_name: 'model-reserve',
          rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 86400 } },
        },
      ],
    },
    1000000,
  );
  assert.equal(result.rateLimits.primary.windowDurationMins, 300);
  assert.equal(result.rateLimits.secondary.windowDurationMins, 10080);
  assert.equal(result.rateLimits.secondary.resetsAt, 1060);
  assert.equal(result.rateLimitsByLimitId['model-reserve'].primary.resetsAt, null);
  assert.equal(result.rateLimitsByLimitId['model-reserve'].secondary, null);
  assert.equal(result.rateLimits.planType, 'pro');
  assert.throws(() => normalizeCodexUsage({}), /no readable/);
});

test('quota requests carry only their selected credential, reject redirects and suppress token-bearing errors', async () => {
  await assert.rejects(
    readCodexUsageHttp({
      token: 'private-token',
      accountId: 'selected-account',
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['ChatGPT-Account-Id'], 'selected-account');
        assert.equal(options.headers.Authorization, 'Bearer private-token');
        return new Response('private-token', { status: 401 });
      },
    }),
    (error) => error.status === 401 && !error.message.includes('private-token'),
  );
});

test('reset redemption sends exactly one POST even if the follow-up read or response fails', async () => {
  const requests = [];
  const consume = {
    idempotencyKey: '00112233-4455-6677-8899-aabbccddeeff',
    creditId: 'one-credit',
  };
  const fetchImpl = async (_url, options) => {
    requests.push(options);
    if (options.method === 'POST') return Response.json({ outcome: 'reset' });
    throw new Error('Disconnected after redemption');
  };
  const result = await readCodexUsageHttp({ token: 'private', consume, fetchImpl });
  assert.equal(result.redemption.outcome, 'reset');
  assert.equal(result.limits, null);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['POST', 'GET'],
  );
  assert.deepEqual(JSON.parse(requests[0].body), {
    redeem_request_id: consume.idempotencyKey,
    credit_id: 'one-credit',
  });
  let posts = 0;
  await assert.rejects(
    readCodexUsageHttp({
      token: 'private',
      consume,
      fetchImpl: async () => {
        ++posts;
        throw new Error('Ambiguous delivery');
      },
    }),
    /Ambiguous delivery/,
  );
  assert.equal(posts, 1);
});
