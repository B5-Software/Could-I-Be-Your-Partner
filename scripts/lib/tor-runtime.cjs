/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const lock = require('../../integrations/tor/runtime-lock.json');
const { downloadVerified } = require('../../packages/npm/lib/download.cjs');
async function prepareTor(platform = process.platform, arch = process.arch, destination) {
  const key = platform + '-' + arch,
    asset = lock.targets[key];
  if (!asset) throw new Error('Tor runtime is unavailable for ' + key);
  const directory =
    destination ||
    path.resolve(
      __dirname,
      '../../assets/tor',
      { win32: 'win', darwin: 'mac', linux: 'linux' }[platform] + '-' + arch,
    );
  const binary = path.join(directory, 'tor', platform === 'win32' ? 'tor.exe' : 'tor');
  if (
    (await fs.readFile(path.join(directory, '.cibyp-ready'), 'utf8').catch(() => '')) ===
      asset.sha256 &&
    (await fs.stat(binary).catch(() => null))
  )
    return directory;
  await fs.mkdir(directory, { recursive: true });
  const archive = path.join(directory, 'bundle.tar.gz');
  const url = new URL(asset.url);
  if (url.origin !== 'https://dist.torproject.org' || !/^\/[\w./-]+\.tar\.gz$/.test(url.pathname))
    throw new Error('Invalid official Tor runtime URL');
  try {
    await downloadVerified(asset, archive, { candidates: [asset.url], concurrency: 4 });
    await require('tar').x({
      file: archive,
      cwd: directory,
      filter: (name) => !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'),
    });
    if (!(await fs.stat(binary)).isFile()) throw new Error('Tor executable is missing');
    if (platform !== 'win32') await fs.chmod(binary, 0o755);
    await fs.writeFile(path.join(directory, '.cibyp-ready'), asset.sha256);
    return directory;
  } finally {
    await fs.rm(archive, { force: true });
  }
}
module.exports = { prepareTor };
