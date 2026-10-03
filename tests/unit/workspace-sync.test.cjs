const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { WorkspaceSync } = require('../../src/main/vm/vm-workspace');
const { parseTar, writeTar } = require('../../src/main/vm/vm-tar');
const { scanDirectory } = require('../../src/main/vm/workspace-manifest');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-sync-test-'));
  const host = path.join(root, 'host');
  const guest = path.join(root, 'guest');
  fs.mkdirSync(host);
  fs.mkdirSync(guest);
  const sync = new WorkspaceSync({
    hostRoot: host,
    vmMount: guest.replace(/\\/g, '/'),
    instanceDir: path.join(root, 'state'),
    vmService: {
      instance: {
        state: 'ready',
        exec: async (command) => {
          assert.ok(command.startsWith('node -e '));
          const script = command.slice(8).slice(1, -1).replace(/'\\''/g, "'");
          const remoteScript = script.replace(
            /\/tmp\/cibyp-sync-[a-f0-9]+\.json/g,
            path.join(root, 'guest-cache.json').replace(/\\/g, '/'),
          );
          const { stdout } = await execFile(process.execPath, ['-e', remoteScript]);
          return { ok: true, stdout };
        },
      },
    },
  });
  sync._execWithStdin = async (_inst, _cmd, data) => {
    for (const entry of parseTar(data).entries) {
      const file = path.join(guest, entry.name);
      if (entry.type === '5') {
        fs.mkdirSync(file, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry.data);
      fs.utimesSync(file, entry.mtime, entry.mtime);
    }
  };
  sync._execWithStdout = async (_inst, command) => {
    const rels = command
      .slice(command.indexOf('-- ') + 3)
      .match(/'[^']*'/g)
      .map((value) => value.slice(1, -1));
    return writeTar(
      rels.map((rel) => ({
        name: rel,
        data: fs.readFileSync(path.join(guest, rel)),
        mtime: Math.floor(fs.statSync(path.join(guest, rel)).mtimeMs / 1000),
      })),
    );
  };
  sync.deleteInVm = async (rels) => {
    for (const rel of rels) fs.rmSync(path.join(guest, rel), { force: true });
    return rels.length;
  };
  const write = (side, rel, text) => {
    const file = path.join(side, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, host, guest, sync, write };
}

test('content consensus survives clock drift, rapid same-size edits, directional syncs, and restart', async (t) => {
  const { root, host, guest, sync, write } = fixture(t);
  write(host, 'package.json', 'AAAA');
  assert.equal((await sync.sync()).ok, true);
  fs.utimesSync(path.join(guest, 'package.json'), 1, 1);
  const drifted = await sync.sync();
  assert.equal(drifted.ok, true);
  assert.deepEqual(drifted.conflicts, []);
  assert.equal(drifted.pushed + drifted.pulled, 0);
  write(guest, 'package.json', 'BBBB');
  assert.equal((await sync.sync({ direction: 'push' })).pulled, 0);
  assert.ok(sync.baseline.files['package.json'], 'unpulled edits retain their previous consensus');
  assert.equal((await sync.sync({ direction: 'pull' })).conflicts.length, 0);
  assert.equal(fs.readFileSync(path.join(host, 'package.json'), 'utf8'), 'BBBB');
  write(guest, 'package.json', 'CCCC');
  assert.equal((await sync.sync({ direction: 'pull' })).conflicts.length, 0);
  assert.equal(fs.readFileSync(path.join(host, 'package.json'), 'utf8'), 'CCCC');
  const restarted = new WorkspaceSync({
    hostRoot: host,
    vmMount: guest.replace(/\\/g, '/'),
    instanceDir: path.join(root, 'state'),
  });
  assert.equal(restarted.baseline.version, 2);
  assert.equal(
    restarted.baseline.files['package.json'].host.hash,
    restarted.baseline.files['package.json'].vm.hash,
  );
});

test('real divergent edits preserve the losing bytes; directional deletion never acts on the opposite side', async (t) => {
  const { host, guest, sync, write } = fixture(t);
  write(host, 'source.js', 'baseline');
  write(host, 'deleted.js', 'delete me');
  await sync.sync();
  write(host, 'source.js', 'host edit');
  const vmFile = write(guest, 'source.js', 'guest edit');
  const time = Date.now() / 1000 + 10;
  fs.utimesSync(vmFile, time, time);
  fs.rmSync(path.join(host, 'deleted.js'));
  const pulled = await sync.sync({ direction: 'pull' });
  assert.equal(pulled.ok, true);
  assert.equal(pulled.conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(host, 'source.js'), 'utf8'), 'guest edit');
  const backup = fs.readdirSync(path.join(host, '.cibyp-conflicts'))[0];
  assert.equal(fs.readFileSync(path.join(host, '.cibyp-conflicts', backup), 'utf8'), 'host edit');
  assert.equal(fs.existsSync(path.join(guest, 'deleted.js')), true, 'pull cannot delete VM files');
  await sync.sync({ direction: 'push' });
  assert.equal(fs.existsSync(path.join(guest, 'deleted.js')), false);
  assert.deepEqual((await sync.sync()).conflicts, []);
});

test('host scanning yields to the event loop, prunes dependency trees, and recognizes equal bytes across timestamps', async (t) => {
  const { host, sync, write } = fixture(t);
  for (let i = 0; i < 200; i++) write(host, `src/${i}.txt`, 'text');
  write(host, 'node_modules/should-not-open/file', 'dependency');
  write(host, '.cibyp-ready', 'heartbeat');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const scanned = await sync.scanHost();
  clearInterval(timer);
  assert.equal(Object.keys(scanned).length, 200);
  assert.ok(ticks > 0, 'scan does not block the main event loop');
  const changedTime = { ...scanned['src/0.txt'], mtimeMs: 1 };
  assert.equal(WorkspaceSync.sameEntry(scanned['src/0.txt'], changedTime), true);
  const cached = await scanDirectory(host, sync._scanOptions(), scanned);
  assert.equal(cached['src/0.txt'].hash, scanned['src/0.txt'].hash);
});

test('a guest scan failure cannot masquerade as deleting the entire workspace', async (t) => {
  const { host, sync, write } = fixture(t);
  write(host, 'keep.txt', 'safe');
  await sync.sync();
  sync.vmService.instance.exec = async () => ({ ok: false, stderr: 'SSH failure' });
  const result = await sync.sync();
  assert.equal(result.ok, false);
  assert.ok(sync.baseline.files['keep.txt']);
  assert.equal(fs.readFileSync(path.join(host, 'keep.txt'), 'utf8'), 'safe');
});

test('host edits arriving while a guest tar is being read are retained for a later sync', async (t) => {
  const { host, guest, sync, write } = fixture(t);
  write(host, 'source.js', 'baseline');
  await sync.sync();
  write(guest, 'source.js', 'guest change');
  const original = sync._execWithStdout;
  sync._execWithStdout = async (...args) => {
    const tar = await original(...args);
    write(host, 'source.js', 'new host change');
    return tar;
  };
  assert.equal((await sync.sync({ direction: 'pull' })).ok, false);
  assert.equal(fs.readFileSync(path.join(host, 'source.js'), 'utf8'), 'new host change');
  assert.equal(fs.readFileSync(path.join(guest, 'source.js'), 'utf8'), 'guest change');
});

test('oversized files and linked directories are excluded without propagating false deletions', async (t) => {
  const { host, guest, sync, write, root } = fixture(t);
  write(host, 'large.txt', 'baseline');
  write(host, 'folder/child.txt', 'safe');
  await sync.sync();
  sync.maxFileMB = 0.001;
  write(host, 'large.txt', 'x'.repeat(5000));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  write(outside, 'child.txt', 'private');
  fs.rmSync(path.join(host, 'folder'), { recursive: true });
  fs.symlinkSync(
    outside,
    path.join(host, 'folder'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = await sync.sync();
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 0);
  assert.equal(fs.readFileSync(path.join(guest, 'large.txt'), 'utf8'), 'baseline');
  assert.equal(fs.readFileSync(path.join(guest, 'folder/child.txt'), 'utf8'), 'safe');
  assert.equal(fs.readFileSync(path.join(outside, 'child.txt'), 'utf8'), 'private');
  assert.ok(result.skipped.some((item) => item.reason === 'size-limit'));
  assert.ok(result.skipped.some((item) => item.reason === 'symbolic-link'));
});

test('baselines are bound to both roots and unsafe guest manifests cannot escape the host workspace', async (t) => {
  const { host, sync, write, root } = fixture(t);
  write(host, 'keep.txt', 'safe');
  await sync.sync();
  const different = path.join(root, 'different');
  fs.mkdirSync(different);
  const reopened = new WorkspaceSync({
    hostRoot: different,
    vmMount: sync.vmMount,
    instanceDir: path.join(root, 'state'),
  });
  assert.deepEqual(Object.keys(reopened.baseline.files), []);
  sync.scanVm = async () => ({ '../outside': { size: 6, mtimeMs: 1, hash: 'forged' } });
  const result = await sync.sync();
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsafe sync path/);
  assert.equal(fs.readFileSync(path.join(host, 'keep.txt'), 'utf8'), 'safe');
  assert.ok(!fs.existsSync(path.join(root, 'outside')));
});
