  async function loadBudgetSettings() {
    const s = await window.api.getSettings();
    const budget = s.budget || {};
    const dailyCapInput = document.getElementById('setting-budget-daily-cap');
    const weeklyCapInput = document.getElementById('setting-budget-weekly-cap');
    const capInput = document.getElementById('setting-budget-monthly-cap');
    const actionSel = document.getElementById('setting-budget-action');
    const fallbackInput = document.getElementById('setting-budget-fallback-model');
    const tzSel = document.getElementById('setting-budget-timezone');
    const weekModeSel = document.getElementById('setting-budget-week-mode');
    const monthModeSel = document.getElementById('setting-budget-month-mode');
    if (dailyCapInput) dailyCapInput.value = budget.dailyLimitUSD ?? 0;
    if (weeklyCapInput) weeklyCapInput.value = budget.weeklyLimitUSD ?? 0;
    if (capInput) capInput.value = budget.monthlyLimitUSD ?? 0;
    if (actionSel) actionSel.value = budget.overLimitAction || budget.overAction || 'warn';
    if (fallbackInput) fallbackInput.value = budget.fallbackModel || '';
    if (tzSel) tzSel.value = budget.timezone || 'Asia/Shanghai';
    if (weekModeSel) weekModeSel.value = budget.weekMode || 'natural';
    if (monthModeSel) monthModeSel.value = budget.monthMode || 'natural';

    // 峰谷时段字段
    const ph = budget.peakHours || {};
    const phEnabled = document.getElementById('setting-budget-peak-enabled');
    const phStart = document.getElementById('setting-budget-peak-start');
    const phEnd = document.getElementById('setting-budget-peak-end');
    const phInMul = document.getElementById('setting-budget-peak-input-mul');
    const phCrMul = document.getElementById('setting-budget-peak-cacheread-mul');
    const phOutMul = document.getElementById('setting-budget-peak-output-mul');
    const phCwMul = document.getElementById('setting-budget-peak-cachewrite-mul');
    if (phEnabled) phEnabled.checked = !!ph.enabled;
    if (phStart) phStart.value = ph.start ?? 9;
    if (phEnd) phEnd.value = ph.end ?? 18;
    if (phInMul) phInMul.value = ph.inputMul ?? 1.5;
    if (phCrMul) phCrMul.value = ph.cacheReadMul ?? 1.5;
    if (phOutMul) phOutMul.value = ph.outputMul ?? 1.5;
    if (phCwMul) phCwMul.value = ph.cacheWriteMul ?? 1.5;

    const listEl = document.getElementById('budget-pricing-list');
    if (listEl) {
      listEl.innerHTML = '';
      const models = budget.models || {};
      for (const [modelId, price] of Object.entries(models)) {
        appendBudgetPricingRow(listEl, modelId, price);
      }
      // 默认至少显示一行空行
      if (listEl.children.length === 0) {
        appendBudgetPricingRow(listEl, '', {});
      }
    }

    // 按钮绑定
    const addRowBtn = document.getElementById('btn-budget-add-row');
    if (addRowBtn) {
      addRowBtn.onclick = () => {
        if (!listEl) return;
        appendBudgetPricingRow(listEl, '', {});
      };
    }
    const importCurrentBtn = document.getElementById('btn-budget-import-current');
    if (importCurrentBtn) {
      importCurrentBtn.onclick = async () => {
        const cur = await window.api.getSettings();
        const model = cur?.llm?.model;
        if (!model) { window.showToast('未检测到当前 LLM 模型', 'warn'); return; }
        if (!listEl) return;
        // 去重添加
        const existing = Array.from(listEl.querySelectorAll('.budget-model-id')).map(i => i.value.trim());
        if (existing.includes(model)) { window.showToast('价格表中已存在该模型', 'info'); return; }
        // 默认根据模型名自动推断 hasCacheWrite
        appendBudgetPricingRow(listEl, model, { hasCacheWrite: /claude/i.test(model) });
      };
    }
    const importUsageBtn = document.getElementById('btn-budget-import-usage');
    if (importUsageBtn) {
      importUsageBtn.onclick = async () => {
        const res = await window.api.usageGetRange('monthly');
        if (!listEl) return;
        const usedModels = Object.keys(res?.models || {});
        if (usedModels.length === 0) { window.showToast('用量记录中没有模型数据', 'info'); return; }
        const existing = new Set(Array.from(listEl.querySelectorAll('.budget-model-id')).map(i => i.value.trim()));
        let added = 0;
        for (const m of usedModels) {
          if (!existing.has(m)) { appendBudgetPricingRow(listEl, m, { hasCacheWrite: /claude/i.test(m) }); added++; }
        }
        window.showToast(added > 0 ? `已导入 ${added} 个模型` : '所有已用模型都已在价格表中', 'success');
      };
    }
    const budgetRefreshBtn = document.getElementById('btn-budget-refresh');
    if (budgetRefreshBtn) budgetRefreshBtn.onclick = async () => {
      await refreshBudgetStatus();
      window.showToast('预算数据已刷新', 'success');
    };
    const pickFallbackBtn = document.getElementById('btn-budget-pick-fallback');
    if (pickFallbackBtn) {
      pickFallbackBtn.onclick = async () => {
        // 复用 LLM 设置的模型选择逻辑：列出可用模型
        try {
          const cur = await window.api.getSettings();
          // llmFetchModels 返回 {ok, models} 对象，需要从中提取 models 数组
          const provider = cur?.llm?.provider || 'openai-compat';
          const apiUrl = cur?.llm?.apiUrl || '';
          const apiKey = cur?.llm?.apiKey || '';
          const zenKey = cur?.llm?.zenApiKey || '';
          let res;
          if (provider === 'opencode-zen') {
            res = await window.api.zenFetchModels();
          } else {
            res = await window.api.llmFetchModels(provider, apiUrl, apiKey || zenKey);
          }
          const list = Array.isArray(res?.models) ? res.models : [];
          if (list.length === 0) {
            window.showToast('无可选模型，请先在 LLM 标签页获取模型列表', 'warn');
            return;
          }
          // 弹出简单选择框
          const picked = prompt('选择 fallback 模型（输入序号）:\n' + list.map((m, i) => `${i + 1}. ${m.id || m.name || m}`).join('\n'));
          const idx = parseInt(picked) - 1;
          if (!isNaN(idx) && list[idx]) {
            const modelId = typeof list[idx] === 'string' ? list[idx] : (list[idx].id || list[idx].name);
            if (fallbackInput) fallbackInput.value = modelId;
          }
        } catch (e) { window.showToast('获取模型列表失败: ' + e.message, 'error'); }
      };
    }

    // 自动保存：绑定输入事件
    [dailyCapInput, capInput, actionSel, fallbackInput, phEnabled, phStart, phEnd, phInMul, phCrMul, phOutMul, phCwMul].forEach(el => {
      if (!el) return;
      el.addEventListener('change', saveBudgetSettings);
    });
    listEl?.addEventListener('input', () => { /* 输入时仅更新内部状态，保存由 change 触发 */ });
    // 注意：listEl 不再绑定 change 事件，因为 appendBudgetPricingRow 中
    // 已经为每个 input 单独绑定了 change → saveBudgetSettings，
    // 若 listEl 也绑定会导致 change 事件冒泡时重复触发保存（弹两次 toast）

    await refreshBudgetStatus(budget);
  }
