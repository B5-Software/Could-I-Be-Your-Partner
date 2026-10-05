  async function loadBudgetSettings() {
    const s = await readSettings();
    const budget = s.budget || {};
    const display = document.getElementById('setting-subscription-display');
    if (display) { display.value = budget.subscriptionDisplay || 'urgent'; display.onchange = saveBudgetSettings; }
    const quotaCard = document.getElementById('subscription-usage-settings');
    if (quotaCard) {
      quotaCard.hidden = !['chatgpt-codex', 'opencode-go'].includes(s.llm?.provider);
      if (!quotaCard.hidden) refreshSubscriptionWindows();
    }
    const dailyCapInput = document.getElementById('setting-budget-daily-cap');
    const weeklyCapInput = document.getElementById('setting-budget-weekly-cap');
    const capInput = document.getElementById('setting-budget-monthly-cap');
    const actionSel = document.getElementById('setting-budget-action');
    const tzSel = document.getElementById('setting-budget-timezone');
    const weekModeSel = document.getElementById('setting-budget-week-mode');
    const monthModeSel = document.getElementById('setting-budget-month-mode');
    if (dailyCapInput) dailyCapInput.value = budget.dailyLimitUSD ?? 0;
    if (weeklyCapInput) weeklyCapInput.value = budget.weeklyLimitUSD ?? 0;
    if (capInput) capInput.value = budget.monthlyLimitUSD ?? 0;
    if (actionSel) actionSel.value = budget.overLimitAction || 'warn';
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
        const cur = await readSettings();
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
    // 自动保存：绑定输入事件
    [dailyCapInput, weeklyCapInput, capInput, actionSel, phEnabled, phStart, phEnd, phInMul, phCrMul, phOutMul, phCwMul,
      ...['setting-budget-timezone', 'setting-budget-week-mode', 'setting-budget-month-mode'].map(id => document.getElementById(id))].forEach(el => {
      if (!el) return;
      el.onchange = saveBudgetSettings;
    });
    // 注意：listEl 不再绑定 change 事件，因为 appendBudgetPricingRow 中
    // 已经为每个 input 单独绑定了 change → saveBudgetSettings，
    // 若 listEl 也绑定会导致 change 事件冒泡时重复触发保存（弹两次 toast）

    refreshAutoPricing();
    await refreshBudgetStatus(budget);
    await refreshDecisionStatus();
  }
