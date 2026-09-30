/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const { dataPath } = require('../core/data-path');

module.exports = function registerWebControlIpc({
  getMainWindow,
  webControlService,
  ipcMain,
  getSettings,
  workspacesBaseDir,
  fs,
  historyDir,
  loadJSON,
  path,
  vmService,
  userDataPath,
  imagesDir,
  WebControlService,
}) {
  // ---- Web Control IPC ----
  // 通知渲染层 Web 控制是否运行：渲染层据此彻底跳过镜像序列化/IPC
  function broadcastWebControlRunning() {
    try {
      if (getMainWindow() && !getMainWindow().isDestroyed()) {
        getMainWindow().webContents.send('webControl:running', !!webControlService.running);
      }
    } catch {
      /* ignore */
    }
  }

  ipcMain.handle('webControl:start', async () => {
    try {
      webControlService.configure(getSettings().webControl);
      webControlService.workDir = workspacesBaseDir; // fallback; renderer will update when agent workspace is created
      // Wire callbacks
      webControlService.onGetHistory = async () => {
        const files = fs.readdirSync(historyDir).filter((f) => f.endsWith('.json'));
        return files
          .map((f) => {
            const data = loadJSON(path.join(historyDir, f), {});
            return {
              id: data.id || f.replace('.json', ''),
              title: data.title || '未命名',
              date: data.updatedAt || data.createdAt || '',
            };
          })
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      };
      webControlService.onGetConversation = async (id) => {
        const fp = dataPath(historyDir, id, '.json');
        if (!fs.existsSync(fp)) return null;
        return loadJSON(fp, null);
      };
      webControlService.onDeleteConversation = async (id) => {
        const fp = dataPath(historyDir, id, '.json');
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      };
      webControlService.onNewChat = async () => {
        if (getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('webControl:newChat');
        }
        return Date.now().toString();
      };
      webControlService.onSendMessage = async (message) => {
        if (getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('webControl:sendMessage', message);
        }
      };
      webControlService.onStopAgent = async () => {
        if (getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('webControl:stopAgent');
        }
      };
      webControlService.onApprovalResponse = (approved) => {
        if (getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('webControl:approvalResponse', approved);
        }
      };
      webControlService.onLoadConversation = (id) => {
        if (getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('webControl:loadConversation', id);
        }
      };
      const result = await webControlService.start();
      broadcastWebControlRunning();
      return result;
    } catch (e) {
      console.error('[WebControl] Start error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:stop', async () => {
    try {
      const result = await webControlService.stop();
      broadcastWebControlRunning();
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 运行中热更新配置（改密码后无需 stop/start，bcrypt.compare 每次读 this.config）
  ipcMain.handle('webControl:reconfigure', async () => {
    try {
      if (webControlService.running) {
        webControlService.configure(getSettings().webControl);
        return { ok: true };
      }
      return { ok: true, message: '服务未运行' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:getStatus', () => {
    return {
      ok: true,
      running: webControlService.running,
      port: webControlService.port,
    };
  });

  ipcMain.handle('webControl:hashPassword', async (_, password) => {
    try {
      const hash = await webControlService.hashPassword(password);
      return { ok: true, hash };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:generateTOTP', async () => {
    try {
      return { ok: true, ...(await webControlService.generateTOTPSecret()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:verifyTOTP', (_, code) => {
    try {
      webControlService.configure(getSettings().webControl);
      const valid = webControlService.verifyTOTP(code);
      return { ok: true, valid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Forward renderer events to web control
  ipcMain.on('webControl:pushMessage', (_, role, content, extra) => {
    if (webControlService.running) webControlService.pushMessage(role, content, extra);
  });
  ipcMain.on('webControl:pushStatus', (_, status) => {
    if (webControlService.running) webControlService.pushStatus(status);
  });
  ipcMain.on('webControl:pushApproval', (_, toolName, args) => {
    if (webControlService.running) webControlService.pushApproval(toolName, args);
  });
  ipcMain.on('webControl:clearApproval', () => {
    if (webControlService.running) webControlService.clearApproval();
  });
  ipcMain.on('webControl:pushToolCall', (_, toolName, args, status, result) => {
    if (webControlService.running) webControlService.pushToolCall(toolName, args, status, result);
  });
  ipcMain.on('webControl:pushConversationSwitch', (_, conversationId) => {
    if (webControlService.running) webControlService.pushConversationSwitch(conversationId);
  });
  ipcMain.on('webControl:pushHistoryMessages', (_, messages) => {
    if (webControlService.running) webControlService.pushHistoryMessages(messages);
  });
  ipcMain.on('webControl:pushTheme', (_, vars) => {
    if (webControlService.running) webControlService.pushTheme(vars);
  });
  ipcMain.on('webControl:pushTarot', (_, card) => {
    if (webControlService.running) webControlService.pushTarot(card);
  });
  ipcMain.on('webControl:pushTitle', (_, title) => {
    if (webControlService.running) webControlService.pushTitle(title);
  });
  ipcMain.on('webControl:setWorkDir', (_, dir) => {
    if (dir) webControlService.workDir = dir;
    console.log('[WebControl] workDir updated to agent workspace:', dir);
  });
  ipcMain.on('webControl:setAvatars', (_, avatars) => {
    webControlService._currentAvatars = avatars;
    if (webControlService.running) webControlService.pushAvatars(avatars);
  });
  // 渲染器模式切换 → 广播到 WebUI
  ipcMain.on('webControl:pushModeSwitch', (_, mode) => {
    if (webControlService.running && typeof webControlService.pushModeSwitch === 'function') {
      webControlService.pushModeSwitch(mode);
    }
  });
  // 渲染器上下文进度 → 广播到 WebUI（圆扇形指示器）
  ipcMain.on('webControl:pushContextProgress', (_, data) => {
    if (webControlService.running && typeof webControlService.pushContextProgress === 'function') {
      webControlService.pushContextProgress(data);
    }
  });
  // 渲染器重新优化按钮可见性 → 广播到 WebUI
  ipcMain.on('webControl:pushReoptimizeState', (_, visible) => {
    if (webControlService.running && typeof webControlService.pushReoptimizeState === 'function') {
      webControlService.pushReoptimizeState(visible);
    }
  });
  // 渲染器屏幕软键盘状态 → 广播到 WebUI
  ipcMain.on('webControl:pushOskState', (_, state) => {
    if (webControlService.running && typeof webControlService.pushOskState === 'function') {
      webControlService.pushOskState(state);
    }
  });
  // WebUI → 渲染器：模式切换
  if (typeof webControlService.onSwitchMode !== 'undefined') {
    webControlService.onSwitchMode = (mode) => {
      getMainWindow()?.webContents?.send('webControl:switchMode', mode);
    };
  }
  // WebUI → 渲染器：重新优化工具
  if (typeof webControlService.onReoptimizeTools !== 'undefined') {
    webControlService.onReoptimizeTools = () => {
      getMainWindow()?.webContents?.send('webControl:reoptimizeTools');
    };
  }
  // WebUI → 渲染器：切换屏幕软键盘
  if (typeof webControlService.onToggleOsk !== 'undefined') {
    webControlService.onToggleOsk = () => {
      getMainWindow()?.webContents?.send('webControl:toggleOsk');
    };
  }
  // ---- DOM Mirror bridge ----
  // WS 客户端连接后：通知渲染器推送完整 mirror_head + mirror_body 快照
  webControlService.onMirrorInit = () => {
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
      getMainWindow().webContents.send('webControl:mirrorInit');
    }
  };
  // WebUI UI 事件 → 渲染器：转发到渲染器以触发对应元素操作
  webControlService.onUiEvent = (data) => {
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
      getMainWindow().webContents.send('webControl:uiEvent', data);
    }
  };
  // WebUI 上传文件后通知渲染器刷新附件列表
  // 运行位置=虚拟机：WebUI 上传的文件送进 VM（返回 VM 路径作为附件路径）

  try {
    webControlService.vmUploader = async (buffer, name) => {
      if (!require('../vm/tool-location').isVmOperation(() => vmService)) return null;
      if (!vmService.instance || vmService.instance.state !== 'ready') await vmService.start();

      const { VmFs } = require('../vm/vm-fs');

      const vmFs = new VmFs({ vmService });

      const dir = /.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name || '')
        ? '/workspace/_images'
        : '/workspace/_uploads';

      const vmPath =
        dir + '/' + Date.now() + '_' + String(name || 'upload.bin').replace(/[\\/]/g, '_');
      await vmFs.writeBuffer(vmPath, buffer);

      return { ok: true, vmPath };
    };
  } catch (e) {
    console.warn('[vm] WebUI 上传 hook 注入失败:', e.message);
  }

  webControlService.onFileUploaded = (filePath, fileName, isImage) => {
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
      getMainWindow().webContents.send('webControl:fileUploaded', {
        path: filePath,
        name: fileName,
        isImage,
      });
    }
  };
  // WebUI 本地图片代理：允许用户数据目录 / 工作区基目录 / 当前 Agent 工作区内的图片
  webControlService.resolveLocalImage = (requested) => {
    try {
      const raw = String(requested).replace(/^file:\/\/\/?/i, '');
      let target = decodeURIComponent(raw);
      if (process.platform === 'win32') target = target.replace(/\//g, '\\');
      const real = fs.realpathSync(path.resolve(target));
      const roots = [userDataPath, imagesDir, workspacesBaseDir, webControlService.workDir]
        .filter(Boolean)
        .map((r) => {
          try {
            return fs.realpathSync(r);
          } catch (_) {
            return path.resolve(r);
          }
        });
      const allowed = roots.some((r) => real === r || real.startsWith(r + path.sep));
      if (!allowed) return null;
      const ext = path.extname(real).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(WebControlService.MIME_BY_EXT, ext)) return null;
      return real;
    } catch (_) {
      return null;
    }
  };
  // 渲染器 → WS 广播：DOM 镜像更新（mirror_head / mirror_body）
  ipcMain.on('webControl:mirrorUpdate', (_, data) => {
    if (webControlService.running) webControlService.pushMirrorUpdate(data);
  });

  return { broadcastWebControlRunning };
};
