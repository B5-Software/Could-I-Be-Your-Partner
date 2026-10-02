/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { VmFs } = require('./vm-fs');
function createVmFileDialog({ ipcMain, dialog, getVmService, getTheme, getMainWindow }) {
  const requests = new Map();
  const queues = new WeakMap();
  function context(event, id) {
    const entry = requests.get(id);
    if (!entry || event.sender !== entry.host.webContents) throw new Error('File picker is closed');
    return entry;
  }
  ipcMain.handle('vmFileDialog:config', (event, id) => context(event, id).config);
  ipcMain.handle('vmFileDialog:browse', async (event, id, raw) => {
    const entry = context(event, id);
    const target = entry.io.resolveVmPath(raw);
    if (!target.ok) return target;
    const result = await entry.io.listDirectory(target.vm);
    return { ...result, path: target.vm };
  });
  ipcMain.handle('vmFileDialog:mkdir', async (event, id, raw) =>
    context(event, id).io.makeDirectory(raw),
  );
  ipcMain.handle('vmFileDialog:choose', async (event, id, raw, overwrite = false) => {
    const entry = context(event, id);
    const target = entry.io.resolveVmPath(raw, { forWrite: entry.config.save });
    if (!target.ok) return target;
    const stat = await entry.io.stat(target.vm).catch(() => null);
    if (entry.config.save) {
      if (stat?.isDirectory) return { ok: false, error: '请选择文件名' };
      if (stat && !overwrite)
        return { ok: false, overwrite: true, error: '文件已存在，是否覆盖？' };
      const parent = await entry.io.stat(path.posix.dirname(target.vm));
      if (!parent?.isDirectory) return { ok: false, error: '保存目录不存在' };
    } else if (!stat || !!stat.isDirectory !== entry.config.directory) {
      return { ok: false, error: entry.config.directory ? '请选择文件夹' : '请选择文件' };
    }
    if (requests.get(id) !== entry) return { ok: false, canceled: true };
    entry.finish(
      entry.config.save
        ? { canceled: false, filePath: target.vm }
        : { canceled: false, filePaths: [target.vm] },
    );
    return { ok: true };
  });
  ipcMain.handle('vmFileDialog:cancel', (event, id) => {
    context(event, id).finish();
    return { ok: true };
  });
  async function show(save, parent, options = {}) {
    if (!require('./tool-location').isVmOperation(getVmService))
      return dialog[save ? 'showSaveDialog' : 'showOpenDialog'](parent, options);
    const host = getMainWindow?.() || parent;
    if (!host || host.isDestroyed()) throw new Error('CIBYP window is unavailable');
    const operation = async () => {
      if (host.isDestroyed()) return save ? { canceled: true } : { canceled: true, filePaths: [] };
      const service = getVmService();
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
      if (host.isDestroyed()) return save ? { canceled: true } : { canceled: true, filePaths: [] };
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
      return new Promise((resolve) => {
        const id = randomUUID();
        const finish = (result = save ? { canceled: true } : { canceled: true, filePaths: [] }) => {
          if (!requests.delete(id)) return;
          host.removeListener('closed', onClosed);
          host.webContents.removeListener('did-start-navigation', onNavigate);
          if (!host.isDestroyed()) host.webContents.send('vmFileDialog:close', { id });
          resolve(result);
        };
        const onClosed = () => finish();
        const onNavigate = (_event, _url, _inPlace, mainFrame) => {
          if (mainFrame) finish();
        };
        requests.set(id, { host, io, config, finish });
        host.once('closed', onClosed);
        host.webContents.on('did-start-navigation', onNavigate);
        host.webContents.send('vmFileDialog:open', { id, config });
      });
    };
    const task = (queues.get(host) || Promise.resolve()).then(operation);
    queues.set(
      host,
      task.catch(() => {}),
    );
    return task;
  }
  return {
    showOpenDialog: (parent, options) => show(false, parent, options),
    showSaveDialog: (parent, options) => show(true, parent, options),
  };
}
module.exports = { createVmFileDialog };
