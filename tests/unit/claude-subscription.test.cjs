/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  ClaudeAccounts,
  subscriptionEnvironment,
} = require('../../src/main/services/claude-accounts');
const { fetchClaude, preparePrompt } = require('../../src/main/services/claude-transport');
const { consumeSSEStream, abortRequests } = require('../../src/main/llm-retry');

test('subscription environment excludes API keys, alternative endpoints, inherited OAuth and cloud billing', () => {
  const env = subscriptionEnvironment('/private/profile', {
    PATH: '/bin',
    HTTPS_PROXY: 'http://proxy',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_BASE_URL: 'https://proxy.invalid',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'other-app',
    CLAUDECODE: '1',
    NODE_OPTIONS: '--require=other-app.cjs',
    ELECTRON_RUN_AS_NODE: '1',
    GOOGLE_APPLICATION_CREDENTIALS: '/other/account',
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/private/profile');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HTTPS_PROXY, 'http://proxy');
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDECODE',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ])
    assert.equal(env[key], undefined);
});

async function accountFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-claude-test-'));
  const processes = [],
    events = [];
  const accounts = new ClaudeAccounts({
    root,
    executablePath: () => '/official/claude',
    publish: (...event) => events.push(event),
    spawnImpl: (file, args, options) => {
      const proc = new EventEmitter();
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => proc.emit('close', 1);
      processes.push({ file, args, options, proc });
      if (args[1] === 'logout') setImmediate(() => proc.emit('close', 0));
      options.signal?.addEventListener(
        'abort',
        () => {
          proc.emit('error', new Error('Aborted'));
          proc.emit('close', 1);
        },
        { once: true },
      );
      return proc;
    },
  });
  t.after(async () => {
    accounts.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const until = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail('Fixture operation did not progress');
  };
  const finishStatus = (plan) => {
    const proc = processes.at(-1).proc;
    proc.stdout.end(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        subscriptionType: plan,
        email: 'fixture@example.invalid',
      }),
    );
    proc.emit('close', 0);
  };
  return { accounts, processes, events, root, until, finishStatus };
}
test('official login persists isolated Pro/Max metadata, switches cancel requests, logout never touches another profile', async (t) => {
  const f = await accountFixture(t),
    { accounts } = f;
  const login = await accounts.login();
  assert.deepEqual(f.processes[0].args, ['auth', 'login', '--claudeai']);
  assert.equal(f.processes[0].options.cwd, path.join(f.root, login.id));
  f.processes[0].proc.stdout.write('Open https://claude.ai/oauth/authorize?state=fixture\n');
  assert.match(accounts.snapshot().pending.url, /^https:\/\/claude\.ai\//);
  f.processes[0].proc.emit('close', 0);
  await f.until(() => f.processes.length === 2);
  f.finishStatus('pro');
  await f.until(() => !accounts.pending);
  assert.equal((await accounts.status()).activeId, login.id);
  assert.equal((await accounts.status()).accounts[0].plan, 'pro');
  const controller = new AbortController();
  accounts.requests.add(controller);
  const switching = accounts.switchAccount(login.id);
  await f.until(() => f.processes.length === 3);
  f.finishStatus('pro');
  await switching;
  assert.equal(controller.signal.aborted, true);
  const sibling = path.join(f.root, 'unrelated-claude-profile');
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'keep'), 'keep');
  await accounts.logout(login.id);
  assert.equal(await fs.readFile(path.join(sibling, 'keep'), 'utf8'), 'keep');
  assert.equal((await accounts.status()).accounts.length, 0);
});
test('API/Console and unsupported subscription logins are rejected, cancellation prevents a late login commit', async (t) => {
  const f = await accountFixture(t);
  const login = await f.accounts.login();
  f.processes[0].proc.emit('close', 0);
  await f.until(() => f.processes.length === 2);
  f.finishStatus('free');
  await f.until(() => !f.accounts.pending);
  assert.match(f.accounts.snapshot().error, /Pro or Max/);
  assert.equal(f.accounts.snapshot().activeId, null);
  await f.accounts.login();
  f.processes.at(-1).proc.emit('close', 0);
  await f.until(() => f.processes.at(-1).args[1] === 'status');
  const consoleStatus = f.processes.at(-1).proc;
  consoleStatus.stdout.end(
    JSON.stringify({ loggedIn: true, authMethod: 'api_key', subscriptionType: 'max' }),
  );
  consoleStatus.emit('close', 0);
  await f.until(() => !f.accounts.pending);
  assert.equal(f.accounts.snapshot().activeId, null);
  await f.accounts.login();
  f.accounts.cancel();
  f.processes.at(-1).proc.emit('close', 0);
  assert.equal(f.accounts.snapshot().activeId, null);
  assert.equal(
    f.accounts.snapshot().accounts.some((a) => a.id === login.id),
    false,
  );
});

test('cancel during account verification cannot activate or persist the completed OAuth login', async (t) => {
  const f = await accountFixture(t);
  await f.accounts.login();
  f.processes[0].proc.emit('close', 0);
  await f.until(() => f.processes.length === 2);
  f.accounts.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.accounts.snapshot().activeId, null);
  assert.equal(f.accounts.snapshot().accounts.length, 0);
});

test('historical attachments remain native images, opaque reasoning never becomes prompt text', () => {
  const prompt = preparePrompt([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Image question' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
      ],
    },
    {
      role: 'assistant',
      content: 'Description',
      providerReasoning: { data: 'opaque-not-a-message' },
    },
    { role: 'user', content: 'Continue' },
  ]);
  assert.equal(prompt.content.filter((b) => b.type === 'image').length, 1);
  const text = prompt.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  assert.ok(!text.includes('aW1hZ2U='));
  assert.ok(!text.includes('opaque-not-a-message'));
  assert.ok(text.includes('Description') && text.includes('Continue'));
});

async function sdkFixture(frames, onQuery = () => {}) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  let closed = 0,
    released = 0;
  const accounts = {
    lease: async (_id, controller) => ({
      directory: os.tmpdir(),
      executable: '/official/claude',
      env: { CLAUDE_CONFIG_DIR: '/private/profile' },
      signal: controller.signal,
      release: () => released++,
    }),
    sdkLoader: async () => ({
      ...sdk,
      query: (config) => {
        onQuery(config);
        const iterator = (async function* () {
          for (const frame of frames) yield frame;
        })();
        iterator.close = () => closed++;
        return iterator;
      },
    }),
  };
  return { accounts, counts: () => ({ closed, released }) };
}
test('real SDK tool definitions return native CIBYP calls without executing them; readable thinking and cache usage survive streaming', async () => {
  let config;
  const f = await sdkFixture(
    [
      {
        type: 'stream_event',
        event: { delta: { type: 'thinking_delta', thinking: 'Readable reasoning' } },
      },
      {
        type: 'stream_event',
        event: { delta: { type: 'text_delta', text: 'Inspecting the file' } },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Readable reasoning' },
            { type: 'redacted_thinking', data: 'encrypted-not-readable' },
            { type: 'text', text: 'Inspecting the file' },
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'mcp__cibyp__readFile',
              input: { path: 'file.txt' },
            },
          ],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 6,
          },
        },
      },
    ],
    (value) => {
      config = value;
    },
  );
  const result = await fetchClaude(f.accounts, {
    stream: true,
    model: 'sonnet',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: 'CIBYP persona' },
      { role: 'user', content: 'Read the file' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'readFile',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ],
  });
  assert.equal(result.ok, true);
  const parsed = await consumeSSEStream(
    result.response.body,
    () => {},
    'claude-fixture',
    'openai',
    5000,
    {},
  );
  result.releaseController();
  assert.equal(parsed.content, 'Inspecting the file');
  assert.equal(parsed.reasoning, 'Readable reasoning');
  assert.equal(parsed.reasoningKind, 'summary');
  assert.ok(parsed.providerReasoning.items.some((item) => item.data?.type === 'redacted_thinking'));
  assert.equal(parsed.usage.prompt_tokens, 35);
  assert.equal(parsed.usage.total_tokens, 41);
  assert.equal(parsed.toolCalls[0].function.name, 'readFile');
  assert.equal(parsed.toolCalls[0].function.arguments, '{"path":"file.txt"}');
  assert.deepEqual(config.options.tools, []);
  assert.equal(config.options.strictMcpConfig, true);
  assert.equal(config.options.maxTurns, 1);
  assert.equal(config.options.persistSession, false);
  assert.equal(config.options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '1024');
  assert.equal((await config.options.canUseTool()).behavior, 'deny');
  assert.deepEqual(f.counts(), { closed: 1, released: 1 });
});
test('SDK auth failures return errors without alternate HTTP billing; Stop cancels an SDK stream by session', async () => {
  const f = await sdkFixture([
    { type: 'assistant', error: 'authentication_failed', message: { content: [] } },
  ]);
  const failed = await fetchClaude(f.accounts, {
    stream: false,
    model: 'sonnet',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /authentication_failed/);
  let controller;
  const pending = {
    lease: async (_id, c) => {
      controller = c;
      await new Promise((_, reject) =>
        c.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }),
      );
    },
  };
  const running = fetchClaude(
    pending,
    { messages: [] },
    { sessionKey: 'claude-stop', requestId: 'stop-fixture' },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(abortRequests({ sessionKey: 'unrelated' }), 0);
  assert.equal(abortRequests({ sessionKey: 'claude-stop' }), 1);
  assert.equal((await running).ok, false);
  assert.equal(controller.signal.aborted, true);
});

test(
  'bundled official SDK initializes its isolated native runtime and SDK MCP server without a model request',
  { timeout: 25000, skip: !['x64', 'arm64'].includes(process.arch) },
  async (t) => {
    const { executable } = require('../../src/main/services/claude-accounts');
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = await import('zod');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-claude-native-'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    let run;
    t.after(async () => {
      clearTimeout(timer);
      controller.abort();
      run?.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    run = sdk.query({
      prompt: (async function* () {
        await new Promise((resolve) =>
          controller.signal.addEventListener('abort', resolve, { once: true }),
        );
      })(),
      options: {
        abortController: controller,
        cwd: root,
        env: subscriptionEnvironment(root),
        pathToClaudeCodeExecutable: executable(),
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
        persistSession: false,
        mcpServers: {
          cibyp: sdk.createSdkMcpServer({
            name: 'cibyp',
            tools: [
              sdk.tool('probe', 'A fixture only', { value: z.string() }, async () => ({
                content: [{ type: 'text', text: 'not executed' }],
              })),
            ],
          }),
        },
      },
    });
    const info = await run.accountInfo();
    assert.ok(!info.email, 'fresh profile must not borrow another application login');
    const status = await run.mcpServerStatus();
    assert.equal(status.find((server) => server.name === 'cibyp')?.status, 'connected');
    const models = await run.supportedModels();
    assert.ok(Array.isArray(models));
  },
);
