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
    createSession: () => {
      const session = {
        key: String(sessions.size + 1),
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
