const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { createNodeRuntime, confinePath } = require('../../src/agent/node-host');
test('pure Node host runs shared chat/code/babe and remote v2 protects scoped clients', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-integration-'));
  const host = await createNodeRuntime({ dataDir: dir });
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const token = crypto.randomBytes(32).toString('hex'),
    address = await host.start({ port: 0, token });
  const skill = await host.api.createSkill({ name: 'fixture', prompt: 'Shared skill guidance' });
  assert.ok((await host.api.listSkills()).some((value) => value.id === skill.id));
  await assert.rejects(host.api.updateSkill('../escape', { prompt: 'no' }));
  assert.equal((await host.api.decisionStatus()).ok, true);
  assert.match(await host.api.automationGetGuide('all'), /automation|自动化/i);
  // Existing mobile/IDE clients still use the owner-authenticated v1 contract.
  const { BackendClient } = require('../../src/shared/backend-client');
  const legacy = new BackendClient({ url: address.url, token });
  const avatar = 'data:image/png;base64,iVBORw0KGgo=';
  await host.api.setSettings({
    userProfile: { name: 'Fixture', avatar, avatarFrame: 'frame-001' },
  });
  const appearance = await legacy.request('chat:appearance');
  assert.equal(appearance.user.avatar, avatar);
  assert.match(appearance.user.frame, /<svg/);
  assert.equal((await legacy.request('snapshot')).sessions.length, 0);
  assert.equal((await host.api.avatarEncodeFile(path.join(dir, 'settings.json'))).ok, false);
  assert.equal((await host.api.decisionCall({ usage: 'fixture-disabled' })).ok, false);
  async function call(method, params = {}, credential = token) {
    const res = await fetch(address.url + '/remote/v2/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    });
    return res.json();
  }
  assert.equal((await call('system.hello')).result.protocol.major, 2);
  for (const mode of ['chat', 'code', 'babe']) {
    const session = (await call('session.create', { mode, operationId: crypto.randomUUID() }))
      .result;
    assert.ok(session.key);
    assert.equal(
      (
        await call('session.initialize', {
          sessionId: session.key,
          operationId: crypto.randomUUID(),
        })
      ).result.mode,
      mode,
    );
  }
  assert.equal((await call('session.list')).result.total, 3);
  const { RemoteClient } = require('../../packages/remote/src/client');
  const WebSocket = require('ws'),
    events = [];
  const client = new RemoteClient({
    url: address.url,
    token,
    socketFactory: (url, token) =>
      new WebSocket(url, { headers: { Authorization: 'Bearer ' + token } }),
    onEvent: (e) => events.push(e),
  });
  t.after(() => client.close());
  await client.connect();
  const sessionId = host.runtime.listSessions()[0].key;
  const bytes = new TextEncoder().encode('附件正文 · attachment content');
  const uploaded = await client.upload(sessionId, 'notes.txt', bytes);
  assert.equal(uploaded.size, bytes.length);
  assert.equal(uploaded.path, undefined);
  assert.deepEqual(await client.download(uploaded.attachmentId), bytes);
  assert.equal((await client.call('attachment.list', { sessionId })).total, 1);
  const otherSession = host.runtime.listSessions()[1].key;
  await assert.rejects(
    client.call('session.submit', {
      sessionId: otherSession,
      text: 'wrong session',
      attachments: [uploaded.attachmentId],
      operationId: crypto.randomUUID(),
    }),
    (e) => e.reason === 'FORBIDDEN',
  );
  const issued = (
    await call('client.issue', {
      label: 'read-only',
      scopes: ['system.read', 'sessions.read'],
      operationId: crypto.randomUUID(),
    })
  ).result;
  assert.ok(issued.accessToken);
  assert.equal((await call('session.list', {}, issued.accessToken)).result.total, 3);
  assert.equal(
    (
      await call(
        'session.create',
        { mode: 'chat', operationId: crypto.randomUUID() },
        issued.accessToken,
      )
    ).error.data.reason,
    'FORBIDDEN',
  );
  const v1 = await fetch(address.url + '/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + issued.accessToken },
    body: '{}',
  });
  assert.equal(v1.status, 401);
  const settings = (await call('settings.get')).result;
  assert.equal(settings.values.llm.apiKey, undefined);
  await host.api.setSettings({
    mcp: {
      servers: [
        {
          name: 'secret-service',
          args: ['--token', 'hidden'],
          url: 'https://user:pass@example.com/mcp?token=hidden',
        },
      ],
    },
  });
  assert.ok(!JSON.stringify((await call('settings.get')).result).includes('hidden'));
  assert.ok(!JSON.stringify((await call('settings.get')).result).includes('user:pass'));
  await host.api.setSettings({ language: 'en' });
  for (let i = 0; i < 100 && !events.some((e) => e.channel === 'settings:changed'); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(events.some((e) => e.channel === 'settings:changed'));
  assert.equal(
    (
      await call('settings.patch', {
        expectedRevision: settings.revision,
        changes: { language: 'de' },
        operationId: crypto.randomUUID(),
      })
    ).error.data.reason,
    'REVISION_CONFLICT',
  );
  const key = host.runtime.listSessions()[0].key;
  const pending = host.runtime.sessions
    .get(key)
    .agent.requestApproval('gpio_write', { resource: 'gpio:17' });
  const interaction = host.runtime.getSessionDetails(key).pendingInteraction;
  assert.ok(interaction.id);
  assert.equal(
    (
      await call('interaction.answer', {
        sessionId: key,
        interactionId: 'stale',
        revision: 1,
        response: true,
        operationId: crypto.randomUUID(),
      })
    ).error.data.reason,
    'REVISION_CONFLICT',
  );
  await call('interaction.answer', {
    sessionId: key,
    interactionId: interaction.id,
    revision: interaction.revision,
    response: true,
    operationId: crypto.randomUUID(),
  });
  assert.equal(await pending, true);
  const question = host.runtime.sessions.get(key).agent.executeTool('askQuestions', {
    questions: [{ question: 'Choose a pin', options: [{ label: 'GPIO 17' }] }],
  });
  let currentQuestion;
  for (
    let i = 0;
    i < 100 && !(currentQuestion = host.runtime.getSessionDetails(key).pendingInteraction);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(currentQuestion, 'question tool publishes a pending interaction');
  assert.equal(currentQuestion.kind, 'questions');
  const answers = [{ question: 'Choose a pin', answer: 'GPIO 17' }];
  await call('interaction.answer', {
    sessionId: key,
    interactionId: currentQuestion.id,
    revision: currentQuestion.revision,
    answers,
    operationId: crypto.randomUUID(),
  });
  assert.deepEqual((await question).answers, answers);
  assert.equal(
    (
      await call('interaction.answer', {
        sessionId: key,
        interactionId: currentQuestion.id,
        revision: currentQuestion.revision,
        answers,
        operationId: crypto.randomUUID(),
      })
    ).error.data.reason,
    'REVISION_CONFLICT',
  );
  const longMessage = '大消息'.repeat(12000),
    cm = host.runtime.sessions.get(key).agent.contextManager;
  cm.addMessage({ role: 'assistant', content: longMessage });
  const listed = (await call('session.messages', { sessionId: key })).result.items.find(
    (m) => m.truncated,
  );
  assert.ok(listed);
  let offset = 0,
    json = '',
    sha256;
  do {
    const chunk = (
      await call('session.message', {
        sessionId: key,
        messageIndex: listed.messageIndex,
        offset,
        ...(sha256 ? { sha256 } : {}),
      })
    ).result;
    json += chunk.text;
    offset = chunk.nextOffset;
    sha256 = chunk.sha256;
  } while (offset !== null);
  assert.equal(JSON.parse(json).content, longMessage);
  await call('client.revoke', { clientId: issued.id, operationId: crypto.randomUUID() });
  assert.ok((await call('system.hello', {}, issued.accessToken)).error);
});

test(
  'Node provider transport executes a real HTTP tool turn and native child with a one-task limit',
  { timeout: 20000 },
  async (t) => {
    const http = require('node:http');
    let calls = 0;
    const provider = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls++;
      const last = body.messages.at(-1);
      const message =
        body.tools?.some((tool) => tool.function?.name === 'readFile') &&
        last.role !== 'tool' &&
        String(last.content).includes('read fixture')
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'file-read',
                  type: 'function',
                  function: { name: 'readFile', arguments: JSON.stringify({ path: file }) },
                },
              ],
            }
          : {
              role: 'assistant',
              content: last.role === 'tool' ? 'Read the fixture successfully' : 'Child completed',
            };
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'mock-response',
          choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 10 },
        }),
      );
    });
    await new Promise((r) => provider.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => provider.close(r)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-provider-')),
      file = path.join(dir, 'fixture.txt');
    fs.writeFileSync(file, 'fixture contents');
    const host = await createNodeRuntime({
      dataDir: path.join(dir, 'profile'),
      workspaceRoot: dir,
      settings: {
        language: 'en',
        llm: {
          provider: 'openai',
          model: 'fixture',
          apiKey: 'test-key',
          apiUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
          streamResponses: false,
        },
        decision: { enabled: false },
        automaticMemory: { enabled: false },
        sessions: { maxConcurrent: 1 },
      },
    });
    t.after(async () => {
      await host.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const session = host.runtime.createSession({ mode: 'code', workspacePath: dir });
    await host.runtime.initialize({ key: session.key });
    const result = await host.runtime.sendMessage(session.key, 'read fixture');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(calls >= 2);
    assert.ok(
      JSON.stringify(host.runtime.getSessionDetails(session.key).messages).includes(
        'Read the fixture successfully',
      ),
    );
    const parent = host.runtime.sessions.get(session.key);
    parent.busy = true;
    try {
      const child = await host.api.nativeSubagentStart(session.key, {
        task: 'Return a short finding',
        tools: ['readFile'],
        wait: true,
      });
      assert.equal(child.ok, true, JSON.stringify(child));
    } finally {
      parent.busy = false;
    }
  },
);
test('workspace guard resolves parent traversal and symlinks before file access', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'root'));
  fs.mkdirSync(path.join(dir, 'outside'));
  assert.equal(confinePath(path.join(dir, 'root'), 'new.txt'), path.join(dir, 'root', 'new.txt'));
  assert.throws(() => confinePath(path.join(dir, 'root'), '../outside/file'));
  fs.symlinkSync(
    path.join(dir, 'outside'),
    path.join(dir, 'root', 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => confinePath(path.join(dir, 'root'), 'link/new.txt'));
});
