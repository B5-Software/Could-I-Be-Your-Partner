const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/shared/token-policy');
const { loadSettings, mergeSettings } = require('../../src/main/settings/merge');
const { DEFAULT_SETTINGS } = require('../../src/main/settings/defaults')({
  DEFAULT_DECISION_SETTINGS: {},
});
const { create } = require('../../src/renderer/js/settings-client');
const LLM = require('../../src/main/llm-providers');

test('legacy limits migrate once without losing preferences or the previous stop behavior', () => {
  const old = {
    llm: { dailyMaxTokens: 12345 },
    budget: { monthlyCapUsd: 6, overAction: 'fallback' },
    theme: { mode: 'dark' },
  };
  const s = loadSettings(DEFAULT_SETTINGS, old);
  assert.equal(s.budget.dailyTokenLimit, 12345);
  assert.equal(s.budget.monthlyLimitUSD, 6);
  assert.equal(s.budget.overLimitAction, 'stop');
  assert.equal(s.theme.mode, 'dark');
  assert.equal('dailyMaxTokens' in s.llm, false);
  assert.equal('monthlyCapUsd' in s.budget, false);
  assert.deepEqual(loadSettings(DEFAULT_SETTINGS, s), s);
  assert.equal(old.llm.dailyMaxTokens, 12345);
});

test('selected model capacity, output reserve and tool allowance use one policy', () => {
  const s = loadSettings(DEFAULT_SETTINGS, {
    llm: {
      model: 'large',
      activeEntryId: 'a',
      maxResponseTokens: 8192,
      pool: [
        { id: 'a', model: 'large', contextLength: 131072 },
        { id: 'b', model: 'small', contextLength: 8192 },
      ],
    },
  });
  const limits = policy.resolve(s, { model: 'small', poolEntryId: 'b' });
  assert.equal(limits.contextTokens, 8192);
  assert.equal(limits.outputTokens, 4096);
  assert.equal(limits.inputTokens, 4096);
  assert.equal(limits.toolTokens, 819);
  assert.equal(policy.requestOutput(s, { model: 'small', max_tokens: 20000 }), 4096);
  s.llm.maxContextLength = 200000;
  assert.equal(policy.resolve(s, { poolEntryId: 'b' }).contextTokens, 8192);
  policy.syncActiveEntry(s, { llm: { maxContextLength: 200000 } });
  assert.equal(s.llm.pool[0].contextLength, 200000);
  assert.equal(s.llm.pool[1].contextLength, 8192);
});

test('zero retries survive normalization, invalid values recover, thinking cannot raise the output cap', () => {
  const s = loadSettings(DEFAULT_SETTINGS, {
    llm: { maxRetries: 0, timeoutMs: 0, maxResponseTokens: -1 },
    contextCompaction: { compactionRetries: 0 },
  });
  assert.equal(s.llm.maxRetries, 0);
  assert.equal(s.llm.timeoutMs, 0);
  assert.equal(s.contextCompaction.compactionRetries, 0);
  assert.equal(s.llm.maxResponseTokens, 256);
  const request = LLM.buildLLMRequest(
    {
      provider: 'anthropic-compat',
      model: 'claude-sonnet-4-20250514',
      apiUrl: 'https://example.invalid',
      maxResponseTokens: 8192,
    },
    { messages: [{ role: 'user', content: 'test' }], max_tokens: 30000, reasoningEffort: 'high' },
  );
  assert.equal(request.body.max_tokens, 8192);
  assert.ok(request.body.thinking.budget_tokens < 8192);
  assert.throws(
    () =>
      LLM.buildLLMRequest(
        { provider: 'anthropic-compat', model: 'claude-sonnet-4-20250514', maxResponseTokens: 512 },
        { messages: [], reasoningEffort: 'high' },
      ),
    /1025/,
  );
});

test('concurrent edits write changed fields, preserve siblings and delete price rows', async () => {
  let stored = loadSettings(DEFAULT_SETTINGS, { budget: { models: { old: { inputPerM: 1 } } } });
  const patches = [];
  const client = create({
    getSettings: async () => structuredClone(stored),
    setSettings: async (patch) => {
      patches.push(patch);
      stored = mergeSettings(stored, patch);
      return structuredClone(stored);
    },
  });
  const [model, theme] = await Promise.all([client.read(), client.read()]);
  model.llm.temperature = 1;
  theme.theme.mode = 'dark';
  await Promise.all([client.save(model), client.save(theme)]);
  assert.equal(stored.llm.temperature, 1);
  assert.equal(stored.theme.mode, 'dark');
  assert.deepEqual(Object.keys(patches[0]), ['llm']);
  assert.deepEqual(Object.keys(patches[1]), ['theme']);
  const pricing = await client.read();
  pricing.budget.models = {};
  await client.save(pricing);
  assert.deepEqual(stored.budget.models, {});
});

test('a failed save can be retried and never poisons later settings writes', async () => {
  let stored = { llm: { temperature: 0.7 } },
    fail = true;
  const client = create({
    getSettings: async () => structuredClone(stored),
    setSettings: async (patch) => {
      if (fail) {
        fail = false;
        throw new Error('disk busy');
      }
      stored = mergeSettings(stored, patch);
      return stored;
    },
  });
  const s = await client.read();
  s.llm.temperature = 1;
  await assert.rejects(client.save(s), /disk busy/);
  await client.save(s);
  assert.equal(stored.llm.temperature, 1);
});

test('daily warning cannot mask a monthly stop; all recorded requests share the daily token counter', () => {
  const s = loadSettings(DEFAULT_SETTINGS, {
    budget: { dailyLimitUSD: 10, monthlyLimitUSD: 8, overLimitAction: 'stop' },
  });
  const budget = require('../../src/main/services/budget')({
    getSettings: () => s,
    calculateTokenCost: () => ({ totalCost: 0 }),
  });
  const today = budget.getTodayKeyTZ(s.budget.timezone);
  s.llm.usageHistory = { [today]: { costUSD: 9 } };
  assert.equal(budget.checkBudgetExceeded(s.budget).period, 'monthly');
  assert.equal(budget.checkBudgetExceeded(s.budget).exceeded, true);
  budget.recordTokenUsage({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, 'vision');
  budget.recordTokenUsage(
    { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    'summary',
  );
  assert.equal(s.llm.dailyTokensUsed, 50);
  s.budget.dailyTokenLimit = 50;
  s.budget.overLimitAction = 'warn';
  assert.equal(budget.checkBudgetExceeded(s.budget).kind, 'tokens');
  assert.equal(budget.checkBudgetExceeded(s.budget).action, 'stop');
});

test('text, streaming, visual and compaction IPC all reject a reached daily limit before network calls', async () => {
  const handlers = new Map();
  const settings = loadSettings(DEFAULT_SETTINGS, {
    llm: { model: 'test', apiUrl: 'https://example.invalid' },
  });
  require('../../src/main/ipc/llm')({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getSettings: () => settings,
    resetDailyUsageIfNeeded: () => {},
    checkBudgetExceeded: () => ({
      exceeded: true,
      kind: 'tokens',
      cost: 100,
      limit: 100,
      action: 'stop',
    }),
  });
  for (const name of ['llm:chat', 'llm:chatStream', 'llm:summarize', 'vision:describeImage']) {
    const result = await handlers.get(name)(
      null,
      name.startsWith('vision') ? { dataUrl: 'data:fake', prompt: 'test' } : [],
      {},
    );
    assert.equal(result.code, 'usage_limit_exceeded', name);
  }
});

test('System One accounting and its gate use the same injected budget day boundary', () => {
  const { DecisionService } = require('../../src/main/decision-service');
  const settings = { decision: { dailyMaxCalls: 1 } };
  let day = '2026-09-30';
  const service = new DecisionService({ getSettings: () => settings, getDayKey: () => day });
  service._bumpUsage({});
  assert.equal(settings.decision.usage.date, day);
  assert.equal(service._usageGate(service.config).ok, false);
  day = '2026-10-01';
  assert.equal(service._usageGate(service.config).ok, true);
  service._bumpUsage({});
  assert.deepEqual(settings.decision.usage, { date: day, calls: 1 });
  service.flushPersist();
});

test('external vision respects the output cap and records estimated usage when the provider omits it', async () => {
  const handlers = new Map(),
    records = [],
    originalFetch = global.fetch;
  const settings = loadSettings(DEFAULT_SETTINGS, {
    llm: {
      maxResponseTokens: 512,
      externalVision: { model: 'vision-test', apiUrl: 'https://example.invalid' },
    },
  });
  let body;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'test caption' } }] }),
    };
  };
  try {
    require('../../src/main/ipc/llm')({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getSettings: () => settings,
      resetDailyUsageIfNeeded: () => {},
      checkBudgetExceeded: () => ({ exceeded: false }),
      estimateTokens: (text) => text.length,
      maskLogUrl: () => 'fixture',
      logSnippet: () => '',
      logTs: () => '',
      recordTokenUsage: (usage, model) => records.push({ usage, model }),
      persistSettings: () => {},
      broadcastUsageChanged: () => {},
    });
    const result = await handlers.get('vision:describeImage')(null, {
      dataUrl: 'data:image/png;base64,AAA',
      prompt: 'describe',
    });
    assert.equal(result.ok, true);
    assert.equal(body.max_tokens, 512);
    assert.equal(records[0].model, 'vision-test');
    assert.equal(records[0].usage._estimated, true);
    assert.ok(records[0].usage.prompt_tokens > 0 && records[0].usage.completion_tokens > 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('email resend limits preserve zero and count resends separately from the first request', async () => {
  const { EmailService } = require('../../src/main/email-service');
  const originalInterval = global.setInterval,
    originalTimeout = global.setTimeout,
    originalClear = global.clearInterval;
  try {
    for (const maximum of [0, 2]) {
      let resend,
        checkReply,
        sent = 0;
      global.setInterval = (callback) => {
        resend = callback;
        return 1;
      };
      global.clearInterval = () => {};
      global.setTimeout = (callback) => {
        checkReply = callback;
        return 2;
      };
      const service = new EmailService();
      service.configure({ maxResends: maximum, ownerAddress: 'fixture@example.invalid' });
      service.sendEmail = async () => {
        sent++;
      };
      service.fetchNewEmails = async () => [{ subject: '审批', text: 'reject' }];
      const pending = service.requestApprovalViaEmail('fixture', {}, 'fixture');
      for (let i = 0; i < 4; i++) await resend();
      assert.equal(sent, 1 + maximum);
      await checkReply();
      assert.equal((await pending).approved, false);
    }
  } finally {
    global.setInterval = originalInterval;
    global.setTimeout = originalTimeout;
    global.clearInterval = originalClear;
  }
});
