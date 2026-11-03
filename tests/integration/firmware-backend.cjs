/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Actual shared backend and packaged bundle. Read-only device enumeration;
// no reset, flash, external network or user-profile access.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-firmware-backend-'));
const entry = process.argv.includes('--bundled')
  ? path.resolve('dist/node-core/core.cjs')
  : require.resolve('../../src/agent/node-host');
let runtime;
(async () => {
  try {
    runtime = await require(entry).createNodeRuntime({
      dataDir: profile,
      workspaceRoot: path.join(profile, 'workspaces'),
      settings: {
        onboardingCompleted: true,
        runtime: { location: 'host' },
        automaticMemory: { enabled: false },
        decision: { enabled: false },
        updates: { autoCheckEnabled: false },
      },
    });
    fs.mkdirSync(path.join(profile, 'workspaces'), { recursive: true });
    const call = (action, input = {}) =>
      runtime.dispatch({ method: 'firmware:request', args: [action, input] });
    const listing = await call('list');
    assert.equal(listing.firmware.images.length, 6);
    assert.equal(listing.firmware.protocol, 2);
    assert.ok(listing.ports.every((port) => port.vendorId && port.productId));
    // Construct the official loader through the actual bundled module graph.
    // No connect/detect command is sent, so this never opens a physical port.
    const sdk = await runtime.runtime.firmwareService.connect({
      path: 'NO-DEVICE-OPEN',
      vendorId: '303a',
      productId: '1001',
    });
    assert.equal(typeof sdk.loader.detectChip, 'function');
    await sdk.close();
    await assert.rejects(call('network', { port: 'NOT-A-REAL-DEVICE' }), /PORT_NOT_FOUND/);
    const archive = await call('sources');
    assert.equal(archive.name, 'CIBYP-TRNG-Rust-IDF.zip');
    const zip = new (require('adm-zip'))(Buffer.from(archive.base64, 'base64'));
    for (const name of ['main/network.c', 'web/index.html', 'web/app.js', 'rust/core/src/lib.rs'])
      assert.ok(zip.getEntry('CIBYP-TRNG/' + name));
    const art = zip.readFile('CIBYP-TRNG/resources/tarot-art.bin');
    assert.equal(art.length, 0x1e0000);
    assert.equal(art.toString('ascii', 0, 8), 'CIBYPTA1');
    assert.equal(art.readUInt32LE(8), 78);
    for (const name of [
      'main/tarot_art_digest.h',
      'web/deck.json',
      'web/question-seed.js',
      'web/question-seed.LICENSE',
    ])
      assert.ok(zip.getEntry('CIBYP-TRNG/' + name));
    assert.equal(await call('status'), null);
    console.log(
      'PASS: ' +
        (process.argv.includes('--bundled') ? 'bundled' : 'source') +
        ' shared firmware backend, read-only USB list and modern firmware source export.',
    );
  } finally {
    await runtime?.close();
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('cibyp-firmware-backend-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
