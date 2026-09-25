  function _fileManagerName() {
    try {
      if (window.api?.platform === 'darwin') return 'Finder';
    } catch { /* ignore */ }
    return '资源管理器';
  }
  function showCodeFileTreeContextMenu(e, node) {
    // Remove any existing menu
    const existing = document.querySelector('.file-tree-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'file-tree-context-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:var(--bg-secondary,#fff);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:4px 0;min-width:180px;font-size:0.85em;left:' + e.clientX + 'px;top:' + e.clientY + 'px;';

    const fmName = _fileManagerName();
    const isFile = node.type === 'file';
    const items = [];
    if (isFile) {
      items.push({ icon: 'fa-comment-dots', label: '添加到上下文', action: () => addFileToCodeContext(node) });
      items.push({ icon: 'fa-copy', label: '复制路径', action: () => { navigator.clipboard.writeText(node.path).catch(() => {}); } });
      items.push({ icon: 'fa-folder-open', label: `在${fmName}中显示`, action: () => window.api.openFileExplorer?.(node.path) });
    } else {
      items.push({ icon: 'fa-folder-open', label: `在${fmName}中打开`, action: () => window.api.openFileExplorer?.(node.path) });
    }
    items.push({ icon: 'fa-pen', label: '重命名', action: () => renameTreeNode(node) });
    items.push({ icon: 'fa-trash', label: '删除', danger: true, action: () => deleteTreeNode(node) });

    for (const item of items) {
      const el = document.createElement('div');
      el.style.cssText = 'padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap;' + (item.danger ? 'color:#dc3545;' : '');
      el.innerHTML = '<i class="fa-solid ' + item.icon + '" style="width:14px;"></i><span>' + escapeHtml(item.label) + '</span>';
      el.addEventListener('mouseenter', () => { el.style.background = item.danger ? 'rgba(220,53,69,0.1)' : 'var(--bg-hover,rgba(0,0,0,0.05))'; });
      el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
      el.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(el);
    }
    document.body.appendChild(menu);

    // Adjust position if out of viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    // Close on outside click
    setTimeout(() => {
      const closer = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('click', closer);
          document.removeEventListener('contextmenu', closer);
        }
      };
      document.addEventListener('click', closer);
      document.addEventListener('contextmenu', closer);
    }, 100);
  }

  async function addFileToCodeContext(node) {
    // 避免重复添加
    if (codeCurrentAttachments.some(a => a.path === node.path)) {
      window.showMessageModal?.('该文件已在上下文中', '提示', 'info');
      return;
    }
    const readRes = await window.api.readFile(node.path);
    if (!readRes.ok) {
      window.showMessageModal?.('无法读取文件: ' + (readRes.error || '未知错误'), '错误', 'error');
      return;
    }
    const ext = (node.name.split('.').pop() || '').toLowerCase();
    const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(node.name);
    codeCurrentAttachments.push({
      name: node.name,
      path: node.path,
      isImage,
      content: readRes.content || '',
      ext
    });
    renderCodeAttachments();
  }
