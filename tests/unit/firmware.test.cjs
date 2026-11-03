/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { createHash } = require('node:crypto');
const { FirmwareService, readImage, checkSecurity } = require('../../src/main/services/firmware');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-firmware-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-firmware-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(directory, 'esp32c6-usb'));
  const image = {
    id: 'esp32c6-usb',
    chip: 'esp32c6',
    profile: 'development',
    walletEntropy: false,
    segments: [0, 0x10000, 0x20000].map((address, index) => {
      const data = Buffer.alloc(64, index);
      if (index !== 1) {
        data[0] = 0xe9;
        data.writeUInt16LE(13, 12);
      }
      const file = 'esp32c6-usb/' + index + '.bin';
      fs.writeFileSync(path.join(directory, file), data);
      return {
        file,
        address,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
    }),
  };
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify({ version: 1, protocol: 2, firmwareVersion: '2.0.0', images: [image] }),
  );
  const state = {
    flags: 0,
    mac: '01:02:03:04:05:06',
    writes: 0,
    stubs: 0,
    connections: 0,
    closed: 0,
  };
  const service = new FirmwareService({
    directory,
    ports: async () => [
      { path: 'USB-test', vendorId: '303a', productId: '1001' },
      { path: 'COM1' },
    ],
    loaderFactory: async () => {
      state.connections++;
      return {
        close: async () => state.closed++,
        loader: {
          chip: { CHIP_NAME: 'ESP32-C6', readMac: async () => state.mac },
          detectChip: async () => {},
          getSecurityInfo: async () => ({ flags: state.flags, flashCryptCnt: 0 }),
          after: async () => {},
          runStub: async () => state.stubs++,
          detectFlashSize: async () => '4MB',
          flashSizeBytes: () => 4194304,
          writeFlash: async (options) => {
            assert.equal(options.eraseAll, false);
            assert.equal(options.fileArray.length, 3);
            assert.equal(typeof options.calculateMD5Hash, 'function');
            state.writes++;
            options.reportProgress(0, 32, 64);
            await sleep(2);
            options.reportProgress(2, 64, 64);
          },
        },
      };
    },
  });
  t.after(() => service.dispose());
  return { directory, image, state, service };
}
async function finished(service) {
  for (let i = 0; i < 100; i++) {
    const job = service.status();
    if (['failed', 'completed'].includes(job?.stage)) return job;
    await sleep(5);
  }
  throw Error('fixture did not finish');
}
test('firmware verifies each bundled byte and rejects wrong-chip and overlapping images before opening a device', (t) => {
  const f = fixture(t);
  assert.equal(readImage(f.directory, f.image).length, 3);
  const target = path.join(f.directory, f.image.segments[0].file);
  const wrong = structuredClone(f.image);
  wrong.chip = 'esp32c3';
  assert.throws(() => readImage(f.directory, wrong), /CHIP_MISMATCH/);
  const overlap = structuredClone(f.image);
  overlap.segments[1].address = 32;
  assert.throws(() => readImage(f.directory, overlap), /MANIFEST/);
  fs.appendFileSync(target, 'tamper');
  assert.throws(() => readImage(f.directory, f.image), /FIRMWARE_HASH_MISMATCH/);
  assert.equal(f.state.connections, 0);
  const image = structuredClone(f.image);
  image.segments[0].address = -1;
  assert.throws(() => readImage(f.directory, image), /MANIFEST/);
  image.segments[0].address = 0;
  image.segments[0].file = '../key';
  assert.throws(() => readImage(f.directory, image), /MANIFEST/);
});
test('protected, encrypted and unknown-security devices cannot be forced through ordinary flashing', async (t) => {
  const f = fixture(t);
  for (const value of [
    null,
    {},
    { flags: 1, flashCryptCnt: 0 },
    { flags: 4, flashCryptCnt: 0 },
    { flags: 0, flashCryptCnt: 2 },
  ])
    assert.throws(() => checkSecurity(value));
  f.state.flags = 1;
  await assert.rejects(f.service.inspect('USB-test'), /PROTECTED/);
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.stubs, 0);
  assert.equal(f.state.closed, 1);
});
test('inspection is read-only; flash confirmation is single-use and identity is rechecked before a write', async (t) => {
  const f = fixture(t),
    ticket = await f.service.inspect('USB-test');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.stubs, 0);
  f.state.mac = 'changed';
  await f.service.flash({ token: ticket.token, confirmed: true });
  assert.equal((await finished(f.service)).error, 'FIRMWARE_DEVICE_CHANGED');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.stubs, 0);
  await assert.rejects(f.service.flash({ token: ticket.token, confirmed: true }), /CONFIRMATION/);
});
test('a device becoming protected after confirmation is never written', async (t) => {
  const f = fixture(t),
    ticket = await f.service.inspect('USB-test');
  f.state.flags = 4;
  await f.service.flash({ token: ticket.token, confirmed: true });
  assert.equal((await finished(f.service)).error, 'FIRMWARE_PROTECTED_DEVICE');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.stubs, 0);
});
test('bundled update uses verified segments, readback hashing, no erase-all and reports completion independently of UI lifetime', async (t) => {
  const f = fixture(t);
  assert.equal((await f.service.request('list')).ports.length, 1);
  await assert.rejects(f.service.inspect('COM1'), /PORT_NOT_FOUND/);
  const ticket = await f.service.inspect('USB-test');
  const job = await f.service.flash({ token: ticket.token, confirmed: true });
  assert.equal(typeof job.id, 'string');
  const result = await finished(f.service);
  assert.equal(result.stage, 'completed');
  assert.equal(result.progress, 100);
  assert.equal(result.verified, true);
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.closed, 2);
});
test('tampering after inspection is caught before reconnecting or sending a flash command', async (t) => {
  const f = fixture(t),
    ticket = await f.service.inspect('USB-test');
  fs.appendFileSync(path.join(f.directory, f.image.segments[2].file), 'x');
  await assert.rejects(f.service.flash({ token: ticket.token, confirmed: true }), /HASH/);
  assert.equal(f.state.connections, 1);
  assert.equal(f.state.writes, 0);
});
test('source export contains only allowlisted Rust/IDF files, not caches, signing keys or Arduino sources', async () => {
  const service = new FirmwareService({ ports: async () => [] });
  try {
    const archive = await service.request('sources'),
      zip = new (require('adm-zip'))(Buffer.from(archive.base64, 'base64'));
    const names = zip.getEntries().map((entry) => entry.entryName);
    assert.ok(names.includes('CIBYP-TRNG/rust/core/src/lib.rs'));
    assert.ok(names.every((name) => !/(target|\.ino|\.pem|\.key)(?:\/|$)/.test(name)));
  } finally {
    service.dispose();
  }
});
