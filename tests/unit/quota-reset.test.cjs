const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChatGPTAccounts } = require('../../src/main/services/chatgpt-accounts');
const account = (id) => ({
  id,
  accessToken: 'test-token',
  codexAccountId: id,
  expiresAt: Date.now() + 600000,
  scope: ['chatgpt.tokens.use.direct'],
});
function create(quotaReader) {
  const data = { version: 1, activeId: 'a', accounts: [account('a'), account('b')] };
  return new ChatGPTAccounts({
    vault: { load: async () => data, save: async () => {} },
    quotaReader,
  });
}
const quota = {
  ok: true,
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [
      {
        id: 'card',
        status: 'available',
        resetType: 'codexRateLimits',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      },
    ],
  },
};
test('quota resets require a manual confirmation and never run from a quota read', async () => {
  let consumed = 0;
  const service = create(async (options) => {
    if (options.consume) {
      consumed++;
      return {
        ok: true,
        redemption: { outcome: 'reset' },
        limits: { ok: true, rateLimits: { primary: { usedPercent: 0 } } },
      };
    }
    return quota;
  });
  await service.limits();
  assert.equal(consumed, 0);
  await assert.rejects(service.consumeReset({ accountId: 'a', creditId: 'card' }), /confirmation/);
  assert.equal(
    (await service.consumeReset({ accountId: 'a', creditId: 'card' }, async () => false)).cancelled,
    true,
  );
  assert.equal(consumed, 0);
  await assert.rejects(
    service.consumeReset({ accountId: 'a', creditId: 'unknown' }, async () => true),
    /unavailable/,
  );
  assert.equal(
    (
      await service.consumeReset({ accountId: 'a', creditId: 'card' }, async (detail) => {
        assert.equal(detail.card.id, 'card');
        assert.equal(detail.account.accessToken, undefined);
        return true;
      })
    ).redemption.outcome,
    'reset',
  );
  assert.equal(consumed, 1);
  service.dispose();
});
test('account changes cancel confirmed resets and ambiguous failures preserve idempotency', async () => {
  const keys = [];
  const service = create(async (options) => {
    if (options.consume) {
      keys.push(options.consume.idempotencyKey);
      return { ok: false, error: 'connection lost' };
    }
    return quota;
  });
  await assert.rejects(
    service.consumeReset({ accountId: 'a', creditId: 'card' }, async () => {
      await service.switchAccount('b');
      return true;
    }),
    /changed/,
  );
  assert.equal(keys.length, 0);
  await service.switchAccount('a');
  await service.consumeReset({ accountId: 'a', creditId: 'card' }, async () => true);
  await service.consumeReset({ accountId: 'a', creditId: 'card' }, async () => true);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  service.dispose();
});
