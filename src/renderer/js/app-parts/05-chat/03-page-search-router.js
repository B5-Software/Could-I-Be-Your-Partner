  // ============ Ctrl/Cmd+F 页面级搜索路由 ============
  // 聊天搜索只作用于 Chat/Code/Babe 聊天界面；历史页/设置页各有自己的搜索，
  // 其余标签页不拦截 Ctrl+F，避免聊天搜索泄露到无关页面。
  window.__pageSearchHandlers = window.__pageSearchHandlers || {};
  window.registerPageSearch = function (pageId, handler) {
    if (pageId && handler) window.__pageSearchHandlers[pageId] = handler;
  };

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'f' && e.key !== 'F')) return;
    const active = document.querySelector('.page.active');
    const pageId = active ? String(active.id || '').replace(/^page-/, '') : '';
    if (pageId === 'chat' || pageId === 'code' || pageId === 'babe') {
      e.preventDefault();
      if (chatSearch) chatSearch.open();
      return;
    }
    const handler = window.__pageSearchHandlers[pageId];
    if (handler && typeof handler.open === 'function') {
      e.preventDefault();
      handler.open();
    }
  }, true);

  // 离开历史/设置等页面时关闭其搜索，恢复完整列表
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('.nav-item[data-page]');
    if (!nav) return;
    const target = nav.dataset.page;
    if (target === 'chat' || target === 'code' || target === 'babe') return;
    Object.values(window.__pageSearchHandlers || {}).forEach(h => {
      try { if (h && typeof h.close === 'function') h.close(); } catch { /* ignore */ }
    });
  }, true);
