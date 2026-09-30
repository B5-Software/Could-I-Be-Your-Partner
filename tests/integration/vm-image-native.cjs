/* Explicit native QEMU check. Uses a temporary writable disk and profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { VmService } = require('../../src/main/vm/vm-service');
const images = require('../../src/main/vm/vm-images');
const runtime = require('../../src/main/vm/qemu-runtime');

async function main() {
  const [assetsDir, version, variant = 'desktop', desktop = '', screenshotDir = ''] =
    process.argv.slice(2);
  if (!assetsDir || !version)
    throw new Error('Usage: node vm-image-native.cjs <assetsDir> <version> [variant] [desktop]');
  const selected = images
    .localStatus(assetsDir, { variant })
    .versions.find((row) => row.ok && row.version === version);
  assert.ok(selected, 'Requested image must already be installed');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-image-native-'));
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
  // Borrow read-only image/runtime files; every writable path is in this profile.
  instance.dir = path.join(temporary, 'instance');
  instance.overlayPath = path.join(instance.dir, 'overlay.qcow2');
  instance.instanceFile = path.join(instance.dir, 'instance.json');
  const settings = {
    runtime: { location: 'vm', workspaceMode: 'isolated', vm: { variant, assetsDir } },
    theme: { mode: 'dark', accentColor: '#bf83ed', backgroundColor: '#202536' },
  };
  const vm = new VmService({
    app: { getPath: () => temporary, getAppPath: () => instance.opts.appPath },
    getSettings: () => settings,
  });
  vm.instance = instance;
  instance.on('error', (error) => console.error('[VM]', error.message));
  instance.on('state', (state) => console.log(state.state, state.detail || ''));
  try {
    await instance.start();
    const brand = await instance.exec('. /etc/os-release; printf "%s" "$VERSION_ID"');
    assert.equal(brand.stdout, version, 'Guest system branding must match the installed image');
    if (desktop !== 'boundaries') {
      const firstIdentity = instance.ciServer.instanceId;
      const write = await instance.exec(
        "printf 'persistent campus data' > /workspace/campus-restart-check.txt",
      );
      assert.equal(write.ok, true, write.stderr);
      await instance.stop();
      const assets = await instance.ensureAssets();
      const before = fs.readFileSync(instance.overlayPath);
      assert.equal(
        runtime.createOverlay(assets.qemu.img, selected.image, instance.overlayPath),
        instance.overlayPath,
      );
      assert.deepEqual(fs.readFileSync(instance.overlayPath), before);
      assert.throws(
        () =>
          runtime.createOverlay(
            assets.qemu.img,
            selected.image + '.different',
            instance.overlayPath,
          ),
        /已保留原磁盘/,
      );
      assert.deepEqual(fs.readFileSync(instance.overlayPath), before);
      await instance.start();
      assert.notEqual(instance.ciServer.instanceId, firstIdentity);
      const persisted = await instance.exec('cat /workspace/campus-restart-check.txt');
      assert.equal(persisted.ok, true, persisted.stderr);
      assert.equal(persisted.stdout, 'persistent campus data');
      console.log(
        'PASS real QEMU restart, rotated in-memory SSH key, persistent disk and mismatched-image preservation',
      );
    }
    if (desktop === 'tools') {
      const { createRoutedHandler } = require('../../src/main/vm/vm-tools');
      const call = async (channel, ...args) => {
        const handler = createRoutedHandler(
          channel,
          () => {
            throw new Error('HOST TOOL MUST NOT RUN');
          },
          { getVmService: () => vm, isLocationVm: () => true },
        );
        const result = await handler(null, ...args);
        assert.notEqual(result.ok, false, `${channel}: ${result.error}`);
        console.log('PASS guest tool', channel);
        return result;
      };
      await call('fs:writeFile', '/workspace/guest-only.txt', 'guest content');
      const doc = await call(
        'word:create',
        {
          title: 'Guest document',
          fileName: 'guest.docx',
          blocks: [{ type: 'paragraph', text: 'Created entirely in the VM' }],
        },
        '/workspace',
      );
      await call('word:getMetadata', doc.path);
      const text = await call('word:extractText', doc.path, 'text');
      assert.ok(text.content.includes('Created entirely in the VM'));
      const unpacked = await call('office:unpack', doc.path);
      await call('office:listContents', unpacked.dir || unpacked.path);
      await call('qr:generate', 'VM-only-QR', '/workspace', 'vm-qr.png');
      const qr = await call('qr:scan', '/workspace/vm-qr.png');
      assert.equal(qr.data, 'VM-only-QR');
      await call(
        'ppt:create',
        {
          title: 'Guest slides',
          slides: [{ title: 'Guest', bullets: ['VM'], imagePath: '/workspace/vm-qr.png' }],
        },
        '/workspace',
      );
      await call(
        'spreadsheet:exportFile',
        '/workspace/guest.csv',
        [{ addr: 'A1', value: 'VM' }],
        'Guest',
      );
      await call('spreadsheet:importFile', '/workspace/guest.csv');
      await call('knowledge:importFile', '/workspace/guest-only.txt', '/workspace');
      await call('ffmpeg:available');
      await call('ffmpeg:invoke', 'info', { input: '/workspace/vm-qr.png' }, '/workspace');
      await call('ocr:recognize', '/workspace/vm-qr.png');
    }
    if (desktop === 'boundaries') {
      await require('./vm-tool-boundaries.cjs')(vm, temporary, settings);
    }
    if (desktop === 'desktop') {
      const graphics = await vm.graphicsStart();
      assert.equal(graphics.ok, true, graphics.error);
      assert.equal(graphics.mode, 'wayland');
      await vm.syncAppearance({ force: true });
      const themed = await instance.exec(
        'python3 -c \'import json,pathlib; x=json.loads((pathlib.Path.home()/".config/cibyp/desktop.json").read_text()); assert x["theme"]=="dark" and x["accent_color"]=="#bf83ed" and x["background_color"]=="#202536"\'',
      );
      assert.equal(themed.ok, true, themed.stderr);
      const installed = await instance.exec(
        'test -x /usr/local/lib/cibyp-desktop/session/cibyp-session && command -v cibyp-terminal',
      );
      assert.equal(installed.ok, true, installed.stderr);
      const controller = vm.graphicsController();
      const identity = await instance.exec(`cat '${controller.runtimeDir}/campus-session.pid'`);
      assert.equal(identity.ok, true, identity.stderr);
      if (screenshotDir) {
        fs.mkdirSync(screenshotDir, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const shot = await controller.capture({ filename: 'cibyp-native-dark.png' });
        fs.writeFileSync(
          path.join(screenshotDir, 'preview-native-dark.png'),
          await (await instance.sftp()).readFile(shot.vmPath),
        );
      }
      settings.theme = {
        mode: 'light',
        accentColor: '#65a99b',
        backgroundColor: '#eff8f3',
      };
      await vm.syncAppearance({ force: true });
      const switched = await instance.exec(
        'python3 -c \'import json,pathlib; x=json.loads((pathlib.Path.home()/".config/cibyp/desktop.json").read_text()); assert x["theme"]=="light" and x["accent_color"]=="#65a99b" and x["background_color"]=="#eff8f3"\'',
      );
      assert.equal(switched.ok, true, switched.stderr);
      const unchanged = await instance.exec(`cat '${controller.runtimeDir}/campus-session.pid'`);
      assert.equal(unchanged.stdout, identity.stdout, 'Theme switch must keep the desktop session');
      if (screenshotDir) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const shot = await controller.capture({ filename: 'cibyp-native-light.png' });
        fs.writeFileSync(
          path.join(screenshotDir, 'preview-native-light.png'),
          await (await instance.sftp()).readFile(shot.vmPath),
        );
      }
      console.log(
        'PASS production App connection to image-installed Wayland desktop and live personalization',
      );
    }
  } finally {
    await vm.graphicsStop().catch(() => {});
    await instance.stop({ force: true, timeoutMs: 10000 }).catch(() => {});
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cibyp-image-native-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
