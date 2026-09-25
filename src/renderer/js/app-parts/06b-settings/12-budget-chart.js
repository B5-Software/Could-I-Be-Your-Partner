  async function refreshBudgetStatus(budget) {
    const statusEl = document.getElementById('budget-status');
    if (!statusEl) return;
    try {
      // 使用新的 budget:getStatus API（后端已根据价格表+峰谷价计算好）
      const st = await window.api.budgetGetStatus();
      const fmt = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const fmtLimit = (v) => `$${(Number(v) || 0).toFixed(2)}`;
      const renderSection = (title, info) => {
        const limit = info.limitUSD > 0;
        const pct = info.pct;
        const barColor = info.level === 'danger' ? '#f44336' : (info.level === 'warn' ? '#ff9800' : 'var(--accent)');
        return `
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-weight:600">
              <span>${title}</span><span style="color:${barColor}">${fmt(info.costUSD)}${limit ? ` / ${fmtLimit(info.limitUSD)} (${pct.toFixed(1)}%)` : '（未设限）'}</span>
            </div>
            ${limit ? `<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:6px"><div style="height:100%;width:${pct}%;background:${barColor};transition:width 0.3s"></div></div>` : ''}
            <div style="font-size:11px;color:var(--text-secondary);display:grid;grid-template-columns:1fr 1fr;gap:2px 12px">
              <span>输入 ${fmt(info.inputCost)}</span>
              <span>输出 ${fmt(info.outputCost)}</span>
              <span>缓存读 ${fmt(info.cacheReadCost)}</span>
              <span>缓存写 ${fmt(info.cacheWriteCost)}</span>
            </div>
          </div>
        `;
      };
      const peak = st?.peakHours || {};
      const peakBadge = peak.enabled ? `<span style="font-size:10px;color:var(--text-tertiary);margin-left:6px">峰时段 ${peak.start}-${peak.end}</span>` : '';
      statusEl.innerHTML = `
        ${renderSection('今日消费' + peakBadge, st?.daily || {})}
        ${st?.weekly ? renderSection('本周消费', st.weekly) : ''}
        ${renderSection('本月消费', st?.monthly || {})}
      `;
      // 同步刷新图表区域（若存在）
      const activePeriod = document.querySelector('.budget-period-btn.active');
      if (activePeriod) loadBudgetChart(activePeriod.dataset.period);
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">加载失败: ${e.message}</span>`;
    }
  }

  // 预算统计图表：渲染卡片 + 柱状图 + 圆环占比
  async function loadBudgetChart(period) {
    const summaryEl = document.getElementById('budget-chart-summary');
    const chartEl = document.getElementById('budget-chart');
    const ringsEl = document.getElementById('budget-rings');
    if (!summaryEl || !chartEl || !ringsEl) return;
    try {
      const [status, usage] = await Promise.all([
        window.api.budgetGetStatus(),
        window.api.usageGetRange(period || 'daily')
      ]);
      if (!status?.ok) {
        summaryEl.innerHTML = '<div style="opacity:0.6">加载失败</div>';
        return;
      }
      const periodInfo = status[period || 'daily'] || {};
      const periodLabels = { daily: '今日', weekly: '本周', monthly: '本月' };
      const fmt = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const fmtLimit = (v) => `$${(Number(v) || 0).toFixed(2)}`;
      const hasLimit = periodInfo.limitUSD > 0;
      const pct = periodInfo.pct || 0;
      const barColor = periodInfo.level === 'danger' ? '#f44336' : (periodInfo.level === 'warn' ? '#ff9800' : 'var(--accent)');

      // 卡片
      const cards = [
        { label: `${periodLabels[period]}消费`, value: fmt(periodInfo.costUSD), accent: true },
        { label: '输入消费', value: fmt(periodInfo.inputCost) },
        { label: '输出消费', value: fmt(periodInfo.outputCost) }
      ];
      if ((periodInfo.cacheReadCost || 0) > 0) cards.push({ label: '缓存读消费', value: fmt(periodInfo.cacheReadCost) });
      if ((periodInfo.cacheWriteCost || 0) > 0) cards.push({ label: '缓存写消费', value: fmt(periodInfo.cacheWriteCost) });
      summaryEl.innerHTML = cards.map(c =>
        `<div class="usage-card${c.accent ? ' accent' : ''} cost">
          <div class="usage-card-label">${c.label}</div>
          <div class="usage-card-value">${c.value}</div>
        </div>`
      ).join('');

      // 柱状图（按小时或按日）
      const isHourly = usage.isHourly;
      const chartData = isHourly ? (usage.hours || []) : (usage.days || []);
      const max = Math.max(0.0001, ...chartData.map(d => d.costUSD || 0));
      if (chartData.length === 0) {
        chartEl.innerHTML = '<div style="opacity:0.5;font-size:12px;width:100%;text-align:center;">无数据</div>';
      } else {
        chartEl.innerHTML = chartData.map(d => {
          const h = Math.max(2, Math.round(((d.costUSD || 0) / max) * 100));
          const label = isHourly ? `${d.hour}h` : (d.date || '').slice(5);
          const title = isHourly ? `${d.hour}:00 - ${fmt(d.costUSD)}` : `${d.date}: ${fmt(d.costUSD)}`;
          return `<div title="${title}" style="flex:1;min-width:4px;height:${h}px;background:var(--accent);border-radius:2px 2px 0 0;position:relative;">
            <div style="position:absolute;bottom:-16px;left:50%;transform:translateX(-50%);font-size:9px;opacity:0.5;white-space:nowrap;">${label}</div>
          </div>`;
        }).join('');
      }

      // 圆环占比（日/周/月三个）
      const periods = ['daily', 'weekly', 'monthly'];
      const labels = { daily: '日', weekly: '周', monthly: '月' };
      ringsEl.innerHTML = periods.map(p => {
        const info = status[p] || {};
        const pPct = info.pct || 0;
        const pColor = info.level === 'danger' ? '#f44336' : (info.level === 'warn' ? '#ff9800' : 'var(--accent)');
        const r = 15.915;
        const dashArray = `${(pPct/100 * 100).toFixed(1)} ${(100 - pPct/100 * 100).toFixed(1)}`;
        return `<div style="text-align:center">
          <svg viewBox="0 0 36 36" width="64" height="64">
            <circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--border)" stroke-width="3"/>
            <circle cx="18" cy="18" r="${r}" fill="none" stroke="${pColor}" stroke-width="3"
              stroke-dasharray="${dashArray}" stroke-dashoffset="0" transform="rotate(-90 18 18)" stroke-linecap="round"/>
            <text x="18" y="20" text-anchor="middle" font-size="9" fill="var(--text-primary)" font-weight="600">${pPct.toFixed(0)}%</text>
          </svg>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${labels[p]}预算</div>
          <div style="font-size:10px;color:var(--text-tertiary)">${fmt(info.costUSD)}${info.limitUSD > 0 ? ' / ' + fmtLimit(info.limitUSD) : ''}</div>
        </div>`;
      }).join('');
    } catch (e) {
      console.error('loadBudgetChart failed:', e);
    }
  }

  // 预算周期按钮切换
  document.querySelectorAll('.budget-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.budget-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadBudgetChart(btn.dataset.period);
    });
  });
  // 周期设置变化时刷新图表
  document.getElementById('setting-budget-timezone')?.addEventListener('change', () => loadBudgetChart('daily'));
  document.getElementById('setting-budget-week-mode')?.addEventListener('change', () => loadBudgetChart('weekly'));
  document.getElementById('setting-budget-month-mode')?.addEventListener('change', () => loadBudgetChart('monthly'));
  loadBudgetSettings();

  // ── Terminal Settings ──
  // settings.terminal = { abortStrategy: 'kill'|'clearC'|'none', shell: 'auto'|..., customShellPath }
