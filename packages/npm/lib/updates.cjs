/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  cacheDirectory,
  runtimeDirectoryName,
  inside,
  selectTarget,
  usable,
  ensureRuntime,
  lockDirectory,
} = require('./runtime.cjs');
const { discoverRelease } = require('./releases.cjs');

async function readState({ env = process.env, platform = process.platform } = {}) {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(cacheDirectory(env, platform), 'current.json'), 'utf8'),
    );
    if (!['stable', 'preview'].includes(value.channel)) throw new Error('Invalid cached channel');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT')
      console.error('[cibyp] Ignoring invalid launcher state: ' + error.message);
    return { channel: 'preview', checkedAt: 0 };
  }
}
async function writeState(base, state) {
  const temporary = inside(base, 'current-' + crypto.randomUUID() + '.json');
  try {
    await fs.writeFile(temporary, JSON.stringify(state) + '\n');
    await fs.rename(temporary, path.join(base, 'current.json'));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function cachedRuntime(state, options) {
  if (!state.manifest) return null;
  try {
    const asset = selectTarget(state.manifest, options.platform, options.arch);
    const directory = inside(
      cacheDirectory(options.env, options.platform),
      runtimeDirectoryName(state.manifest, options.platform, options.arch, asset),
    );
    return (await usable(directory, asset)) ? { directory, asset } : null;
  } catch {
    return null;
  }
}
async function resolveRuntime({
  force = false,
  offline = false,
  channel,
  signal,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  now = Date.now,
  discover = discoverRelease,
  ensure = ensureRuntime,
  log = (message) => console.error(message),
} = {}) {
  if (channel && !['stable', 'preview'].includes(channel))
    throw new Error('Channel must be stable or preview');
  if (force && offline) throw new Error('An update requires network access; remove --no-update');
  const options = { env, platform, arch };
  const base = cacheDirectory(env, platform);
  await fs.mkdir(base, { recursive: true });
  let state = await readState(options);
  let cached = await cachedRuntime(state, options);
  const fresh = (value) =>
    now() >= value.checkedAt &&
    now() - value.checkedAt < (value.failedCheck ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000);
  if (offline) {
    if (channel && channel !== state.channel)
      throw new Error('Changing the channel requires network access');
    if (!cached) throw new Error('No verified runtime is cached; run cibyp update while online');
    return cached;
  }
  if (cached && !force && (!channel || channel === state.channel) && fresh(state)) return cached;
  const unlock = await lockDirectory(inside(base, 'update.lock'), { signal, log });
  try {
    // Another launcher may have finished while this process waited for the lock.
    state = await readState(options);
    cached = await cachedRuntime(state, options);
    const selected = channel || state.channel;
    if (cached && !force && selected === state.channel && fresh(state)) return cached;
    try {
      const mirrors =
        env.CIBYP_MIRRORS === 'off'
          ? []
          : env.CIBYP_MIRRORS?.split(',')
              .map((value) => value.trim())
              .filter(Boolean);
      const manifest = await discover({ channel: selected, signal, mirrors });
      selectTarget(manifest, platform, arch);
      const concurrency = env.CIBYP_DOWNLOAD_CONCURRENCY
        ? Number(env.CIBYP_DOWNLOAD_CONCURRENCY)
        : 4;
      const runtime = await ensure(manifest, { ...options, signal, mirrors, concurrency, log });
      await writeState(base, { channel: selected, checkedAt: now(), manifest });
      return runtime;
    } catch (error) {
      signal?.throwIfAborted();
      if (force || !cached || selected !== state.channel) throw error;
      await writeState(base, { ...state, checkedAt: now(), failedCheck: true });
      log('[cibyp] Update check failed; using the previously verified runtime: ' + error.message);
      return cached;
    }
  } finally {
    await unlock();
  }
}
module.exports = { resolveRuntime, readState, writeState, cachedRuntime };
