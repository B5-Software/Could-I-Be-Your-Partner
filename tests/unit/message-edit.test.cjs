/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ContextManager } = require('../../src/renderer/js/context-manager');
const { planMessageEdit } = require('../../src/main/services/message-edit');

test('context removal groups tool protocols and preserves the exact prefix and independent transcript', () => {
  const context = new ContextManager();
  context.setSystemPrompt('Stable system prefix');
  context.addUserMessage('keep');
  context.addAssistantMessage('keep reply');
  context.addUserMessage('remove');
  context.addAssistantMessage('', [
    { id: 'a', type: 'function', function: { name: 'readFile', arguments: '{}' } },
    { id: 'b', type: 'function', function: { name: 'readFile', arguments: '{}' } },
  ]);
  context.addToolResult('a', 'readFile', 'result a');
  context.addToolResult('b', 'readFile', 'result b');
  context.addAssistantMessage('final');
  const original = context.messages.slice(),
    prefix = JSON.stringify(original.slice(0, 2)),
    system = context.systemPrompt;
  const plan = planMessageEdit(context, [original[4].metadata.messageId], 'context');
  assert.equal(plan.affectedCount, 3, 'one result selects both calls and their sibling results');
  assert.equal(plan.preservedPrefixCount, 3);
  context.removeHistoryMessages(plan.ids, { keepHistory: true });
  assert.equal(context.systemPrompt, system);
  assert.equal(JSON.stringify(context.messages.slice(0, 2)), prefix);
  assert.equal(context.messages[0], original[0]);
  assert.equal(context.getHistoryMessages().length, original.length);
  assert.equal(context.getHistoryMessages().filter((m) => m.metadata.contextExcluded).length, 3);
  const saved = { messages: context.getHistoryMessages(), working: context.exportWorkingState() };
  context.loadFromHistory(saved.messages, saved.working);
  assert.ok(!context.messages.some((m) => m.role === 'tool' || m.tool_calls));
  context.loadFromHistory(saved.messages);
  assert.ok(
    !context.messages.some((m) => m.role === 'tool' || m.tool_calls),
    'legacy reload must not reintroduce removed context',
  );
});

test('multi-turn deletion retains summaries and rejects stale IDs or hidden runtime messages', () => {
  const context = new ContextManager();
  context.addUserMessage('one');
  context.addAssistantMessage('one reply');
  context.addUserMessage('two');
  context.addAssistantMessage('two reply');
  const history = context.getHistoryMessages(),
    id = history[0].metadata.messageId;
  const checkpoint = {
    role: 'assistant',
    content: 'Retained summary',
    metadata: { kind: 'compaction-checkpoint', compactedIds: [id] },
  };
  context.messages = [checkpoint, ...context.messages.slice(2)];
  const plan = planMessageEdit(context, [id, history[2].metadata.messageId]);
  assert.equal(plan.retainedInSummary, true);
  assert.equal(plan.affectedCount, 4);
  context.removeHistoryMessages(plan.ids);
  assert.deepEqual(context.messages, [checkpoint]);
  assert.equal(context.messages[0], checkpoint);
  assert.equal(context.getHistoryMessages().length, 0);
  assert.throws(() => planMessageEdit(context, [id]), /no longer exists/);
  context.addMessage({ role: 'user', content: 'runtime', metadata: { kind: 'context-update' } });
  assert.throws(
    () => planMessageEdit(context, [context.getHistoryMessages()[0].metadata.messageId]),
    /no longer exists/,
  );
});
