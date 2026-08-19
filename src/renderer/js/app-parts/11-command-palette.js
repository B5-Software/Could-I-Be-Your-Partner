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
    { cmd: '/fork', icon: 'fa-code-branch', desc: '分支当前对话为新会话（/fork N 分支到第 N 条用户消息）' },
    { cmd: '/clear', icon: 'fa-broom', desc: '清空上下文（保留可见聊天记录）' },
    { cmd: '/compact', icon: 'fa-compress', desc: '立即压缩当前上下文（可附加聚焦说明）' },
    { cmd: '/new', icon: 'fa-plus', desc: '新建同模式会话' },
    { cmd: '/config', icon: 'fa-gear', desc: '打开设置（/config llm 直达对应标签页）' },
    { cmd: '/doctor', icon: 'fa-stethoscope', desc: '检测开发环境（Python / Node / Bun / Git）' },
    { cmd: '/export', icon: 'fa-file-export', desc: '导出当前会话（/export md 或 /export json）' },
    { cmd: '/help', icon: 'fa-circle-question', desc: '查看可用命令' }
  ];

  // /config 可直达的设置标签页（id + 中文名）
  const SETTINGS_TABS = [
    ['ai', 'AI 形象'], ['babe', 'Babe 模式'], ['user', '个人资料'], ['llm', 'LLM'],
    ['usage', '用量统计'], ['budget', '预算控制'], ['image', '生图'], ['theme', '主题'],
    ['animations', '动效'], ['fonts', '字体'], ['language', '语言'], ['network', '网络'],
    ['entropy', '熵源'], ['firmware', 'TRNG固件'], ['security', '安全'], ['mcp', 'MCP'],
    ['email', '邮箱'], ['fedikitten', 'FediKitten'], ['webcontrol', 'Web控制'], ['playwright', 'Playwright'],
    ['notifications', '通知'], ['terminal', '终端'], ['ime', '输入法'], ['voice', '语音'],
    ['context', '上下文'], ['sandbox', '沙箱'], ['automation', '自动化'], ['plugins', '插件'],
    ['environment', '环境检测'], ['updates', '更新']
  ];

  let panel = null;
  let panelInput = null;
  let panelItems = [];
  let selectedIndex = 0;
  let loading = false;
  let outsideMousedownHandler = null;

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
    if (cmd === '/fork') {
      const mode = getModeForInput(input);
      const n = parseInt(query, 10);
      if (mode === 'babe') {
        renderItems([{ label: 'Babe 模式暂不支持分支', icon: 'fa-circle-info', desc: '分支仅适用于 Chat / Code 模式' }]);
      } else {
        renderItems([{
          label: (Number.isFinite(n) && n > 0) ? `分支到第 ${n} 条用户消息` : '创建分支（复制完整对话）',
          icon: 'fa-code-branch',
          desc: '新会话继承历史/模型/变体/极简属性，独立计费',
          action: 'fork',
          upto: (Number.isFinite(n) && n > 0) ? n : null
        }]);
      }
      showPanel();
      return;
    }
    if (cmd === '/clear') {
      renderItems([{
        label: '清空上下文（保留聊天记录）',
        icon: 'fa-broom',
        desc: '下一次请求从全新上下文开始，可见聊天与历史记录不变',
        action: 'clear'
      }]);
      showPanel();
      return;
    }
    if (cmd === '/compact') {
      renderItems([{
        label: query ? `压缩上下文（聚焦：${query.slice(0, 30)}）` : '立即压缩上下文',
        icon: 'fa-compress',
        desc: '无视当前使用率，直接压缩早期对话',
        action: 'compact',
        focus: query || null
      }]);
      showPanel();
      return;
    }
    if (cmd === '/new') {
      renderItems([{
        label: '新建同模式会话',
        icon: 'fa-plus',
        desc: `模式：${getModeForInput(input) || 'chat'}`,
        action: 'new'
      }]);
      showPanel();
      return;
    }
    if (cmd === '/config') {
      const q = query.toLowerCase();
      renderItems(SETTINGS_TABS
        .filter(([id, label]) => !q || id.includes(q) || label.includes(q))
        .map(([id, label]) => ({
          label,
          icon: 'fa-gear',
          desc: `tab: ${id}`,
          action: 'config',
          tab: id
        })));
      showPanel();
      return;
    }
    if (cmd === '/doctor') {
      renderItems([{
        label: '运行环境检测',
        icon: 'fa-stethoscope',
        desc: '检测 Python / Node+npm / Bun / Git 并显示版本',
        action: 'doctor'
      }]);
      showPanel();
      return;
    }
    if (cmd === '/export') {
      const q = query.toLowerCase();
      const formats = [
        { id: 'md', label: 'Markdown（.md）', desc: '人类可读的对话记录' },
        { id: 'json', label: 'JSON（.json）', desc: '完整结构数据（消息+元信息）' }
      ].filter(f => !q || f.id.includes(q) || f.label.includes(q));
      renderItems(formats.map(f => ({
        label: f.label,
        icon: 'fa-file-export',
        desc: f.desc,
        action: 'export',
        format: f.id
      })));
      showPanel();
      return;
    }
    closePanel();
  }

  function showPanel() {
    const p = ensurePanel();
    p.style.display = 'block';
    // 只在面板打开期间注册外部点击关闭监听，面板关闭时零全局干扰
    if (!outsideMousedownHandler) {
      outsideMousedownHandler = (e) => {
        if (!panel.contains(e.target)) closePanel();
      };
      document.addEventListener('mousedown', outsideMousedownHandler, true);
    }
  }

  function closePanel() {
    if (panel) panel.style.display = 'none';
    if (outsideMousedownHandler) {
      document.removeEventListener('mousedown', outsideMousedownHandler, true);
      outsideMousedownHandler = null;
    }
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

    if (item && item.action) {
      try {
        await runAction(item.action, item, input, ag);
      } catch (e) {
        if (typeof window.showToast === 'function') window.showToast('命令执行失败：' + (e && e.message ? e.message : e), 'error', 4000);
      }
      clearAndClose(input);
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
    // 先关闭面板再清空输入框，避免合成 input 事件与面板状态互相干扰
    closePanel();
    input.value = '';
    // 仅在输入框所在页面可见时派发 input 事件并聚焦。
    // /config、/doctor 会切到设置页：此时 input 已隐藏，若派发合成 input，
    // 自动调高处理器会按 scrollHeight=0 把高度写成 0px，返回后输入框塌陷无法点击。
    if (input.offsetParent !== null) {
      input.dispatchEvent(new Event('input'));
    }
    if (typeof input.focus === 'function' && input.offsetParent !== null) {
      input.focus();
    }
  }

  async function runAction(action, item, input, ag) {
    const mode = getModeForInput(input);
    switch (action) {
      case 'fork': await forkConversation(ag, input, item.upto ?? null); break;
      case 'clear': await clearContext(ag); break;
      case 'compact': await compactContext(ag, item.focus); break;
      case 'new': createNewSessionForMode(mode); break;
      case 'config': openSettingsTab(item.tab); break;
      case 'doctor': openSettingsTab('environment'); break;
      case 'export': await exportConversation(ag, item.format || 'md'); break;
      default: break;
    }
  }

  async function forkConversation(ag, input, uptoIndex) {
    if (!ag) return;
    const mode = getModeForInput(input);
    if (mode === 'babe') {
      if (typeof window.showToast === 'function') window.showToast('Babe 模式暂不支持分支', 'warn', 3000);
      return;
    }
    const full = (ag.contextManager && typeof ag.contextManager.getHistoryMessages === 'function')
      ? ag.contextManager.getHistoryMessages() : [];
    const utils = (typeof window !== 'undefined' && window.CIBYPForkUtils) || {};
    const trunc = (uptoIndex && typeof utils.truncateToUserMessage === 'function')
      ? utils.truncateToUserMessage(full, uptoIndex)
      : { truncated: full, lastUserText: '' };
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const forkConv = {
      id: newId,
      title: (ag.conversationTitle || '未命名对话') + '（分支）',
      ts: Date.now(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 2,
      messages: trunc.truncated || [],
      summaries: Array.isArray(ag.contextManager?.summaries) ? ag.contextManager.summaries.slice() : [],
      tarotCard: ag.tarotCard || null,
      workspacePath: ag.workspacePath || null,
      mode,
      status: 'idle',
      lastError: null,
      usage: { prompt: 0, completion: 0, total: 0, cached: 0, cacheCreation: 0, estimated: false },
      usageByModel: {},
      llmOverride: { ...(ag.llmOverride || {}) },
      minimal: ag.minimalMode === true,
      parentId: ag.conversationId || null,
      parentTitle: ag.conversationTitle || '',
      subAgents: []
    };
    if (mode === 'chat') {
      const ag2 = new Agent();
      ag2.mode = 'chat';
      await ag2.init();
      // 分支共享源会话工作目录（不新建 workspace）
      if (ag.workspacePath) {
        ag2.workspacePath = ag.workspacePath;
        try {
          const tree = await window.api.workspaceGetFileTree(ag.workspacePath);
          if (tree && tree.ok) ag2.cachedWorkspaceTree = tree.tree;
        } catch (_) { /* 文件树失败不影响分支 */ }
        try { await window.api.webControlSetWorkDir(ag.workspacePath); } catch (_) { /* ignore */ }
      }
      await ag2.loadFromHistory(forkConv);
      wireChatAgent(ag2);
      const session = sessionManager.registerAgent('chat', ag2, { id: newId, title: forkConv.title });
      session.draft = trunc.lastUserText || '';
      activateSession('chat', session.key);
      try { await ag2.saveToHistory(); } catch (_) { /* ignore */ }
    } else if (mode === 'code') {
      forkConv._restorePrompt = trunc.lastUserText || '';
      await createCodeSession(forkConv);
      if (typeof codeAgent !== 'undefined' && codeAgent && String(codeAgent.conversationId) === newId) {
        try { await codeAgent.saveToHistory(); } catch (_) { /* ignore */ }
      }
    }
    if (typeof window.showToast === 'function') window.showToast(`已创建分支：${forkConv.title}`, 'success', 4000);
  }

  async function clearContext(ag) {
    if (!ag) return;
    if (ag.running) {
      if (typeof window.showToast === 'function') window.showToast('Agent 正在运行，请先停止再清空上下文', 'warn', 3500);
      return;
    }
    if (typeof ag.clearContextOnly === 'function') ag.clearContextOnly();
    if (typeof updateContextProgress === 'function') { try { updateContextProgress(); } catch (_) {} }
    if (typeof window.showToast === 'function') window.showToast('已清空上下文（可见聊天记录保留）', 'success', 3000);
  }

  async function compactContext(ag, focus) {
    if (!ag || typeof ag.compactNow !== 'function') return;
    if (typeof window.showToast === 'function') window.showToast('正在压缩上下文…', 'info', 2000);
    const res = await ag.compactNow(focus);
    if (typeof updateContextProgress === 'function') { try { updateContextProgress(); } catch (_) {} }
    const msg = (res && res.message) ? res.message : '压缩完成';
    if (typeof window.showToast === 'function') {
      window.showToast(msg, (res && res.ok && !res.skipped) ? 'success' : 'info', 4500);
    }
  }

  function createNewSessionForMode(mode) {
    if (typeof createNewSession === 'function') {
      createNewSession(mode);
    } else if (typeof window.showToast === 'function') {
      window.showToast('无法新建会话', 'error', 3000);
    }
  }

  function openSettingsTab(tabId) {
    const valid = SETTINGS_TABS.some(([id]) => id === tabId);
    const target = valid ? tabId : null;
    document.querySelector('.nav-item[data-page="settings"]')?.click();
    if (!target) return;
    const started = Date.now();
    const tryTab = () => {
      const page = document.getElementById('page-settings');
      const tab = document.querySelector(`.settings-tab[data-tab="${target}"]`);
      if (tab && page && page.classList.contains('active')) {
        tab.click();
      } else if (Date.now() - started < 4000) {
        setTimeout(tryTab, 80);
      }
    };
    setTimeout(tryTab, 120);
  }

  async function exportConversation(ag, format) {
    if (!ag) return;
    // 复用 Chat 历史导出实现：原生保存对话框 + 一致 JSON/Markdown 格式
    const conv = {
      title: ag.conversationTitle || '未命名对话',
      createdAt: ag.sessionStartTime || Date.now(),
      updatedAt: Date.now(),
      workspacePath: ag.codeWorkspacePath || ag.workspacePath || '',
      mode: ag.mode || 'chat',
      messages: (ag.contextManager && typeof ag.contextManager.getHistoryMessages === 'function')
        ? ag.contextManager.getHistoryMessages() : []
    };
    await exportConversationToFile(conv, format === 'json' ? 'json' : 'md');
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

  // 窗口尺寸变化 / 滚动时重定位
  window.addEventListener('resize', () => { if (panelInput && panel && panel.style.display !== 'none') positionPanel(panelInput); });
  document.addEventListener('scroll', () => {
    if (panelInput && panel && panel.style.display !== 'none') positionPanel(panelInput);
  }, true);

  // 页面/模式切换时强制关闭面板：彻底避免面板残留在其他标签页上方遮挡点击
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => closePanel());
  });
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => closePanel());
  });

  // 启动时同步各输入框的极简徽标（此时 DOM 已解析，part 01 已初始化主 Agent）
  syncBadges();
  // 会话激活时同步徽标（新会话 Agent 可能替换）
  if (typeof window.AppBus !== 'undefined' && window.AppBus && window.AppBus.addEventListener) {
    window.AppBus.addEventListener('session-activated', () => syncBadges());
    window.AppBus.addEventListener('session-deactivated', () => syncBadges());
  }
  window._cmdPaletteRefreshBadges = syncBadges;
})();
