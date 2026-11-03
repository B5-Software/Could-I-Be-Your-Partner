/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { verify } = require('../../scripts/check-tarot-art.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-tarot-art-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cibyp-tarot-art-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, bytes) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  const cards = Array.from({ length: 78 }, (_, id) => ({ name: '牌' + id, nameEn: 'Card ' + id }));
  write('src/data/tarot.js', 'module.exports=' + JSON.stringify(cards));
  const archive = Buffer.alloc(0x1e0000, 0xff);
  archive.fill(0, 0, 4096);
  archive.write('CIBYPTA1');
  archive.writeUInt32LE(78, 8);
  archive.writeUInt32LE(4096, 12);
  const images = cards.map((card, id) => {
    const bytes = Buffer.alloc(32, id);
    bytes.write('RIFF');
    bytes.write('WEBP', 8);
    const digest = hash(bytes),
      file = String(id).padStart(2, '0') + '.webp';
    write('src/renderer/assets/tarot/' + file, bytes);
    write('IoT-Firmware/CIBYP-TRNG/web/cards/' + file, bytes);
    const pos = 64 + id * 48,
      offset = 4096 + id * 32;
    archive.writeUInt16LE(id, pos);
    archive.writeUInt16LE(224, pos + 2);
    archive.writeUInt16LE(336, pos + 4);
    archive.writeUInt16LE(1, pos + 6);
    archive.writeUInt32LE(offset, pos + 8);
    archive.writeUInt32LE(bytes.length, pos + 12);
    Buffer.from(digest, 'hex').copy(archive, pos + 16);
    bytes.copy(archive, offset);
    return {
      id,
      ...card,
      file,
      sourceSha256: hash('source-' + id),
      desktop: { bytes: bytes.length, sha256: digest },
      firmware: { bytes: bytes.length, sha256: digest },
    };
  });
  Buffer.from(hash(archive.subarray(64, 64 + 78 * 48)), 'hex').copy(archive, 16);
  const manifest = {
    version: 1,
    complete: true,
    deckId: 'test-deck',
    images,
    archive: { sha256: hash(archive), usedBytes: 4096 + 78 * 32 },
  };
  const save = () => {
    write('artwork/tarot/manifest.json', JSON.stringify(manifest));
    write('assets/trng-firmware/tarot-art.bin', archive);
    write(
      'IoT-Firmware/CIBYP-TRNG/main/tarot_art_digest.h',
      '{' +
        Array.from(
          Buffer.from(manifest.archive.sha256, 'hex'),
          (v) => '0x' + v.toString(16).padStart(2, '0'),
        ).join(',') +
        '}',
    );
  };
  write(
    'IoT-Firmware/CIBYP-TRNG/web/deck.json',
    JSON.stringify({
      complete: true,
      deckId: manifest.deckId,
      images: images.map(({ id, file, firmware }) => ({ id, file, sha256: firmware.sha256 })),
    }),
  );
  save();
  return { root, manifest, archive, write, save };
}
test('complete artwork verifies; partial and duplicated decks are rejected', (t) => {
  const f = fixture(t);
  assert.equal(verify(f.root).images, 78);
  f.manifest.complete = false;
  f.save();
  assert.throws(() => verify(f.root), /TAROT_ART_INCOMPLETE/);
  f.manifest.complete = true;
  f.manifest.images[1].sourceSha256 = f.manifest.images[0].sourceSha256;
  f.save();
  assert.throws(() => verify(f.root), /TAROT_DUPLICATE_ARTWORK/);
});
test('corrupted image and stale signed-app digest are rejected', (t) => {
  const f = fixture(t);
  f.write('IoT-Firmware/CIBYP-TRNG/web/cards/00.webp', Buffer.alloc(32));
  assert.throws(() => verify(f.root), /TAROT_CARD_HASH_MISMATCH/);
  f.write('IoT-Firmware/CIBYP-TRNG/main/tarot_art_digest.h', 'stale');
  assert.throws(() => verify(f.root), /TAROT_FIRMWARE_DIGEST_STALE/);
});
test('overlapping archive entries are rejected even if outer hashes are updated', (t) => {
  const f = fixture(t);
  f.archive.writeUInt32LE(4096, 64 + 48 + 8);
  Buffer.from(hash(f.archive.subarray(64, 64 + 78 * 48)), 'hex').copy(f.archive, 16);
  f.manifest.archive.sha256 = hash(f.archive);
  f.save();
  assert.throws(() => verify(f.root), /TAROT_CARD_ARCHIVE_MISMATCH/);
});
