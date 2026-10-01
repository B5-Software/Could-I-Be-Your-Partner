  // ---- Code Mode ----
  // Separate agent instance for Code mode, with workspace-scoped history.
  let codeAgent = null;
  let codeWorkspacePath = null;
  let codeCurrentHistoryId = null;
  let codeMessages = []; // [{role, content}]
  let codeCurrentAttachments = []; // Code mode context attachments [{name, path, isImage, content, ext}]

  // IDE documents, tabs, navigation and diagnostics belong to Code-OSS.
  const codeWorkbench = new CodeOSSController(window.api, document.getElementById('codeoss-viewport'), document.getElementById('codeoss-status'));
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
      const opened = await codeWorkbench.open(wsPath);
      if (opened.ok && opened.path) codeWorkspacePath = opened.path;
    } else {
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = '未选择工作区';
      const opened = await codeWorkbench.open(null);
      if (opened.ok && opened.path) codeWorkspacePath = opened.path;
    }
    codeWorkbench.scheduleLayout();
  }

  async function loadCodeFileTree(dirPath) {
    const opened = await codeWorkbench.open(dirPath);
    return opened;
  }
