const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeSettings, loadSettings } = require('../../src/main/settings/merge');
const { dataPath } = require('../../src/main/core/data-path');
const registerLlm = require('../../src/main/ipc/llm');
const LLMProviders = require('../../src/main/llm-providers');
const createBudgetService = require('../../src/main/services/budget');

test('budget periods use the configured calendar across midnight and daylight saving boundaries', () => {
  const { getBudgetPeriodKeys } = createBudgetService({ getSettings: () => ({}) });
  const midnightInShanghai = new Date('2026-09-27T16:30:00Z');
  assert.deepEqual(
    getBudgetPeriodKeys('weekly', { timezone: 'Asia/Shanghai' }, midnightInShanghai),
    {
      startKey: '2026-09-28',
      endKey: '2026-09-28',
    },
  );
  assert.deepEqual(
    getBudgetPeriodKeys(
      'weekly',
      { timezone: 'Asia/Shanghai', weekMode: 'rolling' },
      midnightInShanghai,
    ),
    {
      startKey: '2026-09-22',
      endKey: '2026-09-28',
    },
  );
  assert.deepEqual(
    getBudgetPeriodKeys(
      'monthly',
      { timezone: 'Asia/Shanghai', monthMode: 'rolling' },
      midnightInShanghai,
    ),
    {
      startKey: '2026-08-30',
      endKey: '2026-09-28',
    },
  );
  const dstTransition = new Date('2026-03-08T08:30:00Z');
  assert.deepEqual(
    getBudgetPeriodKeys('weekly', { timezone: 'America/Los_Angeles' }, dstTransition),
    {
      startKey: '2026-03-02',
      endKey: '2026-03-08',
    },
  );
  assert.deepEqual(getBudgetPeriodKeys('daily', { timezone: 'Invalid/Zone' }, midnightInShanghai), {
    startKey: '2026-09-27',
    endKey: '2026-09-27',
  });
});

test('partial settings preserve nested siblings and never mutate defaults', () => {
  const defaults = {
    llm: { model: 'original', headers: ['first'] },
    runtime: { vm: { memory: 4096, cores: 2 } },
  };
  const merged = mergeSettings(defaults, { runtime: { vm: { cores: 4 } } });
  assert.deepEqual(merged.runtime.vm, { memory: 4096, cores: 4 });
  merged.llm.headers.push('second');
  assert.deepEqual(defaults.llm.headers, ['first']);
  assert.deepEqual(loadSettings(defaults, null), defaults);
  assert.deepEqual(loadSettings(defaults, []), defaults);
  assert.throws(() => mergeSettings(defaults, null), TypeError);
});

test('settings reject prototype pollution and recover invalid nested objects', () => {
  const defaults = { llm: { model: 'original' } };
  const merged = mergeSettings(
    defaults,
    JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"llm":null}',
    ),
  );
  assert.deepEqual(merged.llm, defaults.llm);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(merged, '__proto__'), false);
  assert.equal(Object.hasOwn(merged, 'constructor'), false);
});

test('history and skill IDs cannot escape their data directory', () => {
  const root = path.resolve('tmp-data');
  for (const id of [
    '../settings',
    '..\\settings',
    '.',
    '..',
    'C:\\Windows',
    'name:stream',
    'name\0',
    'name.',
  ]) {
    assert.throws(() => dataPath(root, id, '.json'), /Invalid|outside/);
  }
  assert.equal(dataPath(root, 'session_01-中文', '.json'), path.join(root, 'session_01-中文.json'));
});

test('concurrent LLM calls keep responses isolated and read replaced settings through their getter', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-llm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let settings = {
    llm: {
      provider: 'openai-compat',
      apiUrl: 'https://example.invalid/v1/chat/completions',
      apiKey: '',
      model: 'first',
    },
    budget: {},
  };
  const handlers = new Map();
  let released = 0;
  registerLlm({
    path,
    fs,
    dataDir: dir,
    loadJSON: (_file, fallback) => fallback,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getSettings: () => settings,
    LLMProviders,
    logTs: () => '',
    maskLogUrl: (value) => value,
    logSnippet: (value) => value,
    recordTokenUsage: () => {},
    resetDailyUsageIfNeeded: () => {},
    checkBudgetExceeded: () => ({ exceeded: false }),
    normalizeMessagesForThinking: (messages) => messages,
    getMainWindow: () => null,
    fetchLLMWithRetry: async ({ body }) => ({
      ok: true,
      releaseController: () => released++,
      response: {
        json: async () => {
          await new Promise((resolve) => setTimeout(resolve, body.model === 'first' ? 20 : 1));
          return {
            choices: [{ message: { role: 'assistant', content: body.model } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    }),
    estimateTokens: () => 1,
    persistSettings: () => {},
    broadcastUsageChanged: () => {},
    consumeSSEStream: () => {},
    ocHeaders: {},
  });
  const invoke = (model) =>
    handlers.get('llm:chat')({ sender: {} }, [{ role: 'user', content: 'hello' }], { model });
  const results = await Promise.all([invoke('first'), invoke('second')]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(
    results.map((result) => result.data.choices[0].message.content),
    ['first', 'second'],
  );
  assert.equal(released, 2);
  assert.equal(Object.hasOwn(globalThis, 'rawData'), false);
  settings = { ...settings, llm: { ...settings.llm, model: 'replacement' } };
  const result = await handlers.get('llm:chat')({ sender: {} }, [
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(result.data.choices[0].message.content, 'replacement');
});

test('every feature factory loads without starting Electron or performing registration-time network work', () => {
  const directory = path.resolve(__dirname, '../../src/main/ipc');
  for (const file of fs.readdirSync(directory).filter((file) => file.endsWith('.js'))) {
    assert.equal(typeof require(path.join(directory, file)), 'function', file);
  }
});
