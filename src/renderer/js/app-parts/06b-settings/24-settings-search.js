  // ============ 设置页搜索（Ctrl/Cmd+F 打开，仅设置页生效） ============
  const settingsSearch = (() => {
    const input = document.getElementById('settings-search-input');
    const countEl = document.getElementById('settings-search-count');
    if (!input || !countEl) return null;

    let query = '';
    let lastActiveTab = 'ai';

    function activateTab(tabId) {
      document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tabId));
    }

    function settingItemText(item) {
      let text = item.textContent || '';
      item.querySelectorAll('input, textarea, select').forEach(el => {
        text += ' ' + (el.value || '') + ' ' + (el.placeholder || '');
      });
      return text.toLowerCase();
    }

    function applyQuery() {
      const q = query;
      const panels = Array.from(document.querySelectorAll('#page-settings .settings-panel'));
      let matchCount = 0;
      let firstPanelTab = null;
      panels.forEach(panel => {
        const items = Array.from(panel.querySelectorAll(':scope > .settings-group > .setting-item, :scope > .setting-item'));
        let panelMatches = 0;
        items.forEach(item => {
          const ok = !q || settingItemText(item).includes(q);
          item.classList.toggle('settings-search-match', !!q && ok);
          item.style.display = q ? (ok ? '' : 'none') : '';
          if (q && ok) panelMatches++;
        });
        panel.querySelectorAll(':scope > .settings-group').forEach(group => {
          const hasVisibleItem = group.querySelector('.setting-item:not([style*="display: none"])');
          const titleMatch = q && group.querySelector('h3') && (group.querySelector('h3').textContent || '').toLowerCase().includes(q);
          group.style.display = q ? ((hasVisibleItem || titleMatch) ? '' : 'none') : '';
        });
        const panelVisible = !q || panelMatches > 0;
        panel.style.display = q ? (panelVisible ? '' : 'none') : '';
        if (panelVisible && q) {
          matchCount += panelMatches;
          if (!firstPanelTab) firstPanelTab = panel.dataset.tab;
        }
        const tab = document.querySelector(`.settings-tab[data-tab="${panel.dataset.tab}"]`);
        if (tab) tab.style.display = q ? (panelVisible ? '' : 'none') : '';
      });
      // 分组标题：组内 tab 全被过滤时隐藏
      document.querySelectorAll('#page-settings .settings-tab-group').forEach(header => {
        let visible = false;
        let el = header.nextElementSibling;
        while (el && !el.classList.contains('settings-tab-group')) {
          if (el.classList.contains('settings-tab') && !el.hidden && el.style.display !== 'none') { visible = true; break; }
          el = el.nextElementSibling;
        }
        header.style.display = q ? (visible ? '' : 'none') : '';
      });
      countEl.textContent = q ? `${matchCount} 项` : '';
      input.classList.toggle('has-results', !!q);
      if (q && firstPanelTab) activateTab(firstPanelTab);
      else if (!q) activateTab(lastActiveTab);
    }

    function open() {
      lastActiveTab = document.querySelector('.settings-tab.active')?.dataset.tab || 'ai';
      input.focus({ preventScroll: true });
      try { input.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      Promise.resolve().then(() => input.focus({ preventScroll: true }));
    }

    function close() {
      if (query || input.value) {
        query = '';
        input.value = '';
        applyQuery();
      }
      input.blur();
    }

    input.addEventListener('input', () => {
      query = input.value.trim().toLowerCase();
      applyQuery();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    document.querySelectorAll('.settings-tab').forEach(b => {
      b.addEventListener('click', () => { if (!query) lastActiveTab = b.dataset.tab; });
    });

    if (typeof window.registerPageSearch === 'function') {
      window.registerPageSearch('settings', { open, close });
    }
    return { open, close };
  })();

  // Settings change handlers
  async function saveSettings(updates) {
    const current = await window.api.getSettings();
    const merged = { ...current, ...updates };
    await window.api.setSettings(merged);
    // 全局字体即时生效
    if (typeof applyFontSettings === 'function') applyFontSettings(merged);
    // 即时生效：更新 maxTokens + 重算 systemPrompt（persona/llm 变更后立即生效，无需重启）
    if (typeof agent.applySettings === 'function') {
      agent.applySettings(merged);
    } else {
      agent.settings = merged;
    }
    // 隐私信息保护：同步到 Code / Babe 代理实例（其 settings 为独立快照）
    if (merged.privacyProtection) {
      if (typeof codeAgent !== 'undefined' && codeAgent && codeAgent.settings) codeAgent.settings.privacyProtection = merged.privacyProtection;
      if (typeof babeAgent !== 'undefined' && babeAgent && babeAgent.settings) babeAgent.settings.privacyProtection = merged.privacyProtection;
    }
  }
