/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const lock = require('../build/cli/node-runtime.json');
const root = path.resolve(__dirname, '..');

async function checksum(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

function checkedAsset(target) {
  const base = path.join(root, 'assets/node');
  const absolute = path.resolve(target);
  const relative = path.relative(base, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Unsafe Node runtime path');
  return absolute;
}

async function prepareCLI(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = lock.targets[key];
  if (!asset) throw new Error(`Unsupported CLI target: ${key}`);
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform;
  const destination = checkedAsset(path.join(root, 'assets/node', `${os}-${arch}`));
  const binaryName = platform === 'win32' ? 'node.exe' : 'node';
  try {
    const marker = JSON.parse(await fsp.readFile(path.join(destination, 'runtime.json'), 'utf8'));
    if (
      marker.archiveSha256 === asset.sha256 &&
      marker.binarySha256 === (await checksum(path.join(destination, binaryName)))
    )
      return destination;
  } catch {
    /* Prepare missing or interrupted runtime. */
  }
  const cache = path.join(root, '.cache/node', lock.version, key);
  await fsp.mkdir(cache, { recursive: true });
  const archive = path.join(cache, asset.file);
  if (!fs.existsSync(archive) || (await checksum(archive)) !== asset.sha256) {
    console.log(`[cli] Downloading verified Node.js ${lock.version} (${key})`);
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(`https://nodejs.org/dist/v${lock.version}/${asset.file}`, {
          signal: AbortSignal.timeout(300000),
        });
        if (!response.ok) throw new Error(`Node.js download: HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive + '.partial'));
        if ((await checksum(archive + '.partial')) !== asset.sha256)
          throw new Error('Node.js archive checksum mismatch');
        await fsp.rename(archive + '.partial', archive);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  }
  const staging = checkedAsset(destination + `.staging-${process.pid}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    const prefix = asset.file.replace(/\.(zip|tar\.gz)$/, '');
    if (platform === 'win32') {
      const zip = new (require('adm-zip'))(archive);
      for (const name of [binaryName, 'LICENSE']) {
        const entry = zip.getEntry(`${prefix}/${name}`);
        if (!entry) throw new Error(`Node.js archive file missing: ${name}`);
        await fsp.writeFile(path.join(staging, name), entry.getData());
      }
    } else {
      const result = spawnSync(
        'tar',
        [
          '-xzf',
          archive,
          '-C',
          staging,
          '--strip-components=1',
          `${prefix}/bin/node`,
          `${prefix}/LICENSE`,
        ],
        { stdio: 'inherit' },
      );
      if (result.error || result.status !== 0)
        throw result.error || new Error('Node.js extraction failed');
      await fsp.rename(path.join(staging, 'bin/node'), path.join(staging, 'node'));
      await fsp.rmdir(path.join(staging, 'bin'));
      await fsp.chmod(path.join(staging, 'node'), 0o755);
    }
    await fsp.writeFile(
      path.join(staging, 'runtime.json'),
      JSON.stringify(
        {
          version: lock.version,
          platform,
          arch,
          archiveSha256: asset.sha256,
          binarySha256: await checksum(path.join(staging, binaryName)),
        },
        null,
        2,
      ) + '\n',
    );
    if (fs.existsSync(destination))
      await fsp.rm(checkedAsset(destination), { recursive: true, force: true });
    await fsp.rename(staging, destination);
  } finally {
    if (fs.existsSync(staging))
      await fsp.rm(checkedAsset(staging), { recursive: true, force: true });
  }
  return destination;
}

// Extend the builder's current Linux defaults, preserving sandbox, AppArmor,
// desktop database and upgrade behavior instead of replacing those hooks.
function prepareLinuxInstallers() {
  const directory = path.join(root, '.cache/installers');
  fs.mkdirSync(directory, { recursive: true });
  const templates = path.join(
    path.dirname(require.resolve('app-builder-lib/package.json')),
    'templates/linux',
  );
  for (const [file, operation] of [
    ['after-install', 'install'],
    ['after-remove', 'remove'],
  ]) {
    const standard = fs.readFileSync(path.join(templates, `${file}.tpl`), 'utf8');
    const extension = fs.readFileSync(
      path.join(root, 'build/installers', `linux-${operation}.tpl`),
      'utf8',
    );
    fs.writeFileSync(path.join(directory, `${file}.tpl`), `${standard}\n${extension}`);
  }
}

module.exports = { prepareCLI, prepareLinuxInstallers };
if (require.main === module)
  prepareCLI().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
