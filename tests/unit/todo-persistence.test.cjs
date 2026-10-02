const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TodoService } = require('../../src/main/services/todo-service');

test('unreadable global todos remain intact and mutations cannot replace them', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-todos-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'todos.json');
  const content = '{"items": incomplete';
  fs.writeFileSync(file, content);
  const service = new TodoService({ file });
  await assert.rejects(service.get(), /Unable to read persistent todos/);
  assert.equal((await service.mutate({ action: 'add', text: 'Preserve existing data' })).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('global todos survive restart, simultaneous session edits and cleared history', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-todos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = path.join(root, 'history');
  fs.mkdirSync(history);
  fs.writeFileSync(
    path.join(history, 'a.json'),
    JSON.stringify({ todoItems: [{ id: 1, text: 'Old task', done: false }] }),
  );
  const options = { file: path.join(root, 'todos.json'), historyDirectories: [history] };
  const service = new TodoService(options);
  assert.equal((await service.get()).items[0].text, 'Old task');
  const added = await Promise.all([
    service.mutate({ action: 'add', text: 'Chat task' }),
    service.mutate({ action: 'add', text: 'Code task' }),
  ]);
  assert.notEqual(added[0].id, added[1].id);
  await service.mutate({ action: 'update', id: added[0].id, text: 'Edited task' });
  await service.mutate({ action: 'toggle', id: added[1].id });
  fs.unlinkSync(path.join(history, 'a.json'));
  const reopened = new TodoService(options);
  const items = (await reopened.get()).items;
  assert.deepEqual(
    items.map((item) => [item.text, item.done]),
    [
      ['Old task', false],
      ['Edited task', false],
      ['Code task', true],
    ],
  );
  await reopened.mutate({ action: 'remove', id: items[0].id });
  fs.writeFileSync(
    path.join(history, 'restored.json'),
    JSON.stringify({ todoItems: [{ id: 1, text: 'Old task', done: false }] }),
  );
  assert.equal(
    (await new TodoService(options).get()).items.some((item) => item.text === 'Old task'),
    false,
    'Restoring a conversation must not resurrect deleted todos',
  );
});

test('invalid actions leave persistent todos unchanged', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-todos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new TodoService({ file: path.join(root, 'todos.json') });
  const before = await service.get();
  assert.equal((await service.mutate({ action: 'add', text: '' })).ok, false);
  assert.equal((await service.mutate({ action: 'toggle', id: 22 })).ok, false);
  assert.deepEqual(await service.get(), before);
});
