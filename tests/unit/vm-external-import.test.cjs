/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { VmService } = require('../../src/main/vm/vm-service');
const { VmFs } = require('../../src/main/vm/vm-fs');
const { WorkspaceSync } = require('../../src/main/vm/vm-workspace');

function fixture(t, workspaceMode = 'shared') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-import-'));
  const host = path.join(root, 'project');
  fs.mkdirSync(host);
  const identity = createHash('sha256')
    .update(process.platform === 'win32' ? host.toLowerCase() : host)
    .digest('hex');
  const short = '/workspace/_external/project-' + identity.slice(0, 8);
  const full = '/workspace/_external/project-' + identity;
  const directories = new Set();
  const files = new Map();
  const calls = [];
  let syncResult = { ok: true };
  let readError;
  const services = [];
  const restart = () => {
    const vm = new VmService({
      app: { getPath: () => root },
      getSettings: () => ({
        runtime: { workspaceMode, vm: { workspaceRoot: path.join(root, 'workspaces') } },
      }),
    });
    vm.instance = { state: 'ready', dir: path.join(root, 'instance') };
    services.push(vm);
    return vm;
  };
  t.mock.method(VmFs.prototype, 'exists', async (value) => directories.has(value));
  t.mock.method(VmFs.prototype, 'readBuffer', async (value) => {
    if (readError) throw readError;
    if (!files.has(value)) throw Object.assign(new Error('No such file'), { code: 2 });
    return files.get(value);
  });
  t.mock.method(VmFs.prototype, 'writeBuffer', async (value, data) => files.set(value, data));
  t.mock.method(VmFs.prototype, 'exec', async (command) => {
    const quoted = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
    if (command.startsWith('mkdir')) {
      const destination = quoted.at(-1);
      assert.ok(!directories.has(destination), 'never create over an existing directory');
      directories.add(destination);
    } else {
      assert.match(command, /^mv -f -- /);
      assert.ok(files.has(quoted[0]));
      files.set(quoted[1], files.get(quoted[0]));
      files.delete(quoted[0]);
    }
    return { ok: true };
  });
  t.mock.method(WorkspaceSync.prototype, 'sync', async function () {
    const marker = JSON.parse(files.get(this.vmMount + '/.cibyp-host-import').toString());
    assert.equal(marker.identity, identity, 'source must be claimed before syncing');
    assert.equal(marker.status, 'pending');
    calls.push(this.vmMount);
    await new Promise((resolve) => setImmediate(resolve));
    return syncResult;
  });
  t.after(() => {
    for (const vm of services) clearInterval(vm._syncTimer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    identity,
    short,
    full,
    directories,
    files,
    calls,
    restart,
    fail: () => {
      syncResult = { ok: false, error: 'Transfer interrupted' };
    },
    resume: () => {
      syncResult = { ok: true };
    },
    disconnect: () => {
      readError = Object.assign(new Error('SFTP disconnected'), { code: 'ECONNRESET' });
    },
  };
}

test('unmarked and foreign VM imports are preserved and a verified alternative is reused after restart', async (t) => {
  const f = fixture(t);
  f.directories.add(f.short);
  f.directories.add(f.full);
  f.files.set(f.short + '/guest-only.txt', Buffer.from('keep edits'));
  f.files.set(
    f.full + '/.cibyp-host-import',
    Buffer.from(JSON.stringify({ identity: 'other-host' })),
  );
  const before = new Map(f.files);
  const vm = f.restart();
  const imported = await vm.mountExternalDir(f.host);
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.vmRoot, f.full + '-2');
  assert.deepEqual(imported.preserved, [f.short, f.full]);
  for (const [file, content] of before) assert.deepEqual(f.files.get(file), content);
  assert.equal(vm.toHostPath(imported.vmRoot + '/result.txt'), path.join(f.host, 'result.txt'));
  const restored = await f.restart().mountExternalDir(f.host);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.vmRoot, imported.vmRoot);
  assert.equal(restored.reused, true);
  for (const [file, content] of before) assert.deepEqual(f.files.get(file), content);
});

test('interrupted isolated imports retry their transfer after restart without allocating another copy', async (t) => {
  const f = fixture(t, 'isolated');
  f.fail();
  const vm = f.restart();
  assert.equal((await vm.mountExternalDir(f.host)).ok, false);
  assert.equal(
    vm._externMounts.size,
    0,
    'failed imports must not become reusable cached successes',
  );
  assert.equal(vm._pairSyncs.size, 0, 'failed imports must not continue in the background');
  assert.equal(JSON.parse(f.files.get(f.short + '/.cibyp-host-import')).status, 'pending');
  f.resume();
  const restored = f.restart();
  const result = await restored.mountExternalDir(f.host);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.vmRoot, f.short);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.files.get(f.short + '/.cibyp-host-import')).status, 'ready');
  await restored.mountExternalDir(f.host);
  await f.restart().mountExternalDir(f.host);
  assert.equal(f.calls.length, 2, 'completed isolated imports preserve guest edits on reuse');
});

test('a matching durable baseline recovers an old import with a missing marker', async (t) => {
  const f = fixture(t, 'isolated');
  f.directories.add(f.short);
  const vm = f.restart();
  const pair = createHash('sha256')
    .update(f.host + '\0' + f.short)
    .digest('hex');
  const state = path.join(vm.instance.dir, 'workspace-pairs', pair);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, 'sync-baseline.json'),
    JSON.stringify({ hostRoot: f.host, vmMount: f.short, files: {} }),
  );
  assert.equal((await vm.mountExternalDir(f.host)).vmRoot, f.short);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.files.get(f.short + '/.cibyp-host-import')).status, 'ready');
});

test('concurrent imports serialize their source checks and disconnected SFTP never creates alternatives', async (t) => {
  const f = fixture(t, 'isolated');
  const vm = f.restart();
  const results = await Promise.all([vm.mountExternalDir(f.host), vm.mountExternalDir(f.host)]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(f.calls.length, 1);
  assert.equal(f.directories.size, 1);
  assert.equal(vm._externMountTasks.size, 0);
  f.disconnect();
  await assert.rejects(f.restart().mountExternalDir(f.host), /SFTP disconnected/);
  assert.equal(f.directories.size, 1);
});
