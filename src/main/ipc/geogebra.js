/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerGeogebraIpc({
  getMainWindow,
  ipcMain,
  fs,
  imagesDir,
  path,
  getVmService,
}) {
  const toolFiles = require('../vm/tool-files').createToolFiles({ fs, getVmService });
  const defaultDir = () => (toolFiles.active() ? '/workspace/_images' : imagesDir);
  // ---- IPC: GeoGebra ----
  // GeoGebra now runs in the main window, not a separate window.
  // 完整离线：web3d/webSimple/web 编译产物由构建期下载的 Math Apps Bundle 提供，
  // 经 ggb:// 协议（src/main/geogebra-protocol.js）从本地文件系统加载，全程不访问 www.geogebra.org。

  function callGeogebraInMainWindow(fnName, ...args) {
    const safe = args.map((a) => JSON.stringify(a));
    const code = `window.${fnName}(${safe.join(',')})`;
    return getMainWindow().webContents.executeJavaScript(code);
  }

  ipcMain.handle('geogebra:init', async (_, options) => {
    try {
      const opts = options && typeof options === 'object' ? options : {};
      const result = await callGeogebraInMainWindow('initGeoGebra', opts);
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:evalCommand', async (_, cmd) => {
    try {
      // 使用 JSON.stringify 安全转义命令字符串（避免注入 / 换行破坏语法）
      const safe = JSON.stringify(String(cmd || ''));
      const result = await getMainWindow().webContents.executeJavaScript(
        `window.evalGeoGebraCommand(${safe})`,
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:getAllObjects', async () => {
    try {
      const result = await getMainWindow().webContents.executeJavaScript(
        'window.getAllGeoGebraObjects()',
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:deleteObject', async (_, name) => {
    try {
      const safe = JSON.stringify(String(name || ''));
      const result = await getMainWindow().webContents.executeJavaScript(
        `window.deleteGeoGebraObject(${safe})`,
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:exportPNG', async (_, workspacePath) => {
    try {
      const result = await getMainWindow().webContents.executeJavaScript(
        'window.exportGeoGebraPNG()',
      );
      if (result.ok && result.data) {
        const targetDir =
          workspacePath && (await toolFiles.exists(workspacePath)) ? workspacePath : defaultDir();
        const imgPath = toolFiles.join(targetDir, `geogebra_${Date.now()}.png`);
        // GGB getPNGBase64 返回 "data:image/png;base64,...." 完整 data URI；
        // Buffer.from(.., 'base64') 不能解析带前缀的字符串，需要先剥离前缀。
        let b64 = String(result.data);
        const commaIdx = b64.indexOf(',');
        if (commaIdx > 0 && b64.slice(0, commaIdx).includes('base64')) {
          b64 = b64.slice(commaIdx + 1);
        }
        await toolFiles.write(imgPath, Buffer.from(b64, 'base64'));
        return { ok: true, path: imgPath, url: `file://${imgPath}` };
      }
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:evalCAS', async (_, cmd) => {
    try {
      const safe = JSON.stringify(String(cmd || ''));
      const result = await getMainWindow().webContents.executeJavaScript(
        `window.evalGeoGebraCAS(${safe})`,
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:getObject', async (_, name) => {
    try {
      const safe = JSON.stringify(String(name || ''));
      const result = await getMainWindow().webContents.executeJavaScript(
        `window.getGeoGebraObject(${safe})`,
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:getXML', async () => {
    try {
      const result = await getMainWindow().webContents.executeJavaScript('window.getGeoGebraXML()');
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:setXML', async (_, xml) => {
    try {
      const safe = JSON.stringify(String(xml || ''));
      const result = await getMainWindow().webContents.executeJavaScript(
        `window.setGeoGebraXML(${safe})`,
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:setStyle', async (_, name, style) => {
    try {
      const safeName = JSON.stringify(String(name || ''));
      const safeStyle = JSON.stringify(style && typeof style === 'object' ? style : {});
      const result = await getMainWindow().webContents.executeJavaScript(
        `window.setGeoGebraStyle(${safeName}, ${safeStyle})`,
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:getError', async () => {
    try {
      const result = await getMainWindow().webContents.executeJavaScript(
        'window.getGeoGebraError()',
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:getPNGBase64', async () => {
    try {
      const result = await getMainWindow().webContents.executeJavaScript(
        'window.getGeoGebraPNGBase64()',
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:save', async (_, workspacePath, fileName) => {
    try {
      const result = await getMainWindow().webContents.executeJavaScript(
        'window.getGeoGebraBase64()',
      );
      if (!result || !result.ok || !result.base64)
        return result || { ok: false, error: 'GeoGebra 未返回数据' };
      const dir =
        workspacePath && (await toolFiles.exists(workspacePath)) ? workspacePath : defaultDir();
      const name = (fileName && String(fileName).trim()) || `geogebra_${Date.now()}.ggb`;
      const target = toolFiles.join(dir, name.endsWith('.ggb') ? name : `${name}.ggb`);
      await toolFiles.write(target, Buffer.from(result.base64, 'base64'));
      return { ok: true, path: target, url: `file://${target}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:load', async (_, filePath) => {
    try {
      if (!filePath || !(await toolFiles.exists(filePath)))
        return { ok: false, error: '文件不存在' };
      const b64 = (await toolFiles.read(filePath)).toString('base64');
      const safe = JSON.stringify(b64);
      const result = await getMainWindow().webContents.executeJavaScript(
        `window.setGeoGebraBase64(${safe})`,
      );
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('geogebra:guide', async (_, category) => {
    try {
      const safe = JSON.stringify(String(category || ''));
      const result = await getMainWindow().webContents.executeJavaScript(
        `window.getGeoGebraGuide(${safe})`,
      );
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
};
