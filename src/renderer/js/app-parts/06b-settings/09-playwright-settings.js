  async function loadPlaywrightSettings() {
    const s = await window.api.getSettings();
    const pw = s.playwright || {};
    const modeSelect = document.getElementById('setting-pw-mode');
    const pathInput = document.getElementById('setting-pw-path');
    const followLangCheckbox = document.getElementById('setting-pw-follow-lang');
    const headlessCheckbox = document.getElementById('setting-pw-headless');
    const bannerCheckbox = document.getElementById('setting-pw-banner-enabled');
    const argsTextarea = document.getElementById('setting-pw-args');
    const dataModeSelect = document.getElementById('setting-pw-data-mode');
    const customRow = document.getElementById('pw-custom-path-row');
    const testBtn = document.getElementById('btn-pw-test');
    const saveBtn = document.getElementById('btn-pw-save');
    const searchBtn = document.getElementById('btn-pw-search');
    const browseBtn = document.getElementById('btn-pw-browse');
    const detectedEl = document.getElementById('pw-detected-browsers');
    const testResultEl = document.getElementById('pw-test-result');

    if (modeSelect) modeSelect.value = pw.mode || 'auto';
    if (pathInput) pathInput.value = pw.path || '';
    if (followLangCheckbox) followLangCheckbox.checked = pw.followLang !== false;
    // UI 语义：checked = 有头模式；setting 语义：headless=true 表示无头
    if (headlessCheckbox) headlessCheckbox.checked = pw.headless !== true;
    // 横幅开关：默认开启，仅 headed 模式下显示
    if (bannerCheckbox) bannerCheckbox.checked = pw.bannerEnabled !== false;
    if (argsTextarea) argsTextarea.value = pw.args || '';
    if (dataModeSelect) dataModeSelect.value = pw.dataMode || 'isolated';

    // 浏览器数据模式：提示文案 + 行显隐
    const dataModeHint = document.getElementById('pw-data-mode-hint');
    const sourceRow = document.getElementById('pw-profile-source-row');
    const persistentResetRow = document.getElementById('pw-persistent-reset-row');
    function updateDataModeUi() {
      if (!dataModeSelect) return;
      const v = dataModeSelect.value;
      const hints = {
        isolated: '每次启动都是全新的浏览器，不保留 cookies/登录态。适合隐私优先或一次性任务。',
        persistent: '登录一次长期保留：cookies/localStorage 存入 Agent 专用目录（与系统浏览器完全隔离），跨会话生效。',
        'profile-copy': '首次使用时把系统浏览器的用户数据复制为独立副本，自带已有登录态。需先完全退出源浏览器；部分站点可能需要重新登录一次。'
      };
      if (dataModeHint) dataModeHint.textContent = hints[v] || '';
      if (sourceRow) sourceRow.style.display = v === 'profile-copy' ? '' : 'none';
      if (persistentResetRow) persistentResetRow.style.display = v === 'persistent' ? '' : 'none';
    }
    if (dataModeSelect) {
      dataModeSelect.addEventListener('change', updateDataModeUi);
      updateDataModeUi();
    }

    // 复制系统浏览器配置
    const copyBtn = document.getElementById('btn-pw-copy-profile');
    const copyStatus = document.getElementById('pw-copy-status');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const sourceSel = document.getElementById('setting-pw-profile-source');
        const src = sourceSel ? sourceSel.value : 'chrome';
        if (copyStatus) { copyStatus.textContent = '复制中…（可在弹窗查看进度）'; copyStatus.style.color = 'var(--text-secondary)'; }
        copyBtn.disabled = true;
        try {
          const r = await window.api.pwCopyProfile(src);
          if (r && r.ok) {
            if (copyStatus) {
              copyStatus.textContent = `✅ 已复制 ${r.files} 个文件（${(r.bytes / 1048576).toFixed(1)} MB）到专用目录`;
              copyStatus.style.color = 'var(--success, #4caf50)';
            }
          } else if (r && r.canceled) {
            if (copyStatus) copyStatus.textContent = '已取消';
          } else {
            if (copyStatus) { copyStatus.textContent = '❌ ' + ((r && r.error) || '复制失败'); copyStatus.style.color = 'var(--danger, #f44336)'; }
          }
        } catch (e) {
          if (copyStatus) { copyStatus.textContent = '❌ ' + e.message; copyStatus.style.color = 'var(--danger, #f44336)'; }
        } finally {
          copyBtn.disabled = false;
        }
      });
    }

    // Show/hide custom path row
    function updateCustomRowVisibility() {
      if (!modeSelect || !customRow) return;
      if (modeSelect.value === 'custom') {
        customRow.style.display = '';
      } else {
        customRow.style.display = 'none';
      }
    }
    if (modeSelect) {
      modeSelect.addEventListener('change', updateCustomRowVisibility);
      updateCustomRowVisibility();
    }

    // Browse for browser binary
    if (browseBtn) {
      browseBtn.addEventListener('click', async () => {
        const result = await window.api.pwBrowserDialog();
        if (result.ok && pathInput) {
          pathInput.value = result.path;
        }
      });
    }

    // Search for browsers
    if (searchBtn) {
      searchBtn.addEventListener('click', async () => {
        if (detectedEl) {
          detectedEl.innerHTML = '<span style="color:var(--text-tertiary)">搜索中...</span>';
        }
        const result = await window.api.pwSearchBrowsers();
        if (result.ok && result.browsers && result.browsers.length > 0) {
          detectedEl.innerHTML = result.browsers.map(b =>
            `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>${b.name}</span><code style="font-size:11px;color:var(--accent)">${b.path}</code></div>`
          ).join('');
        } else {
          detectedEl.innerHTML = '<span style="color:var(--danger)">未检测到已安装的浏览器</span>';
        }
      });
    }

    // Test launch
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        if (testResultEl) {
          testResultEl.textContent = '测试中...';
          testResultEl.style.color = 'var(--text-secondary)';
        }
        const testSettings = {
          mode: modeSelect ? modeSelect.value : 'auto',
          path: pathInput ? pathInput.value : '',
          followLang: followLangCheckbox ? followLangCheckbox.checked : true,
          headless: headlessCheckbox ? !headlessCheckbox.checked : false,
          bannerEnabled: bannerCheckbox ? bannerCheckbox.checked : true,
          args: argsTextarea ? argsTextarea.value : '',
          dataMode: dataModeSelect ? dataModeSelect.value : 'isolated'
        };
        // 先持久化设置：测试启动即应用，避免用户忘记点"保存"导致 Agent 调用仍用旧浏览器
        try {
          const s2 = await window.api.getSettings();
          s2.playwright = testSettings;
          await saveSettings(s2);
          await window.api.pwCloseBrowser();
        } catch (e) {
          console.warn('Test launch: persist settings failed:', e);
        }
        const result = await window.api.pwTestLaunch(testSettings);
        if (testResultEl) {
          if (result.ok) {
            testResultEl.textContent = '✅ ' + (result.message || '测试成功');
            testResultEl.style.color = 'var(--success, #4caf50)';
          } else {
            testResultEl.textContent = '❌ ' + (result.error || '测试失败');
            testResultEl.style.color = 'var(--danger, #f44336)';
          }
        }
      });
    }

    // Save
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const s2 = await window.api.getSettings();
        s2.playwright = {
          mode: modeSelect ? modeSelect.value : 'auto',
          path: pathInput ? pathInput.value : '',
          followLang: followLangCheckbox ? followLangCheckbox.checked : true,
          headless: headlessCheckbox ? !headlessCheckbox.checked : false,
          bannerEnabled: bannerCheckbox ? bannerCheckbox.checked : true,
          args: argsTextarea ? argsTextarea.value : '',
          dataMode: dataModeSelect ? dataModeSelect.value : 'isolated'
        };
        await saveSettings(s2);
        // Close existing browser so next launch uses new settings
        await window.api.pwCloseBrowser();
        if (testResultEl) {
          testResultEl.textContent = '✅ ' + (typeof i18nGetLanguage === 'function' && i18nGetLanguage() !== 'zh-CN' ? 'Settings saved' : '设置已保存');
          testResultEl.style.color = 'var(--success, #4caf50)';
        }
      });
    }
  }
  loadPlaywrightSettings();

  // ── Budget Control Settings ──
  // 数据结构：settings.budget = {
  //   monthlyCapUsd, dailyLimitUSD, overAction, fallbackModel, warningThreshold,
  //   models: { [modelId]: { inputPerM, cacheReadPerM, outputPerM, cacheWritePerM, hasCacheWrite } },
  //   peakHours: { enabled, start, end, inputMul, cacheReadMul, outputMul, cacheWriteMul }
  // }
