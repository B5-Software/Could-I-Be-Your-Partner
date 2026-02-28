/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Main Application Controller
(async function () {
  // Wait for KaTeX to load
  let waitCount = 0;
  while (!window.katex && waitCount < 50) {
    await new Promise(r => setTimeout(r, 100));
    waitCount++;
  }

  // Init theme
  await ThemeManager.init();

  // Helper: push current theme CSS vars to web control
  function pushThemeToWebControl() {
    // Use getComputedStyle so CSS-file defaults are read even when no inline style is set
    const style = getComputedStyle(document.documentElement);
    const vars = {
      accent: style.getPropertyValue('--accent').trim(),
      accentLight: style.getPropertyValue('--accent-light').trim(),
      accentDark: style.getPropertyValue('--accent-dark').trim(),
      accentBg: style.getPropertyValue('--accent-bg').trim(),
      bgPrimary: style.getPropertyValue('--bg-primary').trim(),
      bgSecondary: style.getPropertyValue('--bg-secondary').trim(),
      bgTertiary: style.getPropertyValue('--bg-tertiary').trim(),
      bgHover: style.getPropertyValue('--bg-hover').trim(),
      isDark: document.documentElement.getAttribute('data-theme') === 'dark',
    };
    window.api.webControlPushTheme(vars);
  }

  function makeAvatarHTML(avatarData, isAI, style) {
    const sz = style || 'width:100%;height:100%;border-radius:50%;object-fit:cover';
    if (avatarData) {
      const src = avatarData.startsWith('data:') ? avatarData : 'file://' + avatarData.replace(/\\/g, '/');
      return `<img src="${src}" style="${sz}" alt="">`;
    }
    return isAI ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-user"></i>';
  }

  async function pushAvatarsToWeb() {
    const s = await window.api.getSettings();
    window.api.webControlSetAvatars({ ai: s.aiPersona?.avatar || '', user: s.userProfile?.avatar || '' });
  }

  // Intercept ThemeManager.apply so every theme change is auto-pushed
  const _origApply = ThemeManager.apply.bind(ThemeManager);
  ThemeManager.apply = function(theme) {
    _origApply(theme);
    // Defer slightly to allow applyThemeMode (which sets data-theme) to settle
    setTimeout(pushThemeToWebControl, 50);
  };
  // Push initial theme (ThemeManager.init already ran with the original apply)
  setTimeout(pushThemeToWebControl, 200);
  setTimeout(pushAvatarsToWeb, 250);

  // Sync app version from package metadata (main process)
  async function syncAboutVersion() {
    const el = document.getElementById('about-version');
    if (!el) return;
    try {
      const version = await window.api.getAppVersion();
      el.textContent = `v${version || '-'}`;
    } catch {
      // keep fallback text
    }
  }
  syncAboutVersion();

  function syncBuiltinToolCount() {
    const el = document.getElementById('about-builtins-count');
    if (!el) return;
    const count = Array.isArray(TOOL_DEFINITIONS) ? TOOL_DEFINITIONS.length : 0;
    el.textContent = `${count}个内置工具`;
  }
  syncBuiltinToolCount();

  // Init agent
  const agent = new Agent();

  // ---- IPC Dialog Listeners ----
  // 监听main进程的确认对话框请求
  window.api.onShowConfirmDialog(async (message) => {
    try {
      const result = await window.confirmDialog(message, '敏感操作确认');
      window.api.sendConfirmDialogResponse(result);
    } catch (e) {
      window.api.sendConfirmDialogResponse(false);
    }
  });

  // DOM Elements
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  const btnNewChat = document.getElementById('btn-new-chat');
  const btnClearChat = document.getElementById('btn-clear-chat');
  const agentStatus = document.getElementById('agent-status');
  const agentTarot = document.getElementById('agent-tarot');
  const todoPanel = document.getElementById('todo-panel');
  const todoList = document.getElementById('todo-list');
  const todoInput = document.getElementById('todo-input');
  const approvalPanel = document.getElementById('approval-panel');
  const approvalContent = document.getElementById('approval-content');
  const btnStop = document.getElementById('btn-stop');
  const btnAttachFile = document.getElementById('btn-attach-file');
  const btnCamera = document.getElementById('btn-camera');
  const btnReoptimizeTools = document.getElementById('btn-reoptimize-tools');
  const btnOpenWorkspace = document.getElementById('btn-open-workspace');
  const attachmentsPreview = document.getElementById('attachments-preview');
  const imagePreviewModal = document.getElementById('image-preview-modal');
  const cameraModal = document.getElementById('camera-modal');

  function setTitlebarTitle(title) {
    const titleEl = document.getElementById('titlebar-title');
    if (titleEl) titleEl.textContent = title || '未命名对话';
  }

  // Attachment state
  let currentAttachments = [];

  // ---- Window Controls ----
  document.getElementById('btn-minimize')?.addEventListener('click', () => window.api.windowMinimize());
  document.getElementById('btn-maximize')?.addEventListener('click', () => window.api.windowMaximize());
  document.getElementById('btn-close')?.addEventListener('click', () => window.api.windowClose());

  // ---- Title Editing ----
  const titlebarTitle = document.getElementById('titlebar-title');
  const titlebarEdit = document.getElementById('titlebar-title-edit');
  
  titlebarTitle?.addEventListener('click', () => {
    titlebarTitle.classList.add('hidden');
    titlebarEdit.classList.remove('hidden');
    titlebarEdit.value = agent.conversationTitle || '未命名对话';
    titlebarEdit.focus();
    titlebarEdit.select();
  });

  titlebarEdit?.addEventListener('blur', async () => {
    const newTitle = titlebarEdit.value.trim() || '未命名对话';
    agent.conversationTitle = newTitle;
    setTitlebarTitle(newTitle);
    titlebarEdit.classList.add('hidden');
    titlebarTitle.classList.remove('hidden');
    // Save to history if conversation exists
    if (agent.conversationId) {
      await window.api.historyRename(agent.conversationId, newTitle);
    }
  });

  titlebarEdit?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      titlebarEdit.blur();
    } else if (e.key === 'Escape') {
      titlebarEdit.classList.add('hidden');
      titlebarTitle.classList.remove('hidden');
    }
  });

  // ---- Markdown Renderer with Math Support ----
  function renderMarkdown(text) {
    if (!text) return '';
    let html = text;
    
    // Protect code blocks and math first
    const codeBlocks = [];
    const mathBlocks = [];
    const inlineMath = [];
    const tables = [];
    
    // Extract tables (before other processing)
    html = html.replace(/(\n|^)(\|.+\|)\n(\|[-:\s|]+\|)\n((?:\|.+\|\n?)*)/gm, (match, prefix, header, separator, rows) => {
      const tableData = {
        header: header.trim().split('|').filter(c => c.trim()).map(c => c.trim()),
        rows: rows.trim().split('\n').map(row => 
          row.split('|').filter(c => c.trim()).map(c => c.trim())
        )
      };
      tables.push(tableData);
      return `${prefix}__TABLE${tables.length - 1}__`;
    });
    
    // Extract display math ($$...$$)
    html = html.replace(/\$\$([\s\S]*?)\$\$/g, (m, math) => {
      mathBlocks.push(math);
      return `__MATHBLOCK${mathBlocks.length - 1}__`;
    });
    
    // Extract inline math ($...$)
    html = html.replace(/\$([^$\n]+?)\$/g, (m, math) => {
      inlineMath.push(math);
      return `__INLINEMATH${inlineMath.length - 1}__`;
    });
    
    // Extract code blocks
    html = html.replace(/```([^\n]*)\n([\s\S]*?)```/g, (m, lang, code) => {
      codeBlocks.push({ lang: (lang || '').trim(), code });
      return `__CODEBLOCK${codeBlocks.length - 1}__`;
    });

    // Escape HTML before inline formatting
    html = escapeHtml(html);
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Horizontal rule
    html = html.replace(/^---$/gm, '<hr>');
    // Blockquote
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    // Unordered list
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    // Ordered list
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2" data-external="true">$1</a>');

    // Line breaks before restoring blocks to avoid corrupting KaTeX markup
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    
    // Restore tables
    html = html.replace(/__TABLE(\d+)__/g, (m, i) => {
      const table = tables[parseInt(i)];
      let tableHtml = '<div class="table-wrapper" style="overflow-x:auto;margin:12px 0;"><table class="markdown-table" style="border-collapse:collapse;width:100%;max-width:100%;">';
      tableHtml += '<thead><tr>';
      table.header.forEach(cell => {
        tableHtml += `<th style="border:1px solid var(--border-color);padding:8px;background:var(--bg-secondary);text-align:left;font-weight:600;">${escapeHtml(cell)}</th>`;
      });
      tableHtml += '</tr></thead><tbody>';
      table.rows.forEach(row => {
        if (row.length > 0) {
          tableHtml += '<tr>';
          row.forEach(cell => {
            tableHtml += `<td style="border:1px solid var(--border-color);padding:8px;">${escapeHtml(cell)}</td>`;
          });
          tableHtml += '</tr>';
        }
      });
      tableHtml += '</tbody></table></div>';
      return tableHtml;
    });
    
    // Restore code blocks
    html = html.replace(/__CODEBLOCK(\d+)__/g, (m, i) => {
      const { lang, code } = codeBlocks[parseInt(i)];
      return `<pre><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre>`;
    });
    
    // Restore math blocks
    html = html.replace(/__MATHBLOCK(\d+)__/g, (m, i) => {
      const math = mathBlocks[parseInt(i)];
      try {
        if (window.katex) {
          return `<div class="math-block">${window.katex.renderToString(math, { displayMode: true, throwOnError: false })}</div>`;
        }
      } catch {}
      return `<div class="math-block">$$${escapeHtml(math)}$$</div>`;
    });
    
    // Restore inline math
    html = html.replace(/__INLINEMATH(\d+)__/g, (m, i) => {
      const math = inlineMath[parseInt(i)];
      try {
        if (window.katex) {
          return `<span class="math-inline">${window.katex.renderToString(math, { displayMode: false, throwOnError: false })}</span>`;
        }
      } catch {}
      return `<span class="math-inline">$${escapeHtml(math)}$</span>`;
    });
    // Wrap in paragraph if not already structured
    if (!html.startsWith('<')) html = '<p>' + html + '</p>';
    return html;
  }

  // Handle external links - open in system browser
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-external]');
    if (link) {
      e.preventDefault();
      const url = link.getAttribute('href');
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        window.api.openBrowser(url);
      }
    }
  });

  // ---- Page Navigation ----
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const page = document.getElementById(`page-${btn.dataset.page}`);
      if (page) page.classList.add('active');

      // Load page data
      if (btn.dataset.page === 'tools') loadToolsPage();
      if (btn.dataset.page === 'skills') loadSkillsPage();
      if (btn.dataset.page === 'knowledge') loadKnowledgePage();
      if (btn.dataset.page === 'memory') loadMemoryPage();
      if (btn.dataset.page === 'settings') loadSettingsPage();
      if (btn.dataset.page === 'history') loadHistoryPage();
    });
  });

  // ---- Agent Callbacks ----
  agent.onMessage = (type, data) => {
    switch (type) {
      case 'tarot':
        if (data && agentTarot) {
          const iconHtml = data.icon ? `<i class="fa-solid ${data.icon}"></i>` : '<i class="fa-solid fa-star"></i>';
          const position = data.isReversed ? '逆位' : '正位';
          const meaning = data.isReversed ? data.meaningOfReversed : data.meaningOfUpright;
          const eSource = data.entropySource || 'CSPRNG';
          const isTRNG = eSource.startsWith('TRNG');
          const trngBadge = isTRNG ? '<span class="trng-badge" style="margin-left:6px;font-size:9px;padding:1px 6px"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>' : '';
          agentTarot.innerHTML = `${iconHtml}<span>命运之牌：${data.name}(${position})</span>${trngBadge}`;
          agentTarot.title = `${data.name}(${position}) - ${meaning || ''} [${eSource}]`;
          // Add system message for tarot card
          const entropyNote = isTRNG ? ' [TRNG 硬件真随机]' : '';
          addSystemMessage(`抽取了命运之牌：${data.name}${data.isReversed ? '(逆位)' : '(正位)'}（${data.nameEn}）${entropyNote}\n${meaning || ''}`);
          // Push tarot to web control
          window.api.webControlPushTarot(data);
        }
        break;
      case 'assistant':
        addMessageToChat('assistant', data);
        window.api.webControlPushMessage('assistant', data);
        break;
      case 'error':
        addMessageToChat('assistant', `[错误] ${data}`);
        window.api.webControlPushMessage('system', `[错误] ${data}`);
        break;
      case 'optimize-tools-start':
        addThinkingIndicatorWithText('正在优化工具选择...');
        break;
      case 'optimize-tools-end':
        if (agent.running) {
          addThinkingIndicator();
        } else {
          removeThinkingIndicator();
        }
        updateReoptimizeButtonVisibility();
        if (document.getElementById('page-tools')?.classList.contains('active')) {
          loadToolsPage();
        }
        break;
      case 'approval':
        showApprovalPanel(data.toolName, data.args);
        window.api.webControlPushApproval(data.toolName, data.args);
        break;
      case 'sub-agent-start': {
        const eTag = data.tarot?.entropySource?.startsWith('TRNG') ? ' [TRNG]' : '';
        addSubAgentMessage(`子代理启动 - 命运之牌: ${data.tarot.name}${data.tarot.isReversed ? '(逆位)' : '(正位)'}${eTag}`, `任务: ${data.task}`);
        break;
      }
      case 'sub-agent-done':
        addSubAgentMessage('子代理完成', data.result);
        break;
    }
    updateContextProgress();
  };

  agent.onTitleChange = (title) => {
    setTitlebarTitle(title);
    window.api.webControlPushTitle(title);
  };

  agent.onStatusChange = (status) => {
    if (status === 'working') {
      agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 工作中...';
      agentStatus.className = 'agent-status working';
      if (btnStop) btnStop.classList.remove('hidden');
      // 热对话：工作时发送按钮保持可见
    } else {
      agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 待命中';
      agentStatus.className = 'agent-status';
      if (btnStop) btnStop.classList.add('hidden');
      btnSend.classList.remove('hidden');
    }
    window.api.webControlPushStatus(status);
  };

  agent.onToolCall = (name, args, status, result) => {
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === name);
    const displayName = toolDef?.desc || name;

    if (status === 'calling') {
      addToolCallToChat(displayName, name, args);
    } else if (status === 'done') {
      updateToolCallResult(name, result);
      updateContextProgress();
      // If generateImage returned a URL/base64, display image directly
      if (name === 'generateImage' && result?.ok && result?.url) {
        addImageMessage(result.url);
      }
    } else if (status === 'denied') {
      updateToolCallResult(name, { ok: false, error: '用户拒绝了操作' }, true);
      updateContextProgress();
    }
    window.api.webControlPushToolCall(name, args, status, typeof result === 'string' ? result : JSON.stringify(result || ''));
  };

  agent.onTodoUpdate = (items) => {
    renderTodoList(items);
  };

  await agent.init();
  await normalizeToolSettings();
  setTitlebarTitle(agent.conversationTitle || '未命名对话');
  updateReoptimizeButtonVisibility();
  updateContextProgress();

  function updateReoptimizeButtonVisibility() {
    if (!btnReoptimizeTools) return;
    const visible = !!agent.settings?.autoOptimizeToolSelection
      && (typeof agent.hasUsableOptimizedSelection === 'function'
        ? agent.hasUsableOptimizedSelection()
        : (Array.isArray(agent.optimizedToolNames) && agent.optimizedToolNames.length > 0));
    btnReoptimizeTools.classList.toggle('hidden', !visible);
  }

  // 更新上下文进度条函数
  function updateContextProgress() {
    const stats = agent.contextManager.getStats ? agent.contextManager.getStats() : null;
    const cm = agent.contextManager;
    const progressFill = document.getElementById('context-progress-fill');
    const progressText = document.getElementById('context-progress-text');
    if (progressFill && progressText) {
      const estimateMsg = (msg) => (cm?.estimateMessageTokens ? cm.estimateMessageTokens(msg) : 0);
      const estimateText = (text) => (cm?.estimateTokens ? cm.estimateTokens(text) : 0);
      const systemGuidanceTokens = cm?.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
      const toolDefsTokens = Math.ceil(JSON.stringify(
        (typeof agent.getRuntimeToolSchemas === 'function')
          ? agent.getRuntimeToolSchemas()
          : getToolSchemas(agent.settings?.tools || {})
      ).length / 4);

      let chatTokens = 0;
      let toolResultTokens = 0;
      (cm?.messages || []).forEach(msg => {
        if (!msg) return;
        if (msg.role === 'tool') {
          toolResultTokens += estimateMsg(msg);
        } else if (msg.role === 'user' || msg.role === 'assistant') {
          chatTokens += estimateMsg(msg);
        }
      });

      const summaryTokens = (cm?.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
      const otherTokens = Math.max(0, summaryTokens);
      const tokens = systemGuidanceTokens + toolDefsTokens + chatTokens + toolResultTokens + otherTokens;
      const maxTokens = stats?.maxTokens ?? (agent.settings?.llm?.maxContextLength || 0);
      const percentage = maxTokens ? Math.min(100, (tokens / maxTokens) * 100) : 0;
      progressFill.style.width = percentage + '%';
      progressText.textContent = `${tokens}/${maxTokens}`;

      const detail = [
        `上下文使用: ${tokens}/${maxTokens} (${percentage.toFixed(1)}%)`,
        `系统指导: ${systemGuidanceTokens} tokens`,
        `工具定义: ${toolDefsTokens} tokens`,
        `聊天记录: ${chatTokens} tokens`,
        `工具结果: ${toolResultTokens} tokens`,
        `其他: ${otherTokens} tokens`
      ].join('\n');
      progressFill.title = detail;
      progressText.title = detail;
    }
  }

  // 定时更新进度条
  setInterval(updateContextProgress, 1000);

  btnReoptimizeTools?.addEventListener('click', async () => {
    if (!agent.settings?.autoOptimizeToolSelection) return;
    const seed = chatInput.value.trim() || (typeof agent.getLatestUserMessageText === 'function' ? agent.getLatestUserMessageText() : '') || '手动触发工具重优化';
    await agent.optimizeToolsForConversation(seed, '用户手动点击“重新优化工具选择”');
    updateReoptimizeButtonVisibility();
    if (document.getElementById('page-tools')?.classList.contains('active')) {
      loadToolsPage();
    }
  });

  // ---- Web Control Incoming Events ----
  window.api.onWebControlNewChat(() => {
    agent.newConversation();
    setTitlebarTitle('未命名对话');
    chatMessages.innerHTML = '';
    updateReoptimizeButtonVisibility();
    window.api.webControlPushConversationSwitch(null);
  });

  window.api.onWebControlSendMessage(async (message) => {
    if (agent.running && !agent.stopped) {
      // Use hot message queue if agent is working
      agent.hotMessages.push(message);
      addMessageToChat('user', message);
      window.api.webControlPushMessage('user', message);
      return;
    }
    addMessageToChat('user', message);
    window.api.webControlPushMessage('user', message, { source: 'web' });
    agent._fromWeb = true;
    await agent.sendMessage(message);
    agent._fromWeb = false;
  });

  window.api.onWebControlStopAgent(() => {
    agent.stopped = true;
    agent.running = false;
  });

  window.api.onWebControlApprovalResponse((approved) => {
    agent.resolveApproval(approved);
    window.api.webControlClearApproval();
  });

  window.api.onWebControlLoadConversation(async (id) => {
    try {
      const conv = await window.api.historyGet(id);
      if (!conv) return;
      await agent.loadFromHistory(conv);
      setTitlebarTitle(agent.conversationTitle || '未命名对话');
      updateContextProgress();
      // Switch to chat page
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-chat')?.classList.add('active');
      // Replay messages in local UI
      chatMessages.innerHTML = '';
      const toolCallMap = {};
      for (const msg of (conv.messages || [])) {
        if (msg.role === 'user') {
          addMessageToChat('user', msg.content);
        } else if (msg.role === 'assistant') {
          if (msg.content) addMessageToChat('assistant', msg.content);
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              const toolName = tc.function?.name || 'tool';
              let args = {};
              try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
              const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
              addToolCallToChat(toolDef?.desc || toolName, toolName, args);
              if (tc.id) toolCallMap[tc.id] = toolName;
            }
          }
        } else if (msg.role === 'tool') {
          const toolName = msg.name || toolCallMap[msg.tool_call_id] || 'tool';
          let result = msg.content;
          try { result = JSON.parse(msg.content); } catch {}
          updateToolCallResult(toolName, result);
        }
      }
      // Sync to web control — include tool_calls and tool results so they render properly
      const webMsgs = [];
      for (const m of (conv.messages || [])) {
        if (m.role === 'user') {
          webMsgs.push({ role: 'user', content: m.content || '', timestamp: m.timestamp || Date.now() });
        } else if (m.role === 'assistant') {
          webMsgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls || null, timestamp: m.timestamp || Date.now() });
        } else if (m.role === 'tool') {
          webMsgs.push({ role: 'tool', content: m.content || '', name: m.name || '', tool_call_id: m.tool_call_id || '', timestamp: m.timestamp || Date.now() });
        }
      }
      window.api.webControlPushConversationSwitch(id);
      window.api.webControlPushHistoryMessages(webMsgs);
      window.api.webControlPushTitle(agent.conversationTitle || '未命名对话');
    } catch (e) {
      console.error('[App] onWebControlLoadConversation error:', e.message);
    }
  });

  window.api.onGameFinished((data) => {
    if (!data) return;
    const gameNames = { flyingflower: '飞花令', sanguosha: '三国杀', undercover: '谁是卧底' };
    const gameName = gameNames[data.game] || data.game;
    const resultText = `《${gameName}》游戏结束: ${data.result}`;
    addSystemMessage(resultText);
    window.api.webControlPushMessage('system', resultText);
  });

  // ---- Chat Functions ----
  function scrollChatToBottom() {
    const target = document.getElementById('thinking-indicator') || chatMessages.lastElementChild;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
        chatMessages.scrollTop = chatMessages.scrollHeight;
      });
    });
  }

  function appendChatElement(el) {
    const thinking = document.getElementById('thinking-indicator');
    if (thinking) {
      chatMessages.insertBefore(el, thinking);
    } else {
      chatMessages.appendChild(el);
    }
    scrollChatToBottom();
  }

  async function normalizeToolSettings() {
    if (!agent.settings) return;
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    if (typeof agent.settings.autoOptimizeToolSelection !== 'boolean') {
      agent.settings.autoOptimizeToolSelection = false;
    }
    const toolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
    let changed = false;

    TOOL_DEFINITIONS.forEach(tool => {
      if (agent.settings.tools[tool.name] === undefined) {
        agent.settings.tools[tool.name] = true;
        changed = true;
      }
    });

    Object.keys(agent.settings.tools).forEach(name => {
      if (!toolNames.has(name)) {
        delete agent.settings.tools[name];
        changed = true;
      }
    });

    if (changed) {
      await window.api.setSettings(agent.settings);
      agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    }
  }

  function addMessageToChat(role, content) {
    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    
    // Avatar handling
    let avatarHTML = '';
    if (role === 'user') {
      avatarHTML = makeAvatarHTML(agent.settings?.userProfile?.avatar, false);
    } else {
      avatarHTML = makeAvatarHTML(agent.settings?.aiPersona?.avatar, true);
    }
    
    const rendered = role === 'assistant' ? renderMarkdown(content) : escapeHtml(content);
    const bodyClass = role === 'assistant' ? 'message-content markdown-body' : 'message-content';
    msg.innerHTML = `
      <div class="message-avatar">${avatarHTML}</div>
      <div class="message-body">
        <div class="${bodyClass}">${rendered}</div>
        <div class="message-time">${time}</div>
      </div>`;
    appendChatElement(msg);
    
    // Add right-click context menu for deletion
    msg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(e, msg, role);
    });
  }

  function addImageMessage(imageUrl) {
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    
    // AI avatar
    const avatarHTML = makeAvatarHTML(agent.settings?.aiPersona?.avatar, true);
    
    const imgId = 'img-' + Date.now();
    msg.innerHTML = `
      <div class="message-avatar">${avatarHTML}</div>
      <div class="message-body">
        <div class="message-content">
          <img id="${imgId}" src="${imageUrl}" style="max-width:400px;max-height:400px;border-radius:8px;cursor:pointer;display:block"/>
        </div>
        <div class="message-time">${time}</div>
      </div>`;
    
    appendChatElement(msg);
    
    // 添加点击放大功能
    const imgEl = document.getElementById(imgId);
    if (imgEl) {
      imgEl.addEventListener('click', () => openImageModal(imageUrl));
      
      // 添加右键菜单
      imgEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showImageContextMenu(e, imageUrl);
      });
    }
    
    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      msg.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  // 显示图片右键菜单
  function showImageContextMenu(e, imageUrl) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.image-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'image-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${e.clientX}px;
      top: ${e.clientY}px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
      z-index: 10000;
      min-width: 120px;
    `;

    const menuItems = [
      {
        icon: 'fa-copy',
        label: '复制图片',
        action: async () => {
          try {
            // 读取图片文件为blob
            const response = await fetch(imageUrl);
            const blob = await response.blob();
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type]: blob })
            ]);
            addSystemMessage('图片已复制到剪贴板');
          } catch (err) {
            addSystemMessage(`复制失败: ${err.message}`);
          }
        }
      },
      {
        icon: 'fa-floppy-disk',
        label: '另存为',
        action: async () => {
          try {
            const sourcePath = imageUrl.replace(/^file:\/\/\/?/, '');
            const fileName = sourcePath.split(/[\\/]/).pop() || 'image.png';
            const result = await window.api.saveFileDialog({
              title: '保存图片',
              defaultPath: fileName,
              filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
            });
            if (result.ok && result.path) {
              await window.api.copyFile(sourcePath, result.path);
              addSystemMessage(`图片已保存到: ${result.path}`);
            }
          } catch (err) {
            addSystemMessage(`保存失败: ${err.message}`);
          }
        }
      }
    ];

    menuItems.forEach(item => {
      const menuItem = document.createElement('div');
      menuItem.style.cssText = `
        padding: 8px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        transition: background 0.2s;
      `;
      menuItem.innerHTML = `<i class="fa-solid ${item.icon}" style="width:16px"></i><span>${item.label}</span>`;
      
      menuItem.addEventListener('mouseenter', () => {
        menuItem.style.background = 'var(--bg-hover)';
      });
      menuItem.addEventListener('mouseleave', () => {
        menuItem.style.background = 'transparent';
      });
      menuItem.addEventListener('click', () => {
        item.action();
        menu.remove();
      });
      
      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    // 点击其他地方关闭菜单
    const closeMenu = (evt) => {
      if (!menu.contains(evt.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  }
  
  // 显示消息右键菜单
  function showMessageContextMenu(e, messageElement, role) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.message-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${e.clientX}px;
      top: ${e.clientY}px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
      z-index: 10000;
      min-width: 160px;
    `;

    const menuItem = document.createElement('div');
    menuItem.style.cssText = `
      padding: 8px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #e74c3c;
    `;
    menuItem.innerHTML = `<i class="fa-solid fa-trash"></i><span>删除对话</span>`;
    
    menuItem.addEventListener('mouseenter', () => {
      menuItem.style.backgroundColor = 'var(--bg-hover)';
    });
    menuItem.addEventListener('mouseleave', () => {
      menuItem.style.backgroundColor = 'transparent';
    });
    
    menuItem.addEventListener('click', async () => {
      menu.remove();
      
      // 查找完整的对话轮次：user -> (system/tool-call)* -> assistant
      const allElements = Array.from(chatMessages.children);
      const currentIndex = allElements.indexOf(messageElement);
      
      if (currentIndex === -1) return;
      
      let userMsg = null;
      let assistantMsg = null;
      const middleElements = []; // system messages and tool calls
      
      if (role === 'user') {
        // 从 user 开始，向后找 assistant
        userMsg = messageElement;
        for (let i = currentIndex + 1; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.classList.contains('assistant')) {
            assistantMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.push(el);
          } else if (el.classList.contains('user')) {
            // 遇到下一个 user，停止
            break;
          }
        }
      } else if (role === 'assistant') {
        // 从 assistant 开始，向前找 user
        assistantMsg = messageElement;
        for (let i = currentIndex - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el.classList.contains('user')) {
            userMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.unshift(el);
          } else if (el.classList.contains('assistant')) {
            // 遇到上一个 assistant，停止
            break;
          }
        }
      } else {
        // 从 system/tool-call 开始，找前后的 user 和 assistant
        // 向前找 user
        for (let i = currentIndex - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el.classList.contains('user')) {
            userMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.unshift(el);
          } else if (el.classList.contains('assistant')) {
            break;
          }
        }
        // 向后找 assistant
        middleElements.push(messageElement); // 当前元素
        for (let i = currentIndex + 1; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.classList.contains('assistant')) {
            assistantMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.push(el);
          } else if (el.classList.contains('user')) {
            break;
          }
        }
      }

      if (!userMsg && !assistantMsg) return;

      const pending = [];
      if (userMsg) pending.push(userMsg);
      pending.push(...middleElements);
      if (assistantMsg) pending.push(assistantMsg);

      pending.forEach(el => el.classList.add('pending-delete'));

      // Confirm deletion
      const confirmed = await window.confirmDialog(
        `确定要删除这轮对话吗？\n${userMsg ? '包括用户消息' : ''}${middleElements.length > 0 ? '、工具调用' : ''}${userMsg && assistantMsg ? '和' : ''}${assistantMsg ? 'AI回复' : ''}`,
        '删除对话'
      );

      if (confirmed) {
        pending.forEach(el => el.remove());
      } else {
        pending.forEach(el => el.classList.remove('pending-delete'));
      }
    });

    menu.appendChild(menuItem);
    document.body.appendChild(menu);

    const closeMenu = () => {
      if (menu && menu.parentNode) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  }

  function openImageModal(src) {
    const img = document.getElementById('image-preview-img');
    if (img) {
      img.src = src;
      img.alt = '预览';
    }
    imagePreviewModal.classList.remove('hidden');
  }

  function addToolCallToChat(displayName, toolName, args) {
    const el = document.createElement('div');
    el.className = 'tool-call';
    el.id = `tool-${toolName}-${Date.now()}`;
    el.dataset.toolName = toolName;
    const argsStr = Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.substring(0, 100) : JSON.stringify(v)}`).join('\n');
    el.innerHTML = `
      <div class="tool-call-header">
        <i class="fa-solid fa-gear fa-spin"></i>
        <span>调用工具: ${escapeHtml(displayName)}</span>
        <span class="trng-badge" style="display:none"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>
      </div>
      ${argsStr ? `<div class="tool-call-args">${escapeHtml(argsStr)}</div>` : ''}
      <div class="tool-call-result" style="display:none"></div>`;
    appendChatElement(el);
    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  function updateToolCallResult(toolName, result, isError = false) {
    const els = chatMessages.querySelectorAll(`[data-tool-name="${toolName}"]`);
    const el = els[els.length - 1];
    if (!el) return;
    const header = el.querySelector('.tool-call-header i');
    const isFailure = isError || result?.ok === false;
    if (header) { header.className = `fa-solid ${isFailure ? 'fa-xmark' : 'fa-check'}`; }
    // Show TRNG badge if applicable
    if (result?.entropySource && result.entropySource.startsWith('TRNG')) {
      const badge = el.querySelector('.trng-badge');
      if (badge) badge.style.display = 'inline-flex';
    }
    const resultEl = el.querySelector('.tool-call-result');
    if (resultEl) {
      resultEl.style.display = 'block';
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      resultEl.textContent = text.substring(0, 500);
      if (isFailure) resultEl.classList.add('error');
    }
  }

  function addSubAgentMessage(title, content) {
    const el = document.createElement('div');
    el.className = 'sub-agent-msg';
    el.innerHTML = `
      <div class="sub-agent-label"><i class="fa-solid fa-users"></i> ${escapeHtml(title)}</div>
      <div class="message-content">${escapeHtml(content)}</div>`;
    appendChatElement(el);
    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  function addSystemMessage(content) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `
      <div class="system-icon"><i class="fa-solid fa-info-circle"></i></div>
      <div class="system-content">${escapeHtml(content)}</div>`;
    appendChatElement(el);
    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  // ---- Game Invitation Card ----
  const GAME_META = {
    flyingFlower: { name: '飞花令', icon: 'fa-feather', desc: '经典诗词接龙游戏，各方轮流说出含有指定字的诗句', defaultAgents: 2 },
    sanguosha: { name: '三国杀', icon: 'fa-khanda', desc: '经典卡牌对战游戏，选择武将、出牌博弈', defaultAgents: 3 },
    undercover: { name: '谁是卧底', icon: 'fa-user-secret', desc: '经典社交推理游戏，通过描述找出卧底', defaultAgents: 4 },
  };

  window.showGameInvitation = function(game, message, suggestedAgents) {
    return new Promise((resolve) => {
      const meta = GAME_META[game] || { name: game, icon: 'fa-gamepad', desc: '', defaultAgents: 2 };
      const numAgents = suggestedAgents || meta.defaultAgents;
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      // Wrap inside AI message bubble (like askQuestions)
      const msg = document.createElement('div');
      msg.className = 'message assistant';

      const avatarHTML = makeAvatarHTML(agent.settings?.aiPersona?.avatar, true);

      const body = document.createElement('div');
      body.className = 'message-body';

      const card = document.createElement('div');
      card.className = 'game-invite-card';
      card.innerHTML = `
        <div class="game-invite-header">
          <div class="game-invite-icon"><i class="fa-solid ${meta.icon}"></i></div>
          <div class="game-invite-info">
            <h4>${escapeHtml(meta.name)}</h4>
            <p>${escapeHtml(meta.desc)}</p>
          </div>
        </div>
        ${message ? `<div class="game-invite-msg">${escapeHtml(message)}</div>` : ''}
        <div class="game-invite-agents">
          <label>参与 Agent 数量：</label>
          <input type="number" min="1" max="8" value="${numAgents}" class="agent-count-input" />
        </div>
        <div class="game-invite-actions">
          <button class="btn-game-ignore">忽略</button>
          <button class="btn-game-accept"><i class="fa-solid fa-play"></i> 开始游戏</button>
        </div>`;

      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = time;

      body.appendChild(card);
      body.appendChild(timeEl);

      msg.innerHTML = `<div class="message-avatar">${avatarHTML}</div>`;
      msg.appendChild(body);

      const btnAccept = card.querySelector('.btn-game-accept');
      const btnIgnore = card.querySelector('.btn-game-ignore');
      const agentInput = card.querySelector('.agent-count-input');

      btnAccept.addEventListener('click', () => {
        const count = parseInt(agentInput.value) || numAgents;
        card.classList.add('accepted');
        btnAccept.textContent = '已接受';
        btnAccept.disabled = true;
        btnIgnore.disabled = true;
        agentInput.disabled = true;
        resolve({ accepted: true, game, agentCount: count });
      });

      btnIgnore.addEventListener('click', () => {
        card.classList.add('ignored');
        btnAccept.disabled = true;
        btnIgnore.disabled = true;
        agentInput.disabled = true;
        resolve({ accepted: false, game, agentCount: 0 });
      });

      appendChatElement(msg);

      // Add right-click deletion support (counts as that turn's AI message)
      msg.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMessageContextMenu(e, msg, 'assistant');
      });

      requestAnimationFrame(() => msg.scrollIntoView({ behavior: 'smooth', block: 'end' }));
    });
  };

  function addThinkingIndicator() {
    addThinkingIndicatorWithText('AI 正在思考...');
  }

  function addThinkingIndicatorWithText(text) {
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div><span>${escapeHtml(text || 'AI 正在思考...')}</span>`;
    chatMessages.appendChild(el);
    scrollChatToBottom();
  }

  function removeThinkingIndicator() {
    const el = document.getElementById('thinking-indicator');
    if (el) el.remove();
    scrollChatToBottom();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function setSendButtons(isWorking) {
    if (isWorking) {
      if (btnStop) btnStop.classList.remove('hidden');
      // 热对话：发送按钮始终可见
    } else {
      if (btnStop) btnStop.classList.add('hidden');
      btnSend.classList.remove('hidden');
    }
  }

  // ---- Send Message ----
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    // 热对话：Agent工作中时注入新消息
    if (agent.running) {
      chatInput.value = '';
      chatInput.style.height = 'auto';

      // Process attachments
      const attachments = [...currentAttachments];
      clearAttachments();

      let displayText = text;
      if (attachments.length > 0) {
        const names = attachments.map(a => a.name).join(', ');
        displayText += `\n[附件: ${names}]`;
      }
      addMessageToChat('user', displayText);

      await copyAttachmentsToWorkspace(attachments);

      // Process attachments: OCR for images, text extraction for documents
      for (const att of attachments) {
        if (att.isImage && att.path) {
          try {
            const ocrResult = await window.api.ocrRecognize(att.path);
            if (ocrResult.ok && ocrResult.text) att.ocrText = ocrResult.text;
          } catch (e) { console.error('OCR error:', e); }
        } else if (att.path) {
          const ext = att.name.split('.').pop().toLowerCase();
          const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
          if (officeFormats.includes(ext)) {
            try {
              const importResult = await window.api.knowledgeImportFile(att.path, agent.workspacePath);
              if (importResult.ok && importResult.content) {
                const workspacePath = agent.workspacePath;
                if (workspacePath) {
                  const textFileName = att.name.replace(/\.\w+$/, '.txt');
                  const textFilePath = `${workspacePath}\\${textFileName}`;
                  const saveResult = await window.api.writeFile(textFilePath, importResult.content);
                  if (saveResult.ok) {
                    att.convertedPath = textFilePath;
                    att.extractedText = `已转换为文本文件：${textFilePath}`;
                  } else {
                    att.extractedText = importResult.content;
                  }
                } else {
                  att.extractedText = importResult.content;
                }
                if (importResult.images && importResult.images.length > 0) {
                  att.extractedImages = importResult.images;
                }
              }
            } catch (e) { console.error('Document extraction error:', e); }
          }
        }
      }

      agent.injectHotMessage(text, attachments);
      return;
    }

    // 正常发送（Agent空闲时）

    // Show stop button immediately
    setSendButtons(true);
    
    // Check daily limits before sending
    const settings = await window.api.getSettings();
    const llmLimit = settings.llm.dailyMaxTokens || 0;
    const llmUsed = settings.llm.dailyTokensUsed || 0;
    if (llmLimit > 0) {
      if (llmUsed >= llmLimit) {
        addSystemMessage(`⚠️ 已达到今日LLM Token上限(${llmLimit})，请明天再试或在设置中重置使用量。`);
        setSendButtons(false);
        return;
      } else if (llmUsed >= llmLimit * 0.9) {
        addSystemMessage(`⚠️ 警告：今日Token已使用${llmUsed}，接近限制${llmLimit}(${((llmUsed/llmLimit)*100).toFixed(1)}%)`);
      }
    }
    
    chatInput.value = '';
    chatInput.style.height = 'auto';

    // Process attachments
    const attachments = [...currentAttachments];
    clearAttachments();

    // Show message with attachment indicators
    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += `\n[附件: ${names}]`;
    }
    addMessageToChat('user', displayText);
    addThinkingIndicator();
    window.api.webControlPushMessage('user', displayText);

    await copyAttachmentsToWorkspace(attachments);

    // Process attachments: OCR for images, text extraction for documents
    for (const att of attachments) {
      if (att.isImage && att.path) {
        // OCR for images
        try {
          const ocrResult = await window.api.ocrRecognize(att.path);
          if (ocrResult.ok && ocrResult.text) {
            att.ocrText = ocrResult.text;
          }
        } catch (e) { console.error('OCR error:', e); }
      } else if (att.path) {
        // Extract text from Office/PDF files
        const ext = att.name.split('.').pop().toLowerCase();
        const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
        if (officeFormats.includes(ext)) {
          try {
            const importResult = await window.api.knowledgeImportFile(att.path, agent.workspacePath);
            if (importResult.ok && importResult.content) {
              // 将转换后的文本保存到工作目录
              const workspacePath = agent.workspacePath;
              if (workspacePath) {
                const textFileName = att.name.replace(/\.\w+$/, '.txt');
                const textFilePath = `${workspacePath}\\${textFileName}`;
                const saveResult = await window.api.writeFile(textFilePath, importResult.content);
                if (saveResult.ok) {
                  att.convertedPath = textFilePath;
                  att.extractedText = `已转换为文本文件：${textFilePath}`;
                } else {
                  att.extractedText = importResult.content;
                }
              } else {
                att.extractedText = importResult.content;
              }
              // 如果有图片，也提取出来
              if (importResult.images && importResult.images.length > 0) {
                att.extractedImages = importResult.images;
              }
            }
          } catch (e) { console.error('Document extraction error:', e); }
        }
      }
    }

    await agent.sendMessage(text, attachments);
    removeThinkingIndicator();
  }

  // ---- Stop Button ----
  if (btnStop) {
    btnStop.addEventListener('click', () => {
      agent.stop();
      removeThinkingIndicator();
    });
  }

  btnSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  // Quick actions
  document.querySelectorAll('.quick-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chatInput.value = btn.dataset.prompt;
      sendMessage();
    });
  });

  // ---- Attachment Handling ----
  function addAttachment(file) {
    const isImage = file.type?.startsWith('image/') || /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(file.name);
    const att = { name: file.name, size: file.size, type: file.type, isImage, path: file.path || null, pendingSave: null };

    // If it's a blob/File without path, save to workspace
    if (!att.path && file.arrayBuffer) {
      att.pendingSave = file.arrayBuffer().then(buf => {
        return window.api.saveUploadedFile(file.name, buf).then(result => {
          if (result.ok) att.path = result.path;
        });
      });
    }

    currentAttachments.push(att);
    renderAttachments();
  }

  async function copyAttachmentsToWorkspace(attachments) {
    const workspacePath = agent.workspacePath;
    if (!workspacePath || !attachments || attachments.length === 0) return;

    const normalizePath = (p) => (p || '').replace(/\//g, '\\');
    const normalizedWorkspace = normalizePath(workspacePath);
    const targetDir = normalizedWorkspace;
    await window.api.makeDirectory(targetDir);

    const pending = attachments.map(att => att.pendingSave).filter(Boolean);
    if (pending.length > 0) {
      await Promise.all(pending);
    }

    for (const att of attachments) {
      if (!att.path) continue;
      const normalizedPath = normalizePath(att.path);
      if (normalizedPath.startsWith(normalizedWorkspace + '\\')) continue;

      const safeName = (att.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
      const destPath = `${targetDir}\\${safeName}`;
      const copyResult = await window.api.copyFile(att.path, destPath);
      if (copyResult.ok) {
        att.originalPath = att.path;
        att.path = destPath;
      }
    }
  }

  function removeAttachment(index) {
    currentAttachments.splice(index, 1);
    renderAttachments();
  }

  function clearAttachments() {
    currentAttachments = [];
    renderAttachments();
  }

  function renderAttachments() {
    if (currentAttachments.length === 0) {
      attachmentsPreview.classList.add('hidden');
      attachmentsPreview.innerHTML = '';
      return;
    }
    attachmentsPreview.classList.remove('hidden');
    attachmentsPreview.innerHTML = currentAttachments.map((att, i) => `
      <div class="attachment-item">
        <i class="fa-solid ${att.isImage ? 'fa-image' : 'fa-file'}"></i>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="btn-icon attachment-remove" data-index="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `).join('');
    attachmentsPreview.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => removeAttachment(parseInt(btn.dataset.index)));
    });
  }

  // Attach file button
  if (btnAttachFile) {
    btnAttachFile.addEventListener('click', async () => {
      const result = await window.api.openFileDialog();
      if (result.ok && result.paths) {
        for (const p of result.paths) {
          const name = p.split(/[\\/]/).pop();
          const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name);
          currentAttachments.push({ name, path: p, isImage });
        }
        renderAttachments();
      }
    });
  }

  // Drag and drop
  chatMessages.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatMessages.classList.add('drag-over');
  });
  chatMessages.addEventListener('dragleave', () => {
    chatMessages.classList.remove('drag-over');
  });
  chatMessages.addEventListener('drop', (e) => {
    e.preventDefault();
    chatMessages.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      for (const file of e.dataTransfer.files) {
        addAttachment(file);
      }
    }
  });

  // Paste image
  chatInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const name = `paste-${Date.now()}.png`;
          // Save file directly
          const arrayBuffer = await file.arrayBuffer();
          const result = await window.api.saveUploadedFile(name, arrayBuffer);
          if (result.ok) {
            currentAttachments.push({ name, path: result.path, isImage: true });
            renderAttachments();
          }
        }
      }
    }
  });

  // ---- Camera Modal ----
  if (btnCamera) {
    btnCamera.addEventListener('click', async () => {
      cameraModal.classList.remove('hidden');
      const video = document.getElementById('camera-video');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.play();
      } catch (e) {
        console.error('Camera error:', e);
        cameraModal.classList.add('hidden');
      }
    });
  }

  document.getElementById('btn-close-camera')?.addEventListener('click', () => {
    closeCameraModal();
  });

  document.getElementById('btn-cancel-camera')?.addEventListener('click', () => {
    closeCameraModal();
  });

  document.getElementById('btn-capture-photo')?.addEventListener('click', async () => {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const response = await fetch(dataUrl);
    const arrayBuffer = await response.arrayBuffer();
    const name = `camera-${Date.now()}.png`;
    const result = await window.api.saveUploadedFile(name, arrayBuffer);
    if (result.ok) {
      currentAttachments.push({ name, path: result.path, isImage: true });
      renderAttachments();
    }
    closeCameraModal();
  });

  function closeCameraModal() {
    const video = document.getElementById('camera-video');
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
    cameraModal.classList.add('hidden');
  }

  // ---- Image Preview Modal ----
  document.getElementById('btn-close-image-modal')?.addEventListener('click', () => {
    imagePreviewModal.classList.add('hidden');
  });
  imagePreviewModal?.addEventListener('click', (e) => {
    if (e.target === imagePreviewModal) imagePreviewModal.classList.add('hidden');
  });

  // ---- Open Workspace ----
  if (btnOpenWorkspace) {
    btnOpenWorkspace.addEventListener('click', async () => {
      if (agent.workspacePath) {
        await window.api.workspaceOpenInExplorer(agent.workspacePath);
      } else {
        const base = await window.api.workspaceGetBase();
        if (base.ok) await window.api.openFileExplorer(base.path);
      }
    });
  }

  // New chat
  btnNewChat.addEventListener('click', () => {
    agent.newConversation();
    setTitlebarTitle('未命名对话');
    chatMessages.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <h2>你好，我是你的AI伙伴</h2>
        <p>我可以帮你完成各种任务，包括文件操作、代码编写、信息搜索、图像生成等。告诉我你需要什么帮助吧！</p>
        <div class="quick-actions">
          <button class="quick-action-btn" data-prompt="帮我搜索一下最新的科技新闻"><i class="fa-solid fa-magnifying-glass"></i> 搜索新闻</button>
          <button class="quick-action-btn" data-prompt="帮我生成一张风景图片"><i class="fa-solid fa-image"></i> 生成图片</button>
          <button class="quick-action-btn" data-prompt="帮我创建一个待办事项列表"><i class="fa-solid fa-list-check"></i> 待办事项</button>
          <button class="quick-action-btn" data-prompt="帮我写一段JavaScript代码"><i class="fa-solid fa-code"></i> 编写代码</button>
        </div>
      </div>`;
    // Re-attach quick action handlers
    document.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.addEventListener('click', () => { chatInput.value = btn.dataset.prompt; sendMessage(); });
    });
  });

  btnClearChat.addEventListener('click', () => {
    agent.newConversation();
    setTitlebarTitle('未命名对话');
    chatMessages.innerHTML = '';
  });

  // ---- Todo Panel ----
  document.getElementById('btn-todo-toggle').addEventListener('click', () => {
    todoPanel.classList.toggle('hidden');
  });

  document.getElementById('btn-close-todo').addEventListener('click', () => {
    todoPanel.classList.add('hidden');
  });

  document.getElementById('btn-add-todo').addEventListener('click', () => {
    const text = todoInput.value.trim();
    if (!text) return;
    agent.handleTodo({ action: 'add', text });
    todoInput.value = '';
  });

  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = todoInput.value.trim();
      if (!text) return;
      agent.handleTodo({ action: 'add', text });
      todoInput.value = '';
    }
  });

  function renderTodoList(items) {
    if (items.length === 0) {
      todoList.innerHTML = '<div class="empty-state" style="padding:30px"><i class="fa-solid fa-list-check"></i><p>暂无待办事项</p></div>';
      return;
    }
    todoList.innerHTML = items.map(item => `
      <div class="todo-item ${item.done ? 'done' : ''}" data-id="${item.id}">
        <div class="todo-checkbox"><i class="fa-solid fa-check"></i></div>
        <span class="todo-text">${escapeHtml(item.text)}</span>
        <button class="btn-icon todo-delete" title="删除"><i class="fa-solid fa-xmark"></i></button>
      </div>`).join('');

    todoList.querySelectorAll('.todo-item').forEach(el => {
      const id = parseInt(el.dataset.id);
      el.querySelector('.todo-checkbox').addEventListener('click', () => agent.handleTodo({ action: 'toggle', id }));
      el.querySelector('.todo-delete').addEventListener('click', (e) => { e.stopPropagation(); agent.handleTodo({ action: 'remove', id }); });
    });
  }

  // ---- Approval Panel ----
  function showApprovalPanel(toolName, args) {
    approvalPanel.classList.remove('hidden');
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
    approvalContent.textContent = `操作: ${toolDef?.desc || toolName}\n\n参数:\n${JSON.stringify(args, null, 2)}`;
  }

  document.getElementById('btn-approve').addEventListener('click', () => {
    approvalPanel.classList.add('hidden');
    agent.resolveApproval(true);
  });

  document.getElementById('btn-deny').addEventListener('click', () => {
    approvalPanel.classList.add('hidden');
    agent.resolveApproval(false);
  });

  // ---- Tools Page ----
  function renderToolsStats() {
    const enabledSettings = agent.settings.tools || {};
    const allDefs = getAllToolDefinitions();
    const total = allDefs.length;
    const enabledCount = allDefs.filter(t => enabledSettings[t.name] !== false).length;
    const enabledSchemas = getToolSchemas(enabledSettings);
    const schemaChars = JSON.stringify(enabledSchemas).length;
    const estTokens = Math.ceil(schemaChars / 4);
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeTools = (typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : allDefs.filter(t => enabledSettings[t.name] !== false).map(t => t.name);
    const activeMap = {};
    allDefs.forEach(t => { activeMap[t.name] = false; });
    activeTools.forEach(n => { activeMap[n] = true; });
    const activeSchemas = getToolSchemas(activeMap);
    const activeTokens = Math.ceil(JSON.stringify(activeSchemas).length / 4);
    const savedTokens = Math.max(0, estTokens - activeTokens);
    const mcpCount = MCP_DYNAMIC_TOOLS.length;
    const mcpBadge = mcpCount > 0 ? `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-plug-circle-bolt"></i> MCP动态 <strong>${mcpCount}</strong></span>` : '';
    const optimizedInfo = agent.settings.autoOptimizeToolSelection
      ? (hasOptimized
        ? `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-wand-magic-sparkles"></i> 当前优化: <strong>${activeTools.length}</strong> / ${enabledCount}</span><span class="tools-stat"><i class="fa-solid fa-compress"></i> 优化后 <strong>~${activeTokens.toLocaleString()}</strong> tokens（节省 ~${savedTokens.toLocaleString()}）</span><span class="tools-stat" title="${escapeHtml(agent.optimizedToolReason || '')}"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(agent.optimizedToolReason || '已优化')}</span>`
        : `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-wand-magic-sparkles"></i> 当前优化: <strong>未执行</strong></span>`)
      : '';
    const statsEl = document.getElementById('tools-stats');
    if (statsEl) {
      statsEl.innerHTML = `<span class="tools-stat"><i class="fa-solid fa-toggle-on"></i> 已启用 <strong>${enabledCount}</strong> / ${total} 个工具</span><span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-layer-group"></i> 工具上下文 <strong>~${estTokens.toLocaleString()}</strong> tokens</span>${mcpBadge}${optimizedInfo}`;
    }
  }

  function loadToolsPage() {
    const groupsEl = document.getElementById('tools-groups');
    const enabledSettings = agent.settings.tools || {};
    const allDefs = getAllToolDefinitions();
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeToolSet = new Set((typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : allDefs.filter(t => enabledSettings[t.name] !== false).map(t => t.name));
    renderToolsStats();

    const autoOptimizeEl = document.getElementById('toggle-auto-optimize-tools');
    if (autoOptimizeEl) {
      autoOptimizeEl.checked = !!agent.settings.autoOptimizeToolSelection;
      autoOptimizeEl.onchange = async () => {
        if (autoOptimizeEl.checked) {
          const confirmed = await window.confirmDialog(
            '开启后，每个新对话首条消息前会先优化本次可用工具集合，以节省上下文占用。\n\n注意：若任务中途发现工具不足，AI会通过内部机制重新优化。是否继续开启？',
            '开启自动优化工具选择'
          );
          if (!confirmed) {
            autoOptimizeEl.checked = false;
            return;
          }
        }
        agent.settings.autoOptimizeToolSelection = !!autoOptimizeEl.checked;
        await window.api.setSettings(agent.settings);
        if (typeof agent.resetOptimizedTools === 'function') {
          agent.resetOptimizedTools();
        }
        updateReoptimizeButtonVisibility();
        renderToolsStats();
      };
    }

    const categoryMap = new Map();
    for (const tool of allDefs) {
      const cat = tool.category || '其他';
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat).push(tool);
    }

    const categoryEntries = Array.from(categoryMap.entries());
    groupsEl.innerHTML = categoryEntries.map(([category, tools]) => {
      const enabledCount = tools.filter(t => enabledSettings[t.name] !== false).length;
      const categoryChecked = enabledCount === tools.length;
      const toolCards = tools.map(tool => {
        const enabled = enabledSettings[tool.name] !== false;
        const active = enabled && activeToolSet.has(tool.name);
        const optimizeClass = agent.settings.autoOptimizeToolSelection
          ? (hasOptimized ? (active ? 'optimized-active' : 'optimized-muted') : '')
          : '';
        const mcpBadge = tool.serverName
          ? `<span class="tool-badge-mcp" title="来自 MCP 服务器: ${escapeHtml(tool.serverName)}"><i class="fa-solid fa-plug-circle-bolt"></i> 动态 · ${escapeHtml(tool.serverName)}</span>`
          : '';
        return `
          <div class="tool-card ${enabled ? '' : 'disabled'} ${optimizeClass}" data-tool="${tool.name}">
            <div class="tool-icon"><i class="fa-solid ${tool.icon}"></i></div>
            <div class="tool-info">
              <div class="tool-name">${tool.name}${mcpBadge}</div>
              <div class="tool-desc">${tool.desc}</div>
            </div>
            <div class="tool-toggle">
              <div class="toggle-switch">
                <input type="checkbox" ${enabled ? 'checked' : ''} data-tool-name="${tool.name}">
                <span class="toggle-slider"></span>
              </div>
            </div>
          </div>`;
      }).join('');
      const isMcpCategory = category.startsWith('MCP:');
      const mcpRefreshBtn = isMcpCategory
        ? `<button class="mcp-refresh-btn" data-mcp-refresh="${escapeHtml(category)}" title="刷新MCP工具"><i class="fa-solid fa-arrows-rotate"></i></button>`
        : '';
      return `
        <div class="tool-group ${isMcpCategory ? 'mcp-tool-group' : ''}" data-tool-category="${category}">
          <div class="tool-group-header">
            <div class="tool-group-meta">
              <div class="tool-group-title">${isMcpCategory ? '<i class="fa-solid fa-plug-circle-bolt"></i> ' : ''}${category}</div>
              <div class="tool-group-count"><span data-category-enabled>${enabledCount}</span> / ${tools.length} 已启用${mcpRefreshBtn}</div>
            </div>
            <label class="tool-group-toggle">
              <span>整组开关</span>
              <div class="toggle-switch">
                <input type="checkbox" ${categoryChecked ? 'checked' : ''} data-tool-category-toggle="${category}">
                <span class="toggle-slider"></span>
              </div>
            </label>
          </div>
          <div class="tools-grid">${toolCards}</div>
        </div>`;
    }).join('');

    groupsEl.querySelectorAll('input[data-tool-name]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const name = cb.dataset.toolName;
        await updateToolSetting(name, cb.checked, cb);
      });
    });

    groupsEl.querySelectorAll('input[data-tool-category-toggle]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const category = cb.dataset.toolCategoryToggle;
        await setToolCategoryEnabled(category, cb.checked);
      });
    });

    groupsEl.querySelectorAll('.tool-card').forEach(card => {
      card.addEventListener('click', async (e) => {
        if (e.target.closest('input')) return;
        const cb = card.querySelector('input[data-tool-name]');
        if (!cb) return;
        cb.checked = !cb.checked;
        await updateToolSetting(cb.dataset.toolName, cb.checked, cb);
      });
    });

    // MCP refresh buttons
    groupsEl.querySelectorAll('.mcp-refresh-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.classList.add('spinning');
        btn.disabled = true;
        try {
          const result = await window.api.mcpListTools();
          if (result && result.tools) {
            registerMcpTools(result.tools);
            agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
            loadToolsPage();
          }
        } catch (err) {
          console.error('[MCP Refresh]', err);
        } finally {
          btn.classList.remove('spinning');
          btn.disabled = false;
        }
      });
    });
  }

  async function setToolCategoryEnabled(category, enabled) {
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    const toolsInCategory = getAllToolDefinitions().filter(t => (t.category || '其他') === category);
    toolsInCategory.forEach(t => {
      agent.settings.tools[t.name] = enabled;
    });
    await window.api.setSettings(agent.settings);
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    if (typeof agent.resetOptimizedTools === 'function') {
      agent.resetOptimizedTools();
    }
    loadToolsPage();
  }

  async function updateToolSetting(name, enabled, checkboxEl) {
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    agent.settings.tools[name] = enabled;
    await window.api.setSettings(agent.settings);
    if (checkboxEl) {
      checkboxEl.closest('.tool-card')?.classList.toggle('disabled', !enabled);
    }
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    if (typeof agent.resetOptimizedTools === 'function') {
      agent.resetOptimizedTools();
    }
    renderToolsStats();
    const groupEl = checkboxEl?.closest('.tool-group');
    if (groupEl) {
      const allChecks = Array.from(groupEl.querySelectorAll('input[data-tool-name]'));
      const enabledCount = allChecks.filter(c => c.checked).length;
      const countEl = groupEl.querySelector('[data-category-enabled]');
      if (countEl) countEl.textContent = String(enabledCount);
      const toggle = groupEl.querySelector('input[data-tool-category-toggle]');
      if (toggle) toggle.checked = enabledCount === allChecks.length;
    }
  }

  // ---- Skills Page ----
  function getPathDirname(filePath) {
    const p = String(filePath || '');
    const idxSlash = p.lastIndexOf('/');
    const idxBackslash = p.lastIndexOf('\\');
    const idx = Math.max(idxSlash, idxBackslash);
    return idx >= 0 ? p.slice(0, idx) : '';
  }

  function joinPath(base, name) {
    if (!base) return name;
    const sep = base.includes('\\') ? '\\' : '/';
    return `${base}${base.endsWith(sep) ? '' : sep}${name}`;
  }

  function getPathBasename(filePath) {
    const p = String(filePath || '').replace(/[\\/]+$/, '');
    const idxSlash = p.lastIndexOf('/');
    const idxBackslash = p.lastIndexOf('\\');
    const idx = Math.max(idxSlash, idxBackslash);
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  function parseFrontmatter(text) {
    const data = {};
    if (!text || !text.startsWith('---\n')) return { data, body: text || '' };
    const end = text.indexOf('\n---', 4);
    if (end < 0) return { data, body: text };
    const fm = text.slice(4, end).split(/\r?\n/);
    let currentArrayKey = '';
    fm.forEach(line => {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) {
        const key = kv[1].trim();
        const value = kv[2].trim();
        if (!value) {
          data[key] = [];
          currentArrayKey = key;
        } else {
          data[key] = value.replace(/^['"]|['"]$/g, '');
          currentArrayKey = '';
        }
        return;
      }
      const arr = line.match(/^\s*-\s*(.+)$/);
      if (arr && currentArrayKey) {
        if (!Array.isArray(data[currentArrayKey])) data[currentArrayKey] = [];
        data[currentArrayKey].push(arr[1].trim().replace(/^['"]|['"]$/g, ''));
      }
    });
    const body = text.slice(end + 4).replace(/^\r?\n/, '');
    return { data, body };
  }

  function parseMarkdownSections(markdownBody) {
    const sections = {};
    let current = '__intro';
    sections[current] = [];
    String(markdownBody || '').split(/\r?\n/).forEach(line => {
      const h = line.match(/^#{2,6}\s+(.+)$/);
      if (h) {
        current = h[1].trim().toLowerCase();
        if (!sections[current]) sections[current] = [];
      } else {
        sections[current].push(line);
      }
    });
    Object.keys(sections).forEach(key => {
      sections[key] = sections[key].join('\n').trim();
    });
    return sections;
  }

  function pickSection(sections, aliases) {
    for (const alias of aliases) {
      const k = alias.toLowerCase();
      if (sections[k]) return sections[k];
    }
    return '';
  }

  function buildStandardSkillFromMarkdown(skillMdPath, markdownContent, scripts = []) {
    const { data: meta, body } = parseFrontmatter(markdownContent);
    const sections = parseMarkdownSections(body);
    const titleFromHeading = (body.match(/^#\s+(.+)$/m) || [])[1] || '';
    const fallbackName = getPathBasename(getPathDirname(skillMdPath)) || 'Imported Skill';
    const name = String(meta.name || meta.title || titleFromHeading || fallbackName).trim();
    const description = String(
      meta.description
      || pickSection(sections, ['description', '简介', '概述'])
      || sections.__intro
      || '标准 Skill 导入'
    ).trim();
    const whenToUse = pickSection(sections, ['when to use', 'when-to-use', '使用场景']);
    const instructions = pickSection(sections, ['instructions', '步骤', 'usage', '使用方法']);
    const guidelines = pickSection(sections, ['guidelines', '规则', '注意事项']);
    const prompt = [
      whenToUse ? `【适用场景】\n${whenToUse}` : '',
      instructions ? `【执行说明】\n${instructions}` : '',
      guidelines ? `【约束】\n${guidelines}` : ''
    ].filter(Boolean).join('\n\n').trim() || description;

    return {
      name,
      description,
      prompt,
      type: 'standard',
      sourceType: 'imported-skill-md',
      sourcePath: skillMdPath,
      runtime: 'javascript',
      scripts,
      standard: {
        whenToUse,
        instructions,
        guidelines,
        metadata: meta
      }
    };
  }

  async function collectSkillScripts(skillRootDir) {
    if (!skillRootDir) return [];
    const scriptsDir = joinPath(skillRootDir, 'scripts');
    const listResult = await window.api.listDirectory(scriptsDir);
    if (!listResult?.ok || !Array.isArray(listResult.entries)) return [];
    return listResult.entries
      .filter(entry => entry?.isFile && /\.js$/i.test(entry.name || ''))
      .map(entry => ({ name: entry.name, path: joinPath(scriptsDir, entry.name) }));
  }

  function getSkillSummaryMeta(skill) {
    const scriptCount = Array.isArray(skill?.scripts) ? skill.scripts.filter(s => /\.js$/i.test(String(s?.name || s || ''))).length : 0;
    const typeLabel = skill?.type === 'standard' ? '标准 Skill' : '自定义';
    return `${typeLabel}${scriptCount > 0 ? ` · JS脚本 ${scriptCount}` : ''}`;
  }

  async function importStandardSkillFile(skillMdPath) {
    const readResult = await window.api.readFile(skillMdPath);
    if (!readResult?.ok) return { ok: false, error: readResult?.error || '读取 SKILL.md 失败' };

    const rootDir = getPathDirname(skillMdPath);
    const scripts = await collectSkillScripts(rootDir);
    const skillPayload = buildStandardSkillFromMarkdown(skillMdPath, readResult.content || '', scripts);

    const existing = await window.api.listSkills();
    const matched = (Array.isArray(existing) ? existing : []).find(s => String(s?.sourcePath || '') === String(skillMdPath));
    if (matched?.id) {
      const updated = await window.api.updateSkill(matched.id, skillPayload);
      if (updated?.ok === false) return { ok: false, error: updated.error || '更新技能失败' };
      return { ok: true, mode: 'updated', name: skillPayload.name };
    }
    const created = await window.api.createSkill(skillPayload);
    if (!created) return { ok: false, error: '创建技能失败' };
    return { ok: true, mode: 'created', name: skillPayload.name };
  }

  async function loadSkillsPage() {
    const list = document.getElementById('skills-list');
    const skills = await window.api.listSkills();
    if (skills.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-lightbulb"></i><p>暂无技能，点击上方按钮添加或导入 SKILL.md</p></div>';
      return;
    }
    list.innerHTML = skills.map(s => `
      <div class="skill-card" data-id="${s.id}">
        <div class="skill-icon"><i class="fa-solid fa-lightbulb"></i></div>
        <div class="skill-info">
          <div class="skill-name">${escapeHtml(s.name || '')}</div>
          <div class="skill-desc">${escapeHtml(s.description || '')}</div>
          <div class="skill-meta">${escapeHtml(getSkillSummaryMeta(s))}</div>
        </div>
        <div class="skill-actions">
          <button class="btn-icon skill-edit" data-id="${s.id}" data-name="${escapeHtml(s.name || '')}" data-desc="${escapeHtml(s.description || '')}" data-prompt="${escapeHtml(s.prompt || '')}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="btn-icon skill-delete" data-id="${s.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`).join('');

    list.querySelectorAll('.skill-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.api.deleteSkill(btn.dataset.id);
        if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        loadSkillsPage();
      });
    });

    list.querySelectorAll('.skill-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = document.getElementById('skill-modal');
        document.getElementById('skill-modal-title').textContent = '编辑技能';
        document.getElementById('skill-edit-id').value = btn.dataset.id;
        document.getElementById('skill-name').value = btn.dataset.name || '';
        document.getElementById('skill-desc').value = btn.dataset.desc || '';
        document.getElementById('skill-prompt').value = btn.dataset.prompt || '';
        modal.classList.remove('hidden');
      });
    });
  }

  // Skill Modal
  document.getElementById('btn-add-skill').addEventListener('click', () => {
    document.getElementById('skill-modal-title').textContent = '添加技能';
    document.getElementById('skill-edit-id').value = '';
    document.getElementById('skill-name').value = '';
    document.getElementById('skill-desc').value = '';
    document.getElementById('skill-prompt').value = '';
    document.getElementById('skill-modal').classList.remove('hidden');
  });

  document.getElementById('btn-close-skill-modal').addEventListener('click', () => {
    document.getElementById('skill-modal').classList.add('hidden');
  });

  document.getElementById('btn-cancel-skill').addEventListener('click', () => {
    document.getElementById('skill-modal').classList.add('hidden');
  });

  document.getElementById('btn-save-skill').addEventListener('click', async () => {
    const editId = document.getElementById('skill-edit-id').value;
    const name = document.getElementById('skill-name').value.trim();
    const description = document.getElementById('skill-desc').value.trim();
    const prompt = document.getElementById('skill-prompt').value.trim();
    if (!name) return;
    if (editId) {
      await window.api.updateSkill(editId, { name, description, prompt });
    } else {
      await window.api.createSkill({ name, description, prompt });
    }
    if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    document.getElementById('skill-modal').classList.add('hidden');
    document.getElementById('skill-name').value = '';
    document.getElementById('skill-desc').value = '';
    document.getElementById('skill-prompt').value = '';
    document.getElementById('skill-edit-id').value = '';
    loadSkillsPage();
  });

  const btnImportStandardSkill = document.getElementById('btn-import-standard-skill');
  if (btnImportStandardSkill) {
    btnImportStandardSkill.addEventListener('click', async () => {
      const selectResult = await window.api.openFileDialog({
        title: '选择标准 Skill 文件（SKILL.md）',
        multiple: true,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
      });
      if (!selectResult?.ok || !Array.isArray(selectResult.paths) || selectResult.paths.length === 0) return;

      const resultLines = [];
      for (const skillPath of selectResult.paths) {
        try {
          const imported = await importStandardSkillFile(skillPath);
          if (imported.ok) {
            resultLines.push(`${imported.mode === 'updated' ? '更新' : '导入'}成功：${imported.name}`);
          } else {
            resultLines.push(`导入失败：${getPathBasename(skillPath)} (${imported.error || '未知错误'})`);
          }
        } catch (e) {
          resultLines.push(`导入失败：${getPathBasename(skillPath)} (${e.message})`);
        }
      }

      if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
      agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      loadSkillsPage();
      addMessage('system', `技能导入结果：\n- ${resultLines.join('\n- ')}`);
    });
  }

  // ---- Knowledge Page ----
  async function loadKnowledgePage(query = '') {
    const list = document.getElementById('knowledge-list');
    const items = await window.api.knowledgeSearch(query);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-database"></i><p>知识库为空</p></div>';
      return;
    }
    list.innerHTML = items.map(k => `
      <div class="knowledge-item" data-id="${k.id}">
        <div class="item-title">${escapeHtml(k.title || '未命名')}</div>
        <div class="item-content">${escapeHtml(k.content || '')}</div>
        <div class="item-meta">
          <span>${new Date(k.createdAt).toLocaleDateString('zh-CN')}</span>
          <div class="item-actions">
            <button class="btn-icon knowledge-delete" data-id="${k.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.knowledge-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await window.api.confirmSensitive('确定要删除这条知识吗？');
        if (!confirmed) return;
        await window.api.knowledgeDelete(btn.dataset.id);
        loadKnowledgePage(query);
      });
    });
  }

  document.getElementById('knowledge-search').addEventListener('input', (e) => {
    loadKnowledgePage(e.target.value);
  });

  // Knowledge import button
  const btnImportKnowledge = document.getElementById('btn-import-knowledge');
  if (btnImportKnowledge) {
    btnImportKnowledge.addEventListener('click', async () => {
      try {
        // 先选择文件
        const selectResult = await window.api.openFileDialog();
        if (!selectResult.ok || !selectResult.paths || selectResult.paths.length === 0) return;
        
        // 对每个文件进行导入
        for (const filePath of selectResult.paths) {
          const result = await window.api.knowledgeImportFile(filePath, agent.workspacePath);
          if (result.ok) {
            const title = result.fileName || '导入文件';
            await window.api.knowledgeAdd({ title, content: result.content });
            
            // 如果有提取的图片，也添加到消息中作为引用
            if (result.images && result.images.length > 0) {
              await window.api.knowledgeAdd({ 
                title: `${title} - 图片`, 
                content: `图片文件：${result.images.join(', ')}` 
              });
            }
          }
        }
        loadKnowledgePage();
      } catch (e) {
        console.error('Import knowledge error:', e);
      }
    });
  }

  // ---- Memory Page ----
  async function loadMemoryPage(query = '') {
    const list = document.getElementById('memory-list');
    const items = await window.api.memorySearch(query);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-brain"></i><p>暂无长期记忆</p></div>';
      return;
    }
    list.innerHTML = items.map(m => `
      <div class="memory-item" data-id="${m.id}">
        <div class="item-content">${escapeHtml(m.content || '')}</div>
        <div class="item-meta">
          <span>${new Date(m.createdAt).toLocaleDateString('zh-CN')}</span>
          <div class="item-tags">${(m.tags || []).map(t => `<span class="item-tag">${escapeHtml(t)}</span>`).join('')}</div>
          <div class="item-actions">
            <button class="btn-icon memory-edit" data-id="${m.id}" title="编辑"><i class="fa-solid fa-pen"></i></button>
            <button class="btn-icon memory-delete" data-id="${m.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.memory-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await window.api.confirmSensitive('确定要删除这条记忆吗？');
        if (!confirmed) return;
        await window.api.memoryDelete(btn.dataset.id);
        loadMemoryPage(query);
      });
    });

    list.querySelectorAll('.memory-edit').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const current = items.find(i => String(i.id) === String(id));
        const result = await openMemoryEditDialog(current);
        if (!result) return;
        await window.api.memoryUpdate(id, { content: result.content, tags: result.tags });
        loadMemoryPage(query);
      });
    });
  }

  document.getElementById('memory-search').addEventListener('input', (e) => {
    loadMemoryPage(e.target.value);
  });

  // ---- Memory Edit Modal ----
  let memoryEditResolve = null;
  function openMemoryEditDialog(item) {
    return new Promise((resolve) => {
      const modal = document.getElementById('memory-edit-modal');
      const contentEl = document.getElementById('memory-edit-content');
      const tagsEl = document.getElementById('memory-edit-tags');
      if (!modal || !contentEl || !tagsEl) {
        resolve(null);
        return;
      }
      memoryEditResolve = resolve;
      contentEl.value = item?.content || '';
      tagsEl.value = (item?.tags || []).join(', ');
      modal.classList.remove('hidden');
      contentEl.focus();
    });
  }

  function closeMemoryEditDialog(result) {
    const modal = document.getElementById('memory-edit-modal');
    modal?.classList.add('hidden');
    if (memoryEditResolve) {
      memoryEditResolve(result);
      memoryEditResolve = null;
    }
  }

  document.getElementById('btn-close-memory-edit')?.addEventListener('click', () => {
    closeMemoryEditDialog(null);
  });

  document.getElementById('btn-cancel-memory-edit')?.addEventListener('click', () => {
    closeMemoryEditDialog(null);
  });

  document.getElementById('btn-save-memory-edit')?.addEventListener('click', () => {
    const contentEl = document.getElementById('memory-edit-content');
    const tagsEl = document.getElementById('memory-edit-tags');
    const content = contentEl?.value.trim() || '';
    const tags = (tagsEl?.value || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!content) return;
    closeMemoryEditDialog({ content, tags });
  });

  // ---- Settings Page ----
  async function loadSettingsPage() {
    const s = await window.api.getSettings();
    document.getElementById('setting-llm-url').value = s.llm.apiUrl || '';
    document.getElementById('setting-llm-key').value = s.llm.apiKey || '';
    document.getElementById('setting-llm-model').value = s.llm.model || '';
    document.getElementById('setting-llm-temp').value = s.llm.temperature;
    document.getElementById('setting-temp-val').textContent = s.llm.temperature;
    document.getElementById('setting-llm-ctx').value = s.llm.maxContextLength;
    document.getElementById('setting-llm-max-response').value = s.llm.maxResponseTokens || 8192;
    document.getElementById('setting-llm-daily-limit').value = s.llm.dailyMaxTokens || 0;
    const llmUsage = s.llm.dailyTokensUsed || 0;
    const llmLimit = s.llm.dailyMaxTokens || 0;
    const llmUsageEl = document.getElementById('setting-llm-usage');
    llmUsageEl.textContent = `今日已用: ${llmUsage}`;
    if (llmLimit > 0 && llmUsage >= llmLimit * 0.8) {
      llmUsageEl.classList.add('warning');
      llmUsageEl.textContent = `今日已用: ${llmUsage} (接近限制 ${llmLimit})`;
    }
    
    document.getElementById('setting-img-url').value = s.imageGen.apiUrl || '';
    document.getElementById('setting-img-key').value = s.imageGen.apiKey || '';
    document.getElementById('setting-img-model').value = s.imageGen.model || '';
    document.getElementById('setting-img-size').value = s.imageGen.imageSize || '1024x1024';
    document.getElementById('setting-img-daily-limit').value = s.imageGen.dailyMaxImages || 0;
    const imgUsage = s.imageGen.dailyImagesUsed || 0;
    const imgLimit = s.imageGen.dailyMaxImages || 0;
    const imgUsageEl = document.getElementById('setting-img-usage');
    imgUsageEl.textContent = `今日已用: ${imgUsage}`;
    if (imgLimit > 0 && imgUsage >= imgLimit * 0.8) {
      imgUsageEl.classList.add('warning');
      imgUsageEl.textContent = `今日已用: ${imgUsage} (接近限制 ${imgLimit})`;
    }
    
    document.getElementById('setting-accent-color').value = s.theme.accentColor;
    document.getElementById('setting-bg-color').value = s.theme.backgroundColor;
    document.getElementById('setting-auto-approve').checked = s.autoApproveSensitive;

    // Theme mode
    document.querySelectorAll('.theme-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === s.theme.mode);
    });

    // AI Persona settings
    const persona = s.aiPersona || {};
    const nameEl = document.getElementById('setting-ai-name');
    const bioEl = document.getElementById('setting-ai-bio');
    const pronounsEl = document.getElementById('setting-ai-pronouns');
    const personalityEl = document.getElementById('setting-ai-personality');
    const customPromptEl = document.getElementById('setting-ai-custom-prompt');
    if (nameEl) nameEl.value = persona.name || '';
    if (bioEl) bioEl.value = persona.bio || '';
    if (pronounsEl) pronounsEl.value = persona.pronouns || '';
    if (personalityEl) personalityEl.value = persona.personality || '';
    if (customPromptEl) customPromptEl.value = persona.customPrompt || '';
    // Avatar migration: if stored as file path, convert to base64
    let aiAvatarData = persona.avatar || '';
    if (aiAvatarData && !aiAvatarData.startsWith('data:') && !aiAvatarData.startsWith('http')) {
      const enc = await window.api.avatarEncodeFile(aiAvatarData);
      if (enc.ok) { aiAvatarData = enc.dataUrl; s.aiPersona.avatar = aiAvatarData; await window.api.setSettings(s); }
    }
    updateAvatarPreview(aiAvatarData);

    // User Profile settings
    const userProfile = s.userProfile || {};
    const userNameEl = document.getElementById('setting-user-name');
    const userBioEl = document.getElementById('setting-user-bio');
    if (userNameEl) userNameEl.value = userProfile.name || '';
    if (userBioEl) userBioEl.value = userProfile.bio || '';
    let userAvatarData = userProfile.avatar || '';
    if (userAvatarData && !userAvatarData.startsWith('data:') && !userAvatarData.startsWith('http')) {
      const enc = await window.api.avatarEncodeFile(userAvatarData);
      if (enc.ok) { userAvatarData = enc.dataUrl; s.userProfile.avatar = userAvatarData; await window.api.setSettings(s); }
    }
    updateUserAvatarPreview(userAvatarData);
    window.api.webControlSetAvatars({ ai: aiAvatarData, user: userAvatarData });

    // Entropy settings
    const entropy = s.entropy || {};
    document.querySelectorAll('.entropy-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.source === (entropy.source || 'csprng')));
    document.getElementById('entropy-trng-settings').style.display = entropy.source === 'trng' ? '' : 'none';
    document.querySelectorAll('.trng-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === (entropy.trngMode || 'network')));
    document.getElementById('trng-network-settings').style.display = (entropy.trngMode || 'network') === 'network' ? '' : 'none';
    document.getElementById('trng-serial-settings').style.display = entropy.trngMode === 'serial' ? '' : 'none';
    const trngHostEl = document.getElementById('setting-trng-host');
    if (trngHostEl) trngHostEl.value = entropy.trngNetworkHost || '192.168.4.1';
    const trngPortEl = document.getElementById('setting-trng-port');
    if (trngPortEl) trngPortEl.value = entropy.trngNetworkPort || 80;
    const trngBaudEl = document.getElementById('setting-trng-serial-baud');
    if (trngBaudEl) trngBaudEl.value = entropy.trngSerialBaud || 115200;
    const trngSerialEl = document.getElementById('setting-trng-serial-port');
    if (trngSerialEl && entropy.trngSerialPort) trngSerialEl.value = entropy.trngSerialPort;
    if (entropy.trngMode === 'serial') {
      refreshTrngPorts(false);
    }
    
    // 更新配色方案可见性
    updateColorSchemeVisibility();
    
    // Proxy settings
    const proxy = s.proxy || {};
    document.querySelectorAll('.proxy-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === (proxy.mode || 'system'));
    });
    document.getElementById('manual-proxy-settings').style.display = proxy.mode === 'manual' ? '' : 'none';
    const proxyHttpEl = document.getElementById('setting-proxy-http');
    if (proxyHttpEl) proxyHttpEl.value = proxy.http || '';
    const proxyHttpsEl = document.getElementById('setting-proxy-https');
    if (proxyHttpsEl) proxyHttpsEl.value = proxy.https || '';
    const proxyBypassEl = document.getElementById('setting-proxy-bypass');
    if (proxyBypassEl) proxyBypassEl.value = proxy.bypass || 'localhost,127.0.0.1';

    // MCP settings
    await loadMcpServerList();
    setupMcpEvents();

    // Email settings
    const email = s.email || {};
    const eid = (id, prop, def='') => { const el = document.getElementById(id); if (el) el.value = email[prop] ?? def; };
    const emailModeEl = document.getElementById('setting-email-mode');
    if (emailModeEl) emailModeEl.value = email.mode || 'send-receive';
    updateEmailModeVisibility(email.mode || 'send-receive');
    eid('setting-email-smtp-host', 'smtpHost');
    eid('setting-email-smtp-port', 'smtpPort', 587);
    const smtpSecure = document.getElementById('setting-email-smtp-secure');
    if (smtpSecure) smtpSecure.checked = email.smtpSecure !== false;
    eid('setting-email-imap-host', 'imapHost');
    eid('setting-email-imap-port', 'imapPort', 993);
    const imapTls = document.getElementById('setting-email-imap-tls');
    if (imapTls) imapTls.checked = email.imapTls !== false;
    eid('setting-email-user', 'emailUser');
    eid('setting-email-pass', 'emailPass');
    eid('setting-email-owner', 'ownerAddress');
    eid('setting-email-totp-secret', 'totpSecret');
    eid('setting-email-poll-interval', 'pollInterval', 30);
    eid('setting-email-resend-interval', 'resendIntervalMinutes', 30);
    eid('setting-email-max-resends', 'maxResends', 3);
    const emailEnabled = document.getElementById('setting-email-enabled');
    if (emailEnabled) emailEnabled.checked = !!email.enabled;
    setupEmailEvents();

    // Web Control settings
    const wc = s.webControl || {};
    const wcPortEl = document.getElementById('setting-wc-port');
    if (wcPortEl) wcPortEl.value = wc.port || 3456;
    const wcEnabledEl = document.getElementById('setting-wc-enabled');
    if (wcEnabledEl) wcEnabledEl.checked = !!wc.enabled;
    const wcAutoStartEl = document.getElementById('setting-wc-autostart');
    if (wcAutoStartEl) wcAutoStartEl.checked = !!wc.autoStartOnOpen;
    const wc2faEl = document.getElementById('setting-wc-enable-2fa');
    if (wc2faEl) {
      wc2faEl.checked = !!wc.enable2FA;
      document.getElementById('wc-2fa-area').style.display = wc.enable2FA ? '' : 'none';
    }
    // Update toggle button state
    updateWcToggleButton();
    setupWebControlEvents();
  }

  // ---- MCP Settings Helpers ----
  let mcpEventsSetup = false;

  // ---- Email Settings Helpers ----
  let emailEventsSetup = false;

  function updateEmailModeVisibility(mode) {
    const smtpGroup = document.getElementById('email-smtp-group');
    const imapGroup = document.getElementById('email-imap-group');
    if (smtpGroup) smtpGroup.style.display = (mode === 'send-only' || mode === 'send-receive') ? '' : 'none';
    if (imapGroup) imapGroup.style.display = (mode === 'receive-only' || mode === 'send-receive') ? '' : 'none';
  }

  function setupEmailEvents() {
    if (emailEventsSetup) return;
    emailEventsSetup = true;

    // Mode change
    document.getElementById('setting-email-mode')?.addEventListener('change', (e) => {
      updateEmailModeVisibility(e.target.value);
    });

    // Generate TOTP
    document.getElementById('btn-email-gen-totp')?.addEventListener('click', async () => {
      const result = await window.api.emailGenerateTOTP();
      if (result.ok) {
        const qrArea = document.getElementById('email-totp-qr-area');
        const qrImg = document.getElementById('email-totp-qr-img');
        const secretText = document.getElementById('email-totp-secret-text');
        const secretInput = document.getElementById('setting-email-totp-secret');
        if (qrArea) qrArea.style.display = '';
        if (qrImg) qrImg.src = result.qrDataUrl;
        if (secretText) secretText.textContent = `密钥: ${result.secret}`;
        if (secretInput) secretInput.value = result.secret;
        // Save secret immediately
        await window.api.emailSaveTOTPSecret(result.secret);
      } else {
        alert('TOTP 生成失败: ' + (result.error || '未知错误'));
      }
    });

    // Verify TOTP
    document.getElementById('btn-email-verify-totp')?.addEventListener('click', async () => {
      const code = document.getElementById('email-totp-verify-code')?.value?.trim();
      if (!code) return;
      const result = await window.api.emailVerifyTOTP(code);
      const span = document.getElementById('email-totp-verify-result');
      if (result.ok && result.valid) {
        if (span) { span.textContent = '✅ 验证通过'; span.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (span) { span.textContent = '❌ 验证失败'; span.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Test connection
    document.getElementById('btn-email-test')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('email-test-result');
      if (resultEl) { resultEl.textContent = '正在测试连接...'; resultEl.style.color = 'var(--text-secondary)'; }
      // Save first
      await saveEmailSettings();
      const result = await window.api.emailConnect();
      if (result.ok) {
        if (resultEl) { resultEl.textContent = `✅ 连接成功。SMTP: ${result.smtp || 'OK'}, IMAP: ${result.imap || 'OK'}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (resultEl) { resultEl.textContent = `❌ 连接失败: ${result.error}`; resultEl.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Save settings
    document.getElementById('btn-email-save')?.addEventListener('click', async () => {
      await saveEmailSettings();
      const resultEl = document.getElementById('email-test-result');
      if (resultEl) { resultEl.textContent = '✅ 设置已保存'; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      // If enabled, start polling
      const enabled = document.getElementById('setting-email-enabled')?.checked;
      if (enabled) {
        const r = await window.api.emailStartPolling();
        if (r.ok && resultEl) resultEl.textContent += '，邮件轮询已启动';
      } else {
        await window.api.emailStopPolling();
      }
    });
  }

  async function saveEmailSettings() {
    const s = await window.api.getSettings();
    s.email = {
      enabled: document.getElementById('setting-email-enabled')?.checked || false,
      mode: document.getElementById('setting-email-mode')?.value || 'send-receive',
      smtpHost: document.getElementById('setting-email-smtp-host')?.value?.trim() || '',
      smtpPort: parseInt(document.getElementById('setting-email-smtp-port')?.value) || 587,
      smtpSecure: document.getElementById('setting-email-smtp-secure')?.checked ?? true,
      imapHost: document.getElementById('setting-email-imap-host')?.value?.trim() || '',
      imapPort: parseInt(document.getElementById('setting-email-imap-port')?.value) || 993,
      imapTls: document.getElementById('setting-email-imap-tls')?.checked ?? true,
      emailUser: document.getElementById('setting-email-user')?.value?.trim() || '',
      emailPass: document.getElementById('setting-email-pass')?.value?.trim() || '',
      ownerAddress: document.getElementById('setting-email-owner')?.value?.trim() || '',
      totpSecret: document.getElementById('setting-email-totp-secret')?.value?.trim() || s.email?.totpSecret || '',
      pollInterval: parseInt(document.getElementById('setting-email-poll-interval')?.value) || 30,
      resendIntervalMinutes: parseInt(document.getElementById('setting-email-resend-interval')?.value) || 30,
      maxResends: parseInt(document.getElementById('setting-email-max-resends')?.value) || 3,
    };
    await saveSettings(s);
  }

  // ---- Web Control Settings Helpers ----
  let wcEventsSetup = false;

  async function updateWcToggleButton() {
    const btn = document.getElementById('btn-wc-toggle');
    const resultEl = document.getElementById('wc-status-result');
    if (!btn) return;
    try {
      const status = await window.api.webControlGetStatus();
      if (status.running) {
        btn.innerHTML = '<i class="fa-solid fa-stop"></i> 停止';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-danger');
        if (resultEl) { resultEl.textContent = `✅ 运行中: http://localhost:${status.port}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i> 启动';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-primary');
        if (resultEl) { resultEl.textContent = '未运行'; resultEl.style.color = 'var(--text-secondary)'; }
      }
    } catch {}
  }

  async function saveWebControlSettings() {
    const s = await window.api.getSettings();
    const passwordInput = document.getElementById('setting-wc-password')?.value?.trim();
    let passwordHash = s.webControl?.passwordHash || '';
    if (passwordInput) {
      const hashResult = await window.api.webControlHashPassword(passwordInput);
      if (hashResult.ok) passwordHash = hashResult.hash;
    }
    s.webControl = {
      enabled: document.getElementById('setting-wc-enabled')?.checked || false,
      autoStartOnOpen: document.getElementById('setting-wc-autostart')?.checked || false,
      port: parseInt(document.getElementById('setting-wc-port')?.value) || 3456,
      password: '',
      passwordHash,
      enable2FA: document.getElementById('setting-wc-enable-2fa')?.checked || false,
      totpSecret: s.webControl?.totpSecret || '',
    };
    await saveSettings(s);
    // Clear password field after save
    const pwEl = document.getElementById('setting-wc-password');
    if (pwEl) pwEl.value = '';
  }

  function setupWebControlEvents() {
    if (wcEventsSetup) return;
    wcEventsSetup = true;

    // 2FA toggle
    document.getElementById('setting-wc-enable-2fa')?.addEventListener('change', (e) => {
      document.getElementById('wc-2fa-area').style.display = e.target.checked ? '' : 'none';
    });

    // Generate TOTP
    document.getElementById('btn-wc-gen-totp')?.addEventListener('click', async () => {
      const result = await window.api.webControlGenerateTOTP();
      if (result.ok) {
        const qrArea = document.getElementById('wc-totp-qr-area');
        const qrImg = document.getElementById('wc-totp-qr-img');
        const secretText = document.getElementById('wc-totp-secret-text');
        if (qrArea) qrArea.style.display = '';
        if (qrImg) qrImg.src = result.qrDataUrl;
        if (secretText) secretText.textContent = `密钥: ${result.secret}`;
        // Save to settings
        const s = await window.api.getSettings();
        s.webControl = s.webControl || {};
        s.webControl.totpSecret = result.secret;
        await saveSettings(s);
      } else {
        alert('TOTP 生成失败: ' + (result.error || '未知错误'));
      }
    });

    // Verify TOTP
    document.getElementById('btn-wc-verify-totp')?.addEventListener('click', async () => {
      const code = document.getElementById('wc-totp-verify-code')?.value?.trim();
      if (!code) return;
      const result = await window.api.webControlVerifyTOTP(code);
      const span = document.getElementById('wc-totp-verify-result');
      if (result.ok && result.valid) {
        if (span) { span.textContent = '✅ 验证通过'; span.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (span) { span.textContent = '❌ 验证失败'; span.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Save
    document.getElementById('btn-wc-save')?.addEventListener('click', async () => {
      await saveWebControlSettings();
      const resultEl = document.getElementById('wc-status-result');
      if (resultEl) { resultEl.textContent = '✅ 设置已保存'; resultEl.style.color = 'var(--success-color, #4caf50)'; }
    });

    // Toggle start/stop
    document.getElementById('btn-wc-toggle')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('wc-status-result');
      const status = await window.api.webControlGetStatus();
      if (status.running) {
        const r = await window.api.webControlStop();
        if (r.ok) {
          if (resultEl) { resultEl.textContent = '已停止'; resultEl.style.color = 'var(--text-secondary)'; }
        } else {
          if (resultEl) { resultEl.textContent = '❌ 停止失败: ' + (r.error || ''); resultEl.style.color = 'var(--error-color, #f44336)'; }
        }
      } else {
        // Save first, then start
        await saveWebControlSettings();
        const r = await window.api.webControlStart();
        if (r.ok) {
          if (resultEl) { resultEl.textContent = `✅ ${r.message}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
        } else {
          if (resultEl) { resultEl.textContent = '❌ 启动失败: ' + (r.error || ''); resultEl.style.color = 'var(--error-color, #f44336)'; }
        }
      }
      updateWcToggleButton();
    });
  }

  async function loadMcpServerList() {
    const listEl = document.getElementById('mcp-servers-list');
    const toolsEl = document.getElementById('mcp-connected-tools');
    if (!listEl) return;

    try {
      const servers = await window.api.mcpListServers();
      if (!servers || servers.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">暂无 MCP 服务器配置</p>';
        toolsEl.innerHTML = '暂无已连接的 MCP 服务器';
        return;
      }

      listEl.innerHTML = servers.map(s => {
        const statusDot = s.status === 'connected' ? 'connected' : s.status === 'error' ? 'error' : '';
        const statusText = s.status === 'connected' ? '已连接' : s.status === 'connecting' ? '连接中...' : s.status === 'error' ? '错误' : '未连接';
        return `
          <div class="mcp-server-card" data-name="${s.name}">
            <div class="mcp-server-icon"><i class="fa-solid fa-server"></i></div>
            <div class="mcp-server-info">
              <h4>${s.name}</h4>
              <p>${s.command || ''} ${(s.args || []).join(' ')}</p>
            </div>
            <div class="mcp-server-status">
              <span class="dot ${statusDot}"></span>
              <span>${statusText}${s.toolCount ? ` (${s.toolCount} 工具)` : ''}</span>
            </div>
            <div class="mcp-server-actions">
              ${s.status === 'connected'
                ? `<button class="btn-icon btn-mcp-disconnect" data-name="${s.name}" title="断开"><i class="fa-solid fa-plug-circle-xmark"></i></button>`
                : `<button class="btn-icon btn-mcp-connect" data-name="${s.name}" title="连接"><i class="fa-solid fa-plug-circle-check"></i></button>`
              }
              <button class="btn-icon btn-mcp-remove" data-name="${s.name}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>`;
      }).join('');

      // Bind buttons
      listEl.querySelectorAll('.btn-mcp-connect').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          btn.disabled = true;
          await window.api.mcpConnect(name);
          await loadMcpServerList();
        });
      });
      listEl.querySelectorAll('.btn-mcp-disconnect').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.api.mcpDisconnect(btn.dataset.name);
          await loadMcpServerList();
        });
      });
      listEl.querySelectorAll('.btn-mcp-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.api.mcpRemoveServer(btn.dataset.name);
          await loadMcpServerList();
        });
      });

      // Show connected tools
      const toolsResult = await window.api.mcpListTools();
      if (toolsResult.ok && toolsResult.tools.length > 0) {
        toolsEl.innerHTML = toolsResult.tools.map(t =>
          `<div style="margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border)">
            <strong>${t.name}</strong> <span style="color:var(--text-secondary);font-size:11px">[${t.serverName}]</span>
            <br><span style="font-size:12px">${t.description || ''}</span>
          </div>`
        ).join('');
      } else {
        toolsEl.innerHTML = '暂无已连接的工具';
      }
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--error-color)">加载失败: ${e.message}</p>`;
    }
  }

  function setupMcpEvents() {
    if (mcpEventsSetup) return;
    mcpEventsSetup = true;

    const btnAdd = document.getElementById('btn-mcp-add');
    const form = document.getElementById('mcp-add-form');
    const btnCancel = document.getElementById('btn-mcp-cancel');
    const btnSave = document.getElementById('btn-mcp-save');

    if (btnAdd) {
      btnAdd.addEventListener('click', () => {
        form.classList.toggle('hidden');
      });
    }
    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        form.classList.add('hidden');
      });
    }
    if (btnSave) {
      btnSave.addEventListener('click', async () => {
        const name = document.getElementById('mcp-new-name').value.trim();
        const command = document.getElementById('mcp-new-command').value.trim();
        const argsStr = document.getElementById('mcp-new-args').value.trim();
        const envStr = document.getElementById('mcp-new-env').value.trim();
        const cwd = document.getElementById('mcp-new-cwd').value.trim();
        const autoConnect = document.getElementById('mcp-new-autoconnect').checked;

        if (!name || !command) {
          alert('名称和命令不能为空');
          return;
        }

        let args = [];
        let env = {};
        try { if (argsStr) args = JSON.parse(argsStr); } catch { alert('参数格式错误(需JSON数组)'); return; }
        try { if (envStr) env = JSON.parse(envStr); } catch { alert('环境变量格式错误(需JSON对象)'); return; }

        const result = await window.api.mcpAddServer({ name, command, args, env, cwd: cwd || undefined, autoConnect });
        if (result.ok) {
          document.getElementById('mcp-new-name').value = '';
          document.getElementById('mcp-new-command').value = '';
          document.getElementById('mcp-new-args').value = '';
          document.getElementById('mcp-new-env').value = '';
          document.getElementById('mcp-new-cwd').value = '';
          document.getElementById('mcp-new-autoconnect').checked = false;
          form.classList.add('hidden');
          await loadMcpServerList();
        } else {
          alert(result.error || '添加失败');
        }
      });
    }
  }

  function updateAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-ai-avatar-preview');
    if (!preview) return;
    preview.innerHTML = makeAvatarHTML(avatarData, true, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
  }

  function updateUserAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-user-avatar-preview');
    if (!preview) return;
    preview.innerHTML = makeAvatarHTML(avatarData, false, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
  }

  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.querySelector(`.settings-panel[data-tab="${btn.dataset.tab}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  // Settings change handlers
  async function saveSettings(updates) {
    const current = await window.api.getSettings();
    const merged = { ...current, ...updates };
    await window.api.setSettings(merged);
    agent.settings = merged;
  }

  // LLM settings
  ['setting-llm-url', 'setting-llm-key', 'setting-llm-model', 'setting-llm-ctx', 'setting-llm-daily-limit', 'setting-llm-max-response'].forEach(id => {
    document.getElementById(id).addEventListener('change', async (e) => {
      const key = { 'setting-llm-url': 'apiUrl', 'setting-llm-key': 'apiKey', 'setting-llm-model': 'model', 'setting-llm-ctx': 'maxContextLength', 'setting-llm-daily-limit': 'dailyMaxTokens', 'setting-llm-max-response': 'maxResponseTokens' }[id];
      const val = (id === 'setting-llm-ctx' || id === 'setting-llm-daily-limit' || id === 'setting-llm-max-response') ? parseInt(e.target.value) : e.target.value;
      const s = await window.api.getSettings();
      s.llm[key] = val;
      await saveSettings(s);
      if (key === 'maxContextLength') agent.contextManager.setMaxTokens(val);
    });
  });

  document.getElementById('setting-llm-temp').addEventListener('input', async (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById('setting-temp-val').textContent = val;
    const s = await window.api.getSettings();
    s.llm.temperature = val;
    await saveSettings(s);
  });

  // Image settings
  ['setting-img-url', 'setting-img-key', 'setting-img-model', 'setting-img-daily-limit'].forEach(id => {
    document.getElementById(id).addEventListener('change', async (e) => {
      const key = { 'setting-img-url': 'apiUrl', 'setting-img-key': 'apiKey', 'setting-img-model': 'model', 'setting-img-daily-limit': 'dailyMaxImages' }[id];
      const s = await window.api.getSettings();
      const val = id === 'setting-img-daily-limit' ? parseInt(e.target.value) : e.target.value;
      s.imageGen[key] = val;
      await saveSettings(s);
    });
  });

  document.getElementById('setting-img-size').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.imageGen.imageSize = e.target.value;
    await saveSettings(s);
  });

  // Theme mode
  document.querySelectorAll('.theme-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.theme-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const s = await window.api.getSettings();
      const oldMode = s.theme.mode;
      s.theme.mode = btn.dataset.mode;
      
      // 检测是否切换了深浅色模式
      const oldDark = await ThemeManager.getCurrentDarkMode(oldMode);
      const newDark = await ThemeManager.getCurrentDarkMode(s.theme.mode);
      const currentBgDark = ThemeManager.isBackgroundDark(s.theme.backgroundColor);
      
      // 如果深浅色模式改变，或者当前配色与目标模式不符，随机应用目标色系的配色
      if (oldDark !== newDark || currentBgDark !== newDark) {
        const scheme = ThemeManager.getRandomScheme(newDark);
        s.theme.accentColor = scheme.accent;
        s.theme.backgroundColor = scheme.bg;
        document.getElementById('setting-accent-color').value = scheme.accent;
        document.getElementById('setting-bg-color').value = scheme.bg;
      }
      
      await saveSettings(s);
      ThemeManager.apply(s.theme);
      updateColorSchemeVisibility();
    });
  });

  // Accent color
  document.getElementById('setting-accent-color').addEventListener('input', async (e) => {
    const s = await window.api.getSettings();
    s.theme.accentColor = e.target.value;
    await saveSettings(s);
    ThemeManager.apply(s.theme);
  });

  document.querySelectorAll('#accent-presets .color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const color = dot.dataset.color;
      document.getElementById('setting-accent-color').value = color;
      const s = await window.api.getSettings();
      s.theme.accentColor = color;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Background color
  document.getElementById('setting-bg-color').addEventListener('input', async (e) => {
    const s = await window.api.getSettings();
    s.theme.backgroundColor = e.target.value;
    await saveSettings(s);
    ThemeManager.apply(s.theme);
  });

  document.querySelectorAll('#bg-presets .color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const color = dot.dataset.color;
      document.getElementById('setting-bg-color').value = color;
      const s = await window.api.getSettings();
      s.theme.backgroundColor = color;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Color schemes
  async function updateColorSchemeVisibility() {
    const s = await window.api.getSettings();
    const isDark = await ThemeManager.getCurrentDarkMode(s.theme.mode);
    document.querySelectorAll('.scheme-btn').forEach(btn => {
      const bgColor = btn.dataset.bg;
      const btnIsDark = ThemeManager.isBackgroundDark(bgColor);
      // 只显示当前深浅色系的配色
      if (btnIsDark === isDark) {
        btn.style.display = '';
      } else {
        btn.style.display = 'none';
      }
    });
  }
  
  document.querySelectorAll('.scheme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const accent = btn.dataset.accent;
      const bg = btn.dataset.bg;
      document.getElementById('setting-accent-color').value = accent;
      document.getElementById('setting-bg-color').value = bg;
      const s = await window.api.getSettings();
      s.theme.accentColor = accent;
      s.theme.backgroundColor = bg;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Password toggle
  document.querySelectorAll('.btn-toggle-pwd').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target.type === 'password') {
        target.type = 'text';
        btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
      } else {
        target.type = 'password';
        btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
      }
    });
  });

  // Auto-approve toggle
  document.getElementById('setting-auto-approve').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const confirmed = await window.api.confirmSensitive('开启自动批准敏感操作后，AI Agent将无需确认即可执行文件删除、终端命令等危险操作。\n\n确定要开启吗？');
      if (!confirmed) {
        e.target.checked = false;
        return;
      }
    }
    const s = await window.api.getSettings();
    s.autoApproveSensitive = e.target.checked;
    await saveSettings(s);
  });

  // Usage reset button
  document.getElementById('btn-reset-usage')?.addEventListener('click', async () => {
    const confirmed = await window.api.confirmSensitive('确定要重置每日使用量统计吗？\n\n这将清零今日的Token用量和图片生成数。');
    if (!confirmed) return;
    
    const s = await window.api.getSettings();
    s.llm.dailyTokensUsed = 0;
    s.llm.dailyUsageDate = '';
    s.imageGen.dailyImagesUsed = 0;
    s.imageGen.dailyUsageDate = '';
    await saveSettings(s);
    
    // Refresh display
    document.getElementById('setting-llm-usage').textContent = '今日已用: 0';
    document.getElementById('setting-img-usage').textContent = '今日已用: 0';
    alert('使用量已重置');
  });

  // Firmware export button
  document.getElementById('btn-export-firmware')?.addEventListener('click', async () => {
    const result = await window.api.firmwareExport();
    if (result.ok) {
      showMessageModal(`固件源码已导出到：<br>${result.path}<br><br>请在 Arduino IDE 中打开 CIBYP-TRNG.ino 文件。`, '导出成功', 'success');
      window.api.openFileExplorer(result.path);
    } else {
      showMessageModal(`导出失败：${result.error || '未知错误'}`, '导出失败', 'error');
    }
  });

  // Arduino download link
  document.querySelectorAll('.link-arduino-download').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openBrowser('https://www.arduino.cc/en/software');
    });
  });

  // ---- AI Persona Settings ----
  ['setting-ai-name', 'setting-ai-bio', 'setting-ai-pronouns', 'setting-ai-personality', 'setting-ai-custom-prompt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = {
          'setting-ai-name': 'name',
          'setting-ai-bio': 'bio',
          'setting-ai-pronouns': 'pronouns',
          'setting-ai-personality': 'personality',
          'setting-ai-custom-prompt': 'customPrompt',
        }[id];
        const s = await window.api.getSettings();
        if (!s.aiPersona) s.aiPersona = {};
        s.aiPersona[key] = el.value;
        await saveSettings(s);
        // Update agent system prompt
        agent.settings = s;
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        // Update display
        updatePersonaDisplay(s.aiPersona);
      });
    }
  });

  // AI avatar file picker
  document.getElementById('btn-ai-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode();
    if (result.ok && result.dataUrl) {
      const s = await window.api.getSettings();
      if (!s.aiPersona) s.aiPersona = {};
      s.aiPersona.avatar = result.dataUrl;
      await saveSettings(s);
      updateAvatarPreview(result.dataUrl);
      updatePersonaDisplay(s.aiPersona);
      window.api.webControlSetAvatars({ ai: result.dataUrl, user: s.userProfile?.avatar || '' });
    }
  });

  document.getElementById('btn-ai-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.aiPersona) s.aiPersona = {};
    s.aiPersona.avatar = '';
    await saveSettings(s);
    updateAvatarPreview('');
    updatePersonaDisplay(s.aiPersona);
    window.api.webControlSetAvatars({ ai: '', user: s.userProfile?.avatar || '' });
  });

  function updatePersonaDisplay(persona) {
    const nameEl = document.getElementById('agent-name-display');
    const avatarEl = document.getElementById('agent-avatar-display');
    if (nameEl && persona?.name) nameEl.textContent = persona.name;
    if (avatarEl) {
      avatarEl.innerHTML = makeAvatarHTML(persona?.avatar, true, 'width:28px;height:28px;border-radius:50%;object-fit:cover');
    }
  }

  // ---- User Profile Settings ----
  ['setting-user-name', 'setting-user-bio'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = { 'setting-user-name': 'name', 'setting-user-bio': 'bio' }[id];
        const s = await window.api.getSettings();
        if (!s.userProfile) s.userProfile = {};
        s.userProfile[key] = el.value;
        await saveSettings(s);
        agent.settings = s;
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      });
    }
  });

  document.getElementById('btn-user-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode();
    if (result.ok && result.dataUrl) {
      const s = await window.api.getSettings();
      if (!s.userProfile) s.userProfile = {};
      s.userProfile.avatar = result.dataUrl;
      await saveSettings(s);
      updateUserAvatarPreview(result.dataUrl);
      window.api.webControlSetAvatars({ ai: s.aiPersona?.avatar || '', user: result.dataUrl });
    }
  });

  document.getElementById('btn-user-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.userProfile) s.userProfile = {};
    s.userProfile.avatar = '';
    await saveSettings(s);
    updateUserAvatarPreview('');
    window.api.webControlSetAvatars({ ai: s.aiPersona?.avatar || '', user: '' });
  });

  // ---- Entropy Source Settings ----
  document.querySelectorAll('.entropy-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.entropy-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const source = btn.dataset.source;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy.source = source;
      await saveSettings(s);
      document.getElementById('entropy-trng-settings').style.display = source === 'trng' ? '' : 'none';
    });
  });

  document.querySelectorAll('.trng-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.trng-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy.trngMode = mode;
      await saveSettings(s);
      document.getElementById('trng-network-settings').style.display = mode === 'network' ? '' : 'none';
      document.getElementById('trng-serial-settings').style.display = mode === 'serial' ? '' : 'none';
      if (mode === 'serial') {
        refreshTrngPorts(true);
      }
    });
  });

  ['setting-trng-host', 'setting-trng-port'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async (e) => {
      const key = id === 'setting-trng-host' ? 'trngNetworkHost' : 'trngNetworkPort';
      const val = id === 'setting-trng-port' ? parseInt(e.target.value) : e.target.value;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy[key] = val;
      await saveSettings(s);
    });
  });

  document.getElementById('setting-trng-serial-port')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.entropy) s.entropy = {};
    s.entropy.trngSerialPort = e.target.value;
    await saveSettings(s);
  });
  document.getElementById('setting-trng-serial-baud')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.entropy) s.entropy = {};
    s.entropy.trngSerialBaud = parseInt(e.target.value);
    await saveSettings(s);
  });

  async function refreshTrngPorts(showStatus) {
    const result = await window.api.trngListPorts();
    const sel = document.getElementById('setting-trng-serial-port');
    const statusEl = document.getElementById('trng-port-status');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">选择串口...</option>';

    if (result.ok && Array.isArray(result.ports)) {
      result.ports.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = `${p.path} ${p.manufacturer || ''} ${p.serialNumber || ''}`.trim();
        sel.appendChild(opt);
      });
      if (current) sel.value = current;
      if (statusEl && showStatus) {
        statusEl.textContent = result.ports.length > 0 ? `发现 ${result.ports.length} 个串口` : '未检测到串口';
        statusEl.className = 'setting-hint';
      }
      sel.disabled = false;
      return;
    }

    const errMsg = result?.error || '串口列表获取失败';
    if (statusEl && showStatus) {
      statusEl.textContent = errMsg.includes('serialport') ? 'serialport 未安装，请先安装依赖' : `串口列表失败: ${errMsg}`;
      statusEl.className = 'setting-hint warning';
    }
    sel.disabled = true;
  }

  document.getElementById('btn-refresh-ports')?.addEventListener('click', async () => {
    refreshTrngPorts(true);
  });

  document.getElementById('btn-trng-test')?.addEventListener('click', async () => {
    const el = document.getElementById('trng-test-result');
    if (el) el.textContent = '正在测试...';
    const result = await window.api.trngTest();
    if (el) {
      if (result.ok) {
        const r = result.result;
        el.textContent = `连接成功! 抽到: ${r.name}(${r.orientation === 'reversed' ? '逆位' : '正位'}) - 熵源: ${r.entropySource}`;
        el.className = 'setting-hint success';
      } else {
        el.textContent = `连接失败: ${result.error}`;
        el.className = 'setting-hint warning';
      }
    }
  });

  // ---- Proxy Settings ----
  document.querySelectorAll('.proxy-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.proxy-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const s = await window.api.getSettings();
      if (!s.proxy) s.proxy = {};
      s.proxy.mode = mode;
      await saveSettings(s);
      document.getElementById('manual-proxy-settings').style.display = mode === 'manual' ? '' : 'none';
    });
  });

  ['setting-proxy-http', 'setting-proxy-https', 'setting-proxy-bypass'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async (e) => {
      const key = id.replace('setting-proxy-', '');
      const s = await window.api.getSettings();
      if (!s.proxy) s.proxy = {};
      s.proxy[key] = e.target.value;
      await saveSettings(s);
    });
  });

  // ---- History Page ----
  async function loadHistoryPage() {
    const list = document.getElementById('history-list');
    if (!list) return;
    const histories = await window.api.historyList();
    if (!histories || histories.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无对话历史</p></div>';
      return;
    }
    list.innerHTML = histories.map(h => {
      let timeStr = '未知时间';
      if (h.timestamp) {
        const ts = typeof h.timestamp === 'number' ? h.timestamp : Date.parse(h.timestamp);
        if (!isNaN(ts)) {
          timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
      } else if (h.createdAt) {
        const ts = typeof h.createdAt === 'number' ? h.createdAt : Date.parse(h.createdAt);
        if (!isNaN(ts)) {
          timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
      }
      return `
      <div class="history-item" data-id="${h.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || '未命名对话')}</div>
          <div class="history-time">${timeStr}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon history-continue" data-id="${h.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon history-open-workspace" data-id="${h.id}" title="打开工作目录"><i class="fa-solid fa-folder-open"></i></button>
          <button class="btn-icon history-export-json" data-id="${h.id}" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon history-export-md" data-id="${h.id}" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon history-delete" data-id="${h.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>
      `;
    }).join('');

    const sanitizeFileName = (name) => (name || '对话记录').replace(/[\\/:*?"<>|]/g, '_');
    const buildMarkdown = (conv) => {
      const title = conv.title || '未命名对话';
      const createdAt = conv.createdAt ? new Date(conv.createdAt).toLocaleString('zh-CN') : '';
      const updatedAt = conv.updatedAt ? new Date(conv.updatedAt).toLocaleString('zh-CN') : '';
      const lines = [];
      lines.push(`# ${title}`);
      lines.push('');
      if (createdAt) lines.push(`- 创建时间：${createdAt}`);
      if (updatedAt) lines.push(`- 更新时间：${updatedAt}`);
      if (conv.workspacePath) lines.push(`- 工作目录：${conv.workspacePath}`);
      lines.push('');

      (conv.messages || []).forEach(msg => {
        const role = msg.role || 'assistant';
        const roleName = role === 'user' ? '用户' : role === 'assistant' ? 'AI' : role === 'system' ? '系统' : '工具';
        lines.push(`## ${roleName}`);
        if (role === 'tool') {
          let toolContent = msg.content;
          try { toolContent = JSON.stringify(JSON.parse(msg.content), null, 2); } catch {}
          lines.push('```json');
          lines.push(toolContent || '');
          lines.push('```');
        } else {
          lines.push(msg.content || '');
        }
        lines.push('');
      });
      return lines.join('\n');
    };

    list.querySelectorAll('.history-continue').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (conv) {
          await agent.loadFromHistory(conv);
          setTitlebarTitle(agent.conversationTitle || '未命名对话');
          updateContextProgress();
          // Switch to chat page
          document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
          document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
          document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
          document.getElementById('page-chat')?.classList.add('active');
          // Replay messages
          chatMessages.innerHTML = '';
          const toolCallMap = {};
          for (const msg of (conv.messages || [])) {
            if (msg.role === 'user') {
              addMessageToChat('user', msg.content);
            } else if (msg.role === 'assistant') {
              if (msg.content) addMessageToChat('assistant', msg.content);
              if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                  const toolName = tc.function?.name || 'tool';
                  let args = {};
                  try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                  const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                  const displayName = toolDef?.desc || toolName;
                  addToolCallToChat(displayName, toolName, args);
                  if (tc.id) toolCallMap[tc.id] = toolName;
                }
              }
            } else if (msg.role === 'tool') {
              const toolName = msg.name || toolCallMap[msg.tool_call_id] || 'tool';
              let result = msg.content;
              try { result = JSON.parse(msg.content); } catch {}
              updateToolCallResult(toolName, result);
            }
          }

          requestAnimationFrame(() => {
            const last = chatMessages.lastElementChild;
            if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
          });
        }
      });
    });

    list.querySelectorAll('.history-open-workspace').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (conv?.workspacePath) {
          window.api.openFileExplorer(conv.workspacePath);
        } else {
          alert('该对话没有记录工作目录');
        }
      });
    });

    list.querySelectorAll('.history-export-json').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (!conv) return;
        const filename = `${sanitizeFileName(conv.title || '对话记录')}.json`;
        const result = await window.api.saveFileDialog({
          title: '导出对话记录(JSON)',
          defaultPath: filename,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (!result.ok || !result.path) return;
        const content = JSON.stringify(conv, null, 2);
        const saveResult = await window.api.writeFile(result.path, content);
        if (saveResult.ok) {
          showMessageModal(`已导出：${result.path}`, '导出成功', 'success');
        } else {
          showMessageModal(`导出失败：${saveResult.error || '未知错误'}`, '导出失败', 'error');
        }
      });
    });

    list.querySelectorAll('.history-export-md').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (!conv) return;
        const filename = `${sanitizeFileName(conv.title || '对话记录')}.md`;
        const result = await window.api.saveFileDialog({
          title: '导出对话记录(Markdown)',
          defaultPath: filename,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        });
        if (!result.ok || !result.path) return;
        const content = buildMarkdown(conv);
        const saveResult = await window.api.writeFile(result.path, content);
        if (saveResult.ok) {
          showMessageModal(`已导出：${result.path}`, '导出成功', 'success');
        } else {
          showMessageModal(`导出失败：${saveResult.error || '未知错误'}`, '导出失败', 'error');
        }
      });
    });

    list.querySelectorAll('.history-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.api.historyDelete(btn.dataset.id);
        if (agent.conversationId === btn.dataset.id) {
          agent.newConversation();
          chatMessages.innerHTML = '';
          setTitlebarTitle('未命名对话');
        }
        loadHistoryPage();
      });
    });
  }

  // ---- Init AI Persona Display ----
  async function initPersonaDisplay() {
    const s = await window.api.getSettings();
    if (s.aiPersona) updatePersonaDisplay(s.aiPersona);
  }
  initPersonaDisplay();

  // ---- GeoGebra Side Panel ----
  let ggbApplet = null;
  let ggbInitialized = false;
  const ggbPanel = document.getElementById('geogebra-panel');
  const btnCloseGgb = document.getElementById('btn-close-geogebra');

  window.initGeoGebra = function() {
    if (ggbInitialized) {
      ggbPanel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');
      return { ok: true, message: 'GeoGebra已显示' };
    }

    const params = {
      appName: 'classic',
      width: '100%',
      height: '100%',
      showToolBar: true,
      showAlgebraInput: true,
      showMenuBar: false,
      showAppsPicker: false,
      showKeyboard: false,
      enableRightClick: false,
      enableShiftDragZoom: true,
      showResetIcon: true,
      appletOnLoad: function() {
        ggbApplet = window.ggbApplet;
        ggbInitialized = true;
        console.log('GeoGebra loaded');
      }
    };

    const ggbApp = new GGBApplet(params, true);
    ggbApp.inject('ggb-element');
    ggbPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open');

    return { ok: true, message: 'GeoGebra已启动' };
  };

  window.evalGeoGebraCommand = async function(cmd) {
    if (!ggbApplet || typeof ggbApplet.evalCommand !== 'function') {
      return { ok: false, error: 'GeoGebra未初始化' };
    }
    if (!cmd || typeof cmd !== 'string') {
      return { ok: false, error: '命令为空' };
    }

    if (window.__ggbLastError) {
      window.__ggbLastError = null;
      window.__ggbLastErrorAt = 0;
    }

    const maxRetries = 8;
    const retryDelayMs = 200;
    const lazyModulePattern = /(Advanced|Discrete|CAS|Stats|Prover|Scripting) commands not loaded yet/i;

    const getObjectValue = (name) => {
      try {
        const type = ggbApplet.getObjectType(name);
        if (type === 'numeric') {
          const numVal = ggbApplet.getValue(name);
          return isFinite(numVal) ? numVal : ggbApplet.getValueString(name);
        }
        if (type === 'point') {
          const x = ggbApplet.getXcoord(name);
          const y = ggbApplet.getYcoord(name);
          return `(${x}, ${y})`;
        }
        return ggbApplet.getValueString(name);
      } catch {
        return null;
      }
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let label = null;
        if (typeof ggbApplet.evalCommandGetLabels === 'function') {
          label = ggbApplet.evalCommandGetLabels(cmd);
        } else {
          ggbApplet.evalCommand(cmd);
        }
        await new Promise(r => setTimeout(r, 120));
        if (window.__ggbLastError && Date.now() - (window.__ggbLastErrorAt || 0) < 2000) {
          return { ok: false, error: window.__ggbLastError.message };
        }
        const labels = (label || '').split(',').map(s => s.trim()).filter(Boolean);
        let value = null;
        if (labels.length === 1) {
          value = getObjectValue(labels[0]);
        } else if (labels.length > 1) {
          value = labels.map(n => ({ name: n, value: getObjectValue(n) }));
        }
        return { ok: true, label: label || null, value };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (lazyModulePattern.test(msg) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, retryDelayMs));
          continue;
        }
        return { ok: false, error: msg };
      }
    }

    return { ok: false, error: '命令执行超时' };
  };

  window.getAllGeoGebraObjects = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      const names = ggbApplet.getAllObjectNames();
      const objs = [];
      for (const n of names) {
        const type = ggbApplet.getObjectType(n);
        let value = ggbApplet.getValueString(n);
        
        // 对数值类型尝试获取数值
        if (type === 'numeric') {
          try {
            const numVal = ggbApplet.getValue(n);
            if (!isNaN(numVal) && isFinite(numVal)) {
              value = numVal.toString();
            }
          } catch { /* 保持原 value */ }
        }
        // 对点类型，尝试获取坐标
        else if (type === 'point') {
          try {
            const x = ggbApplet.getXcoord(n);
            const y = ggbApplet.getYcoord(n);
            if (!isNaN(x) && !isNaN(y)) {
              value = `(${x}, ${y})`;
            }
          } catch { /* 保持原 value */ }
        }
        
        objs.push({
          name: n,
          type: type,
          value: value,
          visible: ggbApplet.getVisible(n)
        });
      }
      return { ok: true, objects: objs };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  window.deleteGeoGebraObject = function(name) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      ggbApplet.deleteObject(name);
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  window.exportGeoGebraPNG = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      const png = ggbApplet.getPNGBase64(1, true, 72);
      return { ok: true, data: png };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  if (btnCloseGgb) {
    btnCloseGgb.addEventListener('click', () => {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Canvas Implementation ----
  const canvasPanel = document.getElementById('canvas-panel');
  const canvasSvg = document.getElementById('canvas-svg');
  const btnCloseCanvas = document.getElementById('btn-close-canvas');
  const canvasObjects = new Map(); // Store object references

  window.initCanvas = function() {
    if (!canvasPanel || !canvasSvg) {
      return { ok: false, error: '画布元素未找到' };
    }
    
    // Close GeoGebra if open (only one split-screen at a time)
    if (ggbPanel && !ggbPanel.classList.contains('hidden')) {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }
    
    canvasPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open'); // Reuse same CSS class for split-screen
    
    // Auto-clear canvas when initializing
    window.clearCanvas();
    
    return { ok: true, message: '画布已初始化并清空' };
  };

  window.clearCanvas = function() {
    if (!canvasSvg) {
      return { ok: false, error: '画布未初始化' };
    }
    
    // Remove all child elements
    while (canvasSvg.firstChild) {
      canvasSvg.removeChild(canvasSvg.firstChild);
    }
    canvasObjects.clear();
    
    return { ok: true, message: '画布已清空' };
  };

  window.addCanvasObject = function(type, id, attributes) {
    if (!canvasSvg) {
      return { ok: false, error: '画布未初始化' };
    }
    
    if (canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 已存在` };
    }
    
    try {
      const element = document.createElementNS('http://www.w3.org/2000/svg', type);
      element.setAttribute('id', id);
      
      // Set attributes
      for (const [key, value] of Object.entries(attributes || {})) {
        element.setAttribute(key, value);
      }
      
      canvasSvg.appendChild(element);
      canvasObjects.set(id, element);
      
      return { ok: true, message: `对象 ${id} 已添加` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.updateCanvasObject = function(id, attributes) {
    if (!canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 不存在` };
    }
    
    try {
      const element = canvasObjects.get(id);
      for (const [key, value] of Object.entries(attributes || {})) {
        element.setAttribute(key, value);
      }
      
      return { ok: true, message: `对象 ${id} 已更新` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.deleteCanvasObject = function(id) {
    if (!canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 不存在` };
    }
    
    try {
      const element = canvasObjects.get(id);
      element.remove();
      canvasObjects.delete(id);
      
      return { ok: true, message: `对象 ${id} 已删除` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.exportCanvasSVG = async function(filename, workspacePath) {
    if (!canvasSvg || !workspacePath) {
      return { ok: false, error: '画布或工作区路径未设置' };
    }
    
    try {
      // Get SVG content
      const svgContent = new XMLSerializer().serializeToString(canvasSvg);
      const fullSvg = `<?xml version="1.0" encoding="UTF-8"?>\n${svgContent}`;
      
      // Save to workspace
      const result = await window.api.writeFile(
        `${workspacePath}/${filename}`,
        fullSvg
      );
      
      if (result.ok) {
        return { ok: true, path: `${workspacePath}/${filename}`, message: 'SVG已导出' };
      } else {
        return result;
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  if (btnCloseCanvas) {
    btnCloseCanvas.addEventListener('click', () => {
      canvasPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Spreadsheet Implementation ----
  const spreadsheetPanel = document.getElementById('spreadsheet-panel');
  const spreadsheetBody = document.getElementById('spreadsheet-body');
  const btnCloseSpreadsheet = document.getElementById('btn-close-spreadsheet');
  let ssEngine = null;
  let ssUI = null;

  function ensureSpreadsheet() {
    if (!ssEngine) {
      ssEngine = new SpreadsheetEngine();
      ssUI = new SpreadsheetUI(ssEngine, 'spreadsheet-body');
    }
    // Wire up formula bar input
    const fxInput = spreadsheetPanel?.querySelector('.ss-fx');
    if (fxInput && !fxInput._bound) {
      fxInput._bound = true;
      fxInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && ssUI?.selectedCell) {
          ssEngine.setCell(ssUI.selectedCell, fxInput.value);
        }
      });
    }
    return { engine: ssEngine, ui: ssUI };
  }

  window.initSpreadsheet = function(title) {
    if (!spreadsheetPanel) return { ok: false, error: '数据表格面板元素未找到' };
    // Close other panels
    if (ggbPanel && !ggbPanel.classList.contains('hidden')) {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }
    if (canvasPanel && !canvasPanel.classList.contains('hidden')) {
      canvasPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }
    spreadsheetPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open');
    const { engine } = ensureSpreadsheet();
    if (title) engine.title = title;
    return { ok: true, message: '数据表格已打开' };
  };

  window.spreadsheetSetCells = function(entries) {
    const { engine } = ensureSpreadsheet();
    return engine.setCells(entries);
  };

  window.spreadsheetGetCells = function(range) {
    const { engine } = ensureSpreadsheet();
    return { ok: true, cells: engine.getCells(range) };
  };

  window.spreadsheetSetCellFormat = function(addr, format) {
    const { engine } = ensureSpreadsheet();
    return { ok: true, cell: engine.setCellFormat(addr, format) };
  };

  window.spreadsheetSetRangeFormat = function(range, format) {
    const { engine } = ensureSpreadsheet();
    return engine.setRangeFormat(range, format);
  };

  window.spreadsheetClearCells = function(range) {
    const { engine } = ensureSpreadsheet();
    return engine.clearCells(range);
  };

  window.spreadsheetInsertRows = function(rowNum, count) {
    const { engine } = ensureSpreadsheet();
    return engine.insertRow(rowNum, count || 1);
  };

  window.spreadsheetDeleteRows = function(rowNum, count) {
    const { engine } = ensureSpreadsheet();
    return engine.deleteRow(rowNum, count || 1);
  };

  window.spreadsheetInsertCols = function(colLetter, count) {
    const { engine } = ensureSpreadsheet();
    return engine.insertCol(colLetter, count || 1);
  };

  window.spreadsheetDeleteCols = function(colLetter, count) {
    const { engine } = ensureSpreadsheet();
    return engine.deleteCol(colLetter, count || 1);
  };

  window.spreadsheetSortRange = function(range, colLetter, ascending) {
    const { engine } = ensureSpreadsheet();
    return engine.sortRange(range, colLetter, ascending);
  };

  window.spreadsheetGetData = function() {
    const { engine } = ensureSpreadsheet();
    return { ok: true, data: engine.getData() };
  };

  window.spreadsheetExportCSV = function() {
    const { engine } = ensureSpreadsheet();
    return { ok: true, csv: engine.exportCSV() };
  };

  window.spreadsheetImportCSV = function(csv, startAddr) {
    const { engine } = ensureSpreadsheet();
    return engine.importCSV(csv, startAddr || 'A1');
  };

  if (btnCloseSpreadsheet) {
    btnCloseSpreadsheet.addEventListener('click', () => {
      spreadsheetPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Spreadsheet File Import/Export ----
  window.spreadsheetImportFile = async function(filePath) {
    const result = await window.api.spreadsheetImportFile(filePath);
    if (!result.ok) return result;
    ensureSpreadsheet();
    spreadsheetPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open');
    if (result.sheetName) ssEngine.title = result.sheetName;
    if (result.cells && result.cells.length > 0) {
      ssEngine.setCells(result.cells);
    }
    return { ok: true, message: `已导入 ${result.cells?.length || 0} 个单元格`, sheetName: result.sheetName };
  };

  window.spreadsheetExportFile = async function(filePath) {
    ensureSpreadsheet();
    const data = ssEngine.getData();
    const cells = [];
    for (const [addr, cell] of Object.entries(data.cells || {})) {
      cells.push({ addr, value: cell.formula || cell.value });
    }
    return await window.api.spreadsheetExportFile(filePath, cells, data.title || 'Sheet1');
  };

  // ---- Email Received Handler ----
  window.api.onEmailReceived((email) => {
    // Forward email content to agent as hot message
    if (agent && typeof agent.injectHotMessage === 'function') {
      const content = `[来自邮件] 发件人: ${email.from || '未知'}, 主题: ${email.subject || '无主题'}\n\n${email.text || email.html || ''}`;
      agent.injectHotMessage(content);
    }
  });

  // ---- Ask Questions (Chat Bubble) ----
  window.askQuestions = function(questions) {
    return new Promise((resolve) => {
      if (!Array.isArray(questions) || questions.length === 0) {
        resolve([]);
        return;
      }

      const answers = new Array(questions.length).fill('');
      let currentIndex = 0;

      const msg = document.createElement('div');
      msg.className = 'message assistant';
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      let avatarHTML = '';
      const persona = agent.settings?.aiPersona;
      avatarHTML = makeAvatarHTML(persona?.avatar, true);

      const body = document.createElement('div');
      body.className = 'message-body';

      const content = document.createElement('div');
      content.className = 'message-content';
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.gap = '12px';

      const header = document.createElement('div');
      header.style.fontWeight = '500';

      const optionsWrap = document.createElement('div');
      optionsWrap.style.display = 'flex';
      optionsWrap.style.flexDirection = 'column';
      optionsWrap.style.gap = '8px';

      const hint = document.createElement('div');
      hint.style.fontSize = '12px';
      hint.style.color = 'var(--error-color)';
      hint.style.display = 'none';

      const nav = document.createElement('div');
      nav.style.display = 'flex';
      nav.style.justifyContent = 'space-between';
      nav.style.gap = '8px';

      const btnPrev = document.createElement('button');
      btnPrev.className = 'btn-secondary';
      btnPrev.textContent = '上一题';

      const btnNext = document.createElement('button');
      btnNext.className = 'btn-primary';

      nav.appendChild(btnPrev);
      nav.appendChild(btnNext);

      content.appendChild(header);
      content.appendChild(optionsWrap);
      content.appendChild(hint);
      content.appendChild(nav);

      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = time;

      body.appendChild(content);
      body.appendChild(timeEl);

      msg.innerHTML = `<div class="message-avatar">${avatarHTML}</div>`;
      msg.appendChild(body);
      appendChatElement(msg);

      const baseOptions = ['选项A', '选项B', '选项C'];

      function renderQuestion() {
        const q = questions[currentIndex] || {};
        const rawOptions = Array.isArray(q.options) ? q.options : [];
        const options = baseOptions.map((fallback, i) => rawOptions[i] || fallback);
        const currentAnswer = answers[currentIndex];

        header.textContent = `${currentIndex + 1}/${questions.length} ${q.question || ''}`;
        optionsWrap.innerHTML = '';
        hint.style.display = 'none';

        const radioName = `question-${currentIndex}`;

        options.forEach((opt, idx) => {
          const label = document.createElement('label');
          label.style.display = 'flex';
          label.style.alignItems = 'center';
          label.style.gap = '8px';
          label.style.cursor = 'pointer';

          const input = document.createElement('input');
          input.type = 'radio';
          input.name = radioName;
          input.value = opt;
          input.style.accentColor = 'var(--accent-color, #4f8cff)';
          if (currentAnswer === opt) input.checked = true;

          input.addEventListener('change', () => {
            answers[currentIndex] = opt;
          });

          const text = document.createElement('span');
          const letter = String.fromCharCode(65 + idx);
          text.textContent = `${letter}. ${opt}`;

          label.appendChild(input);
          label.appendChild(text);
          optionsWrap.appendChild(label);
        });

        const customLabel = document.createElement('label');
        customLabel.style.display = 'flex';
        customLabel.style.alignItems = 'center';
        customLabel.style.gap = '8px';

        const customRadio = document.createElement('input');
        customRadio.type = 'radio';
        customRadio.name = radioName;
        customRadio.value = '__custom__';
        customRadio.style.accentColor = 'var(--accent-color, #4f8cff)';

        const customPrefix = document.createElement('span');
        customPrefix.textContent = 'D.';

        const customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.placeholder = '自定义选项';
        customInput.style.cssText = `
          flex: 1;
          padding: 8px 12px;
          border: 1px solid var(--border-color);
          border-radius: 6px;
          background-color: var(--bg-secondary);
          color: var(--text-primary);
          font-size: 14px;
          transition: border-color 0.2s, box-shadow 0.2s;
        `;
        
        // Add focus/blur styling
        customInput.addEventListener('focus', () => {
          customInput.style.borderColor = 'var(--accent-color, #4f8cff)';
          customInput.style.boxShadow = '0 0 0 2px var(--accent-bg, rgba(79, 140, 255, 0.15))';
          customRadio.checked = true;
          if (customInput.value.trim()) {
            answers[currentIndex] = customInput.value.trim();
          }
        });
        
        customInput.addEventListener('blur', () => {
          customInput.style.borderColor = 'var(--border-color)';
          customInput.style.boxShadow = 'none';
        });
        
        if (currentAnswer && !options.includes(currentAnswer)) {
          customRadio.checked = true;
          customInput.value = currentAnswer;
        }

        customInput.addEventListener('input', () => {
          if (customRadio.checked) {
            answers[currentIndex] = customInput.value.trim();
          }
        });

        customRadio.addEventListener('change', () => {
          answers[currentIndex] = customInput.value.trim();
        });

        customLabel.appendChild(customRadio);
        customLabel.appendChild(customPrefix);
        customLabel.appendChild(customInput);
        optionsWrap.appendChild(customLabel);

        btnPrev.disabled = currentIndex === 0;
        btnNext.textContent = currentIndex === questions.length - 1 ? '提交' : '下一题';
      }

      function finish() {
        // Disable all inputs
        const allInputs = optionsWrap.querySelectorAll('input');
        allInputs.forEach(inp => inp.disabled = true);
        
        // Update buttons to show submitted state
        btnPrev.style.display = 'none';
        btnNext.textContent = '已提交';
        btnNext.disabled = true;
        btnNext.className = 'btn-secondary';
        
        // Add submitted indicator
        const submittedMsg = document.createElement('div');
        submittedMsg.style.cssText = `
          margin-top: 8px;
          padding: 8px 12px;
          background: var(--success-bg, #d4edda);
          color: var(--success-color, #155724);
          border-radius: 6px;
          font-size: 14px;
          text-align: center;
        `;
        submittedMsg.innerHTML = '<i class="fa-solid fa-check-circle"></i> 问卷已提交';
        content.appendChild(submittedMsg);
        
        const result = questions.map((q, i) => ({
          question: q.question,
          answer: answers[i]
        }));
        resolve(result);
      }

      btnPrev.addEventListener('click', () => {
        if (currentIndex > 0) {
          currentIndex -= 1;
          renderQuestion();
        }
      });

      btnNext.addEventListener('click', () => {
        const answer = answers[currentIndex];
        if (!answer || !answer.trim()) {
          hint.textContent = '请选择一个选项，或填写自定义选项';
          hint.style.display = 'block';
          return;
        }

        if (currentIndex < questions.length - 1) {
          currentIndex += 1;
          renderQuestion();
          return;
        }

        finish();
      });

      renderQuestion();
    });
  };

  // ---- Confirm Modal ----
  let confirmResolve = null;
  let confirmReject = null;

  window.confirmDialog = function(message, title = '确认操作') {
    return new Promise((resolve, reject) => {
      const modal = document.getElementById('confirm-modal');
      const modalBody = document.querySelector('.confirm-modal-body');
      const modalHeader = modal?.querySelector('.modal-header h3');
      
      if (!modal || !modalBody) {
        reject(new Error('确认对话框未找到'));
        return;
      }

      confirmResolve = resolve;
      confirmReject = reject;

      if (modalHeader) {
        modalHeader.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${title}`;
      }
      modalBody.textContent = message;
      modal.classList.remove('hidden');
    });
  };

  document.getElementById('btn-close-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    modal?.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  document.getElementById('btn-cancel-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    modal?.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  document.getElementById('btn-accept-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    modal?.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(true);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  // ---- Message Modal ----
  window.showMessageModal = function(message, title = '提示', type = 'info') {
    const modal = document.getElementById('message-modal');
    const modalBody = document.querySelector('.message-modal-body');
    const modalHeader = modal?.querySelector('.modal-header h3');
    
    if (!modal || !modalBody) {
      console.error('消息对话框未找到');
      return;
    }

    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-check-circle';
    else if (type === 'error') iconClass = 'fa-exclamation-triangle';
    else if (type === 'warning') iconClass = 'fa-exclamation-circle';

    if (modalHeader) {
      modalHeader.innerHTML = `<i class="fa-solid ${iconClass}"></i> ${title}`;
    }
    modalBody.innerHTML = message.replace(/\n/g, '<br>');
    modal.classList.remove('hidden');
  };

  document.getElementById('btn-close-message')?.addEventListener('click', () => {
    const modal = document.getElementById('message-modal');
    modal?.classList.add('hidden');
  });

  document.getElementById('btn-ok-message')?.addEventListener('click', () => {
    const modal = document.getElementById('message-modal');
    modal?.classList.add('hidden');
  });

})();
