  // ---- Code Mode ----
  // Separate agent instance for Code mode, with workspace-scoped history.
  let codeAgent = null;
  let codeWorkspacePath = null;
  let codeCurrentHistoryId = null;
  let codeMessages = []; // [{role, content}]
  let codeCurrentAttachments = []; // Code mode context attachments [{name, path, isImage, content, ext}]
  // 触发文件树刷新的工具集合（执行后可能增删/移动文件）
  const _fileSystemTools = new Set(['createFile', 'deleteFile', 'moveFile', 'copyFile', 'editFile', 'multiEditFile', 'writeFile', 'renameFile', 'mkdir', 'rmdir']);

  // Monaco Editor state
  let monacoEditor = null;
  let monacoReady = null;
  let codeOpenTabs = [];      // [{path, name, model, originalContent, dirty}]
  let codeActiveTabPath = null;
  let codeEditorModeFilter = 'chat';   // 'chat' | 'code' — tools page mode filter

  async function loadCodePage() {
    // 已有进行中的会话时保留内存中的工作区，避免切到 Chat 再切回时回退到上次持久化的工作区
    let wsPath = codeWorkspacePath;
    if (!wsPath) {
      wsPath = await window.api.codeGetLastWorkspace();
    }
    if (wsPath) {
      codeWorkspacePath = wsPath;
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = wsPath;
      await loadCodeFileTree(wsPath);
    } else {
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = '未选择工作区';
      const treeEl = document.getElementById('code-file-tree');
      if (treeEl) treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-folder-tree"></i><p>打开工作区后显示文件树</p></div>';
      // 无工作区时隐藏 ESLint 面板
      const eslintPanel = document.getElementById('code-eslint-panel');
      const eslintResizer = document.getElementById('code-eslint-resizer');
      if (eslintPanel) eslintPanel.style.display = 'none';
      if (eslintResizer) eslintResizer.style.display = 'none';
    }
    // Pre-warm Monaco loader (don't await — start in background)
    ensureMonaco().catch(err => console.warn('[Monaco] preload failed:', err));
  }

  async function loadCodeFileTree(dirPath) {
    const treeEl = document.getElementById('code-file-tree');
    if (!treeEl) return;
    treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载文件树...</p></div>';
    try {
      const result = await window.api.codeGetFileTree(dirPath);
      if (result.ok && result.tree) {
        renderCodeFileTree(treeEl, result.tree, dirPath);
      } else {
        treeEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>无法读取文件树</p></div>';
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: treeEl.innerHTML });
      }
    } catch (e) {
      treeEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: treeEl.innerHTML });
    }
    // 自动运行 ESLint（如果是支持的项目）
    if (dirPath) autoRunESLint(dirPath).catch(err => console.warn('[ESLint] auto run failed:', err));
  }
