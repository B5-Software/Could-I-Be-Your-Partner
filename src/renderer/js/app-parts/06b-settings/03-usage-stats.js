  async function loadUsageStats(period) {
    const summaryEl = document.getElementById('usage-summary');
    const chartEl = document.getElementById('usage-chart');
    const modelsEl = document.getElementById('usage-models');
    if (!summaryEl || !chartEl || !modelsEl) return;
    summaryEl.innerHTML = '<div style="opacity:0.6">加载中...</div>';
    chartEl.innerHTML = '';
    modelsEl.innerHTML = '';
    try {
      const res = await window.api.usageGetRange(period || 'daily');
      if (!res || !res.ok) {
        summaryEl.innerHTML = '<div>加载失败</div>';
        return;
      }
      const fmt = (n) => (n || 0).toLocaleString();
      const fmtUSD = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const data = res;
      const hasCost = (data.costUSD || 0) > 0 || (data.inputCost || 0) > 0 || (data.outputCost || 0) > 0;
      const cards = [
        { label: '总 Token', value: fmt(data.totalTokens), accent: true },
        { label: '提示 Token', value: fmt(data.promptTokens) },
        { label: '生成 Token', value: fmt(data.completionTokens) },
        { label: '请求次数', value: fmt(data.requestCount) }
      ];
      // 若有费用数据则加入金钱卡片
      if (hasCost) {
        cards.push({ label: '总消费 (USD)', value: fmtUSD(data.costUSD), accent: true, kind: 'cost' });
        cards.push({ label: '输入消费', value: fmtUSD(data.inputCost), kind: 'cost' });
        cards.push({ label: '输出消费', value: fmtUSD(data.outputCost), kind: 'cost' });
        if ((data.cacheReadCost || 0) > 0) cards.push({ label: '缓存读消费', value: fmtUSD(data.cacheReadCost), kind: 'cost' });
        if ((data.cacheWriteCost || 0) > 0) cards.push({ label: '缓存写消费', value: fmtUSD(data.cacheWriteCost), kind: 'cost' });
      }
      summaryEl.innerHTML = cards.map(c =>
        `<div class="usage-card${c.accent ? ' accent' : ''}${c.kind === 'cost' ? ' cost' : ''}">
          <div class="usage-card-label">${c.label}</div>
          <div class="usage-card-value">${c.value}</div>
        </div>`
      ).join('');
      // chart: 按小时（daily）或按天（weekly/monthly）
      const isHourly = data.isHourly;
      const chartTitleEl = document.getElementById('usage-chart-title');
      if (chartTitleEl) chartTitleEl.textContent = isHourly ? '按小时趋势' : '按日趋势';
      const chartData = isHourly ? (data.hours || []) : (data.days || []);
      if (chartData.length === 0) {
        chartEl.innerHTML = '<div style="opacity:0.5;font-size:12px;width:100%;text-align:center;">无数据</div>';
      } else {
        const max = Math.max(1, ...chartData.map(d => d.total || 0));
        chartEl.innerHTML = chartData.map(d => {
          const h = Math.max(2, Math.round((d.total / max) * 140));
          const label = isHourly ? `${d.hour}h` : d.date.slice(5);
          const costStr = (d.costUSD || 0) > 0 ? ` · $${(d.costUSD || 0).toFixed(4)}` : '';
          const title = isHourly ? `${d.hour}:00 - ${fmt(d.total)} tokens${costStr}` : `${d.date}: ${fmt(d.total)} tokens${costStr}`;
          return `<div title="${title}" style="flex:1;min-width:4px;height:${h}px;background:var(--accent);border-radius:2px 2px 0 0;position:relative;">
            <div style="position:absolute;bottom:-16px;left:50%;transform:translateX(-50%);font-size:9px;opacity:0.5;white-space:nowrap;">${label}</div>
          </div>`;
        }).join('');
        chartEl.style.marginBottom = '20px';
      }
      // by model
      const models = data.models || {};
      const modelEntries = Object.entries(models).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
      if (modelEntries.length === 0) {
        modelsEl.innerHTML = '<div style="opacity:0.5;font-size:12px;">无数据</div>';
      } else {
        modelsEl.innerHTML = modelEntries.map(([id, st]) => {
          const costStr = (st.costUSD || 0) > 0 ? ` · <span style="color:var(--accent)">$${(st.costUSD || 0).toFixed(4)}</span>` : '';
          return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="font-family:monospace;font-size:12px;">${id}</span>
            <span><b>${fmt(st.total)}</b> tokens · ${fmt(st.count)} 次${costStr}</span>
          </div>`;
        }).join('');
      }
    } catch (e) {
      summaryEl.innerHTML = '<div>错误: ' + (e?.message || e) + '</div>';
    }
  }
