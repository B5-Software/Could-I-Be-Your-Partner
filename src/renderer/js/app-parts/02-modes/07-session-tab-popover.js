  // ---- 会话标签悬停预览 ----
  let _stpSessionKey = null;
  let _stpTimer = null;

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function workspaceInfo(session) {
    const ws = (session && session.agent && (session.agent.codeWorkspacePath || session.agent.workspacePath)) || '';
    if (!ws) return { name: '未选择', full: '' };
    const parts = String(ws).split(/[\\/]/).filter(Boolean);
    return { name: parts[parts.length - 1] || ws, full: ws };
  }

  function computeContextStats(ag) {
    const cm = ag && ag.contextManager;
    if (!cm) return null;
    const usage = { ...(ag.sessionUsage || {}) };
    const bd = (typeof cm.getUsageBreakdown === 'function') ? cm.getUsageBreakdown() : null;
    if (bd) {
      return {
        sys: bd.detail.system,
        tools: bd.detail.tools,
        chat: bd.detail.chat,
        tool: bd.detail.tool,
        summaries: bd.detail.summaries,
        used: bd.used,
        max: bd.max,
        reserve: bd.reserve,
        totalOcc: bd.totalUsed,
        pct: bd.pct,
        inputPct: bd.inputPct,
        exact: bd.exact === true,
        usage,
      };
    }
    // 兜底（理论不达）：旧实例按本地估算展示
    const stats = (typeof cm.getStats === 'function') ? cm.getStats() : null;
    const estimateMsg = (m) => (typeof cm.estimateMessageTokens === 'function' ? cm.estimateMessageTokens(m) : 0);
    const estimateText = (t) => (typeof cm.estimateTokens === 'function' ? cm.estimateTokens(t) : 0);
    const sys = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
    let tools = cm.toolSchemaTokens || 0;
    if (!tools) {
      try {
        const schemas = (typeof ag.getRuntimeToolSchemas === 'function') ? ag.getRuntimeToolSchemas() : [];
        tools = Math.ceil(JSON.stringify(schemas).length / 4);
      } catch { /* ignore */ }
    }
    let chat = 0;
    let tool = 0;
    (cm.messages || []).forEach((m) => {
      if (!m) return;
      if (m.role === 'tool') tool += estimateMsg(m);
      else if (m.role === 'user' || m.role === 'assistant') chat += estimateMsg(m);
    });
    const summaries = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
    const used = sys + tools + chat + tool + summaries;
    const max = (stats && stats.maxTokens) || (ag.settings && ag.settings.llm && ag.settings.llm.maxContextLength) || 0;
    const reserve = (ag.settings && ag.settings.llm && ag.settings.llm.maxResponseTokens) || 8192;
    const totalOcc = used + reserve;
    const pct = max ? Math.min(100, (totalOcc / max) * 100) : 0;
    return { sys, tools, chat, tool, summaries, used, max, reserve, totalOcc, pct, inputPct: max ? Math.min(100, (used / max) * 100) : 0, exact: !!(stats && stats.exact), usage };
  }

  function renderPopoverContext(stats) {
    if (!stats) return '该会话上下文尚未初始化';
    // 估算数据加 ~ 前缀；API 实测基线不加
    const pfx = stats.exact ? '' : '~';
    const fmt = (n) => (typeof fmtTokenCount === 'function' ? fmtTokenCount(n, pfx) : `${pfx}${n}`);
    const level = stats.pct >= 85 ? 'danger' : stats.pct >= 65 ? 'warn' : '';
    // 已用段实色，输出预留段半透明（同一进度条内区分两种含义）
    const usedPct = stats.max ? Math.min(100, (stats.used / stats.max) * 100) : 0;
    const reservePct = stats.max ? Math.max(0, Math.min(100 - usedPct, (stats.reserve / stats.max) * 100)) : 0;
    // 预留段从最左开始铺满"已用+预留"，实心已用段覆盖其上 → 中间无缝隙、无额外圆角
    const totalPct = Math.min(100, usedPct + reservePct);
    const usagePfx = stats.usage.estimated ? '~' : '';
    const ufmt = (n) => (typeof fmtTokenCount === 'function' ? fmtTokenCount(n, usagePfx) : `${usagePfx}${n}`);
    const rows = [
      ['系统指导 + 工具定义', fmt(stats.sys + stats.tools)],
      ['对话消息', fmt(stats.chat)],
      ['工具结果', fmt(stats.tool)],
      ['摘要', fmt(stats.summaries)],
      ['输入占用', fmt(stats.used)],
      ['输出预留', fmt(stats.reserve)],
      ['数据来源', stats.exact ? 'API 实测' : '估算（下一条回复后校准）'],
      ['本会话累计 Token', ufmt(stats.usage.total || 0)]
    ];
    return rows.map(([label, value]) => `<div class="stp-ctx-row"><span>${escapeHtml(label)}</span><b>${value}</b></div>`).join('')
      + `<div class="stp-ctx-bar">`
      + `<div class="stp-ctx-bar-reserve ${level}" style="width:${totalPct.toFixed(1)}%"></div>`
      + `<div class="stp-ctx-bar-fill ${level}" style="width:${usedPct.toFixed(1)}%"></div>`
      + `</div>`
      + `<div class="stp-ctx-total"><span>${escapeHtml('合计 / 窗口')}</span><span>${fmt(stats.totalOcc)} / ${fmt(stats.max)} (${Math.round(stats.pct)}%)</span></div>`;
  }

  function showSessionTabPopover(session, tab) {
    const pop = document.getElementById('session-tab-popover');
    if (!pop || !session || !tab) return;
    _stpSessionKey = session.key;
    const stpTitle = document.getElementById('stp-title');
    const stpStatus = document.getElementById('stp-status');
    const stpElapsed = document.getElementById('stp-elapsed');
    const stpWorkspace = document.getElementById('stp-workspace');
    const stpContext = document.getElementById('stp-context');
    const stpCostRow = document.getElementById('stp-cost-row');
    const stpCost = document.getElementById('stp-cost');
    if (!stpTitle || !stpStatus || !stpElapsed || !stpWorkspace || !stpContext || !stpCostRow || !stpCost) return;

    const update = () => {
      if (_stpSessionKey !== session.key) return;
      const cur = sessionManager.get(session.key);
      if (!cur) { hideSessionTabPopover(); return; }
      stpTitle.textContent = cur.title || '未命名会话';
      const attMeta = (typeof sessionAttentionMeta === 'function') ? sessionAttentionMeta(cur.attention) : null;
      stpStatus.textContent = attMeta ? attMeta.label : (typeof sessionStatusLabel === 'function' ? sessionStatusLabel(cur.status) : String(cur.status || '空闲'));
      const running = cur.status === 'running' || cur.status === 'queued' || cur.status === 'waiting_approval' || cur.status === 'waiting_tool_auth' || (cur.agent && cur.agent.running);
      // 任务用时 = Agent 工作累计用时（跨轮次累计，持久化）；工作中实时跳动，空闲定格
      const ag = cur.agent;
      const agWorkMs = (ag && ag.workingMs) || 0;
      const agLiveMs = (ag && ag._workStartAt != null) ? Date.now() - ag._workStartAt : 0;
      const hasWork = agWorkMs > 0 || agLiveMs > 0;
      stpElapsed.textContent = hasWork ? fmtDuration(agWorkMs + agLiveMs) : (running ? '进行中' : '未开始');
      const ws = workspaceInfo(cur);
      stpWorkspace.textContent = ws.name;
      stpWorkspace.title = ws.full || '';
      updatePopoverCost(cur.agent, stpCostRow, stpCost);
      stpContext.innerHTML = renderPopoverContext(computeContextStats(cur.agent));
    };
    update();

    const rect = tab.getBoundingClientRect();
    pop.classList.remove('hidden');
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
    let top = rect.bottom + 6;
    if (top + popH > window.innerHeight - 8) top = Math.max(8, rect.top - popH - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    if (_stpTimer) clearInterval(_stpTimer);
    _stpTimer = setInterval(update, 1000);
  }

  function hideSessionTabPopover() {
    _stpSessionKey = null;
    if (_stpTimer) { clearInterval(_stpTimer); _stpTimer = null; }
    const pop = document.getElementById('session-tab-popover');
    if (pop) pop.classList.add('hidden');
  }

  // 会话详情左侧：实时金钱消耗（已配置价格且有消费数据才显示，否则隐藏）
  function updatePopoverCost(ag, rowEl, costEl) {
    if (!ag || !rowEl || !costEl) return;
    let cost = null;
    let estimated = false;
    const byModel = ag.sessionUsageByModel || {};
    const entries = Object.entries(byModel)
      .filter(([, u]) => u && (u.total > 0 || u.prompt > 0 || u.completion > 0));
    const calc = (typeof computeSessionCostForModel === 'function')
      ? computeSessionCostForModel : null;
    if (entries.length > 0) {
      let total = 0;
      let priced = false;
      for (const [model, mu] of entries) {
        const c = calc ? calc(ag, model, mu) : null;
        if (c) {
          total += c.totalCost;
          priced = true;
        }
        if (mu.estimated) estimated = true;
      }
      if (priced) cost = total;
    } else if (ag.sessionUsage && ag.sessionUsage.total > 0) {
      const activeModel = (typeof ag.getActiveModelId === 'function')
        ? ag.getActiveModelId() : (ag.settings?.llm?.model || '');
      const c = calc ? calc(ag, activeModel, ag.sessionUsage) : null;
      if (c) cost = c.totalCost;
      estimated = ag.sessionUsage.estimated === true;
    }
    // 无价格配置（cost=null）或会话刚开始（cost=0）都不显示
    if (cost === null || !(cost > 0)) {
      rowEl.classList.add('hidden');
      return;
    }
    const fmtCost = cost >= 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(6)}`;
    costEl.textContent = (estimated ? '~' : '') + fmtCost;
    rowEl.classList.remove('hidden');
  }

  // 切换模式时优先恢复该模式最后访问的会话；不存在/已关闭时回退到第一个标签
  function resolveModeTarget(mode) {
    try {
      const active = sessionManager.getActive(mode);
      if (active) return active;
      const lastKey = sessionManager.getLastActive(mode);
      if (lastKey) {
        const last = sessionManager.get(lastKey);
        if (last) return last;
      }
      return sessionManager.ordered(mode)[0] || null;
    } catch {
      return (sessionManager && sessionManager.ordered(mode)[0]) || null;
    }
  }

  // 只显示当前模式对应的标签栏（宿主常驻，其余模式隐藏）
  function showSessionTabsForMode(mode) {
    const host = document.getElementById('session-tabs-host');
    if (host) host.classList.remove('hidden');
    for (const m of ['chat', 'code', 'babe']) {
      const el = document.getElementById(`${m}-session-tabs`);
      if (!el) continue;
      el.classList.remove('hidden');
      const want = m === mode ? 'flex' : 'none';
      if (el.style.getPropertyValue('display') !== want) {
        el.style.setProperty('display', want, 'important');
        if (!isRemoteMode) {
          try {
            WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + el.id, attr: 'style', value: el.style.cssText });
          } catch { /* ignore */ }
        }
      }
    }
  }
