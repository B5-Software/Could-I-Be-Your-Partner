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
  const walk = async (directory, prefix) => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded(rel) || entry.isSymbolicLink()) continue;
      const abs = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const before = await fs.promises.lstat(abs);
      if (!before.isFile() || before.isSymbolicLink() || before.size > options.maxBytes) continue;
      const previous = cache[rel];
      let hash = previous?.hash;
      if (!hash || !sameStat(before, previous)) {
        const digest = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(abs)) digest.update(chunk);
        hash = digest.digest('hex');
      }
      const after = await fs.promises.lstat(abs);
      if (!sameStat(before, after)) throw new Error(`同步扫描期间文件发生变化: ${rel}`);
      files[rel] = { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, hash };
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
