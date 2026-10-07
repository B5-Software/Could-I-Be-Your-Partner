/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

// This function is also executed by the guest's existing Node runtime. Keep its
// dependencies local so both sides use identical exclusions and content hashes.
async function scanDirectory(root, options = {}, cache = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const files = Object.create(null);
  const excludes = options.excludes || {};
  const extra = options.extra || [];
  const excluded = (rel) => {
    const value = rel.toLowerCase();
    const segments = value.split('/');
    return (
      (excludes.segments || []).some((item) => segments.includes(item.toLowerCase())) ||
      (!options.syncGit && segments.includes('.git')) ||
      (excludes.suffixes || []).some((item) => value.endsWith(item.toLowerCase())) ||
      (excludes.prefixes || []).some((item) => value.startsWith(item.toLowerCase())) ||
      extra.some((item) =>
        item.regex ? new RegExp(item.regex, item.flags).test(value) : value.includes(item.text),
      )
    );
  };
  const sameStat = (a, b) =>
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const transient = error => ['EBUSY', 'EAGAIN', 'EPERM', 'EACCES', 'ENOENT', 'FILE_CHANGED'].includes(error.code);
  const retry = async operation => {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (!transient(error) || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  };
  const walk = async (directory, prefix) => {
    let entries;
    try { entries = await retry(() => fs.promises.readdir(directory, { withFileTypes: true })); }
    catch (error) {
      if (!prefix || !transient(error)) throw error;
      files[prefix] = { skipped: 'unavailable-directory', code: error.code };
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded(rel)) continue;
      if (entry.isSymbolicLink()) { files[rel] = { skipped: 'symbolic-link' }; continue; }
      const abs = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) { files[rel] = { skipped: 'unsupported-type' }; continue; }
      try {
        files[rel] = await retry(async () => {
          const before = await fs.promises.lstat(abs);
          if (!before.isFile() || before.isSymbolicLink() || before.size > options.maxBytes)
            return { skipped: before.size > options.maxBytes ? 'size-limit' : 'unsupported-type', size: before.size };
          const previous = cache[rel];
          let hash = previous?.hash;
          if (!hash || !sameStat(before, previous)) {
            const digest = crypto.createHash('sha256');
            for await (const chunk of fs.createReadStream(abs)) digest.update(chunk);
            hash = digest.digest('hex');
          }
          const after = await fs.promises.lstat(abs);
          if (!sameStat(before, after)) throw Object.assign(new Error('File changed during scan: ' + rel), { code: 'FILE_CHANGED' });
          return { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, hash };
        });
      } catch (error) {
        if (!transient(error)) throw error;
        // An explicit marker blocks both transfer and deletion, including all
        // descendants, until a later scan can establish a valid snapshot.
        files[rel] = { skipped: 'unavailable-file', code: error.code };
      }
    }
  };
  await walk(root, '');
  return files;
}

function guestScanScript(root, options, cacheFile) {
  return `(${async function guest(root, options, cacheFile, scan) {
    const fs = require('node:fs').promises;
    let cache = {};
    try {
      cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    } catch {
      /* cold scan */
    }
    const files = await scan(root, options, cache);
    const temporary = cacheFile + '.tmp-' + process.pid;
    await fs.writeFile(temporary, JSON.stringify(files), { mode: 0o600 });
    await fs.rename(temporary, cacheFile);
    process.stdout.write(JSON.stringify(files));
  }.toString()})(${JSON.stringify(root)},${JSON.stringify(options)},${JSON.stringify(cacheFile)},${scanDirectory.toString()}).catch(error => { console.error(error.message); process.exitCode = 1; });`;
}

module.exports = { scanDirectory, guestScanScript };
