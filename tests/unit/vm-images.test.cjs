const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const images = require('../../src/main/vm/vm-images');
const { VmService } = require('../../src/main/vm/vm-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = { runtime: { vm: { assetsDir: root, variant: 'desktop' } } };
  const vm = new VmService({
    app: { getPath: () => root, getAppPath: () => root },
    getSettings: () => settings,
  });
  function install(version, variant = 'desktop') {
    const dir = path.join(root, 'images', variant, version);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of [
      `cibyp-vmos-${version}-${variant}-${images.guestArch()}.qcow2`,
      `vmlinuz-${images.guestArch()}`,
      `initrd-${images.guestArch()}.img`,
    ])
      fs.writeFileSync(path.join(dir, name), 'fixture');
  }
  return { vm, root, settings, install };
}

test('image selection uses numeric versions and ignores incomplete installations', (t) => {
  const { root, install } = fixture(t);
  install('0.9.0');
  install('0.10.0');
  fs.mkdirSync(path.join(root, 'images/desktop/0.11.0'));
  assert.equal(images.localStatus(root, { variant: 'desktop' }).selected.version, '0.10.0');
});

test('download manifests cannot use versions to escape the image directory', () => {
  for (const version of [
    '../../instances',
    '..\\..\\settings',
    '0.3.1/../../data',
    '0.3.1:stream',
    '0.3.1.',
  ]) {
    assert.throws(() => images.pickArtifacts({ version }), /版本号不合法/);
  }
  const artifact = { url: 'https://example.invalid/image', sha256: '0'.repeat(64), size: 1 };
  const manifest = {
    version: '0.3.1',
    variants: { desktop: { arches: { amd64: artifact } } },
    kernel: { amd64: { kernel: artifact, initrd: artifact } },
  };
  assert.equal(
    images.pickArtifacts(manifest, { variant: 'desktop', arch: 'x64' }).version,
    '0.3.1',
  );
});

test('new images receive separate persistent disks and stopped services select the update', (t) => {
  const { vm, install } = fixture(t);
  install('0.2.1');
  const old = vm._ensureInstance();
  fs.mkdirSync(old.dir, { recursive: true });
  fs.writeFileSync(old.overlayPath, 'old user data');
  install('0.3.0');
  old.state = 'ready';
  assert.equal(vm._ensureInstance(), old);
  old.state = 'idle';
  const next = vm._ensureInstance();
  assert.notEqual(next.dir, old.dir);
  assert.equal(next.opts.version, '0.3.0');
  assert.equal(fs.readFileSync(old.overlayPath, 'utf8'), 'old user data');
  assert.equal(vm._ensureInstance(), next);
});

test('matching legacy disks are retained and variant changes keep both disks', (t) => {
  const { vm, root, install, settings } = fixture(t);
  install('0.2.1');
  const selected = images.localStatus(root, { variant: 'desktop' }).selected;
  const legacy = path.join(root, 'instances/default');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(
    path.join(legacy, 'instance.json'),
    JSON.stringify({ imagePath: selected.image }),
  );
  fs.writeFileSync(path.join(legacy, 'overlay.qcow2'), 'legacy');
  const first = vm._ensureInstance();
  assert.equal(first.dir, legacy);
  install('0.3.0', 'full');
  settings.runtime.vm.variant = 'full';
  assert.notEqual(vm._ensureInstance().dir, legacy);
  assert.equal(fs.readFileSync(first.overlayPath, 'utf8'), 'legacy');
  settings.runtime.vm.variant = 'desktop';
  assert.equal(vm._ensureInstance().dir, legacy);
});

test('stop closes graphics and forwarded ports before shutting down the instance', async (t) => {
  const { vm } = fixture(t);
  const order = [];
  vm.instance = { stop: async () => order.push('VM') };
  t.mock.method(vm, 'graphicsStop', async () => order.push('desktop'));
  vm._forwards = new Map([[1234, { guestPort: 80, close: () => order.push('port') }]]);
  await vm.stop();
  assert.deepEqual(order, ['desktop', 'port', 'VM']);
  assert.deepEqual(vm.listForwards(), []);
});

test('combined runtime downloads retain the same cancellation task through image installation', async (t) => {
  const { vm } = fixture(t);
  t.mock.method(vm, 'qemuPackInstalled', () => ({ dir: 'ready' }));
  const task = { cancelled: false, current: null };
  const manifest = {
    schema: 1,
    version: '0.3.1',
    get variants() {
      vm.cancelDownload();
      return {};
    },
  };
  const result = await vm.downloadAll({ task, manifest });
  assert.equal(task.cancelled, true);
  assert.equal(result.ok, false);
  assert.equal(vm._download, null);
});
