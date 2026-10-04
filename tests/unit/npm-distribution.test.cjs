/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const {
  targets,
  archiveRuntime,
  preparePackage,
  prepareRuntimeManifest,
} = require('../../scripts/lib/npm-distribution.cjs');
const {
  ensureRuntime,
  selectTarget,
  inside,
  startRuntime,
} = require('../../packages/npm/lib/runtime.cjs');
const { registerDesktop, desktopQuote } = require('../../packages/npm/lib/desktop.cjs');
const version = require('../../package.json').version;

async function fixtures(root) {
  const dist = path.join(root, 'assets');
  await fs.mkdir(dist);
  for (const key of targets) {
    const [platform, arch] = key.split('-');
    const app = path.join(dist, key);
    const resources = platform === 'darwin' ? 'CIBYP.app/Contents/Resources' : 'resources';
    const executable = platform === 'darwin' ? '../MacOS/CIBYP' : '../../CIBYP';
    const write = async (file, content) => {
      const destination = path.join(app, resources, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    };
    await write('node/' + (platform === 'win32' ? 'node.exe' : 'node'), 'node fixture');
    await write('cli/launch.cjs', 'launcher fixture');
    await write('cli/runtime.json', JSON.stringify({ executable, platform, arch }));
    // Non-mac executable is at the unpacked root, one level above resources.
    if (platform !== 'darwin') await write('../CIBYP', 'app fixture');
    else await write(executable, 'app fixture');
    await write(
      'app.asar.unpacked/package.json',
      JSON.stringify({ version: version + '+fixture' }),
    );
    await write('app.asar.unpacked/keep.txt', 'bundled tools');
    if (platform !== 'darwin') {
      const marker = JSON.parse(
        await fs.readFile(path.join(app, resources, 'cli/runtime.json'), 'utf8'),
      );
      marker.executable = '../CIBYP';
      await write('cli/runtime.json', JSON.stringify(marker));
    }
    await archiveRuntime({ dist, platform, arch, version });
  }
  const output = path.join(root, 'packages');
  const manifest = await prepareRuntimeManifest({
    assets: dist,
    version,
    revision: 'a'.repeat(40),
  });
  await preparePackage({ output });
  return { output, manifest, dist };
}

test('GitHub runtimes serialize extraction, reuse the verified cache and reject damaged downloads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-npm-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { output, manifest, dist } = await fixtures(root);
  const platform = process.platform,
    arch = process.arch;
  const asset = selectTarget(manifest, platform, arch);
  assert.equal(asset.parts, undefined);
  const pkg = JSON.parse(await fs.readFile(path.join(output, 'cibyp/package.json'), 'utf8'));
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(await fs.readdir(output), ['cibyp']);
  assert.equal(pkg.bin['cibyp-code'], 'bin/cibyp-code.cjs');
  await assert.rejects(preparePackage({ assets: dist, output, version }), /must be empty/);
  for (const unsafe of ['../outside', '/absolute', 'C:/outside', 'C:\\outside', '..'])
    assert.throws(() => inside(root, unsafe));
  const env = { CIBYP_CACHE_DIR: path.join(root, 'cache') };
  let downloads = 0;
  const download = async (item, destination) => {
    downloads++;
    await fs.copyFile(path.join(dist, item.file), destination);
  };
  const options = { platform, arch, env, download, log: () => {} };
  const [first, second] = await Promise.all([
    ensureRuntime(manifest, options),
    ensureRuntime(manifest, options),
  ]);
  assert.equal(first.directory, second.directory);
  assert.equal(downloads, 1);
  assert.equal(
    await fs.readFile(
      inside(first.directory, asset.resources + '/app.asar.unpacked/keep.txt'),
      'utf8',
    ),
    'bundled tools',
  );
  assert.deepEqual(
    (await fs.readdir(env.CIBYP_CACHE_DIR)).filter((name) => /staging|archive|lock/.test(name)),
    [],
  );
  const files = await fs.readdir(env.CIBYP_CACHE_DIR);
  await ensureRuntime(manifest, {
    ...options,
    download: () => assert.fail('cache must be offline'),
  });
  assert.deepEqual(await fs.readdir(env.CIBYP_CACHE_DIR), files);
  const badPart = path.join(dist, asset.file);
  const bytes = await fs.readFile(badPart);
  bytes[0] ^= 1;
  await fs.writeFile(badPart, bytes);
  await assert.rejects(
    ensureRuntime(manifest, { ...options, env: { CIBYP_CACHE_DIR: path.join(root, 'bad-cache') } }),
    /SHA-256 verification failed/,
  );
  assert.deepEqual(await fs.readdir(path.join(root, 'bad-cache')), []);
});

test('GUI launcher updates preserve other files and point at the new cached runtime', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-npm-desktop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    XDG_DATA_HOME: path.join(root, 'desktop'),
    CIBYP_CACHE_DIR: path.join(root, 'cache'),
    APPDATA: path.join(root, 'roaming'),
  };
  const runtime = (name) => ({
    directory: path.join(env.CIBYP_CACHE_DIR, name),
    asset: {
      resources: 'resources',
      node: 'resources/node/node',
      entry: 'resources/cli/launch.cjs',
      executable: 'CIBYP',
    },
  });
  const old = runtime('old with spaces'),
    next = runtime('next');
  const run = async () => {};
  const shortcut = await registerDesktop(old, { platform: 'linux', env, home: root, run });
  await fs.writeFile(path.join(path.dirname(shortcut), 'unrelated.desktop'), 'keep');
  await registerDesktop(next, { platform: 'linux', env, home: root, run });
  assert.match(await fs.readFile(shortcut, 'utf8'), /cache[\\/]next/);
  assert.equal(
    await fs.readFile(path.join(path.dirname(shortcut), 'unrelated.desktop'), 'utf8'),
    'keep',
  );
  assert.equal(desktopQuote('a "$`%'), '"a \\"\\$\\`%%"');
  let values;
  await registerDesktop(next, {
    platform: 'win32',
    env,
    home: root,
    run: async (_file, args) => {
      values = JSON.parse(
        Buffer.from(args.at(-1).match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString(),
      );
    },
  });
  assert.equal(values.executable, inside(next.directory, next.asset.executable));
  assert.equal(path.basename(values.shortcut), 'CIBYP.lnk');
  const launchCommand = Buffer.from(values.arguments.split(' ').at(-1), 'base64').toString(
    'utf16le',
  );
  const launcherVersion = require('../../packages/npm/package.json').version;
  assert.ok(launchCommand.includes('launcher-' + launcherVersion));
  assert.match(launchCommand, /bin[\\/]cibyp\.cjs' --desktop$/);
  const mac = {
    ...next,
    asset: {
      ...next.asset,
      resources: 'CIBYP.app/Contents/Resources',
      executable: 'CIBYP.app/Contents/MacOS/CIBYP',
    },
  };
  const macOptions = {
    platform: 'darwin',
    env: { ...env, CIBYP_DESKTOP_DIR: path.join(root, 'Applications') },
    home: root,
    run,
  };
  const app = await registerDesktop(mac, macOptions);
  assert.match(
    await fs.readFile(path.join(app, 'Contents/MacOS/CIBYP'), 'utf8'),
    new RegExp('launcher-' + launcherVersion.replaceAll('.', '\\.')),
  );
  await registerDesktop(
    { ...mac, directory: path.join(env.CIBYP_CACHE_DIR, 'next revision') },
    macOptions,
  );
  assert.match(await fs.readFile(path.join(app, 'Contents/MacOS/CIBYP'), 'utf8'), /next revision/);
});

test(
  'a real global npm install contains only JavaScript and exposes all three commands',
  { timeout: 120000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-npm-install-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const output = path.join(root, 'packages');
    const pkg = await preparePackage({ output });
    const cwd = path.join(output, 'cibyp');
    const npmCLI =
      process.env.npm_execpath ||
      path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const npm = (args, options = {}) =>
      run(process.execPath, [npmCLI, ...args], {
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        ...options,
      });
    const packed = JSON.parse(
      (await npm(['pack', '--json', '--ignore-scripts'], { cwd })).stdout,
    )[0];
    require('../../scripts/publish-npm.cjs').verifyLauncher(pkg, packed);
    assert.ok(packed.size < 64 * 1024);
    const prefix = path.join(root, 'prefix');
    const env = {
      ...process.env,
      CIBYP_SKIP_INSTALL: '1',
      CIBYP_CACHE_DIR: path.join(root, 'cache'),
      npm_config_cache: path.join(root, 'npm-cache'),
    };
    await npm(
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--offline',
        '--no-audit',
        '--no-fund',
        path.join(cwd, packed.filename),
      ],
      { env },
    );
    const modules = path.join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    );
    assert.deepEqual(await fs.readdir(modules), ['cibyp']);
    for (const command of ['cibyp', 'cibyp-tui', 'cibyp-code']) {
      const result = await run(
        process.execPath,
        [path.join(modules, 'cibyp/bin', command + '.cjs'), '--version'],
        { env },
      );
      assert.equal(result.stdout.trim(), pkg.version);
    }
    await assert.rejects(fs.stat(path.join(modules, 'cibyp/runtime.json')), { code: 'ENOENT' });
  },
);

test('packaged commands receive literal arguments, exit codes and the existing working directory', async () => {
  const { EventEmitter } = require('node:events');
  let call;
  const code = await startRuntime(
    'code',
    ['--workspace=a $ folder'],
    { directory: path.resolve('runtime'), asset: { node: 'node', entry: 'launch.cjs' } },
    {
      spawnProcess(file, args, options) {
        call = { file, args, options };
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 7, null));
        return child;
      },
    },
  );
  assert.equal(code, 7);
  assert.deepEqual(call.args.slice(1), ['code', '--workspace=a $ folder']);
  assert.equal(call.options.cwd, undefined);
});
