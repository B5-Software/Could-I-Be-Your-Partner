  // Search indexes labels and help, never stored API keys or passwords.
  const settingsSearch = (() => {
    const input = document.getElementById('settings-search-input');
    const count = document.getElementById('settings-search-count');
    const results = document.getElementById('settings-search-results');
    function applyQuery() {
      const query = input.value.trim().toLowerCase();
      results.replaceChildren(); results.hidden = !query;
      document.querySelectorAll('.settings-search-match').forEach(el => el.classList.remove('settings-search-match'));
      if (!query) { count.textContent = ''; return; }
      const words = query.split(/\s+/).filter(Boolean);
      const matches = [];
      document.querySelectorAll('#page-settings .settings-panel').forEach(panel => {
        if (panel.hidden) return;
        const info = settingsHelp[panel.dataset.tab] || [panel.dataset.tab, '', ''];
        panel.querySelectorAll('.setting-item').forEach(item => {
          for (let parent = item; parent && parent !== panel; parent = parent.parentElement) {
            if (parent.hidden || parent.style.display === 'none') return;
          }
          const label = item.querySelector('label')?.textContent.trim() || item.querySelector('button')?.textContent.trim();
          if (!label) return;
          const text = (item.textContent + ' ' + [...item.querySelectorAll('input, textarea')].map(el => el.placeholder || '').join(' ')).toLowerCase();
          const all = text + ' ' + info.join(' ').toLowerCase();
          if (words.every(word => all.includes(word))) matches.push({ item, panel, label, info,
            score: words.reduce((score, word) => score + (label.toLowerCase().includes(word) ? 6 : text.includes(word) ? 3 : 1), 0) });
        });
      });
      matches.sort((a, b) => b.score - a.score);
      count.textContent = matches.length + ' 项';
      const title = document.createElement('p'); title.className = 'setting-hint';
      title.textContent = matches.length ? '选择结果跳转到对应设置' : '没有匹配设置，试试“模型”“Token”“预算”或“虚拟机”。';
      results.append(title);
      for (const match of matches.slice(0, 20)) {
        const button = document.createElement('button'); button.type = 'button';
        const name = document.createElement('strong'); name.textContent = match.label;
        const path = document.createElement('span'); path.textContent = match.info[0];
        button.append(name, path);
        button.onclick = () => {
          window.activateSettingsTab(match.panel.dataset.tab);
          for (let parent = match.item.parentElement; parent && parent !== match.panel; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
          match.item.classList.add('settings-search-match');
          match.item.scrollIntoView({ block: 'center', behavior: motionEnabled() ? 'smooth' : 'instant' });
          match.item.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button')?.focus({ preventScroll: true });
          results.hidden = true;
        };
        results.append(button);
      }
    }
    function open() { input.focus({ preventScroll: true }); if (input.value) applyQuery(); }
    function close() { input.value = ''; applyQuery(); input.blur(); }
    input.addEventListener('input', applyQuery);
    input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    window.registerPageSearch?.('settings', { open, close });
    return { open, close };
  })();

  var settingsWriter;
  function getSettingsWriter() { return settingsWriter ||= SettingsClient.create(window.api, (state, error) => {
    const status = document.getElementById('settings-save-status');
    if (!status) return;
    status.dataset.state = state;
    status.textContent = state === 'saving' ? '正在保存…' : state === 'error' ? '保存失败：' + error.message : '已保存';
  }); }
  async function readSettings() { return getSettingsWriter().read(); }
  async function saveSettings(updates) {
    const saved = await getSettingsWriter().save(updates);
    if (typeof applyFontSettings === 'function') applyFontSettings(saved);
    for (const live of allLiveAgents()) live.applySettings(saved);
    window.refreshSettingsOverview?.(saved);
    window.refreshTokenSettings?.(saved);
    return saved;
  }
