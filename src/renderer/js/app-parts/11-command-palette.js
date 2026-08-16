/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// ---- Slash 命令模式（输入框以 / 开头） ----
// 支持：/model 切换模型（会话级）、/variant 切换变体（思考强度）、/minimal 切换极简模式、/help
// 参考 OpenCode 的斜杠命令交互：浮层面板、↑↓ 选择、Enter 执行、Tab 补全、Esc 关闭。
// 命令执行不把文本当消息发送；切换模型后自动收敛变体，避免 400。
(function () {
  'use strict';

  const INPUT_MODE_MAP = [
    { id: 'chat-input', mode: 'chat' },
    { id: 'code-chat-input', mode: 'code' },
    { id: 'babe-chat-input', mode: 'babe' }
  ];

  const COMMAND_DEFS = [
    { cmd: '/model', icon: 'fa-robot', desc: '切换模型（仅本会话生效）' },
    { cmd: '/variant', icon: 'fa-gauge-high', desc: '切换变体 / 思考强度' },
    { cmd: '/minimal', icon: 'fa-wand-magic-sparkles', desc: '切换极简模式（精简提示词 + 最小工具集）' },
    { cmd: '/help', icon: 'fa-circle-question', desc: '查看可用命令' }
  ];

  let panel = null;
  let panelInput = null;
  let panelItems = [];
  let selectedIndex = 0;
  let loading = false;

  function getAgentForInput(input) {
    const id = input && input.id;
    if (id === 'chat-input') return (typeof agent !== 'undefined' ? agent : null);
    if (id === 'code-chat-input') return (typeof codeAgent !== 'undefined' ? codeAgent : null);
    if (id === 'babe-chat-input') return (typeof babeAgent !== 'undefined' ? babeAgent : null);
    return null;
  }

  function getModeForInput(input) {
    const entry = INPUT_MODE_MAP.find(e => e.id === input?.id);
    return entry ? entry.mode : null;
  }

  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.className = 'cmd-palette';
    panel.style.display = 'none';
    document.body.appendChild(panel);
    return panel;
  }

  function positionPanel(input) {
    const p = ensurePanel();
    const rect = input.getBoundingClientRect();
    p.style.left = `${Math.max(8, rect.left)}px`;
    p.style.width = `${Math.max(220, rect.width)}px`;
    p.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
  }

  function renderItems(items) {
    panelItems = items || [];
    selectedIndex = panelItems.length > 0 ? 0 : -1;
    const p = ensurePanel();
    if (!panelItems.length) {
      p.innerHTML = '<div class="cmd-palette-empty">没有匹配结果（Esc 关闭，Enter 按普通消息发送）</div>';
      return;
    }
    p.innerHTML = panelItems.map((it, i) => `
      <div class="cmd-palette-item${i === selectedIndex ? ' selected' : ''}" data-index="${i}">
        <i class="fa-solid ${it.icon || 'fa-circle'}"></i>
        <div class="cmd-palette-item-body">
          <div class="cmd-palette-item-label">${esc(it.label)}</div>
          ${it.desc ? `<div class="cmd-palette-item-desc">${esc(it.desc)}</div>` : ''}
        </div>
        ${it.badge ? `<span class="cmd-palette-item-badge">${esc(it.badge)}</span>` : ''}
      </div>`).join('');
    p.querySelectorAll('.cmd-palette-item').forEach(el => {
      const idx = Number(el.dataset.index);
      // 鼠标悬停高亮（与键盘 ↑↓ 共用 selectedIndex）
      el.addEventListener('mouseenter', () => {
        if (Number(el.dataset.index) !== selectedIndex) {
          selectedIndex = Number(el.dataset.index);
          highlightSelected();
        }
      });
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedIndex = idx;
        executeSelected();
      });
    });
    highlightSelected();
  }

  function highlightSelected() {
    const p = panel;
    if (!p) return;
    p.querySelectorAll('.cmd-palette-item').forEach(el => {
      el.classList.toggle('selected', Number(el.dataset.index) === selectedIndex);
    });
    const sel = p.querySelector('.cmd-palette-item.selected');
    if (sel && typeof sel.scrollIntoView === 'function') {
      sel.scrollIntoView({ block: 'nearest' });
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function parseCommandText(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('/')) return { cmd: null, query: '' };
    const m = t.match(/^(\/[a-z-]+)(?:\s+([\s\S]*))?$/i);
    if (!m) return { cmd: t.split(/\s+/)[0].toLowerCase(), query: '' };
    return { cmd: m[1].toLowerCase(), query: (m[2] || '').trim() };
  }

  async function openPanel(input) {
    const text = input.value || '';
    if (!text.startsWith('/')) { closePanel(); return; }
    const ag = getAgentForInput(input);
    panelInput = input;
    positionPanel(input);
    const { cmd, query } = parseCommandText(text);

    // 顶层命令菜单（含模糊过滤）
    if (!cmd || cmd === '/' || !COMMAND_DEFS.some(c => c.cmd === cmd)) {
      const q = (cmd === '/' ? '' : (cmd || '').slice(1)).toLowerCase();
      const defs = COMMAND_DEFS.filter(c => !q || c.cmd.includes(q) || c.desc.toLowerCase().includes(q));
      renderItems(defs.map(c => ({ ...c, label: c.cmd, badge: null })));
      showPanel();
      return;
    }

    const def = COMMAND_DEFS.find(c => c.cmd === cmd);
    if (cmd === '/help') {
      renderItems(COMMAND_DEFS.map(c => ({ ...c, label: c.cmd })));
      showPanel();
      return;
    }
    if (cmd === '/minimal') {
      const mode = getModeForInput(input);
      const on = ag && ag.minimalMode === true;
      if (mode === 'babe') {
        renderItems([{ label: 'Babe 模式不支持极简模式', icon: 'fa-circle-info', desc: '极简模式仅适用于 Chat / Code 模式' }]);
      } else {
        renderItems([{
          label: on ? '关闭极简模式' : '开启极简模式',
          icon: 'fa-wand-magic-sparkles',
          desc: on ? '恢复完整提示词与工具集' : '精简系统提示词 + 终端/文件编辑最小工具集',
          badge: on ? '当前：开启' : '当前：关闭'
        }]);
      }
      showPanel();
      return;
    }
    if (cmd === '/model') {
      loading = true;
      renderItems([{ label: '正在加载模型列表…', icon: 'fa-spinner fa-spin' }]);
      showPanel();
      const models = await fetchModelList(ag);
      loading = false;
      if (panelInput !== input) return; // 期间焦点/输入已切换
      const q = query.toLowerCase();
      const activeModel = ag ? ag.getActiveModelId() : '';
      renderItems(models
        .filter(m => !q || String(m.id || '').toLowerCase().includes(q))
        .map(m => ({
          label: m.id,
          icon: 'fa-robot',
          desc: m.name && m.name !== m.id ? m.name : '切换后自动收敛变体',
          badge: m.id === activeModel ? '当前' : ''
        })));
      showPanel();
      return;
    }
    if (cmd === '/variant') {
      loading = true;
      renderItems([{ label: '正在加载变体档位…', icon: 'fa-spinner fa-spin' }]);
      showPanel();
      const variants = await fetchVariants(ag);
      loading = false;
      if (panelInput !== input) return;
      const activeEffort = ag ? ag.getActiveReasoningEffort() : 'off';
      const q = query.toLowerCase();
      renderItems(variants
        .filter(v => !q || String(v.label || '').toLowerCase().includes(q) || String(v.id || '').includes(q))
        .map(v => ({
          label: v.label,
          icon: 'fa-gauge-high',
          desc: `wire: ${v.id}`,
          badge: v.id === activeEffort ? '当前' : ''
        })));
      showPanel();
      return;
    }
    closePanel();
  }

  function showPanel() {
    const p = ensurePanel();
    p.style.display = 'block';
  }

  function closePanel() {
    if (panel) panel.style.display = 'none';
    panelInput = null;
    panelItems = [];
    selectedIndex = 0;
    loading = false;
  }

  async function fetchModelList(ag) {
    const s = (ag && ag.settings) || {};
    const provider = s.llm?.provider || 'openai-compat';
    let models = [];
    try {
      if (provider === 'opencode-zen') {
        const res = await window.api.zenFetchModels();
        if (res && res.ok && Array.isArray(res.models)) {
          models = res.models.map(m => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } else {
        const res = await window.api.llmFetchModels(provider, s.llm?.apiUrl || '', s.llm?.apiKey || '');
        if (res && res.ok && Array.isArray(res.models)) {
          models = res.models.map(m => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      }
    } catch (_) { /* 网络失败走缓存兜底 */ }
    if (!models.length && typeof llmFetchedModels !== 'undefined' && Array.isArray(llmFetchedModels)) {
      models = llmFetchedModels.map(m => ({ id: m.id || m.name, name: m.name || m.id }));
    }
    if (!models.length && s.llm?.model) {
      models = [{ id: s.llm.model, name: '当前全局模型' }];
    }
    return models;
  }

  async function fetchVariants(ag) {
    const s = (ag && ag.settings) || {};
    const provider = s.llm?.provider || 'openai-compat';
    const model = ag ? ag.getActiveModelId() : (s.llm?.model || '');
    try {
      const apiUrl = provider === 'opencode-zen' ? '' : (s.llm?.apiUrl || '');
      const apiKey = provider === 'opencode-zen' ? (s.llm?.zenApiKey || '') : (s.llm?.apiKey || '');
      const res = await window.api.llmCapabilities?.(provider, model, apiUrl, apiKey);
      if (res && res.ok && Array.isArray(res.variants) && res.variants.length) return res.variants;
    } catch (_) { /* 走兜底 */ }
    const fallback = ['off', 'auto', 'low', 'medium', 'high'];
    const labels = { off: '关闭', auto: '自动（模型默认）', low: '低', medium: '中', high: '高' };
    return fallback.map(id => ({ id, label: labels[id], wire: id }));
  }

  async function executeSelected() {
    if (!panelInput || selectedIndex < 0 || selectedIndex >= panelItems.length) return;
    const item = panelItems[selectedIndex];
    const input = panelInput;
    const text = input.value || '';
    const { cmd } = parseCommandText(text);
    const ag = getAgentForInput(input);

    // 命令菜单项（顶层模糊匹配 / /help）：补全命令名并打开对应面板
    if (item && item.cmd && String(item.cmd).startsWith('/')) {
      completeCommand(input, item.cmd);
      return;
    }

    if (cmd === '/model') {
      if (item.label && !item.label.includes('加载')) await applyModel(ag, item.label);
      clearAndClose(input);
      return;
    }
    if (cmd === '/variant') {
      await applyVariant(ag, item);
      clearAndClose(input);
      return;
    }
    if (cmd === '/minimal') {
      await toggleMinimal(ag, input);
      clearAndClose(input);
      return;
    }
    clearAndClose(input);
  }

  // 把输入框补全为完整命令（/mod → /model ），触发 input 事件打开对应面板
  function completeCommand(input, cmd) {
    if (!input || !cmd) return;
    input.value = cmd + ' ';
    input.dispatchEvent(new Event('input'));
    try {
      const len = input.value.length;
      if (typeof input.setSelectionRange === 'function') input.setSelectionRange(len, len);
    } catch (_) { /* 某些 textarea 状态异常时忽略 */ }
    if (typeof input.focus === 'function') input.focus();
  }

  function clearAndClose(input) {
    input.value = '';
    input.dispatchEvent(new Event('input'));
    closePanel();
    if (typeof input.focus === 'function') input.focus();
  }

  async function applyModel(ag, modelId) {
    if (!ag || !modelId) return;
    const s = ag.settings || {};
    const provider = s.llm?.provider || 'openai-compat';
    ag.llmOverride = ag.llmOverride || {};
    ag.llmOverride.model = modelId;
    let extra = '';
    try {
      const apiUrl = provider === 'opencode-zen' ? '' : (s.llm?.apiUrl || '');
      const apiKey = provider === 'opencode-zen' ? (s.llm?.zenApiKey || '') : (s.llm?.apiKey || '');
      const res = await window.api.llmCapabilities?.(provider, modelId, apiUrl, apiKey);
      if (res && res.ok && Array.isArray(res.variants) && res.variants.length) {
        const ids = res.variants.map(v => v.id);
        const cur = ag.getActiveReasoningEffort();
        if (!ids.includes(cur)) {
          const def = res.defaultId || 'off';
          ag.llmOverride.reasoningEffort = def;
          const label = (res.variants.find(v => v.id === def) || {}).label || def;
          extra = `，变体已自动调整为「${label}」`;
        }
      }
    } catch (_) { /* 收敛失败不阻断切换 */ }
    if (typeof ag.applySettings === 'function') { try { ag.applySettings(ag.settings); } catch (_) {} }
    try { await ag.saveToHistory?.(); } catch (_) {}
    if (typeof window.showToast === 'function') window.showToast(`已切换模型：${modelId}（仅本会话）${extra}`, 'success', 4000);
  }

  async function applyVariant(ag, item) {
    if (!ag || !item || !item.id || item.id === 'loading') return;
    ag.llmOverride = ag.llmOverride || {};
    ag.llmOverride.reasoningEffort = item.id;
    if (typeof ag.applySettings === 'function') { try { ag.applySettings(ag.settings); } catch (_) {} }
    try { await ag.saveToHistory?.(); } catch (_) {}
    if (typeof window.showToast === 'function') window.showToast(`已切换变体：${item.label}（仅本会话）`, 'success', 3500);
  }

  async function toggleMinimal(ag, input) {
    if (!ag) return;
    if (getModeForInput(input) === 'babe') {
      if (typeof window.showToast === 'function') window.showToast('Babe 模式不支持极简模式', 'warn', 3000);
      return;
    }
    ag.minimalMode = !ag.minimalMode;
    if (typeof ag.resetOptimizedTools === 'function') { try { ag.resetOptimizedTools(); } catch (_) {} }
    if (typeof ag.applySettings === 'function') { try { ag.applySettings(ag.settings); } catch (_) {} }
    try { await ag.saveToHistory?.(); } catch (_) {}
    updateMinimalBadge(input, ag.minimalMode);
    if (typeof window.showToast === 'function') {
      window.showToast(ag.minimalMode ? '已开启极简模式（精简提示词 + 最小工具集）' : '已关闭极简模式', 'success', 3500);
    }
  }

  function updateMinimalBadge(input, on) {
    if (!input) return;
    const wrap = input.closest('.input-wrapper, .code-chat-input, .babe-chat-input');
    if (!wrap) return;
    let badge = wrap.querySelector(':scope > .minimal-mode-badge');
    if (!on) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'minimal-mode-badge';
      badge.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 极简';
      wrap.insertBefore(badge, wrap.firstChild);
    }
  }

  // 各输入框打开时同步极简徽标
  function syncBadges() {
    // 以 SessionManager 的活动会话为准（切换会话后 agent 全局变量重新赋值存在时序，
    // 直接读 sm.getActive(mode).agent 才能拿到新激活会话，避免极简徽标串到旧会话）
    const sm = (typeof window !== 'undefined' ? window.__sessionManager : null);
    for (const entry of INPUT_MODE_MAP) {
      const input = document.getElementById(entry.id);
      let ag = null;
      if (sm && typeof sm.getActive === 'function') {
        ag = (sm.getActive(entry.mode) || {}).agent || null;
      }
      if (!ag) ag = getAgentForInput(input);
      if (input && ag) updateMinimalBadge(input, ag.minimalMode === true);
    }
  }

  // 文档级捕获监听：先于各输入框自身的 Enter 处理器执行，命令模式拦截发送
  document.addEventListener('keydown', (e) => {
    if (!panel || panel.style.display === 'none') return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const cur = panelInput;
      closePanel();
      if (cur) { cur.value = ''; cur.dispatchEvent(new Event('input')); cur.focus(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!panelItems.length) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      selectedIndex = (selectedIndex + delta + panelItems.length) % panelItems.length;
      highlightSelected();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      // 有可执行项时拦截（顶层命令菜单选择命令；模型/变体/极简选择项）
      if (selectedIndex >= 0 && selectedIndex < panelItems.length) {
        e.preventDefault();
        e.stopPropagation();
        executeSelected();
        return;
      }
      // 无匹配项：Enter 放行，按普通消息发送；Tab 只关闭面板
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      }
      return;
    }
  }, true);

  // 输入变化：以 / 开头打开面板，否则关闭
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !INPUT_MODE_MAP.some(m => m.id === t.id)) return;
    if (t.value && t.value.startsWith('/')) {
      openPanel(t);
    } else if (panel && panel.style.display !== 'none' && panelInput === t) {
      closePanel();
    }
  }, true);

  // 点击面板外关闭
  document.addEventListener('mousedown', (e) => {
    if (!panel || panel.style.display === 'none') return;
    if (!panel.contains(e.target)) closePanel();
  }, true);

  // 窗口尺寸变化 / 滚动时重定位
  window.addEventListener('resize', () => { if (panelInput && panel && panel.style.display !== 'none') positionPanel(panelInput); });
  document.addEventListener('scroll', () => {
    if (panelInput && panel && panel.style.display !== 'none') positionPanel(panelInput);
  }, true);

  // 启动时同步各输入框的极简徽标（此时 DOM 已解析，part 01 已初始化主 Agent）
  syncBadges();
  // 会话激活时同步徽标（新会话 Agent 可能替换）
  if (typeof window.AppBus !== 'undefined' && window.AppBus && window.AppBus.addEventListener) {
    window.AppBus.addEventListener('session-activated', () => syncBadges());
    window.AppBus.addEventListener('session-deactivated', () => syncBadges());
  }
  window._cmdPaletteRefreshBadges = syncBadges;
})();
