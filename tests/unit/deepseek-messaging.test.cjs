/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PluginHost } = require('../../src/main/ds-compat/plugin-host');
const { createUserMessage } = require('@deepseek-ai/dsh-llm');

const message = (text) =>
  createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
const delay = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay();
  }
  assert.fail('Messaging condition did not settle');
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-ds-messaging-'));
  const turns = [],
    closed = [],
    requests = [];
  let host;
  const finish = (key, text = 'Finished') => {
    host.agentsService.consumeRuntimeEvent({
      key,
      type: 'model-response',
      message: { content: text },
    });
    host.agentsService.consumeRuntimeEvent({ key, type: 'status', status: 'idle' });
    for (const turn of turns.filter((value) => value.key === key && !value.finished)) {
      turn.finished = true;
      turn.resolve();
    }
  };
  host = new PluginHost({
    dataDir: directory,
    transport: {
      request: async (channel, payload) => {
        requests.push({ channel, ...payload });
        if (channel === 'ds:agentClose') {
          closed.push(payload.sessionKey);
          return {};
        }
        return { sessionKey: payload.sessionId, cwd: directory, status: 'idle' };
      },
      send: async (_, payload) => {
        if (payload.kind === 'stop') {
          finish(payload.sessionKey);
          return;
        }
        if (payload.kind !== 'plugin-turn') return;
        host.agentsService.consumeRuntimeEvent({
          key: payload.sessionKey,
          type: 'status',
          status: 'running',
        });
        host.agentsService.consumeRuntimeEvent({
          key: payload.sessionKey,
          type: 'message',
          role: 'user',
          content: payload.text,
        });
        await new Promise((resolve) =>
          turns.push({ key: payload.sessionKey, text: payload.text, resolve }),
        );
      },
    },
  });
  await host.init();
  await host.agentsService.sync([{ key: 'parent', cwd: directory, status: 'idle' }]);
  t.after(async () => {
    for (const row of turns) finish(row.key);
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    host,
    ctx: host.ctx,
    parent: host.ctx.agents.get('parent'),
    turns,
    finish,
    closed,
    requests,
  };
}

test('DS interrupt preserves pending inbox work but parks it until a waking send', async (t) => {
  const { parent, turns, finish } = await fixture(t);
  parent.followup(message('first'));
  await until(() => turns.length === 1);
  parent.followup(message('queued'));
  const cancelled = parent.cancel({ kind: 'user' }, { keepInbox: true });
  await delay();
  assert.equal(turns.length, 1, 'interrupt must not immediately start the pending turn');
  assert.equal(parent.inbox.nextTurn.length, 1);
  await cancelled;
  parent.inject(message('parked context'));
  await delay();
  assert.equal(turns.length, 1, 'context injection alone must not wake a cancelled driver');
  parent.steer(message('resume'));
  await until(() => turns.length === 2);
  assert.match(turns[1].text, /queued/);
  assert.match(turns[1].text, /resume/);
  finish(parent.id);
  await parent.whenIdle();
});

test('idle inject does not wake through metadata observations, and failed composition rolls back', async (t) => {
  const { host, ctx, parent, turns, finish, closed } = await fixture(t);
  parent.inject(message('non-waking context'));
  await host.agentsService.sync([{ key: parent.id, status: 'idle' }]);
  await delay();
  assert.equal(turns.length, 0);
  parent.followup(message('start'));
  await until(() => turns.length === 1);
  assert.match(turns[0].text, /non-waking context/);
  finish(parent.id);
  await parent.whenIdle();
  await assert.rejects(
    ctx.agents.create({
      sessionId: 'bad-composition',
      setup() {
        throw new Error('Fixture setup failed');
      },
    }),
    /Fixture setup failed/,
  );
  assert.equal(ctx.agents.get('bad-composition'), undefined);
  assert.ok(closed.includes('bad-composition'));
});

test('DS continuable children use the real SDK mailbox, return receipts and reject unrelated targets', async (t) => {
  const { ctx, parent, turns, finish, closed, requests, host } = await fixture(t);
  const signal = new AbortController().signal;
  const started = await ctx.subagents.startContinuable({
    provider: 'cibyp',
    label: 'Research',
    signal,
    request: { parent, prompt: [{ type: 'text', text: 'Investigate the task' }] },
  });
  assert.ok(started.childId && started.messageId);
  await until(() => turns.some((row) => row.key === started.childId));
  const child = ctx.agents.get(started.childId);
  assert.ok(child);
  const receipt = await ctx.subagents.sendMessage(
    parent,
    child.id,
    [{ type: 'text', text: 'Focus on cancellation' }],
    { signal },
  );
  assert.equal(child.inbox.nextStep[0].id, receipt);
  await assert.rejects(
    ctx.subagents.sendMessage(parent, 'unrelated', [{ type: 'text', text: 'Do work' }], { signal }),
    { code: 'NOT_RESUMABLE' },
  );
  const outsider = await ctx.agents.create({ sessionId: 'outsider' });
  await assert.rejects(
    ctx.subagents.sendMessage(
      outsider.agent,
      child.id,
      [{ type: 'text', text: 'Cross-session takeover' }],
      { signal },
    ),
    { code: 'UNAUTHORIZED' },
  );
  await outsider.dispose();
  const returnId = await ctx.subagents.sendMessage(
    child,
    parent.id,
    [{ type: 'text', text: 'Important finding' }],
    { signal },
  );
  assert.ok(returnId);
  await until(() => turns.some((row) => row.key === parent.id));
  assert.match(turns.find((row) => row.key === parent.id).text, /Important finding/);
  finish(parent.id);
  finish(child.id);
  await until(() => turns.filter((row) => row.key === child.id).length === 2);
  finish(child.id);
  await until(() => closed.includes(child.id));
  const continued = await ctx.subagents.sendMessage(
    parent,
    child.id,
    [{ type: 'text', text: 'Continue with another check' }],
    { signal },
  );
  assert.ok(continued);
  await until(() => turns.filter((row) => row.key === child.id).length === 3);
  assert.ok(requests.some((row) => row.channel === 'ds:agentResume' && row.sessionId === child.id));
  assert.match(turns.filter((row) => row.key === child.id).at(-1).text, /another check/);
  const restored = host.agentsService.get(child.id).session.deriveMessages();
  assert.ok(
    restored.some((row) => row.content.some((block) => block.text?.includes('Investigate'))),
  );
  for (const row of turns) finish(row.key);
});
