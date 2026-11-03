/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { createHash, randomUUID } = require('node:crypto'),
  zlib = require('node:zlib');
function createNativeRuntime(lock, resourceName) {
  const MAX_BINARY = 32 * 1024 * 1024,
    MAX_ARCHIVE = MAX_BINARY + 65536;
  const fail = (code) => {
    throw Object.assign(Error(code), { code });
  };
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  function target(platform = process.platform, arch = process.arch) {
    const key = platform + '-' + arch,
      value = lock.targets[key];
    if (!value) fail('NATIVE_TARGET_UNSUPPORTED');
    return { key, ...value };
  }
  function readRegular(file, maximum) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum)
      fail('NATIVE_BINARY_INVALID');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== stat.size) fail('NATIVE_BINARY_CHANGED');
    return bytes;
  }
  function executable(bytes, platform, arch) {
    target(platform, arch);
    if (bytes.length < 64 || bytes.length > MAX_BINARY) fail('NATIVE_BINARY_INVALID');
    if (platform === 'win32') {
      const pe = bytes.readUInt32LE(0x3c);
      if (
        bytes.toString('ascii', 0, 2) !== 'MZ' ||
        pe > bytes.length - 24 ||
        bytes.readUInt32LE(pe) !== 0x4550 ||
        bytes.readUInt16LE(pe + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64) ||
        !(bytes.readUInt16LE(pe + 22) & 2) ||
        bytes.readUInt16LE(pe + 22) & 0x2000
      )
        fail('NATIVE_BINARY_TARGET_MISMATCH');
    } else if (platform === 'darwin') {
      if (
        bytes.readUInt32LE(0) !== 0xfeedfacf ||
        bytes.readUInt32LE(4) !== (arch === 'x64' ? 0x01000007 : 0x0100000c) ||
        bytes.readUInt32LE(12) !== 2
      )
        fail('NATIVE_BINARY_TARGET_MISMATCH');
    } else {
      if (
        bytes.readUInt32BE(0) !== 0x7f454c46 ||
        bytes[4] !== 2 ||
        bytes[5] !== 1 ||
        bytes.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183) ||
        ![2, 3].includes(bytes.readUInt16LE(16))
      )
        fail('NATIVE_BINARY_TARGET_MISMATCH');
      const offset = bytes.readBigUInt64LE(32),
        size = bytes.readUInt16LE(54),
        count = bytes.readUInt16LE(56);
      if (
        offset > BigInt(bytes.length) ||
        size < 56 ||
        count > 1024 ||
        offset + BigInt(size * count) > BigInt(bytes.length)
      )
        fail('NATIVE_BINARY_INVALID');
      for (let i = 0; i < count; i++)
        if (bytes.readUInt32LE(Number(offset) + i * size) === 3)
          fail('NATIVE_LINUX_BINARY_NOT_STATIC');
    }
    return true;
  }
  function manifest(value, platform = process.platform, arch = process.arch) {
    const spec = target(platform, arch);
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.format !== lock.format ||
      value.protocol !== lock.protocol ||
      value.target !== spec.key ||
      value.rustTarget !== spec.rust ||
      value.engineVersion !== lock.engineVersion ||
      value.toolchain !== lock.toolchain ||
      value.binary !== spec.binary ||
      value.archive !== 'engine.gz' ||
      !['sha256', 'archiveSha256', 'sourceHash'].every((k) =>
        /^[a-f0-9]{64}$/.test(value[k] || ''),
      ) ||
      !Number.isSafeInteger(value.size) ||
      value.size < 64 ||
      value.size > MAX_BINARY ||
      !Number.isSafeInteger(value.archiveSize) ||
      value.archiveSize < 1 ||
      value.archiveSize > MAX_ARCHIVE
    )
      fail('NATIVE_MANIFEST_INVALID');
    return value;
  }
  function decode(folder, platform = process.platform, arch = process.arch) {
    const value = manifest(
      JSON.parse(readRegular(path.join(folder, 'manifest.json'), 65536).toString('utf8')),
      platform,
      arch,
    );
    const compressed = readRegular(path.join(folder, value.archive), MAX_ARCHIVE);
    if (compressed.length !== value.archiveSize || sha256(compressed) !== value.archiveSha256)
      fail('NATIVE_ARCHIVE_MISMATCH');
    let bytes;
    try {
      bytes = zlib.gunzipSync(compressed, { maxOutputLength: MAX_BINARY });
    } catch {
      fail('NATIVE_ARCHIVE_INVALID');
    }
    if (bytes.length !== value.size || sha256(bytes) !== value.sha256)
      fail('NATIVE_MANIFEST_MISMATCH');
    executable(bytes, platform, arch);
    return { manifest: value, bytes };
  }
  function privateDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('NATIVE_CACHE_INVALID');
  }
  function replaceCacheFile(temporary, binary, platform) {
    // Windows scanners can briefly hold a newly written executable without
    // delete-sharing. Keep the atomic replacement and verified old file intact;
    // never unlink an executable or remove its protection to work around a lock.
    const signal = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, binary);
        return;
      } catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        if (attempt === 5) fail('NATIVE_CACHE_BUSY');
        Atomics.wait(signal, 0, 0, 10 * 2 ** attempt);
      }
    }
  }
  function resolveManaged(resources, cache, platform = process.platform, arch = process.arch) {
    if (!path.isAbsolute(resources) || !path.isAbsolute(cache)) fail('NATIVE_STORAGE_INVALID');
    const folder = path.join(resources, resourceName);
    const value = manifest(
      JSON.parse(readRegular(path.join(folder, 'manifest.json'), 65536).toString('utf8')),
      platform,
      arch,
    );
    const directory = path.join(cache, value.target + '-' + value.sha256),
      binary = path.join(directory, value.binary);
    privateDirectory(cache);
    privateDirectory(directory);
    try {
      const bytes = readRegular(binary, MAX_BINARY);
      if (bytes.length === value.size && sha256(bytes) === value.sha256) {
        executable(bytes, platform, arch);
        if (platform !== 'win32' && (fs.statSync(binary).mode & 0o100) === 0)
          fs.chmodSync(binary, 0o700);
        return { binary, sha256: value.sha256, development: false, manifest: value };
      }
    } catch (error) {
      if (
        error.code !== 'ENOENT' &&
        !['NATIVE_BINARY_INVALID', 'NATIVE_BINARY_CHANGED'].includes(error.code)
      )
        throw error;
    }
    const { bytes } = decode(folder, platform, arch),
      temporary = path.join(directory, '.extract-' + randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o700);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (platform !== 'win32') fs.chmodSync(temporary, 0o700);
      replaceCacheFile(temporary, binary, platform);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    if (sha256(readRegular(binary, MAX_BINARY)) !== value.sha256) fail('NATIVE_CACHE_INVALID');
    return { binary, sha256: value.sha256, development: false, manifest: value };
  }
  return {
    lock,
    MAX_BINARY,
    MAX_ARCHIVE,
    target,
    readRegular,
    sha256,
    executable,
    manifest,
    decode,
    resolveManaged,
  };
}
module.exports = { createNativeRuntime };
