/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const mainDir = require('node:path').resolve(__dirname, '..');

module.exports = function registerPcbIpc({
  ipcMain,
  BrowserWindow,
  path,
  app,
  fs,
  dialog,
  requireAdmZip,
  getVmService,
}) {
  const toolFiles = require('../vm/tool-files').createToolFiles({
    fs,
    getVmService,
    recoveryDirectory: path.join(app.getPath('userData'), 'recovery'),
  });
  // ===========================================================================
  // CIBYP-PCB-EDA - PCB design sub-application (schematic + layout + Gerber)
  // ===========================================================================
  let pcbEdaWindow = null;

  ipcMain.handle('pcbeda:open', async () => {
    try {
      if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) {
        pcbEdaWindow.focus();
        return { ok: true };
      }
      pcbEdaWindow = new BrowserWindow({
        width: 1380,
        height: 860,
        minWidth: 1000,
        minHeight: 640,
        title: 'CIBYP-PCB-EDA',
        frame: false,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        icon: path.join(mainDir, '../../assets/icons/icon.png'),
        webPreferences: {
          preload: path.join(mainDir, '../preload/generated/pcbeda-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      pcbEdaWindow.loadFile(path.join(mainDir, '../renderer/pages/pcbeda.html'));
      // 关闭拦截：由渲染进程检查未保存改动并决定
      pcbEdaWindow.on('close', (event) => {
        if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) {
          event.preventDefault();
          pcbEdaWindow.webContents.send('pcbeda:close-requested');
        }
      });
      pcbEdaWindow.on('maximize', () => {
        try {
          pcbEdaWindow.webContents.send('pcbeda:maximizeChanged');
        } catch {}
      });
      pcbEdaWindow.on('unmaximize', () => {
        try {
          pcbEdaWindow.webContents.send('pcbeda:maximizeChanged');
        } catch {}
      });
      pcbEdaWindow.on('closed', () => {
        pcbEdaWindow = null;
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('pcbeda:confirmClose', (_, action) => {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false };
    if (action === 'close') {
      pcbEdaWindow.removeAllListeners('close');
      pcbEdaWindow.destroy();
      pcbEdaWindow = null;
    }
    return { ok: true };
  });

  ipcMain.handle('pcbeda:minimize', () => {
    if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) pcbEdaWindow.minimize();
    return { ok: true };
  });
  ipcMain.handle('pcbeda:maximizeToggle', () => {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false };
    if (pcbEdaWindow.isMaximized()) pcbEdaWindow.unmaximize();
    else pcbEdaWindow.maximize();
    return { ok: true, maximized: pcbEdaWindow.isMaximized() };
  });
  ipcMain.handle('pcbeda:isMaximized', () => {
    return {
      ok: true,
      maximized: !!(pcbEdaWindow && !pcbEdaWindow.isDestroyed() && pcbEdaWindow.isMaximized()),
    };
  });
  ipcMain.handle('pcbeda:close', () => {
    if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) pcbEdaWindow.close();
    return { ok: true };
  });

  // Agent 触发的关闭：默认自动保存后直接销毁，不弹询问框（Agent 无法回答）
  let _pcbLastPath = null;
  ipcMain.handle('pcbeda:agentClose', async () => {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: true };
    try {
      const st = await _pcbExec(`window.pcbGetState()`);
      if (st && st.ok && st.state && st.state.modified) {
        // 优先级：state.filePath（渲染进程最新保存路径）→ _pcbLastPath（IPC 缓存）→ recovery/ 兜底
        let target = st.state.filePath || _pcbLastPath;
        // 只允许写回工程文件；导入来源（KiCad 等）绝不覆盖
        if (target && !/\.(cipypcb|cibypcbproj|json)$/i.test(String(target))) target = null;
        let isMulti = false;
        if (!target) {
          const dir = toolFiles.recovery();
          await toolFiles.mkdir(dir, { recursive: true });
          target = toolFiles.join(dir, 'pcbeda-' + Date.now() + '.cipypcb');
        } else {
          isMulti = String(target).toLowerCase().endsWith('.cibypcbproj');
        }
        if (isMulti) {
          const base = path.basename(target).replace(/\.cibypcbproj$/i, '');
          const res = await _pcbExec(`window.pcbGetMultiFiles(${JSON.stringify(base)})`);
          if (res && res.ok) {
            const dir = toolFiles.dirname(target);
            if (!(await toolFiles.exists(dir))) await toolFiles.mkdir(dir, { recursive: true });
            await toolFiles.write(target, JSON.stringify(res.data.manifest, null, 2), 'utf-8');
            for (const f of res.data.files) {
              await toolFiles.write(
                toolFiles.join(dir, path.basename(f.name)),
                JSON.stringify(f.data, null, 2),
                'utf-8',
              );
            }
          }
        } else {
          const res = await _pcbExec(`window.pcbGetProjectJSON()`);
          if (res && res.ok) {
            await toolFiles.write(target, JSON.stringify(res.data, null, 2), 'utf-8');
          }
        }
      }
    } catch (e) {
      return {
        ok: false,
        error: 'PCB 自动保存失败，窗口保持打开: ' + e.message,
      };
    }
    if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) {
      pcbEdaWindow.removeAllListeners('close');
      pcbEdaWindow.destroy();
    }
    pcbEdaWindow = null;
    _pcbLastPath = null;
    return { ok: true };
  });

  // Helper: safely execute JS in PCB-EDA window (waits for engine bridge)
  async function _pcbExec(script) {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) {
      return {
        ok: false,
        error: 'CIBYP-PCB-EDA 窗口未打开，请先调用 initPcbEda',
      };
    }
    try {
      for (let i = 0; i < 50; i++) {
        const ready = await pcbEdaWindow.webContents.executeJavaScript(
          'typeof window.pcbExecuteCommand === "function"',
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return await pcbEdaWindow.webContents.executeJavaScript(script);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  ipcMain.handle('pcbeda:runCommand', async (_, cmd) => {
    const safe = JSON.stringify(String(cmd || ''));
    return await _pcbExec(`window.pcbExecuteCommand(${safe})`);
  });
  ipcMain.handle('pcbeda:runCommands', async (_, cmds) => {
    if (!Array.isArray(cmds)) return { ok: false, error: 'commands must be array' };
    const safe = JSON.stringify(cmds.map((c) => String(c || '')));
    return await _pcbExec(`window.pcbExecuteCommands(${safe})`);
  });
  ipcMain.handle('pcbeda:getState', async () => {
    return await _pcbExec(`window.pcbGetState()`);
  });

  // ---- dialogs ----
  ipcMain.handle('pcbeda:saveProjectDialog', async () => {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed())
      return { ok: false, error: 'PCB-EDA 窗口未打开' };
    const result = await dialog.showSaveDialog(pcbEdaWindow, {
      title: '保存 PCB 工程',
      defaultPath: 'project.cipypcb',
      filters: [
        { name: 'CIBYP PCB 工程 (单文件)', extensions: ['cipypcb'] },
        { name: 'CIBYP PCB 多文件工程 (清单)', extensions: ['cibypcbproj'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('pcbeda:loadProjectDialog', async () => {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed())
      return { ok: false, error: 'PCB-EDA 窗口未打开' };
    const result = await dialog.showOpenDialog(pcbEdaWindow, {
      title: '打开 PCB 工程 / 导入 EDA 文件',
      properties: ['openFile'],
      filters: [
        {
          name: '所有支持的格式',
          extensions: [
            'cipypcb',
            'cibypcbproj',
            'json',
            'kicad_pcb',
            'net',
            'kicad_net',
            'csv',
            'txt',
          ],
        },
        {
          name: 'CIBYP PCB 工程',
          extensions: ['cipypcb', 'cibypcbproj', 'json'],
        },
        {
          name: 'KiCad 工程/网表',
          extensions: ['kicad_pcb', 'net', 'kicad_net'],
        },
        { name: 'CSV 网表', extensions: ['csv', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('pcbeda:exportDirDialog', async (_, defaultName) => {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed())
      return { ok: false, error: 'PCB-EDA 窗口未打开' };
    const result = await dialog.showOpenDialog(pcbEdaWindow, {
      title: '选择导出目录',
      defaultPath: defaultName || 'gerber',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('pcbeda:saveFileDialog', async (_, defaultName, filterName) => {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed())
      return { ok: false, error: 'PCB-EDA 窗口未打开' };
    const ext = (defaultName || 'export').split('.').pop();
    const result = await dialog.showSaveDialog(pcbEdaWindow, {
      title: '导出文件',
      defaultPath: defaultName || 'export',
      filters: [
        { name: filterName || 'File', extensions: [ext || '*'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('pcbeda:importFileDialog', async () => {
    if (!pcbEdaWindow || pcbEdaWindow.isDestroyed())
      return { ok: false, error: 'PCB-EDA 窗口未打开' };
    const result = await dialog.showOpenDialog(pcbEdaWindow, {
      title: '导入网表 / 其他 EDA 文件',
      properties: ['openFile'],
      filters: [
        {
          name: '所有支持的格式',
          extensions: ['kicad_pcb', 'net', 'kicad_net', 'csv', 'txt', 'cipypcb', 'json'],
        },
        {
          name: 'KiCad 工程/网表',
          extensions: ['kicad_pcb', 'net', 'kicad_net'],
        },
        { name: 'CSV 网表', extensions: ['csv', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    const p = result.filePaths[0];
    try {
      const content = await toolFiles.read(p, 'utf-8');
      return { ok: true, path: p, name: path.basename(p), content };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- file save/load ----
  ipcMain.handle('pcbeda:saveProject', async (_, filePath, multi) => {
    try {
      if (multi) {
        const base = path.basename(filePath).replace(/\.cibypcbproj$/i, '');
        const res = await _pcbExec(`window.pcbGetMultiFiles(${JSON.stringify(base)})`);
        if (!res.ok) return res;
        const dir = toolFiles.dirname(filePath);
        if (!(await toolFiles.exists(dir))) await toolFiles.mkdir(dir, { recursive: true });
        await toolFiles.write(filePath, JSON.stringify(res.data.manifest, null, 2), 'utf-8');
        for (const f of res.data.files) {
          await toolFiles.write(
            toolFiles.join(dir, path.basename(f.name)),
            JSON.stringify(f.data, null, 2),
            'utf-8',
          );
        }
        _pcbLastPath = filePath; // 缓存最近保存路径，供 agentClose 兜底使用
        return { ok: true, path: filePath, files: res.data.files.length + 1 };
      }
      const res = await _pcbExec(`window.pcbGetProjectJSON()`);
      if (!res.ok) return res;
      await toolFiles.write(filePath, JSON.stringify(res.data, null, 2), 'utf-8');
      _pcbLastPath = filePath; // 缓存最近保存路径，供 agentClose 兜底使用
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('pcbeda:loadProject', async (_, filePath) => {
    try {
      if (!(await toolFiles.exists(filePath)))
        return { ok: false, error: '文件不存在: ' + filePath };
      const lower = filePath.toLowerCase();
      let r;
      if (lower.endsWith('.cibypcbproj')) {
        const manifest = JSON.parse(await toolFiles.read(filePath, 'utf-8'));
        const dir = toolFiles.dirname(filePath);
        const contents = {};
        for (const ent of manifest.files || []) {
          const fp = toolFiles.join(dir, ent.file);
          if (await toolFiles.exists(fp))
            contents[ent.file] = JSON.parse(await toolFiles.read(fp, 'utf-8'));
        }
        r = await _pcbExec(
          `window.pcbLoadMultiFiles(${JSON.stringify(manifest)}, ${JSON.stringify(contents)})`,
        );
      } else if (
        lower.endsWith('.kicad_pcb') ||
        lower.endsWith('.net') ||
        lower.endsWith('.kicad_net') ||
        lower.endsWith('.csv') ||
        lower.endsWith('.txt')
      ) {
        const content = await toolFiles.read(filePath, 'utf-8');
        r = await _pcbExec(
          `window.pcbImportData(${JSON.stringify(path.basename(filePath))}, ${JSON.stringify(content)})`,
        );
      } else {
        const data = JSON.parse(await toolFiles.read(filePath, 'utf-8'));
        r = await _pcbExec(`window.pcbLoadProjectJSON(${JSON.stringify(data)})`);
      }
      if (r && r.ok) _pcbLastPath = filePath; // 缓存最近加载路径
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 批量导出文件（Gerber 套装等），可选打 zip 包
  ipcMain.handle('pcbeda:exportFiles', async (_, dirPath, files, zipName) => {
    try {
      if (!dirPath) return { ok: false, error: '未指定导出目录' };
      if (!Array.isArray(files)) return { ok: false, error: 'files must be array' };
      if (!(await toolFiles.exists(dirPath))) await toolFiles.mkdir(dirPath, { recursive: true });
      const written = [];
      for (const f of files) {
        const p = toolFiles.join(dirPath, path.basename(f.name || 'unnamed'));
        if (f.base64)
          await toolFiles.write(
            p,
            Buffer.from(String(f.base64).replace(/^data:[^;]+;base64,/, ''), 'base64'),
          );
        else await toolFiles.write(p, f.content == null ? '' : String(f.content), 'utf-8');
        written.push(p);
      }
      let zipPath = null;
      if (zipName) {
        const AdmZip = requireAdmZip();
        if (!AdmZip) return { ok: false, error: 'adm-zip 不可用，无法打包' };
        const zip = new AdmZip();
        for (const f of files) {
          const name = path.basename(f.name || 'unnamed');
          if (f.base64)
            zip.addFile(
              name,
              Buffer.from(String(f.base64).replace(/^data:[^;]+;base64,/, ''), 'base64'),
            );
          else zip.addFile(name, Buffer.from(f.content == null ? '' : String(f.content), 'utf-8'));
        }
        zipPath = toolFiles.join(dirPath, path.basename(zipName));
        await toolFiles.write(zipPath, zip.toBuffer());
      }
      return { ok: true, paths: written, zipPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('pcbeda:writeFile', async (_, filePath, content) => {
    try {
      await toolFiles.write(filePath, content == null ? '' : String(content), 'utf-8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('pcbeda:writeFileBase64', async (_, filePath, b64) => {
    try {
      await toolFiles.write(
        filePath,
        Buffer.from(String(b64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64'),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Agent 驱动的一站式导出：Gerber 套装（可选 zip）
  ipcMain.handle('pcbeda:exportGerber', async (_, dirPath, baseName, options, zipName) => {
    try {
      if (!dirPath) return { ok: false, error: '未指定导出目录' };
      const res = await _pcbExec(
        `window.pcbGetGerberFiles(${JSON.stringify(baseName || 'pcb')}, ${JSON.stringify(options || {})})`,
      );
      if (!res || !res.ok) return res || { ok: false, error: 'Gerber 生成失败' };
      if (!(await toolFiles.exists(dirPath))) await toolFiles.mkdir(dirPath, { recursive: true });
      const written = [];
      for (const f of res.files) {
        const p = toolFiles.join(dirPath, path.basename(f.name));
        await toolFiles.write(p, f.content == null ? '' : String(f.content), 'utf-8');
        written.push(p);
      }
      let zipPath = null;
      if (zipName) {
        const AdmZip = requireAdmZip();
        if (!AdmZip) return { ok: false, error: 'adm-zip 不可用，无法打包' };
        const zip = new AdmZip();
        for (const f of res.files) {
          zip.addFile(
            path.basename(f.name),
            Buffer.from(f.content == null ? '' : String(f.content), 'utf-8'),
          );
        }
        zipPath = toolFiles.join(dirPath, path.basename(zipName));
        await toolFiles.write(zipPath, zip.toBuffer());
      }
      return { ok: true, count: res.files.length, paths: written, zipPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Agent 驱动的单文件导出（kicad/netlist/svg/png/obj/pnp/bom）
  ipcMain.handle('pcbeda:exportTextFile', async (_, kind, filePath, baseName) => {
    try {
      let script = null,
        isBase64 = false,
        extra = null;
      switch (kind) {
        case 'kicad':
          script = 'window.pcbGetKicadPcb()';
          break;
        case 'netlist-kicad':
          script = 'window.pcbGetNetlist("kicad")';
          break;
        case 'netlist-csv':
          script = 'window.pcbGetNetlist("csv")';
          break;
        case 'svg-pcb':
          script = 'window.pcbGetSVGString("pcb")';
          break;
        case 'svg-sch':
          script = 'window.pcbGetSVGString("sch")';
          break;
        case 'png-pcb':
          script = 'window.pcbGetPNGDataUrl("pcb", 1920)';
          isBase64 = true;
          break;
        case 'png-3d':
          script = 'window.pcbGetPNGDataUrl("3d", 1920)';
          isBase64 = true;
          break;
        case 'pnp':
          script = 'window.pcbGetAuxExport("pnp")';
          break;
        case 'bom':
          script = 'window.pcbGetAuxExport("bom")';
          break;
        case 'obj':
          script = `window.pcbGet3DOBJ(${JSON.stringify((baseName || 'pcb').replace(/\.obj$/i, ''))})`;
          extra = 'obj';
          break;
        default:
          return { ok: false, error: '未知导出类型: ' + kind };
      }
      const res = await _pcbExec(script);
      if (!res || !res.ok) return res || { ok: false, error: '导出失败' };
      if (extra === 'obj') {
        // 文件名不含 .obj 时 replace 不匹配 → MTL 覆盖 OBJ（实测数据损坏）；并同步 OBJ 内 mtllib 名
        if (!/\.obj$/i.test(filePath)) filePath = filePath + '.obj';
        if (!(await toolFiles.exists(toolFiles.dirname(filePath))))
          await toolFiles.mkdir(toolFiles.dirname(filePath), { recursive: true });
        const mtlPath = filePath.replace(/\.obj$/i, '.mtl');
        const mtlBase = path.basename(mtlPath);
        const objText = String(res.data.obj).replace(/^mtllib\s+.*$/m, 'mtllib ' + mtlBase);
        await toolFiles.write(filePath, objText, 'utf-8');
        await toolFiles.write(mtlPath, res.data.mtl, 'utf-8');
        return { ok: true, path: filePath, extra: mtlPath };
      }
      if (!(await toolFiles.exists(toolFiles.dirname(filePath))))
        await toolFiles.mkdir(toolFiles.dirname(filePath), { recursive: true });
      if (isBase64) {
        const b64 = String(res.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
        if (!b64) return { ok: false, error: 'PNG 数据为空（渲染层未返回图像）' };
        await toolFiles.write(filePath, Buffer.from(b64, 'base64'));
      } else {
        await toolFiles.write(filePath, res.content != null ? res.content : res.svg || '', 'utf-8');
      }
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Agent 驱动的外部 EDA 文件导入
  ipcMain.handle('pcbeda:importFile', async (_, filePath) => {
    try {
      if (!(await toolFiles.exists(filePath)))
        return { ok: false, error: '文件不存在: ' + filePath };
      const content = await toolFiles.read(filePath, 'utf-8');
      return await _pcbExec(
        `window.pcbImportData(${JSON.stringify(path.basename(filePath))}, ${JSON.stringify(content)})`,
      );
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
};
