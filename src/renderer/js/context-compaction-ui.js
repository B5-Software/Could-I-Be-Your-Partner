/* SPDX-License-Identifier: GPL-3.0-or-later */
(() => {
  const labels = {
    running: ['ui.compaction.running', '正在压缩上下文'],
    done: ['ui.compaction.done', '上下文已压缩'],
    error: ['ui.compaction.error', '压缩失败 · 上下文已保留'],
    skipped: ['ui.compaction.skipped', '本次无需压缩']
  };
  const tr = (key, fallback) => typeof t === 'function' ? t(key, fallback) : fallback;
  const tokens = value => Number(value || 0).toLocaleString();
  const timers = new Map();
  function hide(badge) {
    if (badge.hidden) return;
    badge.dataset.dismissed = badge.dataset.stateId;
    if (!window.CibypMotion?.enabled()) { badge.hidden = true; return; }
    const id = badge.dataset.stateId;
    badge.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180 }).finished.then(() => {
      if (badge.dataset.stateId === id) badge.hidden = true;
    }).catch(() => {});
  }
  function update(agent, indicatorId) {
    const indicator = document.getElementById(indicatorId);
    if (!indicator) return;
    let badge = document.getElementById(indicatorId + '-compaction');
    const state = agent?._compactionState || agent?.contextManager?.compactionState;
    if (!state || !labels[state.phase]) { if (badge) badge.hidden = true; return; }
    const lifetime = state.phase === 'error' ? 12000 : 7000;
    if (state.finishedAt && Date.now() - state.finishedAt >= lifetime) { if (badge) hide(badge); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.id = indicatorId + '-compaction';
      badge.className = 'context-compaction-status';
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      badge.setAttribute('aria-atomic', 'true');
      indicator.after(badge);
    }
    const newState = badge.dataset.stateId !== state.id || badge.dataset.phase !== state.phase;
    badge.dataset.stateId = state.id;
    if (badge.dataset.dismissed === state.id && !newState) return;
    const wasHidden = badge.hidden || !badge.dataset.phase;
    badge.hidden = false;
    badge.dataset.phase = state.phase;
    const label = tr(...labels[state.phase]);
    const detail = state.phase === 'done' ? `${tokens(state.beforeTokens)} → ${tokens(state.afterTokens)}` : '';
    const signature = JSON.stringify([label, detail, state.phase, state.message]);
    if (badge.dataset.signature === signature) return;
    badge.dataset.signature = signature;
    badge.replaceChildren();
    const icon = document.createElement('i');
    icon.className = 'fa-solid ' + ({ running: 'fa-spinner fa-spin', done: 'fa-check', error: 'fa-triangle-exclamation', skipped: 'fa-circle-info' })[state.phase];
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.textContent = label;
    badge.append(icon, text);
    if (detail) { const amount = document.createElement('span'); amount.className = 'compaction-token-change'; amount.textContent = detail; badge.append(amount); }
    badge.title = [label, detail, state.message, tr('ui.compaction.estimate', 'Token 数量为估算；完整聊天历史保留')].filter(Boolean).join('\n');
    if (wasHidden && window.CibypMotion?.enabled()) badge.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    clearTimeout(timers.get(indicatorId));
    if (state.finishedAt) timers.set(indicatorId, setTimeout(() => hide(badge), Math.max(0, lifetime - (Date.now() - state.finishedAt))));
  }
  function refresh() {
    const sm = window.__sessionManager;
    for (const [mode, id] of [['chat', 'chat-context-indicator'], ['code', 'code-context-indicator'], ['babe', 'babe-context-indicator']]) update(sm?.getActive(mode)?.agent, id);
  }
  window.CibypCompactionUI = { update, refresh };
  window.addEventListener('languagechange', refresh);
})();
