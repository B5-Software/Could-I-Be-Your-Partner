const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const {
  materializeCodeOSSDependencies,
  verifyCodeOSSDependencies,
} = require('../../scripts/lib/codeoss-runtime.cjs');

test('standalone Code-OSS ESM resolves archived packages without development dependencies', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-codeoss-deps-'));
  try {
    const input = path.join(directory, 'source');
    await fs.mkdir(path.join(input, 'semver'), { recursive: true });
    await fs.mkdir(path.join(input, '@vscode/native'), { recursive: true });
    await fs.writeFile(
      path.join(input, 'semver/package.json'),
      JSON.stringify({ name: 'semver', main: 'index.js' }),
    );
    await fs.writeFile(
      path.join(input, 'semver/index.js'),
      'module.exports = { valid: () => "1.2.3" };',
    );
    await fs.writeFile(path.join(input, '@vscode/native/binding.node'), 'unpacked native fixture');
    await asar.createPackageWithOptions(input, path.join(directory, 'node_modules.asar'), {
      unpack: '**/*.node',
    });
    const entry = path.join(directory, 'main.mjs');
    await fs.writeFile(entry, 'import semver from "semver"; console.log(semver.valid("1.2.3"));');
    const execute = () =>
      spawnSync(process.execPath, [entry], { cwd: directory, encoding: 'utf8' });
    const missing = execute();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Cannot find package 'semver'/);

    assert.equal(materializeCodeOSSDependencies(directory), 3);
    const ready = execute();
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stdout.trim(), '1.2.3');
    assert.equal(
      await fs.readFile(path.join(directory, 'node_modules/@vscode/native/binding.node'), 'utf8'),
      'unpacked native fixture',
    );

    await fs.writeFile(path.join(directory, 'node_modules/semver/index.js'), 'incomplete');
    assert.throws(() => verifyCodeOSSDependencies(directory), /dependency missing or incomplete/);
    materializeCodeOSSDependencies(directory);
    await fs.unlink(path.join(directory, 'node_modules/@vscode/native/binding.node'));
    assert.throws(() => verifyCodeOSSDependencies(directory), /dependency missing or incomplete/);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
