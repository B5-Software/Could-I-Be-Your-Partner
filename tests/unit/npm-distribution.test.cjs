/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const {
  targets,
  archiveRuntime,
  preparePackage,
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
  const manifest = await preparePackage({ assets: dist, output, version, chunkSize: 350 });
  return { output, manifest, dist };
}

test('complete platform payloads install offline, serialize concurrent extraction and reject damaged parts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-npm-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { output, manifest, dist } = await fixtures(root);
  const platform = process.platform,
    arch = process.arch;
  const asset = selectTarget(manifest, platform, arch);
  assert.ok(asset.parts.length > 1);
  const pkg = JSON.parse(await fs.readFile(path.join(output, 'cibyp/package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.optionalDependencies).length, 6);
  assert.equal(pkg.bin['cibyp-code'], 'bin/cibyp-code.cjs');
  await assert.rejects(preparePackage({ assets: dist, output, version }), /must be empty/);
  for (const unsafe of ['../outside', '/absolute', 'C:/outside', 'C:\\outside', '..'])
    assert.throws(() => inside(root, unsafe));
  const env = { CIBYP_CACHE_DIR: path.join(root, 'cache') };
  const resolvePayload = (part) => path.join(output, part.package, 'payload.bin');
  const options = { platform, arch, env, resolvePayload, log: () => {} };
  const [first, second] = await Promise.all([
    ensureRuntime(manifest, options),
    ensureRuntime(manifest, options),
  ]);
  assert.equal(first.directory, second.directory);
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
    resolvePayload: () => assert.fail('cache must be offline'),
  });
  assert.deepEqual(await fs.readdir(env.CIBYP_CACHE_DIR), files);
  const badPart = resolvePayload(asset.parts[0]);
  const bytes = await fs.readFile(badPart);
  bytes[0] ^= 1;
  await fs.writeFile(badPart, bytes);
  await assert.rejects(
    ensureRuntime(manifest, { ...options, env: { CIBYP_CACHE_DIR: path.join(root, 'bad-cache') } }),
    /checksum failed/,
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
});

test(
  'a real npm install selects only the native platform, runs postinstall and exposes all three commands',
  { timeout: 120000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-npm-install-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { output } = await fixtures(root);
    const npmCLI =
      process.env.npm_execpath ||
      path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const npm = (args, options = {}) =>
      run(process.execPath, [npmCLI, ...args], {
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        ...options,
      });
    const packages = new Map();
    for (const name of await fs.readdir(output)) {
      const cwd = path.join(output, name);
      const packed = JSON.parse(
        (await npm(['pack', '--json', '--ignore-scripts'], { cwd })).stdout,
      )[0];
      const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
      packages.set(name, {
        pkg,
        packed,
        bytes: await fs.readFile(path.join(cwd, packed.filename)),
      });
    }
    const downloaded = [];
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split('/')[1]);
      const value = packages.get(name);
      if (!value) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      if (req.url.includes('/-/')) {
        downloaded.push(name);
        res.end(value.bytes);
        return;
      }
      const pkg = {
        ...value.pkg,
        dist: {
          tarball: `http://127.0.0.1:${server.address().port}/${name}/-/${value.packed.filename}`,
          integrity: value.packed.integrity,
          shasum: crypto.createHash('sha1').update(value.bytes).digest('hex'),
        },
      };
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: pkg } }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const prefix = path.join(root, 'prefix');
    const env = {
      ...process.env,
      CIBYP_CACHE_DIR: path.join(root, 'runtime'),
      APPDATA: path.join(root, 'roaming'),
      XDG_DATA_HOME: path.join(root, 'desktop'),
      CIBYP_DESKTOP_DIR: path.join(root, 'menu'),
      npm_config_cache: path.join(root, 'npm-cache'),
    };
    await npm(
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--registry',
        `http://127.0.0.1:${server.address().port}`,
        '--no-audit',
        '--no-fund',
        'cibyp@' + version,
      ],
      { env },
    );
    const modules =
      process.platform === 'win32'
        ? path.join(prefix, 'node_modules')
        : path.join(prefix, 'lib/node_modules');
    for (const entry of ['cibyp', 'cibyp-tui', 'cibyp-code']) {
      const result = await run(
        process.execPath,
        [path.join(modules, 'cibyp/bin', entry + '.cjs'), '--version'],
        { env },
      );
      assert.equal(result.stdout.trim(), version);
    }
    assert.ok((await fs.readdir(env.CIBYP_CACHE_DIR)).some((name) => name.startsWith(version)));
    assert.ok(
      downloaded.some((name) =>
        name.startsWith(`cibyp-runtime-${process.platform}-${process.arch}-part-`),
      ),
    );
    assert.ok(
      downloaded.every(
        (name) =>
          name === 'cibyp' || name.startsWith(`cibyp-runtime-${process.platform}-${process.arch}`),
      ),
    );
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
