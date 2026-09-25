  function updateReoptimizeButtonVisibility() {
    if (!btnReoptimizeTools) return;
    // Code 模式不使用自动优化，隐藏按钮
    // Babe 模式同理（Babe 有独立的 context-indicator）
    const currentAgent = currentMode === 'code' ? codeAgent : (currentMode === 'babe' ? babeAgent : agent);
    const visible = currentMode === 'chat'
      && !!agent.settings?.autoOptimizeToolSelection
      && !(agent.sessionAutoOptimizeDisabled);
    btnReoptimizeTools.classList.toggle('hidden', !visible);
    // 同步重新优化按钮可见性到 WebUI
    try { window.api.webControlPushReoptimizeState(visible); } catch (_) {}
  }

  // 更新上下文进度条函数
  // 通用：更新指定 agent 的上下文圆扇形指示器
  // 数据来源：API 真实基线优先（精确），无基线时用校准估算；估算时数字加 ~ 前缀
  function updateAgentContextProgress(agentInstance, fillId, textId) {
    if (!agentInstance || !agentInstance.contextManager) return;
    const cm = agentInstance.contextManager;
    const progressFill = document.getElementById(fillId);
    const progressText = document.getElementById(textId);
    if (!progressFill || !progressText) return;
    const indicator = progressFill.closest('.context-indicator');

    let bd = (typeof cm.getUsageBreakdown === 'function') ? cm.getUsageBreakdown() : null;
    if (!bd) {
      // 兜底（理论不达）：无 getUsageBreakdown 的旧实例按本地估算
      const stats = cm.getStats ? cm.getStats() : null;
      const estimateMsg = (msg) => (cm.estimateMessageTokens ? cm.estimateMessageTokens(msg) : 0);
      const estimateText = (text) => (cm.estimateTokens ? cm.estimateTokens(text) : 0);
      const systemGuidanceTokens = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
      const toolDefsTokens = Math.ceil(JSON.stringify(
        (typeof agentInstance.getRuntimeToolSchemas === 'function')
          ? agentInstance.getRuntimeToolSchemas()
          : (typeof getToolSchemas === 'function' ? getToolSchemas(agentInstance.settings?.tools || {}) : [])
      ).length / 4);
      let chatTokens = 0;
      let toolResultTokens = 0;
      (cm.messages || []).forEach(msg => {
        if (!msg) return;
        if (msg.role === 'tool') toolResultTokens += estimateMsg(msg);
        else if (msg.role === 'user' || msg.role === 'assistant') chatTokens += estimateMsg(msg);
      });
      const summaryTokens = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
      const tokens = systemGuidanceTokens + toolDefsTokens + chatTokens + toolResultTokens + Math.max(0, summaryTokens);
      const maxTokens = stats?.maxTokens ?? (agentInstance.settings?.llm?.maxContextLength || 0);
      const reserve = agentInstance.settings?.llm?.maxResponseTokens || 8192;
      bd = {
        used: tokens,
        max: maxTokens,
        reserve,
        totalUsed: tokens + reserve,
        pct: maxTokens ? Math.min(100, ((tokens + reserve) / maxTokens) * 100) : 0,
        inputPct: maxTokens ? Math.min(100, (tokens / maxTokens) * 100) : 0,
        exact: !!(stats && stats.exact),
        basis: stats?.basis || 'estimate',
        detail: {
          system: systemGuidanceTokens, tools: toolDefsTokens, chat: chatTokens,
          tool: toolResultTokens, summaries: Math.max(0, summaryTokens),
        },
      };
    }

    const tokens = bd.used;
    const maxTokens = bd.max;
    const maxResponseTokens = bd.reserve || 0;
    const totalOccupied = bd.totalUsed;
    const percentage = bd.pct;
    const inputOnlyPct = bd.inputPct;
    const sysTokens = bd.detail.system || 0;
    const toolDefsTokens = bd.detail.tools || 0;
    const chatTokens = bd.detail.chat || 0;
    const toolResultTokens = bd.detail.tool || 0;
    const otherTokens = bd.detail.summaries || 0;
    const exact = bd.exact === true;
    // 估算数据加 ~ 前缀；窗口上限不带前缀
    const pfx = exact ? '' : '~';
    const fmt = (n, p = pfx) => fmtTokenCount(n, p);

    // 更新 SVG 圆扇形：已用段实色 + 输出预留段半透明。
    // 圆周长 = 2 * PI * r = 2 * PI * 15.915 ≈ 100，所以直接用百分比。
    const usedPct = Math.min(100, inputOnlyPct);
    const reservePct = Math.max(0, Math.min(100, percentage - usedPct));
    progressFill.setAttribute('stroke-dasharray', `${usedPct} ${100 - usedPct}`);
    if (indicator) {
      const reserveFill = indicator.querySelector('.context-ring-reserve');
      if (reserveFill) {
        reserveFill.setAttribute('stroke-dasharray', `${reservePct} 100`);
        reserveFill.setAttribute('stroke-dashoffset', `${-usedPct}`);
      }
    }
    // 文本：精简显示（≥1K 用 K，≥1M 用 M，≥1G/T/P 用对应单位），显示当前占用+输出预留 / 完整上下文窗口
    progressText.textContent = `${fmt(totalOccupied)}/${fmt(maxTokens, '')}`;

    // 颜色级别
    if (indicator) {
      indicator.dataset.used = totalOccupied;
      indicator.dataset.max = maxTokens;
      indicator.dataset.exact = exact ? '1' : '0';
      if (percentage >= 95) indicator.dataset.level = 'danger';
      else if (percentage >= 80) indicator.dataset.level = 'warn';
      else indicator.dataset.level = 'normal';
      // 更新/创建 tooltip
      let tooltip = indicator.querySelector('.context-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'context-tooltip';
        indicator.appendChild(tooltip);
      }
      // 绘制迷你扇形图 + 细化占比（已用实色 + 预留半透明）
      const segPct = (v, total) => total > 0 ? (v/total*100).toFixed(1) : '0';
      const miniR = 12, miniCx = 15, miniCy = 15, miniCircum = 2 * Math.PI * miniR;
      const sysPct = (sysTokens / Math.max(1, tokens)) * 100;
      const toolPct = (toolDefsTokens / Math.max(1, tokens)) * 100;
      const chatPct = (chatTokens / Math.max(1, tokens)) * 100;
      const toolResPct = (toolResultTokens / Math.max(1, tokens)) * 100;
      const miniUsedLen = (usedPct / 100 * miniCircum);
      const miniReserveLen = (reservePct / 100 * miniCircum);
      const nf = (n) => `${pfx}${n}`;
      tooltip.innerHTML = `
        <div class="context-tooltip-title">上下文使用详情</div>
        <svg class="context-tooltip-mini-ring" viewBox="0 0 30 30" width="60" height="60">
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="var(--bg-tertiary)" stroke-width="4"/>
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="var(--accent)" stroke-width="4"
          stroke-dasharray="${miniUsedLen.toFixed(1)} ${miniCircum.toFixed(1)}"
          stroke-dashoffset="0" transform="rotate(-90 ${miniCx} ${miniCy})"/>
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="var(--accent)" stroke-width="4" opacity="0.32"
          stroke-dasharray="${miniReserveLen.toFixed(1)} ${miniCircum.toFixed(1)}"
          stroke-dashoffset="${(-miniUsedLen).toFixed(1)}" transform="rotate(-90 ${miniCx} ${miniCy})"/>
          <text x="${miniCx}" y="${miniCy+3}" text-anchor="middle" font-size="9" fill="var(--text-primary)">${percentage.toFixed(0)}%</text>
        </svg>
        <div class="context-tooltip-row"><span>系统指导</span><span>${nf(sysTokens)} (${segPct(sysTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>工具定义</span><span>${nf(toolDefsTokens)} (${segPct(toolDefsTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>聊天记录</span><span>${nf(chatTokens)} (${segPct(chatTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>工具结果</span><span>${nf(toolResultTokens)} (${segPct(toolResultTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>其他</span><span>${nf(otherTokens)} (${segPct(otherTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row" style="color:var(--text-tertiary)"><span>数据来源</span><span>${exact ? 'API 实测基线' : '估算（下一条回复后校准）'}</span></div>
        <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600">
          <span>当前输入</span><span>${nf(tokens)} / ${nf(maxTokens)}</span>
        </div>
        <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600;color:var(--accent)">
          <span>输出预留</span><span>${maxResponseTokens}</span>
        </div>
        <div class="context-tooltip-row"><span>占比（含预留）</span><span>${percentage.toFixed(1)}%</span></div>
        <div class="context-tooltip-row" style="color:var(--text-tertiary)"><span>占比（仅输入）</span><span>${inputOnlyPct.toFixed(1)}%</span></div>
        <div class="context-tooltip-row" style="font-weight:600">
          <span>总占用</span><span>${fmt(totalOccupied)} / ${fmt(maxTokens, '')}</span>
        </div>
        ${renderSessionTokenStats(agentInstance)}
      `;
    }
  }

  // 渲染当前会话的累计 Token 统计和费用（从 agent.sessionUsage 累计）
  function renderSessionTokenStats(agentInstance) {
    const su = agentInstance?.sessionUsage;
    if (!su) return '';
    // API 未返回 usage 时使用估算值，数字前加 ~ 前缀标识
    const pfx = su.estimated ? '~' : '';
    // ≥1M 用 M（非 10M），≥1G/T/P 用对应单位（防御性编程）
    const fmt = (n) => fmtTokenCount(n, pfx);
    const cachedPct = su.prompt > 0 ? (su.cached / su.prompt * 100).toFixed(1) : '0.0';
    const esc = (s) => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
    // 按模型分桶：混合模型会话按各自单价计价并求和
    const byModel = agentInstance?.sessionUsageByModel || {};
    const entries = Object.entries(byModel)
      .filter(([, u]) => u && (u.total > 0 || u.prompt > 0 || u.completion > 0));
    let perModelRows = '';
    let totalCost = 0;
    let pricedCount = 0;
    if (entries.length > 0) {
      const rows = [];
      for (const [model, mu] of entries) {
        const cost = computeSessionCostForModel(agentInstance, model, mu);
        if (cost) { totalCost += cost.totalCost; pricedCount++; }
        rows.push(`<div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)"><span>　${esc(model)}</span><span>${fmt(mu.total)}${cost ? ` · $${cost.totalCost.toFixed(5)}` : ''}</span></div>`);
      }
      perModelRows = `<div class="context-tooltip-row" style="border-top:1px solid var(--border);padding-top:4px;font-weight:600"><span>按模型明细</span><span></span></div>` + rows.join('');
    }
    // 总费用：有分桶时按模型求和；旧数据（无分桶）回退到当前模型单价 × 扁平总量
    let costRow = '';
    if (entries.length > 0) {
      if (pricedCount > 0) {
        costRow = `<div class="context-tooltip-row" style="border-top:1px solid var(--border);padding-top:4px"><span>费用（合计）</span><span>$${totalCost.toFixed(5)}</span></div>`;
      }
    } else {
      const activeModel = (typeof agentInstance?.getActiveModelId === 'function')
        ? agentInstance.getActiveModelId() : agentInstance?.settings?.llm?.model;
      const cost = computeSessionCostForModel(agentInstance, activeModel, su);
      if (cost) {
        costRow = `<div class="context-tooltip-row" style="border-top:1px solid var(--border);padding-top:4px">
          <span>费用（${esc(cost.pricing.model)}）</span><span>$${cost.totalCost.toFixed(5)}</span>
        </div>
        <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
          <span>　输入</span><span>$${cost.inputCost.toFixed(5)}</span>
        </div>
        <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
          <span>　输出</span><span>$${cost.outputCost.toFixed(5)}</span>
        </div>
        <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
          <span>　缓存读</span><span>$${cost.cacheReadCost.toFixed(5)}</span>
        </div>
        <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
          <span>　缓存写</span><span>$${cost.cacheWriteCost.toFixed(5)}</span>
        </div>${cost.pricing.hasCacheWrite ? '' : '<div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)"><span>　(此模型不计缓存写入费)</span></div>'}`;
      }
    }
    return `
      <div class="context-tooltip-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;font-weight:600">
        <span>会话累计 Token${su.estimated ? ' <span style="font-size:10px;color:var(--text-tertiary);font-weight:normal">(估算)</span>' : ''}</span><span></span>
      </div>
      <div class="context-tooltip-row"><span>　输入</span><span>${fmt(su.prompt)}</span></div>
      <div class="context-tooltip-row"><span>　输出</span><span>${fmt(su.completion)}</span></div>
      <div class="context-tooltip-row"><span>　总计</span><span>${fmt(su.total)}</span></div>
      ${su.cached > 0 ? `<div class="context-tooltip-row"><span>　缓存命中</span><span>${fmt(su.cached)} (${cachedPct}%)</span></div>` : ''}
      ${su.cacheCreation > 0 ? `<div class="context-tooltip-row"><span>　缓存创建</span><span>${fmt(su.cacheCreation || 0)}</span></div>` : ''}
      ${perModelRows}
      ${costRow}
    `;
  }

  // 计算某模型的会话费用（含峰谷倍率）。无价格配置返回 null。
