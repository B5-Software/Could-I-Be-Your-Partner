  function updateCodePanelRestoreBar() {
    const fileTree = document.getElementById('code-file-tree-panel');
    const editor = document.getElementById('code-editor-panel');
    const chat = document.getElementById('code-chat');
    const r1 = document.getElementById('btn-restore-file-tree');
    const r2 = document.getElementById('btn-restore-editor');
    const r3 = document.getElementById('btn-restore-chat');
    const s1 = document.getElementById('code-resizer-1');
    const s2 = document.getElementById('code-resizer-2');
    r1?.classList.toggle('hidden', !fileTree?.classList.contains('collapsed'));
    r2?.classList.toggle('hidden', !editor?.classList.contains('collapsed'));
    r3?.classList.toggle('hidden', !chat?.classList.contains('collapsed'));
    // 隐藏相邻的分割器
    s1?.classList.toggle('hidden', fileTree?.classList.contains('collapsed'));
    s2?.classList.toggle('hidden', editor?.classList.contains('collapsed'));
    // 增量推送：面板折叠状态变更同步到 WebUI（推送相关元素的 class 属性）
    if (fileTree) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-file-tree-panel', attr: 'class', value: fileTree.className });
    if (editor) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-editor-panel', attr: 'class', value: editor.className });
    if (chat) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-chat', attr: 'class', value: chat.className });
    if (r1) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-file-tree', attr: 'class', value: r1.className });
    if (r2) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-editor', attr: 'class', value: r2.className });
    if (r3) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-restore-chat', attr: 'class', value: r3.className });
    if (s1) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-resizer-1', attr: 'class', value: s1.className });
    if (s2) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-resizer-2', attr: 'class', value: s2.className });
  }
  document.getElementById('btn-close-file-tree')?.addEventListener('click', () => {
    document.getElementById('code-file-tree-panel')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-close-editor')?.addEventListener('click', () => {
    document.getElementById('code-editor-panel')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-close-chat')?.addEventListener('click', () => {
    document.getElementById('code-chat')?.classList.add('collapsed');
    updateCodePanelRestoreBar();
  });
  // 恢复按钮
  document.getElementById('btn-restore-file-tree')?.addEventListener('click', () => {
    document.getElementById('code-file-tree-panel')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-restore-editor')?.addEventListener('click', () => {
    document.getElementById('code-editor-panel')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });
  document.getElementById('btn-restore-chat')?.addEventListener('click', () => {
    document.getElementById('code-chat')?.classList.remove('collapsed');
    updateCodePanelRestoreBar();
  });
