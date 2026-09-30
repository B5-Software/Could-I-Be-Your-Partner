/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
const path = require('node:path');
const { VmFs } = require('./vm-fs');

function createVmFileDialog({ ipcMain, BrowserWindow, dialog, getVmService, getTheme }) {
  const windows = new Map();
  function context(event) {
    const entry = windows.get(event.sender.id);
    if (!entry) throw new Error('File picker is closed');
    return entry;
  }
  ipcMain.handle('vmFileDialog:config', (event) => context(event).config);
  ipcMain.handle('vmFileDialog:browse', async (event, raw) => {
    const entry = context(event);
    const target = entry.io.resolveVmPath(raw);
    if (!target.ok) return target;
    const result = await entry.io.listDirectory(target.vm);
    return { ...result, path: target.vm };
  });
  ipcMain.handle('vmFileDialog:mkdir', async (event, raw) => context(event).io.makeDirectory(raw));
  ipcMain.handle('vmFileDialog:choose', async (event, raw, overwrite = false) => {
    const entry = context(event);
    const target = entry.io.resolveVmPath(raw, { forWrite: entry.config.save });
    if (!target.ok) return target;
    const stat = await entry.io.stat(target.vm).catch(() => null);
    if (entry.config.save) {
      if (stat?.isDirectory) return { ok: false, error: '请选择文件名' };
      if (stat && !overwrite)
        return { ok: false, overwrite: true, error: '文件已存在，是否覆盖？' };
      const parent = await entry.io.stat(path.posix.dirname(target.vm));
      if (!parent?.isDirectory) return { ok: false, error: '保存目录不存在' };
    } else if (!stat || !!stat.isDirectory !== entry.config.directory)
      return { ok: false, error: entry.config.directory ? '请选择文件夹' : '请选择文件' };
    entry.finish(
      entry.config.save
        ? { canceled: false, filePath: target.vm }
        : { canceled: false, filePaths: [target.vm] },
    );
    return { ok: true };
  });
  ipcMain.handle('vmFileDialog:cancel', (event) => {
    context(event).window.close();
    return { ok: true };
  });
  async function show(save, parent, options = {}) {
    const service = getVmService();
    if (!require('./tool-location').isVmOperation(getVmService))
      return dialog[save ? 'showSaveDialog' : 'showOpenDialog'](parent, options);
    if (!service.instance || service.instance.state !== 'ready') await service.start();
    const io = new VmFs({ vmService: service });
    const rawDefault = String(options.defaultPath || '');
    const mapped = rawDefault && io.resolveVmPath(rawDefault);
    let directory = mapped?.ok
      ? save
        ? path.posix.dirname(mapped.vm)
        : mapped.vm
      : io.mountRoot();
    if (!save && mapped?.ok) {
      const stat = await io.stat(mapped.vm).catch(() => null);
      if (!stat?.isDirectory) directory = path.posix.dirname(mapped.vm);
    }
    const theme = getTheme?.() || {};
    const config = {
      save,
      directory: (options.properties || []).includes('openDirectory'),
      initial: directory,
      filename: save ? path.posix.basename(rawDefault || 'untitled') : '',
      title: options.title || (save ? '保存文件' : '打开文件'),
      filters: options.filters || [],
      theme: {
        ...theme,
        mode:
          theme.mode === 'dark' ||
          (theme.mode !== 'light' && service.appearanceSync?.getSystemDark())
            ? 'dark'
            : 'light',
      },
    };
    const window = new BrowserWindow({
      width: 760,
      height: 540,
      minWidth: 620,
      minHeight: 420,
      parent,
      modal: !!parent,
      show: false,
      title: config.title,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../../preload/generated/vm-file-dialog-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        resolve(result);
        window.close();
      };
      windows.set(window.webContents.id, { window, io, config, finish });
      window.once('ready-to-show', () => window.show());
      const senderId = window.webContents.id;
      window.once('closed', () => {
        windows.delete(senderId);
        if (!finished) resolve(save ? { canceled: true } : { canceled: true, filePaths: [] });
      });
      window
        .loadFile(path.join(__dirname, '../../renderer/pages/vm-file-dialog.html'))
        .catch((error) => {
          reject(error);
          window.close();
        });
    });
  }
  return {
    showOpenDialog: (parent, options) => show(false, parent, options),
    showSaveDialog: (parent, options) => show(true, parent, options),
  };
}
module.exports = { createVmFileDialog };
