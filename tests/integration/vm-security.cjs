/* SPDX-License-Identifier: GPL-3.0-or-later */
// Real QEMU/Linux, isolated overlay; never modifies a user's running VM/disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { updateGuestTrust } = require('../../src/main/vm/vm-security');
const images = require('../../src/main/vm/vm-images');

async function main() {
  const [assetsDir, variant = 'full', version] = process.argv.slice(2);
  assert.ok(assetsDir, 'Usage: node vm-security.cjs <assetsDir> [variant] [version]');
  const installed = images.localStatus(assetsDir, { variant });
  const selected = version
    ? installed.versions.find((row) => row.version === version && row.ok)
    : installed.selected;
  assert.ok(selected, 'Installed immutable base image required');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-security-test-'));
  const instance = new VmInstance({
    assetsDir,
    imagePath: selected.image,
    kernelPath: selected.kernel,
    initrdPath: selected.initrd,
    version: selected.version,
    variant,
    config: { memMB: 2048, smp: 2, tcg: true, quickResume: false, bootTimeoutMs: 240000 },
  });
  instance.dir = path.join(profile, 'instance');
  instance.overlayPath = path.join(instance.dir, 'overlay.qcow2');
  instance.instanceFile = path.join(instance.dir, 'instance.json');
  instance.on('error', (error) => console.error(error.message));
  instance.on('state', (status) => console.log(status.state, status.detail));
  const exec = async (command) => {
    const r = await instance.exec(command);
    assert.equal(r.ok, true, r.stderr);
    return r.stdout.trim();
  };
  try {
    await instance.start();
    assert.equal(instance.security.distrusted, true);
    assert.equal(
      instance.security.updated,
      true,
      'Online package refresh must reach the security baseline',
    );
    console.log('TRUST', JSON.stringify(instance.security));
    assert.equal(await exec('systemctl is-enabled apt-daily-upgrade.timer'), 'enabled');
    assert.equal(await exec('systemctl is-active apt-daily-upgrade.timer'), 'active');
    console.log(
      'GUEST',
      await exec('node --version; dpkg-query -W ca-certificates nodejs openssl; uname -r'),
    );
    // Add the real public compromised root as a locally managed certificate.
    // A custom trust anchor that survives the package update must fail closed.
    const pem = fs.readFileSync(
      path.join(__dirname, '../fixtures/security/emsign-ecc-g3.pem'),
      'utf8',
    );
    assert.equal(
      new X509Certificate(pem).fingerprint256.replaceAll(':', ''),
      '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B',
    );
    if (pem) {
      await exec(
        "printf '%s' '" +
          Buffer.from(pem).toString('base64') +
          "' | base64 -d | sudo tee /usr/local/share/ca-certificates/cibyp-test-compromised.crt >/dev/null; sudo update-ca-certificates >/dev/null",
      );
      await assert.rejects(updateGuestTrust(instance.ssh), /still contains a distrusted CA/);
      await exec('sudo rm /usr/local/share/ca-certificates/cibyp-test-compromised.crt');
      assert.equal((await updateGuestTrust(instance.ssh)).updated, true);
      console.log('PASS: custom compromised trust anchor rejected');
    }
    console.log('PASS: real VM certificate migration and signed package upgrade');
  } finally {
    await instance.stop({ force: true });
    console.log('Disposable profile:', profile);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
