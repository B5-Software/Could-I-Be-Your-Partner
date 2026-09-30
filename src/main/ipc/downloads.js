/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerDownloadsIpc({
  ipcMain,
  aria2Manager,
  getSettings,
  path,
  getVmService,
}) {
  const manager = () => {
    const service = getVmService?.();
    return require('../vm/tool-location').isVmOperation(() => service)
      ? service.downloadsController()
      : aria2Manager;
  };
  // ---- IPC: Download Manager (aria2) ----
  // 替换旧的同步 file:download：现在使用 aria2 异步下载，返回 gid 立即继续工作
  // （aria2Manager 已在文件头部 require，供 VM 资源下载复用同一实例）

  // 启动 aria2（首次下载时自动触发，也可在打开下载管理器时预热）
  // 自动同步 settings.proxy 代理设置
  ipcMain.handle('aria2:start', async () => {
    try {
      await manager().start(getSettings().proxy);
      return {
        ok: true,
        port: manager().port,
        proxy: manager().currentProxy,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 获取 aria2 状态（是否就绪、端口）
  ipcMain.handle('aria2:status', async () => {
    return {
      ok: true,
      ready: manager().ready,
      port: manager().port,
      binPath: manager().binPath,
    };
  });

  // 添加下载任务（异步，立即返回 gid）
  // dir 可选：未指定时使用 aria2 默认目录（userData/aria2），由上层（Agent）传入工作目录
  ipcMain.handle('aria2:add-uri', async (_, url, opts = {}) => {
    try {
      const gid = await manager().addUri(url, opts);
      return { ok: true, gid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 查询单个下载状态
  ipcMain.handle('aria2:tell-status', async (_, gid) => {
    try {
      const status = await manager().tellStatus(gid);
      return { ok: true, status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 列出所有下载（active + waiting + stopped）
  ipcMain.handle('aria2:list-all', async () => {
    try {
      const result = await manager().listAll();
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 暂停下载
  ipcMain.handle('aria2:pause', async (_, gid, force = false) => {
    try {
      await manager().pause(gid, force);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 恢复下载
  ipcMain.handle('aria2:unpause', async (_, gid) => {
    try {
      await manager().unpause(gid);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 取消下载
  ipcMain.handle('aria2:cancel', async (_, gid, force = false) => {
    try {
      await manager().cancel(gid, force);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 删除下载记录（已停止的任务）
  ipcMain.handle('aria2:remove-result', async (_, gid) => {
    try {
      await manager().removeDownloadResult(gid);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 兼容旧版 downloadFile 调用：用 aria2 异步下载后等待完成再返回
  // （仅用于不关心进度的旧调用方；Agent 新工具走 aria2:add-uri 异步路径）
  ipcMain.handle('file:download', async (_, url, filename, workspacePath) => {
    try {
      if (!workspacePath) {
        return { ok: false, error: '未设置工作区路径' };
      }
      const { URL } = require('url');
      const parsedUrl = new URL(url);
      let targetFilename = filename;
      if (!targetFilename) {
        targetFilename = path.basename(parsedUrl.pathname) || 'download';
      }
      const gid = await manager().addUri(url, {
        dir: workspacePath,
        out: targetFilename,
      });
      // 轮询等待完成（最长 10 分钟）
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const st = await manager().tellStatus(gid);
        if (st.status === 'complete') {
          const filePath =
            st.files?.[0]?.path ||
            (manager() !== aria2Manager
              ? workspacePath.replace(/\/$/, '') + '/' + targetFilename
              : path.join(workspacePath, targetFilename));
          return {
            ok: true,
            path: filePath,
            size: parseInt(st.completedLength || '0', 10),
            gid,
          };
        }
        if (st.status === 'error' || st.status === 'removed') {
          return {
            ok: false,
            error: st.errorMessage || `下载${st.status}`,
            gid,
          };
        }
      }
      return { ok: false, error: '下载超时（10 分钟）', gid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
};
