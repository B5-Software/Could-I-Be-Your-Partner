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
  if (
    asset.parts !== undefined &&
    (!Array.isArray(asset.parts) ||
      !asset.parts.length ||
      asset.parts.some(
        (part, index) =>
          part.package !== `cibyp-runtime-${key}-part-${index + 1}` ||
          !/^[a-f0-9]{64}$/.test(part.sha256 || '') ||
          !Number.isSafeInteger(part.size) ||
          part.size <= 0,
      ) ||
      asset.parts.reduce((sum, part) => sum + part.size, 0) !== asset.size)
  )
    throw new Error('Invalid CIBYP runtime parts');
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

function resolvePart(part, version) {
  let file;
  try {
    const platform = require.resolve(part.package.replace(/-part-\d+$/, '') + '/package.json');
    file = require.resolve(part.package + '/package.json', { paths: [path.dirname(platform)] });
  } catch {
    throw new Error(
      'Missing ' + part.package + '. Reinstall cibyp with optional dependencies enabled.',
    );
  }
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pkg.name !== part.package || pkg.version !== version)
    throw new Error('Mismatched runtime package: ' + part.package);
  return path.join(path.dirname(file), 'payload.bin');
}

async function assembleArchive(manifest, asset, archive, { resolvePayload = resolvePart, signal }) {
  if (!asset.parts?.length) throw new Error('Missing runtime parts; reinstall cibyp');
  const output = await fsp.open(archive, 'wx');
  const hash = crypto.createHash('sha256');
  let total = 0;
  try {
    for (const part of asset.parts) {
      signal?.throwIfAborted();
      const file = resolvePayload(part, manifest.version);
      if ((await fsp.stat(file)).size !== part.size)
        throw new Error('Incomplete runtime part: ' + part.package);
      const partHash = crypto.createHash('sha256');
      for await (const buffer of fs.createReadStream(file)) {
        signal?.throwIfAborted();
        hash.update(buffer);
        partHash.update(buffer);
        total += buffer.length;
        // FileHandle.write may complete with a short write.
        for (let offset = 0; offset < buffer.length;) {
          const result = await output.write(buffer, offset, buffer.length - offset);
          if (!result.bytesWritten) throw new Error('Unable to write runtime archive');
          offset += result.bytesWritten;
        }
      }
      if (partHash.digest('hex') !== part.sha256)
        throw new Error('Runtime part checksum failed: ' + part.package);
    }
    if (total !== asset.size || hash.digest('hex') !== asset.sha256)
      throw new Error('Runtime SHA-256 verification failed');
  } finally {
    await output.close();
  }
}

async function ensureRuntime(
  manifest,
  {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    resolvePayload = resolvePart,
    extract = run,
    signal,
    log = (message) => console.error(message),
  } = {},
) {
  const asset = selectTarget(manifest, platform, arch);
  const base = cacheDirectory(env, platform);
  const name = `${manifest.version}-${platform}-${arch}-${asset.sha256.slice(0, 12)}`;
  const destination = inside(base, name);
  if (await usable(destination, asset)) return { directory: destination, asset };
  await fsp.mkdir(base, { recursive: true });
  const unlock = await lockDirectory(inside(base, name + '.lock'), { signal, log });
  const staging = inside(base, name + '.staging-' + crypto.randomUUID());
  const archive = inside(base, name + '.archive-' + crypto.randomUUID() + '.tar.gz');
  try {
    if (await usable(destination, asset)) return { directory: destination, asset };
    log(`[cibyp] Preparing CIBYP ${manifest.version} for ${platform}-${arch}...`);
    await assembleArchive(manifest, asset, archive, { resolvePayload, signal });
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
  if (args.includes('--version') || args.includes('-v')) {
    console.log(pkg.version);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Could I Be Your Partner ${pkg.version}

  cibyp                         GUI, or TUI when no desktop is available
  cibyp --tui                   TUI
  cibyp-tui                     TUI
  cibyp-code                    Code TUI in the current terminal directory
  cibyp-tui --mode=code --workspace="/your/project"
  cibyp --install-only          Repair the runtime and register the GUI launcher

npm installs the complete build for your platform, including GUI and Code-OSS.
Starts are offline; settings and history are shared with the installed App.
Use /help inside TUI. Set CIBYP_CACHE_DIR to move the runtime cache.`);
    return;
  }
  let manifest;
  try {
    manifest = require('../runtime.json');
  } catch {
    throw new Error('This npm package is missing its release manifest; reinstall cibyp from npm');
  }
  if (manifest.version !== pkg.version)
    throw new Error('The npm package and its runtime have different versions');
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Runtime installation cancelled'));
  process.once('SIGINT', interrupt);
  let runtime;
  try {
    runtime = await ensureRuntime(manifest, { signal: controller.signal });
    if (args.includes('--install-only')) await require('./desktop.cjs').registerDesktop(runtime);
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
  if (!args.includes('--install-only')) process.exitCode = await startRuntime(mode, args, runtime);
}

module.exports = {
  main,
  ensureRuntime,
  startRuntime,
  selectTarget,
  inside,
  checksum,
  cacheDirectory,
  assembleArchive,
};
