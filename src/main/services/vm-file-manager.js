/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { shellQuote } = require('../vm/vm-paths');

class VmFileManager {
  constructor(vmService) {
    this.vmService = vmService;
    this.active = null;
  }
  async io(side) {
    if (!['host', 'vm'].includes(side)) throw new Error('Invalid file pane');
    if (side === 'host') return fs.promises;
    if (this.vmService.instance?.state !== 'ready') await this.vmService.start();
    return this.vmService.instance.sftp();
  }
  target(side, value) {
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid file path');
    if (side === 'host') return path.resolve(value);
    if (!value.startsWith('/')) throw new Error('VM path must be absolute');
    return path.posix.normalize(value);
  }
  async noLinks(side, value) {
    const io = await this.io(side),
      absolute = this.target(side, value);
    const parser = side === 'host' ? path : path.posix;
    let current = parser.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(parser.sep).filter(Boolean)) {
      current = parser.join(current, part);
      try {
        if ((await io.lstat(current)).isSymbolicLink())
          throw new Error('Symbolic links cannot be transferred: ' + current);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 2) throw error;
      }
    }
    return absolute;
  }
  async list(side, directory) {
    const io = await this.io(side);
    const absolute = this.target(
      side,
      directory ||
        (side === 'host' ? os.homedir() : this.vmService.runtime.vm.workspaceMount || '/workspace'),
    );
    const items =
      side === 'host'
        ? await io.readdir(absolute, { withFileTypes: true })
        : await io.readdir(absolute);
    const entries = await Promise.all(
      items
        .filter((item) => !['.', '..'].includes(item.name || item.filename))
        .map(async (item) => {
          const name = item.name || item.filename;
          const child = (side === 'host' ? path : path.posix).join(absolute, name);
          const stat = item.attrs || (await io.lstat(child));
          return {
            name,
            path: child,
            directory: stat.isDirectory(),
            link: stat.isSymbolicLink(),
            size: stat.size,
            modified: stat.mtimeMs || stat.mtime * 1000,
          };
        }),
    );
    entries.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    const parent = (side === 'host' ? path : path.posix).dirname(absolute);
    return { ok: true, path: absolute, parent, entries };
  }
  async mkdir(side, directory, name) {
    if (!name || /[/\\\0]/.test(name) || ['.', '..'].includes(name))
      throw new Error('Invalid folder name');
    const target = await this.noLinks(
      side,
      (side === 'host' ? path : path.posix).join(this.target(side, directory), name),
    );
    await (await this.io(side)).mkdir(target);
    return { ok: true };
  }
  async transfer({ from, paths, destination, overwrite = false }, progress = () => {}) {
    if (this.active) throw new Error('A transfer is already running');
    if (!Array.isArray(paths) || !paths.length || paths.length > 10000)
      throw new Error('Select files or folders to transfer');
    const to = from === 'host' ? 'vm' : 'host';
    const controller = new AbortController();
    this.active = controller;
    this.vmService._manualTransfers = (this.vmService._manualTransfers || 0) + 1;
    const stats = { files: 0, bytes: 0, skipped: [], current: '' };
    let lastProgress = 0;
    const report = () => {
      if (Date.now() - lastProgress > 100) {
        lastProgress = Date.now();
        progress({ ...stats });
      }
    };
    try {
      const sourceIo = await this.io(from),
        targetIo = await this.io(to);
      const dest = await this.noLinks(to, destination);
      if (!(await targetIo.stat(dest)).isDirectory())
        throw new Error('Transfer destination must be a directory');
      const copy = async (source, target) => {
        controller.signal.throwIfAborted();
        await this.noLinks(from, source);
        await this.noLinks(to, target);
        const stat = await sourceIo.lstat(source);
        if (stat.isSymbolicLink()) throw new Error('Symbolic links cannot be transferred');
        let existing;
        try {
          existing = await targetIo.lstat(target);
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 2) throw error;
        }
        if (existing?.isSymbolicLink()) throw new Error('Destination is a symbolic link');
        if (stat.isDirectory()) {
          if (existing && !existing.isDirectory())
            throw new Error('File/folder collision: ' + target);
          if (!existing) await targetIo.mkdir(target);
          const entries =
            from === 'host'
              ? await sourceIo.readdir(source)
              : (await sourceIo.readdir(source)).map((entry) => entry.filename);
          for (const name of entries) {
            if (!name || ['.', '..'].includes(name) || /[/\\\0]/.test(name)) continue;
            await copy(
              (from === 'host' ? path : path.posix).join(source, name),
              (to === 'host' ? path : path.posix).join(target, name),
            );
          }
          return;
        }
        if (!stat.isFile() || existing?.isDirectory())
          throw new Error('Unsupported file type: ' + source);
        if (existing && !overwrite) {
          stats.skipped.push(target);
          return;
        }
        const temporary = (to === 'host' ? path : path.posix).join(
          (to === 'host' ? path : path.posix).dirname(target),
          '.cibyp-transfer-' + crypto.randomBytes(8).toString('hex'),
        );
        stats.current = source;
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            stats.bytes += chunk.length;
            report();
            callback(null, chunk);
          },
        });
        try {
          const input =
            from === 'host' ? fs.createReadStream(source) : sourceIo.createReadStream(source);
          const output =
            to === 'host'
              ? fs.createWriteStream(temporary, { flags: 'wx', mode: stat.mode & 0o777 })
              : targetIo.createWriteStream(temporary, { flags: 'wx', mode: stat.mode & 0o777 });
          await pipeline(input, meter, output, { signal: controller.signal });
          const after = await sourceIo.lstat(source);
          if (
            after.size !== stat.size ||
            (after.mtimeMs || after.mtime) !== (stat.mtimeMs || stat.mtime)
          )
            throw new Error('Source changed during transfer: ' + source);
          await this.noLinks(to, target);
          let current;
          try {
            current = await targetIo.lstat(target);
          } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 2) throw error;
          }
          if (
            Boolean(current) !== Boolean(existing) ||
            (current &&
              (current.size !== existing.size ||
                (current.mtimeMs || current.mtime) !== (existing.mtimeMs || existing.mtime)))
          )
            throw new Error('Destination changed during transfer: ' + target);
          if (to === 'host') await targetIo.rename(temporary, target);
          else {
            const result = await this.vmService.instance.exec(
              'node -e ' +
                shellQuote(
                  `require('node:fs').renameSync(${JSON.stringify(temporary)},${JSON.stringify(target)})`,
                ),
              { timeoutMs: 20000 },
            );
            if (!result.ok) throw new Error(result.stderr || 'VM could not finalize transfer');
          }
          stats.files++;
          report();
        } finally {
          await targetIo.unlink(temporary).catch(() => {});
        }
      };
      for (const item of paths) {
        const source = this.target(from, item);
        const basename = (from === 'host' ? path : path.posix).basename(source);
        if (!basename) throw new Error('Select a folder inside a filesystem root');
        await copy(source, (to === 'host' ? path : path.posix).join(dest, basename));
      }
      progress({ ...stats, complete: true });
      return { ok: true, ...stats };
    } finally {
      this.active = null;
      this.vmService._manualTransfers--;
    }
  }
  cancel() {
    this.active?.abort();
    return { ok: true };
  }
}

function registerVmFileManager({ ipcMain, BrowserWindow, vmService, getSettings, systemDark }) {
  let win;
  const manager = new VmFileManager(vmService);
  ipcMain.handle('vm-files:open', () => {
    if (win && !win.isDestroyed()) {
      win.focus();
      return { ok: true };
    }
    const theme = getSettings().theme || {};
    win = new BrowserWindow({
      width: 1100,
      height: 740,
      minWidth: 720,
      minHeight: 480,
      show: false,
      frame: false,
      title: 'VM Files | CIBYP',
      backgroundColor: theme.backgroundColor || (systemDark() ? '#17181d' : '#f5f7fa'),
      icon: path.join(__dirname, '../../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../../preload/generated/vm-file-manager-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const created = win;
    win.once('ready-to-show', () => {
      if (!created.isDestroyed()) created.show();
    });
    win.on('closed', () => {
      manager.cancel();
      win = null;
    });
    win
      .loadFile(path.join(__dirname, '../../renderer/pages/vm-file-manager.html'))
      .catch((error) => console.error('[vm-files]', error.message));
    return { ok: true };
  });
  for (const action of ['list', 'mkdir', 'transfer', 'cancel', 'window', 'initial']) {
    ipcMain.handle('vm-files:' + action, async (event, payload = {}) => {
      if (
        !(event.sender?.id === -1 && event.frameId === -1) &&
        (!win ||
          win.isDestroyed() ||
          event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame)
      )
        return { ok: false, error: 'Unauthorized file manager request' };
      try {
        if (action === 'initial')
          return {
            ok: true,
            language: getSettings().language,
            theme: getSettings().theme,
            shouldUseDarkColors: systemDark(),
            host: vmService.workspaceRoot || os.homedir(),
            vm: vmService.runtime.vm.workspaceMount || '/workspace',
          };
        if (action === 'window') {
          if (payload.action === 'close') win.close();
          else if (payload.action === 'minimize') win.minimize();
          else if (payload.action === 'maximize')
            win.isMaximized() ? win.unmaximize() : win.maximize();
          return { ok: true };
        }
        if (action === 'list') return await manager.list(payload.side, payload.path);
        if (action === 'mkdir')
          return await manager.mkdir(payload.side, payload.path, payload.name);
        if (action === 'cancel') return manager.cancel();
        return await manager.transfer(payload, (progress) => {
          if (event.sender?.id === -1) event.sender.send('vm-files:progress', progress);
          if (win && !win.isDestroyed()) win.webContents.send('vm-files:progress', progress);
        });
      } catch (error) {
        return {
          ok: false,
          error: error.name === 'AbortError' ? 'Transfer canceled' : error.message,
        };
      }
    });
  }
  return manager;
}
module.exports = { VmFileManager, registerVmFileManager };
