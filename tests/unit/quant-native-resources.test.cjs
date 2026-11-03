/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const runtime = require('../../src/main/services/quant/native-binary');
const { stage, sourceHash } = require('../../scripts/lib/quant-engine-runtime.cjs');
test('packaged native lookup never borrows the developer checkout when installed resources are missing or invalid', (t) => {
  const root = folder(t),
    previous = process.resourcesPath,
    override = process.env.CIBYP_QUANT_ENGINE_BIN;
  delete process.env.CIBYP_QUANT_ENGINE_BIN;
  process.resourcesPath = root;
  t.after(() => {
    if (previous === undefined) delete process.resourcesPath;
    else process.resourcesPath = previous;
    if (override !== undefined) process.env.CIBYP_QUANT_ENGINE_BIN = override;
  });
  fs.writeFileSync(path.join(root, 'app.asar'), 'installed marker');
  const { NativeEngine } = require('../../src/main/services/quant/native-engine');
  const engine = new NativeEngine({ directory: path.join(root, 'private-profile') });
  assert.equal(engine.inspect().reason, 'NATIVE_BINARY_UNAVAILABLE');
  fs.mkdirSync(path.join(root, 'quant-engine'));
  fs.writeFileSync(path.join(root, 'quant-engine/manifest.json'), '{}');
  assert.equal(engine.inspect().reason, 'NATIVE_MANIFEST_INVALID');
});
function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-native-resource-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cibyp-native-resource-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}
function fixtureBinary(platform, arch) {
  const bytes = Buffer.alloc(256);
  if (platform === 'win32') {
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 60);
    bytes.writeUInt32LE(0x4550, 64);
    bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68);
    bytes.writeUInt16LE(2, 86);
  } else if (platform === 'darwin') {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
    bytes.writeUInt32LE(2, 12);
  } else {
    bytes.writeUInt32BE(0x7f454c46, 0);
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(1, 64);
  }
  return bytes;
}
for (const key of Object.keys(runtime.lock.targets))
  test('native resource validates ' + key + ' architecture and immutable archive hashes', (t) => {
    const root = folder(t),
      [platform, arch] = key.split('-'),
      binary = path.join(root, 'fixture');
    fs.writeFileSync(binary, fixtureBinary(platform, arch));
    const destination = path.join(root, 'quant-engine'),
      prepared = stage(binary, destination, platform, arch, { sourceHash: 'a'.repeat(64) });
    assert.deepEqual(runtime.decode(destination, platform, arch).bytes, fs.readFileSync(binary));
    assert.equal(prepared.manifest.target, key);
    assert.throws(
      () => runtime.decode(destination, platform, arch === 'x64' ? 'arm64' : 'x64'),
      /MANIFEST/,
    );
    fs.appendFileSync(path.join(destination, 'engine.gz'), 'changed');
    assert.throws(() => runtime.decode(destination, platform, arch), /ARCHIVE_MISMATCH/);
  });
test('managed native cache repairs only from verified resources and uses separate paths for different payload hashes', (t) => {
  const root = folder(t),
    resources = path.join(root, 'resources'),
    cache = path.join(root, 'cache'),
    binary = path.join(root, 'fixture');
  const platform = process.platform,
    arch = process.arch;
  fs.writeFileSync(binary, fixtureBinary(platform, arch));
  stage(binary, path.join(resources, 'quant-engine'), platform, arch, {
    sourceHash: 'a'.repeat(64),
  });
  const first = runtime.resolveManaged(resources, cache);
  assert.equal(first.development, false);
  assert.match(first.binary, new RegExp(first.sha256));
  fs.writeFileSync(first.binary, 'broken');
  assert.equal(runtime.resolveManaged(resources, cache).sha256, first.sha256);
  assert.equal(runtime.sha256(fs.readFileSync(first.binary)), first.sha256);
  const updated = fixtureBinary(platform, arch);
  updated[255] = 42;
  fs.writeFileSync(binary, updated);
  stage(binary, path.join(resources, 'quant-engine'), platform, arch, {
    sourceHash: 'b'.repeat(64),
  });
  const second = runtime.resolveManaged(resources, cache);
  assert.notEqual(second.binary, first.binary);
  assert.equal(fs.existsSync(first.binary), true, 'active old versions are preserved');
  fs.writeFileSync(second.binary, 'broken');
  fs.writeFileSync(path.join(resources, 'quant-engine/engine.gz'), 'corrupt');
  assert.throws(() => runtime.resolveManaged(resources, cache), /ARCHIVE_MISMATCH/);
  assert.equal(
    fs.readFileSync(second.binary, 'utf8'),
    'broken',
    'unverified bytes never repair the cache',
  );
});
test('native resources refuse wrong executable headers and dynamic Linux interpreters', () => {
  assert.throws(
    () => runtime.executable(fixtureBinary('win32', 'arm64'), 'win32', 'x64'),
    /TARGET/,
  );
  assert.throws(
    () => runtime.executable(fixtureBinary('darwin', 'arm64'), 'darwin', 'x64'),
    /TARGET/,
  );
  const bytes = fixtureBinary('linux', 'x64');
  bytes.writeUInt32LE(3, 64);
  assert.throws(() => runtime.executable(bytes, 'linux', 'x64'), /NOT_STATIC/);
});

test('Windows cache replacement tolerates transient scanner locks and leaves a permanently locked cache intact', (t) => {
  const root = folder(t),
    resources = path.join(root, 'resources'),
    cache = path.join(root, 'cache'),
    source = path.join(root, 'fixture');
  fs.writeFileSync(source, fixtureBinary('win32', 'x64'));
  stage(source, path.join(resources, 'quant-engine'), 'win32', 'x64', {
    sourceHash: 'c'.repeat(64),
  });
  const first = runtime.resolveManaged(resources, cache, 'win32', 'x64');
  fs.writeFileSync(first.binary, 'broken');
  const original = fs.renameSync;
  let attempts = 0,
    permanent = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === first.binary && (permanent || attempts++ < 2))
      throw Object.assign(Error('scanner holds file'), { code: 'EPERM' });
    return original(from, to);
  });
  const repaired = runtime.resolveManaged(resources, cache, 'win32', 'x64');
  assert.equal(attempts, 3);
  assert.equal(runtime.sha256(fs.readFileSync(repaired.binary)), first.sha256);
  fs.writeFileSync(first.binary, 'still locked');
  permanent = true;
  assert.throws(
    () => runtime.resolveManaged(resources, cache, 'win32', 'x64'),
    /NATIVE_CACHE_BUSY/,
  );
  assert.equal(fs.readFileSync(first.binary, 'utf8'), 'still locked');
  assert.ok(
    fs.readdirSync(path.dirname(first.binary)).every((name) => !name.startsWith('.extract-')),
  );
});
test('native build fingerprints include source, dependency lock, toolchain and packaging policy but ignore platform line endings', (t) => {
  const root = folder(t),
    files = [
      'native/quant-engine/Cargo.toml',
      'native/quant-engine/Cargo.lock',
      'native/quant-engine/rust-toolchain.toml',
      'native/quant-engine/src/main.rs',
      'scripts/lib/quant-engine-runtime.cjs',
      'src/main/services/quant/native-binary.js',
      'src/main/services/native-resource.js',
      'integrations/quant/runtime-lock.json',
      'LICENSE',
    ];
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(file), target);
  }
  const first = sourceHash(root);
  const file = path.join(root, 'native/quant-engine/src/main.rs'),
    text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/\r?\n/g, '\r\n'));
  assert.equal(sourceHash(root), first);
  fs.appendFileSync(file, '\n// a source change\n');
  assert.notEqual(sourceHash(root), first);
  fs.writeFileSync(file, text);
  fs.appendFileSync(
    path.join(root, 'scripts/lib/quant-engine-runtime.cjs'),
    '\n// changed build policy\n',
  );
  assert.notEqual(sourceHash(root), first);
});
