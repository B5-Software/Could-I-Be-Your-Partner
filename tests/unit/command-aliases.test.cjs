const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { manageAliases, aliasName, aliasFiles } = require('../../packages/npm/lib/aliases.cjs');

async function fixture(t, platform = process.platform) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp aliases '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, 'entry.cjs');
  await fs.writeFile(
    entry,
    'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}))',
  );
  const target = {
    node: process.execPath,
    entries: { gui: entry, code: entry, tui: entry, webui: entry },
    arguments: { gui: ['gui'], code: ['code'], tui: ['tui'], webui: ['webui'] },
  };
  return {
    directory,
    target,
    options: { env: { CIBYP_ALIAS_DIR: directory }, platform, persistPath: false },
  };
}
test('an alias family forwards modes, spaces and cwd, then removes all owned commands', async (t) => {
  const f = await fixture(t);
  const added = await manageAliases(['add', 'kamisato'], f.target, f.options);
  assert.deepEqual(added.commands, ['kamisato', 'kamisato-code', 'kamisato-tui', 'kamisato-webui']);
  for (const [suffix, mode] of [
    ['', 'gui'],
    ['-code', 'code'],
    ['-tui', 'tui'],
    ['-webui', 'webui'],
  ]) {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(f.directory, 'kamisato' + suffix + '.cjs'),
          '--workspace=path with spaces',
          'a&b',
        ],
        { cwd: f.directory, encoding: 'utf8' },
      ),
    );
    assert.deepEqual(result.args, [mode, '--workspace=path with spaces', 'a&b']);
    assert.equal(result.cwd, f.directory);
  }
  assert.deepEqual((await manageAliases(['list'], f.target, f.options)).names, ['kamisato']);
  await manageAliases(['remove', 'kamisato'], f.target, f.options);
  assert.deepEqual((await manageAliases(['list'], f.target, f.options)).names, []);
  assert.equal(
    (await fs.readdir(f.directory)).some((name) => name.startsWith('kamisato')),
    false,
  );
});
test('collisions and edited commands preserve user files without partial installation/removal', async (t) => {
  const f = await fixture(t, 'win32');
  await fs.writeFile(path.join(f.directory, 'kamisato-code.cmd'), 'unrelated');
  await assert.rejects(manageAliases(['add', 'kamisato'], f.target, f.options), /overwrite/);
  assert.equal((await fs.readdir(f.directory)).includes('kamisato.cmd'), false);
  await fs.unlink(path.join(f.directory, 'kamisato-code.cmd'));
  await manageAliases(['add', 'kamisato'], f.target, f.options);
  await fs.appendFile(path.join(f.directory, 'kamisato.cmd'), 'edit');
  await assert.rejects(manageAliases(['delete', 'kamisato'], f.target, f.options), /was changed/);
  assert.ok(await fs.stat(path.join(f.directory, 'kamisato-tui.cmd')));
});
test('names reject traversal, reserved commands and shell syntax; Unix commands quote paths', () => {
  for (const name of ['../bad', 'cibyp', 'a-code', 'CON', 'x;echo', '', 'a\nb'])
    assert.throws(() => aliasName(name));
  const files = aliasFiles(
    'kamisato',
    {
      node: '/path with space/node',
      directory: '/home/name/bin',
      entries: { gui: '/x', code: '/y', tui: '/z' },
    },
    'linux',
  );
  assert.match(files.kamisato, /exec '\/path with space\/node'/);
  assert.match(files.kamisato, /"\$@"/);
});

test('a stale process lock is recovered, while a live lock is retained', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.directory, '.cibyp-aliases.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: 99999999 }));
  await manageAliases(['add', 'kamisato'], f.target, f.options);
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(
    manageAliases(['remove', 'kamisato'], f.target, f.options),
    /operation is running/,
  );
});
