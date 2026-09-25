  async function renameTreeNode(node) {
    // 使用自定义输入模态框替代 prompt()（prompt 在 Electron 中不受支持）
    const newName = await showInputModal('重命名', '输入新名称:', node.name);
    if (!newName || newName === node.name) return;
    const dir = node.path.substring(0, node.path.lastIndexOf(node.path.includes('\\') ? '\\' : '/'));
    const sep = node.path.includes('\\') ? '\\' : '/';
    const newPath = dir + sep + newName;
    const result = await window.api.moveFile(node.path, newPath);
    if (result && result.ok) {
      const tab = codeOpenTabs.find(t => t.path === node.path);
      if (tab) {
        tab.path = newPath;
        tab.name = newName;
        renderEditorTabs();
      }
      await loadCodeFileTree(codeWorkspacePath);
    } else {
      window.showMessageModal?.('重命名失败: ' + (result?.error || '未知错误'), '错误', 'error');
    }
  }

  async function deleteTreeNode(node) {
    const confirmed = await showConfirmModal('确认删除', '确定删除 ' + node.name + ' 吗？此操作不可恢复。');
    if (!confirmed) return;
    const result = node.type === 'directory'
      ? await window.api.deleteDirectory(node.path)
      : await window.api.deleteFile(node.path);
    if (result && result.ok) {
      // Close tab if open
      const idx = codeOpenTabs.findIndex(t => t.path === node.path);
      if (idx !== -1) closeTab(node.path);
      await loadCodeFileTree(codeWorkspacePath);
    } else {
      window.showMessageModal?.('删除失败: ' + (result?.error || '未知错误'), '错误', 'error');
    }
  }

  // 退订 agent 注册的 LLM 重试/流式事件监听器。
  // 旧监听器挂在 agent 实例上，若实例被置 null 后无法退订，
  // ipcRenderer 监听器会随每次新对话线性累积。
