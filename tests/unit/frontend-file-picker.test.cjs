/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerFrontendFilePicker } = require('../../src/main/services/frontend-file-picker');
const { VmFs } = require('../../src/main/vm/vm-fs');
function handlers(vmService) {
  const handlers = new Map();
  registerFrontendFilePicker({
    ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
    vmService,
    getSettings: () => ({}),
  });
  return handlers;
}
test('browser workspace reads actual host files and rejects directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-web-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, '文档.txt');
  await fs.writeFile(file, 'Host file bytes');
  const api = handlers({ runtime: { location: 'host' } });
  const result = await api.get('filePicker:download')({}, file);
  assert.equal(result.ok, true);
  assert.equal(result.bytes.toString(), 'Host file bytes');
  assert.equal(result.name, '文档.txt');
  assert.equal((await api.get('filePicker:download')({}, root)).ok, false);
});
test('VM workspace download uses guest bytes and checks size before reading', async (t) => {
  t.mock.method(VmFs.prototype, 'toVm', (raw) => raw);
  t.mock.method(VmFs.prototype, 'stat', async (raw) => ({
    isFile: true,
    size: raw.endsWith('huge') ? 101 * 1024 * 1024 : 5,
  }));
  const reads = t.mock.method(VmFs.prototype, 'readBuffer', async (raw) => {
    assert.equal(raw, '/workspace/note');
    return Buffer.from('Guest');
  });
  const api = handlers({ runtime: { location: 'vm' } });
  assert.equal(
    (await api.get('filePicker:download')({}, '/workspace/note')).bytes.toString(),
    'Guest',
  );
  assert.equal((await api.get('filePicker:download')({}, '/workspace/huge')).ok, false);
  assert.equal(reads.mock.callCount(), 1);
});

test('browser editor saves text and binary files on the host, reporting IO failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-web-write-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const save = handlers({ runtime: { location: 'host' } }).get('filePicker:write');
  const file = path.join(root, 'project.json');
  assert.equal((await save({}, file, '{"title":"工程"}')).ok, true);
  assert.equal(await fs.readFile(file, 'utf-8'), '{"title":"工程"}');
  const bytes = Uint8Array.of(137, 80, 78, 71).buffer;
  assert.equal((await save({}, file, bytes)).ok, true);
  assert.deepEqual(await fs.readFile(file), Buffer.from(bytes));
  assert.equal((await save({}, path.join(root, 'missing', 'project'), 'text')).ok, false);
  assert.equal((await save({}, file, { invalid: true })).ok, false);
});

test('browser editor saves guest bytes through VM IO', async (t) => {
  t.mock.method(VmFs.prototype, 'toVm', (raw) => raw);
  const writes = t.mock.method(VmFs.prototype, 'writeBuffer', async (file, bytes) => {
    assert.equal(file, '/workspace/project');
    assert.equal(bytes.toString(), 'Guest project');
  });
  const result = await handlers({ runtime: { location: 'vm' } }).get('filePicker:write')(
    {},
    '/workspace/project',
    'Guest project',
  );
  assert.equal(result.ok, true);
  assert.equal(writes.mock.callCount(), 1);
});
