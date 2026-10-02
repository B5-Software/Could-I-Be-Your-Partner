/* Actual Electron workbench + SSH + QEMU guest, using only a temporary disk. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { VmService } = require('../../src/main/vm/vm-service');
const { VmFs } = require('../../src/main/vm/vm-fs');
const { CodeOSSService } = require('../../src/main/services/codeoss-service');
const images = require('../../src/main/vm/vm-images');
const lock = require('../../integrations/codeoss/runtime-lock.json');
const [assetsDir, version, variant = 'full', fixtureArchive = ''] = process.argv
  .slice(2)
  .filter((value) => !value.startsWith('--runtime='));
if (!assetsDir || !version)
  throw new Error(
    'Usage: electron codeoss-vm.cjs <assetsDir> <version> [variant] [test-only-backend-tar]',
  );
const selected = images
  .localStatus(assetsDir, { variant })
  .versions.find((row) => row.ok && row.version === version);
assert(selected, 'Use an already installed read-only OS image');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-codeoss-vm-'));
app.setPath('userData', profile);
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
const settings = {
  runtime: { location: 'vm', workspaceMode: 'isolated', vm: { assetsDir, variant } },
  theme: { mode: 'dark', accentColor: '#bf83ed', backgroundColor: '#202536' },
};
const vm = new VmService({
  app: { getPath: () => profile, getAppPath: () => instance.opts.appPath },
  getSettings: () => settings,
});
vm.instance = instance;
instance.on('error', (error) => console.error('[codeoss-vm]', error.message));
instance.on('state', (state) => console.log('[codeoss-vm]', state.state, state.detail || ''));
let win;
const service = new CodeOSSService({
  getMainWindow: () => win,
  getSettings: () => settings,
  getVmService: () => vm,
  dataDirectory: profile,
});
const testRuntime = process.argv.find((value) => value.startsWith('--runtime='));
if (testRuntime) service.runtime = path.resolve(testRuntime.slice('--runtime='.length));
const handleRequest = service.handleExtensionRequest.bind(service);
service.handleExtensionRequest = async (peer, request) =>
  request.method === 'agent.sessions'
    ? { sessions: [], messages: [], running: false }
    : handleRequest(peer, request);
fs.mkdirSync(path.join(service.profile, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(service.profile, 'User/settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': false,
    'window.titleBarStyle': 'custom',
    'window.menuBarVisibility': 'compact',
  }),
);
let finished;
const timer = setTimeout(() => finish(new Error('VM workbench test timeout')), 480000);

async function waitFor(check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('VM condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

app.whenReady().then(async () => {
  try {
    await instance.start();
    const io = new VmFs({ vmService: vm });
    const hostImport = path.join(profile, 'host-project');
    fs.mkdirSync(path.join(hostImport, '.git'), { recursive: true });
    fs.writeFileSync(path.join(hostImport, '.git/HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(hostImport, 'source.js'), 'const fromHost = true;\n');
    const imported = await vm.mountExternalDir(hostImport, { preserveGit: true });
    assert.equal(imported.ok, true, imported.error);
    assert.equal(
      (await io.readBuffer(imported.vmRoot + '/.git/HEAD')).toString(),
      'ref: refs/heads/main\n',
    );
    await io.writeBuffer(
      imported.vmRoot + '/source.js',
      Buffer.from('const editedInGuest = true;\n'),
    );
    vm._externMounts.clear(); // A restarted App must reuse the guest copy.
    const restored = await vm.mountExternalDir(hostImport, { preserveGit: true });
    assert.equal(restored.reused, true);
    assert.equal(
      (await io.readBuffer(restored.vmRoot + '/source.js')).toString(),
      'const editedInGuest = true;\n',
    );
    console.log(
      '[codeoss-vm] PASS Git import and preservation of guest edits across mapping restart',
    );
    if (fixtureArchive) {
      // Explicit integration-test provision of an older image's disposable disk.
      // Production App code never performs this installation.
      assert.equal(
        await require('../../scripts/prepare-codeoss').checksum(fixtureArchive),
        lock.remote['linux-x64'].sha256,
      );
      await io.pushFromHost(path.resolve(fixtureArchive), '/workspace/test-codeoss-runtime.tar.gz');
      await io.pushFromHost(
        path.resolve(__dirname, '../../../cibyp-vm-os/recipes/overlay/codeoss/server.py'),
        '/workspace/test-codeoss-server.py',
      );
      const installed = await instance.exec(
        'sudo mkdir -p /usr/local/lib/cibyp-codeoss/current && sudo tar -xzf /workspace/test-codeoss-runtime.tar.gz -C /usr/local/lib/cibyp-codeoss/current && sudo install -m 755 /workspace/test-codeoss-server.py /usr/local/bin/cibyp-codeoss-server',
        { timeoutMs: 180000 },
      );
      assert.equal(installed.ok, true, installed.stderr);
    }
    const extensionDirectory = `/home/cibyp/.local/state/cibyp/codeoss/${lock.commit}/data/extensions/cibyp-test.integration-fixture-1.0.0`;
    for (const file of ['package.json', 'extension.cjs'])
      await io.pushFromHost(
        path.resolve(__dirname, '../fixtures/codeoss', file),
        extensionDirectory + '/' + file,
      );
    assert.equal(
      (
        await instance.exec(
          "mkdir -p /workspace/codeoss-smoke; cd /workspace/codeoss-smoke; git init -q; touch .cibyp-codeoss-test; printf 'console.log(1);\\n' > sample.js",
        )
      ).ok,
      true,
    );
    win = new BrowserWindow({
      width: 1200,
      height: 820,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    win.setOpacity(0);
    win.setSkipTaskbar(true);
    await win.loadURL('data:text/html,<title>CIBYP remote integration</title>');
    win.show();
    service.setLayout({ visible: true, bounds: { x: 0, y: 0, width: 1200, height: 780 } });
    assert.equal((await service.open('/workspace/codeoss-smoke')).ok, true);
    await waitFor(() => service.activePeer());
    assert.equal(service.target.location, 'vm');
    await waitFor(
      async () =>
        (await instance.exec('test -f /workspace/codeoss-smoke/fixture-result.json')).code === 0,
    );
    const result = JSON.parse(
      (await instance.exec('cat /workspace/codeoss-smoke/fixture-result.json')).stdout,
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.platform, 'linux');
    assert.equal(fs.existsSync('/workspace/codeoss-smoke/terminal-result.txt'), false);
    console.log('[codeoss-vm] PASS real remote workspace', result.passed);
    await service.request('ide.language', {
      action: 'command',
      command: 'cibypFixture.terminal',
      arguments: ['close'],
    });
    await service.request('ide.command', { command: 'workbench.action.terminal.toggleTerminal' });
    const terminal = await service.request('ide.language', {
      action: 'command',
      command: 'cibypFixture.terminal',
      arguments: ['probe'],
    });
    assert.equal(terminal.result.platform, 'linux', JSON.stringify(terminal));
    console.log('[codeoss-vm] PASS toolbar terminal executes in guest workspace');
    const completion = await service.request('ide.language', {
      action: 'completion',
      path: 'sample.js',
      line: 1,
      column: 1,
      query: 'cibypFixture',
    });
    assert(JSON.stringify(completion).includes('cibypFixtureCompletion'));
    console.log('[codeoss-vm] PASS language providers execute in installed remote extensions');
    const read = await service.request('ide.readDocument', {
      path: '/workspace/codeoss-smoke/sample.js',
      location: 'vm',
    });
    assert.equal(read.result.ok, true);
    const write = await service.request('ide.writeDocument', {
      path: '/workspace/codeoss-smoke/ai-vm.js',
      location: 'vm',
      content: 'const insideVM = true;\n',
    });
    assert.equal(write.result.ok, true, JSON.stringify(write));
    assert.equal(
      (await instance.exec('cat /workspace/codeoss-smoke/ai-vm.js')).stdout.trim(),
      'const insideVM = true;',
    );
    console.log('[codeoss-vm] PASS editor-aware AI read/write operate on guest files');
    const changes = await service.request('ide.changes', {});
    const checkpoint = changes.changes.find(
      (item) => item.path === '/workspace/codeoss-smoke/ai-vm.js',
    );
    assert(checkpoint, 'Guest edit must be available for review in the host AI sidebar');
    await service.request('ide.changes', { action: 'open', id: checkpoint.id });
    await service.request('ide.changes', { action: 'revert', id: checkpoint.id });
    assert.equal((await instance.exec('test -e /workspace/codeoss-smoke/ai-vm.js')).code, 1);
    assert.equal((await service.request('ide.changes', {})).changes.length, 0);
    console.log('[codeoss-vm] PASS host AI sidebar bridge reviews/reverts guest checkpoints');
    await io.writeBuffer(imported.vmRoot + '/sample.js', Buffer.from('console.log(1);\n'));
    await io.writeBuffer(imported.vmRoot + '/.cibyp-codeoss-test', Buffer.from('fixture'));
    await instance.exec(`cd '${imported.vmRoot}' && git init -q`);
    assert.equal((await service.open(imported.vmRoot)).ok, true);
    await waitFor(() => service.activePeer());
    await waitFor(
      async () =>
        (await instance.exec(`test -f '${imported.vmRoot}/fixture-result.json'`)).code === 0,
    );
    await service.request('ide.language', {
      action: 'command',
      command: 'cibypFixture.terminal',
      arguments: ['close'],
    });
    await service.request('ide.command', { command: 'workbench.action.terminal.toggleTerminal' });
    const reopened = await service.request('ide.language', {
      action: 'command',
      command: 'cibypFixture.terminal',
      arguments: ['probe'],
    });
    assert.equal(reopened.result.platform, 'linux');
    await service.request('ide.command', { command: 'workbench.action.terminal.toggleTerminal' });
    assert.equal(
      (await instance.exec(`cat '${imported.vmRoot}/toolbar-terminal.txt'`)).stdout,
      'linux',
    );
    console.log(
      '[codeoss-vm] PASS toolbar terminal opens/reuses the imported guest workspace after switching',
    );
    await finish();
  } catch (error) {
    await finish(error);
  }
});

async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error) console.error('[codeoss-vm]', error);
  service.dispose();
  await instance.stop({ timeoutMs: 10000 }).catch(() => {});
  if (error) app.exit(1);
  else app.quit();
}
