/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { downloadVerified } = require('./download.cjs');

function inside(directory, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative)
  )
    throw new Error('Invalid runtime path');
  const target = path.resolve(directory, relative);
  const relation = path.relative(directory, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation))
    throw new Error('Runtime path is outside its cache directory');
  return target;
}

function cacheDirectory(env = process.env, platform = process.platform) {
  if (env.CIBYP_CACHE_DIR) return path.resolve(env.CIBYP_CACHE_DIR);
  const base =
    platform === 'win32'
      ? env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local')
      : platform === 'darwin'
        ? path.join(os.homedir(), 'Library/Caches')
        : env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.resolve(base, 'cibyp/npm');
}

function runtimeDirectoryName(manifest, platform, arch, asset) {
  const name = `${manifest.version}-${platform}-${arch}-${asset.sha256.slice(0, 12)}`;
  // Keep previously running copies untouched while migrating unsigned caches.
  return platform === 'darwin' ? name + '-signed-' + require('./macos.cjs').policy : name;
}

function selectTarget(manifest, platform, arch) {
  const key = `${platform}-${arch}`;
  const asset = manifest?.targets?.[key];
  if (manifest?.schema !== 1 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version))
    throw new Error('Invalid CIBYP release manifest');
  if (!asset) throw new Error(`CIBYP does not provide an npm runtime for ${key}`);
  if (
    !/^[a-f0-9]{64}$/.test(asset.sha256 || '') ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.file !== `cibyp-runtime-${manifest.version}-${key}.tar.gz`
  )
    throw new Error('Invalid CIBYP runtime checksum or archive');
  // Validate every path before any download, cleanup or process execution.
  for (const name of ['node', 'entry', 'resources', 'executable']) inside('/runtime', asset[name]);
  return asset;
}

async function checksum(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function usable(directory, asset) {
  try {
    const marker = JSON.parse(
      await fsp.readFile(path.join(directory, '.cibyp-runtime.json'), 'utf8'),
    );
    if (marker.sha256 !== asset.sha256) return false;
    for (const name of ['node', 'entry', 'executable'])
      if (!(await fsp.stat(inside(directory, asset[name]))).isFile()) return false;
    return true;
  } catch {
    return false;
  }
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function lockDirectory(directory, { signal, log, timeout = 20 * 60 * 1000 }) {
  const started = Date.now();
  const token = crypto.randomUUID();
  let reported = false;
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() - started >= timeout)
      throw new Error('Another CIBYP installation is still running; retry after it finishes');
    try {
      await fsp.mkdir(directory);
      try {
        await fsp.writeFile(
          path.join(directory, 'owner.pending'),
          JSON.stringify({ pid: process.pid, token }),
        );
        await fsp.rename(path.join(directory, 'owner.pending'), path.join(directory, 'owner.json'));
      } catch (error) {
        await fsp.rm(directory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const owner = JSON.parse(await fsp.readFile(path.join(directory, 'owner.json'), 'utf8'));
        if (owner.token === token) await fsp.rm(directory, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(directory, 'owner.json'), 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0)
        throw new Error('Invalid installation lock');
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          const gate = directory + '.recovery';
          const acquired = await fsp.mkdir(gate).then(
            () => true,
            (failure) => {
              if (failure.code !== 'EEXIST') throw failure;
              return false;
            },
          );
          if (acquired)
            try {
              const current = JSON.parse(
                await fsp.readFile(path.join(directory, 'owner.json'), 'utf8'),
              );
              if (current.token === owner.token)
                await fsp.rm(directory, { recursive: true, force: true });
            } catch (failure) {
              if (failure.code !== 'ENOENT') throw failure;
            } finally {
              await fsp.rmdir(gate);
            }
          await pause(250, signal);
          continue;
        }
        if (error.code !== 'EPERM') throw error;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        // A process can die between mkdir and writing its owner marker.
        const stat = await fsp.stat(directory).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 10000)
          throw new Error(
            'An interrupted runtime installation left an ownerless lock: ' + directory,
          );
      } else throw error;
    }
    if (!reported) {
      log('[cibyp] Waiting for another runtime installation...');
      reported = true;
    }
    await pause(250, signal);
  }
}

async function ensureRuntime(
  manifest,
  {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    download = downloadVerified,
    mirrors,
    concurrency,
    extract = run,
    prepareMac = require('./macos.cjs').prepareMacRuntime,
    signal,
    log = (message) => console.error(message),
  } = {},
) {
  const asset = selectTarget(manifest, platform, arch);
  const base = cacheDirectory(env, platform);
  const name = runtimeDirectoryName(manifest, platform, arch, asset);
  const destination = inside(base, name);
  if (await usable(destination, asset)) return { directory: destination, asset };
  await fsp.mkdir(base, { recursive: true });
  const unlock = await lockDirectory(inside(base, name + '.lock'), { signal, log });
  const staging = inside(base, name + '.staging-' + crypto.randomUUID());
  const archive = inside(base, name + '.archive-' + crypto.randomUUID() + '.tar.gz');
  try {
    if (await usable(destination, asset)) return { directory: destination, asset };
    log(`[cibyp] Preparing CIBYP ${manifest.version} for ${platform}-${arch}...`);
    let last = 0;
    const began = Date.now();
    await download(asset, archive, {
      mirrors,
      concurrency,
      signal,
      onProgress({ downloaded, total, source, verified }) {
        if (!verified && Date.now() - last < 1500) return;
        last = Date.now();
        const speed = downloaded / Math.max(1, (last - began) / 1000) / 1048576;
        log(
          '[cibyp] ' +
            (downloaded / 1048576).toFixed(1) +
            '/' +
            (total / 1048576).toFixed(1) +
            ' MiB, ' +
            speed.toFixed(1) +
            ' MiB/s (' +
            new URL(source).host +
            ')',
        );
      },
    });
    if ((await fsp.stat(archive)).size !== asset.size || (await checksum(archive)) !== asset.sha256)
      throw new Error('Runtime SHA-256 verification failed');
    log('[cibyp] Verified SHA-256; extracting runtime...');
    await fsp.mkdir(staging);
    try {
      await extract('tar', ['-xzf', archive, '-C', staging], {
        timeout: 10 * 60 * 1000,
        signal,
        windowsHide: true,
      });
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error(
          'Archive extraction requires tar (included with Windows 10+, macOS and Linux)',
        );
      throw error;
    }
    for (const key of ['node', 'entry', 'executable'])
      if (!(await fsp.stat(inside(staging, asset[key]))).isFile())
        throw new Error(`Incomplete runtime archive: ${key}`);
    if (platform !== 'win32') {
      await fsp.chmod(inside(staging, asset.node), 0o755);
      await fsp.chmod(inside(staging, asset.executable), 0o755);
    }
    if (platform === 'darwin') await prepareMac(staging, asset, { signal, log });
    await fsp.writeFile(
      path.join(staging, '.cibyp-runtime.json'),
      JSON.stringify({ sha256: asset.sha256 }),
    );
    // Only remove this exact, validated cache target, never user settings or workspaces.
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.rename(staging, destination);
    log('[cibyp] Runtime ready. Subsequent starts use this cache.');
    return { directory: destination, asset };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.rm(archive, { force: true });
    await unlock();
  }
}

async function startRuntime(mode, args, runtime, { spawnProcess = spawn, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      inside(runtime.directory, runtime.asset.node),
      [inside(runtime.directory, runtime.asset.entry), mode, ...args],
      { stdio: 'inherit', env: { ...env, ELECTRON_RUN_AS_NODE: undefined } },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.exitCode = signal === 'SIGINT' ? 130 : 1;
        resolve(process.exitCode);
      } else resolve(code ?? 1);
    });
  });
}

async function main(mode, args = process.argv.slice(2)) {
  const pkg = require('../package.json');
  if (args.includes('--desktop')) {
    const launcherDirectory = path.dirname(__dirname);
    if (path.basename(launcherDirectory) !== 'launcher-' + pkg.version)
      throw new Error('Desktop starts require the managed launcher copy');
    process.env.CIBYP_CACHE_DIR = path.dirname(launcherDirectory);
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(pkg.version);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Could I Be Your Partner launcher ' +
        pkg.version +
        '\n\n' +
        '  cibyp                GUI, or TUI without a desktop\n' +
        '  cibyp-tui            TUI\n' +
        '  cibyp-code           Code TUI using the current terminal directory\n' +
        '  cibyp update         Download the latest verified GitHub runtime\n' +
        '  cibyp --no-update    Use the cached runtime without checking updates\n' +
        '  cibyp --channel=stable|preview    Persist the release channel (default: preview)\n' +
        '  cibyp --runtime-version           Show the cached App version\n' +
        '  cibyp --install-only              Install/repair and register the GUI\n\n' +
        'Automatic runtime updates do not require npm updates. Downloads use SHA-256 verification.\n' +
        'CIBYP_CACHE_DIR moves the cache. CIBYP_MIRRORS=off disables mirrors; otherwise supply comma-separated HTTPS prefixes.\n' +
        'CIBYP_DOWNLOAD_CONCURRENCY=1..8 controls parallel downloads (default: 4). Use /help in TUI.',
    );
    return;
  }
  const update = args[0] === 'update' || args.includes('--update');
  const channel = args.find((arg) => arg.startsWith('--channel='))?.slice(10);
  const installOnly = args.includes('--install-only');
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Runtime installation cancelled'));
  process.once('SIGINT', interrupt);
  let runtime;
  try {
    if (args.includes('--runtime-version')) {
      const cached = await require('./updates.cjs').readState();
      console.log(cached.manifest?.version || 'not installed');
      return;
    }
    runtime = await require('./updates.cjs').resolveRuntime({
      force: update || installOnly,
      offline: args.includes('--no-update'),
      channel,
      signal: controller.signal,
    });
    await require('./desktop.cjs')
      .registerDesktop(runtime)
      .catch((error) => {
        console.error('[cibyp] Desktop registration: ' + error.message);
      });
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
  if (!update && !installOnly) {
    const applicationArgs = args.filter(
      (arg) =>
        !['--no-update', '--update', '--desktop'].includes(arg) && !arg.startsWith('--channel='),
    );
    process.exitCode = await startRuntime(mode, applicationArgs, runtime);
  }
}
module.exports = {
  main,
  ensureRuntime,
  startRuntime,
  selectTarget,
  inside,
  checksum,
  cacheDirectory,
  runtimeDirectoryName,
  usable,
  lockDirectory,
};
