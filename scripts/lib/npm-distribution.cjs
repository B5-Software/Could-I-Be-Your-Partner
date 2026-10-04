/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
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

async function prepareRuntimeManifest({
  assets,
  version = require('../../package.json').version,
  revision,
}) {
  if (!assets) throw new Error('Specify the runtime assets directory');
  if (!/^[a-f0-9]{40}$/.test(revision || ''))
    throw new Error('Specify the verified build revision');
  const manifest = { schema: 1, version, revision, targets: {} };
  for (const key of targets) {
    const metadata = JSON.parse(
      await fsp.readFile(
        path.join(assets, 'cibyp-runtime-' + version + '-' + key + '.json'),
        'utf8',
      ),
    );
    const [platform, arch] = key.split('-');
    manifest.targets[key] = metadata;
    selectTarget(manifest, platform, arch);
    if (metadata.version !== version || metadata.platform !== platform || metadata.arch !== arch)
      throw new Error('Release manifest target does not match ' + key);
    const archive = inside(assets, metadata.file);
    if (
      (await fsp.stat(archive)).size !== metadata.size ||
      (await checksum(archive)) !== metadata.sha256
    )
      throw new Error('Release archive verification failed: ' + metadata.file);
  }
  await fsp.writeFile(
    path.join(assets, 'cibyp-runtime.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}
async function preparePackage({ output }) {
  if (!output) throw new Error('Specify an empty npm output directory');
  await fsp.mkdir(output, { recursive: true });
  if ((await fsp.readdir(output)).length) throw new Error('npm output directory must be empty');
  const source = path.join(projectRoot, 'packages/npm');
  const pkg = JSON.parse(await fsp.readFile(path.join(source, 'package.json'), 'utf8'));
  if (
    pkg.name !== 'cibyp' ||
    Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length
  )
    throw new Error('Only the dependency-free cibyp launcher may be prepared for npm');
  const launcher = path.join(output, 'cibyp');
  await fsp.mkdir(launcher);
  for (const name of ['bin', 'lib', 'README.md', 'package.json'])
    await fsp.cp(path.join(source, name), path.join(launcher, name), { recursive: true });
  await fsp.copyFile(path.join(projectRoot, 'LICENSE'), path.join(launcher, 'LICENSE'));
  for (const bin of Object.values(pkg.bin)) await fsp.chmod(path.join(launcher, bin), 0o755);
  return pkg;
}
module.exports = { targets, findApp, archiveRuntime, prepareRuntimeManifest, preparePackage };
