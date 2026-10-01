/* Real SSH, tar synchronization and persistent processes on a temporary QEMU disk. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { VmService } = require('../../src/main/vm/vm-service');
const { WorkspaceSync } = require('../../src/main/vm/vm-workspace');
const { ShellJobs } = require('../../src/main/services/shell-jobs');
const { shellQuote } = require('../../src/main/vm/vm-paths');
const images = require('../../src/main/vm/vm-images');

const [assetsDir, version, variant = 'full'] = process.argv.slice(2);
if (!assetsDir || !version)
  throw new Error('Usage: node vm-workspace-jobs.cjs <installed-assets-dir> <version> [variant]');
const selected = images
  .localStatus(assetsDir, { variant })
  .versions.find((row) => row.ok && row.version === version);
assert(selected, 'Use a locally installed read-only image');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vm-jobs-test-'));
function cleanupFixture() {
  if (!path.resolve(profile).startsWith(path.join(os.tmpdir(), 'cibyp-vm-jobs-test-')))
    throw new Error('Unsafe fixture cleanup path');
  fs.rmSync(profile, { recursive: true, force: true });
}
const hostRoot = path.join(profile, 'workspace');
fs.mkdirSync(hostRoot);
const settings = {
  runtime: {
    location: 'vm',
    workspaceMode: 'shared',
    vm: { workspaceRoot: hostRoot, workspaceMount: '/workspace/cibyp-test', assetsDir, variant },
  },
};
const instance = new VmInstance({
  assetsDir,
  imagePath: selected.image,
  kernelPath: selected.kernel,
  initrdPath: selected.initrd,
  appPath: path.resolve(__dirname, '../..'),
  variant,
  version,
  config: { smp: 2, memMB: 3072, tcg: true, bootTimeoutMs: 300000 },
});
instance.dir = path.join(profile, 'instance');
instance.overlayPath = path.join(instance.dir, 'overlay.qcow2');
instance.instanceFile = path.join(instance.dir, 'instance.json');
instance.on('state', (state) => console.log('[vm-jobs]', state.state, state.detail || ''));
instance.on('error', (error) => console.error('[vm-jobs]', error.message));
const service = new VmService({
  app: { getPath: () => profile, getAppPath: () => instance.opts.appPath },
  getSettings: () => settings,
});
service.instance = instance;
const jobs = new ShellJobs({
  getVmService: () => service,
  isVmOperation: () => true,
  confine: () => {
    throw new Error('VM jobs must never use a host shell');
  },
  isSandboxDenial: () => false,
});

async function run() {
  try {
    await instance.start();
    assert.equal((await instance.exec('mkdir -p /workspace/cibyp-test')).ok, true);
    const sync = new WorkspaceSync({
      vmService: service,
      hostRoot,
      vmMount: '/workspace/cibyp-test',
      instanceDir: path.join(profile, 'baseline'),
    });
    service.sync = sync;
    const hostFile = path.join(hostRoot, 'source.js');
    fs.writeFileSync(hostFile, 'AAAA');
    assert.equal((await sync.sync()).ok, true);
    await instance.exec('touch -t 200001010000 /workspace/cibyp-test/source.js');
    assert.deepEqual((await sync.sync()).conflicts, []);
    for (const content of ['BBBB', 'CCCC', 'DDDD']) {
      await instance.exec(`printf %s ${shellQuote(content)} > /workspace/cibyp-test/source.js`);
      const pushed = await sync.sync({ direction: 'push' });
      assert.equal(pushed.ok, true);
      const pulled = await sync.sync({ direction: 'pull' });
      assert.equal(pulled.ok, true, pulled.error);
      assert.deepEqual(pulled.conflicts, []);
      assert.equal(fs.readFileSync(hostFile, 'utf8'), content);
    }
    console.log(
      '[vm-jobs] real tar: clock drift, fast same-size writes and directional baselines passed',
    );
    const script = `const http=require('node:http');const s=http.createServer((q,r)=>r.end('alive'));s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port));`;
    const command = 'node -e ' + shellQuote(script);
    for (const background of [false, true]) {
      const startedAt = Date.now();
      const started = await jobs.run(
        background ? command + ' & sleep 0.2; echo launcher-finished' : command,
        '/workspace/cibyp-test',
        null,
        { sessionKey: 'fixture', yieldMs: 500 },
      );
      assert.equal(started.ok, true, started.error);
      assert.equal(started.running, true);
      assert.ok(
        Date.now() - startedAt < 30000,
        'persistent command must release the Agent request',
      );
      const poll = (options) =>
        jobs.run(null, null, null, { jobId: started.jobId, sessionKey: 'fixture', ...options });
      let ready = started;
      for (let i = 0; i < 20 && !/PORT=\d+/.test(ready.output); i++)
        ready = await poll({ yieldMs: 500 });
      const match = ready.output.match(/PORT=(\d+)/);
      assert(match, JSON.stringify(ready));
      const port = match[1];
      assert.equal((await instance.exec('curl -sf http://127.0.0.1:' + port)).stdout, 'alive');
      assert.equal((await poll({ yieldMs: 200 })).running, true);
      const stopped = await poll({ action: 'stop' });
      assert.equal(stopped.status, 'stopped', stopped.error);
      assert.equal(
        (await instance.exec('curl -sf --max-time 2 http://127.0.0.1:' + port)).ok,
        false,
      );
      console.log(
        '[vm-jobs] real SSH: ' +
          (background ? 'inherited background process' : 'foreground server') +
          ' yields, remains reachable, and stops with its process group',
      );
    }
    console.log(
      JSON.stringify({
        ok: true,
        sync: 'real guest/tar/hash consensus',
        shell: 'real guest foreground and background services',
      }),
    );
  } finally {
    await jobs.dispose();
    await instance.stop({ timeoutMs: 10000 }).catch(() => {});
    cleanupFixture();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
