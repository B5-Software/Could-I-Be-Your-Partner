const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VmFileManager } = require('../../src/main/services/vm-file-manager');
const { openDirectory } = require('../../src/main/services/open-directory');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-transfer-'));
  const host = path.join(root, 'host'),
    guest = path.join(root, 'guest');
  fs.mkdirSync(host);
  fs.mkdirSync(guest);
  const local = (file) => path.join(guest, path.posix.relative('/vm', file));
  const io = Object.fromEntries(
    ['stat', 'lstat', 'mkdir', 'unlink'].map((name) => [
      name,
      (file) => fs.promises[name](local(file)),
    ]),
  );
  io.readdir = async (file) =>
    Promise.all(
      (await fs.promises.readdir(local(file))).map(async (filename) => ({
        filename,
        attrs: await fs.promises.lstat(path.join(local(file), filename)),
      })),
    );
  io.createReadStream = (file) => fs.createReadStream(local(file), { highWaterMark: 1024 });
  io.createWriteStream = (file, options) => fs.createWriteStream(local(file), options);
  const service = {
    runtime: { vm: { workspaceMount: '/vm' } },
    instance: {
      state: 'ready',
      sftp: async () => io,
      exec: async (command) => {
        const script = command.slice(8).slice(1, -1).replace(/'\\''/g, "'");
        const args = JSON.parse('[' + script.slice(script.indexOf('renameSync(') + 11, -1) + ']');
        await fs.promises.rename(local(args[0]), local(args[1]));
        return { ok: true };
      },
    },
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { host, guest, manager: new VmFileManager(service), service };
}

test('host/VM transfers preserve binary files and empty folders, skip collisions and support explicit overwrite', async (t) => {
  const { host, guest, manager } = fixture(t);
  const folder = path.join(host, '中文 folder');
  fs.mkdirSync(path.join(folder, 'empty'), { recursive: true });
  const data = Buffer.from(Array.from({ length: 40000 }, (_, i) => i % 256));
  fs.writeFileSync(path.join(folder, 'binary.dat'), data);
  let result = await manager.transfer({ from: 'host', paths: [folder], destination: '/vm' });
  assert.equal(result.files, 1);
  assert.equal(result.bytes, data.length);
  assert.ok(fs.statSync(path.join(guest, '中文 folder/empty')).isDirectory());
  assert.deepEqual(fs.readFileSync(path.join(guest, '中文 folder/binary.dat')), data);
  fs.writeFileSync(path.join(folder, 'binary.dat'), 'host edited');
  result = await manager.transfer({ from: 'vm', paths: ['/vm/中文 folder'], destination: host });
  assert.equal(result.skipped.length, 1);
  assert.equal(fs.readFileSync(path.join(folder, 'binary.dat'), 'utf8'), 'host edited');
  await manager.transfer({
    from: 'vm',
    paths: ['/vm/中文 folder'],
    destination: host,
    overwrite: true,
  });
  assert.deepEqual(fs.readFileSync(path.join(folder, 'binary.dat')), data);
  assert.equal((await manager.list('vm', '/vm')).entries[0].name, '中文 folder');
});

test('cancel and concurrent edits retain the destination and remove incomplete temporary files', async (t) => {
  const { host, guest, manager, service } = fixture(t);
  fs.writeFileSync(path.join(guest, 'large'), Buffer.alloc(1024 * 1024));
  fs.writeFileSync(path.join(host, 'large'), 'previous');
  await assert.rejects(
    manager.transfer({ from: 'vm', paths: ['/vm/large'], destination: host, overwrite: true }, () =>
      manager.cancel(),
    ),
    { name: 'AbortError' },
  );
  assert.equal(fs.readFileSync(path.join(host, 'large'), 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(host), ['large']);
  assert.equal(service._manualTransfers, 0);
  await assert.rejects(
    manager.transfer({ from: 'vm', paths: ['/vm/large'], destination: host, overwrite: true }, () =>
      fs.writeFileSync(path.join(host, 'large'), 'edited during transfer'),
    ),
    /Destination changed/,
  );
  assert.equal(fs.readFileSync(path.join(host, 'large'), 'utf8'), 'edited during transfer');
  assert.deepEqual(fs.readdirSync(host), ['large']);
});

test('/cwd refuses without a desktop and opens an existing folder with literal process arguments', async (t) => {
  const { host } = fixture(t);
  let called;
  assert.equal(
    (
      await openDirectory(host, {
        desktop: () => false,
        run: () => {
          throw Error('must not launch');
        },
      })
    ).code,
    'NO_DESKTOP',
  );
  const result = await openDirectory(host, {
    desktop: () => true,
    platform: 'linux',
    run: async (...args) => {
      called = args;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(called.slice(0, 2), ['xdg-open', [host]]);
});
