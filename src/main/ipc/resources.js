/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerResourcesIpc({
  ipcMain,
  getSettings,
  vmService,
  saveJSON,
  settingsPath,
  app,
  vmRuntimeGate,
  dialog,
  getMainWindow,
  qemuRuntimeVersionSafe,
  fs,
  shell,
  tryShowMainWindow,
  openVmDesktopWindow,
  voiceModelManager,
  persistSettings,
  getVoiceIpc,
}) {
  // ---- IPC: Resources（资源下载：语音模型等）----
  // ---- 运行位置（本机 / 虚拟机）+ 虚拟机沙盒（CIBYP-VM-OS）----
  ipcMain.handle('runtime:getLocation', () => {
    const r = getSettings().runtime || {};
    const st = vmService.status();
    return {
      ok: true,
      location: r.location === 'vm' ? 'vm' : 'host',
      workspaceMode: r.workspaceMode === 'isolated' ? 'isolated' : 'shared',
      vmState: (st.inst || {}).state || 'idle',
      vmReady: (st.inst || {}).state === 'ready',
      emergencyHost: !!vmService.emergencyHost,
    };
  });
  ipcMain.handle('runtime:setLocation', (_, location) => {
    const loc = location === 'vm' ? 'vm' : 'host';
    getSettings().runtime = getSettings().runtime || {};
    getSettings().runtime.location = loc;
    try {
      saveJSON(settingsPath, getSettings());
    } catch (_) {}
    return { ok: true, location: loc, requiresRestart: true };
  });
  ipcMain.handle('runtime:setWorkspaceMode', (_, mode) => {
    const m = mode === 'isolated' ? 'isolated' : 'shared';
    getSettings().runtime = getSettings().runtime || {};
    getSettings().runtime.workspaceMode = m;
    try {
      saveJSON(settingsPath, getSettings());
    } catch (_) {}
    return { ok: true, workspaceMode: m, requiresRestart: true };
  });
  ipcMain.handle('runtime:relaunch', () => {
    setTimeout(() => {
      try {
        app.relaunch();
      } catch (_) {}
      try {
        app.exit(0);
      } catch (_) {}
    }, 200);
    return { ok: true };
  });

  ipcMain.handle('vm:status', () => ({ ok: true, ...vmService.status() }));
  ipcMain.handle('vm:start', async () => {
    try {
      const st = await vmService.start();
      vmRuntimeGate.required = false;
      vmRuntimeGate.ready = true;
      return { ok: true, status: st };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });
  // ---- 工作区同步（shared 模式）----
  ipcMain.handle('vm:sync', async (_, opts) => {
    try {
      const r = await vmService.syncWorkspace({
        direction: (opts && opts.direction) || 'both',
        reason: 'manual',
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:syncStatus', () => ({
    ok: true,
    ...vmService.syncStats(),
    workspaceRoot: vmService.workspaceRoot,
    workspaceMode: vmService.runtime.workspaceMode,
  }));
  ipcMain.handle('vm:chooseWorkspaceRoot', async () => {
    try {
      const r = await dialog.showOpenDialog(getMainWindow(), {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: vmService.workspaceRoot || undefined,
        title: '选择工作区根目录（宿主侧权威副本）',
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      getSettings().runtime = getSettings().runtime || {};
      getSettings().runtime.vm = Object.assign({}, getSettings().runtime.vm, {
        workspaceRoot: r.filePaths[0],
      });
      try {
        saveJSON(settingsPath, getSettings());
      } catch (_) {}
      return { ok: true, dir: r.filePaths[0], requiresRestart: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:stop', async () => {
    try {
      await vmService.stop();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:reset', async () => {
    try {
      await vmService.reset();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:probe', async () => {
    try {
      return { ok: true, ...(await vmService.probe()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:logs', () => ({ ok: true, ...vmService.status() }));
  ipcMain.handle('vm:variants', () => ({
    ok: true,
    current: vmService.variant,
    variants: vmService.variants(),
  }));
  ipcMain.handle('vm:assetsStatus', (_, variant) => ({
    ok: true,
    ...vmService.assetsStatus(variant),
  }));
  ipcMain.handle('vm:manifest', async (_, opts) => {
    try {
      return await vmService.manifest(opts || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:download', async (_, opts) => vmService.downloadAll(opts || {}));
  ipcMain.handle('vm:downloadCancel', () => vmService.cancelDownload());
  ipcMain.handle('vm:qemuPackStatus', () => {
    try {
      const info = vmService.qemuPackInstalled();
      if (!info) return { ok: true, installed: false };
      return {
        ok: true,
        installed: true,
        dir: info.dir,
        version: qemuRuntimeVersionSafe(info.exe),
        source: info.source,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // 端口预览：把 VM 内服务映射到宿主 loopback
  ipcMain.handle('vm:forwardPort', async (_, guestPort) => {
    try {
      const inst = vmService.instance;
      if (!inst || inst.state !== 'ready') return { ok: false, error: '虚拟机未就绪' };
      return { ok: true, ...(await vmService.forwardPort(Number(guestPort))) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:unforwardPort', (_, hostPort) => {
    try {
      return { ok: true, ...vmService.unforwardPort(Number(hostPort)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:listForwards', () => ({
    ok: true,
    forwards: vmService.listForwards(),
  }));
  // 一键开启 Windows Hypervisor Platform（需要管理员，会弹 UAC）
  ipcMain.handle('vm:enableWhpx', async () => {
    if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 需要该操作' };
    try {
      const { spawn } = require('child_process');
      const ps = [
        '-NoProfile',
        '-Command',
        'Start-Process -FilePath dism.exe -ArgumentList "/Online","/Enable-Feature","/FeatureName:HypervisorPlatform","/All","/NoRestart" -Verb RunAs -Wait; ' +
          'Start-Process -FilePath dism.exe -ArgumentList "/Online","/Enable-Feature","/FeatureName:VirtualMachinePlatform","/All","/NoRestart" -Verb RunAs -Wait',
      ];
      await new Promise((resolve, reject) => {
        const p = spawn('powershell.exe', ps, { windowsHide: true });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('DISM 退出码 ' + code))));
        p.on('error', reject);
      });
      return {
        ok: true,
        note: '功能已申请开启（若刚开启则需重启一次才能使用 WHPX 加速）',
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:setVariant', (_, variant) => vmService.setVariant(variant));
  ipcMain.handle('vm:chooseAssetsDir', async () => {
    try {
      const r = await dialog.showOpenDialog(getMainWindow(), {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: vmService.assetsDir,
        title: '选择虚拟机资源目录（QEMU / 镜像 / 实例数据）',
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      getSettings().runtime = getSettings().runtime || {};
      getSettings().runtime.vm = Object.assign({}, getSettings().runtime.vm, {
        assetsDir: r.filePaths[0],
      });
      try {
        saveJSON(settingsPath, getSettings());
      } catch (_) {}
      return { ok: true, dir: r.filePaths[0] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:openAssetsDir', async () => {
    try {
      fs.mkdirSync(vmService.assetsDir, { recursive: true });
      await shell.openPath(vmService.assetsDir);
      return { ok: true, dir: vmService.assetsDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // 紧急切回本机：本次运行生效（不写设置），Splash/主界面均可调用
  ipcMain.handle('vm:emergencyHostMode', () => {
    vmService.emergencyHostMode();
    vmRuntimeGate.required = false;
    vmRuntimeGate.ready = true;
    tryShowMainWindow();
    return { ok: true };
  });

  // ---- VM 桌面（P4：Xvfb + x11vnc + noVNC / Chromium CDP）----
  ipcMain.handle('vm:graphicsStatus', () => ({
    ok: true,
    ...vmService.graphicsStatus(),
  }));
  ipcMain.handle('vm:graphicsStart', async (_, opts) => {
    try {
      // 打开 VM 桌面时如果虚拟机没在跑，自动启动（用户不需要先手动点"启动"）
      const inst = vmService.instance;
      if (!inst || inst.state !== 'ready') {
        console.log('[vm] VM 桌面：虚拟机未就绪，先启动虚拟机…');
        await vmService.start();
      }
      return await vmService.graphicsStart(opts || {});
    } catch (e) {
      return {
        ok: false,
        error: e.message,
        detail: e.stack ? String(e.stack).slice(0, 800) : null,
      };
    }
  });
  ipcMain.handle('vm:graphicsStop', async () => {
    try {
      return await vmService.graphicsStop();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:graphicsChromium', async (_, opts) => {
    try {
      return await vmService.graphicsChromium(opts || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // 虚拟机内文件下载（宿主 aria2 下载 → 推入 VM；支持 GitHub 加速镜像）
  ipcMain.handle('vm:downloadFile', async (_, payload) => {
    try {
      const p = payload || {};
      if (!p.url) return { ok: false, error: '请填写下载链接' };
      const inst = vmService.instance;
      if (!inst || inst.state !== 'ready')
        return {
          ok: false,
          error: '请先启动虚拟机（运行位置=虚拟机时会自动启动）',
        };
      return await vmService.downloadFileToVm(p);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:mirrors', () => {
    try {
      const images = require('../vm/vm-images');
      return {
        ok: true,
        current: vmService.runtime.vm.mirror || 'official',
        mirrors: Object.entries(images.MIRROR_PREFIXES).map(([id, prefix]) => ({
          id,
          prefix,
        })),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // 运行位置=虚拟机时把宿主路径翻译为 VM 内路径（渲染层拼提示词/附件路径用）
  ipcMain.handle('runtime:toVmPath', async (_, p) => {
    try {
      const isVm = require('../vm/tool-location').isVmOperation(() => vmService);
      if (!isVm) return { ok: true, path: p, location: 'host' };
      const target = new (require('../vm/vm-fs').VmFs)({ vmService }).resolveVmPath(p);
      if (!target.ok) return { ...target, location: 'vm' };
      return { ok: true, path: target.vm, location: 'vm' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:openExternal', async (_, url) => {
    try {
      await shell.openExternal(String(url));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vm:openDesktop', () => {
    openVmDesktopWindow();
    return { ok: true };
  });

  ipcMain.handle('resources:voiceModels:status', () => {
    try {
      return { ok: true, ...voiceModelManager.status() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('resources:voiceModels:download', async (_, id) => {
    return voiceModelManager.download(String(id || ''));
  });
  ipcMain.handle('resources:voiceModels:cancel', (_, id) =>
    voiceModelManager.cancel(String(id || '')),
  );
  ipcMain.handle('resources:voiceModels:delete', (_, id) =>
    voiceModelManager.deleteModel(String(id || '')),
  );
  ipcMain.handle('resources:voiceModels:chooseDir', async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择语音模型下载目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: voiceModelManager.dir,
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
    getSettings().resources.voiceModelDir = res.filePaths[0];
    persistSettings();
    try {
      getVoiceIpc()?.engine?.resolveModels?.();
    } catch (_) {}
    return { ok: true, dir: res.filePaths[0] };
  });
  ipcMain.handle('resources:voiceModels:openDir', async (_, dir) => {
    const target = String(dir || voiceModelManager.dir);
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (_) {}
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle('resources:voiceModels:setMirror', (_, mirror) => {
    getSettings().resources.mirror = mirror === 'official' ? 'official' : 'cn';
    persistSettings();
    return { ok: true, mirror: getSettings().resources.mirror };
  });

  return {};
};
