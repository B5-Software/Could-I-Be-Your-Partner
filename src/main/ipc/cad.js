/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const mainDir = require('node:path').resolve(__dirname, '..');

module.exports = function registerCadIpc({
  ipcMain,
  BrowserWindow,
  path,
  app,
  fs,
  dialog,
  getVmService,
}) {
  const toolFiles = require('../vm/tool-files').createToolFiles({
    fs,
    getVmService,
    recoveryDirectory: path.join(app.getPath('userData'), 'recovery'),
  });
  // ===========================================================================
  // CIPYP-CAD - 2D Drafting CAD sub-application
  // ===========================================================================
  let cipypCadWindow = null;

  ipcMain.handle('cipypcad:open', async () => {
    try {
      if (cipypCadWindow && !cipypCadWindow.isDestroyed()) {
        cipypCadWindow.focus();
        return { ok: true };
      }
      cipypCadWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: 'CIPYP-CAD',
        frame: false,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        icon: path.join(mainDir, '../../assets/icons/icon.png'),
        webPreferences: {
          preload: path.join(mainDir, '../preload/generated/cipypcad-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      cipypCadWindow.loadFile(path.join(mainDir, '../renderer/pages/cipypcad.html'));
      // 关闭拦截：若工程有未保存改动，由渲染进程通过 cipypcad:requestClose 询问用户
      cipypCadWindow.on('close', (event) => {
        if (cipypCadWindow && !cipypCadWindow.isDestroyed()) {
          event.preventDefault();
          cipypCadWindow.webContents.send('cipypcad:close-requested');
        }
      });
      // 最大化状态变化时通知渲染进程（更新标题栏按钮图标）
      cipypCadWindow.on('maximize', () => {
        try {
          cipypCadWindow.webContents.send('cipypcad:maximizeChanged');
        } catch {}
      });
      cipypCadWindow.on('unmaximize', () => {
        try {
          cipypCadWindow.webContents.send('cipypcad:maximizeChanged');
        } catch {}
      });
      cipypCadWindow.on('closed', () => {
        cipypCadWindow = null;
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 渲染进程在用户确认后（保存/不保存/取消）调用此 handler 真正关闭窗口
  ipcMain.handle('cipypcad:confirmClose', (_, action) => {
    if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: false };
    if (action === 'close') {
      // 解除 close 拦截：先移除 listener，再 destroy
      cipypCadWindow.removeAllListeners('close');
      cipypCadWindow.destroy();
      cipypCadWindow = null;
    }
    return { ok: true };
  });

  // 窗口控制器：最小化/最大化/关闭（自实现标题栏按钮调用）
  ipcMain.handle('cipypcad:minimize', () => {
    if (cipypCadWindow && !cipypCadWindow.isDestroyed()) cipypCadWindow.minimize();
    return { ok: true };
  });
  ipcMain.handle('cipypcad:maximizeToggle', () => {
    if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: false };
    if (cipypCadWindow.isMaximized()) cipypCadWindow.unmaximize();
    else cipypCadWindow.maximize();
    return { ok: true, maximized: cipypCadWindow.isMaximized() };
  });
  ipcMain.handle('cipypcad:isMaximized', () => {
    return {
      ok: true,
      maximized: !!(
        cipypCadWindow &&
        !cipypCadWindow.isDestroyed() &&
        cipypCadWindow.isMaximized()
      ),
    };
  });

  ipcMain.handle('cipypcad:close', () => {
    if (cipypCadWindow && !cipypCadWindow.isDestroyed()) cipypCadWindow.close();
    return { ok: true };
  });

  // Agent 触发的关闭：默认自动保存后直接销毁，不弹询问框（Agent 无法回答）
  let _cadLastPath = null;
  ipcMain.handle('cipypcad:agentClose', async () => {
    if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: true };
    try {
      const st = await _cadExec('window.cadGetState()');
      if (st && st.ok && st.state && st.state.modified) {
        const res = await _cadExec('window.cadGetProjectJSON()');
        if (res && res.ok) {
          // 优先级：state.filePath（渲染进程最新保存路径）→ _cadLastPath（IPC 缓存）→ recovery/ 兜底
          let target = st.state.filePath || _cadLastPath;
          // 只允许写回工程文件（DXF/SVG/PNG 等导入来源绝不覆盖）
          if (target && !/\.(cipyproj|json)$/i.test(String(target))) target = null;
          if (!target) {
            const dir = toolFiles.recovery();
            await toolFiles.mkdir(dir, { recursive: true });
            target = toolFiles.join(dir, 'cipypcad-' + Date.now() + '.cipyproj');
          }
          await toolFiles.write(target, JSON.stringify(res.data, null, 2), 'utf-8');
        }
      }
    } catch (e) {
      return {
        ok: false,
        error: 'CAD 自动保存失败，窗口保持打开: ' + e.message,
      };
    }
    cipypCadWindow.removeAllListeners('close');
    cipypCadWindow.destroy();
    cipypCadWindow = null;
    _cadLastPath = null;
    return { ok: true };
  });

  // Helper: safely execute JS in CAD window and return result
  async function _cadExec(script) {
    if (!cipypCadWindow || cipypCadWindow.isDestroyed()) {
      return {
        ok: false,
        error: 'CIPYP-CAD 窗口未打开，请先调用 initCipypCad',
      };
    }
    try {
      // Wait for the CAD engine to be ready (window.cadExecuteCommand defined)
      // Try up to 5 seconds
      for (let i = 0; i < 50; i++) {
        const ready = await cipypCadWindow.webContents.executeJavaScript(
          'typeof window.cadExecuteCommand === "function"',
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const result = await cipypCadWindow.webContents.executeJavaScript(script);
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  ipcMain.handle('cipypcad:runCommand', async (_, cmd) => {
    const safe = JSON.stringify(String(cmd || ''));
    return await _cadExec(`window.cadExecuteCommand(${safe})`);
  });

  ipcMain.handle('cipypcad:runCommands', async (_, cmds) => {
    if (!Array.isArray(cmds)) return { ok: false, error: 'commands must be array' };
    const safe = JSON.stringify(cmds.map((c) => String(c || '')));
    return await _cadExec(`window.cadExecuteCommands(${safe})`);
  });

  ipcMain.handle('cipypcad:getState', async () => {
    return await _cadExec(`window.cadGetState()`);
  });

  ipcMain.handle('cipypcad:getObjectList', async () => {
    return await _cadExec(`window.cadGetObjectList()`);
  });

  ipcMain.handle('cipypcad:saveProjectDialog', async () => {
    if (!cipypCadWindow || cipypCadWindow.isDestroyed())
      return { ok: false, error: 'CAD 窗口未打开' };
    const result = await dialog.showSaveDialog(cipypCadWindow, {
      title: '保存 CIPYP-CAD 工程',
      defaultPath: 'project.cipyproj',
      filters: [
        { name: 'CIPYP-CAD Project', extensions: ['cipyproj'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('cipypcad:loadProjectDialog', async () => {
    if (!cipypCadWindow || cipypCadWindow.isDestroyed())
      return { ok: false, error: 'CAD 窗口未打开' };
    const result = await dialog.showOpenDialog(cipypCadWindow, {
      title: '加载 CIPYP-CAD 工程',
      properties: ['openFile'],
      filters: [
        { name: 'CIPYP-CAD Project', extensions: ['cipyproj'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('cipypcad:saveImageDialog', async (_, defaultName, filter) => {
    if (!cipypCadWindow || cipypCadWindow.isDestroyed())
      return { ok: false, error: 'CAD 窗口未打开' };
    let filters;
    if (filter === 'DXF') {
      filters = [
        { name: 'AutoCAD DXF', extensions: ['dxf'] },
        { name: 'All Files', extensions: ['*'] },
      ];
    } else if (filter === 'SVG') {
      filters = [
        { name: 'SVG Image', extensions: ['svg'] },
        { name: 'All Files', extensions: ['*'] },
      ];
    } else {
      filters = [
        { name: 'PNG Image', extensions: ['png'] },
        { name: 'All Files', extensions: ['*'] },
      ];
    }
    const result = await dialog.showSaveDialog(cipypCadWindow, {
      title: '导出',
      defaultPath: defaultName || 'export.png',
      filters,
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('cipypcad:saveProject', async (_, filePath) => {
    try {
      const res = await _cadExec(`window.cadGetProjectJSON()`);
      if (!res.ok) return res;
      const json = JSON.stringify(res.data, null, 2);
      await toolFiles.write(filePath, json, 'utf-8');
      _cadLastPath = filePath; // 缓存最近保存路径，供 agentClose 兜底使用
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cipypcad:loadProject', async (_, filePath) => {
    try {
      if (!(await toolFiles.exists(filePath)))
        return { ok: false, error: '文件不存在: ' + filePath };
      const content = await toolFiles.read(filePath, 'utf-8');
      const data = JSON.parse(content);
      const safe = JSON.stringify(data);
      const safePath = JSON.stringify(filePath);
      const r = await _cadExec(`window.cadLoadProjectJSON(${safe}, ${safePath})`);
      if (r && r.ok) _cadLastPath = filePath; // 缓存最近加载路径
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cipypcad:exportDxf', async (_, filePath) => {
    try {
      const res = await _cadExec(`window.cadGetDxfString()`);
      if (!res.ok) return res;
      await toolFiles.write(filePath, res.dxf, 'utf-8');
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cipypcad:importDxfDialog', async () => {
    if (!cipypCadWindow || cipypCadWindow.isDestroyed())
      return { ok: false, error: 'CAD 窗口未打开' };
    const result = await dialog.showOpenDialog(cipypCadWindow, {
      title: '导入 DXF 文件',
      properties: ['openFile'],
      filters: [
        { name: 'AutoCAD DXF', extensions: ['dxf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    try {
      const content = await toolFiles.read(filePath, 'utf-8');
      const safeContent = JSON.stringify(content);
      const safePath = JSON.stringify(filePath);
      const r = await _cadExec(`window.cadImportDxfString(${safeContent}, ${safePath})`);
      // 注意：DXF 是导入来源，不写入 _cadLastPath —— 否则 agentClose 会把 JSON 保存到 .dxf
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cipypcad:getHatchPatterns', async () => {
    try {
      return await _cadExec(`window.cadGetHatchPatterns()`);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cipypcad:exportImage', async (_, filePath, format) => {
    try {
      const fmt = (format || 'png').toLowerCase();
      if (fmt === 'png') {
        const res = await _cadExec(`window.cadGetPNGDataUrl(1920, 1080)`);
        if (!res.ok) return res;
        // Strip "data:image/png;base64," prefix
        const b64 = res.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        await toolFiles.write(filePath, buf);
      } else if (fmt === 'svg') {
        const res = await _cadExec(`window.cadGetSVGString()`);
        if (!res.ok) return res;
        await toolFiles.write(filePath, res.svg, 'utf-8');
      } else {
        return { ok: false, error: 'unsupported format: ' + fmt };
      }
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
};
