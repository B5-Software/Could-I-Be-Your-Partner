/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { ensureArchive, ensureBundle } = require('../../scripts/lib/geogebra-bundle.cjs');

function fixture(t, incomplete = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-geogebra-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const zip = new AdmZip();
  zip.addFile('GeoGebra/deployggb.js', Buffer.from('matching loader'));
  zip.addFile('README.txt', Buffer.from('upstream license'));
  if (!incomplete) zip.addFile('GeoGebra/HTML5/5.0/web3d/web3d.nocache.js', Buffer.from('runtime'));
  const bytes = zip.toBuffer();
  return {
    archive: path.join(directory, 'bundle.zip'),
    assets: path.join(directory, 'assets'),
    manifest: {
      version: 'test',
      url: 'https://example.invalid/bundle.zip',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
    download: (_url, filename) => fs.writeFileSync(filename, bytes),
  };
}

test('GeoGebra reuses only hash-verified archives and repairs corrupt cached downloads', (t) => {
  const options = fixture(t);
  fs.writeFileSync(options.archive, 'corrupt download');
  ensureArchive(options);
  const cached = fs.readFileSync(options.archive);
  ensureArchive({ ...options, download: () => assert.fail('Valid cache should work offline') });
  assert.deepEqual(fs.readFileSync(options.archive), cached);
  assert.equal(fs.existsSync(`${options.archive}.${process.pid}.part`), false);
});

test('GeoGebra rejects a download with the wrong digest before installing any files', (t) => {
  const options = fixture(t);
  assert.throws(
    () =>
      ensureBundle({ ...options, download: (_url, file) => fs.writeFileSync(file, 'untrusted') }),
    /SHA-256 mismatch/,
  );
  assert.equal(fs.existsSync(options.assets), false);
  assert.equal(fs.existsSync(options.archive), false);
  assert.equal(fs.existsSync(`${options.archive}.${process.pid}.part`), false);
});

test('GeoGebra restores incomplete extracted caches and keeps the loader paired with its runtime', (t) => {
  const options = fixture(t);
  const installed = ensureBundle(options);
  fs.unlinkSync(path.join(installed, 'GeoGebra/HTML5/5.0/web3d/web3d.nocache.js'));
  ensureBundle({ ...options, download: () => assert.fail('Verified archive should work offline') });
  assert.equal(
    fs.readFileSync(path.join(installed, 'GeoGebra/HTML5/5.0/web3d/web3d.nocache.js'), 'utf8'),
    'runtime',
  );
  assert.equal(
    fs.readFileSync(path.join(options.assets, 'geogebra/deployggb.js'), 'utf8'),
    'matching loader',
  );
  assert.match(fs.readFileSync(path.join(installed, 'README.txt'), 'utf8'), /license/);
});

test('GeoGebra rejects incomplete archives without replacing a working installation', (t) => {
  const options = fixture(t, true);
  const previous = path.join(options.assets, 'geogebra-app');
  fs.mkdirSync(previous, { recursive: true });
  fs.writeFileSync(path.join(previous, 'keep.txt'), 'previous installation');
  assert.throws(() => ensureBundle(options), /missing.*web3d/);
  assert.equal(fs.readFileSync(path.join(previous, 'keep.txt'), 'utf8'), 'previous installation');
  assert.deepEqual(fs.readdirSync(options.assets), ['geogebra-app']);
});
