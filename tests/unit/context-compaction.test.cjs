const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ContextManager } = require('../../src/renderer/js/context-manager');
function fixture(summarizeLLM) {
  const cm = new ContextManager(32768, { api: { summarizeLLM } });
  // ContextManager expects the host as its third constructor argument.
  cm.host = { api: { summarizeLLM } };
  cm.setSystemPrompt('stable system prefix');
  cm.addUserMessage('earlier request '.repeat(500));
  cm.addAssistantMessage('important implementation details '.repeat(500));
  cm.addUserMessage('current request');
  return cm;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('compaction reports live progress and savings, retains transcript and cache replay prefix', async () => {
  const wait = deferred();
  let replay;
  const cm = fixture((messages) => {
    replay = messages;
    return wait.promise;
  });
  const transcript = JSON.stringify(cm.getHistoryMessages());
  const prefix = cm.getMessages();
  const states = [];
  const pending = cm.summarizeWithLLM({ force: true, onProgress: (state) => states.push(state) });
  assert.equal(cm.getStats().compaction.phase, 'running');
  assert.deepEqual(replay.slice(0, -1), prefix.slice(0, replay.length - 1));
  const competing = await cm.summarizeWithLLM({ force: true });
  assert.equal(competing.skipped, true);
  assert.equal(cm.compactionState.phase, 'running');
  wait.resolve({
    ok: true,
    content: 'Retain the user requirement and the confirmed implementation details.',
  });
  assert.equal((await pending).ok, true);
  assert.equal(states.at(-1).phase, 'done');
  assert.ok(states.at(-1).afterTokens < states.at(-1).beforeTokens);
  assert.equal(JSON.stringify(cm.getHistoryMessages()), transcript);
  assert.equal(cm.messages.at(-1).content, 'current request');
});
test('failed or oversized summaries preserve every working message and expose an error', async () => {
  for (const response of [
    { ok: false, error: 'rate limited' },
    { ok: true, content: 'x'.repeat(100000) },
  ]) {
    let calls = 0;
    const cm = fixture(() => {
      calls++;
      return response;
    });
    const before = JSON.stringify(cm.getMessages());
    const result = await cm.summarizeWithLLM({ force: true, maxRetries: 1 });
    assert.equal(result.ok, false);
    assert.equal(calls, 2);
    assert.equal(cm.compactionState.phase, 'error');
    assert.equal(JSON.stringify(cm.getMessages()), before);
  }
});
test('discarded compaction cannot overwrite a reset or release a newer transaction', async () => {
  const waits = [deferred(), deferred()];
  let calls = 0;
  const cm = fixture(() => waits[calls++].promise);
  const old = cm.summarizeWithLLM({ force: true });
  cm.clearWorkingContext();
  cm.addUserMessage('new request '.repeat(500));
  cm.addAssistantMessage('new details '.repeat(500));
  cm.addUserMessage('new tail');
  const current = cm.summarizeWithLLM({ force: true });
  const currentId = cm.compactionLock.id;
  waits[0].resolve({ ok: true, content: 'obsolete summary' });
  assert.equal((await old).skipped, true);
  assert.equal(cm.compactionLock.id, currentId);
  assert.equal(cm._compactionInProgress, true);
  assert.equal(cm.compactionState.phase, 'running');
  assert.ok(cm.messages[0].content.startsWith('new request'));
  waits[1].resolve({ ok: true, content: 'new summary' });
  assert.equal((await current).ok, true);
  assert.ok(cm.messages[0].content.includes('new summary'));
  assert.equal(cm._compactionInProgress, false);
});
test('appends during a summary are preserved while a changed prefix cancels the summary', async () => {
  for (const reset of [false, true]) {
    const wait = deferred();
    const cm = fixture(() => wait.promise);
    const pending = cm.summarizeWithLLM({ force: true });
    if (reset) cm.loadFromHistory([{ role: 'user', content: 'replacement session' }]);
    else cm.addUserMessage('hot update while compacting');
    wait.resolve({ ok: true, content: 'small summary' });
    const result = await pending;
    assert.equal(result.skipped === true, reset);
    assert.equal(
      cm.messages.at(-1).content,
      reset ? 'replacement session' : 'hot update while compacting',
    );
  }
});
test('checkpoint overhead cannot increase the working context', async () => {
  const cm = fixture(() => ({ ok: true, content: 'short' }));
  cm.loadFromHistory([
    { role: 'user', content: 'tiny' },
    { role: 'assistant', content: 'small' },
    { role: 'user', content: 'tail' },
  ]);
  const before = cm.getTotalTokens();
  const result = await cm.summarizeWithLLM({ force: true, maxRetries: 0 });
  assert.equal(result.ok, false);
  assert.equal(cm.getTotalTokens(), before);
});

test('persisted summaries, independent tails and explicit cleared contexts restore without expanding the transcript', async () => {
  const cm = fixture(() => ({ ok: true, content: 'Persist these project constraints.' }));
  const history = cm.getHistoryMessages();
  await cm.summarizeWithLLM({ force: true });
  const payload = JSON.parse(
    JSON.stringify({ history: cm.getHistoryMessages(), state: cm.exportWorkingState() }),
  );
  const restored = new ContextManager(32768);
  restored.loadFromHistory(payload.history, payload.state);
  assert.deepEqual(restored.getMessages(), cm.getMessages());
  assert.deepEqual(restored.getHistoryMessages(), history);
  assert.equal(restored.compactionState.phase, 'done');
  assert.ok(
    restored.getTotalTokens() <
      history.reduce((total, message) => total + restored.estimateMessageTokens(message), 0),
  );
  const tailId = restored.messages.at(-1).metadata.messageId;
  assert.equal(restored.removeHistoryMessages([tailId]).retainedInSummary, false);
  assert.ok(!restored.getMessages().some((m) => m.metadata?.messageId === tailId));
  assert.ok(!restored.getHistoryMessages().some((m) => m.metadata?.messageId === tailId));
  const compactedId = history[0].metadata.messageId;
  const summary = restored.messages[0].content;
  assert.equal(restored.removeHistoryMessages([compactedId]).retainedInSummary, true);
  assert.equal(restored.messages[0].content, summary);
  restored.clearWorkingContext();
  const empty = JSON.parse(JSON.stringify(restored.exportWorkingState()));
  restored.loadFromHistory(restored.getHistoryMessages(), empty);
  assert.equal(restored.messages.length, 0);
  assert.ok(restored.getHistoryMessages().length > 0);
});
