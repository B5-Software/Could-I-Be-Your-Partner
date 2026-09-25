  // ---- 终端可见化：模态框 + Ctrl+T + xterm.js ----
  // 让所有 node-pty 终端可见（默认后台监听，Agent 也在操作）
  // 用户可通过 Ctrl+T 或 Code 工具栏的"显示终端"按钮打开终端模态框
  // 不同 terminalID 以标签页形式显示，用户可操作
  (function initTerminalModal() {
    const modal = document.getElementById('terminal-modal');
    const tabsEl = document.getElementById('terminal-tabs');
    const containerEl = document.getElementById('terminal-container');
    if (!modal || !tabsEl || !containerEl) return;
    if (typeof window.Terminal === 'undefined') {
      console.warn('[Terminal] xterm.js 未加载，跳过初始化');
      return;
    }

    // 终端实例缓存：id -> { term, fit, panel, exited }
    const instances = new Map();
    let activeId = null;
    let dataListenerBound = false;

    // 获取当前主题（强调色 + 深浅色）
    function getXtermTheme() {
      const isDark = document.documentElement.dataset.theme !== 'light';
      const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#6366f1';
      return {
        background: isDark ? '#1e1e2e' : '#ffffff',
        foreground: isDark ? '#cdd6f4' : '#1e1e2e',
        cursor: accent,
        cursorAccent: isDark ? '#1e1e2e' : '#ffffff',
        selectionBackground: accent + '40',
        black: '#1e1e2e',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: isDark ? '#cdd6f4' : '#1e1e2e',
        brightBlack: isDark ? '#585b70' : '#a6adc8',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: isDark ? '#ffffff' : '#000000'
      };
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // 创建 xterm 实例并附加到指定面板
    function createTerminalPanel(id) {
      const panel = document.createElement('div');
      panel.className = 'terminal-panel';
      panel.dataset.terminalId = String(id);
      panel.style.display = 'none';
      containerEl.appendChild(panel);

      const term = new window.Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Consolas, "Courier New", Menlo, monospace',
        theme: getXtermTheme(),
        allowProposedApi: true,
        scrollback: 5000
      });

      let fit = null;
      const FitCtor = (window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon)) || null;
      if (FitCtor) {
        try {
          fit = new FitCtor();
          term.loadAddon(fit);
        } catch (e) { console.warn('[Terminal] FitAddon load failed:', e); }
      }

      term.open(panel);

      // 用户输入回写到 pty
      term.onData(data => {
        window.api.writeTerminal?.(id, data).catch(() => {});
      });
      // 调整大小时通知 pty
      term.onResize(({ cols, rows }) => {
        window.api.resizeTerminal?.(id, cols, rows).catch(() => {});
      });

      // 异步加载历史并 fit
      setTimeout(() => {
        if (fit) { try { fit.fit(); } catch {} }
        window.api.getTerminalHistory?.(id).then(result => {
          if (result && result.ok && result.history) {
            try { term.write(result.history); } catch {}
          }
        }).catch(() => {});
      }, 50);

      instances.set(id, { term, fit, panel, exited: false });
      return instances.get(id);
    }

    function createTabElement(meta) {
      const tab = document.createElement('div');
      tab.className = 'terminal-tab';
      tab.dataset.terminalId = String(meta.id);
      const label = meta.lastCommand || `终端 ${meta.id}`;
      const cwdName = meta.cwd ? meta.cwd.split(/[/\\]/).pop() : '';
      tab.innerHTML = `<i class="fa-solid fa-terminal"></i>
        <span class="terminal-tab-label">${escapeHtml(label)}</span>
        ${cwdName ? `<span class="terminal-tab-cwd" title="${escapeHtml(meta.cwd)}">${escapeHtml(cwdName)}</span>` : ''}
        <button class="terminal-tab-close" title="关闭此终端" type="button"><i class="fa-solid fa-xmark"></i></button>`;
      // 点击 tab 本身：切换终端
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.terminal-tab-close')) return; // 关闭按钮单独处理
        switchToTerminal(meta.id);
      });
      // 关闭按钮：杀掉该终端，并阻止冒泡
      const closeBtn = tab.querySelector('.terminal-tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.api.killTerminal(meta.id);
          // onTerminalExit 会触发 refreshTerminalList
        });
      }
      return tab;
    }

    function switchToTerminal(id) {
      activeId = id;
      tabsEl.querySelectorAll('.terminal-tab').forEach(t => {
        t.classList.toggle('active', String(t.dataset.terminalId) === String(id));
      });
      containerEl.querySelectorAll('.terminal-panel').forEach(p => {
        p.style.display = String(p.dataset.terminalId) === String(id) ? 'block' : 'none';
      });
      const inst = instances.get(id);
      if (inst) {
        if (inst.fit) { try { inst.fit.fit(); } catch {} }
        try { inst.term.focus(); } catch {}
      }
    }

    function showEmptyState() {
      let empty = containerEl.querySelector('.terminal-empty');
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'terminal-empty';
        empty.innerHTML = `<i class="fa-solid fa-terminal"></i>
          <p class="terminal-empty-title">暂无终端</p>
          <p class="terminal-empty-hint">点击右上角 <i class="fa-solid fa-plus"></i> 新建终端，或 Agent 调用终端工具时会自动出现</p>`;
        containerEl.appendChild(empty);
      }
      empty.style.display = 'flex';
    }
    function hideEmptyState() {
      const empty = containerEl.querySelector('.terminal-empty');
      if (empty) empty.style.display = 'none';
    }

    async function refreshTerminalList() {
      if (typeof window.api.listTerminals !== 'function') return;
      const result = await window.api.listTerminals();
      if (!result || !result.ok) return;
      const existingTabs = new Set(Array.from(tabsEl.querySelectorAll('.terminal-tab')).map(t => t.dataset.terminalId));
      const currentIds = new Set(result.terminals.map(t => String(t.id)));

      // 添加新终端的 tab + panel
      for (const meta of result.terminals) {
        const sid = String(meta.id);
        if (!existingTabs.has(sid)) {
          tabsEl.appendChild(createTabElement(meta));
          createTerminalPanel(meta.id);
        } else {
          // 更新现有 tab 的标签
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${sid}"]`);
          if (tab) {
            const label = meta.lastCommand || `终端 ${meta.id}`;
            const labelEl = tab.querySelector('.terminal-tab-label');
            if (labelEl) labelEl.textContent = label;
          }
        }
      }

      // 移除已退出的 tab + panel
      for (const existingId of existingTabs) {
        if (!currentIds.has(existingId)) {
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${existingId}"]`);
          if (tab) tab.remove();
          const inst = instances.get(Number(existingId));
          if (inst) {
            try { inst.term.dispose(); } catch {}
            instances.delete(Number(existingId));
          }
          const panel = containerEl.querySelector(`.terminal-panel[data-terminal-id="${existingId}"]`);
          if (panel) panel.remove();
        }
      }

      // 若无激活终端，激活第一个；若激活的已退出，切换到第一个
      if (activeId === null || !currentIds.has(String(activeId))) {
        if (result.terminals.length > 0) {
          switchToTerminal(result.terminals[0].id);
          hideEmptyState();
        } else {
          activeId = null;
          showEmptyState();
        }
      } else {
        hideEmptyState();
      }
    }

    async function openTerminalModal() {
      modal.classList.remove('hidden');
      await refreshTerminalList();
      setTimeout(() => {
        const inst = instances.get(activeId);
        if (inst) {
          if (inst.fit) { try { inst.fit.fit(); } catch {} }
          try { inst.term.focus(); } catch {}
        }
      }, 100);
    }
    function closeTerminalModal() {
      fadeOutHide(modal);
    }

    document.getElementById('btn-code-show-terminals')?.addEventListener('click', openTerminalModal);
    document.getElementById('btn-chat-show-terminals')?.addEventListener('click', openTerminalModal);
    document.getElementById('btn-close-terminal-modal')?.addEventListener('click', closeTerminalModal);

    document.getElementById('btn-terminal-new')?.addEventListener('click', async () => {
      // 优先使用 Code 模式工作区，其次 Chat 模式工作目录
      let cwd = codeWorkspacePath || null;
      if (!cwd && typeof agent !== 'undefined' && agent && agent.workspacePath) {
        cwd = agent.workspacePath;
      }
      const result = await window.api.makeTerminal(cwd);
      if (result && result.ok) {
        await refreshTerminalList();
        switchToTerminal(result.terminalId);
      } else {
        const msg = '创建终端失败：' + (result?.error || '未知错误');
        if (window.showMessageModal) window.showMessageModal(msg, '错误', 'error');
        else console.error('[Terminal]', msg);
      }
    });

    // 实时数据推送：仅当模态框打开时才写入 xterm（数据已在主进程的 fullHistory 中累积）
    function bindDataListener() {
      if (dataListenerBound) return;
      dataListenerBound = true;
      window.api.onTerminalData?.(({ id, data }) => {
        if (modal.classList.contains('hidden')) return; // 模态框关闭时不渲染（节省性能）
        const inst = instances.get(id);
        if (inst && inst.term) {
          try { inst.term.write(data); } catch {}
        }
      });
      window.api.onTerminalExit?.(({ id }) => {
        const inst = instances.get(id);
        if (inst) {
          inst.exited = true;
          try { inst.term.write('\r\n\x1b[33m[终端已退出]\x1b[0m\r\n'); } catch {}
          const tab = tabsEl.querySelector(`.terminal-tab[data-terminal-id="${id}"]`);
          if (tab) tab.classList.add('terminal-tab-exited');
        }
        setTimeout(refreshTerminalList, 200);
      });
    }
    bindDataListener();

    // Ctrl+T 快捷键：模态框关闭时打开，已打开时新建终端
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        // 避免与输入框冲突
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        if (modal.classList.contains('hidden')) {
          openTerminalModal();
        } else {
          document.getElementById('btn-terminal-new')?.click();
        }
      }
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeTerminalModal();
      }
    });

    // 主题切换时刷新所有 xterm 实例
    const themeObserver = new MutationObserver(() => {
      if (instances.size === 0) return;
      const theme = getXtermTheme();
      for (const { term } of instances.values()) {
        try { term.options.theme = theme; } catch {}
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // 模态框尺寸变化时触发 fit
    const resizeObserver = new ResizeObserver(() => {
      const inst = instances.get(activeId);
      if (inst && inst.fit) { try { inst.fit.fit(); } catch {} }
    });
    resizeObserver.observe(containerEl);
  })();
