const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { ToolExposure } = require('../../src/renderer/js/tool-exposure');
const { ContextManager } = require('../../src/renderer/js/context-manager');
const AgentHostKit = require('../../src/agent/host');

function catalog(mode = 'chat') {
  const scope = {
    console,
    window: {},
    document: {},
    module: { exports: {} },
    ToolExposure,
    ContextManager,
    AgentHostKit,
  };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync('src/renderer/js/tools-def.js', 'utf8'), scope);
  vm.runInContext(
    `globalThis.defs = getAllToolDefinitions('${mode}'); globalThis.schemas = getToolSchemas({}, '${mode}');`,
    scope,
  );
  return scope;
}

test('rich built-in catalog stays reachable within a bounded schema envelope', () => {
  for (const mode of ['chat', 'code', 'babe']) {
    const fixture = catalog(mode);
    const registry = new ToolExposure();
    registry.configure(fixture.defs, fixture.schemas, 4000);
    const initial = registry.schemas();
    assert.ok(Math.ceil(JSON.stringify(initial).length / 4) <= 4000);
    if (mode !== 'babe')
      assert.ok(registry.lastStats.estimatedTokens < registry.lastStats.fullEstimatedTokens / 2);
    else
      assert.equal(
        initial.length,
        fixture.schemas.length,
        'small catalogs need no discovery overhead',
      );
    for (const tool of fixture.defs) {
      const result = registry.search({ names: [tool.name] });
      assert.equal(result.tools[0].name, tool.name);
      assert.ok(registry.catalog.has(tool.name));
      assert.ok(Math.ceil(JSON.stringify(registry.schemas()).length / 4) <= 4000);
      assert.equal(registry.resolve({ name: tool.name, arguments_json: '{}' }).name, tool.name);
    }
  }
});

test('exact names, categories and Chinese capability searches are paginated and bounded', () => {
  const fixture = catalog();
  const registry = new ToolExposure();
  registry.configure(fixture.defs, fixture.schemas);
  assert.ok(registry.search().categories.some((c) => c.name === '电脑控制'));
  assert.ok(
    registry.search({ query: '帮我控制电脑和鼠标' }).tools.some((t) => t.name === 'computer'),
  );
  const first = registry.search({ category: '文件', limit: 2, load: false });
  assert.equal(first.tools.length, 2);
  assert.equal(first.nextOffset, 2);
  const second = registry.search({ category: '文件', offset: 2, limit: 2, load: false });
  assert.notEqual(second.tools[0].name, first.tools[0].name);
});

test('large MCP schemas remain callable through bounded discovery without duplicating definitions', () => {
  const schemas = [
    {
      type: 'function',
      function: {
        name: 'mcp_big',
        description: 'large integration',
        parameters: {
          type: 'object',
          properties: {
            options: { type: 'string', description: 'x'.repeat(80000) },
            value: { type: 'number' },
          },
          required: ['value'],
        },
      },
    },
  ];
  const registry = new ToolExposure();
  registry.configure([{ name: 'mcp_big', category: 'MCP:engineering' }], schemas, 1200);
  const result = registry.search({ names: ['mcp_big'] });
  assert.equal(result.tools[0].loaded, false);
  assert.ok(JSON.stringify(result).length < 2000);
  assert.ok(JSON.stringify(registry.schemas()).length < 4800);
  assert.equal(
    registry.describe({ name: 'mcp_big', path: '/properties/value' }).schema.type,
    'number',
  );
  assert.match(
    registry.describe({ name: 'mcp_big', path: '/properties/options' }).error,
    /too large/,
  );
  assert.equal(
    registry.resolve({ name: 'mcp_big', arguments_json: '{"value":42}' }).args.value,
    42,
  );
});

test('revocation, schema hot replacement and independent agents do not leak capabilities', () => {
  const fixture = catalog();
  const a = new ToolExposure(),
    b = new ToolExposure();
  for (const r of [a, b]) r.configure(fixture.defs, fixture.schemas);
  a.search({ names: ['computer'] });
  assert.throws(() => b.resolve({ name: 'computer', arguments_json: '{}' }), /discovered/);
  a.configure(
    fixture.defs.filter((t) => t.name !== 'computer'),
    fixture.schemas,
  );
  assert.throws(() => a.resolve({ name: 'computer', arguments_json: '{}' }), /enabled/);
  assert.equal(a.search({ names: ['computer'] }).unavailable[0], 'computer');
  assert.throws(() => b.resolve({ name: 'readFile', arguments_json: '[]' }), /discovered/);
  b.search({ names: ['readFile'] });
  assert.throws(() => b.resolve({ name: 'readFile', arguments_json: '[]' }), /JSON object/);
});

test('stable tool order is retained until a budget eviction is necessary', () => {
  const fixture = catalog();
  const registry = new ToolExposure();
  registry.configure(fixture.defs, fixture.schemas);
  const before = JSON.stringify(registry.schemas());
  registry.configure(fixture.defs, fixture.schemas);
  assert.equal(JSON.stringify(registry.schemas()), before);
  const first = registry.schemas().map((t) => t.function.name);
  registry.search({ names: ['computer'] });
  assert.deepEqual(
    registry
      .schemas()
      .map((t) => t.function.name)
      .slice(0, first.length),
    first,
  );
});

test('Agent discovery applies to Code, filters disabled tools and enforces sub-agent scope', async () => {
  const scope = catalog('code');
  scope.window.api = { readFile: async () => ({ ok: true, content: 'allowed' }) };
  vm.runInContext(fs.readFileSync('src/renderer/js/agent.js', 'utf8'), scope);
  const agent = new scope.module.exports.Agent();
  agent.mode = 'code';
  agent.settings = {
    llm: { maxContextLength: 32768 },
    toolExposure: { mode: 'adaptive', budgetTokens: 2000 },
    tools: { deleteFile: false },
  };
  assert.ok(agent.getRuntimeToolSchemas().some((t) => t.function.name === 'searchTools'));
  assert.equal((await agent.executeTool('searchTools', { names: ['deleteFile'] })).tools.length, 0);
  agent._toolScope = new Set(['readFile']);
  assert.equal(
    (await agent.executeTool('searchTools', { names: ['runTerminalCommand'] })).tools.length,
    0,
  );
  assert.equal((await agent.executeTool('runTerminalCommand', { command: 'pwd' })).ok, false);
  await agent.executeTool('searchTools', { names: ['readFile'] });
  const result = await agent.executeTool('invokeTool', {
    name: 'readFile',
    arguments_json: '{"path":"test.txt"}',
  });
  assert.equal(result.ok, true);
  agent.settings.tools.readFile = false;
  assert.equal(
    (
      await agent.executeTool('invokeTool', {
        name: 'readFile',
        arguments_json: '{"path":"test.txt"}',
      })
    ).ok,
    false,
  );
});

test('generic calls go through the actual Computer Use grant and sensitive-command approval before execution', async () => {
  for (const name of ['computer', 'runShellScriptCode']) {
    const scope = catalog();
    let requests = 0;
    const checks = [],
      executed = [];
    scope.window.api = {
      chatLLM: async () => ({
        ok: true,
        data: {
          choices: [
            {
              finish_reason: requests++ ? 'stop' : 'tool_calls',
              message:
                requests === 1
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: 'invoke-1',
                          type: 'function',
                          function: {
                            name: 'invokeTool',
                            arguments: JSON.stringify({
                              name,
                              arguments_json: JSON.stringify(
                                name === 'computer'
                                  ? { action: 'left_click', coordinate: [1, 1] }
                                  : { script: 'rm -rf /' },
                              ),
                            }),
                          },
                        },
                      ],
                    }
                  : { content: 'finished' },
            },
          ],
        },
      }),
    };
    vm.runInContext(fs.readFileSync('src/renderer/js/agent.js', 'utf8'), scope);
    const agent = new scope.module.exports.Agent();
    agent.settings = {
      llm: { streamResponses: false },
      toolExposure: { mode: 'adaptive' },
      tools: {},
      contextCompaction: { enabled: false },
    };
    agent.getSystemPrompt = () => 'test';
    agent._llmOptions = (value) => value;
    agent.requestToolAuth = async (tool, category) => {
      checks.push({ tool, category });
      return 'deny';
    };
    agent.requestApproval = async (tool, args) => {
      checks.push({ tool, args });
      return false;
    };
    const execute = agent.executeTool.bind(agent);
    agent.executeTool = async (tool, args) => {
      executed.push(tool);
      return execute(tool, args);
    };
    agent.prepareToolExposure().search({ names: [name] });
    agent.contextManager.addUserMessage('test');
    agent.running = true;
    agent.runId = 1;
    await agent.agentLoop(1);
    assert.equal(checks[0].tool, name);
    assert.equal(executed.length, 0, 'denied original tool must never be invoked indirectly');
    if (name === 'computer') assert.equal(checks[0].category, 'computerUse');
    else assert.equal(checks[0].args.script, 'rm -rf /');
  }
});

test('Jev automatic selection preloads tools in Chat and Code, respects budget, and makes no second selection-model call', async () => {
  for (const mode of ['chat', 'code']) {
    const scope = catalog(mode);
    const decisionCalls = [];
    let llmCalls = 0;
    scope.window.api = {
      decisionCall: async (request) => {
        decisionCalls.push(request);
        return {
          ok: true,
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [key, { noul: 0.95 }]),
          ),
        };
      },
      chatLLM: async () => {
        llmCalls++;
        throw new Error('Full-catalog selection must not run');
      },
    };
    vm.runInContext(fs.readFileSync('src/renderer/js/agent.js', 'utf8'), scope);
    const agent = new scope.module.exports.Agent();
    agent.mode = mode;
    agent.settings = {
      tools: {},
      llm: { maxContextLength: 32768 },
      autoOptimizeToolSelection: true,
      toolExposure: { mode: 'adaptive', budgetTokens: 1600 },
      decision: { enabled: true, usages: { toolSelection: true } },
    };
    agent.getSystemPrompt = () => 'test';
    await Promise.all([
      agent.optimizeToolsForConversation('搜索网站并下载文件'),
      agent.optimizeToolsForConversation('搜索网站并下载文件'),
    ]);
    assert.equal(decisionCalls.length, 1, 'concurrent requests share one Jev decision');
    assert.equal(llmCalls, 0);
    assert.match(agent.optimizedToolReason, /Jev/);
    assert.equal(
      agent.hasUsableOptimizedSelection(),
      true,
      'selection is not repeated each Code turn',
    );
    assert.ok(agent.getRuntimeToolSchemas().some((t) => t.function.name === 'searchTools'));
    assert.ok(Math.ceil(JSON.stringify(agent.getRuntimeToolSchemas()).length / 4) <= 1600);
    assert.ok(JSON.stringify(decisionCalls[0]).length < 15000);
    assert.ok(
      !JSON.stringify(decisionCalls[0]).includes('parameters'),
      'Jev sees categories, not full schemas',
    );
    assert.ok(
      (await agent.executeTool('searchTools', { names: ['downloadFile'] })).tools.length,
      'Jev omissions remain searchable',
    );
  }
});

test('Jev failure falls back locally, and resetting settings cancels stale decisions', async () => {
  const scope = catalog('code');
  let finish;
  let llmCalls = 0;
  scope.window.api = {
    decisionCall: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    chatLLM: () => {
      llmCalls++;
    },
  };
  vm.runInContext(fs.readFileSync('src/renderer/js/agent.js', 'utf8'), scope);
  const agent = new scope.module.exports.Agent();
  agent.mode = 'code';
  agent.getSystemPrompt = () => 'test';
  agent.settings = {
    tools: {},
    autoOptimizeToolSelection: true,
    toolExposure: { mode: 'adaptive', budgetTokens: 2000 },
    decision: { enabled: true, usages: { toolSelection: true } },
  };
  const pending = agent.optimizeToolsForConversation('读取文件');
  agent.applySettings({ ...agent.settings, autoOptimizeToolSelection: false });
  finish({ ok: true, answers: { c0: { noul: 1 } } });
  assert.equal((await pending).cancelled, true);
  assert.equal(agent.optimizedToolNames, null);
  agent.applySettings({ ...agent.settings, autoOptimizeToolSelection: true });
  scope.window.api.decisionCall = async () => ({ ok: false, error: 'unavailable' });
  const fallback = await agent.optimizeToolsForConversation('读取文件');
  assert.equal(fallback.localFallback, true);
  assert.equal(llmCalls, 0);
  assert.equal(agent.hasUsableOptimizedSelection(), true);
  assert.ok(agent.getRuntimeToolSchemas().some((t) => t.function.name === 'readFile'));
});
