/* SPDX-License-Identifier: GPL-3.0-or-later */
// Explicit, manual online smoke test. Never uses stored settings or paid credentials.
const path = require('node:path');
const headers = require('../src/main/opencode-headers');
const providers = require('../src/main/llm-providers');
const { isOpenCodeFreeModel } = require('../src/main/opencode-models');
const { fetchLLMWithRetry, consumeSSEStream } = require('../src/main/llm-retry');

async function main() {
  const model = process.argv[2] || 'mimo-v2.6-flash-free';
  const llm = { provider: 'opencode-zen', model, zenApiKey: '' };
  if (!isOpenCodeFreeModel(llm))
    throw new Error('Choose a free Zen model; paid models are not tested');
  console.log(`Checking anonymous Zen compatibility: ${model}`);
  headers.setOpenCodeSessionStore(path.resolve(__dirname, '../.cache/zen-smoke-sessions.json'));
  await headers.refreshOpenCodeVersion();
  const catalog = await fetch(providers.ZEN_BASE + '/models', {
    signal: AbortSignal.timeout(15000),
  });
  if (!catalog.ok) throw new Error(`Model catalog HTTP ${catalog.status}`);
  const models = await catalog.json();
  if (!models.data?.some((item) => item.id === model))
    throw new Error('Model is absent from the live catalog');
  const req = providers.buildLLMRequest(llm, {
    messages: [{ role: 'user', content: 'Reply with only OK. Do not call tools.' }],
    stream: true,
    max_tokens: 256,
    sessionKey: 'cibyp-zen-online-smoke',
  });
  const result = await fetchLLMWithRetry({
    apiUrl: req.url,
    headers: req.headers,
    body: req.body,
    transport: req.transport,
    strictResponses: req.transport === 'responses',
    options: { maxRetries: 1, timeoutMs: 30000, sessionKey: 'cibyp-zen-online-smoke' },
  });
  if (!result.ok) throw new Error(`HTTP ${result.status}: ${result.error}`);
  try {
    const response = await consumeSSEStream(
      result.response.body,
      () => {},
      'zen-smoke',
      req.transport,
      30000,
      {},
    );
    if (response.error) throw new Error(response.error);
    if (!response.content?.trim())
      throw new Error('Model returned no readable answer within the output budget');
    console.log(
      JSON.stringify(
        {
          ok: true,
          model,
          transport: req.transport,
          answer: response.content,
          usage: response.usage,
        },
        null,
        2,
      ),
    );
  } finally {
    result.releaseController?.();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
