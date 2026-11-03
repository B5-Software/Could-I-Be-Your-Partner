/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs'),
  path = require('node:path');
const GoalState = require('../../src/renderer/js/goal-state');
const { ContextManager } = require('../../src/renderer/js/context-manager');
const AgentHostKit = require('../../src/agent/host');
const TokenUsage = require('../../src/shared/token-usage');
function fixture(t, responses) {
  const scope = {
    ContextManager,
    AgentHostKit,
    TokenUsage,
    GoalState,
    console,
    process,
    setTimeout,
    clearTimeout,
    module: { exports: {} },
    window: { api: {} },
    OPENCODE_TOOL_ALIASES: {},
    getAllToolDefinitions: () => [{ name: 'goalComplete', sensitive: false }],
    getToolAuthCategory: () => null,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../../src/renderer/js/agent.js'), 'utf8'),
    scope,
  );
  const api = {};
  const agent = new scope.module.exports.Agent({ host: AgentHostKit.createHeadlessHost({ api }) });
  agent.conversationId = 'goal-test-' + Math.random();
  agent.mode = 'chat';
  agent.settings = { llm: { streamResponses: false }, contextCompaction: { enabled: false } };
  agent.getSystemPrompt = () => 'Stable goal test' + agent.getGoalSteeringSection();
  agent.getRuntimeToolSchemas = () => [];
  agent.getEnabledToolDefinitions = () => [{ name: 'goalComplete', sensitive: false }];
  agent.observeRuntimeContext = async () => {};
  agent.saveToHistory = async () => {};
  agent._repairReasoningContent = () => false;
  const calls = [];
  api.chatLLM = async (messages) => {
    calls.push(JSON.parse(JSON.stringify(messages)));
    const reply = responses[calls.length - 1];
    if (!reply) throw new Error('Unexpected additional model request');
    if (typeof reply === 'function') return reply(agent);
    return {
      ok: true,
      data: {
        choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    };
  };
  agent.contextManager.addUserMessage('Perform the saved objective');
  agent.running = true;
  agent.stopped = false;
  GoalState.setGoal(agent.conversationId, 'Implement and verify the task');
  t.after(() => GoalState.clearGoal(agent.conversationId));
  return { agent, calls };
}
test('a normal final response continues an active goal until the explicit completion tool', async (t) => {
  const { agent, calls } = fixture(t, [
    'First deliverable done; continuing.',
    () => ({
      ok: true,
      data: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'complete-1',
                  type: 'function',
                  function: {
                    name: 'goalComplete',
                    arguments: JSON.stringify({
                      summary: 'Both deliverables were implemented and checked.',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    }),
    'All deliverables verified.',
  ]);
  await agent.agentLoop(agent.runId);
  assert.equal(calls.length, 3);
  assert.equal(GoalState.getGoal(agent.conversationId).status, 'complete');
  assert.ok(
    calls[1].some(
      (m) =>
        m.metadata?.source === 'goal-continuation' ||
        String(m.content).includes('System goal continuation'),
    ),
  );
  assert.equal(
    calls[0][0].content,
    calls[1][0].content,
    'progress counters must not churn the system prefix',
  );
});
test('stop/pause and token budgets stop continuation without claiming completion', async (t) => {
  const { agent, calls } = fixture(t, [
    (a) => {
      a.stop();
      return {
        ok: true,
        data: {
          choices: [{ message: { role: 'assistant', content: 'paused' }, finish_reason: 'stop' }],
        },
      };
    },
  ]);
  await agent.agentLoop(agent.runId);
  assert.equal(calls.length, 1);
  assert.equal(GoalState.getGoal(agent.conversationId).status, 'paused');
  const second = fixture(t, ['Partial work, more remains.']);
  GoalState.getGoal(second.agent.conversationId).tokenBudget = 1;
  await second.agent.agentLoop(second.agent.runId);
  assert.equal(second.calls.length, 1);
  assert.equal(GoalState.getGoal(second.agent.conversationId).status, 'budget_limited');
});
test('goal histories restore safely, reject invalid objectives and require completion evidence', () => {
  const id = 'goal-history';
  GoalState.setGoal(id, 'Persistent objective', 1000);
  GoalState.recordGoalTurn(id);
  GoalState.updateGoalTokens(id, 42);
  const saved = GoalState.exportGoal(id);
  saved.objective = 'not a reference';
  assert.equal(GoalState.getGoal(id).objective, 'Persistent objective');
  GoalState.restoreGoal(id, { ...saved, objective: 'Persistent objective' });
  assert.equal(GoalState.getGoal(id).status, 'paused');
  assert.equal(GoalState.getGoal(id).tokensUsed, 42);
  assert.throws(() => GoalState.completeGoal(id, ''));
  assert.throws(() => GoalState.setGoal(id, ''));
  GoalState.resumeGoal(id);
  GoalState.completeGoal(id, 'Persisted and verified');
  assert.equal(GoalState.getGoal(id).status, 'complete');
  GoalState.clearGoal(id);
});
test('a goal blocks only after the same obstacle on three distinct consecutive model turns', () => {
  const id = 'consecutive-block';
  GoalState.setGoal(id, 'Finish the task');
  GoalState.recordGoalTurn(id);
  GoalState.recordBlockedAttempt(id, 'Waiting for input');
  GoalState.recordBlockedAttempt(id, 'Waiting for input');
  assert.equal(GoalState.getGoal(id).blockedAttempts, 1);
  GoalState.recordGoalTurn(id);
  GoalState.recordGoalTurn(id);
  GoalState.recordBlockedAttempt(id, 'Waiting for input');
  assert.equal(GoalState.getGoal(id).blockedAttempts, 1);
  GoalState.recordGoalTurn(id);
  GoalState.recordBlockedAttempt(id, 'Waiting for input');
  GoalState.recordGoalTurn(id);
  GoalState.recordBlockedAttempt(id, 'Waiting for input');
  assert.equal(GoalState.getGoal(id).status, 'blocked');
  GoalState.resumeGoal(id);
  GoalState.recordBlockedAttempt(id, 'Waiting for input');
  assert.equal(GoalState.getGoal(id).status, 'active');
  assert.equal(GoalState.getGoal(id).blockedAttempts, 1);
  GoalState.clearGoal(id);
});
