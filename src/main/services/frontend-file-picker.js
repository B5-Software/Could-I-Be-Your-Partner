/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { VmFs } = require('../vm/vm-fs');
function registerFrontendFilePicker({ ipcMain, vmService, getSettings }) {
  function io() {
    const vm = require('../vm/tool-location').isVmOperation(() => vmService);
    if (vm)
      return {
        vm,
        fs: new VmFs({ vmService }),
        path: path.posix,
        normalize: (raw) => new VmFs({ vmService }).toVm(raw),
      };
    return {
      vm,
      path,
      normalize: (raw) => path.resolve(String(raw)),
      fs: {
        stat: async (raw) => {
          const s = await fs.stat(raw);
          return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size };
        },
        listDirectory: async (raw) => ({
          ok: true,
          entries: (await fs.readdir(raw, { withFileTypes: true })).map((e) => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
          })),
        }),
        makeDirectory: async (raw) => {
          await fs.mkdir(raw, { recursive: true });
          return { ok: true };
        },
      },
    };
  }
  ipcMain.handle('filePicker:prepare', async (_event, save, options = {}) => {
    const target = io();
    let directory = target.normalize(
      options.defaultPath || (target.vm ? '/workspace' : os.homedir()),
    );
    if (save || !(await target.fs.stat(directory).catch(() => null))?.isDirectory)
      directory = target.path.dirname(directory);
    return {
      save: !!save,
      directory: (options.properties || []).includes('openDirectory'),
      initial: directory.replace(/\\/g, '/'),
      filename: save ? target.path.basename(options.defaultPath || 'untitled') : '',
      title: options.title || (save ? '保存文件' : '打开文件'),
      filters: options.filters || [],
      theme: getSettings().theme || {},
    };
  });
  ipcMain.handle('filePicker:browse', async (_event, raw) => {
    try {
      const target = io(),
        directory = target.normalize(raw);
      return { ...(await target.fs.listDirectory(directory)), path: directory.replace(/\\/g, '/') };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('filePicker:download', async (_event, raw) => {
    try {
      const target = io(),
        file = target.normalize(raw);
      const stat = await target.fs.stat(file);
      if (!stat?.isFile) throw new Error('Choose a regular file');
      if (stat.size > 100 * 1024 * 1024) throw new Error('Download exceeds 100 MiB');
      const bytes = target.vm ? await target.fs.readBuffer(file) : await fs.readFile(file);
      if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('Download exceeds 100 MiB');
      return { ok: true, name: target.path.basename(file), bytes };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('filePicker:write', async (_event, raw, content) => {
    try {
      if (typeof content !== 'string' && !(content instanceof ArrayBuffer))
        throw new Error('Expected text or file bytes');
      const target = io(),
        file = target.normalize(raw);
      const bytes =
        typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
      if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('File exceeds 100 MiB');
      if (target.vm) await target.fs.writeBuffer(file, bytes);
      else await fs.writeFile(file, bytes);
      return { ok: true, path: file };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('filePicker:mkdir', async (_event, raw) => {
    try {
      const target = io();
      return await target.fs.makeDirectory(target.normalize(raw));
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('filePicker:validate', async (_event, raw, config, overwrite) => {
    try {
      const target = io(),
        file = target.normalize(raw),
        stat = await target.fs.stat(file).catch(() => null);
      if (config.save) {
        if (stat?.isDirectory) return { ok: false, error: '请选择文件名' };
        if (stat && !overwrite)
          return { ok: false, overwrite: true, error: '文件已存在，是否覆盖？' };
        if (!(await target.fs.stat(target.path.dirname(file)))?.isDirectory)
          return { ok: false, error: '保存目录不存在' };
      } else if (!stat || !!stat.isDirectory !== !!config.directory)
        return { ok: false, error: config.directory ? '请选择文件夹' : '请选择文件' };
      return { ok: true, path: file };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}
module.exports = { registerFrontendFilePicker };
