/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackendTransport } = require('../../src/main/services/backend-transport');
function fixture() {
  const sessions = new Map(),
    calls = [];
  const runtime = {
    sessions,
    listSessions: () => [...sessions.values()],
    getSession: (key) => sessions.get(key),
    createSession: (options = {}) => {
      const session = {
        key: options.key || String(sessions.size + 1),
        mode: 'chat',
        profile: 'default',
        status: 'idle',
      };
      sessions.set(session.key, session);
      return session;
    },
    sendMessage(key, text) {
      calls.push([key, text]);
      const session = sessions.get(key);
      session.busy = true;
      session.finished = new Promise((resolve) => {
        session.finish = () => {
          session.busy = false;
          resolve({ ok: true });
        };
      });
      return session.finished;
    },
    inject: (key, text) => calls.push(['inject', key, text]),
    stop: (key) => sessions.get(key).finish?.(),
    close: (key) => {
      runtime.stop(key);
      sessions.delete(key);
      return { ok: true };
    },
  };
  return {
    runtime,
    calls,
    transport: createBackendTransport({ getRuntime: () => runtime, publish() {} }),
  };
}
test('automation admission completes before the LLM turn, without a GUI', async () => {
  const { runtime, calls, transport } = fixture();
  const result = await transport.request('automation:dispatch', { prompt: 'work' });
  assert.equal(result.sessionKey, '1');
  assert.equal(runtime.getSession('1').busy, true);
  assert.deepEqual(calls, [['1', 'work']]);
  runtime.stop('1');
});
test('plugin followups wait for the current turn and stop cancels queued messages', async () => {
  const { calls, transport } = fixture();
  const created = await transport.request('ds:agentCreate', { instructions: 'first' });
  const followup = transport.send('ds:pluginAgentMessage', {
    sessionKey: created.sessionKey,
    kind: 'followup',
    text: 'second',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  await transport.send('ds:pluginAgentMessage', { sessionKey: '1', kind: 'stop' });
  await followup;
  assert.equal(calls.length, 1);
  const resumed = await transport.request('ds:agentResume', { sessionId: '1' });
  assert.equal(resumed.sessionKey, '1');
});

test('plugin session setup failures roll back only the newly created session', async () => {
  const { runtime, transport } = fixture();
  const existing = runtime.createSession({ key: 'frontend' });
  runtime.setWorkspace = async () => ({ ok: false, error: 'Workspace is unavailable' });
  await assert.rejects(
    transport.request('ds:agentCreate', { sessionId: 'plugin', cwd: '/missing' }),
    /Workspace is unavailable/,
  );
  assert.equal(runtime.getSession('plugin'), undefined);
  assert.equal(runtime.getSession('frontend'), existing);
  await assert.rejects(
    transport.request('automation:dispatch', { delivery: { mode: 'continue' }, cwd: '/missing' }),
    /Workspace is unavailable/,
  );
  assert.equal(runtime.getSession('frontend'), existing);
});

test('plugin session creation cannot claim an existing frontend key', async () => {
  const { runtime, transport } = fixture();
  const existing = runtime.createSession({ key: 'frontend' });
  await assert.rejects(
    transport.request('ds:agentCreate', { sessionId: 'frontend' }),
    /Session already exists/,
  );
  assert.equal(runtime.getSession('frontend'), existing);
});

test('cancelling plugin setup before admission leaves no session or queued message', async () => {
  const { runtime, calls, transport } = fixture();
  const controller = new AbortController();
  runtime.configureSession = async () => {
    controller.abort(new Error('Cancelled fixture'));
  };
  await assert.rejects(
    transport.request(
      'ds:agentCreate',
      { sessionId: 'plugin', model: 'example', instructions: 'must not send' },
      undefined,
      controller.signal,
    ),
    /Cancelled fixture/,
  );
  assert.equal(runtime.listSessions().length, 0);
  assert.deepEqual(calls, []);
});

test('failed history restoration closes the new session even when the backend throws', async () => {
  const { runtime, transport } = fixture();
  runtime.getHistory = async () => ({ ok: true });
  runtime.openHistory = async () => {
    throw new Error('Unreadable fixture');
  };
  await assert.rejects(
    transport.request('ds:agentResume', { sessionId: 'history' }),
    /Unreadable fixture/,
  );
  assert.equal(runtime.listSessions().length, 0);
});

test('plugin Agent options use a host pool route and preserve reasoning and output limits', async () => {
  const { runtime } = fixture();
  let configured;
  runtime.configureSession = async (_, values) => {
    configured = values;
  };
  const transport = createBackendTransport({
    getRuntime: () => runtime,
    publish() {},
    getSettings: () => ({
      llm: {
        pool: [
          {
            id: 'own-route',
            provider: 'openai-compat',
            model: 'example',
            apiKey: 'must-not-forward',
          },
        ],
      },
    }),
  });
  const response = await transport.request('ds:agentCreate', {
    provider: 'cibyp:own-route',
    reasoningEffort: 'high',
    maxTokens: 2048,
  });
  assert.ok(runtime.getSession(response.sessionKey));
  assert.deepEqual(configured.llmOverride, {
    poolEntryId: 'own-route',
    provider: 'openai-compat',
    model: 'example',
    reasoningEffort: 'high',
    maxResponseTokens: 2048,
  });
  await assert.rejects(
    transport.request('ds:agentCreate', { sessionId: 'bad-route', provider: 'cibyp:missing' }),
    /route is unavailable/,
  );
  assert.equal(runtime.getSession('bad-route'), undefined);
});
