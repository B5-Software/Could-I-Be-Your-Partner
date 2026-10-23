/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const manifest = require('../../build/geogebra-runtime.json');
const root = path.resolve(__dirname, '../..');

function digest(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function downloadArchive(url, destination) {
  // Bound retries; Windows release builds receive this same verified archive
  // from the Linux preparation job rather than depending on upstream routing.
  const result = spawnSync(
    process.platform === 'win32' ? 'curl.exe' : 'curl',
    [
      '--fail',
      '--location',
      '--connect-timeout',
      '15',
      '--max-time',
      '120',
      '--retry',
      '1',
      '--retry-max-time',
      '180',
      '--output',
      destination,
      url,
    ],
    { stdio: 'inherit', shell: false, timeout: 200_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`GeoGebra download failed: ${result.error?.message || result.status}`);
  }
}

function ensureArchive(options = {}) {
  const lock = options.manifest || manifest;
  const archive = options.archive || path.join(root, '.cache/geogebra', lock.filename);
  const download = options.download || downloadArchive;
  if (fs.existsSync(archive) && digest(archive) === lock.sha256) {
    console.log(`[geogebra] Verified cached archive ${lock.version}`);
    return archive;
  }
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const partial = `${archive}.${process.pid}.part`;
  try {
    download(lock.url, partial);
    if (digest(partial) !== lock.sha256) {
      throw new Error(`GeoGebra SHA-256 mismatch (${lock.version}); refusing to extract`);
    }
    fs.renameSync(partial, archive);
    return archive;
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

function ensureBundle(options = {}) {
  const archive = ensureArchive(options);
  const assets = path.resolve(options.assets || path.join(root, 'assets'));
  const destination = path.resolve(assets, 'geogebra-app');
  // Keep destructive replacement confined to this explicitly designated asset folder.
  if (path.dirname(destination) !== assets) throw new Error('Invalid GeoGebra asset path');
  fs.mkdirSync(assets, { recursive: true });
  const staging = fs.mkdtempSync(path.join(assets, '.geogebra-'));
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(archive);
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replaceAll('\\', '/');
      if (name.startsWith('/') || name.includes(':') || name.split('/').includes('..')) {
        throw new Error(`Unsafe GeoGebra archive entry: ${name}`);
      }
    }
    zip.extractAllTo(staging, true);
    for (const file of [
      'GeoGebra/HTML5/5.0/web3d/web3d.nocache.js',
      'GeoGebra/deployggb.js',
      'README.txt',
    ]) {
      if (!fs.statSync(path.join(staging, file), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`GeoGebra archive is missing ${file}`);
      }
    }
    const lock = options.manifest || manifest;
    fs.writeFileSync(
      path.join(staging, 'LICENSES.md'),
      [
        '# GeoGebra Math Apps（离线包）许可',
        '',
        `官方离线包 ${lock.version}：${lock.url}`,
        '',
        '- 版权：© International GeoGebra Institute',
        '- 许可：GeoGebra Non-Commercial License（非商业用途可自由复制、分发与传输）',
        '- 完整条款：见 README.txt 与 https://www.geogebra.org/license',
        '',
        `构建前校验 SHA-256：${lock.sha256}`,
        '',
      ].join('\n'),
    );
    // Always extract the verified archive, including on cache hits. Partial or
    // stale extracted caches must not silently produce incomplete installers.
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    const loaderDirectory = path.join(assets, 'geogebra');
    fs.mkdirSync(loaderDirectory, { recursive: true });
    fs.copyFileSync(
      path.join(destination, 'GeoGebra/deployggb.js'),
      path.join(loaderDirectory, 'deployggb.js'),
    );
    console.log(`[geogebra] Verified offline bundle ${lock.version} ready`);
    return destination;
  } finally {
    // staging is created by mkdtemp directly within the checked asset directory.
    if (path.dirname(path.resolve(staging)) === assets) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

module.exports = { ensureArchive, ensureBundle };

if (require.main === module) {
  try {
    if (process.argv.includes('--archive-only')) ensureArchive();
    else ensureBundle();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
