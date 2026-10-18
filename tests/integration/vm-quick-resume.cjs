/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real QEMU, isolated writable profile; only installed read-only assets are borrowed.
const { app, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const images = require('../../src/main/vm/vm-images');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-resume-test-'));
app.setPath('userData', root);

app
  .whenReady()
  .then(async () => {
    const assetsDir = process.argv[2];
    const variant = process.argv[3] || 'full';
    const installed = images.localStatus(assetsDir, { variant });
    const selected = process.argv[4]
      ? installed.versions.find((row) => row.version === process.argv[4] && row.ok)
      : installed.selected;
    assert.ok(selected, 'Pass an installed VM assets directory');
    let instance;
    const make = () => {
      const vm = new VmInstance({
        assetsDir,
        imagePath: selected.image,
        kernelPath: selected.kernel,
        initrdPath: selected.initrd,
        appPath: path.resolve(__dirname, '../..'),
        variant,
        version: selected.version,
        safeStorage,
        config: { smp: 2, memMB: 2048, tcg: true, bootTimeoutMs: 300000 },
      });
      vm.dir = path.join(root, 'instance');
      vm.overlayPath = path.join(vm.dir, 'overlay.qcow2');
      vm.instanceFile = path.join(vm.dir, 'instance.json');
      vm.on('error', (error) => console.error('[vm-resume]', error.message));
      vm.on('state', (state) => console.log(state.state, state.detail));
      vm.on('serial', (text) => {
        if (String(text).startsWith('[host]')) console.log(text);
      });
      return vm;
    };
    const read = async (command) => {
      const result = await instance.exec(command);
      assert.equal(result.ok, true, result.stderr);
      return result.stdout.trim();
    };
    try {
      instance = make();
      const cold = Date.now();
      await instance.start();
      const coldMs = Date.now() - cold;
      console.log(
        'Guest hibernation capability:',
        await read(
          'cat /sys/power/state; cat /sys/power/disk 2>/dev/null; uname -r; findmnt -n -o SOURCE,FSTYPE /; command -v filefrag; true',
        ),
      );
      const boot = await read('cat /proc/sys/kernel/random/boot_id');
      await read("printf 'resume-persistent-file' > /workspace/resume-check.txt");
      await read(
        'nohup sleep 3600 </dev/null >/tmp/resume-sleep.log 2>&1 & echo $! > /tmp/resume-pid',
      );
      const pid = await read('cat /tmp/resume-pid');
      const privateKey = instance.sshKey;
      const saved = Date.now();
      await instance.stop();
      const saveMs = Date.now() - saved;
      assert.equal(instance.child, null);
      assert.equal(instance.status().quickResume.saved, true, instance.status().quickResume.detail);
      const manifest = fs.readFileSync(path.join(instance.dir, 'saved-state.json'), 'utf8');
      assert.ok(!manifest.includes(privateKey));

      // A fresh object cannot reuse in-memory keys, clients or process handles.
      instance = make();
      const warm = Date.now();
      await instance.start();
      const resumeMs = Date.now() - warm;
      assert.equal(
        instance.status().quickResume.restored,
        true,
        instance.status().quickResume.detail,
      );
      assert.equal(await read('cat /proc/sys/kernel/random/boot_id'), boot);
      assert.equal(await read('cat /workspace/resume-check.txt'), 'resume-persistent-file');
      await read(`kill -0 ${pid}`);
      assert.equal(
        instance.status().quickResume.saved,
        false,
        'Consumed state must never be replayed',
      );
      console.log(
        JSON.stringify({ coldMs, saveMs, resumeMs, accelerator: instance.status().accel }),
      );

      // Save once more, then invalidate the RAM state: disk data must survive fallback.
      await instance.stop();
      const savedFile = path.join(instance.dir, 'saved-state.json');
      const invalid = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
      invalid.signature = 'invalid';
      fs.writeFileSync(savedFile, JSON.stringify(invalid));
      instance = make();
      await instance.start();
      assert.equal(instance.status().quickResume.restored, false);
      assert.notEqual(await read('cat /proc/sys/kernel/random/boot_id'), boot);
      assert.equal(await read('cat /workspace/resume-check.txt'), 'resume-persistent-file');
      instance.config.quickResume = false;
      await instance.stop();
      assert.equal(fs.existsSync(savedFile), false);
      console.log(
        'PASS real QEMU save, fresh-instance resume, live process preservation, invalid-state fallback and disabled shutdown',
      );
    } finally {
      await instance?.stop({ force: true });
      if (
        path.dirname(root) === path.resolve(os.tmpdir()) &&
        path.basename(root).startsWith('cibyp-resume-test-')
      )
        fs.rmSync(root, { recursive: true, force: true });
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
