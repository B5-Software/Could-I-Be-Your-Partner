/* Opt-in real SSH/SFTP/sync/search check. The installed base disk is read only;
 * every write goes to a temporary overlay and temporary host directories. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { VmService } = require('../../src/main/vm/vm-service');
const { VmFs } = require('../../src/main/vm/vm-fs');
const { VmFileManager } = require('../../src/main/services/vm-file-manager');
const { WebResearch } = require('../../src/main/services/web-research');
const [assetsDir, version] = process.argv.slice(2);
if (!assetsDir || !version)
  throw Error('Usage: node vm-data-tools.cjs <installed assetsDir> <full image version>');
const selected = require('../../src/main/vm/vm-images')
  .localStatus(assetsDir, { variant: 'full' })
  .versions.find((row) => row.ok && row.version === version);
assert.ok(selected, 'An installed immutable base image is required');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vm-data-'));
const host = path.join(profile, 'host'),
  download = path.join(profile, 'download');
fs.mkdirSync(host);
fs.mkdirSync(download);
const instance = new VmInstance({
  assetsDir,
  imagePath: selected.image,
  kernelPath: selected.kernel,
  initrdPath: selected.initrd,
  appPath: path.resolve(__dirname, '../..'),
  variant: 'full',
  version,
  config: { smp: 2, memMB: 2048, tcg: true, bootTimeoutMs: 240000 },
});
instance.dir = path.join(profile, 'instance');
instance.overlayPath = path.join(instance.dir, 'overlay.qcow2');
instance.instanceFile = path.join(instance.dir, 'instance.json');
const settings = {
  runtime: {
    location: 'vm',
    workspaceMode: 'shared',
    vm: { assetsDir, variant: 'full', workspaceRoot: host },
  },
};
const service = new VmService({
  app: { getPath: () => profile, getAppPath: () => instance.opts.appPath },
  getSettings: () => settings,
});
service.instance = instance;
instance.on('error', (error) => console.error('[vm-data]', error.message));
instance.on('state', (state) => console.log('[vm-data]', state.state));
async function run() {
  try {
    await instance.start();
    const io = new VmFs({ vmService: service });
    fs.writeFileSync(path.join(host, 'source.txt'), 'host first');
    const sync = service.workspacePair(host, '/workspace');
    assert.equal((await sync.sync()).ok, true);
    await io.writeBuffer('/workspace/source.txt', Buffer.from('虚拟机修改'));
    let result = await sync.sync();
    assert.equal(result.ok, true);
    assert.equal(result.conflicts.length, 0);
    assert.equal(fs.readFileSync(path.join(host, 'source.txt'), 'utf8'), '虚拟机修改');
    fs.writeFileSync(path.join(host, 'source.txt'), 'host next');
    result = await sync.sync();
    assert.equal(result.ok, true);
    assert.equal(result.conflicts.length, 0);
    assert.equal((await io.readBuffer('/workspace/source.txt')).toString(), 'host next');
    const folder = path.join(host, '中文 folder');
    fs.mkdirSync(path.join(folder, 'empty'), { recursive: true });
    const binary = Buffer.from(Array.from({ length: 128000 }, (_, i) => i % 256));
    fs.writeFileSync(path.join(folder, 'binary'), binary);
    await io.exec('mkdir -p /workspace/transfer');
    const manager = new VmFileManager(service);
    assert.equal(
      (
        await manager.transfer({
          from: 'host',
          paths: [folder],
          destination: '/workspace/transfer',
        })
      ).files,
      1,
    );
    assert.equal(
      (
        await manager.transfer({
          from: 'vm',
          paths: ['/workspace/transfer/中文 folder'],
          destination: download,
        })
      ).files,
      1,
    );
    assert.deepEqual(fs.readFileSync(path.join(download, '中文 folder/binary')), binary);
    assert.ok(fs.statSync(path.join(download, '中文 folder/empty')).isDirectory());
    fs.writeFileSync(path.join(folder, 'source.js'), 'before');
    const mounted = await service.mountExternalDir(folder);
    assert.equal(mounted.ok, true, mounted.error);
    await io.writeBuffer(mounted.vmRoot + '/source.js', Buffer.from('guest external edit'));
    assert.equal((await service.pullExternalDir(mounted.vmRoot)).ok, true);
    assert.equal(fs.readFileSync(path.join(folder, 'source.js'), 'utf8'), 'guest external edit');
    const web = new WebResearch({
      getSettings: () => settings,
      vmService: service,
      vmActive: () => true,
    });
    for (const engine of ['exa', 'parallel', 'tinyfish']) {
      const search = await web.search({
        engine,
        query: 'OpenCode official repository',
        numResults: 3,
      });
      assert.equal(search.ok, true, JSON.stringify(search.errors));
      assert.equal(search.location, 'vm');
      console.log('[vm-data] search', engine, search.results.length);
    }
    const read = await web.read({ url: 'https://example.com', maxChars: 50 });
    assert.equal(read.ok, true);
    assert.equal(read.location, 'vm');
    assert.ok(web.page(read.ref, { maxChars: 0 }).content.includes('Example Domain'));
    console.log(
      JSON.stringify({
        ok: true,
        profile,
        checks: [
          'real SSH bidirectional hash sync',
          'no clock-drift conflicts',
          'binary SFTP roundtrip',
          'empty folder transfer',
          'external mirror',
          'keyless search from VM',
          'VM fetch paging',
        ],
      }),
    );
  } finally {
    if (service._syncTimer) clearInterval(service._syncTimer);
    await instance.stop();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
