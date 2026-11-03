/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Real shared runtime and real file tools; deterministic model replies, no external API or accounts.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { randomUUID } = require('node:crypto');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-super-backend-'));
const entry = process.argv.includes('--bundled')
  ? path.resolve('dist/node-core/core.cjs')
  : require.resolve('../../src/agent/node-host');
let host,
  calls = 0;
let hotAdded = false;
const seen = [];
const request = (action, input = {}) =>
  host.dispatch({ method: 'superagent:request', args: [action, input] });
async function until(fn) {
  for (let n = 0; n < 500; n++) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error(
    'SuperAgent integration timed out: ' +
      JSON.stringify(await request('list')) +
      ' / ' +
      JSON.stringify(await request('events')),
  );
}
const reply = (toolCalls) => ({
  ok: true,
  data: {
    choices: [
      {
        message: {
          role: 'assistant',
          content: toolCalls ? '' : 'Turn finished.',
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  },
});
const tool = (name, args) => ({
  id: randomUUID(),
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
async function open() {
  host = await require(entry).createNodeRuntime({
    dataDir: profile,
    workspaceRoot: path.join(profile, 'workspaces'),
    settings: {
      onboardingCompleted: true,
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
      superAgent: { watchdog: false },
    },
  });
  host.eventBus.subscribe('agent:session-event', (e) => {
    if (e.type === 'interaction')
      host.runtime.respond(e.key, e.kind === 'tool-auth' ? 'allow-once' : true);
  });
  host.api.chatLLM = async (messages, options) => {
    calls++;
    seen.push({
      system: String(messages.find((m) => m.role === 'system')?.content || ''),
      tools: options?.tools,
    });
    const system = seen.at(-1).system;
    const lastUser = messages.findLastIndex(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.replace(/^【用户追加消息】/, '').startsWith('{') &&
          m.content.includes('"events"'),
      ),
      input = JSON.parse(messages[lastUser].content.replace(/^【用户追加消息】/, ''));
    const tail = messages.slice(lastUser + 1);
    if (system.includes('SuperAgent Router')) {
      if (tail.some((m) => m.role === 'tool')) return reply();
      assert.ok(input.events.length);
      return reply(
        input.events.map((e) =>
          tool('super_route', { eventId: e.id, action: 'create', title: 'Verified local task' }),
        ),
      );
    }
    assert.ok(system.includes('SuperAgent Worker'));
    const t = (await request('list')).items.find((v) => v.status === 'running'),
      s = host.runtime.sessions.get(t.workerKey);
    assert.ok(!s.agent.getRuntimeToolSchemas().some((r) => r.function.name.startsWith('quant_')));
    if (!hotAdded) {
      hotAdded = true;
      await request('submit', {
        taskId: t.id,
        mode: t.mode,
        text: 'Keep exactly the same public fixture content.',
        operationId: 'hot-followup',
      });
    }
    if (tail.some((m) => m.role === 'tool' && m.name === 'super_report')) return reply();
    if (fs.existsSync(path.join(s.agent.workspacePath, 'result.txt')))
      return reply([
        tool('super_report', {
          status: 'completed',
          summary: 'Created and checked the requested local artifact.',
          evidence: ['result.txt is present in the isolated task workspace'],
        }),
      ]);
    return reply([
      tool('createFile', {
        path: path.join(s.agent.workspacePath, 'result.txt'),
        content: 'public-superagent-fixture\n',
      }),
    ]);
  };
}
(async () => {
  await open();
  assert.equal((await host.dispatch({ method: 'snapshot' })).features.quant, false);
  await assert.rejects(
    host.dispatch({ method: 'quant:request', args: ['native.start', {}] }),
    /QUANT_DISABLED/,
  );
  assert.equal(host.runtime.quantService, undefined);
  const denied = host.runtime.createSession({ key: 'gated-quant', profile: 'quant' });
  await assert.rejects(host.runtime.initialize({ key: denied.key }), /QUANT_DISABLED/);
  await assert.rejects(
    host.runtime.agentAction(denied.key, 'executeTool', ['quant_native', { action: 'start' }]),
    /QUANT_DISABLED/,
  );
  await host.runtime.close(denied.key);
  const event = await request('submit', {
    text: 'Create result.txt with the public fixture text and verify it.',
    operationId: 'real-runtime-test',
    threadId: 'real-thread',
  });
  await until(async () => {
    const p = await request('list');
    return p.items[0]?.status === 'completed';
  });
  let task = (await request('list')).items[0];
  assert.equal(task.inputs, 2);
  assert.equal(
    task.attempts,
    1,
    'hot input is admitted during the current turn, without duplicate continuation',
  );
  assert.equal(
    fs.readFileSync(path.join(task.workspacePath, 'result.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'public-superagent-fixture\n',
  );
  assert.ok(task.tokens > 0);
  assert.equal((await request('deliveries')).total, 1);
  assert.equal(
    (
      await request('submit', {
        text: 'Create result.txt with the public fixture text and verify it.',
        operationId: 'real-runtime-test',
        threadId: 'real-thread',
      })
    ).id,
    event.id,
  );
  const routeCount = seen.filter((r) => r.system.includes('SuperAgent Router')).length;
  await host.close();
  host = null;
  await open();
  task = (await request('get', { id: task.id })).task;
  assert.equal(task.status, 'completed');
  await request('submit', {
    text: 'Verify the same artifact once more.',
    mode: task.mode,
    taskId: task.id,
    operationId: 'after-restart',
  });
  await until(async () => {
    const p = await request('get', { id: task.id });
    return p.task.status === 'completed' && p.task.attempts === 2;
  });
  assert.equal(
    seen.filter((r) => r.system.includes('SuperAgent Router')).length,
    routeCount,
    'subscribed follow-up does not call the Router',
  );
  assert.equal((await request('list')).total, 1);
  assert.ok(calls >= 6);
  console.log(
    'PASS: actual shared Agent loop -> restricted Router -> real isolated file tool -> explicit report -> durable task/delivery -> locked-down quant entry -> backend restart -> history restore and direct follow-up. No external model or chain traffic.',
  );
})()
  .catch((e) => {
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await host?.close();
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('cibyp-super-backend-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
