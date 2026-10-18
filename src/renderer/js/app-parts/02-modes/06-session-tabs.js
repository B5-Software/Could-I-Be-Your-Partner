  function renderSessionTabs(mode) {
    if (!sessionManager) return;
    const tabsEl = document.getElementById(`${mode}-session-tabs`);
    if (!tabsEl) return;
    const sessions = sessionManager.ordered(mode);
    tabsEl.setAttribute('role', 'tablist');
    tabsEl.setAttribute('aria-label', mode + ' sessions');
    tabsEl.setAttribute('aria-orientation', document.documentElement.dataset.frontend === 'v2' ? 'vertical' : 'horizontal');
    // 标签栏常驻：即使没有会话也只显示“新建会话”按钮；
    // 可见性统一由 showSessionTabsForMode 控制（宿主在 page section 之外）。
    tabsEl.innerHTML = '';
    const active = sessionManager.getActive(mode);
    for (const session of sessions) {
      const attentionMeta = (typeof sessionAttentionMeta === 'function') ? sessionAttentionMeta(session.attention) : null;
      const dotClass = attentionMeta
        ? `attention ${attentionMeta.cls}`
        : escapeHtml(session.status);
      const dotTitle = attentionMeta ? attentionMeta.label : '';
      const attentionBadge = attentionMeta
        ? `<span class="session-attention-badge ${attentionMeta.cls}"><i class="fa-solid ${attentionMeta.icon}"></i>${escapeHtml(attentionMeta.label.replace('等待', ''))}</span>`
        : '';
      const tab = document.createElement('div');
      tab.className = 'session-tab' + (active?.key === session.key ? ' active' : '');
      tab.dataset.sessionKey = session.key;
      tab.dataset.historyId = String(session.id);
      tab.draggable = true;
      tab.tabIndex = 0;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(active?.key === session.key));
      tab.setAttribute('aria-controls', 'page-' + mode);
      tab.title = session.title || '未命名会话';
      tab.innerHTML = `
        <span class="session-status-dot ${dotClass}" ${dotTitle ? `title="${escapeHtml(dotTitle)}"` : ''}></span>
        <span class="session-tab-title">${escapeHtml(session.title || '未命名会话')}</span>
        ${attentionBadge}
        <button type="button" class="session-tab-close" title="关闭会话" aria-label="关闭会话"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.session-tab-close')) return;
        activateSession(mode, session.key);
        if (document.documentElement.dataset.frontend === 'v2') navigatePage(mode);
      });
      tab.addEventListener('keydown', (e) => {
        if (e.target !== tab) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activateSession(mode, session.key);
          navigatePage(mode);
        } else {
          const vertical = document.documentElement.dataset.frontend === 'v2';
          const previous = vertical ? 'ArrowUp' : 'ArrowLeft';
          const next = vertical ? 'ArrowDown' : 'ArrowRight';
          if (![previous, next, 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const rows = [...tabsEl.querySelectorAll('.session-tab:not(.v2-filtered)')];
          const index = rows.indexOf(tab);
          const target = e.key === 'Home' ? rows[0] : e.key === 'End' ? rows.at(-1)
            : rows[(index + (e.key === previous ? -1 : 1) + rows.length) % rows.length];
          target?.focus();
        }
      });
      tab.addEventListener('mouseenter', () => {
        if (tab.classList.contains('dragging')) return;
        showSessionTabPopover(session, tab);
      });
      tab.addEventListener('mouseleave', () => {
        hideSessionTabPopover();
      });
      tab.addEventListener('contextmenu', (e) => {
        hideSessionTabPopover();
        showSessionTabContextMenu(e, mode, session);
      });
      // ---- 拖动排序 ----
      tab.addEventListener('dragstart', (e) => {
        hideSessionTabPopover();
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', session.key); } catch { /* ignore */ }
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        clearSessionDragIndicators(tabsEl);
      });
      const closeBtn = tab.querySelector('.session-tab-close');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSessionBatch(session.mode, new Set([session.key]));
      });
      tabsEl.appendChild(tab);
    }
    // ---- 栏级拖放目标 ----
    tabsEl.ondragover = (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types || !Array.from(e.dataTransfer.types).includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetTab = e.target && e.target.closest ? e.target.closest('.session-tab') : null;
      clearSessionDragIndicators(tabsEl);
      if (targetTab) {
        const rect = targetTab.getBoundingClientRect();
        const after = document.documentElement.dataset.frontend === 'v2'
          ? e.clientY > rect.top + rect.height / 2 : e.clientX > rect.left + rect.width / 2;
        targetTab.classList.add(after ? 'drop-target-after' : 'drop-target-before');
      }
    };
    tabsEl.ondragleave = (e) => {
      if (!tabsEl.contains(e.relatedTarget)) clearSessionDragIndicators(tabsEl);
    };
    tabsEl.ondrop = (e) => {
      e.preventDefault();
      const key = e.dataTransfer ? (e.dataTransfer.getData('text/plain') || '') : '';
      clearSessionDragIndicators(tabsEl);
      if (!key || !sessionManager.get(key)) return;
      const tabEls = Array.from(tabsEl.querySelectorAll('.session-tab'));
      let index = tabEls.length;
      const targetTab = e.target && e.target.closest ? e.target.closest('.session-tab') : null;
      if (targetTab) {
        const rect = targetTab.getBoundingClientRect();
        const after = document.documentElement.dataset.frontend === 'v2'
          ? e.clientY > rect.top + rect.height / 2 : e.clientX > rect.left + rect.width / 2;
        index = tabEls.indexOf(targetTab) + (after ? 1 : 0);
      }
      const previousIndex = tabEls.findIndex(tab => tab.dataset.sessionKey === key);
      if (previousIndex >= 0 && previousIndex < index) index--;
      try { sessionManager.reorder(mode, key, index); } catch { /* ignore */ }
      renderAllSessionTabs();
    };
    const add = document.createElement('button');
    add.className = 'session-tab-add';
    add.title = '新建会话';
    add.innerHTML = '<i class="fa-solid fa-plus"></i>';
    add.addEventListener('click', () => createNewSession(mode));
    tabsEl.appendChild(add);
    // 多会话镜像：标签栏内容变更增量推送到 WebUI，保持远端标签栏实时一致
    if (!isRemoteMode) {
      try {
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#' + tabsEl.id, html: tabsEl.innerHTML });
      } catch { /* ignore */ }
    }
  }

  function renderAllSessionTabs() {
    renderSessionTabs('chat');
    renderSessionTabs('code');
    renderSessionTabs('babe');
    window.dispatchEvent(new Event('cibyp:sessions-rendered'));
  }

  function clearSessionDragIndicators(tabsEl) {
    if (!tabsEl) return;
    tabsEl.querySelectorAll('.drop-target-before, .drop-target-after, .dragging').forEach(el => {
      el.classList.remove('drop-target-before', 'drop-target-after');
    });
  }
