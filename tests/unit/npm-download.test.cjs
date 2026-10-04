/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { sources, downloadVerified } = require('../../packages/npm/lib/download.cjs');
const { discoverRelease } = require('../../packages/npm/lib/releases.cjs');
const { resolveRuntime, writeState, readState } = require('../../packages/npm/lib/updates.cjs');

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17);
  const server = http.createServer((req, res) => handler(req, res, bytes));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    root,
    bytes,
    url: 'http://127.0.0.1:' + server.address().port,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}
function serve(req, res, bytes) {
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
  if (range) {
    const start = Number(range[1]),
      end = Number(range[2]);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` });
    res.end(bytes.subarray(start, end + 1));
  } else res.end(bytes);
}
test('parallel range downloads retry transient failures and verify the complete archive', async (t) => {
  let active = 0,
    maximum = 0,
    failed = false;
  const data = await fixture(t, (req, res, bytes) => {
    if (req.headers.range === 'bytes=0-0') return serve(req, res, bytes);
    if (!failed) {
      failed = true;
      res.writeHead(503);
      res.end();
      return;
    }
    active++;
    maximum = Math.max(maximum, active);
    setTimeout(() => {
      active--;
      serve(req, res, bytes);
    }, 40);
  });
  const file = path.join(data.root, 'archive');
  await downloadVerified({ url: data.url, size: data.bytes.length, sha256: data.sha256 }, file, {
    candidates: [data.url],
  });
  assert.ok(maximum > 1);
  assert.deepEqual(await fs.readFile(file), data.bytes);
  assert.deepEqual(await fs.readdir(data.root), ['archive']);
});
test('unsupported ranges fall back to a single stream and corrupt mirrors cannot replace trusted bytes', async (t) => {
  let full = 0;
  const data = await fixture(t, (req, res, bytes) => {
    if (req.url === '/bad') {
      res.end(Buffer.alloc(bytes.length));
      return;
    }
    if (req.headers.range === 'bytes=0-0') return serve(req, res, bytes);
    if (!req.headers.range) full++;
    res.end(bytes);
  });
  const file = path.join(data.root, 'archive');
  await downloadVerified({ url: data.url, size: data.bytes.length, sha256: data.sha256 }, file, {
    candidates: [data.url + '/bad', data.url],
  });
  assert.equal(full, 1);
  assert.deepEqual(await fs.readFile(file), data.bytes);
});
test('cancellation removes partial bytes and failed checks never extract or publish them', async (t) => {
  const data = await fixture(t, (req, res, bytes) => {
    if (req.headers.range === 'bytes=0-0') return serve(req, res, bytes);
    res.writeHead(200);
    res.write(bytes.subarray(0, 1024));
  });
  const controller = new AbortController();
  const file = path.join(data.root, 'archive');
  await assert.rejects(
    downloadVerified({ url: data.url, size: data.bytes.length, sha256: data.sha256 }, file, {
      candidates: [data.url],
      concurrency: 1,
      signal: controller.signal,
      onProgress: () => controller.abort(new Error('cancel fixture')),
    }),
    /cancel fixture/,
  );
  assert.deepEqual(await fs.readdir(data.root), []);
});
test('download sources reject untrusted origins, unsafe mirrors and missing pinned hashes', async () => {
  const url =
    'https://github.com/B5-Software/Could-I-Be-Your-Partner/releases/download/v1.0.0/runtime.tar.gz';
  assert.equal(sources(url, [])[0], url);
  assert.throws(() => sources('https://example.com/runtime'), /origin/);
  for (const mirror of ['http://mirror.example/', 'https://user:password@mirror.example/'])
    assert.throws(() => sources(url, [mirror]), /HTTPS/);
  await assert.rejects(downloadVerified({ url, size: 10 }, 'unused'), /trusted SHA-256/);
});
test('release discovery uses the official manifest, validates all targets and rejects altered asset digests', async () => {
  const version = '1.9.0-alpha.20';
  const base =
    'https://github.com/B5-Software/Could-I-Be-Your-Partner/releases/download/v' + version + '/';
  const keys = [
    'win32-x64',
    'win32-arm64',
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
  ];
  const manifest = {
    schema: 1,
    version,
    targets: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          file: `cibyp-runtime-${version}-${key}.tar.gz`,
          sha256: 'a'.repeat(64),
          size: 10,
          node: 'node',
          entry: 'launch.cjs',
          executable: 'CIBYP',
          resources: 'resources',
        },
      ]),
    ),
  };
  const assets = Object.values(manifest.targets).map((item) => ({
    name: item.file,
    size: item.size,
    digest: 'sha256:' + item.sha256,
    browser_download_url: base + item.file,
  }));
  assets.push({ name: 'cibyp-runtime.json', browser_download_url: base + 'cibyp-runtime.json' });
  const release = {
    tag_name: 'v' + version,
    prerelease: true,
    published_at: '2026-10-04T00:00:00Z',
    assets,
  };
  const urls = [];
  const fetchJSON = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(url.includes('api.github.com') ? [release] : manifest));
  };
  const found = await discoverRelease({ fetchJSON });
  assert.equal(found.targets['win32-x64'].url, base + manifest.targets['win32-x64'].file);
  assert.ok(urls.every((url) => url.startsWith('https://api.github.com/') || url.startsWith(base)));
  await assert.rejects(discoverRelease({ channel: 'stable', fetchJSON }), /No complete runtime/);
  const encoded = JSON.stringify(manifest);
  const metadata = assets.at(-1);
  metadata.size = Buffer.byteLength(encoded);
  metadata.digest = 'sha256:' + crypto.createHash('sha256').update(encoded).digest('hex');
  const downloadManifest = async (asset, file, options) => {
    assert.equal(
      asset.sha256,
      metadata.digest.slice(7),
      'metadata hash must come from the official API',
    );
    assert.equal(asset.size, metadata.size);
    assert.equal(options.concurrency, 1);
    await fs.writeFile(file, encoded);
  };
  assert.equal((await discoverRelease({ fetchJSON, downloadManifest })).version, version);
  assets[0].digest = 'sha256:' + 'b'.repeat(64);
  await assert.rejects(discoverRelease({ fetchJSON, downloadManifest }), /official release asset/);
  metadata.browser_download_url = metadata.browser_download_url.replace('https:', 'http:');
  await assert.rejects(discoverRelease({ fetchJSON, downloadManifest }), /manifest origin/);
});
test('automatic updates fall back to the verified cache, explicit updates fail, and channels persist', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { CIBYP_CACHE_DIR: root };
  const key = process.platform + '-' + process.arch;
  const asset = {
    file: `cibyp-runtime-1.0.0-${key}.tar.gz`,
    sha256: 'a'.repeat(64),
    size: 10,
    node: 'node',
    entry: 'launch.cjs',
    executable: 'CIBYP',
    resources: 'resources',
  };
  const manifest = { schema: 1, version: '1.0.0', targets: { [key]: asset } };
  const directory = path.join(root, `1.0.0-${key}-${asset.sha256.slice(0, 12)}`);
  await fs.mkdir(directory);
  for (const name of ['node', 'launch.cjs', 'CIBYP'])
    await fs.writeFile(path.join(directory, name), 'fixture');
  await fs.writeFile(
    path.join(directory, '.cibyp-runtime.json'),
    JSON.stringify({ sha256: asset.sha256 }),
  );
  await writeState(root, { channel: 'preview', checkedAt: 0, manifest });
  const options = {
    env,
    now: () => 24 * 60 * 60 * 1000,
    discover: async () => {
      throw new Error('network fixture');
    },
    log: () => {},
  };
  assert.equal((await resolveRuntime(options)).directory, directory);
  await assert.rejects(resolveRuntime({ ...options, force: true }), /network fixture/);
  await assert.rejects(resolveRuntime({ ...options, channel: 'stable' }), /network fixture/);
  assert.equal((await readState({ env })).channel, 'preview');
  let selected;
  await resolveRuntime({
    ...options,
    channel: 'stable',
    discover: async ({ channel }) => {
      selected = channel;
      return manifest;
    },
    ensure: async () => ({ directory, asset }),
  });
  assert.equal(selected, 'stable');
  assert.equal((await readState({ env })).channel, 'stable');
  assert.equal((await resolveRuntime({ ...options, offline: true })).directory, directory);
  await assert.rejects(
    resolveRuntime({ ...options, offline: true, force: true }),
    /requires network/,
  );
});
