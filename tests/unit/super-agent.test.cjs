/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SuperAgentService } = require('../../src/main/services/super-agent');
const { SuperStore } = require('../../src/main/services/super-agent/store');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let n = 0; n < 200; n++) {
    const r = await fn();
    if (r) return r;
    await delay(10);
  }
  throw Error('Condition timed out');
}
function fixture(t, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-super-test-'));
  let settings = { llm: { pool: [] }, superAgent: { maxWorkers: 2, ...config } },
    service;
  const running = new Map(),
    routes = [],
    stopped = [];
  const runtime = {
    getSettings: async () => settings,
    saveSettings: async (p) => {
      settings = { ...settings, ...p };
    },
    getView: () => null,
  };
  const adapter = {
    async route(key, events) {
      routes.push(events.map((e) => e.id));
      for (const e of events)
        await service.tool(key, 'super_route', {
          eventId: e.id,
          action: 'create',
          title: e.text.slice(0, 40),
        });
    },
    async run(task, events, _config, checkpoint) {
      checkpoint({ conversationId: task.id, workspacePath: '/fixture/' + task.id });
      await new Promise((resolve) => running.set(task.id, { task, events, resolve }));
    },
    stop(key) {
      stopped.push(key);
      for (const r of running.values()) if (r.task.workerKey === key) r.resolve();
    },
    async close() {
      for (const r of running.values()) r.resolve();
    },
  };
  service = new SuperAgentService({ directory, runtime, adapter, autoStart: false });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const submit = (text, extra = {}) =>
    service.request('submit', { text, operationId: randomUUID(), ...extra });
  const finish = async (id, status = 'completed') => {
    const r = running.get(id);
    await service.tool(r.task.workerKey, 'super_report', {
      status,
      summary: 'Verified result',
      evidence: status === 'completed' ? ['fixture deliverable'] : [],
    });
    r.resolve();
    await until(() => !service.active.has(id));
  };
  return { service, directory, runtime, adapter, running, routes, stopped, submit, finish };
}
test('SuperAgent routes independent requests concurrently, deduplicates intake, and persists deliveries before acknowledgement', async (t) => {
  const f = fixture(t),
    op = randomUUID();
  const first = await f.submit('Task A', { operationId: op });
  const repeated = await f.submit('Task A', { operationId: op });
  assert.equal(repeated.id, first.id);
  await assert.rejects(f.submit('Different', { operationId: op }), /CONFLICT/);
  await f.submit('Task B');
  await until(() => f.running.size === 2);
  const tasks = (await f.service.request('list')).items;
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((x) => x.status === 'running'));
  await f.finish(tasks[0].id);
  await f.finish(tasks[1].id);
  const deliveries = await f.service.request('deliveries');
  assert.equal(deliveries.total, 2);
  await f.service.request('ack', { id: deliveries.items[0].id });
  assert.equal((await f.service.request('deliveries')).items[0].read, true);
  const disk = JSON.parse(fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8'));
  assert.ok(disk.state.tasks.every((x) => x.status === 'completed'));
  assert.ok(!JSON.stringify(disk).includes('apiKey'));
});
test('thread subscriptions bypass the Router and task recall is scoped', async (t) => {
  const f = fixture(t);
  await f.submit('First', { threadId: 'thread-one' });
  await until(() => f.running.size === 1);
  const task = (await f.service.request('list')).items[0];
  await f.finish(task.id, 'waiting');
  const count = f.routes.length;
  await f.submit('Follow up', { threadId: 'thread-one' });
  await until(() => f.service.active.has(task.id));
  assert.equal(f.routes.length, count);
  const detail = await f.service.request('get', { id: task.id });
  assert.equal(detail.events.length, 2);
  const key = detail.task.workerKey;
  const slice = await f.service.tool(key, 'super_recall', { id: task.id, maxChars: 20 });
  assert.equal(slice.text.length, 20);
  assert.equal(slice.next, 20);
  await assert.rejects(f.service.tool(key, 'super_recall', { id: 'foreign-task' }), /FORBIDDEN/);
  await f.finish(task.id);
});
test('a stop fences late reports and ordinary tools, including delayed worker initialization', async (t) => {
  const f = fixture(t);
  await f.submit('Stop this');
  await until(() => f.running.size === 1);
  const task = (await f.service.request('list')).items[0];
  await f.service.request('stop', { id: task.id, generation: task.generation });
  assert.throws(() => f.service.authorize(task.workerKey), /CHANGED|FORBIDDEN/);
  await assert.rejects(
    f.service.tool(task.workerKey, 'super_report', {
      status: 'completed',
      summary: 'Late result',
      evidence: ['late'],
    }),
    /CHANGED|FORBIDDEN/,
  );
  await until(() => !f.service.active.size);
  assert.equal((await f.service.request('get', { id: task.id })).task.status, 'stopped');
  await assert.rejects(
    f.service.request('retry', { id: task.id, generation: task.generation }),
    /CHANGED/,
  );
});
test('a normal answer does not complete a task; restart retains an interrupted task for reconciliation', async (t) => {
  const f = fixture(t);
  await f.submit('Needs evidence');
  await until(() => f.running.size === 1);
  let task = (await f.service.request('list')).items[0];
  f.running.get(task.id).resolve();
  await until(() => !f.service.active.size);
  task = (await f.service.request('get', { id: task.id })).task;
  assert.equal(task.status, 'needs_attention');
  assert.equal(task.reason, 'SUPER_REPORT_REQUIRED');
  await f.service.request('retry', { id: task.id, generation: task.generation });
  await until(() => f.service.active.size === 1);
  // Simulate a process dying without writing another task transition.
  f.service.closed = true;
  f.service.store.close();
  for (const r of f.running.values()) r.resolve();
  await Promise.allSettled([...f.service.active.values()]);
  const recovered = new SuperAgentService({
    directory: f.directory,
    runtime: f.runtime,
    adapter: f.adapter,
    autoStart: false,
  });
  t.after(() => recovered.dispose());
  const saved = (await recovered.request('get', { id: task.id })).task;
  assert.equal(saved.status, 'needs_attention');
  assert.equal(saved.reason, 'SUPER_INTERRUPTED');
  assert.ok(saved.conversationId);
  assert.equal(recovered.active.size, 0);
});
test('candidate observations are ignored until an owner enables a source and policy', async (t) => {
  const f = fixture(t),
    event = {
      source: 'github',
      text: 'Please fix',
      threadId: 'issue-1',
      operationId: randomUUID(),
    };
  assert.deepEqual(await f.service.request('observe', event), { ignored: true });
  await f.service.request('configure', {
    proactive: true,
    sources: ['github'],
    rules: 'Investigate reproducible defects without modifications.',
  });
  await f.service.request('observe', event);
  await until(() => f.running.size === 1);
  assert.equal((await f.service.request('list')).items[0].observation, true);
  await assert.rejects(
    f.service.request('configure', { routerModel: 'missing' }),
    /MODEL_UNAVAILABLE/,
  );
  await assert.rejects(f.service.request('configure', { maxWorkers: 100 }), /INVALID/);
});
test('token limits and repeated ineffective tool actions pause rather than silently retry', async (t) => {
  const f = fixture(t, { maxTokens: 1000 });
  await f.submit('Budget');
  await until(() => f.running.size === 1);
  let task = (await f.service.request('list')).items[0];
  f.service.event({ type: 'model-response', key: task.workerKey, usage: { total_tokens: 1001 } });
  assert.equal(
    (await f.service.request('get', { id: task.id })).task.reason,
    'SUPER_BUDGET_REACHED',
  );
  await until(() => !f.service.active.size);
  await f.submit('Loop');
  await until(() => f.service.active.size === 1);
  task = (await f.service.request('list')).items[0];
  for (let i = 0; i < 8; i++)
    f.service.event({
      type: 'tool-call',
      status: 'done',
      name: 'readFile',
      args: { path: 'same.txt' },
      key: task.workerKey,
    });
  assert.equal(
    (await f.service.request('get', { id: task.id })).task.reason,
    'SUPER_REPEATED_ACTION',
  );
});
test('single-owner storage, corruption and missing checksums fail closed', async (t) => {
  const f = fixture(t);
  assert.throws(() => new SuperStore(f.directory), /LOCKED/);
  await f.service.dispose();
  const file = path.join(f.directory, 'state.json'),
    raw = JSON.parse(fs.readFileSync(file));
  raw.state.paused = false;
  raw.state.revision++;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => new SuperStore(f.directory), /INVALID/);
  assert.equal(fs.existsSync(path.join(f.directory, 'owner.lock')), false);
});

test('an independent Watchdog can inspect only its task and cannot stop a replacement generation', async (t) => {
  const f = fixture(t);
  await f.submit('Review progress');
  await until(() => f.running.size === 1);
  const task = (await f.service.request('list')).items[0];
  let release, arrived;
  const ready = new Promise((r) => (arrived = r)),
    gate = new Promise((r) => (release = r));
  t.after(() => release());
  f.adapter.review = async (key, offered) => {
    const recall = await f.service.tool(key, 'super_recall', { id: offered.id });
    assert.ok(recall.text.includes('Review progress'));
    await assert.rejects(f.service.tool(key, 'super_recall', { id: 'other' }), /FORBIDDEN/);
    await assert.rejects(
      f.service.tool(key, 'super_route', { eventId: 'other', action: 'create', title: 'No' }),
      /FORBIDDEN/,
    );
    arrived();
    await gate;
    await assert.rejects(
      f.service.tool(key, 'super_watch', {
        taskId: offered.id,
        action: 'pause',
        reason: 'Late diagnosis',
      }),
      /CHANGED/,
    );
  };
  const review = f.service.review(f.service.find(f.service.store.state, task.id));
  await ready;
  await f.service.request('stop', { id: task.id, generation: task.generation });
  release();
  await review;
  assert.equal((await f.service.request('get', { id: task.id })).task.status, 'stopped');
});

test('TUI SuperAgent uses named task controls and shared model labels while quant stays gated', async (t) => {
  const { TuiApp } = require('../../src/tui/app');
  const { setLanguage } = require('../../src/tui/text');
  setLanguage('en');
  const config = {
    enabled: true,
    maxWorkers: 2,
    maxAttempts: 12,
    maxTokens: 100000,
    routerModel: 'router',
    workerModel: '',
    watchdog: true,
    proactive: false,
    rules: '',
    sources: [],
  };
  const task = {
    id: 'task',
    title: 'A real task',
    mode: 'code',
    status: 'running',
    generation: 4,
    summary: 'Working',
    evidence: [],
    tokens: 20,
    attempts: 1,
    workerKey: 'worker',
  };
  const calls = [];
  const app = new TuiApp({
    runtime: {
      getSettings: async () => ({
        features: { quant: false },
        llm: { pool: [{ id: 'router', label: 'Quick coordinator', model: 'raw-id' }] },
      }),
      api: {
        backendRequest: async (method, action, input) => {
          calls.push({ method, action, input });
          if (action === 'status') return { config, paused: false, pending: 0 };
          if (action === 'list') return { items: [task], next: null };
          if (action === 'get') return { task, events: [], view: null };
          return { ok: true };
        },
      },
    },
  });
  t.after(() => app.dispose());
  const choose = (value) => {
    const i = app.state.modal.options.findIndex((o) => o.value === value);
    assert.ok(i >= 0, 'Missing option ' + value);
    return app._chooseModalOption(i);
  };
  await assert.rejects(app._runCommand('quant', ''), /QUANT_DISABLED/);
  assert.equal(calls.length, 0);
  await app._runCommand('super', '');
  assert.equal(app.state.modal.title, 'SuperAgent');
  await choose('settings');
  assert.ok(app.state.modal.options.some((o) => o.label.includes('Quick coordinator')));
  assert.ok(!app.state.modal.options.some((o) => o.label.includes('raw-id')));
  await choose('back');
  await choose('task');
  await choose('stop');
  assert.deepEqual(calls.find((r) => r.action === 'stop').input, { id: 'task', generation: 4 });
  await app.superAgentBrowser.create();
  await choose('code');
  app.state.modal.editor.setValue('Build an artifact');
  await app.state.modal.onSubmit();
  const submitted = calls.find((r) => r.action === 'submit');
  assert.equal(submitted.input.mode, 'code');
  assert.ok(submitted.input.operationId);
  assert.ok(calls.every((r) => r.method === 'superagent:request'));
});

test('a failed durable write stops active workers and prevents further tools', async (t) => {
  const f = fixture(t);
  await f.submit('Durable task');
  await until(() => f.running.size === 1);
  const task = (await f.service.request('list')).items[0],
    rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.directory, 'state.json'))
      throw Object.assign(Error('fixture disk failure'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    await assert.rejects(f.submit('Cannot commit this event'), /SUPER_STORAGE_UNAVAILABLE/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(f.service.store.state.events.length, 1);
  assert.ok(f.stopped.includes(task.workerKey));
  assert.throws(() => f.service.authorize(task.workerKey), /STORAGE_UNAVAILABLE/);
  await assert.rejects(
    f.service.tool(task.workerKey, 'super_report', {
      status: 'completed',
      summary: 'No',
      evidence: ['No'],
    }),
    /STORAGE_UNAVAILABLE/,
  );
  assert.equal((await f.service.request('status')).error, 'SUPER_STORAGE_UNAVAILABLE');
});
