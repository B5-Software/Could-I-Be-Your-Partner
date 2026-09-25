  function ensureFallbackContext(ind, fill, textEl, sharedMaxCtx) {
    if (!ind) return;
    ind.dataset.used = 0;
    ind.dataset.max = sharedMaxCtx;
    ind.dataset.level = 'normal';
    let sysT = 0, toolT = 0;
    try {
      const cm = agent?.contextManager;
      const sysP = cm?.systemPrompt;
      if (sysP) {
        sysT = cm.estimateMessageTokens ? cm.estimateMessageTokens(sysP) : Math.ceil(String(sysP).length / 4);
      }
      const schemas = (typeof agent?.getRuntimeToolSchemas === 'function')
        ? agent.getRuntimeToolSchemas()
        : (typeof getToolSchemas === 'function' ? getToolSchemas(agent?.settings?.tools || {}) : []);
      toolT = Math.ceil(JSON.stringify(schemas || []).length / 4);
    } catch (_) {}
    const maxResp = agent?.settings?.llm?.maxResponseTokens || 8192;
    const tokens = sysT + toolT;
    const total = tokens + maxResp;
    const pct = sharedMaxCtx ? Math.min(100, (total / sharedMaxCtx) * 100) : 0;
    const inputPct = sharedMaxCtx ? Math.min(100, (tokens / sharedMaxCtx) * 100) : 0;
    const seg = (v) => (v > 0 ? (v / tokens * 100).toFixed(1) : '0');
    if (textEl) textEl.textContent = `${fmtTokenCount(total)}/${fmtTokenCount(sharedMaxCtx)}`;
    if (fill) {
      const usedPct = Math.min(100, inputPct);
      const reservePct = Math.max(0, Math.min(100, pct - usedPct));
      fill.setAttribute('stroke-dasharray', `${usedPct} ${100 - usedPct}`);
      const reserveFill = ind.querySelector('.context-ring-reserve');
      if (reserveFill) {
        reserveFill.setAttribute('stroke-dasharray', `${reservePct} 100`);
        reserveFill.setAttribute('stroke-dashoffset', `${-usedPct}`);
      }
    }
    // 创建/重建 tooltip
    let tooltip = ind.querySelector('.context-tooltip');
    if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = 'context-tooltip'; ind.appendChild(tooltip); }
    const cc = 2 * Math.PI * 12;
    const usedLen = (inputPct / 100 * cc);
    const reserveLen = (Math.max(0, Math.min(100, pct - inputPct)) / 100 * cc);
    tooltip.innerHTML = `
      <div class="context-tooltip-title">上下文使用详情</div>
      <svg class="context-tooltip-mini-ring" viewBox="0 0 30 30" width="60" height="60">
        <circle cx="15" cy="15" r="12" fill="none" stroke="var(--bg-tertiary)" stroke-width="4"/>
        <circle cx="15" cy="15" r="12" fill="none" stroke="var(--accent)" stroke-width="4"
          stroke-dasharray="${usedLen.toFixed(1)} ${cc.toFixed(1)}"
          stroke-dashoffset="0" transform="rotate(-90 15 15)"/>
        <circle cx="15" cy="15" r="12" fill="none" stroke="var(--accent)" stroke-width="4" opacity="0.32"
          stroke-dasharray="${reserveLen.toFixed(1)} ${cc.toFixed(1)}"
          stroke-dashoffset="${(-usedLen).toFixed(1)}" transform="rotate(-90 15 15)"/>
        <text x="15" y="18" text-anchor="middle" font-size="9" fill="var(--text-primary)">${pct.toFixed(0)}%</text>
      </svg>
      <div class="context-tooltip-row"><span>系统指导</span><span>${sysT} (${seg(sysT)}%)</span></div>
      <div class="context-tooltip-row"><span>工具定义</span><span>${toolT} (${seg(toolT)}%)</span></div>
      <div class="context-tooltip-row"><span>聊天记录</span><span>0 (0%)</span></div>
      <div class="context-tooltip-row"><span>工具结果</span><span>0 (0%)</span></div>
      <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600">
        <span>当前输入</span><span>${fmtTokenCount(tokens)} / ${fmtTokenCount(sharedMaxCtx)}</span>
      </div>
      <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600;color:var(--accent)">
        <span>输出预留</span><span>${fmtTokenCount(maxResp)}</span>
      </div>
      <div class="context-tooltip-row"><span>占比（含预留）</span><span>${pct.toFixed(1)}%</span></div>
      <div class="context-tooltip-row" style="color:var(--text-tertiary)"><span>占比（仅输入）</span><span>${inputPct.toFixed(1)}%</span></div>
      <div class="context-tooltip-row" style="font-weight:600">
        <span>总占用</span><span>${fmtTokenCount(total)} / ${fmtTokenCount(sharedMaxCtx)}</span>
      </div>`;
  }
