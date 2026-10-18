/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function workspaceName(value) {
  const name = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
    .slice(0, 64);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    throw new Error('Choose a descriptive directory name');
  return name;
}

/** Only explicitly owned directories are renamed/cleaned. Stable aliases protect
 * running commands, history paths, VM mappings and the admitted prompt prefix. */
class WorkspaceLifecycle {
  constructor({ root, file, vmService, activePaths = () => [], busyPaths = () => [] }) {
    this.root = path.resolve(root);
    this.file = file;
    this.vm = vmService;
    this.activePaths = activePaths;
    try {
      this.records = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!this.records || typeof this.records !== 'object' || Array.isArray(this.records))
        this.records = {};
    } catch {
      this.records = {};
    }
    this.locks = new Set();
    this.busyPaths = busyPaths;
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.records, null, 2));
    fs.renameSync(temp, this.file);
  }
  register(directory, location = 'host', hostPath = null) {
    if (!directory || this.records[directory]) return;
    const hostOwned =
      location === 'vm' && hostPath && path.dirname(path.resolve(hostPath)) === this.root;
    this.records[directory] = {
      path: directory,
      actual: hostOwned ? hostPath : directory,
      storage: hostOwned ? hostPath : directory,
      vmPath: hostOwned ? directory : null,
      hostPath,
      location: hostOwned ? 'host' : location,
      created: Date.now(),
      hasChat: false,
      name: '',
    };
    this.save();
  }
  retain(directory, hasChat = true) {
    const record = this.records[directory];
    if (!record) return { ok: true, managed: false };
    record.hasChat = hasChat === true;
    this.save();
    return { ok: true, managed: true };
  }
  record(directory) {
    return (
      this.records[directory] ||
      Object.values(this.records).find((r) => r.actual === directory || r.displayPath === directory)
    );
  }
  async adoptLegacy(historyDirectories = []) {
    // One-time migration is conservative: only old generated names, empty
    // directories and a complete readable history scan establish ownership.
    const referenced = new Set();
    let scanned = 0;
    const scan = async (directory) => {
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (++scanned > 100000) throw new Error('History scan incomplete; skipping legacy cleanup');
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(file);
        else if (entry.name.endsWith('.json')) {
          const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
          if (data.workspacePath) referenced.add(data.workspacePath);
          if (data.workspace) referenced.add(data.workspace);
        }
      }
    };
    for (const directory of historyDirectories) await scan(directory);
    for (const entry of await fs.promises.readdir(this.root, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !/^(?:[a-z0-9]{8,}_[a-z0-9]{3,8}|[a-f0-9]{16,64})$/.test(entry.name)
      )
        continue;
      const directory = path.join(this.root, entry.name);
      if (
        !referenced.has(directory) &&
        !this.record(directory) &&
        !(await fs.promises.readdir(directory)).length
      )
        this.register(directory);
    }
  }
  io(record) {
    if (record.location !== 'vm') return Promise.resolve(fs.promises);
    if (this.vm?.instance?.state !== 'ready') throw new Error('VM is not ready');
    return this.vm.instance.sftp();
  }
  allowed(record, target) {
    const parser = record.location === 'vm' ? path.posix : path;
    const root =
      record.location === 'vm' ? this.vm?.runtime?.vm?.workspaceMount || '/workspace' : this.root;
    return parser.dirname(parser.resolve(target)) === parser.resolve(root);
  }
  async inspect(directory) {
    const record = this.record(directory);
    if (!record)
      return {
        ok: true,
        managed: false,
        path: directory,
        name:
          String(directory || '')
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .pop() || '',
      };
    const io = await this.io(record.vmPath ? { location: 'vm' } : record);
    const entries = (await io.readdir(record.vmPath || record.actual)).filter(
      (entry) => (typeof entry === 'string' ? entry : entry.filename) !== '.cibyp-code-history',
    );
    return {
      ok: true,
      managed: true,
      path: record.path,
      displayPath: record.displayPath || record.actual,
      name: record.name,
      needsNaming: !record.name && entries.length > 0,
      empty: entries.length === 0,
    };
  }
  async removeLink(io, record, target) {
    if (!this.allowed(record, target)) throw new Error('Workspace alias is outside its owned root');
    if (!(await io.lstat(target)).isSymbolicLink()) throw new Error('Expected a workspace alias');
    if (record.location === 'host' && process.platform === 'win32') await io.rmdir(target);
    else await io.unlink(target);
  }
  async link(io, record, target, alias) {
    if (record.location === 'host')
      return io.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return io.symlink(target, alias);
  }
  async recover() {
    for (const record of Object.values(this.records)) {
      const pending = record.pendingRename;
      if (this.locks.has(record.path)) continue;
      if (!pending || !this.allowed(record, pending.from) || !this.allowed(record, pending.to))
        continue;
      if (record.location === 'vm' && this.vm?.instance?.state !== 'ready') continue;
      const io = await this.io(record),
        stable = record.storage || record.path;
      let destination;
      try {
        destination = await io.lstat(pending.to);
      } catch (error) {
        if (!['ENOENT', 2].includes(error.code)) throw error;
      }
      if (destination?.isDirectory() && !destination.isSymbolicLink()) {
        let from;
        try {
          from = await io.lstat(pending.from);
        } catch (error) {
          if (!['ENOENT', 2].includes(error.code)) throw error;
        }
        if (from && !from.isSymbolicLink())
          throw new Error('Workspace rename recovery found two storage directories');
        try {
          await this.removeLink(io, record, stable);
        } catch (error) {
          if (!['ENOENT', 2].includes(error.code)) throw error;
        }
        await this.link(io, record, pending.to, stable);
        record.actual = pending.to;
        record.displayPath = pending.to;
        record.name = pending.name;
      } else if (destination?.isSymbolicLink()) {
        // A busy Windows directory kept its original storage and a semantic alias.
        record.displayPath = pending.to;
        record.name = pending.name;
      }
      delete record.pendingRename;
      this.save();
    }
  }
  async rename(directory, value) {
    const record = this.record(directory);
    if (!record || !this.allowed(record, record.actual))
      return {
        ok: false,
        code: 'EXTERNAL_WORKSPACE',
        error:
          'Only automatically created workspace directories can be renamed; keep user-selected project names unchanged',
      };
    if (this.locks.has(record.path)) throw new Error('Workspace is already being renamed');
    const name = workspaceName(value),
      parser = record.location === 'vm' ? path.posix : path;
    if (record.name === name) return { ok: true, ...(await this.inspect(record.path)) };
    this.locks.add(record.path);
    let io;
    const old = record.actual,
      stable = record.storage || record.path;
    const suffix = crypto.createHash('sha256').update(record.path).digest('hex').slice(0, 6);
    const destination = parser.join(parser.dirname(old), name + '-' + suffix);
    let moved = false,
      newAlias = false;
    const before = { ...record };
    try {
      io = await this.io(record);
      try {
        await io.lstat(destination);
        throw new Error('A directory with this name already exists');
      } catch (error) {
        if (!['ENOENT', 2].includes(error.code)) throw error;
      }
      const stat = await io.lstat(old);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Workspace storage is not an owned directory');
      // Stage a link at the new name first. If Windows has the directory locked,
      // this useful semantic path remains available without moving live storage.
      if (record.location === 'host')
        await io.symlink(old, destination, process.platform === 'win32' ? 'junction' : 'dir');
      else await io.symlink(old, destination);
      newAlias = true;
      await this.removeLink(io, record, destination);
      newAlias = false;
      record.pendingRename = { from: old, to: destination, name };
      this.save(); // Durable intent closes the crash window between rename and alias creation.
      try {
        await io.rename(old, destination);
        moved = true;
      } catch (error) {
        if (record.location !== 'host' || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code))
          throw error;
        await io.symlink(old, destination, process.platform === 'win32' ? 'junction' : 'dir');
        newAlias = true;
      }
      if (moved) {
        // Retarget the stable path after repeated renames, or create it once.
        if (old !== stable) await this.removeLink(io, record, stable);
        if (record.location === 'host')
          await io.symlink(destination, stable, process.platform === 'win32' ? 'junction' : 'dir');
        else await io.symlink(destination, stable);
        record.actual = destination;
      }
      const staleDisplay = record.displayPath;
      record.name = name;
      record.displayPath = destination;
      record.namedAt = Date.now();
      delete record.pendingRename;
      this.save();
      if (staleDisplay && staleDisplay !== old && staleDisplay !== destination) {
        try {
          await this.removeLink(io, record, staleDisplay);
        } catch {
          /* obsolete alias may be busy */
        }
      }
      return {
        ok: true,
        path: record.path,
        name,
        displayPath: destination,
        actualPath: record.actual,
        method: moved ? 'rename-with-stable-alias' : 'semantic-alias',
        note: 'Continue using the stable workspace path for tools and commands. The semantic path is shown by the file manager; no prompt prefix is rewritten.',
      };
    } catch (error) {
      let restored = true;
      if (moved) {
        try {
          await this.removeLink(io, record, stable);
        } catch {
          /* absent */
        }
        try {
          await io.rename(destination, old);
          if (old !== stable) await this.link(io, record, old, stable);
        } catch {
          restored = false;
        }
      } else if (newAlias) {
        try {
          await this.removeLink(io, record, destination);
        } catch {
          /* absent */
        }
      }
      delete record.pendingRename;
      Object.assign(record, before);
      if (!restored) record.pendingRename = { from: old, to: destination, name };
      try {
        this.save();
      } catch {
        /* The durable intent remains available for recovery. */
      }
      throw error;
    } finally {
      this.locks.delete(record.path);
    }
  }
  async cleanup({ shutdown = false } = {}) {
    await this.recover();
    const active = new Set(shutdown ? [] : this.activePaths());
    const removed = [];
    for (const record of Object.values(this.records)) {
      if (
        record.hasChat ||
        record.pendingRename ||
        active.has(record.path) ||
        active.has(record.actual) ||
        this.busyPaths().includes(record.path) ||
        this.locks.has(record.path) ||
        !this.allowed(record, record.actual)
      )
        continue;
      if (record.location === 'vm' && this.vm?.instance?.state !== 'ready') continue;
      try {
        if (record.vmPath) {
          const mount = path.posix.resolve(this.vm?.runtime?.vm?.workspaceMount || '/workspace');
          const parent = path.posix.dirname(path.posix.resolve(record.vmPath));
          if (
            ![mount, path.posix.join(mount, '_external')].includes(parent) ||
            this.vm?.instance?.state !== 'ready' ||
            (await (await this.io({ location: 'vm' })).readdir(record.vmPath)).length
          )
            continue;
        }
        const io = await this.io(record),
          stat = await io.lstat(record.actual);
        // Never traverse a replaced workspace link before checking ownership,
        // including the internal history directory below it.
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        // Looking at Code history can create an empty internal directory.
        // Remove only that empty directory; history payloads remain protected.
        if (record.location === 'host') {
          try {
            const history = path.join(record.actual, '.cibyp-code-history');
            if (!(await io.lstat(history)).isSymbolicLink()) {
              let names = await io.readdir(history);
              if (names.length === 1 && names[0] === 'index.json') {
                const indexFile = path.join(history, 'index.json');
                if (!(await io.lstat(indexFile)).isSymbolicLink()) {
                  const index = JSON.parse(await io.readFile(indexFile, 'utf8'));
                  if (index?.version === 2 && index.entries && !Object.keys(index.entries).length) {
                    await io.unlink(indexFile);
                    names = [];
                  }
                }
              }
              if (!names.length) await io.rmdir(history);
            }
          } catch {
            /* nonempty or absent */
          }
        }
        if (
          (await io.readdir(record.actual)).length ||
          record.hasChat ||
          this.locks.has(record.path) ||
          this.busyPaths().includes(record.path) ||
          (!shutdown && this.activePaths().includes(record.path))
        )
          continue;
        if (record.vmPath) await (await this.io({ location: 'vm' })).rmdir(record.vmPath);
        // rmdir is deliberately non-recursive and fails if a file appeared.
        await io.rmdir(record.actual);
        for (const alias of new Set([record.storage || record.path, record.displayPath]))
          if (alias && alias !== record.actual) {
            try {
              await this.removeLink(io, record, alias);
            } catch {
              /* absent */
            }
          }
        delete this.records[record.path];
        removed.push(record.path);
      } catch (error) {
        if (['ENOENT', 2].includes(error.code)) {
          delete this.records[record.path];
          removed.push(record.path);
        }
      }
    }
    if (removed.length) this.save();
    return { ok: true, removed };
  }
}
module.exports = { WorkspaceLifecycle, workspaceName };
