/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Plugins and automations use the same owner whether or not a GUI is attached.
function createBackendTransport({ getRuntime, publish, getSettings = () => ({}) }) {
  const queued = new Map(),
    generations = new Map();
  const handles = (channel) =>
    [
      'automation:dispatch',
      'ds:agentCreate',
      'ds:agentResume',
      'ds:pluginAgentMessage',
      'ds:approvalRequest',
      'ds:questionsRequest',
      'ds:agentClose',
      'ds:compact',
    ].includes(channel);
  function runtime() {
    const value = getRuntime();
    if (!value) throw new Error('Shared backend is not ready');
    return value;
  }
  function metadata(owner, key) {
    const s = owner.getSession(key);
    return {
      sessionKey: key,
      id: s.conversationId || key,
      title: s.title,
      status: s.status,
      mode: s.mode,
      cwd: s.workspacePath,
    };
  }
  function admit(owner, key, text) {
    const maximum = Math.max(1, Number(getSettings().sessions?.maxConcurrent) || 10);
    if (
      !owner.getSession(key)?.busy &&
      owner.listSessions().filter((s) => s.busy).length >= maximum
    )
      throw new Error('Maximum concurrent sessions reached');
    owner
      .sendMessage(key, String(text || ''))
      .then((result) => {
        if (!result.ok) publish('notifications:toast', { type: 'error', message: result.error });
      })
      .catch((error) => publish('notifications:toast', { type: 'error', message: error.message }));
  }
  async function request(channel, payload = {}, _timeoutMs, signal) {
    signal?.throwIfAborted();
    const owner = runtime();
    if (channel === 'ds:approvalRequest') return owner.requestPluginApproval(payload, signal);
    if (channel === 'ds:questionsRequest') return owner.requestPluginQuestions(payload, signal);
    if (channel === 'ds:agentClose') return owner.close(payload.sessionKey);
    if (channel === 'ds:compact')
      return (await owner.agentAction(payload.sessionKey, 'compactNow', [payload.focus])).result;
    if (channel === 'ds:agentResume') {
      let session = owner
        .listSessions()
        .find(
          (s) =>
            s.key === payload.sessionId || String(s.conversationId) === String(payload.sessionId),
        );
      if (!session) {
        const history = await owner.getHistory('chat', payload.sessionId);
        if (!history || history.ok === false) throw new Error('Conversation does not exist');
        session = owner.createSession({ mode: 'chat' });
        try {
          const result = await owner.openHistory(session.key, payload.sessionId);
          if (!result.ok) throw new Error(result.error);
          signal?.throwIfAborted();
        } catch (error) {
          await owner.close(session.key);
          throw error;
        }
      }
      return metadata(owner, session.key);
    }
    let session;
    if (channel === 'automation:dispatch' && payload.delivery?.mode === 'continue')
      session = owner
        .listSessions()
        .filter((s) => s.mode === 'chat' && s.profile === 'default')
        .at(-1);
    const created = !session;
    if (created) {
      // createSession reuses a matching key. A plugin must never accidentally
      // claim an existing frontend conversation or close it during rollback.
      if (channel === 'ds:agentCreate' && payload.sessionId && owner.getSession(payload.sessionId))
        throw new Error('Session already exists');
      session = owner.createSession({
        mode: 'chat',
        ...(channel === 'ds:agentCreate' && payload.sessionId ? { key: payload.sessionId } : {}),
      });
    }
    try {
      if (payload.cwd) {
        const result = await owner.setWorkspace(session.key, payload.cwd);
        if (!result.ok) throw new Error(result.error);
      }
      if (
        payload.model ||
        payload.provider ||
        payload.reasoningEffort !== undefined ||
        payload.maxTokens !== undefined
      ) {
        const pool = getSettings().llm?.pool || [];
        const routeId = payload.provider?.startsWith('cibyp:')
          ? payload.provider.slice(6)
          : undefined;
        const entry = pool.find(
          (e) =>
            e.enabled !== false &&
            (routeId
              ? e.id === routeId
              : e.model === payload.model &&
                (!payload.provider ||
                  payload.provider === 'cibyp' ||
                  e.provider === payload.provider)),
        );
        if (routeId && !entry) throw new Error('Plugin model pool route is unavailable');
        if (
          payload.maxTokens !== undefined &&
          (!Number.isSafeInteger(payload.maxTokens) || payload.maxTokens < 1)
        )
          throw new Error('Invalid plugin output token limit');
        await owner.configureSession(session.key, {
          llmOverride: {
            ...(entry
              ? { poolEntryId: entry.id, model: entry.model, provider: entry.provider }
              : {}),
            ...(payload.model ? { model: payload.model } : {}),
            ...(payload.provider && payload.provider !== 'cibyp' && !routeId
              ? { provider: payload.provider }
              : {}),
            ...(payload.reasoningEffort !== undefined
              ? { reasoningEffort: payload.reasoningEffort }
              : {}),
            ...(payload.maxTokens !== undefined ? { maxResponseTokens: payload.maxTokens } : {}),
          },
        });
      }
      if (payload.seedMessages)
        await owner.configureSession(session.key, { pluginSeed: payload.seedMessages });
      signal?.throwIfAborted();
      const text = channel === 'automation:dispatch' ? payload.prompt : payload.instructions;
      if (text) admit(owner, session.key, text);
      // Acknowledgement means accepted, rather than waiting for a whole LLM turn.
      return metadata(owner, session.key);
    } catch (error) {
      if (created) await owner.close(session.key);
      throw error;
    }
  }
  async function send(channel, payload = {}) {
    if (channel !== 'ds:pluginAgentMessage') {
      publish(channel, payload);
      return;
    }
    const owner = runtime();
    const session = owner
      .listSessions()
      .find(
        (s) =>
          s.key === payload.sessionKey || String(s.conversationId) === String(payload.sessionKey),
      );
    if (!session) throw new Error('Conversation does not exist');
    const key = session.key;
    if (payload.kind === 'stop') {
      generations.set(key, (generations.get(key) || 0) + 1);
      return owner.stop(key);
    }
    if (payload.kind === 'inject') return owner.inject(key, String(payload.text || ''));
    const generation = generations.get(key) || 0;
    const operation = (queued.get(key) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        while (owner.sessions.get(key)?.busy) await owner.sessions.get(key).finished;
        if ((generations.get(key) || 0) !== generation || !owner.getSession(key)) return;
        const maximum = Math.max(1, Number(getSettings().sessions?.maxConcurrent) || 10);
        if (owner.listSessions().filter((s) => s.busy).length >= maximum)
          throw new Error('Maximum concurrent sessions reached');
        const result = await owner.sendMessage(key, String(payload.text || ''));
        if (result?.ok === false) throw new Error(result.error || 'Agent turn failed');
        return result;
      });
    queued.set(key, operation);
    operation
      .finally(() => {
        if (queued.get(key) === operation) queued.delete(key);
      })
      .catch(() => {});
    return operation;
  }
  return { handles, request, send };
}
module.exports = { createBackendTransport };
