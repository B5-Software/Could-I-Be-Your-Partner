/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { patchDesktopMain, patchDesktopWorkbench } = require('./lib/codeoss-patches.cjs');
const lock = require('../integrations/codeoss/runtime-lock.json');
const root = path.resolve(__dirname, '..');

function checkedChild(parent, target) {
  const absolute = path.resolve(target);
  const relative = path.relative(path.resolve(parent), absolute);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('Unsafe Code-OSS build path');
  return absolute;
}

async function checksum(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function prepareCodeOSS(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = lock.desktop[key];
  if (!asset) throw new Error(`Unsupported Code-OSS target: ${key}`);
  const resourcePlatform = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform;
  const destination = path.join(root, 'assets/codeoss', `${resourcePlatform}-${arch}`, 'app');
  const assetsRoot = path.join(root, 'assets/codeoss');
  const marker = path.join(destination, 'cibyp-runtime.json');
  const patchDigest = crypto
    .createHash('sha256')
    .update(await fsp.readFile(__filename))
    .update(await fsp.readFile(path.join(__dirname, 'lib/codeoss-patches.cjs')))
    .digest('hex');
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    /* Missing or interrupted preparation. */
  }
  if (
    installed?.version === lock.version &&
    installed.commit === lock.commit &&
    installed.patchDigest === patchDigest &&
    installed.sha256 === asset.sha256
  ) {
    await buildExtension(destination);
    return destination;
  }
  const cache = path.join(root, '.cache/codeoss', lock.version, key);
  await fsp.mkdir(cache, { recursive: true });
  const archive = path.join(cache, path.basename(new URL(asset.url).pathname));
  if (!fs.existsSync(archive) || (await checksum(archive)) !== asset.sha256) {
    console.log(`[codeoss] Downloading desktop runtime ${lock.version} (${key})`);
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`Code-OSS download: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive + '.partial'));
    if ((await checksum(archive + '.partial')) !== asset.sha256)
      throw new Error('Code-OSS archive checksum mismatch');
    await fsp.rename(archive + '.partial', archive);
  }
  const staging = checkedChild(
    assetsRoot,
    destination + `.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const backup = checkedChild(assetsRoot, staging + '.previous');
  await fsp.mkdir(staging, { recursive: true });
  try {
    if (archive.endsWith('.zip')) {
      const zip = new AdmZip(archive);
      const prefix =
        platform === 'darwin' ? 'VSCodium.app/Contents/Resources/app/' : 'resources/app/';
      for (const entry of zip.getEntries()) {
        if (!entry.entryName.startsWith(prefix) || entry.isDirectory) continue;
        const relative = entry.entryName.slice(prefix.length);
        const target = checkedChild(staging, path.resolve(staging, relative));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, entry.getData());
        if (platform !== 'win32')
          await fsp.chmod(target, (entry.header.attr >>> 16) & 0o777 || 0o644);
      }
    } else {
      const extracted = path.join(cache, 'extracted');
      await fsp.mkdir(extracted, { recursive: true });
      const result = spawnSync('tar', ['-xzf', archive, '-C', extracted], { stdio: 'inherit' });
      if (result.error || result.status !== 0)
        throw result.error || new Error('Code-OSS extraction failed');
      const appRoot = findApp(extracted);
      if (!appRoot) throw new Error('Code-OSS desktop payload is missing');
      await fsp.cp(appRoot, staging, { recursive: true, dereference: false });
    }
    const productFile = path.join(staging, 'product.json');
    const product = JSON.parse(await fsp.readFile(productFile, 'utf8'));
    if (product.commit !== lock.commit) throw new Error('Code-OSS commit mismatch');
    Object.assign(product, {
      nameShort: 'CIBYP Code',
      nameLong: 'CIBYP Code',
      applicationName: 'cibyp-code',
      dataFolderName: '.cibyp-code',
      sharedDataFolderName: '.cibyp-code-shared',
      win32AppUserModelId: 'org.b5-software.cibyp',
      urlProtocol: 'cibyp-code',
      enableTelemetry: false,
      updateUrl: undefined,
      extensionEnabledApiProposals: {
        ...product.extensionEnabledApiProposals,
        'cibyp.workbench': ['resolvers'],
      },
    });
    await fsp.writeFile(productFile, JSON.stringify(product, null, 2) + '\n');
    const mainFile = path.join(staging, 'out/main.js');
    await fsp.writeFile(mainFile, patchDesktopMain(await fsp.readFile(mainFile, 'utf8')));
    const workbenchFile = path.join(staging, 'out/vs/workbench/workbench.desktop.main.js');
    await fsp.writeFile(
      workbenchFile,
      patchDesktopWorkbench(await fsp.readFile(workbenchFile, 'utf8')),
    );
    product.checksums['vs/workbench/workbench.desktop.main.js'] = crypto
      .createHash('sha256')
      .update(await fsp.readFile(workbenchFile))
      .digest('base64')
      .replace(/=+$/, '');
    await fsp.writeFile(productFile, JSON.stringify(product, null, 2) + '\n');
    await buildExtension(staging);
    await fsp.writeFile(
      path.join(staging, 'cibyp-runtime.json'),
      JSON.stringify(
        {
          version: lock.version,
          commit: lock.commit,
          platform,
          arch,
          sha256: asset.sha256,
          patchDigest,
        },
        null,
        2,
      ) + '\n',
    );
    if (fs.existsSync(destination)) await fsp.rename(checkedChild(assetsRoot, destination), backup);
    try {
      await fsp.rename(staging, checkedChild(assetsRoot, destination));
    } catch (error) {
      if (fs.existsSync(backup)) await fsp.rename(backup, destination);
      throw error;
    }
    if (fs.existsSync(backup))
      await fsp.rm(checkedChild(assetsRoot, backup), { recursive: true, force: true });
  } finally {
    if (fs.existsSync(staging))
      await fsp.rm(checkedChild(assetsRoot, staging), { recursive: true, force: true });
  }
  console.log(`[codeoss] Prepared complete desktop workbench: ${key}`);
  return destination;
}

function findApp(directory, depth = 0) {
  if (depth > 5) return null;
  if (
    fs.existsSync(path.join(directory, 'out/main.js')) &&
    fs.existsSync(path.join(directory, 'product.json'))
  )
    return directory;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const result = findApp(path.join(directory, entry.name), depth + 1);
    if (result) return result;
  }
  return null;
}

async function buildExtension(destination) {
  const output = path.join(destination, 'extensions/cibyp-workbench');
  await fsp.mkdir(output, { recursive: true });
  await fsp.cp(path.join(root, 'integrations/codeoss/extension'), output, { recursive: true });
  await require('esbuild').build({
    entryPoints: [path.join(root, 'integrations/codeoss/extension/extension.js')],
    outfile: path.join(output, 'dist/extension.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  });
}

if (require.main === module) {
  const platform = process.argv.find((value) => value.startsWith('--platform='))?.split('=')[1];
  const arch = process.argv.find((value) => value.startsWith('--arch='))?.split('=')[1];
  prepareCodeOSS(platform || process.platform, arch || process.arch).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = { prepareCodeOSS, checksum };
