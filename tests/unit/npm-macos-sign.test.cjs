/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareMacRuntime, signingTargets } = require('../../packages/npm/lib/macos.cjs');
const {
  ensureRuntime,
  checksum,
  runtimeDirectoryName,
} = require('../../packages/npm/lib/runtime.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-mac-sign-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'Could I Be Your Partner.app');
  const executable = 'Could I Be Your Partner.app/Contents/MacOS/CIBYP';
  const helper = path.join(app, 'Contents/Frameworks/Helper.app');
  await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await fs.mkdir(path.join(helper, 'Contents/MacOS'), { recursive: true });
  await fs.mkdir(path.join(app, 'Contents/Resources/native'), { recursive: true });
  for (const file of [
    path.join(root, executable),
    path.join(helper, 'Contents/MacOS/Helper'),
    path.join(app, 'Contents/Resources/native/addon.node'),
  ]) {
    await fs.writeFile(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  }
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), 'fixture');
  await fs.writeFile(path.join(helper, 'Contents/Info.plist'), 'fixture');
  await fs.writeFile(
    path.join(app, 'Contents/Resources/Main.class'),
    Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61]),
  );
  await fs.mkdir(path.join(app, 'Contents/Resources/assets.bundle'));
  return { root, app, helper, asset: { executable } };
}

test('local macOS signing preserves valid signatures and signs native code before enclosing bundles', async (t) => {
  const { root, app, helper, asset } = await fixture(t);
  let calls = [];
  await prepareMacRuntime(root, asset, {
    log: () => {},
    run: async (...args) => {
      calls.push(args);
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['--verify', '--deep', '--strict', app]);
  calls = [];
  let verifies = 0;
  await prepareMacRuntime(root, asset, {
    log: () => {},
    run: async (file, args) => {
      calls.push([file, args]);
      if (args.includes('--verify') && ++verifies === 1) throw new Error('unsigned');
      if (args.includes('--display'))
        return {
          stdout:
            '<?xml version="1.0"?><plist><dict><key>custom.entitlement</key><true/></dict></plist>',
        };
      if (file.endsWith('PlistBuddy'))
        assert.match(await fs.readFile(args.at(-1), 'utf8'), /custom.entitlement/);
      return { stdout: '' };
    },
  });
  const signed = calls.filter(([, args]) => args.includes('--sign')).map(([, args]) => args.at(-1));
  assert.equal(signed.length, 5);
  assert.deepEqual(signed.slice(-2), [helper, app]);
  assert.ok(signed.some((file) => file.endsWith('addon.node')));
  assert.ok(!signed.some((file) => /Main.class|assets.bundle/.test(file)));
  assert.ok(
    calls
      .filter(([, args]) => args.includes('--sign'))
      .every(([, args]) => !args.includes('--deep') && args[args.indexOf('--sign') + 1] === '-'),
  );
  assert.equal(verifies, 2);
  assert.ok(!(await fs.readdir(root)).some((file) => file.startsWith('.cibyp-signing-')));
  await assert.rejects(
    prepareMacRuntime(root, { executable: '../Other.app/Contents/MacOS/Other' }),
    /outside/,
  );
});

test('a failed local signature never publishes a usable cache and temporary signing files are removed', async (t) => {
  const { root, asset } = await fixture(t);
  await assert.rejects(
    prepareMacRuntime(root, asset, {
      log: () => {},
      run: async (_file, args) => {
        if (args.includes('--verify')) throw new Error('unsigned');
        if (args.includes('--sign')) throw new Error('sign failed');
        return { stdout: '' };
      },
    }),
    /local signing failed/,
  );
  assert.ok(!(await fs.readdir(root)).some((file) => file.startsWith('.cibyp-signing-')));
  const bytes = Buffer.from('verified archive fixture');
  const archive = path.join(root, 'fixture.tar.gz');
  await fs.writeFile(archive, bytes);
  const metadata = {
    version: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    file: 'cibyp-runtime-1.0.0-darwin-arm64.tar.gz',
    size: bytes.length,
    sha256: await checksum(archive),
    executable: asset.executable,
    resources: 'Could I Be Your Partner.app/Contents/Resources',
    node: 'node',
    entry: 'entry.cjs',
  };
  const manifest = { schema: 1, version: '1.0.0', targets: { 'darwin-arm64': metadata } };
  const cache = path.join(root, 'cache');
  let preparations = 0;
  const options = {
    platform: 'darwin',
    arch: 'arm64',
    env: { CIBYP_CACHE_DIR: cache },
    log: () => {},
    download: async (_asset, destination) => fs.copyFile(archive, destination),
    extract: async (_command, args) => {
      const staging = args.at(-1);
      await fs.cp(
        path.join(root, 'Could I Be Your Partner.app'),
        path.join(staging, 'Could I Be Your Partner.app'),
        { recursive: true },
      );
      await fs.writeFile(path.join(staging, 'node'), 'node');
      await fs.writeFile(path.join(staging, 'entry.cjs'), 'entry');
    },
    prepareMac: async (staging) => {
      preparations++;
      await assert.rejects(fs.stat(path.join(staging, '.cibyp-runtime.json')), { code: 'ENOENT' });
      if (preparations === 1) throw new Error('sign failed');
    },
  };
  await assert.rejects(ensureRuntime(manifest, options), /sign failed/);
  assert.deepEqual(await fs.readdir(cache), []);
  const ready = await ensureRuntime(manifest, options);
  assert.equal(
    path.basename(ready.directory),
    runtimeDirectoryName(manifest, 'darwin', 'arm64', metadata),
  );
  assert.match(ready.directory, /-signed-1$/);
  await ensureRuntime(manifest, {
    ...options,
    prepareMac: () => assert.fail('must reuse signed cache'),
  });
  assert.equal(preparations, 2);
  const corrupt = {
    ...manifest,
    targets: { 'darwin-arm64': { ...metadata, sha256: 'a'.repeat(64) } },
  };
  await assert.rejects(
    ensureRuntime(corrupt, {
      ...options,
      prepareMac: () => assert.fail('unverified archive must not be signed'),
    }),
    /SHA-256/,
  );
});

test(
  'native signing discovery never follows symlinks outside its App',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, app } = await fixture(t);
    const outside = path.join(root, 'outside.node');
    await fs.writeFile(outside, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    await fs.symlink(outside, path.join(app, 'Contents/Resources/external.node'));
    const targets = await signingTargets(app);
    assert.ok(!targets.binaries.includes(outside));
    assert.equal(targets.binaries.length, 3);
  },
);
