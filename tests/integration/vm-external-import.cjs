/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real SSH/SFTP imports on a disposable overlay. The installed base image is read-only.
// node tests/integration/vm-external-import.cjs <assetsDir> <version> [variant]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { VmService } = require('../../src/main/vm/vm-service');
const { VmFs } = require('../../src/main/vm/vm-fs');
const images = require('../../src/main/vm/vm-images');

const [assetsDir, version, variant = 'full'] = process.argv.slice(2);
if (!assetsDir || !version) throw new Error('Pass an installed assets directory and image version');
const selected = images
  .localStatus(assetsDir, { variant })
  .versions.find((row) => row.ok && row.version === version);
assert(selected, 'Use an installed read-only OS image');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vm-import-test-'));
const instance = new VmInstance({
  assetsDir,
  imagePath: selected.image,
  kernelPath: selected.kernel,
  initrdPath: selected.initrd,
  appPath: path.resolve(__dirname, '../..'),
  variant,
  version,
  config: { smp: 2, memMB: 2048, tcg: true, bootTimeoutMs: 240000 },
});
instance.dir = path.join(profile, 'instance');
instance.overlayPath = path.join(instance.dir, 'overlay.qcow2');
instance.instanceFile = path.join(instance.dir, 'instance.json');
instance.on('error', (error) => console.error('[vm-import]', error.message));
instance.on('state', (state) => console.log('[vm-import]', state.state, state.detail || ''));
const services = [];
function cleanupFixture() {
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.join(os.tmpdir(), 'cibyp-vm-import-test-')))
    throw new Error('Unsafe fixture cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
}
function restartService() {
  const vm = new VmService({
    app: { getPath: () => profile, getAppPath: () => instance.opts.appPath },
    getSettings: () => ({
      runtime: { location: 'vm', workspaceMode: 'isolated', vm: { assetsDir, variant } },
    }),
  });
  vm.instance = instance;
  services.push(vm);
  return vm;
}

async function run() {
  try {
    await instance.start();
    const vm = restartService();
    const io = new VmFs({ vmService: vm });
    const host = path.join(profile, 'project');
    fs.mkdirSync(path.join(host, '.git'), { recursive: true });
    fs.writeFileSync(path.join(host, '.git/HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(host, 'source.txt'), 'host source\n');
    const identity = createHash('sha256')
      .update(process.platform === 'win32' ? host.toLowerCase() : host)
      .digest('hex');
    const unknown = '/workspace/_external/project-' + identity.slice(0, 8);
    await io.writeBuffer(unknown + '/guest-only.txt', Buffer.from('unverified guest edits\n'));
    const imported = await vm.mountExternalDir(host, { preserveGit: true });
    assert.equal(imported.ok, true, imported.error);
    assert.notEqual(imported.vmRoot, unknown);
    assert.deepEqual(imported.preserved, [unknown]);
    assert.equal(
      (await io.readBuffer(unknown + '/guest-only.txt')).toString(),
      'unverified guest edits\n',
    );
    assert.equal(await io.exists(unknown + '/.cibyp-host-import'), false);
    assert.equal(
      (await io.readBuffer(imported.vmRoot + '/source.txt')).toString(),
      'host source\n',
    );
    assert.equal(
      (await io.readBuffer(imported.vmRoot + '/.git/HEAD')).toString(),
      'ref: refs/heads/main\n',
    );
    await io.writeBuffer(imported.vmRoot + '/source.txt', Buffer.from('edited in guest\n'));
    const restoredVm = restartService();
    const restored = await restoredVm.mountExternalDir(host, { preserveGit: true });
    assert.equal(restored.vmRoot, imported.vmRoot);
    assert.equal(
      (await io.readBuffer(restored.vmRoot + '/source.txt')).toString(),
      'edited in guest\n',
    );
    assert.equal(fs.readFileSync(path.join(host, 'source.txt'), 'utf8'), 'host source\n');
    assert.equal((await restoredVm.pullExternalDir(restored.vmRoot, { force: true })).ok, true);
    assert.equal(fs.readFileSync(path.join(host, 'source.txt'), 'utf8'), 'edited in guest\n');
    // Reproduce an older completed import that lost its marker; its durable
    // baseline proves the host source, so guest edits remain in the same directory.
    const marker = restored.vmRoot + '/.cibyp-host-import';
    await (await io.sftp()).unlink(marker);
    assert.equal(
      (await restartService().mountExternalDir(host, { preserveGit: true })).vmRoot,
      restored.vmRoot,
    );
    assert.equal(JSON.parse(await io.readBuffer(marker)).status, 'ready');
    const retryHost = path.join(profile, 'retry');
    fs.mkdirSync(retryHost);
    fs.writeFileSync(path.join(retryHost, 'retry.txt'), 'transfer after restart\n');
    const failingVm = restartService();
    const pair = failingVm.workspacePair.bind(failingVm);
    failingVm.workspacePair = (...args) => {
      const sync = pair(...args);
      sync.sync = async () => ({ ok: false, error: 'Simulated interrupted transfer' });
      return sync;
    };
    assert.equal((await failingVm.mountExternalDir(retryHost)).ok, false);
    assert.equal(failingVm._externMounts.size, 0);
    const retried = await restartService().mountExternalDir(retryHost);
    assert.equal(retried.ok, true, retried.error);
    assert.equal(
      (await io.readBuffer(retried.vmRoot + '/retry.txt')).toString(),
      'transfer after restart\n',
    );
    console.log(
      '[vm-import] PASS: unowned contents preserved, Git import, restart reuse, bidirectional export, missing-marker recovery, interrupted-transfer retry',
    );
  } finally {
    for (const vm of services) clearInterval(vm._syncTimer);
    await instance.stop();
    cleanupFixture();
  }
}
run().catch((error) => {
  console.error('[vm-import] FAIL:', error.stack || error);
  process.exitCode = 1;
});
