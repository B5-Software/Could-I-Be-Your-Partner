  function closeSessionBatch(mode, keys) {
    if (!sessionManager || !keys || !keys.size) return;
    const targets = sessionManager.list(mode).filter(s => keys.has(s.key));
    if (!targets.length) return;
    const activeKey = sessionManager.getActive(mode)?.key || null;
    const runningCount = targets.filter(s => s.status === SessionStatus.RUNNING
      || s.status === SessionStatus.WAITING_APPROVAL
      || s.status === SessionStatus.WAITING_TOOL_AUTH).length;
    const noun = targets.length === 1
      ? `会话“${targets[0].title || '未命名'}”`
      : `${targets.length} 个会话`;
    if (runningCount > 0 && !window.confirm(`${noun}仍在运行，确定停止并关闭吗？`)) return;
    for (const session of targets) {
      sessionManager.stop(session);
      sessionManager.close(session);
    }
    renderAllSessionTabs();
    const remaining = sessionManager.ordered(mode);
    if (!remaining.length) {
      // 关闭最后一个标签页 → 打开一个新会话标签页
      createNewSession(mode).catch(e => console.error('[sessions] 新建会话失败:', e));
      return;
    }
    if (activeKey && keys.has(activeKey)) {
      activateSession(mode, remaining[0].key);
    }
  }

  function closeSession(session) {
    if (!session) return;
    closeSessionBatch(session.mode, new Set([session.key]));
  }

  // 标签页右键菜单：打开工作目录 / 批量关闭
  function showSessionTabContextMenu(e, mode, session) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.session-tab-menu').forEach(m => m.remove());
    const sessions = sessionManager.ordered(mode);
    const idx = sessions.findIndex(s => s.key === session.key);
    const workspacePath = session.agent?.codeWorkspacePath || session.agent?.workspacePath || '';
    const menu = document.createElement('div');
    menu.className = 'session-tab-menu';
    menu.style.cssText = [
      'position:fixed',
      `left:${e.clientX}px`,
      `top:${e.clientY}px`,
      'background:var(--bg-primary)',
      'border:1px solid var(--border)',
      'border-radius:8px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.25)',
      'padding:4px 0',
      'z-index:10001',
      'min-width:200px'
    ].join(';');

    const items = [
      {
        icon: 'fa-folder-open',
        label: '打开工作目录',
        disabled: !workspacePath,
        action: () => { if (workspacePath) window.api.openFileExplorer(workspacePath); }
      },
      {
        icon: 'fa-xmark',
        label: '关闭此标签页',
        action: () => closeSessionBatch(mode, new Set([session.key]))
      },
      {
        icon: 'fa-angles-left',
        label: '关闭左侧所有标签页',
        disabled: idx <= 0,
        action: () => closeSessionBatch(mode, new Set(sessions.slice(0, idx).map(s => s.key)))
      },
      {
        icon: 'fa-angles-right',
        label: '关闭右侧所有标签页',
        disabled: idx >= sessions.length - 1,
        action: () => closeSessionBatch(mode, new Set(sessions.slice(idx + 1).map(s => s.key)))
      },
      {
        icon: 'fa-minus',
        label: '关闭其他标签页',
        disabled: sessions.length <= 1,
        action: () => closeSessionBatch(mode, new Set(sessions.filter(s => s.key !== session.key).map(s => s.key)))
      },
      {
        icon: 'fa-ban',
        label: '关闭所有标签页',
        danger: true,
        action: () => closeSessionBatch(mode, new Set(sessions.map(s => s.key)))
      }
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.style.cssText = [
        'padding:7px 14px',
        'display:flex',
        'align-items:center',
        'gap:10px',
        'font-size:13px',
        'white-space:nowrap',
        'cursor:' + (item.disabled ? 'not-allowed' : 'pointer'),
        'color:' + (item.disabled ? 'var(--text-tertiary)' : (item.danger ? 'var(--danger)' : 'var(--text-primary)')),
        'opacity:' + (item.disabled ? '0.55' : '1'),
        'transition:background 0.15s'
      ].join(';');
      row.innerHTML = `<i class="fa-solid ${item.icon}" style="width:16px;font-size:12px"></i><span>${escapeHtml(item.label)}</span>`;
      if (!item.disabled) {
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        row.addEventListener('click', () => {
          menu.remove();
          item.action();
        });
      }
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const closeMenu = (evt) => {
      if (!menu.contains(evt.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
        document.removeEventListener('contextmenu', closeMenu);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
      document.addEventListener('contextmenu', closeMenu);
    }, 0);
  }
