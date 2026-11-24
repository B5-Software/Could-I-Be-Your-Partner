/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-quant-questions-'));
const entry = process.argv.includes('--bundled')
  ? path.resolve('dist/node-core/core.cjs')
  : require.resolve('../../src/agent/node-host');
const name = 'quant_ask_user';
const questions = [
  { question: 'What horizon?', options: ['Day', 'Week'], custom: false },
  { question: 'Which assets?', options: ['ETH', 'USDC'], multiSelect: true, custom: false },
  { question: 'What else should the research consider?' },
];
let host;
const request = (action, input = {}) =>
  host.dispatch({ method: 'quant:request', args: [action, input] });
const events = [];
const received = [];
let modelCalls = 0;

async function open() {
  host = await require(entry).createNodeRuntime({
    dataDir: profile,
    workspaceRoot: path.join(profile, 'workspaces'),
    settings: {
      onboardingCompleted: true,
      features: { quant: false },
      language: 'en',
      runtime: { location: 'host' },
      automaticMemory: { enabled: false },
      decision: { enabled: false },
      llm: {
        provider: 'openai-compat',
        model: 'public-fixture',
        apiUrl: 'https://fixture.invalid/v1/chat/completions',
        streamResponses: false,
      },
    },
  });
  host.eventBus.subscribe('agent:session-event', (event) => events.push(event));
  host.api.chatLLM = async (messages, options) => {
    const research = options?.tools?.some((tool) => tool.function.name === name);
    const prompt =
      typeof messages.findLast((message) => message.role === 'user')?.content === 'string'
        ? messages.findLast((message) => message.role === 'user').content
        : '';
    const callId = prompt.includes('cold') ? 'question-cold' : 'question-live';
    const previous = messages.filter(
      (message) => message.role === 'tool' && message.tool_call_id === callId,
    );
    let message = { role: 'assistant', content: 'Research continued.' };
    if (research) {
      modelCalls++;
      assert.ok(prompt.includes('questionnaire fixture'));
      assert.ok(previous.length <= 1);
      if (previous.length) {
        received.push(JSON.parse(previous[0].content));
      } else {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name, arguments: JSON.stringify({ questions }) },
            },
          ],
        };
      }
    }
    return {
      ok: true,
      data: {
        choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    };
  };
}

async function until(check) {
  for (let step = 0; step < 250; step++) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw Error('Timed out waiting for the questionnaire runtime');
}

async function start(label) {
  const { id } = await request('workspace.create', { name: label });
  const key = 'quant:' + id;
  const message = 'Run the ' + label + ' questionnaire fixture.';
  assert.equal((await request('chat.send', { id, message })).ok, true);
  const pending = await until(async () => (await request('chat.open', { id })).pendingInteraction);
  assert.equal(pending.scope, 'quant-questionnaire');
  assert.equal(pending.payload.phase, 'pending');
  assert.equal(pending.payload.recovered, false);
  assert.ok(
    events.some(
      (event) => event.key === key && event.id === pending.id && event.type === 'interaction',
    ),
  );
  return {
    id,
    key,
    message,
    response: { id, questionnaireId: pending.id, revision: pending.revision },
  };
}

const stale = { ok: false, error: 'QUANT_QUESTIONNAIRE_STALE' };
const firstAnswers = ['Week', ['ETH', 'USDC'], 'Use observed volume only.'];
const otherAnswers = ['Day', ['ETH'], 'Use a shorter horizon.'];

(async () => {
  await open();
  assert.equal((await host.dispatch({ method: 'snapshot' })).features.quant, true);
  const live = await start('live');
  assert.deepEqual(host.runtime.respond(live.key, { answers: firstAnswers }), stale);
  assert.deepEqual(
    await request('chat.questionnaire.respond', { ...live.response, answers: ['Week'] }),
    { ok: false, error: 'QUANT_QUESTIONNAIRE_ANSWER' },
  );
  const ok = await request('chat.questionnaire.respond', {
    ...live.response,
    answers: firstAnswers,
  });
  assert.deepEqual(ok, { ok: true, resumeRequired: false });
  assert.deepEqual(
    host.runtime.respond(live.key, { ...live.response, answers: otherAnswers }),
    stale,
  );
  assert.deepEqual(
    await request('chat.questionnaire.respond', { ...live.response, answers: firstAnswers }),
    { ok: true, duplicate: true },
  );
  await host.runtime.sessions.get(live.key).finished;
  assert.equal(host.runtime.getSession(live.key).status, 'idle');
  assert.deepEqual(received, [{ ok: true, answers: firstAnswers, authority: 'none' }]);
  assert.equal((await request('chat.open', { id: live.id })).pendingInteraction, null);

  const cold = await start('cold');
  assert.deepEqual(
    await request('chat.questionnaire.respond', {
      ...cold.response,
      id: live.id,
      answers: otherAnswers,
    }),
    stale,
  );
  await host.close();
  host = null;
  await open();
  const [frontendA, frontendB] = await Promise.all([
    request('chat.open', { id: cold.id }),
    request('chat.open', { id: cold.id }),
  ]);
  assert.deepEqual(frontendA.pendingInteraction, frontendB.pendingInteraction);
  assert.equal(frontendA.pendingInteraction.id, cold.response.questionnaireId);
  assert.equal(frontendA.pendingInteraction.payload.recovered, true);
  const before = modelCalls;
  assert.deepEqual(await request('chat.send', { id: cold.id, message: 'Blocked while pending' }), {
    ok: false,
    error: 'QUANT_QUESTIONNAIRE_PENDING',
  });
  assert.deepEqual(
    await request('chat.questionnaire.respond', { ...cold.response, answers: otherAnswers }),
    { ok: true, resumeRequired: true },
  );
  await host.close();
  host = null;
  await open();
  assert.equal(
    (await request('chat.open', { id: cold.id })).pendingInteraction.payload.phase,
    'resume',
  );
  assert.equal(modelCalls, before);
  assert.deepEqual(
    await request('chat.questionnaire.respond', { ...cold.response, action: 'resume' }),
    { ok: true, accepted: true },
  );
  assert.deepEqual(
    await request('chat.questionnaire.respond', { ...cold.response, action: 'resume' }),
    stale,
  );
  const session = host.runtime.sessions.get(cold.key);
  await session.finished;
  assert.equal(host.runtime.getSession(cold.key).status, 'idle');
  assert.equal(host.runtime.getSession(cold.key).busy, false);
  assert.equal(session.agent.running, false);
  assert.deepEqual(received.at(-1), { ok: true, answers: otherAnswers, authority: 'none' });
  assert.equal(received.length, 2);
  const history = session.agent.contextManager.getHistoryMessages();
  assert.equal(history.filter((message) => message.role === 'user').length, 1);
  assert.equal(history.at(-1).content, 'Research continued.');
  assert.equal((await request('chat.open', { id: cold.id })).pendingInteraction, null);
  console.log(
    '[quant-questionnaire] PASS: exact answers, cross-session isolation and cold restart',
  );
})()
  .finally(async () => {
    await host?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
