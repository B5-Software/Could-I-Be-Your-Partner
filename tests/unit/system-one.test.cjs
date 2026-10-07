/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DecisionService, normalizeDecisionSettings } = require('../../src/main/decision-service');
const protocol = require('../../src/main/services/system-one-protocol');
const { prepareDecisionPatch } = require('../../src/main/decision-service');
const q = { q: { type: 'noul', instructions: 'Is it ready?' } };
const yes = { answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 5 } };
const response = (data) => ({ ok: true, status: 200, json: async () => data });
function fixture(config = {}, fetchImpl = async () => response(yes)) {
  const settings = {
    decision: {
      enabled: true,
      provider: 'compatible',
      apiUrl: 'http://127.0.0.1:8000/v1/systemone',
      ...config,
    },
  };
  return { settings, svc: new DecisionService({ getSettings: () => settings, fetchImpl }) };
}

test('System One keeps legacy providers and accepts generic provider/capability settings', () => {
  assert.equal(normalizeDecisionSettings().provider, 'zen');
  assert.equal(normalizeDecisionSettings({ provider: 'perplexity' }).provider, 'perplexity');
  assert.equal(normalizeDecisionSettings({ provider: 'local' }).provider, 'compatible');
  assert.equal(
    normalizeDecisionSettings({ capabilities: { score: false } }).capabilities.choice,
    true,
  );
});

test('shared settings changes isolate provider credentials for GUI, TUI and remote clients', () => {
  const previous = {
    provider: 'typesafe',
    apiKey: 'old-secret',
    model: 'old',
    apiUrl: 'https://old.example/api',
    modelsUrl: 'https://old.example/models',
  };
  const patch = prepareDecisionPatch(previous, { provider: 'openrouter' });
  assert.equal(patch.apiKey, '');
  assert.equal(patch.model, '');
  assert.equal(patch.apiUrl, '');
  assert.equal(prepareDecisionPatch(previous, { ...previous, provider: 'openrouter' }).apiKey, '');
  assert.equal(
    prepareDecisionPatch(previous, { provider: 'openrouter', apiKey: 'new-secret' }).apiKey,
    'new-secret',
  );
  assert.equal(prepareDecisionPatch(previous, { model: 'other' }).model, 'other');
});

test('custom local servers receive intact JSON state, optional model and bearer authentication', async () => {
  const requests = [];
  const { svc } = fixture({ apiKey: 'fixture-key' }, async (url, init) => {
    requests.push({ url, init });
    return response(yes);
  });
  const state = { text: '你好', items: [1, 2] };
  assert.equal((await svc.call(state, q)).ok, true);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.state, state);
  assert.equal(Object.hasOwn(body, 'model'), false);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer fixture-key');
  assert.equal(requests[0].init.headers['User-Agent'], undefined);
  assert.equal(requests[0].init.redirect, 'error');
});

test('decision cache isolates endpoints, credentials and JSON state and cannot be mutated by callers', async () => {
  let count = 0;
  const { svc, settings } = fixture({}, async () => {
    count++;
    return response(structuredClone(yes));
  });
  const result = await svc.call({ text: 'one' }, q);
  result.answers.q.noul = 0;
  assert.equal((await svc.call({ text: 'one' }, q)).answers.q.noul, 0.9);
  assert.equal(count, 1);
  await svc.call({ text: 'two' }, q);
  settings.decision.apiUrl = 'http://127.0.0.1:9000/v1/systemone';
  await svc.call({ text: 'one' }, q);
  settings.decision.apiKey = 'other-account';
  await svc.call({ text: 'one' }, q);
  assert.equal(count, 4);
});

test('provider adapters use typed endpoints and unwrap Cloudflare envelopes', async () => {
  for (const provider of ['typesafe', 'openrouter', 'perplexity', 'fastino', 'cloudflare']) {
    let sent;
    const config = {
      provider,
      apiKey: 'fixture',
      apiUrl: '',
      model: provider === 'openrouter' ? 'vendor/decision-model' : '',
    };
    if (provider === 'cloudflare')
      config.apiUrl =
        'https://api.cloudflare.com/client/v4/accounts/fixture/ai/run/@cf/cloudflare/clef-flash';
    const { svc } = fixture(config, async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return response(provider === 'cloudflare' ? { success: true, result: yes } : yes);
    });
    assert.equal((await svc.call('ready', q)).ok, true, provider);
    assert.ok(!sent.url.includes('chat/completions'));
    if (provider === 'perplexity') assert.equal(sent.url, 'https://api.perplexity.ai/v1/decisions');
    if (provider === 'openrouter')
      assert.equal(sent.url, 'https://openrouter.ai/api/alpha/decisions');
    if (provider === 'cloudflare') assert.equal(sent.body.model, 'clef-flash');
  }
});

test('invalid probabilities, missing confidence, foreign choices and scores trigger fallback', async () => {
  for (const noul of [null, '0.9', -0.1, 1.1]) {
    const { svc } = fixture({}, async () => response({ answers: { q: { type: 'noul', noul } } }));
    assert.equal((await svc.noul('state', 'question')).value, null);
  }
  for (const answer of [
    { type: 'choice', choice: 'a' },
    { type: 'choice', choice: 'z', confidence: 1 },
    { type: 'choice', choice: 'a', confidence: null },
  ]) {
    const { svc } = fixture({}, async () => response({ answers: { q: answer } }));
    assert.equal((await svc.choice('state', 'question', { a: 'A', b: 'B' })).value, null);
  }
  const { svc } = fixture({}, async () =>
    response({ answers: { q: { type: 'score', score: 2, confidence: 1 } } }),
  );
  assert.equal((await svc.score('state', 'question', ['Low', 'High'])).value, null);
  const { svc: low } = fixture({}, async () =>
    response({ answers: { q: { type: 'choice', choice: 'a', confidence: 0.2 } } }),
  );
  assert.equal((await low.choice('state', 'question', { a: 'A', b: 'B' })).lowConfidence, true);
});

test('noul-only capability avoids unsupported requests and connection tests use an enabled type', async () => {
  let count = 0;
  const { svc } = fixture({ capabilities: { choice: false, score: false } }, async () => {
    count++;
    return response(yes);
  });
  assert.equal((await svc.choice('state', 'question', { a: 'A' })).value, null);
  assert.equal(count, 0);
  const { svc: choiceOnly } = fixture(
    { capabilities: { noul: false, score: false } },
    async (_, init) => {
      assert.equal(JSON.parse(init.body).questions.alive.type, 'choice');
      return response({ answers: { alive: { type: 'choice', choice: 'yes', confidence: 0.8 } } });
    },
  );
  assert.equal((await choiceOnly.test()).ok, true);
});

test('daily cap reserves slots before concurrent calls, counts failed dispatches and resets at the configured boundary', async () => {
  let release;
  let count = 0;
  const { svc, settings } = fixture({ dailyMaxCalls: 1, cache: false }, async () => {
    count++;
    await new Promise((resolve) => {
      release = resolve;
    });
    throw new Error('offline');
  });
  const first = svc.call('first', q);
  assert.equal((await svc.call('second', q)).ok, false);
  assert.equal(count, 1);
  release();
  await first;
  assert.equal(settings.decision.usage.calls, 1);
  assert.equal((await svc.call('third', q)).ok, false);
  settings.decision.usage.date = '2000-01-01';
  svc.fetchImpl = async () => response(yes);
  assert.equal((await svc.call('new day', q)).ok, true);
  svc.flushPersist();
});

test('model discovery accepts both list contracts, filters decision modality and sends no inference', async () => {
  let sent;
  const { svc, settings } = fixture(
    { provider: 'openrouter', apiUrl: '', apiKey: '', model: '' },
    async (url, init) => {
      sent = { url, init };
      return response({
        data: [
          { id: 'vendor/decision', architecture: { output_modalities: ['decisions'] } },
          { id: 'vendor/chat', architecture: { output_modalities: ['text'] } },
        ],
      });
    },
  );
  assert.deepEqual(
    (await svc.models()).models.map((m) => m.id),
    ['vendor/decision'],
  );
  assert.equal(sent.init.method, 'GET');
  assert.match(sent.url, /output_modalities=decisions/);
  assert.equal(settings.decision.usage, undefined);
  assert.deepEqual(
    protocol
      .parseModels({ models: [{ name: 'local-decider' }, 'other'] }, 'compatible')
      .map((m) => m.id),
    ['local-decider', 'other'],
  );
});

test('discovery never sends an inference key to a different origin and request errors redact keys', async () => {
  const { svc } = fixture(
    { apiKey: 'test-secret', modelsUrl: 'https://public.example/models' },
    async (_, init) => {
      assert.equal(init.headers.Authorization, undefined);
      return response({ models: ['local'] });
    },
  );
  assert.equal((await svc.models()).ok, true);
  const { svc: rejected } = fixture({ apiKey: 'test-secret' }, async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Rejected test-secret' } }),
  }));
  assert.doesNotMatch((await rejected.call('state', q)).error, /test-secret/);
});
