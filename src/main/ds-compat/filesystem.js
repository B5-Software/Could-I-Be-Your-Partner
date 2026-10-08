/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { FileSystem, FsError } = require('@deepseek-ai/dsh-fs');
const { currentExecution } = require('./execution-context');
const { TextDecoder } = require('node:util');
const sandboxRunner = require('../sandbox-runner');

function aborted(signal) {
  if (signal?.aborted) throw new FsError('Operation aborted', 'FS_ABORTED');
}
function filePath(target) {
  const value = typeof target === 'string' ? target : target?.targetKey;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw new FsError('Invalid filesystem target', 'FS_NOT_FOUND');
  return value;
}
function version(st) {
  return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':');
}
function info(st, noFollow = false) {
  return {
    version: version(st),
    type:
      noFollow && st.isSymbolicLink()
        ? 'symlink'
        : st.isFile()
          ? 'file'
          : st.isDirectory()
            ? 'directory'
            : 'other',
    size: Number(st.size),
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    mtimeMs: Number(st.mtimeMs),
  };
}
function text(bytes) {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.includes('\0')) throw Error('binary');
    return value;
  } catch {
    throw new FsError('File is binary or is not valid UTF-8 text', 'FS_NOT_TEXT');
  }
}
const normalize = (s) => s.replace(/\r\n/g, '\n');
class CibypFileSystem extends FileSystem {
  constructor(ctx, options = {}) {
    super(ctx);
    this.options = options;
    this.locks = new Map();
  }
  base() {
    return currentExecution().cwd || this.options.cwd || process.cwd();
  }
  get sandboxMode() {
    // Advertise the enforcing provider even when its current mode is permissive.
    // Native tools then retain a policy and can render FS_SANDBOX_DENIED after
    // a live setting change instead of assuming an unconstrained filesystem.
    return this.ctx.root.get('sandboxPolicy')?.defaultMode || 'danger-full-access';
  }
  async authorize(target, supplied) {
    const exec = currentExecution();
    const settings = (await this.options.getSettings?.()) || {};
    const own = sandboxRunner.policyForCall(
      settings,
      exec.mode || exec.agent?.mode || 'chat',
      exec.cwd || this.options.cwd,
    );
    // A plugin may tighten a call's policy; it cannot weaken the application's policy.
    const policy = own.mode === 'danger-full-access' ? supplied || own : own;
    if (
      policy.mode === 'read-only' ||
      (policy.mode === 'workspace-write' &&
        (!policy.workspaceRoot || !this.contains(policy.workspaceRoot, target)))
    )
      throw new FsError(
        'CIBYP sandbox policy does not permit writing this target',
        'FS_SANDBOX_DENIED',
      );
    if (this.options.authorizeWrite) await this.options.authorizeWrite(target, policy, exec);
  }
  async resolve(input, opts = {}) {
    aborted(opts.signal);
    if (typeof input !== 'string' || !input.trim() || input.includes('\0'))
      throw new FsError('Path must be non-empty', 'FS_NOT_FOUND');
    const absolute = path.resolve(opts.cwd || this.base(), input);
    let current = absolute;
    const tail = [];
    // Canonicalize existing ancestors even when the requested child is absent.
    while (true) {
      try {
        current = await fsp.realpath(current);
        break;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(current) === current)
          throw error;
        tail.unshift(path.basename(current));
        current = path.dirname(current);
      }
    }
    aborted(opts.signal);
    return { targetKey: path.join(current, ...tail), displayPath: absolute };
  }
  processPath(target) {
    return filePath(target);
  }
  processPathFromHostPath(input) {
    return path.isAbsolute(input) ? path.resolve(input) : undefined;
  }
  fileUrl(target) {
    return pathToFileURL(filePath(target)).href;
  }
  contains(parent, child) {
    const rel = path.relative(filePath(parent), filePath(child));
    return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  }
  async stat(target, signal) {
    aborted(signal);
    try {
      const st = await fsp.stat(filePath(target), { bigint: true });
      aborted(signal);
      return info(st);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    }
  }
  async lstat(input, opts = {}, signal) {
    aborted(signal);
    try {
      const st = await fsp.lstat(path.resolve(opts.cwd || this.base(), input), { bigint: true });
      aborted(signal);
      return info(st, true);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined;
      throw error;
    }
  }
  async regular(target, signal) {
    const meta = await this.stat(target, signal);
    if (!meta) throw new FsError('File does not exist', 'FS_NOT_FOUND');
    if (meta.type !== 'file')
      throw new FsError('Target is not a regular file', 'FS_NOT_REGULAR_FILE');
    return meta;
  }
  async readText(target, signal) {
    await this.regular(target, signal);
    const result = text(await fsp.readFile(filePath(target), { signal }));
    aborted(signal);
    return result;
  }
  async streamText(target, signal) {
    await this.regular(target, signal);
    return (async function* () {
      const stream = fs.createReadStream(filePath(target), { signal });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        for await (const chunk of stream) {
          aborted(signal);
          const value = decoder.decode(chunk, { stream: true });
          if (value.includes('\0')) throw new FsError('File is binary', 'FS_NOT_TEXT');
          yield value;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
      } catch (error) {
        if (error instanceof TypeError) throw new FsError('Invalid UTF-8 text', 'FS_NOT_TEXT');
        throw error;
      } finally {
        stream.destroy();
      }
    })();
  }
  async readBytes(target, signal, maximum) {
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new FsError('Invalid byte bound', 'FS_TOO_LARGE');
    const meta = await this.regular(target, signal);
    if (meta.size > maximum) throw new FsError('File exceeds byte limit', 'FS_TOO_LARGE');
    const handle = await fsp.open(filePath(target), 'r');
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        aborted(signal);
        size += chunk.length;
        if (size > maximum) throw new FsError('File exceeds byte limit', 'FS_TOO_LARGE');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      await handle.close();
    }
  }
  async readByteRange(target, range, signal) {
    if (![range?.offset, range?.length].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new FsError('Invalid byte range', 'FS_IO_ERROR');
    await this.regular(target, signal);
    const handle = await fsp.open(filePath(target), 'r');
    try {
      const result = Buffer.alloc(range.length);
      let size = 0;
      while (size < result.length) {
        aborted(signal);
        const r = await handle.read(result, size, result.length - size, range.offset + size);
        if (!r.bytesRead) break;
        size += r.bytesRead;
      }
      return result.subarray(0, size);
    } finally {
      await handle.close();
    }
  }
  async listDir(target, signal) {
    aborted(signal);
    const names = (await fsp.readdir(filePath(target))).sort();
    const result = [];
    for (const name of names) {
      aborted(signal);
      const child = await this.resolve(path.join(filePath(target), name));
      const meta = await this.stat(child, signal);
      if (meta) result.push({ name, target: child, ...meta });
    }
    return result;
  }
  async watch(target, changed, signal) {
    aborted(signal);
    const directory = (await this.stat(target, signal))?.type === 'directory';
    const observed = filePath(target);
    const watcher = fs.watch(directory ? observed : path.dirname(observed), (_, name) => {
      if (directory || !name || name.toString() === path.basename(observed)) changed();
    });
    watcher.on('error', changed);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      watcher.close();
    };
    this.ctx.effect(() => close);
    return close;
  }
  async locked(target, task) {
    const key = filePath(target),
      prev = this.locks.get(key) || Promise.resolve();
    const operation = prev.then(task, task);
    const tail = operation.then(
      () => {},
      () => {},
    );
    this.locks.set(key, tail);
    try {
      return await operation;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
  async guard(target, expected, signal) {
    const meta = await this.stat(target, signal);
    if (meta && meta.type !== 'file')
      throw new FsError('Target is not a regular file', 'FS_NOT_REGULAR_FILE');
    if (expected?.kind === 'createIfAbsent' && meta)
      throw new FsError('Target already exists', 'FS_NOT_OBSERVED');
    if (expected?.version && meta?.version !== expected.version)
      throw new FsError('File changed since it was observed', 'FS_STALE_VERSION');
    return meta;
  }
  async publish(target, content, signal, expected) {
    aborted(signal);
    const file = filePath(target);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), '.cibyp-write-' + randomUUID());
    const previous = await fsp.stat(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    try {
      await fsp.writeFile(temporary, content, {
        encoding: 'utf8',
        mode: previous?.mode || 0o600,
        flag: 'wx',
        signal,
      });
      aborted(signal);
      await this.guard(target, expected, signal);
      if (expected?.kind === 'createIfAbsent') await fsp.link(temporary, file);
      else await fsp.rename(temporary, file);
    } catch (error) {
      if (error.code === 'EEXIST') throw new FsError('Target already exists', 'FS_NOT_OBSERVED');
      throw error;
    } finally {
      await fsp.rm(temporary, { force: true });
    }
  }
  writeText(target, content, expected, signal, sandboxPolicy) {
    return this.locked(target, async () => {
      await this.authorize(target, sandboxPolicy);
      const meta = await this.guard(target, expected, signal);
      let before = null;
      if (meta && meta.size < 10 * 1024 * 1024)
        try {
          before = normalize(await this.readText(target, signal));
        } catch (error) {
          if (error.code !== 'FS_NOT_TEXT') throw error;
        }
      await this.publish(target, content, signal, expected);
      return {
        operation: meta ? 'update' : 'create',
        before,
        after: normalize(content),
        version: (await this.stat(target)).version,
      };
    });
  }
  editText(target, edit, expected, signal, sandboxPolicy) {
    return this.locked(target, async () => {
      await this.authorize(target, sandboxPolicy);
      await this.guard(target, expected, signal);
      const raw = await this.readText(target, signal),
        before = normalize(raw);
      const old = normalize(edit.oldString),
        replacement = normalize(edit.newString);
      if (!old) throw new FsError('oldString must be non-empty', 'FS_EDIT_NOT_FOUND');
      const matches = before.split(old).length - 1;
      if (!matches) throw new FsError('No matching text', 'FS_EDIT_NOT_FOUND');
      if (!edit.replaceAll && matches !== 1)
        throw new FsError('Edit matches more than once', 'FS_AMBIGUOUS_EDIT');
      const after = edit.replaceAll
        ? before.split(old).join(replacement)
        : before.replace(old, () => replacement);
      await this.publish(
        target,
        raw.includes('\r\n') ? after.replace(/\n/g, '\r\n') : after,
        signal,
        expected,
      );
      return { before, after, version: (await this.stat(target)).version };
    });
  }
}
module.exports = { CibypFileSystem };
