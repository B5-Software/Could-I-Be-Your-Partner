/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceLifecycle } = require('../../src/main/services/workspace-lifecycle');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaces = path.join(root, 'workspaces');
  fs.mkdirSync(workspaces);
  const service = new WorkspaceLifecycle({
    root: workspaces,
    file: path.join(root, 'registry.json'),
  });
  const create = (name) => {
    const directory = path.join(workspaces, name);
    fs.mkdirSync(directory);
    service.register(directory);
    return directory;
  };
  return { root, workspaces, service, create };
}
test('workspace physical renames keep stable paths readable across repeated names and restarts', async (t) => {
  const { service, create, root, workspaces } = fixture(t),
    stable = create('deadbeef01234567');
  fs.writeFileSync(path.join(stable, 'report.txt'), 'artifact');
  assert.equal((await service.inspect(stable)).needsNaming, true);
  const first = await service.rename(stable, '月度分析');
  assert.equal(first.method, 'rename-with-stable-alias');
  assert.notEqual(first.displayPath, stable);
  assert.equal(fs.readFileSync(path.join(stable, 'report.txt'), 'utf8'), 'artifact');
  assert.ok(fs.lstatSync(stable).isSymbolicLink());
  const second = await service.rename(stable, '预算规划');
  assert.ok(!fs.existsSync(first.displayPath));
  fs.writeFileSync(path.join(stable, 'next.txt'), 'second');
  assert.equal(fs.readFileSync(path.join(second.displayPath, 'next.txt'), 'utf8'), 'second');
  const restart = new WorkspaceLifecycle({
    root: workspaces,
    file: path.join(root, 'registry.json'),
  });
  assert.equal((await restart.inspect(stable)).name, '预算规划');
  assert.equal((await restart.cleanup({ shutdown: true })).removed.length, 0);
  assert.equal((await service.rename(root, 'outside')).ok, false);
  await assert.rejects(service.rename(stable, 'CON'), /descriptive/);
});
test('cleanup removes only owned empty directories, protecting active work, chats, hidden files and external paths', async (t) => {
  const { service, create, root } = fixture(t);
  const empty = create('empty'),
    active = create('active'),
    chat = create('chat'),
    files = create('files'),
    hidden = create('hidden');
  service.activePaths = () => [active];
  service.retain(chat, true);
  fs.writeFileSync(path.join(files, 'report.md'), 'data');
  fs.writeFileSync(path.join(hidden, '.gitkeep'), '');
  service.register(root); // An invalid ownership record cannot authorize deleting its parent.
  assert.deepEqual((await service.cleanup()).removed, [empty]);
  assert.ok(fs.existsSync(active));
  assert.ok(fs.existsSync(chat));
  assert.ok(fs.existsSync(files));
  assert.ok(fs.existsSync(hidden));
  service.busyPaths = () => [active];
  assert.equal((await service.cleanup({ shutdown: true })).removed.length, 0);
  service.busyPaths = () => [];
  service.retain(chat, false);
  assert.deepEqual(
    new Set((await service.cleanup({ shutdown: true })).removed),
    new Set([active, chat]),
  );
});
test('rename persistence failure rolls storage and aliases back without losing artifacts', async (t) => {
  const { service, create } = fixture(t),
    stable = create('rollback');
  fs.writeFileSync(path.join(stable, 'keep.txt'), 'keep');
  service.save = () => {
    throw new Error('disk full');
  };
  await assert.rejects(service.rename(stable, 'report'), /disk full/);
  assert.equal(fs.readFileSync(path.join(stable, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(!fs.lstatSync(stable).isSymbolicLink());
  assert.equal(service.locks.size, 0);
});

test('cleanup never traverses a replaced workspace junction to mutate external history', async (t) => {
  const { service, create, root } = fixture(t);
  const stable = create('replaced');
  const outside = path.join(root, 'user-project');
  const history = path.join(outside, '.cibyp-code-history');
  fs.mkdirSync(history, { recursive: true });
  const indexFile = path.join(history, 'index.json');
  const original = JSON.stringify({ version: 2, entries: {} });
  fs.writeFileSync(indexFile, original);
  fs.rmdirSync(stable);
  fs.symlinkSync(outside, stable, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual((await service.cleanup({ shutdown: true })).removed, []);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), original);
  assert.ok(fs.lstatSync(stable).isSymbolicLink());
});
test('legacy cleanup requires readable history and never touches a referenced or user-named workspace', async (t) => {
  const { service, root, workspaces } = fixture(t),
    history = path.join(root, 'history');
  fs.mkdirSync(history);
  const empty = path.join(workspaces, 'abcdef0123456789'),
    used = path.join(workspaces, '1234567890abcdef'),
    user = path.join(workspaces, 'my-project');
  for (const directory of [empty, used, user]) fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(history, 'chat.json'),
    JSON.stringify({ workspacePath: used, messages: [{ role: 'user', content: 'hello' }] }),
  );
  await service.adoptLegacy([history]);
  assert.deepEqual((await service.cleanup()).removed, [empty]);
  assert.ok(fs.existsSync(used));
  assert.ok(fs.existsSync(user));
});

test('startup recovers a crash between directory rename and stable alias creation', async (t) => {
  const { service, create, root, workspaces } = fixture(t),
    stable = create('recover');
  fs.writeFileSync(path.join(stable, 'keep.txt'), 'safe');
  const destination = path.join(workspaces, 'Recovered-123456');
  service.record(stable).pendingRename = { from: stable, to: destination, name: 'Recovered' };
  service.save();
  fs.renameSync(stable, destination);
  const restarted = new WorkspaceLifecycle({
    root: workspaces,
    file: path.join(root, 'registry.json'),
  });
  await restarted.recover();
  assert.equal(fs.readFileSync(path.join(stable, 'keep.txt'), 'utf8'), 'safe');
  assert.equal((await restarted.inspect(stable)).name, 'Recovered');
  assert.ok(!restarted.record(stable).pendingRename);
});

test('VM imported automatic workspaces rename host storage without changing the guest tool path or external mapping', async (t) => {
  const { service, create } = fixture(t),
    host = create('host-import');
  delete service.records[host];
  const guest = '/workspace/_external/host-import';
  let guestFiles = [{ filename: 'artifact.md' }];
  service.vm = {
    instance: {
      state: 'ready',
      sftp: async () => ({
        readdir: async (directory) => {
          assert.equal(directory, guest);
          return guestFiles;
        },
      }),
    },
  };
  service.register(guest, 'vm', host);
  assert.equal((await service.inspect(guest)).needsNaming, true);
  const named = await service.rename(guest, '研究笔记');
  assert.equal(named.path, guest);
  assert.ok(fs.lstatSync(host).isSymbolicLink());
  fs.writeFileSync(path.join(host, 'artifact.md'), 'VM pull writes through stable host mapping');
  assert.equal(
    fs.readFileSync(path.join(named.displayPath, 'artifact.md'), 'utf8'),
    'VM pull writes through stable host mapping',
  );
  assert.equal((await service.cleanup({ shutdown: true })).removed.length, 0);
  guestFiles = [];
});

test('empty Code history indexes do not keep a never-used automatic workspace alive', async (t) => {
  const { service, create } = fixture(t),
    workspace = create('empty-code'),
    history = path.join(workspace, '.cibyp-code-history');
  fs.mkdirSync(history);
  fs.writeFileSync(path.join(history, 'index.json'), JSON.stringify({ version: 2, entries: {} }));
  assert.deepEqual((await service.cleanup({ shutdown: true })).removed, [workspace]);
  assert.ok(!fs.existsSync(workspace));
});

test('direct guest storage uses the two-argument SFTP symlink contract and preserves guest path aliases', async (t) => {
  const { service, root } = fixture(t),
    guestRoot = path.join(root, 'guest');
  fs.mkdirSync(guestRoot);
  const guest = '/workspace/direct';
  const actual = path.join(guestRoot, 'direct');
  fs.mkdirSync(actual);
  fs.writeFileSync(path.join(actual, 'report.md'), 'guest artifact');
  const physical = (remote) => path.join(guestRoot, path.posix.relative('/workspace', remote));
  const sftp = {
    readdir: (remote) => fs.promises.readdir(physical(remote)),
    lstat: (remote) => fs.promises.lstat(physical(remote)),
    rename: (from, to) => fs.promises.rename(physical(from), physical(to)),
    rmdir: (remote) => fs.promises.rmdir(physical(remote)),
    unlink: (remote) =>
      process.platform === 'win32'
        ? fs.promises.rmdir(physical(remote))
        : fs.promises.unlink(physical(remote)),
    symlink: async (...args) => {
      assert.equal(args.length, 2);
      return fs.promises.symlink(
        physical(args[0]),
        physical(args[1]),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    },
  };
  service.vm = {
    runtime: { vm: { workspaceMount: '/workspace' } },
    instance: { state: 'ready', sftp: async () => sftp },
  };
  service.register(guest, 'vm');
  const named = await service.rename(guest, '报告');
  assert.equal(named.method, 'rename-with-stable-alias');
  assert.equal(fs.readFileSync(path.join(actual, 'report.md'), 'utf8'), 'guest artifact');
  assert.equal((await service.inspect(guest)).name, '报告');
  const again = await service.rename(guest, '最终报告');
  assert.equal(again.path, guest);
  assert.equal(fs.readFileSync(path.join(actual, 'report.md'), 'utf8'), 'guest artifact');
});
