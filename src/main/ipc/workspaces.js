/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const { dataPath } = require('../core/data-path');

module.exports = function registerWorkspacesIpc({
  ipcMain,
  dialog,
  getMainWindow,
  path,
  app,
  fs,
  getSettings,
  vmService,
  workspacesBaseDir,
  scheduleSettingsPersist,
  shell,
  persistSettings,
  flushPendingHistorySaves,
  _historyIndexFile,
  _getHistoryIndex,
  _rehydrateHistoryImages,
  saveJSON,
  _externalizeHistoryImages,
  queueHistorySave,
  _putHistoryIndexEntry,
  _removeHistoryIndexEntry,
  _deleteHistoryImages,
}) {
  ipcMain.handle('workspace:resolve', async (_, directory, options = {}) => {
    try {
      if (!directory) {
        directory = path.join(
          workspacesBaseDir,
          require('node:crypto').randomBytes(8).toString('hex'),
        );
        await fs.promises.mkdir(directory, { recursive: true });
        options = { local: true };
      }
      const target = await require('../services/workspace-target').resolveWorkspaceTarget(
        vmService,
        directory,
        options,
      );
      if (target.location === 'vm') {
        await vmService.prepareTerminalDirectory(target.hostPath || target.path);
      }
      return { ok: true, ...target };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Host directory navigation is an explicit frontend picker, never an Agent file tool.
  ipcMain.handle('workspace:listLocalDirectories', async (_, directory) => {
    try {
      const selected = path.resolve(directory || app.getPath('documents'));
      const entries = await fs.promises.readdir(selected, { withFileTypes: true });
      return {
        ok: true,
        path: selected,
        parent: path.dirname(selected),
        home: require('node:os').homedir(),
        directories: entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            name: entry.name,
            path: path.join(selected, entry.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        roots:
          process.platform === 'win32'
            ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
                .split('')
                .map((letter) => letter + ':\\')
                .filter((root) => fs.existsSync(root))
            : ['/'],
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('workspace:sync', async (_, directory, hostPath) => {
    try {
      if (!require('../vm/tool-location').isVmOperation(() => vmService))
        return { ok: true, skipped: 'host' };
      const io = new (require('../vm/vm-fs').VmFs)({ vmService });
      const target = io.resolveVmPath(directory);
      if (!target.ok) return target;
      const hostRoot = hostPath || io.toHost(target.vm);
      if (!hostRoot) return { ok: false, error: 'Workspace has no local mirror' };
      if (vmService.externalPair(target.vm)) {
        return await vmService.pullExternalDir(target.vm, {
          force: true,
        });
      }
      if (
        vmService.runtime.workspaceMode === 'shared' &&
        require('../vm/vm-paths').isUnder(vmService.workspaceRoot, hostRoot)
      ) {
        return await vmService.syncWorkspace({ direction: 'pull', reason: 'code-turn' });
      }
      // A per-directory pull also supports an explicit export in isolated mode.
      const mapping = io
        .mappingRoots()
        .sort((a, b) => b[1].length - a[1].length)
        .find(
          ([host, vm]) =>
            require('../vm/vm-paths').isUnder(host, hostRoot) &&
            (target.vm === vm || target.vm.startsWith(vm + '/')),
        );
      const sync = mapping
        ? vmService.workspacePair(...mapping)
        : vmService.workspacePair(hostRoot, target.vm);
      return await sync.sync({ direction: 'pull', reason: 'workspace-export' });
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // ---- IPC: Workspace (Agent Working Directory) ----
  ipcMain.handle('firmware:export', async () => {
    try {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择导出目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return { ok: false, error: '用户取消' };
      const destDir = path.join(result.filePaths[0], 'CIBYP-TRNG');
      const srcDir = path.join(app.getAppPath(), 'IoT-Firmware', 'CIBYP-TRNG');

      // 创建目标目录
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      // 复制所有文件
      function copyDir(src, dest) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }

      copyDir(srcDir, destDir);
      return { ok: true, path: destDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- IPC: Workspace (Agent Working Directory) ----
  ipcMain.handle('workspace:create', async (_, options = {}) => {
    const inVm = require('../vm/tool-location').isVmOperation(() => vmService);
    if (inVm) {
      try {
        if (!vmService.instance || vmService.instance.state !== 'ready') await vmService.start();
        const { VmFs } = require('../vm/vm-fs');
        const io = new VmFs({ vmService });
        const last = getSettings().workspace?.lastWorkspace;
        if (options.reuse === true && last && (await io.exists(last)))
          return { ok: true, path: last, reused: true, location: 'vm' };
        const name = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const directory = io.mountRoot() + '/' + name;
        const created = await io.makeDirectory(directory);
        if (!created.ok) return created;
        getSettings().workspace = { ...getSettings().workspace, lastWorkspace: directory };
        scheduleSettingsPersist();
        return { ok: true, path: directory, createdInVm: true, location: 'vm' };
      } catch (error) {
        return { ok: false, location: 'vm', error: error.message };
      }
    }
    const vmWorkspaceExists = async (hostPath) => {
      // VM 模式：宿主机存在不代表 VM 里有（Agent 实际工作在 VM 内）
      try {
        const { VmFs } = require('../vm/vm-fs');
        return await new VmFs({ vmService }).exists(hostPath);
      } catch {
        return false;
      }
    };
    try {
      // 复用最近一次工作区，避免每次启动都新建目录（历史上已堆积大量空目录）
      // 注意：VM 模式下必须确认"VM 内也有该目录"，否则会一直复用一个 VM 里并不存在的旧目录
      // 复用仅在调用方显式要求时发生（历史遗留的"堆空目录"担忧由调用方决定；
      // 渲染层新会话传 fresh:true，恢复会话则由历史自带 workspacePath，不再调用本接口）
      if (options && options.reuse === true) {
        const last = getSettings().workspace?.lastWorkspace;
        if (last && fs.existsSync(last) && (!inVm || (await vmWorkspaceExists(last))))
          return { ok: true, path: last, reused: true };
        let latest = '';
        let latestMtime = -1;
        try {
          for (const entry of fs.readdirSync(workspacesBaseDir, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.')) continue; // 跳过 .cibyp-conflicts 等非会话目录
            try {
              const m = fs.statSync(path.join(workspacesBaseDir, entry.name)).mtimeMs;
              if (m > latestMtime) {
                latestMtime = m;
                latest = path.join(workspacesBaseDir, entry.name);
              }
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
        if (latest) {
          getSettings().workspace = {
            ...(getSettings().workspace || {}),
            lastWorkspace: latest,
          };
          scheduleSettingsPersist();
          return { ok: true, path: latest, reused: true };
        }
      }
    } catch {
      /* fall through to create */
    }
    const ts = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const dir = path.join(workspacesBaseDir, ts);
    fs.mkdirSync(dir, { recursive: true });
    getSettings().workspace = {
      ...(getSettings().workspace || {}),
      lastWorkspace: dir,
    };
    scheduleSettingsPersist();
    return { ok: true, path: dir, createdInVm: inVm };
  });

  ipcMain.handle('workspace:getBase', () =>
    require('../vm/tool-location').isVmOperation(() => vmService)
      ? vmService.runtime.vm.workspaceMount || '/workspace'
      : workspacesBaseDir,
  );

  ipcMain.handle('workspace:cwd', async (_, directory) => {
    try {
      if (!(await require('../core/graphical-environment').hasGraphicalEnvironment()))
        return { ok: false, code: 'NO_DESKTOP', error: 'No usable graphical desktop is available' };
      let local = directory || workspacesBaseDir;
      if (require('../vm/tool-location').isVmOperation(() => vmService)) {
        const io = new (require('../vm/vm-fs').VmFs)({ vmService });
        const target = io.resolveVmPath(local);
        if (!target.ok) return target;
        local = vmService.toHostPath(target.vm);
        if (!local)
          return {
            ok: false,
            error: 'VM workspace has no host mirror. Export it with the VM file manager first.',
          };
        const external = vmService.externalPair(target.vm);
        const mapping = io
          .mappingRoots()
          .sort((a, b) => b[1].length - a[1].length)
          .find(([, vm]) => target.vm === vm || target.vm.startsWith(vm + '/'));
        if (!external && !mapping)
          return { ok: false, error: 'Workspace has no synchronized host mapping' };
        const result = external
          ? await vmService.pullExternalDir(target.vm, { force: true })
          : await vmService
              .workspacePair(...mapping)
              .sync({ direction: 'pull', reason: 'cwd-export' });
        if (!result.ok) return result;
      }
      return await require('../services/open-directory').openDirectory(local);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('workspace:openInExplorer', async (_, dirPath) => {
    if (require('../vm/tool-location').isVmOperation(() => vmService)) {
      try {
        const { VmFs } = require('../vm/vm-fs');
        const io = new VmFs({ vmService });
        const target = io.resolveVmPath(dirPath || '/workspace');
        if (!target.ok) return target;
        const graphics = vmService.graphicsController();
        await graphics.start();
        return await vmService.instance.exec(
          `${graphics._wlEnv()} cibyp-files ${require('../vm/vm-paths').shellQuote(target.vm)} >/dev/null 2>&1 &`,
        );
      } catch (error) {
        return { ok: false, location: 'vm', error: error.message };
      }
    }
    await shell.openPath(dirPath || workspacesBaseDir);
    return { ok: true };
  });

  ipcMain.handle('workspace:getFileTree', async (_, dirPath) => {
    try {
      if ((getSettings().runtime || {}).location === 'vm' && !vmService.emergencyHost) {
        const { VmFs } = require('../vm/vm-fs');
        const io = new VmFs({ vmService });
        const target = io.resolveVmPath(dirPath);
        if (!target.ok) return target;
        const nodes = await generateVmFileTree(io, target.vm, 0, 3);
        const render = (items, prefix = '') =>
          items
            .map((node, index) => {
              const last = index === items.length - 1;
              return (
                prefix +
                (last ? '└── ' : '├── ') +
                node.name +
                (node.type === 'directory' ? '/\n' : '\n') +
                render(node.children || [], prefix + (last ? '    ' : '│   '))
              );
            })
            .join('');
        return { ok: true, tree: render(nodes), source: 'vm' };
      }
      const tree = generateFileTree(dirPath, '', 0, 3); // 最多3层
      return { ok: true, tree };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  function generateFileTree(dir, prefix, depth, maxDepth) {
    if (depth >= maxDepth) return '';
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let result = '';
      entries.forEach((entry, i) => {
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        result += prefix + connector + entry.name + (entry.isDirectory() ? '/\n' : '\n');
        if (entry.isDirectory() && depth < maxDepth - 1) {
          result += generateFileTree(path.join(dir, entry.name), newPrefix, depth + 1, maxDepth);
        }
      });
      return result;
    } catch {
      return '';
    }
  }

  // Structured file tree for Code mode UI (returns array of {name, path, type, children?})
  function generateFileTreeStructured(dir, depth, maxDepth) {
    if (depth >= maxDepth) return [];
    const result = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return result;
    }
    // Skip hidden/node_modules/.git folders
    entries = entries.filter(
      (e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '.git',
    );
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const node = {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      };
      if (entry.isDirectory() && depth < maxDepth - 1) {
        node.children = generateFileTreeStructured(fullPath, depth + 1, maxDepth);
      }
      result.push(node);
    }
    return result;
  }

  // VM 模式文件树：直接读虚拟机（Monaco 保存只写 VM，宿主镜像可能是旧的）
  // node.path 返回宿主镜像路径（渲染层后续 fs:* 调用按映射自动作用于 VM）
  async function generateVmFileTree(vmFs, vmDir, depth, maxDepth) {
    const out = [];
    if (depth >= maxDepth) return out;
    const r = await vmFs.listDirectory(vmDir);
    if (!r.ok) throw new Error(r.error);
    if (!Array.isArray(r.entries)) throw new Error('VM 文件列表格式无效');
    const entries = r.entries.filter(
      (e) =>
        e && e.name && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '.git',
    );
    for (const entry of entries) {
      const vmPath = vmDir.replace(/\/+$/, '') + '/' + entry.name;
      const node = {
        name: entry.name,
        path: vmFs.toHost(vmPath) || vmPath,
        vmPath,
        type: entry.isDirectory ? 'directory' : 'file',
      };
      if (entry.isDirectory && depth < maxDepth - 1) {
        node.children = await generateVmFileTree(vmFs, vmPath, depth + 1, maxDepth);
      }
      out.push(node);
    }
    return out;
  }

  // ---- IPC: Code Mode (workspace + per-workspace history) ----
  // Code mode history is stored per-workspace to prevent cross-contamination.
  function getCodeHistoryDir(workspacePath) {
    if (!workspacePath) return null;
    // Store history inside the workspace itself in a .cibyp-code-history folder
    const histDir = require('../vm/tool-location').isVmOperation(() => vmService)
      ? path.join(
          app.getPath('userData'),
          'data',
          'code-history',
          require('node:crypto').createHash('sha256').update(workspacePath).digest('hex'),
        )
      : path.join(workspacePath, '.cibyp-code-history');
    try {
      fs.mkdirSync(histDir, { recursive: true });
    } catch {
      /* ignore */
    }
    return histDir;
  }

  ipcMain.handle('code:openWorkspace', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
      title: '选择 Code 模式工作区文件夹',
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    // Selection only: Code-OSS resolves/imports and persists after accepting the switch.
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('code:getLastWorkspace', () => getSettings().codeMode?.lastWorkspace || null);

  ipcMain.handle('code:setLastWorkspace', (_, wsPath) => {
    if (!wsPath || typeof wsPath !== 'string') return { ok: false };
    getSettings().codeMode = getSettings().codeMode || {};
    getSettings().codeMode.lastWorkspace = wsPath;
    persistSettings();
    return { ok: true };
  });

  function _codeHistoryMeta(id, data, filePath) {
    let ts = Number(data.ts);
    if (!isFinite(ts) || ts <= 0) {
      try {
        ts = fs.statSync(filePath).mtimeMs;
      } catch {
        ts = 0;
      }
    }
    return {
      id,
      title: data.title || '未命名',
      ts,
      messageCount: (data.messages || []).length,
      mode: data.mode || 'code',
      status: data.status || 'idle',
      lastError: data.lastError || null,
      usage: data.usage || null,
      workingMs: Number(data.workingMs) || 0,
    };
  }

  ipcMain.handle('code:listHistory', (_, workspacePath) => {
    const histDir = getCodeHistoryDir(workspacePath);
    if (!histDir) return { ok: false, error: 'no workspace' };
    try {
      flushPendingHistorySaves();
      const indexFile = _historyIndexFile('code', histDir);
      const entries = _getHistoryIndex(histDir, indexFile, _codeHistoryMeta);
      const files = Object.values(entries)
        .filter(Boolean)
        .sort((a, b) => b.ts - a.ts);
      return { ok: true, history: files };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('code:loadHistory', async (_, workspacePath, id) => {
    const histDir = getCodeHistoryDir(workspacePath);
    if (!histDir) return { ok: false, error: 'no workspace' };
    try {
      flushPendingHistorySaves();
      const data = _rehydrateHistoryImages(
        JSON.parse(fs.readFileSync(dataPath(histDir, id, '.json'), 'utf-8')),
      );
      // 运行位置护栏：会话属于另一种模式时，必须先完成一次成功的双向同步，否则拒绝加载（避免工作目录错乱）
      const cur =
        (getSettings().runtime && getSettings().runtime.location) === 'vm' ? 'vm' : 'host';
      const own = data && data.__runtimeLocation;
      if (own && own !== cur) {
        const sync = await vmService
          .syncWorkspace({ direction: 'both', reason: 'cross-mode-history' })
          .catch((e) => ({ ok: false, error: e.message }));
        if (!sync || !sync.ok) {
          return {
            ok: false,
            locationMismatch: true,
            ownLocation: own,
            error: `该会话在「${own === 'vm' ? '虚拟机' : '本机'}」模式下创建，切换前必须完成工作区同步（失败：${(sync && sync.error) || '未知原因'}）；请先在设置 → 运行位置 点「立即同步」后重试`,
          };
        }
        data.__runtimeLocation = cur;
        try {
          saveJSON(dataPath(histDir, id, '.json'), data, false);
        } catch {
          /* ignore */
        }
      }
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('code:saveHistory', (_, workspacePath, id, data) => {
    const histDir = getCodeHistoryDir(workspacePath);
    if (!histDir) return { ok: false, error: 'no workspace' };
    try {
      if (data && typeof data === 'object') {
        // 记录创建时的运行位置（主机/虚拟机），供跨模式继续会话时做同步护栏
        data.__runtimeLocation =
          (getSettings().runtime && getSettings().runtime.location) === 'vm' ? 'vm' : 'host';
        _externalizeHistoryImages(data);
      }
      queueHistorySave('code:' + id, dataPath(histDir, id, '.json'), data);
      if (data && typeof data === 'object') {
        _putHistoryIndexEntry(
          _historyIndexFile('code', histDir),
          id,
          _codeHistoryMeta(id, data, dataPath(histDir, id, '.json')),
        );
      }
      return { ok: true, queued: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('code:deleteHistory', (_, workspacePath, id) => {
    const histDir = getCodeHistoryDir(workspacePath);
    if (!histDir) return { ok: false, error: 'no workspace' };
    try {
      flushPendingHistorySaves();
      fs.unlinkSync(dataPath(histDir, id, '.json'));
      _removeHistoryIndexEntry(_historyIndexFile('code', histDir), id);
      _deleteHistoryImages(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('code:getFileTree', async (_, dirPath) => {
    try {
      const inVm = (getSettings().runtime || {}).location === 'vm' && !vmService.emergencyHost;
      if (inVm) {
        const s = String(dirPath || '');
        // 外部挂载：先把 VM 内的新改动拉回宿主镜像（资源管理器/ESLint 读宿主镜像）
        if (!vmService.isVmPath(s)) {
          await vmService.pullExternalDir(s).catch(() => {});
        }
        const { VmFs } = require('../vm/vm-fs');
        const vmFs = new VmFs({ vmService });
        const t = vmFs.mapVmTarget(s);
        if (t.ok) {
          const tree = await generateVmFileTree(vmFs, t.vm, 0, 4);
          return { ok: true, tree, source: 'vm' };
        }
        return { ok: false, error: t.error, source: 'vm' };
      }
      const tree = generateFileTreeStructured(dirPath, 0, 4); // 4 levels for code mode UI
      return { ok: true, tree };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  return { getCodeHistoryDir };
};
