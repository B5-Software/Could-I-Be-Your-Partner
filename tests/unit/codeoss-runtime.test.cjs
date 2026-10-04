const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { getFileMatchers, copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher');
const {
  materializeCodeOSSDependencies,
  verifyCodeOSSDependencies,
} = require('../../scripts/lib/codeoss-runtime.cjs');

test('electron-builder copies complete physical Code-OSS dependencies on all six targets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-codeoss-copy-'));
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
    await fs.writeFile(path.join(input, 'semver/LICENSE.txt'), 'license fixture');
    await fs.writeFile(path.join(input, '@vscode/native/binding.node'), 'native fixture');
    const archive = path.join(directory, 'node_modules.asar');
    await asar.createPackageWithOptions(input, archive, { unpack: '**/*.node' });
    const mapping = require('../../package.json').build.extraResources.find((entry) =>
      entry.from.startsWith('assets/codeoss/'),
    );
    for (const [osName, arch] of [
      ['win', 'x64'],
      ['win', 'arm64'],
      ['mac', 'x64'],
      ['mac', 'arm64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
    ]) {
      const source = path.join(directory, 'assets/codeoss', `${osName}-${arch}`, 'app');
      const resources = path.join(directory, 'dist', `${osName}-${arch}`, 'resources');
      await fs.mkdir(source, { recursive: true });
      await fs.copyFile(archive, path.join(source, 'node_modules.asar'));
      await fs.cp(archive + '.unpacked', path.join(source, 'node_modules.asar.unpacked'), {
        recursive: true,
      });
      materializeCodeOSSDependencies(source);
      await fs.writeFile(
        path.join(source, 'main.mjs'),
        'import semver from "semver"; console.log(semver.valid("1.2.3"));',
      );
      if (osName === 'win' && arch === 'x64') {
        const oldDestination = path.join(directory, 'broken');
        await copyFiles(
          [new FileMatcher(source, oldDestination, (value) => value, ['**/*'])],
          undefined,
          false,
        );
        await assert.rejects(fs.stat(path.join(oldDestination, 'node_modules/semver/index.js')), {
          code: 'ENOENT',
        });
        assert.throws(
          () => verifyCodeOSSDependencies(oldDestination),
          /dependency missing or incomplete/,
        );
      }
      const macroExpander = (value) =>
        value.replaceAll('${os}', osName).replaceAll('${arch}', arch);
      const matchers = getFileMatchers({ extraResources: [mapping] }, 'extraResources', resources, {
        defaultSrc: directory,
        globalOutDir: path.join(directory, 'dist'),
        customBuildOptions: {},
        macroExpander,
      });
      await copyFiles(matchers, undefined, false);
      const packaged = path.join(resources, 'codeoss/app');
      assert.equal(verifyCodeOSSDependencies(packaged), 4, `${osName}-${arch}`);
      assert.equal(
        await fs.readFile(path.join(packaged, 'node_modules/semver/LICENSE.txt'), 'utf8'),
        'license fixture',
      );
      const result = spawnSync(process.execPath, [path.join(packaged, 'main.mjs')], {
        cwd: packaged,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '1.2.3');
    }
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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
