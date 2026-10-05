const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  GoUsage,
  normalizeCodex,
  selectWindow,
} = require('../../src/main/services/subscription-usage');
test('Go reads all real windows with private fixed-endpoint authorization and coalesces refreshes', async () => {
  let calls = 0;
  const reader = new GoUsage(async (url, options) => {
    calls++;
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer private');
    return new Response(
      JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent: 30, resetsAt: '2026-10-05T05:00:00Z' },
          weekly: { status: 'ok', percent: 90 },
          monthly: { status: 'rate-limited', percent: 100 },
        },
      }),
    );
  });
  const [a, b] = await Promise.all([reader.read('private'), reader.read('private')]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.windows.length, 3);
  assert.equal(selectWindow(a.windows, 'urgent').period, 'monthly');
  assert.equal(selectWindow(a.windows, '5hour').usedPercent, 30);
  assert.ok(!JSON.stringify(a).includes('private'));
  await reader.read('private');
  assert.equal(calls, 1);
  await reader.read('private', true);
  assert.equal(calls, 2);
});
test('quota absence is never converted to zero and Codex preserves independent buckets', async () => {
  assert.equal((await new GoUsage(async () => new Response('{}')).read('key')).ok, false);
  const normalized = normalizeCodex({
    ok: true,
    rateLimitsByLimitId: {
      a: {
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 100 },
        secondary: { usedPercent: null, windowDurationMins: 10080 },
      },
      b: { primary: { usedPercent: 80, windowDurationMins: 10080 } },
    },
  });
  assert.equal(normalized.windows.length, 2);
  assert.equal(normalized.windows[0].resetsAt, 100000);
  assert.equal(selectWindow(normalized.windows, 'weekly').id, 'b');
  assert.equal(selectWindow(normalized.windows, 'monthly'), null);
});
