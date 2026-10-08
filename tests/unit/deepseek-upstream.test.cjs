/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PluginHost } = require('../../src/main/ds-compat/plugin-host');
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-ds-upstream-'));
  const host = new PluginHost({ dataDir: dir, ...options });
  t.after(async () => {
    await host.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await host.init();
  await host.agentsService.sync([{ key: 'native-test', cwd: dir, mode: 'code', status: 'idle' }]);
  const load = async (name, config = {}) => {
    const result = await host.loadPlugin(name, require.resolve('@deepseek-ai/dsh-tool-' + name), {
      config,
    });
    assert.deepEqual(result.issues, []);
    return result;
  };
  const call = (name, tool, args) =>
    host.callTool(name, tool, args, { cwd: dir, sessionKey: 'native-test' });
  return { host, dir, load, call, agent: host.ctx.agents.get('native-test') };
}
test('official DS file plugin executes write/read/edit and supplies scoped CIBYP tool schemas', async (t) => {
  const { host, dir, load, call } = await fixture(t);
  await load('fs');
  assert.equal(
    (await call('fs', 'write', { file_path: 'test.txt', content: 'one\ntwo\n' })).ok,
    true,
  );
  const read = await call('fs', 'read', { file_path: 'test.txt' });
  assert.equal(read.ok, true);
  assert.match(read.content, /one/);
  const edited = await call('fs', 'edit', {
    file_path: 'test.txt',
    old_string: 'two',
    new_string: 'three',
  });
  assert.equal(edited.ok, true);
  assert.equal(await fs.readFile(path.join(dir, 'test.txt'), 'utf8'), 'one\nthree\n');
  const request = await require('../../src/main/ds-compat/service-setup').augmentRequest(
    host,
    [{ role: 'system', content: 'CIBYP identity' }],
    {
      sessionKey: 'native-test',
      tools: [{ type: 'function', function: { name: 'ds__fs__read' } }],
    },
  );
  assert.ok(request.options.tools.some((tool) => tool.function.name === 'ds__fs__read'));
  assert.match(request.messages[0].content, /^CIBYP identity/);
});

test('official filesystem tools retain sandbox policy across live mode changes', async (t) => {
  const settings = { sandbox: { defaultMode: 'danger-full-access' } };
  const { load, call, dir } = await fixture(t, { getSettings: () => settings });
  await load('fs');
  assert.equal(
    (await call('fs', 'write', { file_path: 'allowed.txt', content: 'allowed' })).ok,
    true,
  );
  settings.sandbox.defaultMode = 'read-only';
  const denied = await call('fs', 'write', { file_path: 'denied.txt', content: 'denied' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'FS_SANDBOX_DENIED');
  assert.match(denied.error, /sandbox:.*read-only/);
  await assert.rejects(fs.stat(path.join(dir, 'denied.txt')), { code: 'ENOENT' });
  settings.sandbox.defaultMode = 'danger-full-access';
  assert.equal((await call('fs', 'write', { file_path: 'after.txt', content: 'after' })).ok, true);
});
test('official shell and jobs plugins share live processes, bounded output and cancellation', async (t) => {
  const { load, call } = await fixture(t);
  await load('bash');
  await load('jobs');
  const command =
    process.platform === 'win32'
      ? "Write-Output $env:DSH_SESSION_ID; Start-Sleep -Milliseconds 200; Write-Output 'finished'"
      : "printf '%s\n' \"$DSH_SESSION_ID\"; sleep 0.2; printf 'finished'";
  const result = await call('bash', 'bash', {
    description: 'Run a background probe',
    command,
    run_in_background: true,
  });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.value.jobId);
  const output = await call('jobs', 'job_output', {
    job_id: result.value.jobId,
    wait: true,
    timeout_ms: 10000,
  });
  assert.equal(output.ok, true, output.error);
  assert.match(output.content, /native-test/);
  assert.match(output.content, /finished/);
  assert.equal((await call('jobs', 'job_list', {})).ok, true);
});
test('official questions and todo plugins use structured answers and durable session projections', async (t) => {
  const { load, call, agent, host } = await fixture(t, {
    transport: {
      request: async (channel) => {
        assert.equal(channel, 'ds:questionsRequest');
        return { answers: ['A'] };
      },
      send: async () => {},
    },
  });
  await load('ask-user');
  await load('todo', { allowParallelInProgress: false });
  const answer = await call('ask-user', 'ask_user_question', {
    questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
  });
  assert.equal(answer.ok, true, answer.error);
  assert.deepEqual(answer.value.answers, [{ id: 'q', selected: ['A'] }]);
  const todo = await call('todo', 'todo_write', {
    todos: [{ content: 'Test native plugin', status: 'in_progress' }],
  });
  assert.equal(todo.ok, true, todo.error);
  assert.equal(
    host.ctx.sessionProjections.stateOf(agent.session, 'todos')[0].content,
    'Test native plugin',
  );
  await host.ctx.sessions.flush(agent.session);
});
test('session queries search persisted logs after restart and maintain exclusive write handles', async (t) => {
  const { host, dir, agent } = await fixture(t);
  host.agentsService.consumeRuntimeEvent({
    type: 'message',
    key: agent.id,
    role: 'user',
    content: 'persistent needle',
  });
  host.agentsService.consumeRuntimeEvent({ type: 'status', key: agent.id, status: 'idle' });
  await host.ctx.sessions.flush(agent.session);
  await assert.rejects(host.ctx.sessionPersistence.open(agent.id, 'write'), {
    name: 'SessionAlreadyOwnedError',
  });
  const readonly = await host.ctx.sessionPersistence.open(agent.id, 'read');
  await assert.rejects(async () => readonly.append([]), { name: 'SessionReadOnlyError' });
  await readonly.close();
  const live = await host.ctx.sessionQuery.searchEvents({ sessionId: agent.id, query: 'needle' });
  assert.equal(live.items.length, 1);
  await host.dispose();
  const restored = new PluginHost({ dataDir: dir });
  t.after(() => restored.dispose());
  await restored.init();
  const cold = await restored.ctx.sessionQuery.searchEvents({
    sessionId: agent.id,
    query: 'needle',
  });
  assert.deepEqual(cold.items, live.items);
});
test('official LSP plugin reaches installed Code-OSS extensions with position translation', async (t) => {
  const calls = [];
  const { load, call } = await fixture(t, {
    invoke: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        items: [
          {
            contents: ['Symbol description'],
            range: { start: { line: 2, column: 3 }, end: { line: 2, column: 6 } },
          },
        ],
      };
    },
  });
  await load('lsp');
  const result = await call('lsp', 'lsp', {
    operation: 'hover',
    file_path: 'test.ts',
    line: 2,
    character: 3,
  });
  assert.equal(result.ok, true, result.error);
  assert.match(result.content, /Symbol description/);
  assert.equal(calls[0][0], 'codeoss:language');
  assert.equal(calls[0][1].column, 3);
});
test('foreign application entries are rejected before their startup side effects execute', async (t) => {
  const { host, dir } = await fixture(t);
  const entry = path.join(dir, 'takeover.cjs');
  await fs.writeFile(entry, "throw new Error('Application started');");
  const result = await host.loadPlugin('foreign', entry, { name: '@deepseek-ai/dsh-agent-loop' });
  assert.match(result.issues.join('\n'), /CIBYP owns application startup/);
  assert.doesNotMatch(result.issues.join('\n'), /Application started/);
});
