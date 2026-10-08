/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PluginHost } = require('../../src/main/ds-compat/plugin-host');
const { execution } = require('../../src/main/ds-compat/execution-context');
const { createUserMessage } = require('@deepseek-ai/dsh-llm');
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-ds-services-'));
  const host = new PluginHost({ dataDir: directory, ...options });
  t.after(async () => {
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await host.init();
  return { host, directory, ctx: host.ctx };
}
test('DS file edits use version guards, preserve CRLF, support byte ranges and refuse sandbox escapes', async (t) => {
  let settings = {};
  const { ctx, directory } = await fixture(t, { getSettings: async () => settings });
  const target = await ctx.fs.resolve('sample.txt', { cwd: directory });
  const created = await ctx.fs.writeText(target, '你好\r\nline\r\n', { kind: 'createIfAbsent' });
  assert.equal(created.operation, 'create');
  assert.equal(created.after, '你好\nline\n');
  const edited = await ctx.fs.editText(
    target,
    { oldString: 'line', newString: 'two', replaceAll: false },
    { version: created.version },
  );
  assert.equal(edited.after, '你好\ntwo\n');
  assert.equal(await fs.readFile(target.targetKey, 'utf8'), '你好\r\ntwo\r\n');
  await assert.rejects(
    ctx.fs.editText(target, { oldString: 'two', newString: 'three' }, { version: created.version }),
    { code: 'FS_STALE_VERSION' },
  );
  const bytes = await ctx.fs.readByteRange(target, { offset: 0, length: 6 });
  assert.equal(bytes.toString('utf8'), '你好');
  await assert.rejects(ctx.fs.readBytes(target, undefined, 2), { code: 'FS_TOO_LARGE' });
  assert.equal(await ctx.fs.stat(await ctx.fs.resolve('missing', { cwd: directory })), undefined);
  settings = { sandbox: { defaultMode: 'read-only' } };
  await assert.rejects(
    ctx.fs.writeText(target, 'bad', undefined, undefined, { mode: 'danger-full-access' }),
    { code: 'FS_SANDBOX_DENIED' },
  );
});
test('subprocess collects byte-bounded tails with independent readers and a recoverable spill file', async (t) => {
  const { ctx, directory } = await fixture(t);
  const child = ctx.subprocess.spawn({
    argv: [
      process.execPath,
      '-e',
      "process.stdout.write('1234567890你好');process.stderr.write('oops');process.exitCode=7",
    ],
    cwd: directory,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 8, spill: { maxBytes: 100 } },
      stderr: { maxBytes: 100 },
    },
    graceMs: 250,
  });
  assert.equal((await child.done).exitCode, 7);
  const one = child.collected.stdout.readFrom(0),
    two = child.collected.stdout.readFrom(0);
  assert.deepEqual(one, two);
  assert.equal(one.lossy, true);
  assert.equal(one.text, '90你好');
  assert.equal(await fs.readFile(one.spillPath, 'utf8'), '1234567890你好');
  assert.equal(child.collected.stderr.readFrom(0).text, 'oops');
  assert.equal(await child.waitForExit(), true);
});
test('shell publishes a cancellable handle, uses current workspace and does not treat nonzero exit as a spawn failure', async (t) => {
  const { ctx, directory } = await fixture(t);
  const spec = ctx.shell.resolve({
    command:
      process.platform === 'win32' ? "Write-Output 'hello'; exit 3" : "printf 'hello'; exit 3",
    workdir: directory,
  });
  const handle = await ctx.shell.execute(spec);
  const result = await handle.result();
  assert.equal(result.exitCode, 3);
  assert.match(result.stdout.text, /hello/);
  assert.equal(handle.status, 'completed');
  assert.equal(handle.result(), handle.result());
  assert.equal(handle.kill(), false);
  const controller = new AbortController();
  const long = await ctx.shell.execute(
    ctx.shell.resolve({
      command: process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20',
      workdir: directory,
      signal: controller.signal,
    }),
  );
  controller.abort();
  assert.equal((await long.result()).aborted, true);
  assert.equal(long.status, 'killed');
});
test('registered skills and prompt sections affect requests and disappear when the plugin unloads', async (t) => {
  const { host, ctx, directory } = await fixture(t);
  const entry = path.join(directory, 'prompt.cjs');
  await fs.writeFile(
    entry,
    `module.exports = {inject:['systemPrompt','skills'],apply(ctx){ctx.systemPrompt.section({name:'complete-ds',order:0,complete:true,text:'Plugin instruction'});ctx.skills.register({name:'sample-skill',description:'Example',source:'custom',content:'Skill body'});}}`,
  );
  assert.deepEqual((await host.loadPlugin('prompt', entry)).issues, []);
  assert.equal((await ctx.skills.get('sample-skill')).content, 'Skill body');
  const { augmentRequest } = require('../../src/main/ds-compat/service-setup');
  const output = await augmentRequest(host, [
    { role: 'system', content: 'CIBYP persona' },
    { role: 'user', content: 'Hi' },
  ]);
  assert.match(output.messages[0].content, /^CIBYP persona\n\nPlugin instruction$/);
  await host.unloadPlugin('prompt');
  assert.equal(await ctx.skills.get('sample-skill'), undefined);
  assert.deepEqual(
    (await augmentRequest(host, [{ role: 'system', content: 'CIBYP persona' }])).messages,
    [{ role: 'system', content: 'CIBYP persona' }],
  );
});
test('agent handles are stable, inbox supports editing, scopes isolate contributions and session forks are independent', async (t) => {
  const sent = [];
  const { ctx, host, directory } = await fixture(t, {
    transport: {
      send: async (channel, payload) => {
        sent.push({ channel, payload });
      },
      request: async (_, p) => ({ sessionKey: p.sessionId || 'a', cwd: directory, status: 'idle' }),
    },
  });
  await host.agentsService.sync([
    { key: 'a', id: 'conversation-a', cwd: directory, mode: 'code', status: 'running' },
  ]);
  const agent = ctx.agents.get('a');
  assert.equal(ctx.agents.get('conversation-a'), agent);
  assert.equal(ctx.agents.list()[0], agent);
  assert.equal(agent.status, 'running');
  const one = createUserMessage({
    content: [{ type: 'text', text: 'One' }],
    source: { kind: 'user' },
  });
  const two = createUserMessage({
    content: [{ type: 'text', text: 'Two' }],
    source: { kind: 'user' },
  });
  agent.inbox.append('next-turn', one);
  agent.inbox.prepend('next-turn', two);
  assert.equal(agent.inbox.remove(one.id), true);
  assert.equal(agent.inbox.nextTurn[0].id, two.id);
  agent.inbox.clear();
  assert.equal(agent.inbox.nextTurn.length, 0);
  host.agentsService.consumeRuntimeEvent({
    type: 'message',
    key: 'a',
    role: 'user',
    content: 'Hello',
  });
  host.agentsService.consumeRuntimeEvent({
    type: 'message',
    key: 'a',
    role: 'assistant',
    content: 'Answer',
  });
  host.agentsService.consumeRuntimeEvent({ type: 'status', key: 'a', status: 'idle' });
  await agent.whenIdle();
  const fork = ctx.sessions.fork(agent.session);
  assert.notEqual(fork.id, agent.session.id);
  assert.deepEqual(fork.deriveMessages(), agent.session.deriveMessages());
  fork.append('custom/test', { n: 1 });
  assert.notEqual(fork.seq, agent.session.seq);
  await ctx.sessions.flush(agent.session);
  assert.ok((await fs.readdir(path.join(directory, 'plugin-session-journals'))).length);
});
test('DS canonical streaming uses the shared host pipeline, preserving reasoning, tool calls and usage', async (t) => {
  const listeners = new Map();
  const calls = [];
  const { ctx } = await fixture(t, {
    subscribe: (name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    invoke: async (channel, messages, options) => {
      calls.push({ channel, messages, options });
      listeners.get('llm:stream-chunk')?.({
        requestId: options.requestId,
        content: 'Answer',
        reasoning: 'Summary',
      });
      return {
        ok: true,
        data: {
          choices: [
            {
              message: {
                content: 'Answer',
                tool_calls: [{ id: 'tool-1', function: { name: 'probe', arguments: '{}' } }],
              },
            },
          ],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 5,
            total_tokens: 55,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        },
      };
    },
  });
  const chunks = [];
  for await (const chunk of ctx.llm.stream({
    provider: 'cibyp',
    model: 'subscription-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  }))
    chunks.push(chunk);
  assert.equal(calls[0].channel, 'llm:chatStream');
  assert.equal(calls[0].messages[0].content, 'Hi');
  assert.equal(chunks.filter((c) => c.type === 'block-end').length, 3);
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.equal(chunks.find((c) => c.type === 'usage').usage.inputTokens, 30);
  assert.equal(listeners.size, 0);
});

test('plugin settings redact secrets, validate edits and reject stale revisions without changing CIBYP settings', async (t) => {
  const writes = [];
  const { ctx } = await fixture(t, { setPluginConfig: async (...args) => writes.push(args) });
  const schema = require('@deepseek-ai/schemastery');
  ctx.settings.registerPlugin(
    'probe',
    schema.object({ count: schema.natural().default(1), apiKey: schema.string().role('secret') }),
    { count: 1, apiKey: 'synthetic-secret' },
  );
  const entry = ctx.settings.describe()[0];
  assert.equal(entry.value.apiKey, undefined);
  assert.equal(entry.secrets[0].present, true);
  await ctx.settings.update('probe', { count: 2 }, entry.revision);
  assert.equal(writes[0][1].apiKey, 'synthetic-secret');
  assert.equal(ctx.settings.get('probe').count, 2);
  await assert.rejects(ctx.settings.update('probe', { count: 3 }, entry.revision), {
    code: 'SETTINGS_CONFLICT',
  });
  await assert.rejects(ctx.settings.update('probe', { count: -1 }));
  assert.equal(writes.length, 1);
  await assert.rejects(
    ctx.settings.replace('llm', { apiKey: 'overwrite' }),
    /Unknown plugin settings namespace/,
  );
});

test('model responses and titles mirror to the durable SDK journal without losing the next turn', async (t) => {
  const { host, ctx, directory } = await fixture(t);
  await host.agentsService.sync([{ key: 'journal', cwd: directory, status: 'idle' }]);
  const event = (value) => host.agentsService.consumeRuntimeEvent({ key: 'journal', ...value });
  event({ type: 'title', title: 'Fixture title' });
  event({ type: 'message', role: 'user', content: 'First' });
  event({ type: 'message', role: 'assistant', content: 'Answer' }); // GUI stream-end precedes the canonical response.
  event({
    type: 'model-response',
    message: {
      content: 'Answer',
      reasoning: 'Summary',
      tool_calls: [{ id: 'call', function: { name: 'probe', arguments: '{}' } }],
    },
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  event({ type: 'message', role: 'assistant', content: 'Answer' });
  event({ type: 'status', status: 'idle' });
  event({ type: 'message', role: 'user', content: 'Second' });
  event({ type: 'message', role: 'assistant', content: 'Next answer' });
  event({ type: 'status', status: 'idle' });
  const agent = ctx.agents.get('journal'),
    events = agent.session.snapshotEvents();
  assert.equal(agent.title, 'Fixture title');
  assert.equal(events.filter((e) => e.type === 'assistant/message').length, 2);
  const response = events.find((e) => e.type === 'assistant/message').data;
  assert.equal(response.message.content[0].type, 'reasoning');
  assert.equal(response.usage.inputTokens, 10);
  assert.equal(events.filter((e) => e.type === 'turn/end').length, 2);
  await ctx.sessions.flush(agent.session);
});

test('native agent creation restores a fork seed with its inherited cut and cleans up only the owned agent', async (t) => {
  let host;
  const closed = [];
  let payload;
  const fixtureResult = await fixture(t, {
    transport: {
      request: async (channel, value) => {
        if (channel === 'ds:agentClose') {
          closed.push(value.sessionKey);
          return {};
        }
        payload = value;
        return { sessionKey: value.sessionId, cwd: fixtureResult.directory, status: 'idle' };
      },
      send: async () => {},
    },
  });
  host = fixtureResult.host;
  await host.agentsService.sync([{ key: 'parent', cwd: fixtureResult.directory, status: 'idle' }]);
  host.agentsService.consumeRuntimeEvent({
    key: 'parent',
    type: 'message',
    role: 'user',
    content: 'Inherited question',
  });
  host.agentsService.consumeRuntimeEvent({ key: 'parent', type: 'status', status: 'idle' });
  const parent = host.ctx.agents.get('parent');
  const fork = host.ctx.sessions.fork(parent.session);
  const owned = await host.ctx.agents.create({
    sessionId: 'child',
    meta: { ...fork.header, origin: 'subagent', parentSession: parent.id },
    seed: fork.snapshotEvents(),
    inheritedEventCount: fork.inheritedEventCount,
  });
  assert.equal(owned.agent.session.inheritedEventCount, fork.inheritedEventCount);
  assert.match(payload.seedMessages[0].content, /Inherited question/);
  assert.notEqual(owned.agent.session, parent.session);
  await owned.dispose();
  assert.deepEqual(closed, ['child']);
  assert.equal(host.ctx.agents.get('parent'), parent);
});

test('only real Agent steps consume scoped injection, and plugin rejection stops a step', async (t) => {
  const { host, ctx, directory } = await fixture(t);
  await host.agentsService.sync([{ key: 'steps', cwd: directory, status: 'running' }]);
  const agent = ctx.agents.get('steps');
  agent.inject(
    createUserMessage({
      content: [{ type: 'text', text: 'Next step guidance' }],
      source: { kind: 'user' },
    }),
  );
  const { augmentRequest } = require('../../src/main/ds-compat/service-setup');
  const messages = [{ role: 'user', content: 'Original task' }];
  const title = await augmentRequest(host, messages, { sessionKey: agent.id });
  assert.deepEqual(title.messages, messages);
  assert.equal(agent.inbox.nextStep.length, 1);
  const step = await augmentRequest(host, messages, { sessionKey: agent.id, cibypAgentStep: true });
  assert.match(step.messages.map((message) => message.content).join('\n'), /Next step guidance/);
  assert.equal(agent.inbox.nextStep.length, 0);
  const detach = agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }));
  await assert.rejects(
    augmentRequest(host, messages, { sessionKey: agent.id, cibypAgentStep: true }),
    { code: 'PLUGIN_STEP_REJECTED' },
  );
  detach();
});

test('native subagents return real child outcomes and dispose only their owned backend session', async (t) => {
  let host,
    fail = false;
  const closed = [];
  const {
    ctx,
    directory,
    host: instance,
  } = await fixture(t, {
    transport: {
      request: async (channel, payload) => {
        if (channel === 'ds:agentClose') {
          closed.push(payload.sessionKey);
          return {};
        }
        return { sessionKey: payload.sessionId, cwd: directory, status: 'idle' };
      },
      send: async (_, payload) => {
        if (payload.kind !== 'plugin-turn') return;
        if (fail) throw new Error('Provider fixture failed');
        host.agentsService.consumeRuntimeEvent({
          key: payload.sessionKey,
          type: 'message',
          role: 'user',
          content: payload.text,
        });
        host.agentsService.consumeRuntimeEvent({
          key: payload.sessionKey,
          type: 'model-response',
          message: { content: 'Child fixture answer' },
        });
        host.agentsService.consumeRuntimeEvent({
          key: payload.sessionKey,
          type: 'status',
          status: 'idle',
        });
      },
    },
  });
  host = instance;
  await host.agentsService.sync([{ key: 'parent', cwd: directory, status: 'idle' }]);
  const parent = ctx.agents.get('parent'),
    signal = new AbortController().signal;
  const spec = {
    parent,
    prompt: [{ type: 'text', text: 'Child fixture question' }],
    signal,
    maxDepth: 1,
    label: 'Fixture child',
  };
  const run = await ctx.subagents.start('cibyp', spec);
  const result = await run.result;
  assert.equal(result.stopReason, 'completed');
  assert.match(result.output.map((block) => block.text || '').join('\n'), /Child fixture answer/);
  assert.ok(
    run.localAgent.session.snapshotEvents().some((event) => event.type === 'subagent/descriptor'),
  );
  await run.dispose();
  assert.deepEqual(closed, [run.id]);
  assert.equal(ctx.agents.get('parent'), parent);
  fail = true;
  const failed = await ctx.subagents.start('cibyp', spec);
  assert.equal((await failed.result).stopReason, 'error');
  await failed.dispose();
  await assert.rejects(ctx.subagents.start('cibyp', { ...spec, persona: 'unsupported' }), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
});

test(
  'persistent PTY sends text, retains scrollback and rejects a different session owner',
  { timeout: 25000 },
  async (t) => {
    const { host, ctx, directory } = await fixture(t);
    await host.agentsService.sync([
      { key: 'terminal-owner', cwd: directory, status: 'idle' },
      { key: 'other', cwd: directory, status: 'idle' },
    ]);
    const agent = ctx.agents.get('terminal-owner'),
      signal = AbortSignal.timeout(18000);
    const terminal = await execution.run({ agent, cwd: directory }, () =>
      ctx.terminals.spawn(agent, { type: 'shell', cwd: directory }, signal),
    );
    assert.equal(ctx.terminals.list(agent).length, 1);
    assert.throws(() => ctx.terminals.read(ctx.agents.get('other'), terminal.sessionId), {
      code: 'FOREIGN_SESSION',
    });
    const command =
      process.platform === 'win32'
        ? "Write-Output 'cibyp-pty-sentinel'"
        : "printf 'cibyp-pty-sentinel\\n'";
    const operation = ctx.terminals.startSend(agent, terminal.sessionId, {
      text: command,
      submit: true,
      signal,
    });
    const output = await operation.done;
    assert.match(output.viewport, /cibyp-pty-sentinel/);
    assert.match(ctx.terminals.read(agent, terminal.sessionId).text, /cibyp-pty-sentinel/);
    assert.equal(await ctx.terminals.kill(agent, terminal.sessionId), true);
    assert.equal(ctx.terminals.list(agent).length, 0);
  },
);
