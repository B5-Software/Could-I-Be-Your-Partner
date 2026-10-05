/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatUsage } = require('../../src/shared/usage-indicator');

test('missing subscription quotas and unpriced estimates are explicit, never shown as free capacity', () => {
  for (const language of ['zh-CN', 'en', 'de']) {
    const absent = formatUsage(
      { subscription: true, mode: 'urgent', error: 'Unavailable' },
      language,
    );
    assert.ok(!absent.text.includes('100%'));
    const unpriced = formatUsage(
      {
        subscription: true,
        mode: 'api-equivalent',
        equivalent: { costUSD: 0, pricedRequests: 0, unknownRequests: 1 },
      },
      language,
    );
    assert.equal(unpriced.text, absent.text);
  }
});

test('subscription estimates remain distinct from real limits and flag incomplete pricing', () => {
  const value = formatUsage(
    {
      subscription: true,
      mode: 'api-equivalent',
      equivalent: { costUSD: 2, pricedRequests: 2, unknownRequests: 1 },
      equivalentLimitUSD: 4,
    },
    'en',
  );
  assert.match(value.text, /API equivalent.*2\.0000.*\*/);
  assert.match(value.title, /not a subscription charge/);
  assert.match(value.title, /no reference price/);
  assert.equal(value.pct, 50);
  const quota = formatUsage(
    {
      subscription: true,
      mode: 'weekly',
      selected: { period: 'weekly', usedPercent: 100 },
    },
    'en',
  );
  assert.match(quota.text, /0% remaining/);
  assert.equal(quota.level, 'danger');
});
