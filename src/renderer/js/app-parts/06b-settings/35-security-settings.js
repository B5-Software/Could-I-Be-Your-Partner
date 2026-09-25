  document.getElementById('setting-auto-approve').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const confirmed = await window.api.confirmSensitive('开启自动批准敏感操作后，AI Agent将无需确认即可执行文件删除、终端命令等危险操作。\n\n确定要开启吗？');
      if (!confirmed) {
        e.target.checked = false;
        return;
      }
    }
    const s = await window.api.getSettings();
    s.autoApproveSensitive = e.target.checked;
    await saveSettings(s);
  });

  // 隐私信息保护：总开关与过滤触发器
  function updatePrivacyTriggerState(enabled) {
    const item = document.getElementById('privacy-trigger-item');
    if (item) {
      item.querySelectorAll('input').forEach(inp => { inp.disabled = !enabled; });
      item.style.opacity = enabled ? '' : '0.5';
    }
    const catItem = document.getElementById('privacy-categories-item');
    if (catItem) {
      catItem.querySelectorAll('input').forEach(inp => { inp.disabled = !enabled; });
      catItem.style.opacity = enabled ? '' : '0.5';
    }
  }

  async function savePrivacySettings() {
    const s = await window.api.getSettings();
    const categories = {};
    document.querySelectorAll('#privacy-categories-item input[data-cat]').forEach(inp => {
      categories[inp.dataset.cat] = inp.checked;
    });
    s.privacyProtection = {
      enabled: document.getElementById('setting-privacy-enabled').checked,
      filterResults: document.getElementById('setting-privacy-filter-results').checked,
      filterArgs: document.getElementById('setting-privacy-filter-args').checked,
      filterTerminal: document.getElementById('setting-privacy-filter-terminal').checked,
      filterAttachments: document.getElementById('setting-privacy-filter-attachments').checked,
      categories
    };
    await saveSettings(s);
  }

  document.getElementById('setting-privacy-enabled').addEventListener('change', (e) => {
    updatePrivacyTriggerState(e.target.checked);
    savePrivacySettings();
  });
  ['setting-privacy-filter-results', 'setting-privacy-filter-args', 'setting-privacy-filter-terminal'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => savePrivacySettings());
  });

  // 后台托盘：启用托盘图标
  document.getElementById('setting-tray-enabled')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    try {
      const r = await window.api.traySetEnabled(enabled);
      if (r && r.ok) {
        // 同步本地 settings 缓存
        try { agent.settings = r.settings; } catch {}
      } else {
        e.target.checked = !enabled; // 回滚
      }
    } catch (err) {
      console.error('[Tray] set enabled failed:', err);
      e.target.checked = !enabled;
    }
  });

  // 后台托盘：关闭窗口行为
  document.getElementById('setting-close-to-tray')?.addEventListener('change', async (e) => {
    const mode = e.target.value;
    if (!['ask', 'always', 'never'].includes(mode)) return;
    try {
      const r = await window.api.traySetCloseToTray(mode);
      if (r && r.ok) {
        try { agent.settings = r.settings; } catch {}
      }
    } catch (err) {
      console.error('[Tray] set closeToTray failed:', err);
    }
  });

  // 后台托盘：测试隐藏按钮
  document.getElementById('btn-tray-test-hide')?.addEventListener('click', () => {
    try { window.api.trayHideToTray(); } catch (err) {
      console.error('[Tray] test hide failed:', err);
    }
  });

  // Usage reset button
  document.getElementById('btn-reset-usage')?.addEventListener('click', async () => {
    const confirmed = await window.api.confirmSensitive('确定要重置每日使用量统计吗？\n\n这将清零今日的Token用量和图片生成数。');
    if (!confirmed) return;

    const s = await window.api.getSettings();
    s.llm.dailyTokensUsed = 0;
    s.llm.dailyTokenDate = '';
    s.imageGen.dailyImagesUsed = 0;
    s.imageGen.dailyImageDate = '';
    await saveSettings(s);

    // Refresh display
    document.getElementById('setting-llm-usage').textContent = '今日已用: 0';
    document.getElementById('setting-img-usage').textContent = '今日已用: 0';
    alert('使用量已重置');
  });

  // Firmware export button
  document.getElementById('btn-export-firmware')?.addEventListener('click', async () => {
    const result = await window.api.firmwareExport();
    if (result.ok) {
      showMessageModal(`固件源码已导出到：<br>${result.path}<br><br>请在 Arduino IDE 中打开 CIBYP-TRNG.ino 文件。`, '导出成功', 'success');
      window.api.openFileExplorer(result.path);
    } else {
      showMessageModal(`导出失败：${result.error || '未知错误'}`, '导出失败', 'error');
    }
  });

  // Arduino download link
  document.querySelectorAll('.link-arduino-download').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openBrowser('https://www.arduino.cc/en/software');
    });
  });
