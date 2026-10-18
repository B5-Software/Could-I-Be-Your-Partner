/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// User input owns its reply/tool turn. Tool calls and their results are atomic.
// Other assistant replies may be removed independently. Runtime observations stay.
function planMessageEdit(context, selected, scope = 'both') {
  if (!['context', 'both'].includes(scope)) throw new Error('Invalid removal scope');
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 5000 ||
    selected.some((id) => typeof id !== 'string' || !id)
  )
    throw new Error('Select between 1 and 5000 messages');
  const history = context.getHistoryMessages();
  const id = (m) => m.metadata?.messageId;
  const editable = (m) =>
    m &&
    ['user', 'assistant', 'tool'].includes(m.role) &&
    !['context-update', 'compaction-checkpoint'].includes(m.metadata?.kind);
  const byId = new Map(history.filter(editable).map((m) => [id(m), m]));
  if (selected.some((value) => !byId.has(value)))
    throw new Error('A selected message no longer exists. Refresh the conversation.');
  const ids = new Set(selected);
  const user = (m) => m.role === 'user' && editable(m);
  for (let i = 0; i < history.length; i++) {
    if (!user(history[i]) || !ids.has(id(history[i]))) continue;
    for (let j = i + 1; j < history.length && !user(history[j]); j++)
      if (editable(history[j])) ids.add(id(history[j]));
  }
  const calls = new Map(),
    results = new Map();
  for (const message of history) {
    for (const call of message.tool_calls || []) calls.set(call.id, message);
    if (message.role === 'tool') {
      const group = results.get(message.tool_call_id) || [];
      group.push(message);
      results.set(message.tool_call_id, group);
    }
  }
  for (const message of history) {
    if (!ids.has(id(message))) continue;
    const owner = message.role === 'tool' ? calls.get(message.tool_call_id) : message;
    if (!owner) continue;
    ids.add(id(owner));
    for (const call of owner.tool_calls || [])
      for (const result of results.get(call.id) || []) ids.add(id(result));
  }
  const working = context.messages || [];
  const earliest = working.findIndex((m) => ids.has(id(m)));
  const retainedInSummary = working.some((m) =>
    m.metadata?.compactedIds?.some((value) => ids.has(value)),
  );
  return {
    scope,
    ids: [...ids],
    selectedCount: new Set(selected).size,
    affectedCount: ids.size,
    rawContextCount: working.filter((m) => ids.has(id(m))).length,
    retainedInSummary,
    preservedPrefixCount: earliest < 0 ? working.length : earliest,
  };
}
module.exports = { planMessageEdit };
