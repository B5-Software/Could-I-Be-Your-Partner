/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function verifyRegistryPackage(entry, previous) {
  if (previous?.name !== entry.pkg.name || previous.version !== entry.pkg.version)
    throw new Error('Invalid npm registry metadata: ' + entry.pkg.name);
  if (previous.dist?.integrity !== entry.packed.integrity)
    throw new Error(`${entry.pkg.name}@${entry.pkg.version} already exists with different content`);
}

async function waitForRegistry(
  packages,
  {
    fetchPackage = fetch,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    timeout = 30 * 60 * 1000,
    interval = 30000,
    log = console.log,
  } = {},
) {
  const deadline = now() + timeout;
  let pending = [...packages];
  while (pending.length) {
    const remaining = [];
    for (let offset = 0; offset < pending.length; offset += 6) {
      const batch = pending.slice(offset, offset + 6);
      const available = await Promise.all(
        batch.map(async (entry) => {
          let response;
          try {
            response = await fetchPackage(
              `https://registry.npmjs.org/${entry.pkg.name}/${encodeURIComponent(entry.pkg.version)}`,
              { signal: AbortSignal.timeout(30000), cache: 'no-store' },
            );
          } catch {
            return false;
          }
          if (response.ok) {
            verifyRegistryPackage(entry, await response.json());
            return true;
          }
          if (response.status === 404 || response.status === 429 || response.status >= 500)
            return false;
          throw new Error(
            `npm availability check failed: ${entry.pkg.name}, HTTP ${response.status}`,
          );
        }),
      );
      remaining.push(...batch.filter((_entry, index) => !available[index]));
    }
    pending = remaining;
    if (!pending.length) break;
    if (now() >= deadline)
      throw new Error(
        'npm has not made these uploaded packages available; inspect their scan status before retrying: ' +
          pending.map((entry) => entry.pkg.name).join(', '),
      );
    log(`[npm] Waiting for ${pending.length} uploaded package(s) to become installable...`);
    await pause(Math.min(interval, deadline - now()));
  }
  log(`[npm] Verified ${packages.length} installable package(s) and their integrity.`);
}

function verifyLauncher(pkg, packed) {
  if (
    pkg.name !== 'cibyp' ||
    Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length
  )
    throw new Error('npm publication is restricted to the dependency-free cibyp launcher');
  if (packed.size > 256 * 1024 || packed.unpackedSize > 1024 * 1024)
    throw new Error('Launcher exceeds the small npm package budget');
  const allowed = (file) =>
    /^(?:bin|lib)\/[a-z0-9-]+\.cjs$/.test(file) ||
    ['package.json', 'README.md', 'LICENSE'].includes(file);
  if (packed.files.some((file) => !allowed(file.path)))
    throw new Error('Launcher contains an unexpected file or binary');
}
async function publish(directory) {
  if (!process.env.npm_execpath) throw new Error('Run publishing through npm run publish:npm');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].name !== 'cibyp')
    throw new Error('Only one cibyp launcher package may be published per run');
  const cwd = path.join(directory, 'cibyp');
  const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  const npm = (...args) =>
    run(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      timeout: 15 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
  const packed = JSON.parse((await npm('pack', '--json', '--ignore-scripts')).stdout)[0];
  verifyLauncher(pkg, packed);
  const entry = { pkg, packed };
  const response = await fetch(
    'https://registry.npmjs.org/cibyp/' + encodeURIComponent(pkg.version),
    { signal: AbortSignal.timeout(30000) },
  );
  if (response.ok) {
    verifyRegistryPackage(entry, await response.json());
    console.log('[npm] cibyp@' + pkg.version + ': matching launcher already published');
    return;
  }
  if (response.status !== 404) throw new Error('npm lookup failed: HTTP ' + response.status);
  const result = await npm(
    'publish',
    packed.filename,
    '--access',
    'public',
    '--tag',
    'latest',
    '--provenance',
    '--ignore-scripts',
  );
  console.log(result.stdout);
  await waitForRegistry([entry]);
}
if (require.main === module)
  publish(path.resolve(process.argv[2] || '')).catch((error) => {
    console.error('[npm]', error.message);
    process.exitCode = 1;
  });
module.exports = { publish, waitForRegistry, verifyLauncher };
