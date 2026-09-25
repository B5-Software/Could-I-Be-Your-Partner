  function appendBudgetPricingRow(listEl, modelId, price) {
    price = price || {};
    // 旧字段迁移：promptPerK/completionPerK → inputPerM/outputPerM
    let inputPerM = price.inputPerM;
    if (inputPerM == null && price.promptPerK != null) inputPerM = (Number(price.promptPerK) || 0) * 1000;
    let outputPerM = price.outputPerM;
    if (outputPerM == null && price.completionPerK != null) outputPerM = (Number(price.completionPerK) || 0) * 1000;
    let cacheReadPerM = price.cacheReadPerM;
    if (cacheReadPerM == null && inputPerM != null) cacheReadPerM = (Number(inputPerM) || 0) * 0.1;
    let cacheWritePerM = price.cacheWritePerM;
    if (cacheWritePerM == null && inputPerM != null) cacheWritePerM = (Number(inputPerM) || 0) * 1.25;
    const hasCacheWrite = price.hasCacheWrite != null ? !!price.hasCacheWrite : /claude/i.test(modelId || '');
    const esc = (v) => String(v ?? '').replace(/[<>&"]/g, s => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[s]));
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1.6fr 0.9fr 0.9fr 0.9fr 0.9fr 0.7fr auto;gap:6px;align-items:center';
    row.innerHTML = `
      <input type="text" class="budget-model-id" value="${esc(modelId)}" placeholder="model-id">
      <input type="number" class="budget-input-perm" value="${inputPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 输入价格 (USD)">
      <input type="number" class="budget-cacheread-perm" value="${cacheReadPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 缓存读取价格 (USD)">
      <input type="number" class="budget-output-perm" value="${outputPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 输出价格 (USD)">
      <input type="number" class="budget-cachewrite-perm" value="${cacheWritePerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 缓存写入价格 (USD)">
      <input type="checkbox" class="budget-has-cache-write" ${hasCacheWrite ? 'checked' : ''} title="该模型支持缓存写入计费" style="justify-self:center">
      <button class="btn-icon" title="删除"><i class="fa-solid fa-trash-can"></i></button>
    `;
    // 当模型 ID 改变且未手动勾选过 CW 时，根据模型名自动推断
    const idEl = row.querySelector('.budget-model-id');
    const cwEl = row.querySelector('.budget-has-cache-write');
    idEl?.addEventListener('change', () => {
      if (/claude/i.test(idEl.value || '')) {
        cwEl.checked = true;
        saveBudgetSettings();
      }
    });
    row.querySelector('button').onclick = () => {
      row.remove();
      saveBudgetSettings();
    };
    row.querySelectorAll('input').forEach(i => i.addEventListener('change', saveBudgetSettings));
    listEl.appendChild(row);
  }

  async function saveBudgetSettings() {
    const dailyCapInput = document.getElementById('setting-budget-daily-cap');
    const weeklyCapInput = document.getElementById('setting-budget-weekly-cap');
    const capInput = document.getElementById('setting-budget-monthly-cap');
    const actionSel = document.getElementById('setting-budget-action');
    const fallbackInput = document.getElementById('setting-budget-fallback-model');
    const tzSel = document.getElementById('setting-budget-timezone');
    const weekModeSel = document.getElementById('setting-budget-week-mode');
    const monthModeSel = document.getElementById('setting-budget-month-mode');
    const listEl = document.getElementById('budget-pricing-list');
    const phEnabled = document.getElementById('setting-budget-peak-enabled');
    const phStart = document.getElementById('setting-budget-peak-start');
    const phEnd = document.getElementById('setting-budget-peak-end');
    const phInMul = document.getElementById('setting-budget-peak-input-mul');
    const phCrMul = document.getElementById('setting-budget-peak-cacheread-mul');
    const phOutMul = document.getElementById('setting-budget-peak-output-mul');
    const phCwMul = document.getElementById('setting-budget-peak-cachewrite-mul');
    const models = {};
    if (listEl) {
      listEl.querySelectorAll(':scope > div').forEach(row => {
        const idEl = row.querySelector('.budget-model-id');
        if (!idEl) return;
        const mid = (idEl.value || '').trim();
        if (!mid) return;
        const pEl = row.querySelector('.budget-input-perm');
        const crEl = row.querySelector('.budget-cacheread-perm');
        const cEl = row.querySelector('.budget-output-perm');
        const cwEl = row.querySelector('.budget-cachewrite-perm');
        const hcwEl = row.querySelector('.budget-has-cache-write');
        models[mid] = {
          inputPerM: parseFloat(pEl?.value) || 0,
          cacheReadPerM: parseFloat(crEl?.value) || 0,
          outputPerM: parseFloat(cEl?.value) || 0,
          cacheWritePerM: parseFloat(cwEl?.value) || 0,
          hasCacheWrite: !!hcwEl?.checked
        };
      });
    }
    const budget = {
      dailyLimitUSD: parseFloat(dailyCapInput?.value) || 0,
      weeklyLimitUSD: parseFloat(weeklyCapInput?.value) || 0,
      monthlyLimitUSD: parseFloat(capInput?.value) || 0,
      monthlyCapUsd: parseFloat(capInput?.value) || 0, // 保留旧字段以兼容旧代码
      overLimitAction: actionSel?.value || 'warn',
      overAction: actionSel?.value || 'warn', // 保留旧字段以兼容旧代码
      fallbackModel: (fallbackInput?.value || '').trim(),
      warningThreshold: 0.8,
      timezone: tzSel?.value || 'Asia/Shanghai',
      weekMode: weekModeSel?.value || 'natural',
      monthMode: monthModeSel?.value || 'natural',
      models,
      peakHours: {
        enabled: !!phEnabled?.checked,
        start: parseInt(phStart?.value) ?? 9,
        end: parseInt(phEnd?.value) ?? 18,
        inputMul: parseFloat(phInMul?.value) || 1,
        cacheReadMul: parseFloat(phCrMul?.value) || 1,
        outputMul: parseFloat(phOutMul?.value) || 1,
        cacheWriteMul: parseFloat(phCwMul?.value) || 1
      }
    };
    await saveSettings({ budget });
    await refreshBudgetStatus(budget);
    if (typeof window.showToast === 'function') window.showToast('预算设置已保存', 'success', 2500);
  }
