const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppUpdates, selectInstaller } = require('../../src/main/services/app-updates');
const bytes = Buffer.from('test installer');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const asset = {
  name: 'Could-I-Be-Your-Partner-Setup-2.0.0-x64.exe',
  size: bytes.length,
  digest: 'sha256:' + sha256,
  browser_download_url:
    'https://github.com/B5-Software/Could-I-Be-Your-Partner/releases/download/v2.0.0/installer.exe',
};
test('installer selection rejects missing checksums and wrong architecture', () => {
  assert.equal(selectInstaller([asset], 'win32', 'x64').sha256, sha256);
  assert.throws(() => selectInstaller([asset], 'win32', 'arm64'), /installer/);
  assert.throws(() => selectInstaller([{ ...asset, digest: null }], 'win32', 'x64'), /digest/);
});
test('one shared download, verified restart state, task guard and tampering rejection', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let downloads = 0,
    busy = true;
  const options = {
    app: { getVersion: () => '1.0.0', getPath: () => directory, getAppPath: () => directory },
    settings: () => ({ updates: { channel: 'all' } }),
    publish: () => {},
    platform: 'win32',
    arch: 'x64',
    env: { CIBYP_CACHE_DIR: path.join(directory, 'cache') },
    busy: () => busy,
    json: async () => [{ tag_name: 'v2.0.0', assets: [asset] }],
    download: async (_asset, file) => {
      downloads++;
      await fs.writeFile(file, bytes);
    },
  };
  const updater = new AppUpdates(options);
  await Promise.all([updater.start(), updater.start()]);
  await updater.operation;
  assert.equal(downloads, 1);
  assert.equal(updater.status().phase, 'ready');
  assert.equal('file' in updater.status(), false);
  assert.match((await updater.install()).error, /tasks/);
  const restored = new AppUpdates(options);
  await restored.restore();
  assert.equal(restored.status().phase, 'ready');
  busy = false;
  await fs.writeFile(updater.state.file, 'tampered');
  assert.match((await updater.install()).error, /checksum/);
  const invalid = new AppUpdates(options);
  await invalid.restore();
  assert.equal(invalid.status().phase, 'idle');
  await updater.start();
  await updater.operation;
  assert.equal(updater.status().phase, 'ready');
  assert.equal(downloads, 2, 'a rejected installer can be replaced by a verified download');
});
test('a download error is reported and a retry can succeed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-update-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const updater = new AppUpdates({
    app: { getVersion: () => '1.0.0', getPath: () => directory },
    settings: () => ({}),
    publish: () => {},
    platform: 'win32',
    arch: 'x64',
    env: {},
    json: async () => {
      if (++calls === 1) throw new Error('offline');
      return [{ tag_name: 'v1.0.0' }];
    },
  });
  await updater.start();
  await updater.operation;
  assert.equal(updater.status().phase, 'error');
  await updater.start();
  await updater.operation;
  assert.equal(updater.status().phase, 'current');
});

test('simultaneous restart confirmations launch only one installer', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-update-install-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let launches = 0;
  const updater = new AppUpdates({
    app: { getVersion: () => '1.0.0', getPath: () => directory, quit() {} },
    settings: () => ({}),
    publish() {},
    platform: 'win32',
    arch: 'x64',
    env: {},
    json: async () => [{ tag_name: 'v2.0.0', assets: [asset] }],
    download: async (_asset, file) => fs.writeFile(file, bytes),
    launch: () => {
      launches++;
      const child = new (require('node:events').EventEmitter)();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  await updater.start();
  await updater.operation;
  const results = await Promise.all([updater.install(), updater.install()]);
  assert.equal(launches, 1);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test('an unavailable system installer keeps the application alive and allows retry', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-update-opener-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let quits = 0;
  const updater = new AppUpdates({
    app: {
      getVersion: () => '1.0.0',
      getPath: () => directory,
      quit() {
        quits++;
      },
    },
    settings: () => ({}),
    publish() {},
    platform: 'linux',
    arch: 'x64',
    env: {},
    json: async () => [
      { tag_name: 'v2.0.0', assets: [{ ...asset, name: 'cibyp_2.0.0_amd64.deb' }] },
    ],
    download: async (_asset, file) => fs.writeFile(file, bytes),
    launch: () => {
      const child = new (require('node:events').EventEmitter)();
      child.unref = () => {};
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('exit', 3);
      });
      return child;
    },
  });
  await updater.start();
  await updater.operation;
  assert.match((await updater.install()).error, /could not be opened/);
  assert.equal(updater.status().phase, 'ready');
  assert.equal(quits, 0);
});

test('npm-managed updates pin the selected version, persist a usable runtime and reject mismatches', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-update-managed-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cache = path.join(directory, 'cache');
  const staged = path.join(cache, '2.0.0-win32-x64');
  await fs.mkdir(staged, { recursive: true });
  const runtimeAsset = { sha256, entry: 'app/main.js', node: 'node.exe', executable: 'cibyp.exe' };
  await fs.mkdir(path.join(staged, 'app'));
  for (const name of ['entry', 'node', 'executable'])
    await fs.writeFile(path.join(staged, runtimeAsset[name]), bytes);
  await fs.writeFile(path.join(staged, '.cibyp-runtime.json'), JSON.stringify({ sha256 }));
  const releases = require('../../packages/npm/lib/releases.cjs');
  const original = releases.discoverRelease;
  let requested;
  releases.discoverRelease = async (options) => {
    requested = options.version;
    return { version: options.version };
  };
  t.after(() => {
    releases.discoverRelease = original;
  });
  const options = {
    app: {
      getVersion: () => '1.0.0',
      getPath: () => directory,
      getAppPath: () => path.join(cache, 'old/app'),
    },
    settings: () => ({ updates: { channel: 'all' } }),
    publish() {},
    platform: 'win32',
    arch: 'x64',
    env: { CIBYP_CACHE_DIR: cache },
    json: async () => [{ tag_name: 'v2.0.0', assets: [{ name: 'cibyp-runtime.json' }] }],
    resolveRuntime: async (options) => {
      const manifest = await options.discover({ channel: 'preview' });
      await require('../../packages/npm/lib/updates.cjs').writeState(cache, {
        channel: 'preview',
        manifest,
      });
      return { directory: staged, asset: runtimeAsset };
    },
  };
  const updater = new AppUpdates(options);
  await updater.start();
  await updater.operation;
  assert.equal(requested, '2.0.0');
  assert.equal(updater.status().phase, 'ready');
  assert.equal(updater.status().kind, 'launcher');
  assert.equal('runtime' in updater.status(), false);
  const restored = new AppUpdates(options);
  await restored.restore();
  assert.equal(restored.status().phase, 'ready');
  const mismatch = new AppUpdates({
    ...options,
    resolveRuntime: async () => {
      await require('../../packages/npm/lib/updates.cjs').writeState(cache, {
        channel: 'preview',
        manifest: { version: '3.0.0' },
      });
      return { directory: staged, asset: runtimeAsset };
    },
  });
  await mismatch.start();
  await mismatch.operation;
  assert.equal(mismatch.status().phase, 'error');
  assert.match(mismatch.status().error, /requested version/);
});
