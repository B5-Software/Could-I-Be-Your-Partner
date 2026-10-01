const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { ContextManager } = require('../../src/renderer/js/context-manager');
const TokenUsage = require('../../src/shared/token-usage');

function agentFixture(api = {}) {
  const scope = {
    ContextManager,
    TokenUsage,
    module: { exports: {} },
    window: { api },
    console,
    process,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../../src/renderer/js/agent.js'), 'utf8'),
    scope,
  );
  const agent = new scope.module.exports.Agent();
  agent.settings = { llm: { streamResponses: false }, contextCompaction: { enabled: false } };
  agent.getSystemPrompt = () => 'persona: ' + (agent.settings.aiPersona?.name || 'Original');
  return agent;
}

test('runtime changes are coalesced at provider boundaries and preserve every admitted prefix byte', () => {
  const cm = new ContextManager();
  cm.setSystemPrompt('baseline');
  cm.setContextSource('skills', 'first');
  cm.addUserMessage('task');
  cm.admitContextUpdates();
  const request = JSON.stringify(cm.getMessages());
  const prefix = cm.getMessages().slice();
  cm.setRealBasis(100, 'model');
  cm.setSystemPrompt('temporary');
  cm.setSystemPrompt('latest');
  cm.setContextSource('skills', 'second');
  assert.equal(JSON.stringify(cm.getMessages()), request, 'in-flight request stays unchanged');
  assert.equal(cm.admitContextUpdates(), true);
  assert.deepEqual(cm.getMessages().slice(0, prefix.length), prefix);
  assert.match(cm.getMessages().at(-1).content, /latest/);
  assert.doesNotMatch(cm.getMessages().at(-1).content, /temporary/);
  assert.equal(
    cm.getHistoryMessages().filter((m) => m.metadata?.kind === 'context-update').length,
    1,
  );
  assert.equal(cm.admitContextUpdates(), false, 'unchanged observations never grow context');
  assert.equal(cm.realBasis.promptTokens, 100, 'append-only updates keep the measured baseline');
});

test('measured cache input and last-request reporting survive saving without treating missing usage as a miss', async () => {
  let saved;
  const agent = agentFixture({
    historySave: async (payload) => {
      saved = structuredClone(payload);
    },
  });
  agent.conversationId = 'cache-fixture';
  agent._accumulateUsage(
    {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
    },
    'claude',
  );
  agent._accumulateUsage(
    { prompt_tokens: 200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
    'other',
  );
  agent._accumulateUsage({ prompt_tokens: 300, completion_tokens: 10 }, 'unknown');
  assert.equal(agent.sessionUsage.prompt, 1500);
  assert.equal(agent.sessionUsage.cached, 800);
  assert.equal(agent.sessionUsage.cacheReportedPrompt, 1200);
  assert.equal(agent.sessionUsage.cacheReports, 2);
  assert.equal(agent.sessionUsage.lastCache.reported, false);
  await agent.saveToHistory();
  const restored = agentFixture({});
  await restored.loadFromHistory(saved);
  assert.equal(restored.sessionUsage.cacheReportedPrompt, 1200);
  assert.equal(restored.sessionUsage.lastCache.reported, false);
});

test('unavailable sources retain guidance; explicit removal revokes it; other sessions are isolated', () => {
  const first = new ContextManager();
  const second = new ContextManager();
  for (const cm of [first, second]) {
    cm.setSystemPrompt('baseline');
    cm.setContextSource('skills', 'required guidance');
    cm.admitContextUpdates();
  }
  first.setContextSource('skills', undefined);
  first.setSystemPrompt(null);
  assert.equal(first.admitContextUpdates(), false);
  first.setContextSource('skills', '');
  first.admitContextUpdates();
  assert.match(first.getMessages().at(-1).content, /已撤销/);
  assert.equal(second.getMessages().length, 1);
  assert.match(second.systemPrompt.content, /required guidance/);
});

test('completed compaction refreshes the epoch; working resets and history replay retain the transcript', () => {
  const cm = new ContextManager();
  cm.setSystemPrompt('old');
  cm.setContextSource('todos', 'old task');
  cm.addUserMessage('first');
  cm.addAssistantMessage('first response');
  cm.admitContextUpdates();
  cm.setSystemPrompt('new');
  cm.setContextSource('todos', 'current task');
  cm.admitContextUpdates();
  const transcript = JSON.stringify(cm.getHistoryMessages());
  cm.applyCheckpoint(0, 2, 'summary');
  cm.admitContextUpdates();
  assert.match(cm.systemPrompt.content, /new[\s\S]*current task/);
  assert.equal(cm.messages.filter((m) => m.metadata?.kind === 'context-update').length, 0);
  assert.equal(JSON.stringify(cm.getHistoryMessages()), transcript);
  cm.loadFromHistory(cm.getHistoryMessages());
  cm.admitContextUpdates();
  assert.equal(
    cm.getHistoryMessages().filter((m) => m.metadata?.kind === 'context-update').length,
    1,
  );
  assert.equal(cm.messages.length, 2);
  cm.clearWorkingContext();
  cm.setSystemPrompt('fresh');
  cm.admitContextUpdates();
  assert.match(cm.systemPrompt.content, /^fresh/);
  assert.equal(cm.getHistoryMessages().length, 3);
});

test('Todo edits and batch completion survive saving and reopening, with collision-free IDs', async () => {
  let saved;
  const api = {
    historySave: async (payload) => {
      saved = structuredClone(payload);
    },
  };
  const agent = agentFixture(api);
  agent.conversationId = 'fixture';
  agent.handleTodo({
    operations: [
      { action: 'add', text: 'first' },
      { action: 'add', text: 'second' },
    ],
  });
  agent.handleTodo({ action: 'update', id: 1, text: 'edited' });
  agent.handleTodo({ action: 'toggle', id: 2 });
  await agent.saveToHistory();
  const restored = agentFixture(api);
  await restored.loadFromHistory(saved);
  assert.equal(
    JSON.stringify(restored.todoItems),
    JSON.stringify([
      { id: 1, text: 'edited', done: false },
      { id: 2, text: 'second', done: true },
    ]),
  );
  assert.equal(restored.handleTodo({ action: 'add', text: 'third' }).id, 3);
  assert.equal(restored.handleTodo({ action: 'update', id: 1, text: '   ' }).ok, false);
});

test('skill reload failures retain active bodies and confirmed deletion removes them', async () => {
  let outcome = 'failure';
  const agent = agentFixture({
    listSkills: async () => {
      if (outcome === 'failure') throw new Error('unavailable');
      return outcome === 'delete' ? [] : [{ name: 'guide', prompt: 'new body' }];
    },
  });
  agent.skillsCatalog = [{ name: 'guide', prompt: 'old body' }];
  agent.activeSkills = agent.skillsCatalog.slice();
  await agent.refreshSkillsCatalog();
  assert.equal(agent.activeSkills[0].prompt, 'old body');
  outcome = 'update';
  await agent.refreshSkillsCatalog();
  assert.equal(agent.activeSkills[0].prompt, 'new body');
  outcome = 'delete';
  await agent.refreshSkillsCatalog();
  assert.equal(agent.activeSkills.length, 0);
});

test('workspace refreshes emit only the changed source and retain the last successful observation', async () => {
  let tree = 'first.ts';
  const agent = agentFixture({
    workspaceGetFileTree: async () => {
      if (tree === null) throw new Error('guest unavailable');
      return { ok: true, tree };
    },
  });
  agent.workspacePath = '/workspace/project';
  await agent.observeRuntimeContext();
  const baseline = agent.contextManager.systemPrompt.content;
  tree = 'first.ts\nsecond.ts';
  await agent.observeRuntimeContext();
  const update = agent.contextManager.getMessages().at(-1).content;
  assert.match(update, /second.ts/);
  assert.doesNotMatch(update, /persona: Original/);
  assert.equal(agent.contextManager.systemPrompt.content, baseline);
  const size = agent.contextManager.messages.length;
  tree = null;
  await agent.observeRuntimeContext();
  assert.equal(agent.contextManager.messages.length, size);
  tree = '';
  await agent.observeRuntimeContext();
  assert.match(agent.contextManager.getMessages().at(-1).content, /已撤销/);
});

test('provider requests retain their snapshot while later settings and Todo changes reach the next turn', async () => {
  const requests = [];
  let settle;
  const api = {
    chatLLM: async (messages) => {
      requests.push(structuredClone(messages));
      if (requests.length === 1)
        return new Promise((resolve) => {
          settle = resolve;
        });
      return {
        ok: true,
        data: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] },
      };
    },
  };
  const agent = agentFixture(api);
  agent.getRuntimeToolSchemas = () => [];
  agent.contextManager.addUserMessage('task');
  agent.running = true;
  const run = agent.agentLoop(0);
  while (!settle) await new Promise((resolve) => setImmediate(resolve));
  const first = JSON.stringify(requests[0]);
  agent.applySettings({ ...agent.settings, aiPersona: { name: 'Changed' } });
  agent.handleTodo({ action: 'add', text: 'user edit while streaming' });
  agent.hotMessages.push('continue');
  settle({
    ok: true,
    data: { choices: [{ message: { content: 'first reply' }, finish_reason: 'stop' }] },
  });
  await run;
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests[0]), first);
  assert.match(JSON.stringify(requests[1]), /Changed/);
  assert.match(JSON.stringify(requests[1]), /user edit while streaming/);
  assert.equal(requests[1][0].content, requests[0][0].content, 'baseline prefix remains frozen');
  assert.equal(
    agent.getLatestUserMessageText(),
    '【用户追加消息】continue',
    'runtime source updates are not treated as user intent',
  );
});
