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

async function publish(directory) {
  if (!process.env.npm_execpath) throw new Error('Run publishing through npm run publish:npm');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    const cwd = path.join(directory, entry.name);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    if (
      pkg.name !== entry.name ||
      !/^cibyp(?:-runtime-(?:win32|darwin|linux)-(?:x64|arm64)(?:-part-\d+)?)?$/.test(pkg.name)
    )
      throw new Error('Unexpected npm package: ' + pkg.name);
    packages.push({ cwd, pkg });
  }
  const main = packages.find((entry) => entry.pkg.name === 'cibyp');
  if (
    !main ||
    Object.keys(main.pkg.optionalDependencies || {}).length !== 6 ||
    packages.some((entry) => entry.pkg.version !== main.pkg.version)
  )
    throw new Error('Incomplete prepared npm distribution');
  const names = new Set(packages.map((entry) => entry.pkg.name));
  for (const { pkg } of packages)
    for (const [name, version] of Object.entries({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    }))
      if (!names.has(name) || version !== main.pkg.version)
        throw new Error('Missing runtime dependency: ' + name);
  // Preflight everything; publish payloads first and the public entry point last.
  packages.sort((a, b) => {
    const order = (name) => (name === 'cibyp' ? 2 : /-part-\d+$/.test(name) ? 0 : 1);
    return order(a.pkg.name) - order(b.pkg.name) || a.pkg.name.localeCompare(b.pkg.name);
  });
  for (const entry of packages) {
    entry.npm = (...args) =>
      run(process.execPath, [process.env.npm_execpath, ...args], {
        cwd: entry.cwd,
        timeout: 15 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      });
    entry.packed = JSON.parse((await entry.npm('pack', '--json', '--ignore-scripts')).stdout)[0];
    if (entry.packed.size > 70 * 1024 * 1024)
      throw new Error('npm archive exceeds the payload budget: ' + entry.pkg.name);
    const response = await fetch(
      `https://registry.npmjs.org/${entry.pkg.name}/${encodeURIComponent(entry.pkg.version)}`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (response.ok) {
      const previous = await response.json();
      verifyRegistryPackage(entry, previous);
      entry.published = true;
    } else if (response.status !== 404)
      throw new Error('npm lookup failed: HTTP ' + response.status);
  }
  for (const entry of packages) {
    // npm scans uploads asynchronously. Expose the entry point only after its
    // complete dependency graph is installable, not merely accepted for upload.
    if (entry === main) await waitForRegistry(packages.filter((item) => item !== main));
    if (entry.published) {
      console.log(
        `[npm] ${entry.pkg.name}@${entry.pkg.version}: matching content already published`,
      );
      continue;
    }
    const result = await entry.npm(
      'publish',
      entry.packed.filename,
      '--access',
      'public',
      '--tag',
      'latest',
      '--provenance',
      '--ignore-scripts',
    );
    console.log(result.stdout);
  }
  await waitForRegistry([main]);
}

if (require.main === module)
  publish(path.resolve(process.argv[2] || '')).catch((error) => {
    console.error('[npm]', error.message);
    process.exitCode = 1;
  });
module.exports = { publish, waitForRegistry };
