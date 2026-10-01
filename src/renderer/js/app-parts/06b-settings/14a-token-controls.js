  function refreshTokenSettings(settings) {
    const s = settings || agent.settings;
    const set = (id, value, check = false) => {
      const el = document.getElementById(id);
      if (!el || document.activeElement === el) return;
      if (check) el.checked = !!value; else el.value = String(value);
    };
    set('setting-llm-ctx', s.llm.maxContextLength);
    set('setting-llm-max-response', s.llm.maxResponseTokens);
    set('setting-llm-daily-limit', s.budget?.dailyTokenLimit || 0);
    set('toggle-tool-discovery', s.toolExposure?.mode !== 'all', true);
    set('toggle-auto-optimize-tools', s.autoOptimizeToolSelection, true);
    set('tool-schema-budget', s.toolExposure?.budgetTokens || 4000);
    const adaptive = s.toolExposure?.mode !== 'all';
    document.getElementById('tool-schema-budget').disabled = !adaptive;
    const target = currentMode === 'code' ? codeAgent : currentMode === 'babe' ? babeAgent : agent;
    const limits = target?.getTokenLimits?.() || TokenPolicy.resolve(s);
    const nf = n => Number(n).toLocaleString();
    const box = document.getElementById('token-allocation');
    box.replaceChildren();
    for (const [title, amount] of [['当前会话容量', limits.contextTokens], ['单次输出预留', limits.outputTokens], ['可用输入空间', limits.inputTokens], ['工具定义上限', adaptive ? limits.toolTokens : null]]) {
      const cell = document.createElement('div');
      const name = document.createElement('span'); name.textContent = title;
      const number = document.createElement('strong'); number.textContent = amount == null ? '完整加载' : nf(amount);
      cell.append(name, number); box.append(cell);
    }
    const source = document.createElement('p'); source.className = 'setting-hint';
    source.textContent = `当前 ${currentMode === 'code' ? 'Code' : currentMode === 'babe' ? 'Babe' : 'Chat'} 会话，${limits.source === 'pool' ? '按所选模型池条目' : limits.source === 'session' ? '按会话模型容量' : '按默认模型容量'}计算。工具、系统提示词和对话共用输入空间；工具数值为估算。${limits.outputTokens < limits.requestedOutput ? ' 输出上限已按小窗口收敛，设置值仍保留。' : ''}`;
    box.append(source);
    const hint = document.getElementById('tool-selection-settings-hint');
    hint.textContent = s.autoOptimizeToolSelection && s.decision?.enabled && s.decision?.usages?.toolSelection !== false
      ? 'Jev 工具选择已启用：根据任务预加载；失败时使用本地候选。按需搜索继续补充遗漏。'
      : s.autoOptimizeToolSelection ? '当前使用本地候选预加载。要使用 Jev，请在「Jev 决策模型」中开启服务及工具选择；两项加载开关可以同时启用。' : '任务预加载已关闭；按需发现仍可搜索工具。开启自动工具选择后，可使用 Jev 或本地候选预加载。';
  }
  window.refreshTokenSettings = refreshTokenSettings;

  document.getElementById('tool-schema-budget').addEventListener('change', async e => {
    await saveSettings({ toolExposure: { budgetTokens: Number(e.target.value) } });
    renderToolsStats();
  });
  for (const [id, patch] of [['toggle-tool-discovery', checked => ({ toolExposure: { mode: checked ? 'adaptive' : 'all' } })],
    ['toggle-auto-optimize-tools', checked => ({ autoOptimizeToolSelection: checked })]]) {
    document.getElementById(id).addEventListener('change', async e => {
      await saveSettings(patch(e.target.checked));
      updateReoptimizeButtonVisibility(); renderToolsStats();
    });
  }
  document.getElementById('setting-token-preset').addEventListener('change', async e => {
    const presets = { balanced: [8192, 4000], compact: [4096, 2000], long: [16384, 4000] };
    const preset = presets[e.target.value]; if (!preset) return;
    await saveSettings({ llm: { maxResponseTokens: preset[0] }, toolExposure: { mode: 'adaptive', budgetTokens: preset[1] },
      contextCompaction: { enabled: true, thresholdRatio: 0.8, retainRatio: 0.16 } });
    e.target.value = '';
  });
