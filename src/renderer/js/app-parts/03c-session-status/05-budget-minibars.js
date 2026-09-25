  async function refreshBudgetMiniBars() {
    try {
      const st = await window.api.budgetGetStatus();
      if (!st?.ok) return;
      const daily = st.daily || {};
      const monthly = st.monthly || {};
      // 三种模式的预算小条使用同一份数据（按当日总花费）
      const targets = ['chat-budget-mini-bar', 'code-budget-mini-bar', 'babe-budget-mini-bar'];
      for (const id of targets) {
        const el = document.getElementById(id);
        if (!el) continue;
        const cost = daily.costUSD || 0;
        const limit = daily.limitUSD || 0;
        // 仅在 (有限额) 或 (已花费 > 0) 时显示
        if (limit > 0 || cost > 0) {
          el.style.display = '';
          el.dataset.level = daily.level || 'normal';
          const fill = el.querySelector('.bmb-fill');
          const costEl = el.querySelector('.bmb-cost');
          if (fill) fill.style.width = `${Math.min(100, daily.pct || 0)}%`;
          if (costEl) {
            const fmtCost = cost >= 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(6)}`;
            costEl.textContent = limit > 0 ? `${fmtCost} / $${limit.toFixed(2)}` : fmtCost;
          }
          // title 包含今日/本月详情
          const peakTag = (st.peakHours?.enabled) ? ` · 峰时段 ${st.peakHours.start}-${st.peakHours.end}` : '';
          el.title = `今日 $${cost.toFixed(4)}${limit > 0 ? ` / $${limit.toFixed(2)}` : ''} · 本月 $${(monthly.costUSD || 0).toFixed(4)}${peakTag}`;
        } else {
          el.style.display = 'none';
        }
      }
    } catch (_) { /* 静默失败：不影响主流程 */ }
  }
  // 启动时和每 5 秒刷新一次（实时性，但又不至于过频）
  refreshBudgetMiniBars();
  setInterval(refreshBudgetMiniBars, 5000);
  // 监听 LLM 流结束事件以即时刷新
  try {
    window.api.onStreamEnd?.(() => { setTimeout(refreshBudgetMiniBars, 300); });
  } catch (_) {}

  // 刷新上下文指示器右侧的"当前会话消费"小数字（按 agent.sessionUsage + 价格表实时计算）
  function refreshSessionCostMini() {
    try {
      const agents = [
        { id: 'chat-session-cost', agent: typeof agent !== 'undefined' ? agent : null },
        { id: 'code-session-cost', agent: typeof codeAgent !== 'undefined' ? codeAgent : null },
        { id: 'babe-session-cost', agent: typeof babeAgent !== 'undefined' ? babeAgent : null }
      ];
      for (const { id, agent: a } of agents) {
        const el = document.getElementById(id);
        if (!el) continue;
        const su = a?.sessionUsage;
        if (!su) { el.style.display = 'none'; continue; }
        // 混合模型：按分桶逐模型计价求和；旧数据回退到当前模型单价
        const byModel = a?.sessionUsageByModel || {};
        const entries = Object.entries(byModel)
          .filter(([, u]) => u && (u.total > 0 || u.prompt > 0 || u.completion > 0));
        let totalCost = 0;
        let modelLabel = '';
        let priced = false;
        if (entries.length > 0) {
          const names = [];
          for (const [model, mu] of entries) {
            const cost = computeSessionCostForModel(a, model, mu);
            if (cost) {
              totalCost += cost.totalCost;
              priced = true;
              names.push(model);
            }
          }
          modelLabel = names.join(' + ');
        } else {
          const activeModel = (typeof a?.getActiveModelId === 'function') ? a.getActiveModelId() : a?.settings?.llm?.model;
          const cost = computeSessionCostForModel(a, activeModel, su);
          if (cost) {
            totalCost = cost.totalCost;
            priced = true;
            modelLabel = activeModel || '';
          }
        }
        if (!priced) { el.style.display = 'none'; continue; }
        if (totalCost > 0) {
          el.style.display = '';
          const valEl = el.querySelector('.scm-value');
          const fmtCost = totalCost >= 0.01 ? `$${totalCost.toFixed(4)}` : `$${totalCost.toFixed(6)}`;
          if (valEl) valEl.textContent = (su.estimated ? '~' : '') + fmtCost;
          el.title = `当前会话消费${su.estimated ? ' (估算)' : ''}：${fmtCost}\n模型：${modelLabel || '未知'}`;
        } else {
          el.style.display = 'none';
        }
      }
    } catch (_) { /* 静默失败 */ }
  }
  setInterval(refreshSessionCostMini, 1000);

  btnReoptimizeTools?.addEventListener('click', async () => {
    if (!agent.settings?.autoOptimizeToolSelection) return;
    const seed = chatInput.value.trim() || (typeof agent.getLatestUserMessageText === 'function' ? agent.getLatestUserMessageText() : '') || '手动触发工具重优化';
    await agent.optimizeToolsForConversation(seed, '用户手动点击“重新优化工具选择”');
    updateReoptimizeButtonVisibility();
    if (document.getElementById('page-tools')?.classList.contains('active')) {
      loadToolsPage();
    }
  });
