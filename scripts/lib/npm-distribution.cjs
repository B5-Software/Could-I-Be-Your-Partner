/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const { checksum, inside, selectTarget } = require('../../packages/npm/lib/runtime.cjs');
const run = promisify(execFile);
const projectRoot = path.resolve(__dirname, '../..');
const targets = [
  'win32-x64',
  'win32-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
];

async function findApp(dist, platform, arch) {
  const candidates = [];
  for (const item of await fsp.readdir(dist, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const root = path.join(dist, item.name);
    if (platform !== 'darwin') candidates.push({ root, resources: 'resources' });
    else {
      for (const app of await fsp.readdir(root, { withFileTypes: true }))
        if (app.isDirectory() && app.name.endsWith('.app'))
          candidates.push({ root, resources: `${app.name}/Contents/Resources` });
    }
  }
  const matches = [];
  for (const candidate of candidates) {
    try {
      const marker = JSON.parse(
        await fsp.readFile(
          path.join(candidate.root, candidate.resources, 'cli/runtime.json'),
          'utf8',
        ),
      );
      if (marker.platform === platform && marker.arch === arch) matches.push(candidate);
    } catch {
      // Ignore installer and other architecture output directories.
    }
  }
  if (matches.length !== 1)
    throw new Error(`Expected one packaged ${platform}-${arch} runtime; found ${matches.length}`);
  return matches[0];
}

async function archiveRuntime({
  dist = path.join(projectRoot, 'dist'),
  platform = process.platform,
  arch = process.arch,
  version = require('../../package.json').version,
}) {
  if (!targets.includes(`${platform}-${arch}`))
    throw new Error('Unsupported npm distribution target');
  const app = await findApp(dist, platform, arch);
  const marker = JSON.parse(
    await fsp.readFile(path.join(app.root, app.resources, 'cli/runtime.json'), 'utf8'),
  );
  const pkg = JSON.parse(
    await fsp.readFile(
      path.join(app.root, app.resources, 'app.asar.unpacked/package.json'),
      'utf8',
    ),
  );
  if (pkg.version.split('+')[0] !== version)
    throw new Error('The packaged runtime does not match the npm release version');
  const name = `cibyp-runtime-${version}-${platform}-${arch}`;
  const metadata = {
    schema: 1,
    version,
    platform,
    arch,
    file: name + '.tar.gz',
    resources: app.resources,
    node: `${app.resources}/node/${platform === 'win32' ? 'node.exe' : 'node'}`,
    entry: `${app.resources}/cli/launch.cjs`,
    executable: path
      .relative(app.root, path.resolve(app.root, app.resources, marker.executable))
      .split(path.sep)
      .join('/'),
  };
  for (const key of ['node', 'entry', 'executable'])
    if (!(await fsp.stat(inside(app.root, metadata[key]))).isFile())
      throw new Error(`Packaged npm entry missing: ${key}`);
  const archive = inside(dist, metadata.file);
  await run('tar', ['-czf', archive, '-C', app.root, '.'], {
    timeout: 20 * 60 * 1000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  metadata.size = (await fsp.stat(archive)).size;
  metadata.sha256 = await checksum(archive);
  selectTarget(
    { schema: 1, version, targets: { [`${platform}-${arch}`]: metadata } },
    platform,
    arch,
  );
  await fsp.writeFile(inside(dist, name + '.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

async function preparePackage({
  assets,
  output,
  version = require('../../package.json').version,
  chunkSize = 64 * 1024 * 1024,
}) {
  if (!assets || !output)
    throw new Error('Specify both release assets and an empty npm output directory');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 64 * 1024 * 1024)
    throw new Error('Invalid npm payload chunk size');
  const manifest = { schema: 1, version, targets: {} };
  for (const key of targets) {
    const metadata = JSON.parse(
      await fsp.readFile(path.join(assets, `cibyp-runtime-${version}-${key}.json`), 'utf8'),
    );
    const [platform, arch] = key.split('-');
    manifest.targets[key] = metadata;
    selectTarget(manifest, platform, arch);
    if (metadata.version !== version || metadata.platform !== platform || metadata.arch !== arch)
      throw new Error(`Release manifest target does not match ${key}`);
    const archive = inside(assets, metadata.file);
    if (
      (await fsp.stat(archive)).size !== metadata.size ||
      (await checksum(archive)) !== metadata.sha256
    )
      throw new Error(`Release archive verification failed: ${metadata.file}`);
  }
  // Never recursively replace a caller's arbitrary directory.
  await fsp.mkdir(output, { recursive: true });
  if ((await fsp.readdir(output)).length) throw new Error('npm output directory must be empty');
  const source = path.join(projectRoot, 'packages/npm');
  const launcher = path.join(output, 'cibyp');
  await fsp.mkdir(launcher);
  for (const name of ['bin', 'lib', 'README.md'])
    await fsp.cp(path.join(source, name), path.join(launcher, name), { recursive: true });
  await fsp.copyFile(path.join(projectRoot, 'LICENSE'), path.join(launcher, 'LICENSE'));
  const pkg = JSON.parse(await fsp.readFile(path.join(source, 'package.json'), 'utf8'));
  pkg.version = version;
  pkg.optionalDependencies = {};
  const writePackage = async (name, data) => {
    const directory = path.join(output, name);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.copyFile(path.join(projectRoot, 'LICENSE'), path.join(directory, 'LICENSE'));
    await fsp.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify(
        {
          name,
          version,
          license: pkg.license,
          repository: pkg.repository,
          publishConfig: pkg.publishConfig,
          ...data,
        },
        null,
        2,
      ) + '\n',
    );
    return directory;
  };
  for (const [key, metadata] of Object.entries(manifest.targets)) {
    const platformName = 'cibyp-runtime-' + key;
    const dependencies = {};
    metadata.parts = [];
    const input = await fsp.open(inside(assets, metadata.file), 'r');
    try {
      for (let offset = 0, index = 1; offset < metadata.size; index++) {
        const size = Math.min(chunkSize, metadata.size - offset);
        const buffer = Buffer.allocUnsafe(size);
        let read = 0;
        while (read < size) {
          const result = await input.read(buffer, read, size - read, offset + read);
          if (!result.bytesRead) throw new Error('Truncated runtime archive');
          read += result.bytesRead;
        }
        const name = platformName + '-part-' + index;
        const directory = await writePackage(name, {
          os: [metadata.platform],
          cpu: [metadata.arch],
          files: ['payload.bin', 'LICENSE'],
        });
        await fsp.writeFile(path.join(directory, 'payload.bin'), buffer);
        metadata.parts.push({
          package: name,
          size,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        });
        dependencies[name] = version;
        offset += size;
      }
    } finally {
      await input.close();
    }
    const directory = await writePackage(platformName, {
      os: [metadata.platform],
      cpu: [metadata.arch],
      dependencies,
      files: ['runtime.json', 'LICENSE'],
    });
    await fsp.writeFile(
      path.join(directory, 'runtime.json'),
      JSON.stringify(metadata, null, 2) + '\n',
    );
    pkg.optionalDependencies[platformName] = version;
    selectTarget(manifest, metadata.platform, metadata.arch);
  }
  await fsp.writeFile(path.join(launcher, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await fsp.writeFile(
    path.join(launcher, 'runtime.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  for (const bin of Object.values(pkg.bin)) await fsp.chmod(path.join(launcher, bin), 0o755);
  return manifest;
}

module.exports = { targets, findApp, archiveRuntime, preparePackage };
