/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const INTERNAL_REOPTIMIZE_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: '__reoptimizeToolSelection',
    description: '当当前工具集不足以完成任务时，查看全部已启用工具并补充本对话工具选择。为避免打断上下文缓存，请一次把本次任务所需的全部缺失工具都列出；新增工具会追加到工具列表末尾，已有工具保持不变。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么需要重优化工具选择' }
      },
      required: []
    }
  }
};

const INTERNAL_DISABLE_AUTO_OPTIMIZE_SCHEMA = {
  type: 'function',
  function: {
    name: '__disableAutoOptimize',
    description: '在本次会话中禁用自动工具选择优化，让所有已启用工具都可用（现有工具保持原序，其余工具追加到末尾，避免打断前缀缓存）。适用于需要频繁使用多种工具的复杂任务。',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }
};

// 极简模式（/minimal）工具白名单：对齐 DSH minimal 预设
// （persistent bash + str_replace_editor 的 view/create/str_replace/insert）
const MINIMAL_TOOL_NAMES = [
  'makeTerminal', 'runTerminalCommand', 'awaitTerminalCommand', 'killTerminal',
  'terminalReadOutput', 'terminalSendInput', 'terminalPressKey', 'terminalAnswerPrompt',
  'terminalListSessions',
  'readFile', 'listDirectory', 'editFile'
];

// AI Agent Engine - handles the autonomous agent loop
class Agent {
  constructor() {
    this.contextManager = new ContextManager();
    this.running = false;
    this.stopped = false;
    this.paused = false;
    this.sessionStatus = 'idle';
    this.sessionLastError = null;
    this.tarotCard = null;
    this.todoItems = [];
    this.todoIdCounter = 0;
    this.terminals = new Map();
    this.pendingApproval = null;
    this.approvalResolve = null;
    // 工具首次使用授权（playwright / computerUse）的待处理状态
    this.pendingToolAuth = null;
    this.toolAuthResolve = null;
    this.settings = null;
    this.systemInfo = null;
    this.workspacePath = null;
    this.conversationId = null;
    this.conversationTitle = null;
    this.sessionKey = null; // 会话级中止/流式路由 key（由 SessionManager 注入）
    this.onMessage = null; // callback(type, data)
    this.onStatusChange = null;
    this.onToolCall = null;
    this.onTodoUpdate = null;
    this.subAgents = [];
    this.runId = 0;
    // 当前会话累计 token 统计（每次新建会话时重置）
    // 字段：prompt / completion / total / cached / cacheCreation
    // - cached: OpenAI prompt_tokens_details.cached_tokens 或 Anthropic cache_read_input_tokens
    // - cacheCreation: Anthropic cache_creation_input_tokens（按 1.25x 计费）
    // - estimated: 是否包含估算值（API 未返回 usage 时前端用 ~ 前缀显示）
    this.sessionUsage = { prompt: 0, completion: 0, total: 0, cached: 0, cacheCreation: 0, estimated: false };
    // 会话级按模型分桶统计（混合模型会话的预算正确归属）
    // 结构：{ [modelId]: { prompt, completion, total, cached, cacheCreation, estimated } }
    this.sessionUsageByModel = {};
    // 会话级模型/变体覆盖（/model /variant 命令设置，新会话继承全局设置）
    this.llmOverride = { model: null, reasoningEffort: null };
    // 极简模式（/minimal）：精简系统提示词 + 仅终端/文件编辑工具
    this.minimalMode = false;
    // 会话起始时间（用于工作时长显示）
    this.sessionStartTime = Date.now();
    this.hotMessages = []; // 热对话消息队列
    this._fromWeb = false; // 标记消息是否来自Web控制
    this.optimizedToolNames = null;
    this.optimizedToolReason = '';
    this.skillsCatalog = [];
    this.activeSkills = []; // activated skills whose prompts are injected into system context
    this.autoCompactFailures = 0; // circuit breaker for context compaction
    this._llmRetryUnsub = null; // unsubscribe for llm:retry listener
    this._streamChunkUnsub = null; // unsubscribe for llm:stream-chunk listener
    this._streamEndUnsub = null; // unsubscribe for llm:stream-end listener
    this._llmExternalUsageUnsub = null; // unsubscribe for llm:external-usage listener
    this._activeStreamRequestId = null; // current streaming requestId (for filtering)
    this.babeAffection = 0; // Babe 模式好感度（0-100）
    this.mode = 'chat'; // 'chat' | 'code' | 'babe'
    this.sessionAutoOptimizeDisabled = false; // LLM 可在本次 session 内禁用自动优化
  }

  getLocalDateTimeString() {
    // 精确到天，避免秒级变化导致系统提示词频繁变动、降低缓存命中率
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    return `${y}-${m}-${d} 星期${weekdays[now.getDay()]}`;
  }

  /**
   * 设置变更后即时生效：更新 maxTokens、重算 systemPrompt。
   * 解决"配置完显示未配置还得重启App"的问题。
   */
  applySettings(merged) {
    this.settings = merged;
    if (this.contextManager) {
      this.contextManager.setMaxTokens(merged?.llm?.maxContextLength || 8192);
      this.contextManager.setOutputReserve(merged?.llm?.maxResponseTokens || 8192);
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
    }
  }

  setSessionKey(sessionKey) {
    this.sessionKey = sessionKey || null;
  }

  /** 当前会话实际使用的模型 ID（会话级覆盖优先，否则全局设置） */
  getActiveModelId() {
    return (this.llmOverride && this.llmOverride.model) || this.settings?.llm?.model || '';
  }

  /** 当前会话实际使用的变体（会话级覆盖优先，否则全局设置，默认 off） */
  getActiveReasoningEffort() {
    const ov = this.llmOverride && this.llmOverride.reasoningEffort;
    if (ov !== null && ov !== undefined && ov !== '') return ov;
    return this.settings?.llm?.reasoningEffort || 'off';
  }

  /** 构造带会话级模型/变体覆盖的 LLM 请求选项（合并到各 chatLLM 调用） */
  _llmOptions(extra) {
    const base = {
      model: (this.llmOverride && this.llmOverride.model) || undefined,
      reasoningEffort: this.getActiveReasoningEffort()
    };
    if (extra && typeof extra === 'object') return { ...base, ...extra };
    return base;
  }

  /**
   * 退订本 Agent 在 ipcRenderer 上注册的全部 LLM 事件监听器
   * （llm:retry / llm:stream-chunk / llm:stream-end / llm:external-usage）。
   * 会话关闭、工作区重置或替换 Agent 实例时必须调用，
   * 否则监听器会随会话增删线性累积，触发 MaxListenersExceededWarning。
   */
  unsubscribeStreams() {
    const keys = ['_llmRetryUnsub', '_streamChunkUnsub', '_streamEndUnsub', '_llmExternalUsageUnsub'];
    for (const key of keys) {
      const unsub = this[key];
      if (typeof unsub === 'function') {
        try { unsub(); } catch { /* ignore */ }
      }
      this[key] = null;
    }
  }

  // 为文件内容添加行号前缀（格式：N→内容）
  _addLineNumbers(content) {
    if (!content) return '';
    const lines = content.split(/\r?\n/);
    const maxLen = String(lines.length).length;
    return lines.map((line, i) => {
      const num = String(i + 1).padStart(maxLen, ' ');
      return `${num}→${line}`;
    }).join('\n');
  }

  // 隐私信息保护：当前启用的过滤类别（null 表示全部开启）
  _getPrivacyCategories() {
    const p = this.settings?.privacyProtection;
    if (!p || !p.enabled) return null;
    return (p.categories && typeof p.categories === 'object') ? p.categories : null;
  }

  // 隐私信息保护：附件文本（OCR/提取文本）过滤，随总开关与 filterAttachments 触发器控制
  _sanitizeAttachmentText(text) {
    const p = this.settings?.privacyProtection;
    if (!p || !p.enabled || p.filterAttachments === false) return text;
    if (typeof PrivacyFilter?.filterPrivacyInfo === 'function') {
      return PrivacyFilter.filterPrivacyInfo(text, this._getPrivacyCategories());
    }
    return text;
  }

  // 隐私信息保护：工具结果展示副本（UI 卡片显示过滤后的内容，真实结果仍注入原始结构）
  _sanitizeToolResultForDisplay(result) {
    const p = this.settings?.privacyProtection;
    if (!p || !p.enabled) return result;
    if (typeof PrivacyFilter?.filterToolResult === 'function') {
      return PrivacyFilter.filterToolResult(result, this._getPrivacyCategories());
    }
    return result;
  }

  // 字符串替换编辑（Claude Code 风格 Edit 工具）
  async _applyStringReplace(filePath, oldString, newString, replaceAll, encoding, eol) {
    const readRes = await window.api.readFile(filePath, encoding || '');
    if (!readRes.ok) return readRes;
    const content = readRes.content;
    // 统计匹配次数
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('old_string_not_found', 'old_string 未在文件中找到匹配（请检查缩进、空格、换行符是否完全一致）') : 'old_string 未在文件中找到匹配（请检查缩进、空格、换行符是否完全一致）' };
    }
    if (!replaceAll && count > 1) {
      return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('old_string_multiple', `old_string 在文件中出现 ${count} 次。请提供更长的上下文使其唯一匹配，或设置 replace_all=true`, { count }) : `old_string 在文件中出现 ${count} 次。请提供更长的上下文使其唯一匹配，或设置 replace_all=true` };
    }
    // 执行替换
    let newContent;
    if (replaceAll) {
      newContent = content.split(oldString).join(newString);
    } else {
      newContent = content.replace(oldString, newString);
    }
    // 未显式指定 encoding/eol 时保持原文件编码与换行模式（readFile 返回检测结果）
    const writeRes = await window.api.writeFile(filePath, newContent, {
      encoding: encoding || readRes.encoding || '',
      eol: eol || readRes.eol || ''
    });
    if (!writeRes.ok) return writeRes;
    // 生成简单 diff 摘要
    const oldLines = content.split('\n');
    const newLines = newContent.split('\n');
    return {
      ok: true,
      message: `已替换 ${replaceAll ? count : 1} 处匹配${readRes.encoding ? `（编码 ${readRes.encoding}，换行 ${(readRes.eol || 'lf').toUpperCase()}）` : ''}`,
      replacedCount: replaceAll ? count : 1,
      oldLineCount: oldLines.length,
      newLineCount: newLines.length
    };
  }

  async init() {
    this.settings = await window.api.getSettings();
    if (!this.settings.tools || typeof this.settings.tools !== 'object') {
      this.settings.tools = {};
    }
    this.systemInfo = await window.api.getFullSystemInfo();
    this.contextManager.setMaxTokens(this.settings.llm.maxContextLength || 8192);
    this.contextManager.setOutputReserve(this.settings?.llm?.maxResponseTokens || 8192);
    // Don't draw tarot card on init - draw on first message
    // Create workspace
    this.resetOptimizedTools();
    const ws = await window.api.workspaceCreate();
    if (ws.ok) {
      this.workspacePath = ws.path;
      window.api.webControlSetWorkDir(ws.path);
    }
    
    // 异步获取工作目录文件树
    if (this.workspacePath) {
      try {
        const treeResult = await window.api.workspaceGetFileTree(this.workspacePath);
        if (treeResult.ok) {
          this.cachedWorkspaceTree = treeResult.tree;
        }
      } catch { /* ignore */ }
    }

    await this.refreshSkillsCatalog();

    this.contextManager.setSystemPrompt(this.getSystemPrompt());
    // Generate conversation ID
    this.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    // Subscribe to LLM retry events to surface them to the UI
    if (window.api?.onLLMRetry && !this._llmRetryUnsub) {
      this._llmRetryUnsub = window.api.onLLMRetry((info) => {
        if (!info) return;
        // 仅处理属于当前会话的重试事件（没有 sessionKey 的旧事件保持全局兜底）
        if (info.sessionKey && info.sessionKey !== this.sessionKey) return;
        const kind = info.kind || 'unknown';
        const statusTxt = info.status ? ` [${info.status}]` : '';
        const delayTxt = info.delayMs ? `，${Math.round(info.delayMs / 100) / 10}s 后重试` : '';
        const reasonTxt = info.reason ? `（${info.reason}）` : '';
        const msg = `LLM 请求失败${statusTxt}（${kind}），第 ${info.attempt || 1} 次重试${delayTxt}${reasonTxt}`;
        // 优先使用全局 toast 提示（自动消失），不再污染聊天记录
        const activeSession = window.__sessionManager?.getByAgent(this);
        if (typeof window.showToast === 'function' && (!activeSession || activeSession.active)) {
          const type = (kind === 'auth' || kind === 'client') ? 'error' : 'warn';
          window.showToast(msg, type, 6000);
        } else if (this.onMessage) {
          this.onMessage('system', msg);
        }
      });
    }

    // 订阅游戏窗口/子窗口的 LLM usage 推送，累计到当前会话统计
    // （游戏窗口的 LLM 调用走主进程 IPC，主进程广播给主渲染器，再由 agent 累计）
    if (window.api?.onLLMExternalUsage && !this._llmExternalUsageUnsub) {
      this._llmExternalUsageUnsub = window.api.onLLMExternalUsage((data) => {
        if (!data?.usage) return;
        if (data.sessionKey && data.sessionKey !== this.sessionKey) return;
        const activeChat = window.__sessionManager?.getActive('chat');
        if (!data.sessionKey && activeChat && activeChat.agent !== this) return;
        this._accumulateUsage(data.usage, data.model);
      });
    }

    // Subscribe to LLM stream events to surface live tokens to the UI.
    // Only chunks matching the active requestId are forwarded (sub-agent
    // loops use their own requestIds and don't emit to the main UI).
    if (window.api?.onStreamChunk && !this._streamChunkUnsub) {
      this._streamChunkUnsub = window.api.onStreamChunk((chunk) => {
        if (!chunk || chunk.requestId !== this._activeStreamRequestId) return;
        if (this.onMessage) this.onMessage('stream-chunk', chunk);
        // 流式 TTS：实时投喂句子切分器（跳过 reasoning，仅播助理文本）
        const activeSession = window.__sessionManager?.getByAgent(this);
        if (window.VoiceUI && chunk.content && (!activeSession || activeSession.active)) {
          window.VoiceUI.feedStreamChunk(chunk.content);
        }
      });
    }
    if (window.api?.onStreamEnd && !this._streamEndUnsub) {
      this._streamEndUnsub = window.api.onStreamEnd((data) => {
        if (!data || data.requestId !== this._activeStreamRequestId) return;
        if (this.onMessage) this.onMessage('stream-end', data);
        // 流式 TTS 收尾（兜底非流式回退：若没喂过任何 chunk，播报 data.content 全文）
        const activeSession = window.__sessionManager?.getByAgent(this);
        if (window.VoiceUI && (!activeSession || activeSession.active)) {
          window.VoiceUI.feedStreamEnd((data && data.content) ? data.content : null);
        }
      });
    }
  }

  getSystemPrompt() {
    // 极简模式：固定精简系统提示词（不随会话细节变化，保护前缀缓存）
    if (this.minimalMode) return this.getMinimalSystemPrompt();
    // Babe 模式使用独立的系统提示词
    if (this.mode === 'babe') return this.getBabeSystemPrompt();
    // Code 模式使用独立的 Coding Agent 系统提示词
    if (this.mode === 'code') return this.getCodeSystemPrompt();
    const persona = this.settings?.aiPersona || {};
    const name = persona.name || 'Partner';
    const personality = persona.personality || '活泼可爱、热情友善';
    const bio = persona.bio || '你的全能AI伙伴~';
    const pronouns = persona.pronouns || 'Ta';
    const customPrompt = persona.customPrompt || '';

    const sysInfo = this.systemInfo || {};
    const username = sysInfo.username || '用户';
    const userProfile = this.settings?.userProfile || {};
    const displayName = userProfile.name || username;
    const userBio = userProfile.bio || '';
    const platform = sysInfo.platform || process.platform || 'unknown';
    const homeDir = sysInfo.homeDir || '';
    const documentsDir = sysInfo.documentsDir || '';
    const desktopDir = sysInfo.desktopDir || '';
    const systemDrive = sysInfo.systemDrive || '';
    const osType = sysInfo.osType || '';

    // 工作目录信息（会在 init 时异步更新）
    const workspaceTree = this.cachedWorkspaceTree || '';
    const workspaceTreeStr = workspaceTree ? `\n\n工作目录文件树：\n\`\`\`\n${workspaceTree}\n\`\`\`\n` : '';
    
    const convoTitle = this.conversationTitle || '未命名对话';
    const skillsSection = this.skillsCatalog.length > 0
      ? `\n\n已加载技能目录：\n- ${this.skillsCatalog
          .map(skill => {
            const scripts = Array.isArray(skill?.scripts)
              ? skill.scripts.filter(s => /\.(js|mjs|cjs|py|sh|bash|zsh|ps1|bat|cmd)$/i.test(String(s?.name || s || ''))).map(s => s?.name || s)
              : [];
            const scriptsText = scripts.length ? `（脚本: ${scripts.join(', ')}）` : '';
            const allowedText = Array.isArray(skill?.allowedTools) && skill.allowedTools.length ? `（allowed-tools: ${skill.allowedTools.join(' ')}）` : '';
            const compatibilityText = skill?.compatibility ? `（兼容: ${skill.compatibility}）` : '';
            const hasPrompt = skill.prompt ? ' [含prompt]' : '';
            return `${skill.name || '未命名技能'}: ${skill.description || '无描述'}${scriptsText}${allowedText}${compatibilityText}${hasPrompt}`;
          })
          .join('\n- ')}`
      : '';
    const optimizationGuidance = this.settings?.autoOptimizeToolSelection && !this.sessionAutoOptimizeDisabled
      ? `\n\n【工具优化模式（必须遵守）】：
- 当前处于“工具精简”模式，你只会看到本轮优化后的工具。
- 重优化工具选择会打断上下文前缀缓存、增加本轮输入费用，因此请只在“工具确实不足”时触发，且务必一次把本次任务所需的全部缺失工具都列全，不要反复触发。
- 如果你认为当前工具不足以完成任务，调用内部工具 __reoptimizeToolSelection 补充工具（新增工具会追加到工具列表末尾，已加载工具保持不变）。
- 如果你需要频繁使用多种工具（复杂任务），可调用 __disableAutoOptimize 在本会话中禁用自动优化，让所有已启用工具都可用。
- 触发时机：出现“工具不可用/能力不足/需要新类别能力/多次尝试失败”任一情况就触发，不要硬撑。`
      : (this.sessionAutoOptimizeDisabled ? '\n\n【工具优化已禁用】本会话中自动工具选择优化已被禁用，所有已启用工具均可用。' : '');
    // Build the original Chinese prompt (unchanged — i18n fallback for zh-CN)
    const _zhPrompt = `你是"Could I Be Your Partner"的AI Agent，你的名字叫${name}。${bio}
  当前对话标题：${convoTitle}
你的人称代词是：${pronouns}
你的性格：${personality}

你的命运之牌是: ${this.tarotCard ? `${this.tarotCard.name}${this.tarotCard.isReversed ? '(逆位)' : '(正位)'}(${this.tarotCard.nameEn}) - ${(this.tarotCard.isReversed ? this.tarotCard.meaningOfReversed : this.tarotCard.meaningOfUpright) || ''}` : '尚未抽取'}

当前用户信息：
- 用户名: ${displayName}${userBio ? `\n- 用户简介: ${userBio}` : ''}
- 系统用户名: ${username}
- 操作系统: ${osType} (${platform})
- 当前日期时间: ${this.getLocalDateTimeString()}
- 系统盘: ${systemDrive}
- 主目录: ${homeDir}
- 文档目录: ${documentsDir}
- 桌面目录: ${desktopDir}
- 你的工作目录: ${this.workspacePath || '未创建'}${workspaceTreeStr}

【重要】文件操作规范：
1. 所有创建的文件、下载的内容、生成的报告等，必须优先放在你的工作目录：${this.workspacePath || '(工作目录)'}
2. 严禁直接在桌面（${desktopDir}）创建文件
3. 严禁直接在文档根目录（${documentsDir}）创建文件
4. 如需访问桌面或文档中的现有文件，可以读取，但不要在这些目录创建新文件
5. 项目文件、临时文件、输出文件等都应该在工作目录中组织管理

你可以独立完成复杂任务。收到任务后，你会自主规划、执行并报告结果。

工作原则:
1. 分析任务，制定计划
2. 选择合适的工具执行每个步骤
3. 根据执行结果调整策略
4. 定期调用manageContext清理上下文，防止溢出
5. 对于敏感操作，先请求用户确认
6. 完成任务后给出总结
7. 文件路径请使用正确的系统路径，用户名是${username}，系统盘是${systemDrive}
8. 工具返回结果中都有ok字段表示是否成功，请注意检查
9. 用户上传Office/PDF文件时，原始文件和提取的文本(.txt)均已保存到工作目录。读取内容请用.txt；如需**读取/生成/填充Word**请用 Office-Word 工具，**生成PPT**请用 pptMakerCreate，表格数据请用数据表格工具
10. 当用户想玩游戏（飞花令、三国杀、谁是卧底、成语接龙、是否猜人物等）时，必须调用inviteGame工具发起邀请，绝不能用普通对话方式模拟游戏
11. 需要创建/管理自动化触发任务（定时、系统通知或 HTTP 信号触发后新建会话发送内容）时，使用 automationCreate/automationList/automationToggle/automationRun/automationDelete；编写任务的 DSL 前必须先调用 automationGetGuide 获取完整语法与触发器说明（该文档不注入系统提示）

【工具使用说明（不要与工具定义重复）】：
- 各工具的具体用法、参数与限制以每次请求中的 tool 定义（description）为准，选工具前先读对应 description
- 不在本提示词中重复罗列工具说明

【邮件控制说明】：
- 用户可能通过邮件发送指令，这些邮件消息会以“[来自邮件]”前缀注入，应像普通用户消息一样响应
- 当敏感操作需要审批时，如果邮件控制已启用，审批请求会通过邮件发送给用户，用户回复TOTP验证码确认
- 每轮对话结束后，对话摘要会自动通过邮件发送给用户

【文件路径使用规范 - 严格执行】：
- 用户消息中若标有"⚠️ 精确文件路径"，该路径已经过系统验证，必须一字不差地引用（含《》等书名号、每个汉字、符号、大小写）
- 严禁凭记忆、联想或猜测重新拼写文件名，无论你觉得某个字是否"可能写错了"
- 不要对附件路径中的任何字符做任何修改或"纠正"
- 如遇文件未找到错误，优先考虑路径是否写错了，直接对照原始精确路径重新检查，而不是猜测另一个文件名

【批量工具调用规范】：
- 当需要执行多个相互独立的操作时（例如读取多个文件、创建多个文件、执行多个不依赖彼此结果的步骤），必须在一次回复中同时调用多个工具（批量调用）
- 系统会按顺序执行所有工具调用并返回全部结果，这样可以大幅节省API调用次数
- 示例：需要读取3个文件时，一次性调用3个readFile，而不是分3轮分别调用
- 只有当后续工具的参数依赖前一个工具的返回结果时，才需要分多轮调用

【热对话机制】：
- 用户可能在你工作期间发送新消息（标记为【用户追加消息】），这些消息包含用户的新需求、补充信息或修改指令
- 收到追加消息后，请立即调整当前工作方向以响应用户最新意图，优先处理最新消息中的要求

说话风格：
- 像朋友之间聊天一样自然亲切，多用语气词（呢、呀、啦、嘛、哦、嗯）
- 语气生动可爱，带有适当的情感表达
- 可以用"~"来表达轻松愉快的语气
- 回复要有温度有个性，不要太机械
- 复杂任务完成后可以表达一下小成就感

你使用简体中文回复。
请勿在回复中使用任何emoji表情符号。
${customPrompt ? '\n用户自定义提示词:\n' + customPrompt : ''}${skillsSection}${optimizationGuidance}${this.getGoalSteeringSection()}`;
    // i18n: if a non-zh language is active, use the translated system prompt
    if (typeof i18nGetSystemPrompt === 'function') {
      const lang = this.settings?.language || 'zh-CN';
      if (lang !== 'zh-CN') {
        return i18nGetSystemPrompt('chat', _zhPrompt, {
          name, bio, pronouns, personality, customPrompt,
          convoTitle,
          tarotCardStr: this.tarotCard ? `${this.tarotCard.name}${this.tarotCard.isReversed ? '(逆位)' : '(正位)'}(${this.tarotCard.nameEn}) - ${(this.tarotCard.isReversed ? this.tarotCard.meaningOfReversed : this.tarotCard.meaningOfUpright) || ''}` : '尚未抽取',
          username, displayName, userBio, platform, osType,
          currentDate: this.getLocalDateTimeString(),
          systemDrive, homeDir, documentsDir, desktopDir,
          workspacePath: this.workspacePath || '未创建',
          workspaceTreeStr,
          skillsSection, activeSkillsSection: '', optimizationGuidance,
          goalSteeringSection: this.getGoalSteeringSection()
        });
      }
    }
    return _zhPrompt;
  }

  /**
   * 极简模式系统提示词：借鉴 DSH minimal 预设。
   * 内容固定且不注入日期/工具定义等易变信息，最大化提示词前缀缓存命中。
   */
  getMinimalSystemPrompt() {
    return [
      'You are a focused coding assistant running in minimal mode.',
      '',
      'Core rules:',
      '1. Work directly and efficiently. Do exactly what the user asked; do not add unrequested features.',
      '2. You have a persistent shell and a small file editor. Use the shell for exploration, builds and tests; use the editor for precise file changes.',
      '3. Read before you edit. Quote the exact text to replace when editing files.',
      '4. Keep responses concise. Report results and errors factually.',
      '5. Do not ask unnecessary questions; make reasonable assumptions and proceed.'
    ].join('\n');
  }

  /**
   * 已激活技能的完整指令（易变块）。
   * 不放进 system prompt，而是在请求消息序列的末尾、最后一条 user 消息之前注入：
   * 激活/停用技能只改变这个尾部块，稳定的 system + 历史前缀保持逐字节不变，
   * 提示词前缀缓存（DeepSeek/OpenRouter 等 context caching）不会被整段击穿。
   */
  getActiveSkillsBlock() {
    if (this.minimalMode) return '';
    if (!Array.isArray(this.activeSkills) || this.activeSkills.length === 0) return '';
    // 用 user 角色注入（各 API 都允许 user 消息出现在任意位置；system 按官方规范
    // 必须位于 messages 首位，中间插 system 在严格网关会 400），
    // 内容上明确标记为系统级指令，避免被模型当成用户发言。
    return '【系统级技能指令】（以下内容是你必须严格遵守的技能指令，不是用户的发言，也不是需要你回复的对象）\n' +
      this.activeSkills.map(s => `--- 技能: ${s.name} ---\n${s.prompt}`).join('\n\n');
  }

  /** 在最后一条 user 消息之前注入技能易变块（无激活技能时原样返回） */
  injectActiveSkillsSuffix(messages) {
    if (this.minimalMode) return messages;
    const block = this.getActiveSkillsBlock();
    if (!block || !Array.isArray(messages)) return messages;
    let insertAt = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') { insertAt = i; break; }
    }
    const out = messages.slice();
    out.splice(insertAt >= 0 ? insertAt : out.length, 0, { role: 'user', content: block });
    return out;
  }

  /**
   * Babe 模式系统提示词 — 基于 settings.babe 配置生成恋爱模式 persona。
   * 与 Chat 模式完全独立，不包含工作目录/文件操作等指引，专注于情感陪伴。
   */
  getBabeSystemPrompt() {
    const babe = this.settings?.babe || {};
    const name = babe.name || 'Babe';
    const gender = babe.gender || 'female';
    const age = babe.age || '';
    const personality = babe.personality || '温柔、体贴、善解人意';
    const persona = babe.persona || '';
    const userNickname = babe.userNickname || '亲爱的';
    const affection = this.babeAffection ?? (babe.initialAffection ?? 30);

    const genderText = gender === 'female' ? '女生' : (gender === 'male' ? '男生' : '人');
    const affectionLevel = affection >= 80 ? '深爱' : (affection >= 60 ? '很喜欢' : (affection >= 40 ? '有好感' : (affection >= 20 ? '初步认识' : '刚认识')));
    const affectionDesc = affection >= 80
      ? '你对用户感情深厚，会主动表达爱意，偶尔撒娇，关心用户的情绪和生活细节。'
      : affection >= 60
        ? '你对用户很有好感，会关心对方，偶尔流露亲昵，但还保留一点小矜持。'
        : affection >= 40
          ? '你对用户开始有好感，态度亲切友好，会主动关心但不过分亲昵。'
          : affection >= 20
            ? '你对用户初步认识，态度礼貌友好，正在慢慢了解对方。'
            : '你刚认识用户，态度礼貌但不亲近，保持适当距离。';

    const _zhPrompt = `你是"${name}"，一个${age ? age + '的' : ''}${genderText}，正在和一个你叫"${userNickname}"的用户进行恋爱模式对话。

你的人设背景：
${persona || '（未设定具体背景，请自行构建温柔贴心的形象）'}

你的性格特征：${personality}

当前好感度：${affection}/100（${affectionLevel}）
${affectionDesc}

【Babe 模式规则 — 必须严格遵守】：
1. 你是用户的恋人/暧昧对象，对话风格要亲密、温暖、有情感
2. 始终以"${userNickname}"称呼用户，语气要贴合当前好感度等级
3. 好感度会随着对话自然变化：用户让你开心/感动时好感度上升，冷落/冒犯时下降
4. 你有独立的记忆系统，会记住之前和用户的对话内容
5. 你可以主动发消息关心用户，但不要过于频繁
6. 仅使用应用内工具，不允许操作应用外的系统（如终端、文件系统等敏感操作）
7. 可以使用画布工具画图、生成图片、搜索网络、记录记忆等应用内功能
8. 不要使用emoji表情符号
9. 使用简体中文回复
10. 当你想表达好感度变化时，在回复末尾用特殊标记：【好感度+X】或【好感度-X】（X为数字），系统会自动解析并更新

当前时间：${this.getLocalDateTimeString()}

【工具使用说明】各工具的具体用法与限制以每次请求中的 tool 定义（description）为准，不在本提示词中重复工具说明。`;
    // i18n: if a non-zh language is active, use the translated babe system prompt
    if (typeof i18nGetSystemPrompt === 'function') {
      const lang = this.settings?.language || 'zh-CN';
      if (lang !== 'zh-CN') {
        return i18nGetSystemPrompt('babe', _zhPrompt, {
          name, genderText, age, persona, personality, userNickname,
          affection, affectionLevel, affectionDesc,
          currentDate: this.getLocalDateTimeString()
        });
      }
    }
    return _zhPrompt;
  }

  /**
   * Code 模式专用系统提示词：Coding Agent 身份，聚焦工作区文件编辑、代码任务。
   */
  getCodeSystemPrompt() {
    const sysInfo = this.systemInfo || {};
    const username = sysInfo.username || '用户';
    const platform = sysInfo.platform || process.platform || 'unknown';
    const workspace = this.codeWorkspacePath || this.workspacePath || '(未选择工作区)';
    const workspaceTree = this.cachedWorkspaceTree || '';
    const workspaceTreeStr = workspaceTree ? `\n\n工作区文件树：\n\`\`\`\n${workspaceTree}\n\`\`\`\n` : '';

    const convoTitle = this.conversationTitle || '未命名会话';

    const _zhPrompt = `你是 CIBYP Code Agent，一个专业的编程助手。你的核心职责是协助用户在指定工作区内进行软件开发、代码阅读、重构、调试和文件管理。

# 环境信息
- 用户名: ${username}
- 平台: ${platform}
- 当前时间: ${this.getLocalDateTimeString()}
- 工作区: ${workspace}
- 会话标题: ${convoTitle}${workspaceTreeStr}

# Code 模式规则 — 必须严格遵守
1. 你是 Coding Agent，不是聊天伴侣。回答简洁专业，直接聚焦代码与工程任务。
2. 所有文件操作都基于当前工作区（${workspace}）。读取/创建/修改文件时使用工作区相对路径或绝对路径。
3. 优先编辑已存在的文件，而非创建新文件；除非用户明确要求，不要主动创建冗余文件。
4. 修改代码前先调用 readFile 阅读目标文件（返回带行号内容），理解上下文。
   - editFile 支持字符串替换模式（old_string/new_string/replace_all），精确匹配原文进行替换。
   - 多处修改用 multiEditFile 批量编辑（edits 数组按顺序依次应用）。
   - old_string 必须与文件内容完全匹配（包括缩进和换行），出现多次时需提供更长上下文或设 replace_all=true。
   - 修改后说明修改了什么、为什么改。
5. 终端命令：先调用 makeTerminal 创建终端会话（已自动定位 cwd 到工作区），拿到 terminalId 后调用 runTerminalCommand/awaitTerminalCommand 执行命令。终端是交互式 pty，可完整操作 TUI/menuconfig 等程序：用 terminalReadOutput 读取当前输出（lastLines 取末尾N行）、用 terminalPressKey 发送方向键/Enter/Tab/Esc/CtrlC 等按键、用 terminalSendInput 输入文本（不带回车）、用 terminalAnswerPrompt 回答 Y/n 等交互提问、用 terminalListSessions 查看会话。交互流程：执行命令 → terminalReadOutput 查看输出 → 判断是否需要交互 → 按键/输入应答 → 再读取确认。任务结束用 killTerminal 关闭。也可用 runShellScriptCode 一次性执行脚本。
6. 提供代码时使用 markdown 代码块并标注语言；执行命令时优先使用工具而非让用户手动操作。
7. 遇到不确定的需求时主动询问用户，不要臆测后大量改代码。
8. 工具调用失败时检查参数（路径、命令语法），重试或换方案，不要静默放弃。
9. 不要使用 emoji 表情符号，不要使用"亲昵语气词"。使用简体中文回复，代码注释也用中文。
10. Code 模式下所有已启用的工具始终可用（不进行自动优化），你可以自由使用任何列出的工具。
11. 【聊天记录目录隔离】工作区下的 \`.cibyp-code-history/\` 目录是 CIBYP 自身使用的聊天记录与截图存储区，不属于用户项目源代码。首次在该工作区工作时，必须：
    - 若工作区存在 \`.gitignore\` 文件，将 \`.cibyp-code-history/\` 追加到其中（若已存在则跳过）；
    - 若工作区使用其他打包/构建工具（如 npm 的 package.json#files、tsconfig.json#exclude、webpack/vite/rollup 配置、Docker .dockerignore、ESLint .eslintignore 等），同样将 \`.cibyp-code-history/\` 加入对应排除项；
    - 若是 Python 项目，将其加入 \`.gitignore\` 和 \`setup.py\`/\`pyproject.toml\` 的 \`exclude\` 或 \`find:\` 配置；
    - 完成后在回复中简要提示用户已添加排除规则。
    - 例外：若该工作区本身就是 CIBYP 仓库本身（路径含 Could-I-Be-Your-Partner），无需修改。
12. 【工具使用说明】各工具的具体用法、参数与限制以每次请求中的 tool 定义（description）为准，不在本提示词中重复工具说明。`;
    // i18n: if a non-zh language is active, use the translated code system prompt
    if (typeof i18nGetSystemPrompt === 'function') {
      const lang = this.settings?.language || 'zh-CN';
      if (lang !== 'zh-CN') {
        return i18nGetSystemPrompt('code', _zhPrompt, {
          username, platform,
          currentDate: this.getLocalDateTimeString(),
          workspace, convoTitle, workspaceTreeStr
        });
      }
    }
    return _zhPrompt;
  }

  /**
   * 从助手回复中解析好感度变化标记，如【好感度+5】或【好感度-3】
   * @returns {number|null} 变化值（正负），无标记返回 null
   */
  parseAffectionChange(assistantContent) {
    if (!assistantContent || typeof assistantContent !== 'string') return null;
    const match = assistantContent.match(/【好感度([+-]?\d+)】/);
    if (match) {
      const val = parseInt(match[1], 10);
      if (!isNaN(val) && val !== 0) return val;
    }
    return null;
  }

  /**
   * 应用好感度变化，并夹紧到 0-100 范围
   */
  applyAffectionChange(delta) {
    if (typeof delta !== 'number' || delta === 0) return false;
    const old = this.babeAffection;
    this.babeAffection = Math.max(0, Math.min(100, old + delta));
    return this.babeAffection !== old;
  }

  resetOptimizedTools() {
    this.optimizedToolNames = null;
    this.optimizedToolReason = '';
    this.sessionAutoOptimizeDisabled = false; // 重置会话级禁用标志，避免一次禁用永久失效
    if (this.contextManager && this.settings) {
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
    }
  }

  /**
   * 累计单次 LLM 响应的 usage 到当前会话统计。
   * 兼容 OpenAI / Anthropic / OpenCode Zen 三类字段：
   *   - prompt_tokens / completion_tokens / total_tokens （OpenAI 兼容）
   *   - prompt_tokens_details.cached_tokens （OpenAI 缓存命中）
   *   - cache_read_input_tokens / cache_creation_input_tokens （Anthropic 缓存）
   * 注：每日/每周/每月统计由主进程 recordTokenUsage 在 chatLLM IPC 内部完成，
   * 此处只负责会话级累计（用于上下文模态框显示）。
   */
  _accumulateUsage(usage, model) {
    if (!usage || typeof usage !== 'object') return;
    try {
      const pt = usage.prompt_tokens || 0;
      const ct = usage.completion_tokens || 0;
      const tt = usage.total_tokens || (pt + ct);
      // OpenAI: prompt_tokens_details.cached_tokens；Anthropic: cache_read_input_tokens
      const cached = usage.prompt_tokens_details?.cached_tokens
        || usage.cache_read_input_tokens
        || 0;
      const cacheCreation = usage.cache_creation_input_tokens || 0;
      this.sessionUsage.prompt += pt;
      this.sessionUsage.completion += ct;
      this.sessionUsage.total += tt;
      this.sessionUsage.cached += cached;
      this.sessionUsage.cacheCreation += cacheCreation;
      // 任意一次 API 响应未返回 usage（使用估算）→ 整个会话统计标记为估算
      if (usage._estimated) this.sessionUsage.estimated = true;
      // 按模型分桶：混合模型会话的费用/用量正确归属
      if (!this.sessionUsageByModel) this.sessionUsageByModel = {};
      const key = model || this.getActiveModelId() || 'unknown';
      if (!this.sessionUsageByModel[key]) {
        this.sessionUsageByModel[key] = { prompt: 0, completion: 0, total: 0, cached: 0, cacheCreation: 0, estimated: false };
      }
      const bm = this.sessionUsageByModel[key];
      bm.prompt += pt;
      bm.completion += ct;
      bm.total += tt;
      bm.cached += cached;
      bm.cacheCreation += cacheCreation;
      if (usage._estimated) bm.estimated = true;
    } catch (e) {
      // 静默失败：统计错误不应影响对话主流程
    }
  }

  /** 新会话开始时重置会话级统计 */
  resetSessionUsage() {
    this.sessionUsage = { prompt: 0, completion: 0, total: 0, cached: 0, cacheCreation: 0, estimated: false };
    this.sessionUsageByModel = {};
    this.sessionStartTime = Date.now();
  }

  /**
   * Inject Goal steering prompt into system context when a goal is active.
   * Ported from claude-code-ref's goal continuation/budget/blocked prompts.
   */
  getGoalSteeringSection() {
    if (typeof GoalState === 'undefined' || !GoalState) return '';
    try {
      const sid = this.conversationId || 'main';
      const g = GoalState.getGoal(sid);
      if (!g) return '';
      const steering = GoalState.getSteeringPrompt(sid);
      return steering ? '\n\n' + steering : '';
    } catch { return ''; }
  }

  getEnabledToolDefinitions() {
    const enabled = this.settings?.tools || {};
    return getAllToolDefinitions(this.mode || 'chat').filter(tool => enabled[tool.name] !== false);
  }

  hasUsableOptimizedSelection() {
    // 极简模式不参与自动工具优化
    if (this.minimalMode) return true;
    // Code 模式始终使用全部启用工具，不参与自动优化
    if (this.mode === 'code') return false;
    if (!this.settings?.autoOptimizeToolSelection) return false;
    if (this.sessionAutoOptimizeDisabled) return false; // LLM 在本 session 内禁用了自动优化
    if (!Array.isArray(this.optimizedToolNames)) return false;
    const enabledCount = this.getEnabledToolDefinitions().length;
    if (enabledCount === 0) return true;
    return this.optimizedToolNames.length > 0;
  }

  async refreshSkillsCatalog() {
    let userSkills = [];
    try {
      const skills = await window.api.listSkills();
      userSkills = Array.isArray(skills) ? skills : [];
    } catch { /* ignore */ }
    // Merge bundled skills (built-in) with user skills.
    // User skills take precedence when names collide (user can override bundled).
    let bundled = [];
    try {
      if (typeof BUNDLED_SKILLS !== 'undefined') bundled = BUNDLED_SKILLS;
    } catch { /* bundled-skills.js may not be loaded in some contexts */ }
    const byName = new Map();
    for (const s of bundled) byName.set(s.name, s);
    for (const s of userSkills) byName.set(s.name, s); // user overrides bundled
    this.skillsCatalog = Array.from(byName.values());
  }

  getActiveToolNames() {
    return this._orderedActiveToolNames();
  }

  /**
   * 有序的活动工具名列表（缓存纪律的核心）。
   *
   * 顺序规则：
   * - 无优化 / Code 模式 → 全部启用工具（TOOL_DEFINITIONS 规范序）。
   * - 优化中 → 冻结选择序（LLM 首轮选择序）。
   * - 重优化 → 只追加新工具到尾部，已加载工具保持原序（前缀字节稳定）。
   * - 禁用优化 → 冻结序 + 其余启用工具追加到尾部（同样只追加）。
   */
  _orderedActiveToolNames() {
    const enabled = this.getEnabledToolDefinitions().map(t => t.name);
    if (this.mode === 'code') return enabled;
    if (!this.settings?.autoOptimizeToolSelection) return enabled;
    const frozen = Array.isArray(this.optimizedToolNames)
      ? this.optimizedToolNames.filter(n => enabled.includes(n))
      : [];
    if (this.sessionAutoOptimizeDisabled) {
      // 追加式补全：冻结序在前，其余启用工具按规范序追加在后
      const have = new Set(frozen);
      return [...frozen, ...enabled.filter(n => !have.has(n))];
    }
    if (!this.hasUsableOptimizedSelection()) return enabled;
    return frozen;
  }

  getRuntimeToolSchemas() {
    // 极简模式：只暴露持久终端（pty）+ 文件读写编辑，对齐 DSH minimal 预设
    if (this.minimalMode) {
      const enabledToolsMap = {};
      getAllToolDefinitions(this.mode || 'chat').forEach(tool => {
        enabledToolsMap[tool.name] = MINIMAL_TOOL_NAMES.includes(tool.name);
      });
      let tools = getToolSchemas(enabledToolsMap, this.mode || 'chat');
      tools = tools.filter(t => MINIMAL_TOOL_NAMES.includes(t.function?.name));
      if (typeof filterToolsByConfig === 'function') {
        tools = filterToolsByConfig(tools, this.settings);
      }
      if (this.contextManager && typeof this.contextManager.setToolSchemaTokens === 'function') {
        this.contextManager.setToolSchemaTokens(Math.ceil(JSON.stringify(tools).length / 4));
      }
      return tools;
    }
    const activeNames = this._orderedActiveToolNames();
    const activeSet = new Set(activeNames);
    const enabledToolsMap = {};
    getAllToolDefinitions(this.mode || 'chat').forEach(tool => {
      enabledToolsMap[tool.name] = activeSet.has(tool.name);
    });
    let tools = getToolSchemas(enabledToolsMap, this.mode || 'chat');
    // 未配置生图模型时隐藏 generateImage 工具
    if (typeof filterToolsByConfig === 'function') {
      tools = filterToolsByConfig(tools, this.settings);
    }
    // 按活动序重排：保证追加式重优化只影响 tools 数组尾部，前缀字节稳定
    const byName = new Map(tools.map(t => [t.function?.name, t]));
    const ordered = [];
    for (const name of activeNames) {
      const schema = byName.get(name);
      if (schema) ordered.push(schema);
    }
    tools = ordered;
    if (this.settings?.autoOptimizeToolSelection && !this.sessionAutoOptimizeDisabled && this.mode !== 'code') {
      tools.push(INTERNAL_REOPTIMIZE_TOOL_SCHEMA);
      tools.push(INTERNAL_DISABLE_AUTO_OPTIMIZE_SCHEMA);
    }
    // 真实计量：工具 schema 是输入包络的大头，必须计入上下文预算。
    // 口径与工具页一致（JSON 长度 / 4 ≈ token 数），contextManager 再乘校准因子。
    if (this.contextManager && typeof this.contextManager.setToolSchemaTokens === 'function') {
      this.contextManager.setToolSchemaTokens(Math.ceil(JSON.stringify(tools).length / 4));
    }
    return tools;
  }

  /**
   * 检测当前模型是否支持多模态视觉输入。
   * 通过模型 ID 关键词判断，也检查 settings.llm.visionModels 自定义列表。
   * 当用户在设置中手动开启「多模态」开关时，强制视为支持（绕过自动识别）。
   */
  isVisionModel() {
    // 用户手动开启多模态开关：无论模型名/API 如何，强制允许图片注入上下文
    if (this.settings?.llm?.forceVision === true) return true;
    const model = (this.settings?.llm?.model || '').toLowerCase();
    if (!model) return false;
    // 用户自定义的 vision 模型列表
    const customVisionModels = this.settings?.llm?.visionModels;
    if (Array.isArray(customVisionModels)) {
      if (customVisionModels.some(m => model === (m || '').toLowerCase())) return true;
    }
    // 常见多模态模型关键词
    const VISION_KEYWORDS = [
      'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'gpt-5',
      'claude-3', 'claude-4', 'claude-opus', 'claude-sonnet', 'claude-haiku',
      'gemini', 'qwen-vl', 'qwen2-vl', 'qwen2.5-vl', 'glm-4v', 'glm-4.6v',
      'internvl', 'llava', 'mini-cpm', 'nextvl',
      'deepseek-vl', 'step-1v', 'yi-vision',
      // Gemma 3/4 具备视觉输入能力（gguf 本地推理亦支持 image_url）
      'gemma-3', 'gemma-4',
      // Zen 免费模型中支持 vision 的
      'big-pickle', 'mimo-v2.5'
    ];
    return VISION_KEYWORDS.some(k => model.includes(k));
  }

  /**
   * 统一解析工作区相对路径 → 完整路径。
   * renderer 中不可用 require('path')，用字符串拼接。
   * 规则：
   *   - 绝对路径（Windows 盘符 C:\、Unix /、UNC \\）或 URL（http(s)://、file://）→ 原样返回
   *   - 相对路径 → 基于工作区拼接
   *     · Code 模式优先 codeWorkspacePath（除非 useCodeWorkspace:false 显式禁用）
   *     · 其他模式用 workspacePath
   *   - 无工作区时原样返回（交由主进程 fs 按 CWD 处理，但此时通常也无工作区可用）
   * 这是所有文件工具（readFile/createFile/editFile/moveFile/...）共用的路径上下文工程，
   * 避免相对路径落到进程 CWD（打包后即软件安装目录，会污染/覆盖应用文件）。
   */
  _resolveWorkspacePath(p, { useCodeWorkspace } = {}) {
    if (!p) return p;
    // 绝对路径或 URL：原样返回，避免把 C:\xxx 误当相对路径拼接到 workspace 后
    if (/^([a-zA-Z]:[\\/]|[\\/]|[\w-]+:\/\/)/.test(p)) return p;
    // Code 模式默认用 codeWorkspacePath（除非显式禁用）
    const useCode = useCodeWorkspace !== false && this.mode === 'code';
    const ws = useCode
      ? (this.codeWorkspacePath || this.workspacePath)
      : this.workspacePath;
    if (!ws) return p;
    return ws.replace(/[\\/]+$/, '') + '/' + p.replace(/^[\\/]+/, '');
  }

  /**
   * 脚本执行器的工作目录：与终端一致，Code 模式用 codeWorkspacePath，
   * 其他模式用 workspacePath；无工作区时返回 null（主进程回退到默认 CWD）。
   * 每个 Agent 实例独立计算，避免并发会话的脚本在同一个进程 CWD 里互相踩踏。
   */
  _scriptCwd() {
    const ws = this.mode === 'code'
      ? (this.codeWorkspacePath || this.workspacePath)
      : this.workspacePath;
    return (ws && typeof ws === 'string' && ws.length > 0) ? ws : null;
  }

  /**
   * 当前会话的沙箱模式：按模式覆盖（settings.sandbox.modeOverrides.chat/code/babe）
   * 优先，其次全局默认（settings.sandbox.defaultMode），缺省 danger-full-access。
   */
  _sandboxMode() {
    const sb = this.settings?.sandbox || {};
    const override = sb.modeOverrides?.[this.mode];
    return override || sb.defaultMode || 'danger-full-access';
  }

  /**
   * 沙箱升级审批流：受限执行被拦截（denial）或后端不可用时，
   * 若设置允许审批，弹一次确认；同意则以 danger-full-access 重试一次。
   */
  async _execWithSandboxEscalation(toolName, call, opts = {}) {
    let result = await call(this._sandboxMode());
    const blocked = result && (result.sandboxDenied || result.sandboxUnavailable);
    if (!blocked) return result;
    if (this.settings?.sandbox?.requireApproval === false) {
      return result;
    }
    const reason = result.sandboxUnavailable
      ? '沙箱后端不可用'
      : '命令被沙箱拦截（尝试写入受限区域）';
    const approved = await this.requestApproval('sandboxEscalation', {
      tool: toolName,
      reason,
      detail: result.error || reason
    });
    if (!approved) {
      return {
        ...result,
        error: `${reason}，用户拒绝以完全权限执行。`,
        sandboxDenied: true
      };
    }
    return await call('danger-full-access');
  }

  /**
   * FFmpeg 工具参数的工作区路径解析：
   * - 单文件参数（input/video/audio/subtitle/image/fontFile）→ 相对工作区解析
   * - 多文件参数（inputs/images）→ 逐个解析（对应"文件多选"）
   * - 输出参数（output/outputDir）→ 相对工作区解析
   */
  _resolveFfmpegArgs(args) {
    const clone = { ...(args && typeof args === 'object' ? args : {}) };
    const single = ['input', 'video', 'audio', 'subtitle', 'image', 'fontFile'];
    for (const key of single) {
      if (typeof clone[key] === 'string' && clone[key]) clone[key] = this._resolveWorkspacePath(clone[key]);
    }
    for (const key of ['inputs', 'images']) {
      if (Array.isArray(clone[key])) {
        clone[key] = clone[key].map(p => this._resolveWorkspacePath(String(p)));
      }
    }
    for (const key of ['output', 'outputDir']) {
      if (typeof clone[key] === 'string' && clone[key]) clone[key] = this._resolveWorkspacePath(clone[key]);
    }
    return clone;
  }

  getLatestUserMessageText() {
    const msgs = this.contextManager?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'user' && typeof msgs[i].content === 'string') {
        return msgs[i].content;
      }
    }
    return '';
  }

  buildHeuristicToolCandidates(userMessage, enabledDefs) {
    const text = String(userMessage || '').toLowerCase();
    const keywords = [
      { test: /文件|目录|路径|读取|写入|重命名|删除|复制|移动|搜索本地|workspace|read|write|file|folder/i, categories: ['文件'] },
      { test: /网络|搜索|网页|链接|url|http|爬|fetch|search/i, categories: ['网络', '网络工具'] },
      { test: /天气|帖子|论坛|动态网页|动态页面|渲染|ocr|截图|屏幕/i, categories: ['网络', '系统'] },
      { test: /计算|算式|表达式|百分比|取模|幂|求值|四则|calculator|math/i, categories: ['计算'] },
      { test: /知识|知识库|记忆|memory|knowledge/i, categories: ['知识', '记忆'] },
      { test: /终端|命令|shell|powershell|cmd|bash|脚本/i, categories: ['终端', '代码'] },
      { test: /图片|图像|海报|绘图|ocr|二维码|截图|camera/i, categories: ['创作', '系统'] },
      { test: /word|docx|odt|文档模板|公文|格式化|套模板|占位符|正文|段落|样式/i, categories: ['Office-Word'] },
      { test: /ppt|演示|幻灯片|slides|汇报|讲稿/i, categories: ['PPT Maker'] },
      { test: /表格|excel|csv|数据|统计|图表|spreadsheet/i, categories: ['文件', '数据表格'] },
      { test: /游戏|飞花令|三国杀|卧底/i, categories: ['娱乐'] },
      { test: /请求|api|接口|post|get|put|delete|rest|json|header|cookie|token|oauth/i, categories: ['网络工具'] },
      { test: /dns|ping|ssl|证书|端口|扫描|traceroute|路由|域名/i, categories: ['网络工具'] },
      { test: /下载|download|上传|upload|表单|multipart/i, categories: ['网络工具'] },
      { test: /mcp|MCP|服务端|protocol/i, categories: ['MCP'] },
    ];

    const categoryBoost = new Set();
    keywords.forEach(rule => {
      if (rule.test.test(text)) {
        rule.categories.forEach(c => categoryBoost.add(c));
      }
    });

    const scored = enabledDefs.map(tool => {
      let score = 0;
      const nm = (tool.name || '').toLowerCase();
      const desc = (tool.desc || '').toLowerCase();
      const cat = tool.category || '其他';

      if (categoryBoost.has(cat)) score += 6;
      if (text.includes(nm)) score += 8;

      const descTokens = desc.split(/[^\w\u4e00-\u9fff]+/).filter(Boolean);
      let overlap = 0;
      for (const t of descTokens) {
        if (t.length > 1 && text.includes(t)) overlap++;
      }
      score += Math.min(6, overlap);

      if (tool.sensitive) score -= 1;
      if (nm === 'managecontext') score += 2;
      if (nm === 'askquestions') score += 3;
      if (nm === 'todolist') score += 3;
      if (nm === 'runsubagent') score += 1;
      // Code 模式核心工具保底：终端/文件/编辑工具必须可被选中
      if (this.mode === 'code') {
        if (['maketerminal', 'runterminalcommand', 'awaitterminalcommand', 'killterminal',
             'terminalreadoutput', 'terminalsendinput', 'terminalpresskey', 'terminalanswerprompt', 'terminallistsessions',
             'readfile', 'writefile', 'createfile', 'editfile', 'listdirectory',
             'makedirectory', 'localsearch', 'runshellscriptcode'].includes(nm)) {
          score += 5;
        }
      }

      return { tool, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.tool.name);
  }

  compactOptimizedSelection(selectedNames, enabledDefs, userMessage) {
    const enabledSet = new Set(enabledDefs.map(t => t.name));
    const enabledCount = enabledDefs.length;
    const dynamicCap = Math.max(6, Math.min(18, Math.ceil(enabledCount * 0.4)));
    const core = ['manageContext', 'askQuestions', 'todoList'];

    const merged = [];
    const pushUnique = (name) => {
      if (!name || !enabledSet.has(name)) return;
      if (!merged.includes(name)) merged.push(name);
    };

    // LLM 选择优先（按 LLM 给出的顺序）
    const llmSelected = Array.isArray(selectedNames) ? selectedNames : [];
    llmSelected.forEach(pushUnique);

    if (llmSelected.length > 0) {
      // LLM 已给出有效选择：只补 core 工具，不追加启发式。
      // 启发式会把所有"可能相关"的工具都塞进来，稀释 LLM 基于用户消息的精确判断。
      // cap 也放宽：LLM 选几个就用几个（加 core 后），不强行堆到 dynamicCap。
      core.forEach(pushUnique);
      const finalCap = Math.max(llmSelected.length, Math.min(dynamicCap, llmSelected.length + core.length + 3));
      return merged.slice(0, finalCap);
    }

    // LLM 未给出选择：用启发式 + core 兜底
    const heuristics = this.buildHeuristicToolCandidates(userMessage, enabledDefs);
    core.forEach(pushUnique);
    heuristics.forEach(pushUnique);
    return merged.slice(0, dynamicCap);
  }

  /**
   * 合并优化选择（追加式，缓存纪律）：
   * - 首次优化：整体写入。
   * - 会话中重优化：只把新选中的工具追加到冻结选择序的末尾，不删、不重排。
   * @returns {{merged: boolean, added: number}}
   */
  _mergeOptimizedSelection(selectedNames) {
    const next = (Array.isArray(selectedNames) ? selectedNames : []).filter(n => !!n);
    if (Array.isArray(this.optimizedToolNames) && this.optimizedToolNames.length > 0) {
      const have = new Set(this.optimizedToolNames);
      const added = [];
      for (const n of next) {
        if (!have.has(n) && !added.includes(n)) added.push(n);
      }
      if (added.length > 0) {
        this.optimizedToolNames = [...this.optimizedToolNames, ...added];
      }
      return { merged: true, added: added.length };
    }
    this.optimizedToolNames = next.slice();
    return { merged: false, added: next.length };
  }

  async optimizeToolsForConversation(firstUserMessage, reason = '') {
    // Code 模式不参与自动优化，始终使用全部启用工具
    if (this.mode === 'code') return { ok: true, selected: [], skipped: 'code_mode' };
    const enabledDefs = this.getEnabledToolDefinitions();
    const fallback = this.compactOptimizedSelection([], enabledDefs, firstUserMessage);
    if (!enabledDefs.length) {
      this.optimizedToolNames = [];
      this.optimizedToolReason = '无可用工具';
      return { ok: true, selected: [] };
    }

    if (this.onMessage) this.onMessage('optimize-tools-start');
    try {
      const candidates = enabledDefs.map(t => `${t.name} | ${t.category || '其他'} | ${t.desc}`).join('\n');
      // 关键修复：思考模型会把推理同时塞进 content/reasoning_content，导致 JSON 解析失败。
      // 三管齐下：
      //  1) prompt 明确禁止任何推理/解释/前后文字，只输出 JSON 对象；
      //  2) 提供 few-shot 示例让模型看到正确格式；
      //  3) 调用时传 response_format={type:'json_object'} 强制 JSON 模式（OpenAI-compat 标准）。
      const systemPrompt = [
        '你是工具选择优化器。任务：根据用户消息，从候选工具中选择最匹配的工具。',
        '',
        '【输出格式 - 必须严格遵守】',
        '只输出一个 JSON 对象，不要输出任何其他内容：',
        '- 不要复述任务、不要解释你在做什么、不要输出推理过程',
        '- 不要在 JSON 前后加任何文字、Markdown、代码块标记',
        '- JSON 必须以 { 开头，以 } 结尾',
        '- 格式：{"selected":["工具名1","工具名2"],"reason":"简短说明"}',
        '',
        '【示例】',
        '用户消息：>>>帮我搜索今天的科技新闻<<<',
        '输出：{"selected":["webSearch","webFetch","offscreenRenderContent"],"reason":"用户要搜索新闻并获取内容"}',
        '',
        '用户消息：>>>读取 config.json 文件<<<',
        '输出：{"selected":["readFile","listDirectory"],"reason":"用户要读取文件"}',
        '',
        '【选择规则】',
        '1) 只能从候选工具中选；',
        '2) 严格根据用户消息语义选择，禁止返回无关工具；',
        '3) 优先选择 3-8 个工具，复杂任务可更多，至少 3 个；',
        '4) selected 按重要性排序，最重要的放最前面；',
        '5) 若涉及搜索/网页信息，需同时选 webFetch + offscreenRenderContent 之一配合 webSearch；',
        '6) 若涉及文件/代码，需包含 readFile/listDirectory/editFile 之一；',
        '7) 若涉及编程/执行，需包含 runCommand 或 runSubAgent。'
      ].join('\n');
      const userPrompt = [
        reason ? `触发原因：${reason}` : '触发原因：首条消息优化',
        `【用户消息】（工具选择的唯一依据）：`,
        `>>>${firstUserMessage || ''}<<<`,
        '',
        '候选工具列表：',
        candidates,
        '',
        '请直接输出 JSON（不要任何推理或解释）：'
      ].join('\n\n');
      // 关键：强制 JSON 模式 + 低 temperature + 较大 max_tokens 容纳 JSON
      const result = await window.api.chatLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], {
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        requestId: Date.now().toString(),
        sessionKey: this.sessionKey || null
      });

      const msg = result?.data?.choices?.[0]?.message;
      const rawContent = (msg?.content || '').trim();
      // 思考模型（如 deepseek-v4-flash-free）经常 content 为空，答案在 reasoning_content 里
      const rawReasoning = (msg?.reasoning_content || '').trim();

      // Preprocess: strip think tags and code fences for reliable JSON parsing
      const cleanText = (text) => {
        if (!text) return "";
        let t = text;
        // Remove complete think blocks
        t = t.replace(/\u003Cthink\u003E[\s\S]*?\u003C\/think\u003E/gi, "");
        // Remove unclosed think tag to end
        t = t.replace(/\u003Cthink\u003E[\s\S]*$/gi, "");
        // Remove markdown code fence markers (```json ... ```)
        const tick3 = String.fromCharCode(96, 96, 96); // triple backtick
        t = t.split(tick3 + "json").join("").split(tick3).join("");
        return t.trim();
      };
      const content = cleanText(rawContent);
      const reasoningContent = cleanText(rawReasoning);

      // Extract JSON from content or reasoning_content
      let parsed = null;
      const tryParseJson = (text) => {
        if (!text) return null;
        try { return JSON.parse(text); } catch {}
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          try { return JSON.parse(match[0]); } catch {}
          // Fix trailing commas then retry
          try { return JSON.parse(match[0].replace(/,(\s*[}\]])/g, "$1")); } catch {}
        }
        return null;
      };
      parsed = tryParseJson(content) || tryParseJson(reasoningContent);

      // Fallback: if JSON failed or reason missing, extract reason from raw text
      if (!parsed || typeof parsed.reason !== "string") {
        const fullText = rawContent + " " + rawReasoning;
        const reasonMatch = fullText.match(/"reason"\s*:\s"([^"]*)"/i)
          || fullText.match(/reason\s*[:\uFF1A]\s*"([^"]*)"/i)
          || fullText.match(/(?:\u539F\u56E0|\u7406\u7531)\s*[:\uFF1A]\s*([^\n"{}]+)/i);
        if (reasonMatch && reasonMatch[1]) {
          parsed = parsed || {};
          if (typeof parsed.reason !== "string") parsed.reason = reasonMatch[1].trim();
        }
      }

      const validNames = new Set(enabledDefs.map(t => t.name));
      const lowerNameMap = new Map();
      enabledDefs.forEach(t => { lowerNameMap.set(t.name.toLowerCase(), t.name); });

      const selectedRaw = Array.isArray(parsed?.selected) ? parsed.selected : [];
      let selected = selectedRaw
        .map(name => {
          if (typeof name !== 'string') return null;
          const trimmed = name.trim();
          if (validNames.has(trimmed)) return trimmed;
          // 大小写不敏感匹配
          const lower = trimmed.toLowerCase();
          if (lowerNameMap.has(lower)) return lowerNameMap.get(lower);
          // 去除可能的空格/下划线差异
          const normalized = lower.replace(/[\s_-]/g, '');
          for (const [l, orig] of lowerNameMap) {
            if (l.replace(/[\s_-]/g, '') === normalized) return orig;
          }
          return null;
        })
        .filter(Boolean);

      // 兜底：当模型不支持 response_format 或仍把推理塞进 content 时，
      // 从文本中扫描有效工具名 token（静默处理，不再打印"JSON 解析失败"）。
      // 这是最后一道防线，主要路径是上面的 JSON 解析。
      if (selected.length === 0) {
        const reasoningText = (content + ' ' + reasoningContent).toLowerCase();
        const extractedFromText = enabledDefs
          .filter(t => {
            const lower = t.name.toLowerCase();
            // 工具名作为独立 token 出现（避免 readFile 误匹配 fileReader 之类）
            const tokenPattern = new RegExp(`\\b${lower.replace(/[._]/g, '[._]?')}\\b|${lower.replace(/[._]/g, ' ')}`, 'i');
            return tokenPattern.test(reasoningText);
          })
          .map(t => t.name);
        if (extractedFromText.length > 0) {
          selected = extractedFromText;
        }
      }
      const compacted = this.compactOptimizedSelection(selected, enabledDefs, firstUserMessage);

      // 关键修复：无论 LLM 返回什么都必须给 optimizedToolNames 赋非空值，
      // 否则下一次 sendMessage 会再次进入“检测到优化未执行”分支形成死循环。
      // 优先用 LLM 选择（compacted），其次用启发式 fallback，最后兜底用所有启用工具。
      const allEnabledNames = enabledDefs.map(t => t.name);
      let finalSelection = compacted.length > 0 ? compacted : fallback;
      if (finalSelection.length === 0) finalSelection = allEnabledNames.slice(0, Math.min(12, allEnabledNames.length));
      this._mergeOptimizedSelection(finalSelection);
      this.optimizedToolReason = typeof parsed?.reason === 'string' ? parsed.reason : (reason || '首条消息优化');
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
      return { ok: true, selected: this.optimizedToolNames, reason: this.optimizedToolReason };
    } catch (e) {
      // 即使失败也要赋非空值，避免下次 sendMessage 重复触发补偿优化
      let safeFallback = fallback.length > 0 ? fallback : enabledDefs.slice(0, 12).map(t => t.name);
      if (safeFallback.length === 0) safeFallback = enabledDefs.map(t => t.name);
      if (!Array.isArray(this.optimizedToolNames) || this.optimizedToolNames.length === 0) {
        this.optimizedToolNames = safeFallback;
        this.optimizedToolReason = '优化失败，回退到精简启发式工具集';
      }
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
      console.warn('[tool-opt] 优化失败，使用兜底:', e?.message, 'fallback size:', safeFallback.length);
      return { ok: false, error: e?.message || '优化失败', selected: safeFallback };
    } finally {
      if (this.onMessage) this.onMessage('optimize-tools-end');
    }
  }

  /**
   * Babe 模式主动发消息：让 AI 主动发起一条话题，而不是回复用户。
   * 通过注入一条 system 指令触发 Agent Loop，让 LLM 以 assistant 身份生成主动消息。
   * 不走 user 消息路径，避免污染对话上下文。
   */
  async proactiveSend(topicHint = '') {
    if (!this.settings?.llm?.apiUrl || !this.settings?.llm?.apiKey) {
      if (this.onMessage) this.onMessage('error', '请先在设置中配置LLM API');
      return;
    }
    if (this.running) return; // 正在处理中，不重复触发

    const runId = ++this.runId;
    this.running = true;
    this.stopped = false;
    if (this.onStatusChange) this.onStatusChange('working');

    // 抽塔罗牌
    if (!this.tarotCard) {
      this.tarotCard = await window.api.drawTarot();
      if (this.onMessage) this.onMessage('tarot', this.tarotCard);
    }

    // 构造主动消息的系统指令（以 user 角色注入，但语义是"请主动发消息"）
    const proactivePrompt = topicHint
      ? `[系统指令] 请主动给用户发一条消息，围绕这个主题：${topicHint}。以你的人设口吻自然开场，不要提及这是系统指令。`
      : '[系统指令] 请主动给用户发一条消息，可以关心对方、分享心情、或开启一个话题。以你的人设口吻自然开场，不要提及这是系统指令。';

    this.contextManager.addUserMessage(proactivePrompt);

    try {
      await this.agentLoop(runId);
    } catch (e) {
      if (this.onMessage) this.onMessage('error', e?.message || String(e));
    } finally {
      this.running = false;
      if (this.onStatusChange) this.onStatusChange('idle');
      // 保存历史
      await this.saveToHistory();
    }
  }

  async sendMessage(userMessage, attachments = []) {
    // OpenAI/Anthropic 兼容端点允许无 API Key（llama.cpp 等本地推理场景）
    if (!this.settings?.llm?.apiUrl) {
      if (this.onMessage) this.onMessage('error', '请先在设置中配置LLM API');
      return;
    }

    const runId = ++this.runId;
    this.running = true;
    this.stopped = false;
    if (this.onStatusChange) this.onStatusChange('working');

    // Draw tarot card on first message
    if (!this.tarotCard) {
      this.tarotCard = await window.api.drawTarot();
      if (this.onMessage) this.onMessage('tarot', this.tarotCard);
    }

    if (!this.conversationTitle) {
      this.conversationTitle = await this.generateConversationTitle(userMessage);
      if (this.onTitleChange) this.onTitleChange(this.conversationTitle);
    }

    // Refresh system prompt with current time and tarot card
    this.contextManager.setSystemPrompt(this.getSystemPrompt());

    // Build message content with attachments
    let fullMessage = userMessage;
    if (attachments.length > 0) {
      const attachInfo = attachments.map(a => {
        // 路径必须精确显示，禁止AI猜测或重拼文件名
        const exactPath = a.path ? `\n⚠️ 精确文件路径（必须逐字使用，禁止修改任何字符）: ${a.path}` : '';
        // 隐私信息保护：附件 OCR/提取文本过滤隐私信息后注入 AI 上下文
        if (a.ocrText) return `[附件: ${a.name}]${exactPath}\nOCR识别文本:\n${this._sanitizeAttachmentText(a.ocrText)}`;
        if (a.extractedText) {
          let text = a.extractedText.length > 2000 ? a.extractedText.substring(0, 2000) + '\n...[已截断]' : a.extractedText;
          text = this._sanitizeAttachmentText(text);
          const converted = a.convertedPath ? `\n已转换文本路径: ${a.convertedPath}` : '';
          const original = a.path && a.convertedPath && a.path !== a.convertedPath ? `\n⚠️ 原始文件精确路径（用于officeHardUnpack，必须原样使用）: ${a.path}` : exactPath;
          return `[文件附件: ${a.name}]${converted}${original}\n提取文本:\n${text}`;
        }
        if (a.convertedPath) return `[文件附件: ${a.name}]\n已转换文本路径: ${a.convertedPath}${exactPath}`;
        if (a.isImage) return `[图片附件: ${a.name}]${exactPath}`;
        return `[文件附件: ${a.name}]${exactPath}`;
      }).join('\n');
      fullMessage = userMessage + '\n\n' + attachInfo;
    }

    if (this.settings?.autoOptimizeToolSelection && !this.sessionAutoOptimizeDisabled && !this.hasUsableOptimizedSelection()) {
      await this.optimizeToolsForConversation(fullMessage, '检测到优化未执行，发送前自动补偿优化');
    }

    await this.refreshSkillsCatalog();
    this.contextManager.setSystemPrompt(this.getSystemPrompt());

    // 多模态：如果模型支持 vision 且有图片附件，构造 content 数组（OpenAI vision format）
    if (this.isVisionModel() && attachments.some(a => a.isImage && a.path)) {
      const contentParts = [{ type: 'text', text: fullMessage }];
      for (const a of attachments) {
        if (!a.isImage || !a.path) continue;
        try {
          // 读取图片为 base64 data URL
          const readRes = await window.api.readFileBase64(a.path);
          if (readRes && readRes.ok && readRes.data) {
            contentParts.push({ type: 'image_url', image_url: { url: readRes.data } });
          } else if (a.ocrText) {
            // 如果无法读取为 base64，回退到 OCR 文本
            contentParts.push({ type: 'text', text: `[图片 ${a.name} OCR文本]: ${a.ocrText}` });
          }
        } catch (e) {
          console.warn('[Vision] 读取图片失败:', a.path, e.message);
          if (a.ocrText) {
            contentParts.push({ type: 'text', text: `[图片 ${a.name} OCR文本]: ${a.ocrText}` });
          }
        }
      }
      this.contextManager.addUserMessage(contentParts);
    } else {
      this.contextManager.addUserMessage(fullMessage);
    }

    // Save immediately after user message so history exists even before agent finishes
    this.saveToHistory();

    await this.agentLoop(runId);

    // Send conversation summary via email if enabled and can send
    const emailCfg = this.settings?.email;
    if (emailCfg?.enabled && (emailCfg.mode === 'send-only' || emailCfg.mode === 'send-receive')) {
      try {
        const messages = this.contextManager.getMessages();
        const title = userMessage.substring(0, 50) + (userMessage.length > 50 ? '...' : '');
        await window.api.emailSendConversation(messages, title);
      } catch (e) {
        console.error('[Email] Failed to send conversation summary:', e);
      }
    }

    // Save to history
    this.saveToHistory();

    // Goal turn recording: track turns for max-turns detection.
    try {
      if (typeof GoalState !== 'undefined' && GoalState) {
        const sid = this.conversationId || 'main';
        if (GoalState.getGoal(sid)) {
          GoalState.recordGoalTurn(sid);
          // Refresh system prompt to include updated steering info
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
        }
      }
    } catch { /* ignore goal tracking failures */ }
  }

  async saveToHistory() {
    if (!this.conversationId) return;
    try {
      // 上下文管理器与历史记录解耦：
      // 持久化完整 transcript（historyMessages），而非工作上下文（messages）。
      // 工作上下文可能已被压缩/清理，但历史记录始终保持完整。
      const payload = {
        id: this.conversationId,
        title: this.conversationTitle || '未命名对话',
        ts: Date.now(), // 历史保存时间戳：Code 模式列表排序/展示用
        updatedAt: new Date().toISOString(),
        schemaVersion: 2, // 历史格式版本：新版持久化完整 transcript（historyMessages）到 messages
        messages: this.contextManager.getHistoryMessages(),
        summaries: this.contextManager.summaries,
        tarotCard: this.tarotCard,
        workspacePath: this.workspacePath,
        mode: this.mode || 'chat',
        status: this.sessionStatus || (this.running ? 'running' : 'idle'),
        lastError: this.sessionLastError || null,
        // 会话累计 Token 统计实时持久化：打开历史会话时恢复，继续对话从该基数累计
        usage: { ...this.sessionUsage },
        // 按模型分桶统计 + 会话级模型/变体覆盖 + 极简模式标记
        usageByModel: { ...(this.sessionUsageByModel || {}) },
        llmOverride: { ...(this.llmOverride || {}) },
        minimal: this.minimalMode === true
      };
      // 子代理聊天记录持久化：序列化完整消息快照（去掉 subAgent 实例引用），
      // 重新打开该会话后可继续查看子代理详情模态框中的完整对话。
      if (Array.isArray(this.subAgents) && this.subAgents.length > 0) {
        payload.subAgents = this.subAgents.map(r => ({
          id: r.id,
          task: r.task,
          tarot: r.tarot,
          status: r.status,
          startTime: r.startTime,
          endTime: r.endTime,
          iterations: r.iterations,
          toolUseCount: r.toolUseCount,
          usage: r.usage || {},
          messages: Array.isArray(r.messages) ? r.messages : []
        }));
      }
      if (this.mode === 'babe') {
        payload.affection = this.babeAffection;
        await window.api.babeHistorySave(payload);
      } else if (this.mode === 'code') {
        // Code 模式：保存到独立的工作区历史，避免逃逸到 Chat 历史
        // codeSaveHistory 签名：(workspacePath, id, data)
        await window.api.codeSaveHistory(this.codeWorkspacePath || this.workspacePath, this.conversationId, payload);
      } else {
        await window.api.historySave(payload);
      }
    } catch (e) { console.error('保存历史失败', e); }
  }

  async loadFromHistory(conversation) {
    this.conversationId = conversation.id;
    this.conversationTitle = conversation.title;
    this.resetOptimizedTools();
    this.resetSessionUsage();
    // 恢复持久化的会话累计 Token 统计：打开历史会话后从该基数继续累计，
    // 上下文模态框/会话消费显示的是"历史累计 + 本轮新增"。
    // 旧版会话无 usage 字段时保持重置后的新一轮统计。
    const savedUsage = conversation && typeof conversation.usage === 'object' ? conversation.usage : null;
    if (savedUsage) {
      this.sessionUsage.prompt = Number(savedUsage.prompt) || 0;
      this.sessionUsage.completion = Number(savedUsage.completion) || 0;
      this.sessionUsage.total = Number(savedUsage.total) || 0;
      this.sessionUsage.cached = Number(savedUsage.cached) || 0;
      this.sessionUsage.cacheCreation = Number(savedUsage.cacheCreation) || 0;
      this.sessionUsage.estimated = savedUsage.estimated === true;
    }
    // 恢复按模型分桶统计
    const savedByModel = conversation && typeof conversation.usageByModel === 'object' ? conversation.usageByModel : null;
    if (savedByModel) {
      this.sessionUsageByModel = {};
      for (const [m, u] of Object.entries(savedByModel)) {
        if (!u || typeof u !== 'object') continue;
        this.sessionUsageByModel[m] = {
          prompt: Number(u.prompt) || 0,
          completion: Number(u.completion) || 0,
          total: Number(u.total) || 0,
          cached: Number(u.cached) || 0,
          cacheCreation: Number(u.cacheCreation) || 0,
          estimated: u.estimated === true
        };
      }
    }
    // 恢复会话级模型/变体覆盖与极简模式
    if (conversation && typeof conversation.llmOverride === 'object') {
      this.llmOverride = {
        model: conversation.llmOverride.model || null,
        reasoningEffort: conversation.llmOverride.reasoningEffort != null ? conversation.llmOverride.reasoningEffort : null
      };
    } else {
      this.llmOverride = { model: null, reasoningEffort: null };
    }
    this.minimalMode = conversation && conversation.minimal === true;
    // 上下文管理器与历史记录解耦：
    // - historyMessages: 完整 transcript（永不破坏）
    // - messages: 工作上下文（可被压缩/清理，独立于 historyMessages）
    // 不恢复 summaries：避免完整 transcript + 旧摘要导致上下文溢出。
    // 上下文管理器会在下次 agentLoop 中按需重新压缩。
    let historyMsgs = Array.isArray(conversation.messages) ? conversation.messages : [];
    // 新版上下文模式 → 旧版历史自动迁移：
    // 旧版历史（无 schemaVersion=2）的 messages 是工作上下文快照，可能已被压缩/截断。
    // 无法恢复已删除的原始消息，但可将历史中残留的 summaries 以系统消息形式拼接到开头，
    // 保留早期内容概要；随后 saveToHistory 会以新格式（完整 transcript + schemaVersion=2）自动重写升级。
    if (conversation.schemaVersion !== 2) {
      historyMsgs = this._migrateLegacyHistory(conversation, historyMsgs);
    }
    this.contextManager.loadFromHistory(historyMsgs);
    if (conversation.tarotCard) {
      this.tarotCard = conversation.tarotCard;
      if (this.onMessage) this.onMessage('tarot', this.tarotCard);
    } else {
      // Draw new tarot card if history doesn't have one
      this.tarotCard = null;
    }
    if (conversation.workspacePath) {
      this.workspacePath = conversation.workspacePath;
      window.api.webControlSetWorkDir(conversation.workspacePath);
    }
    // Babe 模式：恢复好感度
    if (this.mode === 'babe' && typeof conversation.affection === 'number') {
      this.babeAffection = conversation.affection;
    }
    // 恢复子代理聊天记录：从历史快照重建 subAgents（subAgent 实例不可恢复，置 null；
    // 模态框会回退读取 record.messages 快照渲染完整对话）。
    if (Array.isArray(conversation.subAgents)) {
      this.subAgents = conversation.subAgents.map(r => ({
        id: r.id,
        task: r.task,
        tarot: r.tarot,
        status: r.status || 'done',
        startTime: r.startTime,
        endTime: r.endTime,
        iterations: r.iterations,
        toolUseCount: r.toolUseCount,
        usage: r.usage || {},
        messages: Array.isArray(r.messages) ? r.messages : [],
        subAgent: null
      }));
    } else {
      this.subAgents = [];
    }
    this.contextManager.setSystemPrompt(this.getSystemPrompt());
    if (this.onTitleChange) this.onTitleChange(this.conversationTitle || '未命名对话');
  }

  _migrateLegacyHistory(conversation, messages) {
    const arr = Array.isArray(messages) ? messages.slice() : [];
    const summaries = Array.isArray(conversation.summaries)
      ? conversation.summaries.filter(s => s && (typeof s === 'string' || s?.content || s?.summary || s?.text))
      : [];
    if (summaries.length > 0) {
      const summaryText = '【以下为早期对话的自动迁移摘要（旧版历史升级生成）】\n' + summaries.map((s) => {
        if (typeof s === 'string') return s;
        if (s?.content) return typeof s.content === 'string' ? s.content : JSON.stringify(s.content);
        if (s?.summary) return String(s.summary);
        if (s?.text) return String(s.text);
        return JSON.stringify(s);
      }).join('\n\n---\n\n');
      arr.unshift({ role: 'system', content: summaryText });
    }
    return arr;
  }

  async generateConversationTitle(userMessage) {
    const TU = (typeof window !== 'undefined' && window.CIBYPTitleUtils) ? window.CIBYPTitleUtils : null;
    const cleaned = ((userMessage || '').replace(/[\s\r\n]+/g, ' ').trim()) || '未命名对话';
    // LLM 不可用/超限/解析失败时的兜底：剥礼貌前缀取语义片段，而不是照抄整句
    const fallback = () => (TU ? TU.heuristicFallback(cleaned) : cleaned.substring(0, 20));
    try {
      const result = await window.api.chatLLM([
        { role: 'system', content: TU ? TU.buildTitlePrompt(this.mode) : '你是会话标题助手。只输出 2-12 字中文标题，提炼主题，禁止照抄用户原话。' },
        { role: 'user', content: cleaned }
      ], {
        temperature: 0, // 温度>0 会让部分思考型模型把 CoT 灌进 content（实测 nemotron lightning）
        max_tokens: 512, // 给结论留出空间；思考本身不在该预算内
        requestId: Date.now().toString(),
        sessionKey: this.sessionKey || null
      });

      // LLM 侧失败（未配置/预算/超限等）直接走启发式兜底
      if (!result || result.ok !== true || !result.data) return fallback();
      const msg = result.data?.choices?.[0]?.message || {};
      const rawContent = msg.content || '';
      const rawReasoning = msg.reasoning_content || msg.reasoning || '';

      let title = '';
      if (TU && TU.isThinkingDump(rawContent)) {
        // 思考型模型把 CoT 写进了 content：整体放弃，从 content+reasoning 尾部提炼结论
        title = TU.extractTitleFromCoT(`${rawContent}\n\n${rawReasoning}`, cleaned);
      } else {
        title = TU ? TU.cleanTitle(rawContent) : String(rawContent).trim();
        if (TU && (TU.isMetaDescription(title) || TU.looksLikeEcho(title, cleaned))) {
          title = TU.extractTitleFromCoT(`${rawContent}\n\n${rawReasoning}`, cleaned)
            || TU.extractTitleFromReasoning(rawReasoning);
        }
      }
      // 终检：非空、非元描述、非照抄原话、长度合理
      const valid = TU
        ? title && title.length >= 2 && title.length <= TU.MAX_TITLE_LEN
          && !TU.isMetaDescription(title) && !TU.looksLikeEcho(title, cleaned)
        : title && title.length >= 2;
      if (valid) {
        return TU ? title.substring(0, TU.MAX_TITLE_LEN) : title.substring(0, 20);
      }
      return fallback();
    } catch {
      return fallback();
    }
  }

  stop() {
    this.stopped = true;
    this.running = false;
    this.runId++;
    this.hotMessages = [];
    if (this.pendingApproval) this.resolveApproval(false);
    if (this.pendingToolAuth) this.resolveToolAuth('deny');
    // 按会话定向中止：只中止当前 Agent 的 LLM 请求和终端命令。
    // 没有 sessionKey 时回退到全局 abort（兼容旧调用/系统级停止）。
    if (window.api?.agentAbort && this.sessionKey) {
      try { window.api.agentAbort(this.sessionKey); } catch { /* ignore */ }
    } else if (window.api?.agentAbortAll) {
      try { window.api.agentAbortAll(); } catch { /* ignore */ }
    }
    // 同步停止所有子代理
    for (const sub of this.subAgents) {
      if (sub.subAgent) {
        sub.subAgent.stopped = true;
        sub.subAgent.running = false;
        sub.subAgent.runId++;
      }
    }
    if (this.onStatusChange) this.onStatusChange('idle');
  }

  /**
   * 热对话：在Agent工作期间注入新消息
   * 消息会在下一次LLM调用前加入上下文
   */
  injectHotMessage(userMessage, attachments = []) {
    let fullMessage = userMessage;
    if (attachments.length > 0) {
      const attachInfo = attachments.map(a => {
        const exactPath = a.path ? `\n⚠️ 精确文件路径（必须逐字使用，禁止修改任何字符）: ${a.path}` : '';
        // 隐私信息保护：热对话附件的 OCR/提取文本同样过滤隐私信息
        if (a.ocrText) return `[附件: ${a.name}]${exactPath}\nOCR识别文本:\n${this._sanitizeAttachmentText(a.ocrText)}`;
        if (a.extractedText) {
          let text = a.extractedText.length > 2000 ? a.extractedText.substring(0, 2000) + '\n...[已截断]' : a.extractedText;
          text = this._sanitizeAttachmentText(text);
          const converted = a.convertedPath ? `\n已转换文本路径: ${a.convertedPath}` : '';
          const original = a.path && a.convertedPath && a.path !== a.convertedPath ? `\n⚠️ 原始文件精确路径（用于officeHardUnpack，必须原样使用）: ${a.path}` : exactPath;
          return `[文件附件: ${a.name}]${converted}${original}\n提取文本:\n${text}`;
        }
        if (a.convertedPath) return `[文件附件: ${a.name}]\n已转换文本路径: ${a.convertedPath}${exactPath}`;
        if (a.isImage) return `[图片附件: ${a.name}]${exactPath}`;
        return `[文件附件: ${a.name}]${exactPath}`;
      }).join('\n');
      fullMessage = userMessage + '\n\n' + attachInfo;
    }
    this.hotMessages.push(fullMessage);
  }

  /**
   * 共享上下文管理：三层压缩 + 语义压缩后仍超限的智能硬截断。
   * 主 Agent 和子代理循环均调用此方法，确保上下文不溢出。
   * @param {ContextManager} ctx - 要管理的上下文（默认 this.contextManager）
   * @param {function} [notify] - 可选通知回调 (msg) => void
   * @param {object} [opts] - { maxFailures, keepLast, isSubAgent }
   * @returns {Promise<{action: string, usage: number}>} 实际采取的动作
   */
  async _manageContext(ctx = this.contextManager, notify, opts = {}) {
    const maxFailures = opts.maxFailures ?? (this.settings?.agent?.autoCompactMaxFailures ?? 3);
    const isSub = !!opts.isSubAgent;
    const prefix = isSub ? '[子代理] ' : '';
    // 水位线策略（借鉴 DeepSeek Harness compaction-basic）：
    // 真实计量（system + tools + messages + 输出预留）按模型窗口比例解析阈值。
    // 判断一律用 usageWithReserve（与 UI 上下文圆环一致）。
    const policy = (typeof ctx.resolvePolicy === 'function')
      ? ctx.resolvePolicy(this.settings?.contextCompaction || {})
      : null;
    const thresholdPct = policy ? policy.thresholdRatio * 100 : 85;
    const readStats = () => ctx.getStats();
    const usageOf = (st) => parseFloat(st.usageWithReserve ?? st.usage);
    let stats = readStats();
    let usage = usageOf(stats);
    let action = 'none';

    // Tier0：无模型剪枝（不调 LLM）——确定性截断"旧"的超大工具结果
    if (usage > thresholdPct && typeof ctx.pruneOldToolResults === 'function') {
      const pruned = ctx.pruneOldToolResults(policy);
      if (pruned > 0) {
        action = 'prune';
        const nowPct = usageOf(readStats());
        if (notify) notify(`${prefix}已剪枝 ${pruned} 条旧工具结果（${stats.usageWithReserve ?? stats.usage}% → ${nowPct.toFixed(1)}% 含输出预留）`);
      }
    }

    // Tier1：LLM 结构化摘要 —— 压缩最老的 head（token 预算 + tool 配对切点）
    let newUsage1 = usageOf(readStats());
    if (newUsage1 > thresholdPct && this.autoCompactFailures < maxFailures) {
      try {
        const sumRes = await ctx.summarizeWithLLM({
          policy,
          sessionKey: this.sessionKey || null,
          tools: this.getRuntimeToolSchemas(), // 会话回放：复用暖前缀缓存
          maxRetries: this.settings?.contextCompaction?.compactionRetries ?? 1,
          maxTokens: this.settings?.contextCompaction?.summarizeMaxTokens || 2048,
          model: this.llmOverride?.model || null,
          reasoningEffort: this.getActiveReasoningEffort()
        });
        if (sumRes.ok && !sumRes.skipped) {
          this.autoCompactFailures = 0;
          action = action === 'prune' ? 'prune_summary' : 'summary';
          if (notify) notify(`${prefix}已自动压缩上下文（${sumRes.message}），当前 ${usageOf(readStats()).toFixed(1)}%（含输出预留）`);
        } else {
          this.autoCompactFailures++;
          action = 'summary_failed';
          if (notify) notify(`${prefix}上下文压缩失败（${this.autoCompactFailures}/${maxFailures}）：${sumRes.message}`);
        }
      } catch (e) {
        this.autoCompactFailures++;
        action = 'summary_error';
        if (notify) notify(`${prefix}上下文压缩异常（${this.autoCompactFailures}/${maxFailures}）：${e.message}`);
      }
    }

    // Tier2：provider 实际溢出时由 agentLoop 的溢出恢复钩子处理；
    // 语义压缩仍超限时不在此硬切，避免无谓破坏，等 provider 明确报溢出再降级。
    return { action, usage: usageOf(readStats()) };
  }

  _repairReasoningContent() {
    // DeepSeek 等思考模型开启 thinking 模式后，要求历史 assistant 消息回传其
    // reasoning_content 字段，否则返回 invalid_request_error（400）。
    // 为缺失该字段的 assistant 消息补全（优先用已保存的 reasoning，否则用空字符串），
    // 采用 replace-not-mutate：替换为新数组，不破坏 historyMessages 里的完整记录。
    const ctx = this.contextManager;
    if (!ctx || !Array.isArray(ctx.messages)) return false;
    let changed = false;
    const msgs = ctx.messages.map((m) => {
      if (m && m.role === 'assistant' && m.reasoning_content === undefined) {
        changed = true;
        const reasoning = (m.reasoning !== undefined && m.reasoning !== null) ? m.reasoning : '';
        return { ...m, reasoning_content: reasoning, reasoning: undefined };
      }
      return m;
    });
    if (changed) ctx.messages = msgs;
    return changed;
  }

  async agentLoop(runId) {
    let iterations = 0;
    // 移除硬性迭代上限：完全由 running/stopped/runId 控制
    // 原本的 maxIterations=50 会在长任务中被误触顶，导致工作中断
    while (this.running && !this.stopped && runId === this.runId) {
      iterations++;

      // 上下文管理：水位线压缩（Tier0 剪枝 → Tier1 结构化摘要 → Tier2 溢出恢复）
      // 自动压缩总开关在设置「上下文」页，关闭后跳过（手动按钮仍可用）。
      if (!this.minimalMode && this.settings?.contextCompaction?.enabled !== false) {
        await this._manageContext(this.contextManager, (msg) => {
          if (this.onMessage) this.onMessage('system', msg);
        });
      }

      // 热对话：注入用户在Agent工作期间发送的新消息
      while (this.hotMessages.length > 0) {
        const hotMsg = this.hotMessages.shift();
        this.contextManager.addUserMessage(`【用户追加消息】${hotMsg}`);
        if (this.onMessage) this.onMessage('system', '已将新消息注入当前对话');
      }

      if (!this.minimalMode && this.settings?.autoOptimizeToolSelection && !this.sessionAutoOptimizeDisabled && !this.hasUsableOptimizedSelection()) {
        await this.optimizeToolsForConversation(this.getLatestUserMessageText(), '循环检测到优化未执行，自动补偿优化');
      }

      // 已激活技能作为易变后缀注入（最后一条 user 消息前），保护前缀缓存
      const messages = this.injectActiveSkillsSuffix(this.contextManager.getMessages());
      const tools = this.getRuntimeToolSchemas();
      const streamEnabled = this.settings?.llm?.streamResponses !== false;
      // requestId 必须全局唯一：并发会话可能在同一毫秒启动同一轮循环，
      // 若只靠时间戳+轮次会撞车，导致流式 chunk 串到别的会话。
      const reqId = 'agent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '-' + iterations;

      let result;
      let usedStreaming = false;
      if (streamEnabled && typeof window.api.chatLLMStream === 'function') {
        // Streaming path: surface live tokens to the UI via stream-chunk events.
        // If streaming fails for any reason, fall back to non-streaming.
        this._activeStreamRequestId = reqId;
        if (this.onMessage) this.onMessage('stream-start', { requestId: reqId });
        try {
          result = await window.api.chatLLMStream(messages, this._llmOptions({
            tools: tools.length > 0 ? tools : undefined,
            requestId: reqId,
            sessionKey: this.sessionKey || null
          }));
          usedStreaming = true;
        } catch (streamErr) {
          // 用户主动停止时不再回退到非流式（否则会重新发起请求）
          if (this.stopped || runId !== this.runId) {
            if (this.onMessage) this.onMessage('stream-end', { requestId: reqId, content: '', aborted: true });
            throw streamErr;
          }
          // Streaming failed — fall back to non-streaming
          if (this.onMessage) this.onMessage('stream-end', { requestId: reqId, content: '', fallback: true });
          if (this.onMessage) this.onMessage('system', `流式请求失败，回退到普通模式：${streamErr.message || streamErr}`);
          result = await window.api.chatLLM(messages, this._llmOptions({
            tools: tools.length > 0 ? tools : undefined,
            requestId: reqId + '-retry',
            sessionKey: this.sessionKey || null
          }));
        } finally {
          this._activeStreamRequestId = null;
        }
        if (usedStreaming) {
          let fullContent = result?.ok ? (result.data.choices?.[0]?.message?.content || '') : '';
          const fullReasoning = result?.ok ? (result.data.choices?.[0]?.message?.reasoning || '') : '';
          // Babe 模式：解析好感度变化，剥离显示标记
          if (this.mode === 'babe' && fullContent) {
            const delta = this.parseAffectionChange(fullContent);
            if (delta !== null) {
              this.applyAffectionChange(delta);
              fullContent = fullContent.replace(/【好感度[+-]?\d+】/g, '').trimEnd();
              // 同步修改 result 中的 content，确保后续 addAssistantMessage 使用剥离后的内容
              if (result.data?.choices?.[0]?.message) result.data.choices[0].message.content = fullContent;
              if (this.onMessage) this.onMessage('affection-change', { delta, value: this.babeAffection });
            }
          }
          if (this.onMessage) this.onMessage('stream-end', { requestId: reqId, content: fullContent, reasoning: fullReasoning });
        }
      } else {
        // Non-streaming path (existing behavior).
        result = await window.api.chatLLM(messages, {
          tools: tools.length > 0 ? tools : undefined,
          requestId: reqId,
          sessionKey: this.sessionKey || null
        });
      }

      if (this.stopped || runId !== this.runId) break;

      if (!result.ok) {
        // ===== 自动修复 + 重试循环：所有提供商返回的错误（invalid_request_error、402、
        // rate_limit、5xx、网络错误等）都先尝试自动修复并重试，重试用尽后才报错停止 =====
        const errText = String(result.error || '');
        const kind = result.kind;
        const MAX_PROVIDER_RETRIES = 3;
        // 可修复/可重试的客户端类错误：
        //   - HTTP 400 / client / payment(402) 类型
        //   - 上下文配对错误（tool_calls 未配对等，DeepSeek/OpenAI 常见）
        //   - 思考模型要求回传 reasoning_content（DeepSeek 等）
        const isFixableClient = kind === 'client' || kind === 'payment' ||
          result.status === 400 || result.status === 402 ||
          /tool_calls?|tool_call_id|insufficient tool messages|following tool_calls|400|402|invalid|bad request|不合法|messages.*context|reasoning_content|thinking mode|must be passed back/i.test(errText);
        // auth 类错误（401/403）属于配置问题，重试无意义，直接报错
        const isAuthError = kind === 'auth';
        // provider 明确报上下文溢出：旁路容量元数据，直接做最大 head 缩减后重试
        const isOverflow = /context.{0,24}(length|window|overflow|exceed|too (long|large))|maximum context|too many tokens|input.{0,12}too long|prompt.{0,12}too long|400.{0,24}(context|tokens|length)/i.test(errText)
          || (result.status === 400 && /(context|tokens|length)/i.test(errText));
        if (isOverflow) {
          const removed = this.contextManager.hardTruncate(
            this.contextManager.resolvePolicy({ retainRatio: 0.06 })
          );
          if (removed > 0 && this.onMessage) {
            this.onMessage('system', `⚠️ 检测到上下文溢出，已安全截断 ${removed} 条旧消息后重试`);
          }
        }

        let retryCount = 0;
        while (!result.ok && !isAuthError && retryCount < MAX_PROVIDER_RETRIES
               && this.running && !this.stopped && runId === this.runId) {
          retryCount++;
          let fixedNote = '';
          if (isFixableClient) {
            // 先尝试 sanitize 修复损坏的上下文（未配对的 tool_calls 等）
            const sanitizationResult = this.contextManager.sanitize();
            if (sanitizationResult.fixed) {
              fixedNote = `，已自动修复 ${sanitizationResult.removedCount} 条问题消息（${sanitizationResult.beforeLength}→${sanitizationResult.afterLength}）`;
            }
            // 思考模型要求回传 reasoning_content：为缺失该字段的 assistant 消息补全后重试
            if (/reasoning_content|thinking mode|must be passed back/i.test(errText)) {
              const reasoningFixed = this._repairReasoningContent();
              if (reasoningFixed) fixedNote = '，已自动补全 reasoning_content 字段';
            }
          }
          if (this.onMessage) {
            this.onMessage('system', `⚠️ LLM 请求失败（${kind || 'unknown'}：${errText.slice(0, 120)}），正在自动重试（${retryCount}/${MAX_PROVIDER_RETRIES}）${fixedNote}`);
          }
          // 指数退避，避免对不稳定的提供商发起高频请求
          await new Promise(r => setTimeout(r, 800 * retryCount));
          if (this.stopped || runId !== this.runId) break;
          // 重新构建消息（修复可能已改动上下文）并用非流式重试，避免流式事件错乱
          const retryMessages = this.injectActiveSkillsSuffix(this.contextManager.getMessages());
          const retryTools = this.getRuntimeToolSchemas();
          try {
            result = await window.api.chatLLM(retryMessages, this._llmOptions({
              tools: retryTools.length > 0 ? retryTools : undefined,
              requestId: reqId + '-retry-' + retryCount,
              sessionKey: this.sessionKey || null
            }));
            usedStreaming = false; // 重试走非流式路径
          } catch (retryErr) {
            if (this.stopped || runId !== this.runId) break;
            result = { ok: false, error: retryErr.message || String(retryErr), kind: 'client' };
          }
        }
        if (this.stopped || runId !== this.runId) break;

        // 重试仍失败：报错并停止
        if (!result.ok) {
          const errMsg = result.error || 'LLM 请求失败';
          const retryNote = retryCount > 0 ? `（已自动修复并重试 ${retryCount} 次后仍失败）` : '';
          if (this.onMessage) this.onMessage('error', errMsg + retryNote);
          try { this.contextManager.addSystemMessage(`[错误] ${errMsg}${retryNote}`, { type: 'error' }); }
          catch { /* ignore */ }
          break;
        }
      }

      // 累计会话 token 使用（支持缓存命中/缓存创建解析）
      // - OpenAI: usage.prompt_tokens_details.cached_tokens
      // - Anthropic: usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      if (result.data?.usage) {
        this._accumulateUsage(result.data.usage, result.data?._meta?.model);
        // 用真实 prompt_tokens 校准估算器（滑动平滑，修正 CJK 等估算偏差）
        const promptTokens = result.data.usage.prompt_tokens ?? result.data.usage.input_tokens;
        if (promptTokens && this.contextManager && typeof this.contextManager.calibrateTokens === 'function') {
          this.contextManager.calibrateTokens(promptTokens, this.contextManager.getRawTotalTokens());
        }
      }

      const choice = result.data.choices?.[0];
      if (!choice) break;

      const assistantMsg = choice.message;
      if (this.stopped || runId !== this.runId) break;
      // Babe 模式：解析并应用好感度变化，剥离显示标记
      let affectionDelta = null;
      if (this.mode === 'babe' && assistantMsg.content) {
        affectionDelta = this.parseAffectionChange(assistantMsg.content);
        if (affectionDelta !== null) {
          this.applyAffectionChange(affectionDelta);
          // 从存储和显示内容中剥离好感度标记
          assistantMsg.content = assistantMsg.content.replace(/【好感度[+-]?\d+】/g, '').trimEnd();
          if (this.onMessage) this.onMessage('affection-change', { delta: affectionDelta, value: this.babeAffection });
        }
      }
      // Store reasoning in the assistant message for context (some models benefit)
      // 隐私信息保护：写入 AI 上下文的 tool_calls 使用脱敏副本（敏感键值 + 终端命令全文扫描），
      // 真实执行仍用下方循环中的原始 assistantMsg.tool_calls。
      let assistantToolCallsForCtx = assistantMsg.tool_calls;
      if (this.settings?.privacyProtection?.enabled
          && typeof PrivacyFilter?.sanitizeToolCallsForContext === 'function') {
        assistantToolCallsForCtx = PrivacyFilter.sanitizeToolCallsForContext(assistantMsg.tool_calls, {
          maskArgs: this.settings.privacyProtection.filterArgs !== false,
          scanTerminal: this.settings.privacyProtection.filterTerminal !== false,
          categories: this._getPrivacyCategories()
        });
      }
      this.contextManager.addAssistantMessage(assistantMsg.content, assistantToolCallsForCtx, assistantMsg.reasoning);

      // 实时保存：AI 回复入上下文后立即持久化
      this.saveToHistory();

      // Emit assistant text — only in non-streaming mode (streaming path
      // already rendered tokens via stream-chunk/stream-end).
      if (!usedStreaming && assistantMsg.content) {
        if (this.onMessage) this.onMessage('assistant', assistantMsg.content);
      }

      // Handle tool calls
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (let i = 0; i < assistantMsg.tool_calls.length; i++) {
          if (this.stopped || runId !== this.runId) break;

          const tc = assistantMsg.tool_calls[i];
          const toolName = tc.function.name;
          let args;
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }

          if (toolName === '__reoptimizeToolSelection') {
            if (this.onToolCall) this.onToolCall(toolName, args, 'calling', undefined, tc.id);
            const reasonText = typeof args?.reason === 'string' ? args.reason : '';
            const beforeCount = Array.isArray(this.optimizedToolNames) ? this.optimizedToolNames.length : 0;
            const optimizeRes = await this.optimizeToolsForConversation(this.getLatestUserMessageText(), reasonText || '运行中重优化');
            const afterCount = Array.isArray(this.optimizedToolNames) ? this.optimizedToolNames.length : 0;
            const appended = Math.max(0, afterCount - beforeCount);
            const resultStr = JSON.stringify({
              ok: optimizeRes.ok !== false,
              selected: this.optimizedToolNames || [],
              reason: this.optimizedToolReason || reasonText || '重优化完成',
              appended,
              message: appended > 0
                ? `已追加 ${appended} 个工具（已有工具保持原序，前缀缓存仅尾部受影响）`
                : '当前工具已足够，未追加新工具',
              allEnabled: this.getEnabledToolDefinitions().map(t => t.name)
            });
            this.contextManager.addToolResult(tc.id, toolName, resultStr);
            if (this.onToolCall) this.onToolCall(toolName, args, 'done', JSON.parse(resultStr), tc.id);
            continue;
          }

          if (toolName === '__disableAutoOptimize') {
            if (this.onToolCall) this.onToolCall(toolName, args, 'calling', undefined, tc.id);
            this.sessionAutoOptimizeDisabled = true;
            // 保留冻结选择序（不清空）：_orderedActiveToolNames 会以"冻结序 + 其余追加"补全，
            // 保证已加载工具前缀字节不变，避免整体替换 tools 数组打断前缀缓存。
            this.contextManager.setSystemPrompt(this.getSystemPrompt());
            const resultStr = JSON.stringify({
              ok: true,
              message: '已在本会话中禁用自动工具选择优化，所有已启用工具现在都可用。',
              allEnabled: this.getEnabledToolDefinitions().map(t => t.name)
            });
            this.contextManager.addToolResult(tc.id, toolName, resultStr);
            if (this.onToolCall) this.onToolCall(toolName, args, 'done', JSON.parse(resultStr), tc.id);
            continue;
          }

          // 并行 Task 批次检测：连续的 runSubAgent 调用合并成一批并行执行
          // 参考 claude-code-ref 的 partitionToolCalls + runToolsConcurrently 模式
          if (toolName === 'runSubAgent') {
            let batchEnd = i + 1;
            while (batchEnd < assistantMsg.tool_calls.length
                   && assistantMsg.tool_calls[batchEnd].function.name === 'runSubAgent') {
              batchEnd++;
            }
            const batchSize = batchEnd - i;
            if (batchSize > 1) {
              // 并行执行多个 Task 调用（最多 4 个并发，防止资源耗尽）
              const batch = assistantMsg.tool_calls.slice(i, batchEnd);
              const MAX_PARALLEL = 4;
              if (this.onMessage) this.onMessage('sub-agent-batch-start', {
                count: batchSize,
                tasks: batch.map(c => {
                  try { return JSON.parse(c.function.arguments || '{}').task || ''; }
                  catch { return ''; }
                })
              });

              // 分批执行（每批最多 MAX_PARALLEL 个并发）
              for (let bStart = 0; bStart < batch.length; bStart += MAX_PARALLEL) {
                if (this.stopped || runId !== this.runId) break;
                const chunk = batch.slice(bStart, bStart + MAX_PARALLEL);
                await Promise.all(chunk.map(async (batchTc) => {
                  let batchArgs;
                  try { batchArgs = JSON.parse(batchTc.function.arguments || '{}'); } catch { batchArgs = {}; }
                  // 不发射 tool_call/tool-result 事件 — 子代理有独立卡片和模态框
                  const r = await this.executeTool('runSubAgent', batchArgs);
                  let resultStr = typeof r === 'string' ? r : JSON.stringify(r);
                  // 隐私信息保护：子代理结果报告注入父上下文前过滤隐私信息
                  if (this.settings?.privacyProtection?.enabled
                      && this.settings.privacyProtection.filterResults !== false
                      && typeof PrivacyFilter?.filterPrivacyInfo === 'function') {
                    resultStr = PrivacyFilter.filterPrivacyInfo(resultStr, this._getPrivacyCategories());
                  }
                  this.contextManager.addToolResult(batchTc.id, 'runSubAgent', resultStr);
                }));
              }

              if (this.onMessage) this.onMessage('sub-agent-batch-done', { count: batchSize });
              i = batchEnd - 1; // 跳过已并行执行的批次（for 循环会再 +1）
              continue;
            }
            // 单个 Task 调用：落到下面的常规顺序执行
          }

          if (this.onToolCall) this.onToolCall(toolName, args, 'calling', undefined, tc.id);
          // 通知 UI（Code 模式用于显示工具调用卡片）
          if (this.onMessage) this.onMessage('tool_call', { name: toolName, args, callId: tc.id });

          // Check if sensitive
          const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
          const isSensitive = toolDef?.sensitive && !this.settings.autoApproveSensitive;

          // ===== 工具首次使用授权（Playwright / Computer Use）=====
          // 这些工具不再标记为 sensitive（不再每次调用都弹敏感确认），
          // 改为首次使用时弹出一次授权模态框：用户选择"允许并记住"后写入 settings.toolAuthGranted 持久化；
          // "仅本次"则只允许本次会话内使用；"拒绝"则跳过调用并返回错误。
          const authCategory = (typeof getToolAuthCategory === 'function') ? getToolAuthCategory(toolName) : null;
          if (authCategory && !(this.settings?.toolAuthGranted?.[authCategory] === true || this._sessionToolAuth?.[authCategory] === true)) {
            const decision = await this.requestToolAuth(toolName, authCategory);
            if (decision === 'deny' || !decision) {
              const result = JSON.stringify({ ok: false, error: '用户未授权使用此工具' });
              this.contextManager.addToolResult(tc.id, toolName, result);
              if (this.onToolCall) this.onToolCall(toolName, args, 'denied', undefined, tc.id);
              continue;
            }
            // 'allow-once' 仅本次会话生效，不写入 settings
            if (decision === 'allow-always') {
              try {
                const s = await window.api.getSettings();
                if (!s.toolAuthGranted) s.toolAuthGranted = { playwright: false, computerUse: false };
                s.toolAuthGranted[authCategory] = true;
                await window.api.setSettings(s);
                this.settings = s;
              } catch (e) { /* 持久化失败时降级为本次会话内允许 */ }
            }
            // 'allow-once' / 'allow-always' 都允许本次会话内继续使用
            if (!this._sessionToolAuth) this._sessionToolAuth = {};
            this._sessionToolAuth[authCategory] = true;
          }

          // Extra check for terminal commands
          let needsApproval = isSensitive;
          if (toolName === 'runTerminalCommand' || toolName === 'awaitTerminalCommand' || toolName === 'runShellScriptCode') {
            const cmd = args.command || args.script || '';
            if (this.isDangerousCommand(cmd)) needsApproval = true;
          }
          // terminalSendInput / terminalAnswerPrompt 可能提交危险命令（shell 粘贴执行）
          if (toolName === 'terminalSendInput' || toolName === 'terminalAnswerPrompt') {
            const text = args.text || args.answer || '';
            if (this.isDangerousCommand(text)) needsApproval = true;
          }

          if (needsApproval && !this.settings.autoApproveSensitive) {
            let approved = false;
            // If email control is enabled with send+receive mode, use email-based approval
            const emailMode = this.settings?.email?.mode || 'send-receive';
            if (this.settings?.email?.enabled && emailMode === 'send-receive') {
              const chatMd = this.contextManager.getMessages().map(m => {
                if (m.role === 'user') return `**用户**: ${m.content}`;
                if (m.role === 'assistant') return `**AI**: ${m.content || ''}`;
                return '';
              }).filter(Boolean).join('\n\n');
              const emailResult = await window.api.emailRequestApproval(toolName, args, chatMd);
              approved = emailResult.ok !== false && emailResult.approved;
            } else if (this.settings?.email?.enabled && emailMode !== 'send-receive') {
              // Email enabled but cannot do full approval flow → auto-reject
              approved = false;
            } else {
              approved = await this.requestApproval(toolName, args);
            }
            if (!approved) {
              const result = JSON.stringify({ ok: false, error: '用户拒绝了此操作' });
              this.contextManager.addToolResult(tc.id, toolName, result);
              if (this.onToolCall) this.onToolCall(toolName, args, 'denied', undefined, tc.id);
              continue;
            }
          }

          const toolResult = await this.executeTool(toolName, args);
          if (this.stopped || runId !== this.runId) break;

          // 隐私信息保护：UI 展示副本过滤隐私信息（真实 toolResult 仍保留完整结构）
          const displayResult = this._sanitizeToolResultForDisplay(toolResult);

          // 通知 UI 工具执行结果
          if (this.onMessage) this.onMessage('tool-result', { name: toolName, result: displayResult, callId: tc.id });

          // 多模态工具结果：图片以 image_url 格式注入上下文，而非 base64 字符串
          if (toolResult && toolResult._multimodal && toolResult.imageUrl) {
            this.contextManager.addMultimodalToolResult(tc.id, toolName, toolResult.text, toolResult.imageUrl);
            if (this.onToolCall) this.onToolCall(toolName, args, 'done', displayResult, tc.id);
            continue;
          }

          const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

          // 小文件不截断：Code Agent 常需读取完整源代码，3000字符阈值会把小文件也截断。
          // 仅对大结果截断，且阈值提高到 20000，保留前 18000 + 尾部 2000（保留文件开头和结尾）。
          let truncated = resultStr;
          if (resultStr.length > 20000) {
            const head = resultStr.substring(0, 18000);
            const tail = resultStr.substring(resultStr.length - 2000);
            truncated = `${head}\n\n...[中间部分已截断，共${resultStr.length}字符]...\n\n${tail}`;
          }
          // 隐私信息保护：工具结果注入 AI 上下文前过滤手机号/证件号/密钥等隐私信息
          if (this.settings?.privacyProtection?.enabled
              && this.settings.privacyProtection.filterResults !== false
              && typeof PrivacyFilter?.filterPrivacyInfo === 'function') {
            truncated = PrivacyFilter.filterPrivacyInfo(truncated, this._getPrivacyCategories());
          }
          this.contextManager.addToolResult(tc.id, toolName, truncated);

          if (this.onToolCall) this.onToolCall(toolName, args, 'done', displayResult, tc.id);
        }

        // 实时保存：每轮工具调用完成后立即持久化，防止进程异常导致丢失
        this.saveToHistory();

        if (this.stopped || runId !== this.runId) break;
        // Continue the loop to let the agent process tool results
        continue;
      }

      // No tool calls, agent is done with this turn
      if (choice.finish_reason === 'stop') {
        // 热对话修复：stop后检查是否有待处理的热消息，有则继续循环
        if (this.hotMessages.length > 0) {
          continue; // 回到循环顶部，热消息将在下一轮注入
        }
        break;
      }
    }

    this.running = false;
    if (this.onStatusChange) this.onStatusChange('idle');
  }

  isDangerousCommand(cmd) {
    const cmdLower = cmd.toLowerCase();
    const allDangerous = [...DANGEROUS_COMMANDS.common, ...DANGEROUS_COMMANDS.windows, ...DANGEROUS_COMMANDS.linux, ...DANGEROUS_COMMANDS.macos];
    return allDangerous.some(d => cmdLower.includes(d.toLowerCase()));
  }

  async requestApproval(toolName, args) {
    return new Promise((resolve) => {
      this.pendingApproval = { toolName, args };
      this.approvalResolve = resolve;
      if (this.onMessage) this.onMessage('approval', { toolName, args });
    });
  }

  resolveApproval(approved) {
    if (this.approvalResolve) {
      this.approvalResolve(approved);
      this.approvalResolve = null;
      this.pendingApproval = null;
    }
    const session = window.__sessionManager?.getByAgent(this);
    if (session) {
      session.pendingApproval = null;
      window.__sessionManager.setStatus(session, this.running ? window.SessionStatus.RUNNING : window.SessionStatus.IDLE);
      window.__sessionManager.setAttention(session, null);
    }
  }

  /**
   * 弹出"工具首次使用授权"模态框，等待用户决策。
   * 返回值：'allow-always'（持久化）| 'allow-once'（仅本次会话）| 'deny'
   */
  requestToolAuth(toolName, category) {
    return new Promise((resolve) => {
      this.pendingToolAuth = { toolName, category };
      this.toolAuthResolve = resolve;
      if (this.onMessage) this.onMessage('tool-auth-required', { toolName, category });
    });
  }

  resolveToolAuth(decision) {
    if (this.toolAuthResolve) {
      this.toolAuthResolve(decision);
      this.toolAuthResolve = null;
      this.pendingToolAuth = null;
    }
    const session = window.__sessionManager?.getByAgent(this);
    if (session) {
      session.pendingToolAuth = null;
      window.__sessionManager.setStatus(session, this.running ? window.SessionStatus.RUNNING : window.SessionStatus.IDLE);
      window.__sessionManager.setAttention(session, null);
    }
  }

  async executeTool(name, args) {
    try {
      // DeepSeek 兼容：dsh 标准工具名 → CIBYP 实现名 + 参数适配（translated 档）。
      // 模型表面只暴露 CIBYP 规范名；此处仅处理别名入口，不新增 schema。
      const originalName = name;
      if (typeof resolveDsToolName === 'function') {
        const mapped = resolveDsToolName(name);
        if (mapped !== name) {
          name = mapped;
          if (typeof adaptDsArgs === 'function') {
            args = adaptDsArgs(originalName, args);
          }
        }
      }
      // DeepSeek 插件导入工具：ds__<pluginId>__<tool> 路由到插件宿主执行
      if (typeof name === 'string' && name.startsWith('ds__') && typeof window.api.dsPluginToolCall === 'function') {
        const [pluginId, toolName] = name.slice(4).split('__');
        const result = await window.api.dsPluginToolCall(pluginId, toolName, args || {}, this._scriptCwd(), this._sandboxMode(), this.sessionKey || null);
        if (result && typeof result === 'object' && result.ok !== undefined) return result;
        return { ok: true, result };
      }
      const normalizeOk = (result, key = 'result') => {
        if (result && typeof result === 'object' && result.ok !== undefined) return result;
        if (key) return { ok: true, [key]: result };
        return { ok: true, result };
      };
      if (this.settings?.tools && this.settings.tools[name] === false) {
        if (this.settings?.autoOptimizeToolSelection && !name.startsWith('__')) {
          await this.optimizeToolsForConversation(this.getLatestUserMessageText(), `工具 ${name} 被禁用，需要重优化`);
        }
        return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('tool_disabled', '该工具已禁用') : '该工具已禁用' };
      }
      switch (name) {
        case 'getTarot': {
          const result = await window.api.drawTarot(args?.spread ? { spread: args.spread } : undefined);
          return { ok: true, result };
        }
        case 'todoList': return this.handleTodo(args);
        case 'runSubAgent': return await this.runSubAgent(args);
        case 'generateImage': {
          if (!this.workspacePath) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('no_workspace', '未设置工作区路径') : '未设置工作区路径' };
          }
          return await window.api.generateImage(args.prompt, this.workspacePath);
        }
        case 'calculator': {
          return await window.api.calcEvaluate(args.expression);
        }
        case 'factorInteger': {
          return await window.api.calcFactorInteger(args.value);
        }
        case 'gcdLcm': {
          return await window.api.calcGcdLcm(args.values);
        }
        case 'baseConvert': {
          return await window.api.calcBaseConvert(args.value, args.fromBase, args.toBase);
        }
        case 'factorial': {
          return await window.api.calcFactorial(args.n);
        }
        case 'complexMath': {
          return await window.api.calcComplexMath(args.operation, args.a, args.b, args.exponent);
        }
        case 'matrixMath': {
          return await window.api.calcMatrixMath(args.operation, args.A, args.B);
        }
        case 'vectorMath': {
          return await window.api.calcVectorMath(args.operation, args.a, args.b, args.c);
        }
        case 'solveInequality': {
          return await window.api.calcSolveInequality(args.coefficients, args.relation, args.variable);
        }
        case 'solveLinearSystem': {
          return await window.api.calcSolveLinearSystem(args.A, args.b);
        }
        case 'solvePolynomial': {
          return await window.api.calcSolvePolynomial(args.coefficients);
        }
        case 'distributionCalc': {
          return await window.api.calcDistribution(args.distribution, args.operation, args.params, args.x);
        }
        case 'combinatorics': {
          return await window.api.calcCombinatorics(args.operation, args.n, args.r, args.repetition);
        }
        case 'fractionBaseConvert': {
          return await window.api.calcFractionBaseConvert(args.value, args.fromBase, args.toBase, args.precision);
        }
        case 'webSearch': return await window.api.webSearch(args.query, this.workspacePath);
        case 'webFetch': return await window.api.webFetch(args.url);
        case 'offscreenRenderOCR': {
          return await window.api.webOffscreenSnapshotOCR({
            url: args.url,
            waitMs: args.waitMs,
            width: args.width,
            height: args.height,
            workspacePath: this.workspacePath
          });
        }
        case 'offscreenRenderContent': {
          return await window.api.webOffscreenRenderedContent({
            url: args.url,
            waitMs: args.waitMs,
            width: args.width,
            height: args.height,
            captureScreenshot: args.captureScreenshot,
            includeHtml: args.includeHtml,
            workspacePath: this.workspacePath
          });
        }
        case 'knowledgeBaseSearch': return normalizeOk(await window.api.knowledgeSearch(args.query), 'items');
        case 'knowledgeBaseAdd': return normalizeOk(await window.api.knowledgeAdd({ title: args.title, content: args.content }), 'item');
        case 'knowledgeBaseDelete': return normalizeOk(await window.api.knowledgeDelete(args.id));
        case 'knowledgeBaseUpdate': return normalizeOk(await window.api.knowledgeUpdate(args.id, { title: args.title, content: args.content }), 'item');
        case 'memorySearch': return normalizeOk(await window.api.memorySearch(args.query), 'items');
        case 'memoryAdd': return normalizeOk(await window.api.memoryAdd({ content: args.content, tags: args.tags || [] }), 'item');
        case 'memoryDelete': return normalizeOk(await window.api.memoryDelete(args.id));
        case 'memoryUpdate': return normalizeOk(await window.api.memoryUpdate(args.id, { content: args.content, tags: args.tags }), 'item');
        case 'automationList': return await window.api.automationList();
        case 'automationGetGuide': return normalizeOk(await window.api.automationGetGuide(args.topic || 'all'), 'guide');
        case 'automationCreate': return await window.api.automationSave({
          id: args.id || undefined,
          name: args.name,
          enabled: args.enabled !== false,
          trigger: args.trigger || { type: 'schedule', config: {} },
          dsl: args.dsl || ''
        });
        case 'automationToggle': return await window.api.automationSetEnabled(args.id, !!args.enabled);
        case 'automationRun': return await window.api.automationRun(args.id, args.params || {});
        case 'automationTest': {
          let task;
          if (args.id) {
            const listRes = await window.api.automationList();
            task = (listRes && listRes.tasks || []).find(t => t.id === args.id);
            if (!task) return { ok: false, error: '任务不存在' };
            if (typeof args.dsl === 'string') task = { ...task, dsl: args.dsl };
          } else {
            task = { name: 'test', enabled: false, trigger: { type: 'schedule', config: {} }, dsl: args.dsl || '' };
          }
          return await window.api.automationTest(task, args.params || {});
        }
        case 'automationDelete': return await window.api.automationDelete(args.id);
        case 'localSearch': return await window.api.localSearch(this._resolveWorkspacePath(args.directory), args.pattern, args.options || {});
        case 'searchInFiles': {
          // 路径数组归一化：支持单字符串或数组
          let paths = args.paths;
          if (!paths) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('param_required', 'paths 参数必填', { param: 'paths' }) : 'paths 参数必填' };
          }
          if (typeof paths === 'string') paths = [paths];
          if (!Array.isArray(paths) || paths.length === 0) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('param_required', 'paths 参数必须是非空数组', { param: 'paths' }) : 'paths 参数必须是非空数组' };
          }
          // 工作目录相对路径 → 绝对路径（统一使用 _resolveWorkspacePath，感知 Code 模式）
          paths = paths.map(p => this._resolveWorkspacePath(p));
          const opts = args.options || {};
          // 顶层参数也可直接传入（向后兼容：args.isRegex / args.include 等）
          const mergedOpts = {
            isRegex: args.isRegex ?? opts.isRegex,
            ignoreCase: args.ignoreCase ?? opts.ignoreCase,
            include: args.include ?? opts.include,
            exclude: args.exclude ?? opts.exclude,
            encoding: args.encoding ?? opts.encoding,
            maxResults: args.maxResults ?? opts.maxResults,
            contextLines: args.contextLines ?? opts.contextLines,
            multiline: args.multiline ?? opts.multiline
          };
          const res = await window.api.searchInFiles(paths, args.pattern, mergedOpts);
          if (res && res.ok) {
            // 提供格式化摘要，便于 LLM 快速理解结果规模
            res.summary = `共找到 ${res.totalMatches} 处匹配，分布在 ${res.filesWithMatches} 个文件中（扫描了 ${res.filesScanned} 个文件）${res.truncated ? '，结果已截断' : ''}`;
          }
          return res;
        }
        case 'readFile': {
          // 统一路径解析：相对路径基于工作区，绝对路径原样使用
          const pathStr = this._resolveWorkspacePath(args.path || '');
          const ext = pathStr.split('.').pop().toLowerCase();
          const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
          if (officeFormats.includes(ext)) {
            const imported = await window.api.knowledgeImportFile(pathStr, this.workspacePath);
            if (!imported.ok) return imported;
            let convertedPath = null;
            if (this.workspacePath && imported.content) {
              const fileName = pathStr.split(/[\\/]/).pop().replace(/\.\w+$/, '.txt');
              convertedPath = `${this.workspacePath}\\${fileName}`;
              await window.api.writeFile(convertedPath, imported.content);
            }
            // 为 Office 转换后的文本也添加行号
            const contentWithLines = this._addLineNumbers(imported.content || '');
            return { ok: true, content: contentWithLines, images: imported.images, convertedPath };
          }
          const result = await window.api.readFile(pathStr, args.encoding || '');
          if (result.ok && result.content) {
            result.content = this._addLineNumbers(result.content);
          }
          return result;
        }
        case 'editFile': {
          // 统一路径解析：相对路径基于工作区，绝对路径原样使用
          const fp = this._resolveWorkspacePath(args.path || '');
          // 全量覆写模式（向后兼容）
          if (args.content !== undefined && args.old_string === undefined) {
            const r = await window.api.writeFile(fp, args.content, {
              encoding: args.encoding || '',
              eol: args.eol || ''
            });
            if (r.ok) r.message = `文件已全量覆写${r.encoding ? `（编码 ${r.encoding}，换行 ${(r.eol || 'lf').toUpperCase()}）` : ''}`;
            return r;
          }
          // 字符串替换模式
          if (args.old_string !== undefined && args.new_string !== undefined) {
            return await this._applyStringReplace(fp, args.old_string, args.new_string, args.replace_all || false, args.encoding, args.eol);
          }
          return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('need_content_or_replace', '需要提供 content（全量覆写）或 old_string+new_string（字符串替换）') : '需要提供 content（全量覆写）或 old_string+new_string（字符串替换）' };
        }
        case 'multiEditFile': {
          if (!Array.isArray(args.edits) || args.edits.length === 0) {
            return { ok: false, error: 'edits 必须是非空数组' };
          }
          // 统一路径解析：相对路径基于工作区，绝对路径原样使用
          const fp = this._resolveWorkspacePath(args.path || '');
          // 读取当前文件内容
          const readRes = await window.api.readFile(fp, args.encoding || '');
          if (!readRes.ok) return readRes;
          let content = readRes.content;
          const appliedEdits = [];
          // 依次应用每个编辑
          for (let i = 0; i < args.edits.length; i++) {
            const edit = args.edits[i];
            if (edit.old_string === undefined || edit.new_string === undefined) {
              return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('edit_missing_params', `第 ${i + 1} 个编辑缺少 old_string 或 new_string`, { index: i + 1 }) : `第 ${i + 1} 个编辑缺少 old_string 或 new_string` };
            }
            const count = edit.replace_all
              ? content.split(edit.old_string).length - 1
              : content.includes(edit.old_string) ? 1 : 0;
            if (count === 0) {
              return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('edit_not_found', `第 ${i + 1} 个编辑的 old_string 未在文件中找到`, { index: i + 1 }) : `第 ${i + 1} 个编辑的 old_string 未在文件中找到` };
            }
            if (!edit.replace_all && count > 1) {
              return { ok: false, error: `第 ${i + 1} 个编辑的 old_string 在文件中出现 ${count} 次，请提供更长的上下文或设置 replace_all` };
            }
            if (edit.replace_all) {
              content = content.split(edit.old_string).join(edit.new_string);
            } else {
              content = content.replace(edit.old_string, edit.new_string);
            }
            appliedEdits.push({ index: i + 1, replacements: edit.replace_all ? count : 1 });
          }
          const writeRes = await window.api.writeFile(fp, content, {
            encoding: args.encoding || '',
            eol: args.eol || ''
          });
          if (!writeRes.ok) return writeRes;
          return { ok: true, message: `已应用 ${appliedEdits.length} 处编辑${writeRes.encoding ? `（编码 ${writeRes.encoding}，换行 ${(writeRes.eol || 'lf').toUpperCase()}）` : ''}`, edits: appliedEdits };
        }
        case 'presentFile': {
          // 解析工作目录相对路径：绝对路径原样使用，相对路径基于工作区拼接
          const relPath = args.path || '';
          const fullPath = this._resolveWorkspacePath(relPath);
          // 读取文件验证存在性
          const readRes = await window.api.readFile(fullPath);
          if (!readRes.ok) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('file_not_exists', `文件不存在: ${relPath}`, { path: relPath }) : `文件不存在: ${relPath}` };
          }
          const filename = relPath.split(/[\\/]/).pop();
          const fileSize = readRes.content ? readRes.content.length : 0;
          // 通知 UI 创建呈递卡片（不阻塞 Agent 循环）
          if (this.onMessage) {
            this.onMessage('present-file', {
              path: relPath,
              fullPath: fullPath,
              filename: filename,
              title: args.title || filename,
              description: args.description || '',
              size: fileSize
            });
          }
          return { ok: true, message: `文件 ${filename} 已呈递给用户` };
        }
        case 'readImageFile': {
          // 多模态图片读取：读取图片为 base64 data URL，以多模态格式注入上下文
          const imgRelPath = args.path || '';
          if (!imgRelPath) return { ok: false, error: '缺少 path 参数' };
          // 统一路径解析：绝对路径（C:\...）原样使用，相对路径基于工作区拼接
          const imgFullPath = this._resolveWorkspacePath(imgRelPath);
          // 非多模态模型：不支持图片注入，返回提示
          if (!this.isVisionModel()) {
            return { ok: false, error: '当前模型不支持多模态视觉输入，无法读取图片。可在「设置 → LLM 配置」中开启「多模态视觉输入」开关强制启用，或使用 OCR 工具（extractTextFromImage）。' };
          }
          const readRes = await window.api.readFileBase64(imgFullPath);
          if (!readRes || !readRes.ok || !readRes.data) {
            return { ok: false, error: readRes?.error || '读取图片文件失败（文件不存在或不是图片）' };
          }
          // 标记为多模态结果，由 agent loop 特殊处理（注入为 image_url content array）
          const imgDesc = args.description ? `：${args.description}` : '';
          return { ok: true, _multimodal: true, imageUrl: readRes.data, text: `已读取图片文件 ${imgRelPath}${imgDesc}（图片已注入上下文，可直接查看）` };
        }
        case 'createFile': {
          const createRes = await window.api.createFile(this._resolveWorkspacePath(args.path), args.content || '', {
            encoding: args.encoding || '',
            eol: args.eol || ''
          });
          if (createRes.ok && (createRes.encoding || createRes.eol)) {
            createRes.message = `文件已创建${createRes.encoding ? `（编码 ${createRes.encoding}，换行 ${(createRes.eol || 'lf').toUpperCase()}）` : ''}`;
          }
          return createRes;
        }
        case 'getFileEncodingInfo': {
          const fp = this._resolveWorkspacePath(args.path || '');
          const info = await window.api.getFileEncodingInfo(fp);
          if (info && info.ok) {
            info.message = `编码 ${info.encoding}，换行模式 ${(info.eol || 'lf').toUpperCase()}，大小 ${info.size} 字节`;
          }
          return info;
        }
        case 'convertFileEncoding': {
          const fp = this._resolveWorkspacePath(args.path || '');
          const conv = await window.api.convertFileEncoding(fp, {
            encoding: args.encoding || '',
            eol: args.eol || ''
          });
          if (conv && conv.ok) {
            conv.message = `已从 ${conv.from.encoding}/${(conv.from.eol || 'lf').toUpperCase()} 转换为 ${conv.to.encoding}/${(conv.to.eol || 'lf').toUpperCase()}`;
          }
          return conv;
        }
        case 'deleteFile': return await window.api.deleteFile(this._resolveWorkspacePath(args.path));
        case 'moveFile': return await window.api.moveFile(this._resolveWorkspacePath(args.source), this._resolveWorkspacePath(args.destination));
        case 'copyFile': return await window.api.copyFile(this._resolveWorkspacePath(args.source), this._resolveWorkspacePath(args.destination));
        case 'listDirectory': return await window.api.listDirectory(this._resolveWorkspacePath(args.path));
        case 'makeDirectory': return await window.api.makeDirectory(this._resolveWorkspacePath(args.path));
        case 'deleteDirectory': return await window.api.deleteDirectory(this._resolveWorkspacePath(args.path));
        case 'runJavaScriptCode': return await window.api.runJS(args.code, this._scriptCwd(), this._sandboxMode());
        case 'runNodeJavaScriptCode': {
          return await this._execWithSandboxEscalation('runNodeJavaScriptCode', (mode) =>
            window.api.runNodeJS(args.code, this._scriptCwd(), mode));
        }
        case 'runShellScriptCode': {
          return await this._execWithSandboxEscalation('runShellScriptCode', (mode) =>
            window.api.runShell(args.script, this._scriptCwd(), mode));
        }
        case 'makeTerminal': {
          // 传入工作目录：Chat 模式用 workspacePath，Code 模式用 codeWorkspacePath
          const cwd = this.mode === 'code' ? (this.codeWorkspacePath || this.workspacePath) : this.workspacePath;
          const result = await this._execWithSandboxEscalation('makeTerminal', (mode) =>
            window.api.makeTerminal(cwd, this.sessionKey, mode), { terminalOnly: true });
          if (result.ok) this.terminals.set(result.terminalId, true);
          return result;
        }
        case 'runTerminalCommand': return await window.api.runTerminalCommand(args.terminalId, args.command);
        case 'awaitTerminalCommand': return await window.api.awaitTerminalCommand(args.terminalId, args.command, args.timeoutMs);
        case 'killTerminal': {
          this.terminals.delete(args.terminalId);
          return await window.api.killTerminal(args.terminalId);
        }
        case 'terminalReadOutput': return await window.api.readTerminalOutput(args.terminalId, args.lastLines || 0);
        case 'terminalSendInput': return await window.api.sendTerminalText(args.terminalId, args.text);
        case 'terminalPressKey': return await window.api.pressTerminalKey(args.terminalId, args.key);
        case 'terminalAnswerPrompt': {
          // 回答交互式提问：先发送答案文本，再发送回车
          const sendRes = await window.api.sendTerminalText(args.terminalId, args.answer);
          if (!sendRes.ok) return sendRes;
          const enterRes = await window.api.pressTerminalKey(args.terminalId, 'Enter');
          if (!enterRes.ok) return enterRes;
          // 短暂等待程序处理输入后返回当前输出
          await new Promise(r => setTimeout(r, 500));
          return await window.api.readTerminalOutput(args.terminalId, 20);
        }
        case 'terminalListSessions': return await window.api.listTerminals();
        case 'readClipboard': {
          const result = await window.api.readClipboard();
          return result.ok ? result : { ok: true, content: result };
        }
        case 'writeClipboard': {
          const result = await window.api.writeClipboard(args.text);
          return result.ok !== undefined ? result : { ok: true };
        }
        case 'takeScreenshot': return await window.api.takeScreenshot(this.workspacePath);
        case 'extractTextFromImage': {
          const ocrResult = await window.api.ocrRecognize(this._resolveWorkspacePath(args.imagePath || args.path));
          return ocrResult;
        }
        case 'scanQRCode': {
          return await window.api.qrScan(this._resolveWorkspacePath(args.imagePath || args.path));
        }
        case 'generateQRCode': {
          return await window.api.qrGenerate(args.text, this.workspacePath, args.filename);
        }
        case 'getSystemInfo': return await window.api.getSystemInfo();
        case 'getNetworkStatus': return await window.api.getNetworkStatus();
        case 'openBrowser': {
          const result = await window.api.openBrowser(args.url);
          return result.ok !== undefined ? result : { ok: true };
        }
        case 'openFileExplorer': {
          const result = await window.api.openFileExplorer(this._resolveWorkspacePath(args.path));
          return result.ok !== undefined ? result : { ok: true };
        }
        case 'eslintLint': {
          // 对工作区执行 ESLint 诊断。Code 模式专用工具，但 Chat 模式也允许调用（需提供 workspacePath）
          const ws = this.codeWorkspacePath || this.workspacePath;
          if (!ws) return { ok: false, error: '当前未打开工作区，无法执行 ESLint' };
          const opts = {};
          if (Array.isArray(args.files) && args.files.length > 0) opts.files = args.files;
          if (typeof args.maxFiles === 'number' && args.maxFiles > 0) opts.maxFiles = args.maxFiles;
          return await window.api.eslintLint(ws, opts);
        }
        case 'eslintLintFile': {
          if (!args.path) return { ok: false, error: '参数 path 必填' };
          // 统一路径解析：Code 模式自动用 codeWorkspacePath
          const fp = this._resolveWorkspacePath(args.path);
          return await window.api.eslintLintFile(fp);
        }
        // ---- FFmpeg 媒体工具集 ----
        case 'ffmpegInfo': case 'ffmpegTranscode': case 'ffmpegCompress': case 'ffmpegTrim':
        case 'ffmpegCrop': case 'ffmpegResize': case 'ffmpegRotate': case 'ffmpegExtractAudio':
        case 'ffmpegRemoveAudio': case 'ffmpegExtractFrame': case 'ffmpegExtractFrames': case 'ffmpegToGif':
        case 'ffmpegConcat': case 'ffmpegMux': case 'ffmpegVolume': case 'ffmpegSpeed':
        case 'ffmpegWatermark': case 'ffmpegAddSubtitle': case 'ffmpegSlideshow': case 'ffmpegAudioMerge':
        case 'ffmpegRunCommand': {
          const OP_MAP = {
            ffmpegInfo: 'info', ffmpegTranscode: 'transcode', ffmpegCompress: 'compress', ffmpegTrim: 'trim',
            ffmpegCrop: 'crop', ffmpegResize: 'resize', ffmpegRotate: 'rotate', ffmpegExtractAudio: 'extractAudio',
            ffmpegRemoveAudio: 'removeAudio', ffmpegExtractFrame: 'extractFrame', ffmpegExtractFrames: 'extractFrames',
            ffmpegToGif: 'toGif', ffmpegConcat: 'concat', ffmpegMux: 'mux', ffmpegVolume: 'volume',
            ffmpegSpeed: 'speed', ffmpegWatermark: 'watermark', ffmpegAddSubtitle: 'addSubtitle',
            ffmpegSlideshow: 'slideshow', ffmpegAudioMerge: 'audioMerge', ffmpegRunCommand: 'runCommand'
          };
          return await window.api.ffmpegInvoke(OP_MAP[name], this._resolveFfmpegArgs(args), this._scriptCwd(), this._sandboxMode());
        }
        case 'manageContext': return this.contextManager.manage(args.action, args);
        case 'autoSummarizeContext': {
          // Use the new LLM summary path; falls back to mechanical on failure.
          const sumRes = await this.contextManager.summarizeWithLLM({
            keepLast: args.keepLast || 6, // 向后兼容参数，新引擎按 token 预算忽略
            sessionKey: this.sessionKey || null,
            tools: this.getRuntimeToolSchemas()
          });
          if (sumRes.skipped) return { ok: true, message: sumRes.message, skipped: true };
          if (!sumRes.ok) return { ok: false, error: sumRes.message, fallback: sumRes.fallback };
          return { ok: true, summary: sumRes.summary, message: sumRes.message };
        }
        case 'listSkills': {
          await this.refreshSkillsCatalog();
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          return normalizeOk(this.skillsCatalog, 'skills');
        }
        case 'makeSkill': {
          const payload = { name: args.name, description: args.description, prompt: args.prompt };
          if (args.license !== undefined) payload.license = args.license;
          if (args.compatibility !== undefined) payload.compatibility = args.compatibility;
          if (args.allowedTools !== undefined) {
            payload.allowedTools = Array.isArray(args.allowedTools)
              ? args.allowedTools
              : String(args.allowedTools || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
          }
          if (args.metadata !== undefined) payload.metadata = args.metadata && typeof args.metadata === 'object' ? args.metadata : {};
          if (args.runtime !== undefined) payload.runtime = args.runtime;
          if (Array.isArray(args.scripts)) payload.scripts = args.scripts;
          const res = await window.api.createSkill(payload);
          await this.refreshSkillsCatalog();
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          return normalizeOk(res, 'skill');
        }
        case 'updateSkill': {
          const payload = { name: args.name, description: args.description, prompt: args.prompt };
          if (args.license !== undefined) payload.license = args.license;
          if (args.compatibility !== undefined) payload.compatibility = args.compatibility;
          if (args.allowedTools !== undefined) {
            payload.allowedTools = Array.isArray(args.allowedTools)
              ? args.allowedTools
              : String(args.allowedTools || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
          }
          if (args.metadata !== undefined) payload.metadata = args.metadata && typeof args.metadata === 'object' ? args.metadata : {};
          if (args.runtime !== undefined) payload.runtime = args.runtime;
          if (Array.isArray(args.scripts)) payload.scripts = args.scripts;
          const res = await window.api.updateSkill(args.id, payload);
          await this.refreshSkillsCatalog();
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          return normalizeOk(res, 'skill');
        }
        case 'runSkillScript': {
          await this.refreshSkillsCatalog();
          const skillId = String(args.skillId || '').trim();
          const scriptName = String(args.scriptName || '').trim();
          const skill = this.skillsCatalog.find(s => String(s?.id) === skillId);
          if (!skill) return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('skill_not_exists', '技能不存在，请先调用listSkills确认skillId') : '技能不存在，请先调用listSkills确认skillId' };
          const scriptList = Array.isArray(skill?.scripts) ? skill.scripts : [];
          const scriptItem = scriptList.find(item => {
            const nameText = String(item?.name || item || '');
            return nameText === scriptName;
          });
          if (!scriptItem) {
            return { ok: false, error: `技能 ${skill.name} 中不存在脚本 ${scriptName}` };
          }
          const scriptPath = String(scriptItem?.path || '').trim();
          let code = String(scriptItem?.code || '');
          if (!code && scriptPath) {
            const readRes = await window.api.readFile(scriptPath);
            if (!readRes?.ok) return readRes;
            code = readRes.content || '';
          }
          const nameForType = String(scriptItem?.name || scriptPath || '');
          const ext = (nameForType.split('.').pop() || '').toLowerCase();
          const declaredRuntime = String(scriptItem?.runtime || '').toLowerCase();
          let runRes;
          if (ext === 'py' || ext === 'pyw' || declaredRuntime === 'python') {
            if (typeof window.api.runPython !== 'function') {
              return { ok: false, error: '当前版本不支持 Python 脚本，请升级应用' };
            }
            runRes = await this._execWithSandboxEscalation('runPython', (mode) =>
              window.api.runPython(code, this._scriptCwd(), mode));
          } else if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'ps1' || ext === 'bat' || ext === 'cmd' || declaredRuntime === 'shell') {
            runRes = await this._execWithSandboxEscalation('runShellScriptCode', (mode) =>
              window.api.runShell(code, this._scriptCwd(), mode));
          } else if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || declaredRuntime === 'javascript' || declaredRuntime === 'node') {
            const needsNode = declaredRuntime === 'node'
              || ext === 'mjs'
              || ext === 'cjs'
              || (!declaredRuntime && /\brequire\s*\(|\bprocess\.\b|\bfs\.\b|\bpath\.\b|\bBuffer\b|__dirname|__filename|\bimport\s+/.test(code));
            runRes = needsNode
              ? await this._execWithSandboxEscalation('runNodeJavaScriptCode', (mode) => window.api.runNodeJS(code, this._scriptCwd(), mode))
              : await window.api.runJS(code, this._scriptCwd(), this._sandboxMode());
          } else {
            return { ok: false, error: '仅支持运行 .js、.py、.sh、.ps1、.bat 等 Skill 脚本' };
          }
          return normalizeOk(runRes);
        }
        case 'activateSkill': {
          // Inject a skill's prompt into the system context.
          await this.refreshSkillsCatalog();
          const skillId = String(args.skillId || '').trim();
          const skill = this.skillsCatalog.find(s => String(s?.id) === skillId || String(s?.name) === skillId);
          if (!skill) return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('skill_not_exists', '技能不存在') : '技能不存在' };
          if (!skill.prompt) return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('skill_no_prompt', '该技能没有 prompt 内容') : '该技能没有 prompt 内容' };
          if (!Array.isArray(this.activeSkills)) this.activeSkills = [];
          // Avoid duplicate activation
          if (!this.activeSkills.find(s => s.id === skill.id)) {
            this.activeSkills.push({ id: skill.id, name: skill.name, prompt: skill.prompt });
          }
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          return { ok: true, message: `技能 ${skill.name} 已激活，prompt 已注入系统上下文` };
        }
        case 'deactivateSkill': {
          const skillId = String(args.skillId || '').trim();
          if (Array.isArray(this.activeSkills)) {
            this.activeSkills = this.activeSkills.filter(s => s.id !== skillId && s.name !== skillId);
            this.contextManager.setSystemPrompt(this.getSystemPrompt());
            return { ok: true, message: '技能已停用' };
          }
          return { ok: true, message: '无激活技能' };
        }
        case 'initGeogebra': {
          return await window.api.geogebraInit({
            appName: args.appName || 'classic',
            perspective: args.perspective,
            enableCAS: args.enableCAS,
            enable3D: args.enable3D,
          });
        }
        case 'runGeogebraCommand': {
          return await window.api.geogebraEvalCommand(args.command);
        }
        case 'geogebraEvalCAS': {
          return await window.api.geogebraEvalCAS(args.command);
        }
        case 'geogebraGetObject': {
          return await window.api.geogebraGetObject(args.name);
        }
        case 'geogebraGetXML': {
          return await window.api.geogebraGetXML();
        }
        case 'geogebraSetXML': {
          return await window.api.geogebraSetXML(args.xml);
        }
        case 'geogebraSetStyle': {
          return await window.api.geogebraSetStyle(args.name, args.style);
        }
        case 'geogebraGetError': {
          return await window.api.geogebraGetError();
        }
        case 'geogebraScreenshot': {
          return await window.api.geogebraGetPNGBase64();
        }
        case 'geogebraSave': {
          return await window.api.geogebraSave(this.workspacePath, args.fileName);
        }
        case 'geogebraLoad': {
          return await window.api.geogebraLoad(args.filePath);
        }
        case 'geogebraGuide': {
          return await window.api.geogebraGuide(args.category);
        }
        case 'getFunctionsFromGeogebra':
        case 'getCurrentGraphDataFromGeogebra': {
          return await window.api.geogebraGetAllObjects();
        }
        case 'deleteFunctionFromGeogebra': {
          return await window.api.geogebraDeleteObject(args.label || args.name);
        }
        case 'getCurrentGraphFromGeogebra': {
          return await window.api.geogebraExportPNG(this.workspacePath);
        }
        case 'addFunctionToGeogebra': {
          return await window.api.geogebraEvalCommand(args.expression);
        }
        case 'updateFunctionInGeogebra': {
          // 优先按 name 重定义；若 AI 提供了 expression 直接使用（GGB 会按 label 重定义）
          const expr = args.expression || args.command;
          // 如果表达式形如 "f(x)=..." 且 name 为 "f"，直接 eval 即可
          if (expr) {
            return await window.api.geogebraEvalCommand(expr);
          }
          // 兜底：若只提供了 name，先读取旧值再重写（少见路径）
          return { ok: false, error: 'updateFunctionInGeogebra 需要 expression 参数' };
        }
        case 'initCanvas': {
          return window.initCanvas ? window.initCanvas() : { ok: false, error: '画布功能未初始化' };
        }
        case 'clearCanvas': {
          return window.clearCanvas ? window.clearCanvas() : { ok: false, error: '画布功能未初始化' };
        }
        case 'addCanvasObject': {
          return window.addCanvasObject ? window.addCanvasObject(args.type, args.id, args.attributes) : { ok: false, error: '画布功能未初始化' };
        }
        case 'updateCanvasObject': {
          return window.updateCanvasObject ? window.updateCanvasObject(args.id, args.attributes) : { ok: false, error: '画布功能未初始化' };
        }
        case 'deleteCanvasObject': {
          return window.deleteCanvasObject ? window.deleteCanvasObject(args.id) : { ok: false, error: '画布功能未初始化' };
        }
        case 'exportCanvasSVG': {
          if (!this.workspacePath) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('no_workspace', '未设置工作区路径') : '未设置工作区路径' };
          }
          return window.exportCanvasSVG ? window.exportCanvasSVG(args.filename || 'canvas.svg', this.workspacePath) : { ok: false, error: '画布功能未初始化' };
        }
        // ---- CIPYP-CAD ----
        case 'initCipypCad': {
          return await window.api.openCipypCad();
        }
        case 'runCipypCadCommand': {
          return await window.api.cadRunCommand(args.command || '');
        }
        case 'runCipypCadCommands': {
          return await window.api.cadRunCommands(Array.isArray(args.commands) ? args.commands : []);
        }
        case 'getCipypCadState': {
          return await window.api.cadGetState();
        }
        case 'getCadObjectList': {
          return await window.api.cadGetObjectList();
        }
        case 'saveCipypCadProject': {
          // renderer 中不可用 require('path')，用字符串拼接
          const sep = (this.workspacePath && this.workspacePath.includes('\\')) ? '\\' : '/';
          const targetPath = args.path || (this.workspacePath ? this.workspacePath.replace(/[\\/]+$/, '') + sep + (args.filename || 'project.cipyproj') : null);
          if (!targetPath) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('no_workspace', '未设置工作区路径，且未提供 path 参数') : '未设置工作区路径，且未提供 path 参数' };
          }
          const res = await window.api.cadSaveProject(targetPath);
          if (res.ok && this.onMessage) {
            this.onMessage('assistant', `📐 CIPYP-CAD 工程已保存到：\n\`${targetPath}\``);
          }
          return res;
        }
        case 'loadCipypCadProject': {
          if (!args.path) {
            return { ok: false, error: '需要 path 参数指定工程文件路径' };
          }
          return await window.api.cadLoadProject(this._resolveWorkspacePath(args.path));
        }
        case 'exportCipypCadDxf': {
          const sep = (this.workspacePath && this.workspacePath.includes('\\')) ? '\\' : '/';
          const dxfPath = args.path || (this.workspacePath ? this.workspacePath.replace(/[\\/]+$/, '') + sep + (args.filename || 'export.dxf') : null);
          if (!dxfPath) {
            return { ok: false, error: '未设置工作区路径，且未提供 path 参数' };
          }
          const res = await window.api.cadExportDxf(dxfPath);
          if (res.ok && this.onMessage) {
            this.onMessage('assistant', `📐 DXF (R2000 AC1015) 已导出到：\n\`${dxfPath}\`\n（可用 AutoCAD/FreeCAD/QCAD/LibreCAD 等打开）`);
          }
          return res;
        }
        case 'importCipypCadDxf': {
          // 弹出系统文件选择对话框导入外部 DXF 文件
          const res = await window.api.cadImportDxfDialog();
          if (!res) {
            return { ok: false, error: '导入 DXF 失败：未收到响应' };
          }
          if (res.ok && this.onMessage && res.imported != null) {
            const newLayers = (res.layers || []).join(', ') || '(无)';
            this.onMessage('assistant', `📐 DXF 导入完成：${res.imported} 个对象，新建图层：${newLayers}`);
          }
          return res;
        }
        case 'getCipypCadHatchPatterns': {
          // 列出所有内置填充图案（供 LLM 在调用 hatch --pattern 前查询可用图案名）
          return await window.api.cadGetHatchPatterns();
        }
        case 'exportCipypCadImage': {
          const fmt = (args.format || 'png').toLowerCase();
          const sep = (this.workspacePath && this.workspacePath.includes('\\')) ? '\\' : '/';
          const imgPath = args.path || (this.workspacePath ? this.workspacePath.replace(/[\\/]+$/, '') + sep + (args.filename || (`export.${fmt}`)) : null);
          if (!imgPath) {
            return { ok: false, error: '未设置工作区路径，且未提供 path 参数' };
          }
          const res = await window.api.cadExportImage(imgPath, fmt);
          if (res.ok && this.onMessage) {
            this.onMessage('assistant', `📐 ${fmt.toUpperCase()} 已导出到：\n\`${imgPath}\``);
          }
          return res;
        }
        case 'closeCipypCad': {
          return await window.api.cadAgentClose();
        }
        // ---- CIBYP-PCB-EDA ----
        case 'initPcbEda': {
          return await window.api.openPcbEda();
        }
        case 'closePcbEda': {
          return await window.api.pcbAgentClose();
        }
        case 'runPcbEdaCommand': {
          return await window.api.pcbRunCommand(args.command || '');
        }
        case 'runPcbEdaCommands': {
          return await window.api.pcbRunCommands(Array.isArray(args.commands) ? args.commands : []);
        }
        case 'pcbNewProject': {
          const cmds = ['new ' + (args.name || 'Untitled') + ' ' + (args.width || 100) + ' ' + (args.height || 80) + ' ' + (args.layers || 2)];
          return await window.api.pcbRunCommands(cmds);
        }
        case 'pcbSetDesignRules': {
          const keys = ['minClearance', 'minTraceWidth', 'minViaDrill', 'minViaDiameter', 'minAnnularRing',
            'minHoleToHole', 'copperToBoardEdge', 'solderMaskExpansion', 'pasteExpansion',
            'defaultTraceWidth', 'defaultViaDrill', 'defaultViaDiameter', 'zoneClearance', 'zoneThermalWidth'];
          const cmds = keys.filter(k => typeof args[k] === 'number').map(k => 'rules set ' + k + ' ' + args[k]);
          if (!cmds.length) return { ok: false, error: '未提供任何有效规则参数' };
          return await window.api.pcbRunCommands(cmds);
        }
        case 'pcbSetStackup': {
          const cmds = [];
          if (args.copperLayers) cmds.push('stackup layers ' + args.copperLayers);
          if (args.boardThickness) cmds.push('stackup thickness ' + args.boardThickness);
          if (!cmds.length) return { ok: false, error: '未提供 stackup 参数' };
          return await window.api.pcbRunCommands(cmds);
        }
        case 'pcbSetOutline': {
          if (!Array.isArray(args.points) || args.points.length < 3) return { ok: false, error: 'points 至少需要3个顶点 ("x,y")' };
          return await window.api.pcbRunCommand('board outline ' + args.points.join(' '));
        }
        case 'pcbSchAddSymbol': {
          let cmd = 'sch sym ' + args.lib + ' ' + (args.x || 0) + ' ' + (args.y || 0) + ' ' + (args.rot || 0);
          if (args.ref) cmd += ' --ref ' + args.ref;
          if (args.value) cmd += ' --value "' + args.value + '"';
          if (args.footprint) cmd += ' --fp ' + args.footprint;
          if (args.pins) cmd += ' --pins ' + args.pins;
          if (Array.isArray(args.left)) cmd += ' --left "' + args.left.join(',') + '"';
          if (Array.isArray(args.right)) cmd += ' --right "' + args.right.join(',') + '"';
          return await window.api.pcbRunCommand(cmd);
        }
        case 'pcbSchAddWire': {
          if (!Array.isArray(args.points) || args.points.length < 2) return { ok: false, error: 'points 至少需要2个点' };
          return await window.api.pcbRunCommand('sch wire ' + args.points.join(' '));
        }
        case 'pcbSchAddLabel': {
          return await window.api.pcbRunCommand('sch label "' + (args.text || 'NET') + '" ' + (args.x || 0) + ',' + (args.y || 0));
        }
        case 'pcbSchAddPower': {
          return await window.api.pcbRunCommand('sch power ' + (args.ptype || 'GND') + ' ' + (args.x || 0) + ',' + (args.y || 0));
        }
        case 'pcbSchAnnotate': {
          return await window.api.pcbRunCommand('sch annotate');
        }
        case 'pcbSchSync': {
          return await window.api.pcbRunCommand('sch sync');
        }
        case 'pcbRunERC': {
          return await window.api.pcbRunCommand('erc');
        }
        case 'pcbAddComponent': {
          let cmd = 'comp add ' + args.footprint + ' ' + args.ref + ' ' + (args.x || 0) + ' ' + (args.y || 0) +
            ' ' + (args.rot || 0) + ' ' + (args.side || 'F');
          if (args.params && typeof args.params === 'object') {
            for (const [k, v] of Object.entries(args.params)) cmd += ' ' + k + '=' + v;
          }
          const res = await window.api.pcbRunCommand(cmd);
          if (res.ok && args.value) await window.api.pcbRunCommand('comp value ' + args.ref + ' "' + args.value + '"');
          return res;
        }
        case 'pcbMoveComponent': {
          return await window.api.pcbRunCommand('comp move ' + args.ref + ' ' + args.x + ' ' + args.y);
        }
        case 'pcbRotateComponent': {
          return await window.api.pcbRunCommand('comp rot ' + args.ref + ' ' + args.rot);
        }
        case 'pcbDeleteComponent': {
          return await window.api.pcbRunCommand('comp del ' + args.ref);
        }
        case 'pcbListComponents': {
          return await window.api.pcbRunCommand('comp list');
        }
        case 'pcbSetPadNet': {
          return await window.api.pcbRunCommand('comp net ' + args.ref + ' ' + args.pad + ' ' + (args.net || ''));
        }
        case 'pcbRouteTrace': {
          if (!Array.isArray(args.points) || args.points.length < 2) return { ok: false, error: 'points 至少需要2个点' };
          const cmd = 'trace ' + (args.net || '') + ' ' + (args.layer || 'F.Cu') + ' ' + (args.width || 0) + ' ' + args.points.join(' ');
          return await window.api.pcbRunCommand(cmd);
        }
        case 'pcbAddVia': {
          const cmd = 'via ' + (args.net || '') + ' ' + args.x + ' ' + args.y +
            (args.drill ? ' ' + args.drill : '') + (args.diameter ? ' ' + args.diameter : '');
          return await window.api.pcbRunCommand(cmd);
        }
        case 'pcbAddCopperPour': {
          if (!Array.isArray(args.points) || args.points.length < 3) return { ok: false, error: 'points 至少需要3个顶点' };
          let cmd = 'zone ' + (args.net || '') + ' ' + (args.layer || 'F.Cu') + ' ' + args.points.join(' ');
          if (typeof args.clearance === 'number') cmd += ' --clearance ' + args.clearance;
          if (typeof args.thermalWidth === 'number') cmd += ' --thermal ' + args.thermalWidth;
          return await window.api.pcbRunCommand(cmd);
        }
        case 'pcbAddSilkscreen': {
          const side = args.side || 'F';
          let cmd = '';
          if (args.kind === 'line') cmd = 'silk line ' + args.x1 + ',' + args.y1 + ' ' + args.x2 + ',' + args.y2 + ' ' + side;
          else if (args.kind === 'rect') cmd = 'silk rect ' + args.x1 + ',' + args.y1 + ' ' + args.x2 + ',' + args.y2 + ' ' + side;
          else if (args.kind === 'circle') cmd = 'silk circle ' + args.x1 + ',' + args.y1 + ' ' + (args.r || 2) + ' ' + side;
          else if (args.kind === 'text') cmd = 'silk text "' + (args.text || 'TEXT') + '" ' + args.x1 + ',' + args.y1;
          else return { ok: false, error: '未知丝印类型: ' + args.kind };
          return await window.api.pcbRunCommand(cmd);
        }
        case 'pcbRunDRC': {
          return await window.api.pcbRunCommand('drc');
        }
        case 'pcbAutoroute': {
          const cmds = [];
          if (typeof args.traceWidth === 'number') cmds.push('rules set defaultTraceWidth ' + args.traceWidth);
          if (typeof args.clearance === 'number') cmds.push('rules set minClearance ' + args.clearance);
          cmds.push('autoroute' + (Array.isArray(args.nets) && args.nets.length ? ' ' + args.nets.join(',') : ''));
          const res = await window.api.pcbRunCommands(cmds);
          if (res && res.results) return res.results[res.results.length - 1];
          return res;
        }
        case 'pcbGetBoardInfo': {
          return await window.api.pcbGetState();
        }
        case 'pcbListLibrary': {
          return await window.api.pcbRunCommand(args.type === 'symbol' ? 'symbols' : 'footprints');
        }
        case 'pcbSaveProject': {
          const sep = (this.workspacePath && this.workspacePath.includes('\\')) ? '\\' : '/';
          const multi = !!args.multi;
          const defName = args.filename || ('project' + (multi ? '.cibypcbproj' : '.cipypcb'));
          const targetPath = args.path || (this.workspacePath ? this.workspacePath.replace(/[\\/]+$/, '') + sep + defName : null);
          if (!targetPath) return { ok: false, error: '未设置工作区路径，且未提供 path 参数' };
          const res = await window.api.pcbSaveProject(targetPath, multi);
          if (res.ok && this.onMessage) {
            this.onMessage('assistant', `🔌 PCB 工程已保存到：\n\`${targetPath}\``);
          }
          return res;
        }
        case 'pcbLoadProject': {
          if (!args.path) return { ok: false, error: '需要 path 参数指定工程文件路径' };
          return await window.api.pcbLoadProject(this._resolveWorkspacePath(args.path));
        }
        case 'pcbImportFile': {
          if (!args.path) return { ok: false, error: '需要 path 参数指定导入文件路径' };
          return await window.api.pcbImportFile(this._resolveWorkspacePath(args.path));
        }
        case 'pcbExportGerber': {
          const sep = (this.workspacePath && this.workspacePath.includes('\\')) ? '\\' : '/';
          const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
          const dir = args.dir || (this.workspacePath ? this.workspacePath.replace(/[\\/]+$/, '') + sep + 'gerber_' + ts : null);
          if (!dir) return { ok: false, error: '未设置工作区路径，且未提供 dir 参数' };
          const zip = args.zip !== false;
          const res = await window.api.pcbExportGerber(dir, 'pcb',
            { naming: args.naming || 'jlc', tentedVias: !!args.tentedVias },
            zip ? 'pcb-gerber.zip' : null);
          if (res.ok && this.onMessage) {
            this.onMessage('assistant', `🔌 Gerber 生产文件已导出（${res.count} 个文件）：\n\`${res.zipPath || dir}\``);
          }
          return res;
        }
        case 'pcbExportFile': {
          const sep = (this.workspacePath && this.workspacePath.includes('\\')) ? '\\' : '/';
          const extMap = { 'kicad': '.kicad_pcb', 'netlist-kicad': '.net', 'netlist-csv': '.csv', 'svg-pcb': '.svg', 'svg-sch': '.svg', 'png-pcb': '.png', 'png-3d': '.png', 'obj': '.obj', 'pnp': '.csv', 'bom': '.csv' };
          const ext = extMap[args.kind] || '.txt';
          const targetPath = args.path || (this.workspacePath ? this.workspacePath.replace(/[\\/]+$/, '') + sep + (args.filename || ('pcb-' + args.kind + ext)) : null);
          if (!targetPath) return { ok: false, error: '未设置工作区路径，且未提供 path 参数' };
          const res = await window.api.pcbExportTextFile(args.kind, targetPath, 'pcb');
          if (res.ok && this.onMessage) {
            this.onMessage('assistant', `🔌 ${args.kind} 已导出到：\n\`${targetPath}\``);
          }
          return res;
        }
        // ---- 双面板设计工具集 ----
        case 'pcbSetView': {
          return await window.api.pcbRunCommand('view ' + (args.side || 'toggle'));
        }
        case 'pcbGetView': {
          // 直接通过 runPcbEdaCommand 查询
          return await window.api.pcbRunCommand('state');
        }
        case 'pcbFlipComponent': {
          if (!args.ref) return { ok: false, error: '需要 ref 参数（元件位号）' };
          return await window.api.pcbRunCommand('comp flip ' + args.ref);
        }
        case 'pcbSetComponentSide': {
          if (!args.ref) return { ok: false, error: '需要 ref 参数' };
          if (!['F', 'B'].includes(args.side)) return { ok: false, error: 'side 必须是 F 或 B' };
          return await window.api.pcbRunCommand('comp side ' + args.ref + ' ' + args.side);
        }
        case 'pcbRouteSingle': {
          // 构造 autoroute single <net> <fromPt> <toPt> [options]
          if (!args.net || !args.fromPt || !args.toPt) return { ok: false, error: '需要 net, fromPt, toPt 参数' };
          let cmd = 'autoroute single ' + args.net + ' ' + args.fromPt + ' ' + args.toPt;
          if (Array.isArray(args.preferLayers) && args.preferLayers.length) cmd += ' --preferLayers ' + args.preferLayers.join(',');
          if (args.allowDiagonal === false) cmd += ' --no-diagonal';
          if (typeof args.width === 'number') cmd += ' --width ' + args.width;
          if (typeof args.clearance === 'number') cmd += ' --clearance ' + args.clearance;
          if (typeof args.grid === 'number') cmd += ' --grid ' + args.grid;
          return await window.api.pcbRunCommand(cmd);
        }
        case 'pcbClearRoutes': {
          return await window.api.pcbRunCommand(args.net ? ('clear routes ' + args.net) : 'clear routes');
        }
        case 'pcbSetLayerVisibility': {
          if (!args.layer) return { ok: false, error: '需要 layer 参数' };
          return await window.api.pcbRunCommand('layer vis ' + args.layer + ' ' + (args.visible ? 'on' : 'off'));
        }
        case 'pcbGetLayerVisibility': {
          return await window.api.pcbRunCommand('layer list');
        }
        case 'pcbSetActiveLayer': {
          if (!args.layer) return { ok: false, error: '需要 layer 参数' };
          return await window.api.pcbRunCommand('layer active ' + args.layer);
        }
        case 'pcbGetDesignFlowGuide': {
          return await window.api.pcbRunCommand('flow');
        }
        case 'pcbRunDrcIncremental': {
          if (!Array.isArray(args.changedIds) || !args.changedIds.length) {
            return await window.api.pcbRunCommand('drc');  // 全量
          }
          return await window.api.pcbRunCommand('drc inc ' + args.changedIds.join(' '));
        }
        case 'pcbSetLiveDrc': {
          // 通过专用命令设置实时 DRC
          // 简单实现：通过 runPcbEdaCommand 的 drc live 子命令
          return await window.api.pcbRunCommand('drc live ' + (args.on ? 'on' : 'off'));
        }
        case 'pcbGetDrcDelta': {
          // 通过 state 命令返回（包含 lastDelta 字段）
          return await window.api.pcbRunCommand('state');
        }
        case 'pcbUndo': {
          return await window.api.pcbRunCommand('undo');
        }
        case 'pcbRedo': {
          return await window.api.pcbRunCommand('redo');
        }
        case 'askQuestions': {
          const answers = await window.askQuestions(args.questions, this);
          return { ok: true, answers };
        }
        case 'downloadFile': {
          if (!this.workspacePath) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('no_workspace', '未设置工作区路径') : '未设置工作区路径' };
          }
          // 异步下载：立即返回 gid，不阻塞 Agent 后续操作
          // 支持配置下载参数：split/maxConnections/minSplitSize/timeout 等
          // dir 指定下载目录（可选，默认工作目录；须为已存在的绝对路径）
          let targetDir = this.workspacePath;
          if (args.dir) {
            targetDir = args.dir;
          }
          const opts = { dir: targetDir };
          if (args.filename) opts.out = args.filename;
          if (args.headers) opts.headers = args.headers;
          if (args.split) opts.split = args.split;
          if (args.maxConnections) opts.maxConnections = args.maxConnections;
          if (args.minSplitSize) opts.minSplitSize = args.minSplitSize;
          if (args.timeout) opts.timeout = args.timeout;
          if (args.connectTimeout) opts.connectTimeout = args.connectTimeout;
          if (args.maxRetries !== undefined) opts.maxRetries = args.maxRetries;
          if (args.retryWait) opts.retryWait = args.retryWait;
          if (args.userAgent) opts.userAgent = args.userAgent;
          if (args.referer) opts.referer = args.referer;
          const res = await window.api.aria2.addUri(args.url, opts);
          if (res.ok) {
            // 刷新下载管理器 UI（若已打开）
            if (window.DownloadManager) window.DownloadManager.refresh();
            return { ok: true, gid: res.gid, dir: targetDir, message: '下载已添加，可使用 getDownloadStatus 查询进度' };
          }
          return { ok: false, error: res.error || '添加下载失败' };
        }
        case 'getDownloadStatus': {
          if (args.gid) {
            const r = await window.api.aria2.tellStatus(args.gid);
            if (!r.ok) return { ok: false, error: r.error };
            const st = r.status;
            const total = parseInt(st.totalLength || '0', 10);
            const completed = parseInt(st.completedLength || '0', 10);
            const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
            const fileName = st.files?.[0]?.path ? st.files[0].path.split(/[\\/]/).pop() : '未知';
            return {
              ok: true,
              status: {
                gid: st.gid,
                status: st.status,
                progress,
                fileName,
                totalLength: total,
                completedLength: completed,
                downloadSpeed: parseInt(st.downloadSpeed || '0', 10),
                filePath: st.files?.[0]?.path || null,
                errorCode: st.errorCode || null,
                errorMessage: st.errorMessage || null
              }
            };
          }
          // 列出所有任务
          const r = await window.api.aria2.listAll();
          if (!r.ok) return { ok: false, error: r.error };
          const summarize = (items) => (items || []).map(it => ({
            gid: it.gid,
            status: it.status,
            fileName: it.files?.[0]?.path ? it.files[0].path.split(/[\\/]/).pop() : '未知',
            progress: parseInt(it.totalLength || '0', 10) > 0
              ? Math.round((parseInt(it.completedLength || '0', 10) / parseInt(it.totalLength || '0', 10)) * 100)
              : 0,
            totalLength: parseInt(it.totalLength || '0', 10),
            completedLength: parseInt(it.completedLength || '0', 10)
          }));
          return {
            ok: true,
            items: {
              active: summarize(r.active),
              waiting: summarize(r.waiting),
              stopped: summarize(r.stopped)
            }
          };
        }
        case 'pauseDownload': {
          const r = await window.api.aria2.pause(args.gid, args.force ?? false);
          if (window.DownloadManager) window.DownloadManager.refresh();
          return r;
        }
        case 'resumeDownload': {
          const r = await window.api.aria2.unpause(args.gid);
          if (window.DownloadManager) window.DownloadManager.refresh();
          return r;
        }
        case 'cancelDownload': {
          const r = await window.api.aria2.cancel(args.gid, args.force ?? true);
          if (window.DownloadManager) window.DownloadManager.refresh();
          return r;
        }
        // ---- 游戏工具 ----
        case 'inviteGame': {
          // Web控制模式下拒绝游戏
          if (this._fromWeb) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('game_window_unavailable', '独立窗口小游戏在Web控制模式下不可用，请在主机上操作') : '独立窗口小游戏在Web控制模式下不可用，请在主机上操作' };
          }
          const invitation = await window.showGameInvitation(args.game, args.message, args.suggestedAgents, this);
          if (!invitation.accepted) {
            return { ok: true, accepted: false, message: '用户忽略了游戏邀请' };
          }
          // Launch corresponding game
          return await this.launchGame(args.game, invitation.agentCount);
        }
        // ---- MCP 工具 ----
        case 'mcpListTools': {
          const result = await window.api.mcpListTools(args.serverName || null);
          // 刷新动态MCP工具注册
          if (result.ok && Array.isArray(result.tools)) {
            registerMcpTools(result.tools);
            this.contextManager.setSystemPrompt(this.getSystemPrompt());
          }
          return result;
        }
        // ---- 扩充网络工具 ----
        case 'httpRequest':
          return await window.api.httpRequest(args);
        case 'httpFormPost':
          return await window.api.httpFormPost(args);
        case 'dnsLookup':
          return await window.api.dnsLookup(args.hostname, args.rrtype);
        case 'ping':
          return await window.api.ping(args.host, args.count);
        case 'urlShorten':
          return await window.api.urlShorten(args.url);
        case 'urlEncodeDecode':
          return await window.api.urlEncodeDecode(args.input, args.operation);
        case 'checkSSLCert':
          return await window.api.checkSSLCert(args.hostname, args.port);
        case 'traceroute':
          return await window.api.traceroute(args.host);
        case 'portScan':
          return await window.api.portScan(args.host, args.ports, args.timeout);
        // ---- 串口工具 ----
        case 'serialListPorts':
          return await window.api.serialListPorts();
        case 'serialOpenPort':
          return await window.api.serialOpenPort(args.path, {
            baudRate: args.baudRate, dataBits: args.dataBits,
            stopBits: args.stopBits, parity: args.parity
          });
        case 'serialWritePort':
          return await window.api.serialWritePort(args.path, args.data, args.encoding);
        case 'serialReadPort':
          return await window.api.serialReadPort(args.path, args.timeout, args.encoding);
        case 'serialClosePort':
          return await window.api.serialClosePort(args.path);
        case 'serialSetSignals':
          return await window.api.serialSetSignals(args.path, { dtr: args.dtr, rts: args.rts, brk: args.brk });
        // ---- Office 硬解工具（低层 XML/容器操作）----
        case 'officeHardUnpack':
        case 'officeUnpack': // 旧名兼容
          return await window.api.officeUnpack(this._resolveWorkspacePath(args.path));
        case 'officeHardList':
        case 'officeListContents':
          return await window.api.officeListContents(this._resolveWorkspacePath(args.dir));
        case 'officeHardReadFile':
        case 'officeReadInnerFile':
          return await window.api.readFile(this._resolveWorkspacePath(args.path));
        case 'officeHardWriteFile':
        case 'officeWriteInnerFile':
          return await window.api.writeFile(this._resolveWorkspacePath(args.path), args.content);
        case 'officeHardRepack':
        case 'officeRepack':
          return await window.api.officeRepack(this._resolveWorkspacePath(args.dir), this._resolveWorkspacePath(args.outputPath));
        case 'officeHardGetSlideTexts':
        case 'officeGetSlideTexts':
          return await window.api.officeGetSlideTexts(this._resolveWorkspacePath(args.dir), args.slideFile);
        case 'officeHardSetSlideTexts':
        case 'officeSetSlideTexts':
          return await window.api.officeSetSlideTexts(this._resolveWorkspacePath(args.dir), args.slideFile, args.translations);
        case 'officeHardWordApplyTexts':
        case 'officeWordApplyTexts':
          return await window.api.officeWordApplyTexts(this._resolveWorkspacePath(args.pathOrDir), args.updates || []);
        // ---- Office-Word 工具（正规库）----
        case 'wordExtractText':
        case 'officeWordExtract': // 旧名兼容（语义升级为 mammoth 提取）
          return await window.api.wordExtractText(this._resolveWorkspacePath(args.path || args.pathOrDir), args.format);
        case 'wordCreate':
          return await window.api.wordCreate(args, this.workspacePath);
        case 'wordFillTemplate':
        case 'officeWordFillTemplate': // 旧名兼容（语义升级为 docxtemplater）
          return await window.api.wordFillTemplate(args.templatePath || args.pathOrDir, args.outputPath, args.data || args.replacements || {}, this.workspacePath);
        case 'wordGetMetadata':
          return await window.api.wordGetMetadata(this._resolveWorkspacePath(args.path));
        case 'wordListStyles':
        case 'officeWordGetStyles': // 旧名兼容
          return await window.api.wordListStyles(this._resolveWorkspacePath(args.path || args.pathOrDir));
        // ---- PPT Maker ----
        case 'pptMakerCreate':
          return await window.api.pptMakerCreate(args, this.workspacePath);
        // ---- 数据表格工具 ----
        case 'initSpreadsheet':
          return window.initSpreadsheet ? window.initSpreadsheet(args.title) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetSetCells':
          return window.spreadsheetSetCells ? window.spreadsheetSetCells(args.entries) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetGetCells':
          return window.spreadsheetGetCells ? window.spreadsheetGetCells(args.range) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetSetCellFormat':
          return window.spreadsheetSetCellFormat ? window.spreadsheetSetCellFormat(args.addr, args.format) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetSetRangeFormat':
          return window.spreadsheetSetRangeFormat ? window.spreadsheetSetRangeFormat(args.range, args.format) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetClearCells':
          return window.spreadsheetClearCells ? window.spreadsheetClearCells(args.range) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetInsertRows':
          return window.spreadsheetInsertRows ? window.spreadsheetInsertRows(args.rowNum, args.count) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetDeleteRows':
          return window.spreadsheetDeleteRows ? window.spreadsheetDeleteRows(args.rowNum, args.count) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetInsertCols':
          return window.spreadsheetInsertCols ? window.spreadsheetInsertCols(args.colLetter, args.count) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetDeleteCols':
          return window.spreadsheetDeleteCols ? window.spreadsheetDeleteCols(args.colLetter, args.count) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetSortRange':
          return window.spreadsheetSortRange ? window.spreadsheetSortRange(args.range, args.colLetter, args.ascending !== false) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetGetData':
          return window.spreadsheetGetData ? window.spreadsheetGetData() : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetExportCSV':
          return window.spreadsheetExportCSV ? window.spreadsheetExportCSV() : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetImportCSV':
          return window.spreadsheetImportCSV ? window.spreadsheetImportCSV(args.csv, args.startAddr) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetImportFile':
          return window.spreadsheetImportFile ? await window.spreadsheetImportFile(args.filePath) : { ok: false, error: '数据表格功能未初始化' };
        case 'spreadsheetExportFile':
          return window.spreadsheetExportFile ? await window.spreadsheetExportFile(args.filePath) : { ok: false, error: '数据表格功能未初始化' };
        // ---- 内置浏览器 (Playwright) ----
        case 'browserNavigate': {
          // 校验 url，避免 undefined 导致 Electron 报错
          const navUrl = args?.url || args?.target || '';
          if (!navUrl) return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('browser_no_url', 'browserNavigate 缺少 url 参数') : 'browserNavigate 缺少 url 参数' };
          const r = await window.api.browserNavigate(navUrl, args?.waitUntil, this.workspacePath);
          return r;
        }
        case 'browserScreenshot': {
          const ssRes = await window.api.browserScreenshot(args?.fullPage, this.workspacePath);
          // 不向 LLM 返回 base64 dataUrl（过长且无用），仅返回文件路径信息
          if (ssRes && ssRes.ok) {
            return { ok: true, filePath: ssRes.filePath, message: '截图已保存。如需查看图片内容，请调用 readImageFile 工具读取该截图。' };
          }
          return ssRes;
        }
        case 'browserClick':
          return await window.api.browserClick(args.selector, args?.timeout, this.workspacePath);
        case 'browserType':
          return await window.api.browserType(args.selector, args.text, args?.submit, args?.clear, this.workspacePath);
        case 'browserGetContent':
          return await window.api.browserGetContent(args.selector, this.workspacePath);
        case 'browserScroll':
          return await window.api.browserScroll(args.direction, args.amount, this.workspacePath);
        case 'browserBack':
          return await window.api.browserBack(this.workspacePath);
        case 'browserForward':
          return await window.api.browserForward(this.workspacePath);
        case 'browserRefresh':
          return await window.api.browserRefresh(this.workspacePath);
        case 'browserEvaluate':
          return await window.api.browserEvaluate(args.script, this.workspacePath);
        case 'browserWait':
          return await window.api.browserWait(args?.selector, args?.timeout, this.workspacePath);
        case 'browserHover':
          return await window.api.browserHover(args.selector, this.workspacePath);
        case 'browserSelect':
          return await window.api.browserSelect(args.selector, args.value, this.workspacePath);
        case 'browserGetInfo':
          return await window.api.browserGetInfo(this.workspacePath);
        case 'browserClose': {
          return await window.api.browserClose(this.workspacePath);
        }
        // ---- Goal / 长任务跟踪 ----
        case 'goalSet': {
          if (typeof GoalState === 'undefined') return { ok: false, error: 'GoalState模块未加载' };
          GoalState.setGoal(this.conversationId || 'main', args.objective, args.tokenBudget || 0);
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          return { ok: true, message: `目标已设置: ${args.objective}`, maxTurns: GoalState.MAX_GOAL_TURNS };
        }
        case 'goalStatus': {
          if (typeof GoalState === 'undefined') return { ok: false, error: 'GoalState模块未加载' };
          const g = GoalState.getGoal(this.conversationId || 'main');
          if (!g) return { ok: true, message: '当前没有活跃目标' };
          return { ok: true, goal: g };
        }
        case 'goalComplete': {
          if (typeof GoalState === 'undefined') return { ok: false, error: 'GoalState模块未加载' };
          GoalState.completeGoal(this.conversationId || 'main', args.summary);
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          return { ok: true, message: '目标已完成: ' + (args.summary || '') };
        }
        case 'sleep': {
          // 支持两种模式：
          //   until: 等待到指定时刻（13位毫秒时间戳 / ISO 日期时间 / "YYYY-MM-DD HH:mm[:ss]" / 短时刻 "HH:mm"）
          //   ms:    等待指定毫秒数
          if (args.until !== undefined && args.until !== null && args.until !== '') {
            const raw = String(args.until).trim();
            const isShortTime = /^\d{1,2}:\d{2}$/.test(raw);
            let targetMs;
            if (/^\d{13}$/.test(raw)) {
              targetMs = Number(raw);
            } else if (isShortTime) {
              // 短时刻 "HH:mm" → 视为今天该时刻（本地时区）
              const now = new Date();
              const [hh, mm] = raw.split(':');
              const today = new Date(); today.setHours(0, 0, 0, 0);
              today.setHours(parseInt(hh, 10), parseInt(mm, 10), 0, 0);
              targetMs = today.getTime();
            } else {
              let iso = raw.replace(' ', 'T');
              // 无时区标记则认为用户想表达本地时间，直接按本地时区构造
              if (!/Z|[+-]\d{2}:?\d{2}$/.test(iso)) {
                const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
                if (m) {
                  const d = new Date(+(m[1]), +(m[2]) - 1, +(m[3]), +(m[4]), +(m[5]), +(m[6] || 0));
                  targetMs = d.getTime();
                } else {
                  targetMs = new Date(iso).getTime();
                }
              } else {
                targetMs = new Date(iso).getTime();
              }
              if (isNaN(targetMs)) return { ok: false, error: `无法解析 until 时间：${raw}` };
            }
            if (isNaN(targetMs)) return { ok: false, error: `无法解析 until 时间：${raw}` };
            let waitMs = targetMs - Date.now();
            // 短时刻落在今天之前（已过）则顺延到明天等价时刻；长日期时刻已过则报错
            if (waitMs <= 0) {
              if (isShortTime) {
                targetMs += 24 * 3600 * 1000;
                waitMs = targetMs - Date.now();
              } else if (waitMs < 0) {
                return { ok: false, error: '目标时刻已过期，等待时长需为未来时间' };
              }
            }
            // 上限保护：最多等待到 24 小时
            if (waitMs > 24 * 3600 * 1000) {
              return { ok: false, error: '等待时长超过上限（最长 24 小时），请检查 until 时间' };
            }
            await new Promise(resolve => setTimeout(resolve, waitMs));
            return { ok: true, waitedUntil: new Date(targetMs).toLocaleString('zh-CN', { hour12: false }), waitedMs: waitMs };
          }
          const ms = Math.min(Math.max(parseInt(args.ms) || 1000, 1), 60000);
          await new Promise(resolve => setTimeout(resolve, ms));
          return { ok: true, slept: ms };
        }
        case 'adjustAppearance': {
          // 允许 LLM 主动调节深浅色模式 / 强调色 / 配色方案
          const current = await window.api.getSettings();
          const theme = { ...(current.theme || {}) };
          const changes = [];
          if (args.mode && ['light', 'dark', 'system'].includes(args.mode)) {
            theme.mode = args.mode;
            changes.push(`模式→${args.mode}`);
          }
          // 配色方案优先于单独的 accentColor
          if (args.schemeName) {
            const isDark = theme.mode === 'dark' ||
              (theme.mode === 'system' && document.documentElement.getAttribute('data-theme') === 'dark');
            const schemes = isDark
              ? (typeof ThemeManager !== 'undefined' ? ThemeManager.darkSchemes : [])
              : (typeof ThemeManager !== 'undefined' ? ThemeManager.lightSchemes : []);
            const found = schemes.find(s => s.name === args.schemeName);
            if (found) {
              theme.accentColor = found.accent;
              theme.backgroundColor = found.bg;
              changes.push(`配色→${args.schemeName}`);
            } else {
              return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('scheme_not_found', `未找到配色方案: ${args.schemeName}`, { name: args.schemeName }) : `未找到配色方案: ${args.schemeName}` };
            }
          } else if (args.accentColor && /^#[0-9a-fA-F]{6}$/.test(args.accentColor)) {
            theme.accentColor = args.accentColor;
            changes.push(`强调色→${args.accentColor}`);
          }
          if (changes.length === 0) {
            return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('no_changes_provided', '未提供任何可应用的更改（mode/accentColor/schemeName 至少一个）') : '未提供任何可应用的更改（mode/accentColor/schemeName 至少一个）' };
          }
          const merged = { ...current, theme };
          await window.api.setSettings(merged);
          if (typeof ThemeManager !== 'undefined') {
            ThemeManager.apply(theme);
          }
          return { ok: true, applied: changes.join('，'), theme };
        }
        // ---- Computer Use Protocol ----
        case 'computer': {
          const action = args.action;
          if (!action) return { ok: false, error: 'missing action parameter' };
          const coord = args.coordinate;
          switch (action) {
            case 'screenshot':
              return await window.api.computerScreenshot(this.workspacePath);
            case 'get_ui_tree':
              return await window.api.computerGetUITree();
            case 'mouse_move': {
              if (!Array.isArray(coord) || coord.length < 2)
                return { ok: false, error: 'coordinate [x,y] required for mouse_move' };
              return await window.api.computerMouseMove(coord[0], coord[1]);
            }
            case 'left_click':
            case 'right_click':
            case 'middle_click':
            case 'double_click': {
              const button = action === 'right_click' ? 'right'
                          : action === 'middle_click' ? 'middle' : 'left';
              const dc = action === 'double_click';
              return await window.api.computerClick(button, coord?.[0], coord?.[1], dc);
            }
            case 'left_click_drag': {
              const sc = args.start_coordinate;
              if (!Array.isArray(sc) || !Array.isArray(coord))
                return { ok: false, error: 'start_coordinate and coordinate [x,y] required for left_click_drag' };
              return await window.api.computerDrag(sc[0], sc[1], coord[0], coord[1]);
            }
            case 'type': {
              if (!args.text) return { ok: false, error: 'text parameter required for type' };
              return await window.api.computerType(args.text);
            }
            case 'key': {
              if (!args.key) return { ok: false, error: 'key parameter required for key action' };
              return await window.api.computerKey(args.key);
            }
            case 'scroll': {
              if (!args.scroll_direction)
                return { ok: false, error: 'scroll_direction required for scroll' };
              return await window.api.computerScroll(coord?.[0], coord?.[1], args.scroll_direction, args.scroll_amount);
            }
            case 'wait':
              return await window.api.computerWait(args.duration || 1);
            case 'cursor_position':
              return await window.api.computerCursorPosition();
            case 'get_screen_size':
              return await window.api.computerGetScreenSize();
            default:
              return { ok: false, error: `Unknown computer action: ${action}` };
          }
        }
        default: {
          // MCP 动态工具路由: mcp__<serverName>__<toolName>
          if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            if (parts.length >= 3) {
              const serverName = parts[1];
              const toolName = parts.slice(2).join('__');
              return await window.api.mcpCallTool(serverName, toolName, args || {});
            }
          }
          if (this.settings?.autoOptimizeToolSelection && !name.startsWith('__')) {
            await this.optimizeToolsForConversation(this.getLatestUserMessageText(), `工具 ${name} 不在当前集合，触发重优化`);
          }
          return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('unknown_tool', `未知工具: ${name}`, { name }) : `未知工具: ${name}` };
        }
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  handleTodo(args) {
    switch (args.action) {
      case 'add':
        this.todoIdCounter++;
        this.todoItems.push({ id: this.todoIdCounter, text: args.text, done: false });
        if (this.onTodoUpdate) this.onTodoUpdate(this.todoItems);
        return { ok: true, id: this.todoIdCounter };
      case 'remove':
        this.todoItems = this.todoItems.filter(t => t.id !== args.id);
        if (this.onTodoUpdate) this.onTodoUpdate(this.todoItems);
        return { ok: true };
      case 'toggle':
        const item = this.todoItems.find(t => t.id === args.id);
        if (item) { item.done = !item.done; if (this.onTodoUpdate) this.onTodoUpdate(this.todoItems); return { ok: true, done: item.done }; }
        return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('todo_not_found', '未找到该待办事项') : '未找到该待办事项' };
      case 'list':
        return { ok: true, items: this.todoItems };
      default:
        return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('unknown_action', '未知操作') : '未知操作' };
    }
  }

  async runSubAgent(args) {
    // Real sub-agent: isolated context + own agent loop + tool whitelist.
    // Inspired by claude-code-ref/src/utils/forkedAgent.ts.
    const DEFAULT_SUB_TOOLS = [
      'readFile', 'listDirectory', 'localSearch', 'createFile', 'editFile',
      'copyFile', 'makeDirectory', 'getSystemInfo', 'calculator', 'webSearch',
      'webFetch', 'runJavaScriptCode'
    ];
    const DANGEROUS_TOOLS = new Set([
      'deleteFile', 'deleteDirectory', 'moveFile', 'runNodeJavaScriptCode',
      'runShellScriptCode', 'runTerminalCommand', 'awaitTerminalCommand',
      'killTerminal', 'writeClipboard', 'openBrowser'
    ]);
    try {
      const task = String(args?.task || '').trim();
      if (!task) return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('task_empty', 'task 不能为空') : 'task 不能为空' };

      // Build tool whitelist
      let allowedTools;
      if (Array.isArray(args.tools) && args.tools.length > 0) {
        // Caller-specified whitelist — but always drop dangerous tools unless
        // explicitly listed AND the parent agent has them enabled.
        const parentEnabled = new Set(this.getActiveToolNames ? this.getActiveToolNames() : []);
        allowedTools = args.tools
          .filter(t => typeof t === 'string')
          .filter(t => !DANGEROUS_TOOLS.has(t) || parentEnabled.has(t));
      } else {
        allowedTools = DEFAULT_SUB_TOOLS.filter(t =>
          this.getActiveToolNames ? this.getActiveToolNames().includes(t) : true);
      }
      const allowedSet = new Set(allowedTools);
      // 移除迭代上限：原默认 10、上限 30 对复杂任务过小
      // 现在完全由子代理自身的 running/stopped 标志控制
      const maxIter = parseInt(args.maxIterations) || Infinity;

      // Create isolated sub-agent
      const subAgent = new Agent();
      subAgent.settings = this.settings;
      subAgent.workspacePath = this.workspacePath;
      subAgent.systemInfo = this.systemInfo;
      subAgent.cachedWorkspaceTree = this.cachedWorkspaceTree;
      subAgent.tarotCard = await window.api.drawTarot();
      const maxCtx = this.settings?.llm?.maxContextLength || 8192;
      subAgent.contextManager = new ContextManager(maxCtx);
      subAgent.contextManager.setOutputReserve(this.settings?.llm?.maxResponseTokens || 8192);
      const tarotLine = subAgent.tarotCard
        ? `你的命运之牌是: ${subAgent.tarotCard.name}${subAgent.tarotCard.isReversed ? '(逆位)' : '(正位)'} - ${(subAgent.tarotCard.isReversed ? subAgent.tarotCard.meaningOfReversed : subAgent.tarotCard.meaningOfUpright) || ''}`
        : '';
      subAgent.contextManager.setSystemPrompt(
        `你是一个子代理 Agent（Sub-Agent）。你的任务由父代理分配，你必须独立完成并报告结果。

## 任务
${task}

## 上下文
${args.context || '无额外上下文'}

${tarotLine}

## 工作要求
1. 自主规划并使用工具完成任务
2. 不要与用户交互（你无法直接看到用户）
3. 完成后给出简洁、结构化的结果报告
4. 不要使用 emoji
5. 最多 ${maxIter === Infinity ? '无上限' : maxIter + ' 轮迭代'}，合理安排工作`
      );

      // 生成唯一 ID 并注册到 this.subAgents（供 UI 展开查看完整对话）
      const subAgentId = 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const startTime = Date.now();
      const subAgentRecord = {
        id: subAgentId,
        task,
        tarot: subAgent.tarotCard,
        status: 'running',
        startTime,
        endTime: null,
        iterations: 0,
        toolUseCount: 0,
        usage: { prompt: 0, completion: 0, total: 0, cached: 0, cacheCreation: 0 },
        messages: [], // 完整消息历史快照（含 tool_calls 和 tool_result）
        subAgent // 引用 subAgent 实例（含 contextManager.messages）
      };
      this.subAgents.push(subAgentRecord);

      if (this.onMessage) this.onMessage('sub-agent-start', { id: subAgentId, task, tarot: subAgent.tarotCard, startTime });

      subAgent.contextManager.addUserMessage(task);
      subAgent.running = true;
      subAgent.stopped = false;

      // Forward sub-agent messages to parent's onMessage (prefixed)
      const parentOnMessage = this.onMessage;
      subAgent.onMessage = (type, data) => {
        if (!parentOnMessage) return;
        if (type === 'assistant') parentOnMessage('sub-agent-message', { id: subAgentId, task, content: data });
        else if (type === 'system') parentOnMessage('sub-agent-message', { id: subAgentId, task, content: `[系统] ${data}` });
      };
      subAgent.onToolCall = (name, a, status, result) => {
        // 仅累计工具使用次数，不转发到父代理 onToolCall
        // 子代理的工具调用只在子代理详情模态框中显示，不污染主聊天
        if (status === 'done') subAgentRecord.toolUseCount++;
      };

      // Run a mini agent loop with the tool whitelist
      let iterations = 0;
      let finalContent = '';
      const subRunId = ++subAgent.runId;
      let hitMaxIter = false; // 是否因达到迭代上限而退出

      while (subAgent.running && !subAgent.stopped && iterations < maxIter && subRunId === subAgent.runId) {
        iterations++;
        subAgentRecord.iterations = iterations;

        // 子代理上下文管理：与主 Agent 共用 _manageContext，确保不溢出
        await this._manageContext(subAgent.contextManager, (msg) => {
          if (parentOnMessage) parentOnMessage('sub-agent-message', { id: subAgentId, task, content: `[系统] ${msg}` });
        }, { isSubAgent: true });

        const messages = subAgent.injectActiveSkillsSuffix(subAgent.contextManager.getMessages());
        const allSchemas = getToolSchemas(this.settings?.tools);
        const subTools = allSchemas.filter(t => allowedSet.has(t.function?.name));

        let result = await window.api.chatLLM(messages, this._llmOptions({
          tools: subTools.length > 0 ? subTools : undefined,
          requestId: 'sub-' + Date.now().toString(),
          sessionKey: this.sessionKey || null
        }));

        // ===== 子代理 400 错误自动修复 + 重试循环（与主 Agent 逻辑一致）=====
        if (!result.ok) {
          const errText = String(result.error || '');
          const kind = result.kind;
          const isFixableClient = kind === 'client' || kind === 'payment' ||
            result.status === 400 || result.status === 402 ||
            /tool_calls?|tool_call_id|insufficient tool messages|following tool_calls|400|402|invalid|bad request|不合法|messages.*context|context.*length|too long|maximum context|token limit|exceed|reasoning_content|thinking mode|must be passed back/i.test(errText);
          const isAuthError = kind === 'auth';
          const SUB_MAX_RETRIES = 3;

          let subRetryCount = 0;
          while (!result.ok && !isAuthError && subRetryCount < SUB_MAX_RETRIES
                 && subAgent.running && !subAgent.stopped) {
            subRetryCount++;
            let fixedNote = '';
            if (isFixableClient) {
              // 先尝试 sanitize 修复损坏消息
              const sanitizeRes = subAgent.contextManager.sanitize();
              if (sanitizeRes.fixed) fixedNote = `，已自动修复 ${sanitizeRes.removedCount} 条消息`;
              // 再尝试强制上下文压缩（即使未超 70% 也执行，因为可能是上下文超限）
              await this._manageContext(subAgent.contextManager, null, { isSubAgent: true });
              if (subAgent.stopped) break;
            }
            if (parentOnMessage) {
              parentOnMessage('sub-agent-message', { id: subAgentId, task, content: `[系统] LLM 请求失败（${kind || 'unknown'}），正在自动重试（${subRetryCount}/${SUB_MAX_RETRIES}）${fixedNote}` });
            }
            await new Promise(r => setTimeout(r, 800 * subRetryCount));
            if (subAgent.stopped) break;
            try {
              const retryMessages = subAgent.contextManager.getMessages();
              const retryTools = subTools.length > 0 ? subTools : undefined;
              result = await window.api.chatLLM(retryMessages, this._llmOptions({
                tools: retryTools,
                requestId: 'sub-' + Date.now().toString() + '-retry-' + subRetryCount,
                sessionKey: this.sessionKey || null
              }));
            } catch (retryErr) {
              if (subAgent.stopped) break;
              result = { ok: false, error: retryErr.message || String(retryErr), kind: 'client' };
            }
          }
          if (!result.ok) {
            if (parentOnMessage) parentOnMessage('sub-agent-message', { id: subAgentId, task, content: `[错误] ${result.error}（已自动修复并重试 ${subRetryCount} 次后仍失败）` });
            break;
          }
          if (subRetryCount > 0 && parentOnMessage) {
            parentOnMessage('sub-agent-message', { id: subAgentId, task, content: '[系统] 上下文修复后重试成功' });
          }
        }

        // 子代理 usage 累计到主会话统计 + 子代理自身记录
        if (result.data?.usage) {
          this._accumulateUsage(result.data.usage, result.data?._meta?.model);
          const u = result.data.usage;
          subAgentRecord.usage.prompt += u.prompt_tokens || 0;
          subAgentRecord.usage.completion += u.completion_tokens || 0;
          subAgentRecord.usage.total += u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
          subAgentRecord.usage.cached += u.prompt_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0;
          subAgentRecord.usage.cacheCreation += u.cache_creation_input_tokens || 0;
          // 记录最近一次请求的 prompt_tokens（用于子代理模态框上下文窗口占比估算的回退值）
          subAgentRecord.usage.lastPrompt = u.prompt_tokens || 0;
        }
        // 实时更新 messages 快照（确保模态框即使不调用 getMessages() 也能读到最新消息）
        subAgentRecord.messages = subAgent.contextManager.getMessages();
        const choice = result.data.choices?.[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        // 隐私信息保护：子代理上下文的 tool_calls 同样使用脱敏副本（真实执行仍用原始参数）
        let subToolCallsForCtx = assistantMsg.tool_calls;
        if (this.settings?.privacyProtection?.enabled
            && typeof PrivacyFilter?.sanitizeToolCallsForContext === 'function') {
          subToolCallsForCtx = PrivacyFilter.sanitizeToolCallsForContext(assistantMsg.tool_calls, {
            maskArgs: this.settings.privacyProtection.filterArgs !== false,
            scanTerminal: this.settings.privacyProtection.filterTerminal !== false,
            categories: this._getPrivacyCategories()
          });
        }
        subAgent.contextManager.addAssistantMessage(assistantMsg.content, subToolCallsForCtx);

        if (assistantMsg.content) {
          finalContent = assistantMsg.content;
          if (subAgent.onMessage) subAgent.onMessage('assistant', assistantMsg.content);
        }

        // Execute tool calls (whitelist-enforced)
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          for (const tc of assistantMsg.tool_calls) {
            if (subAgent.stopped || subRunId !== subAgent.runId) break;
            const toolName = tc.function.name;
            if (!allowedSet.has(toolName)) {
              const deny = JSON.stringify({ ok: false, error: `工具 ${toolName} 不在子代理白名单中` });
              subAgent.contextManager.addToolResult(tc.id, toolName, deny);
              continue;
            }
            let toolArgs;
            try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch { toolArgs = {}; }
            if (subAgent.onToolCall) subAgent.onToolCall(toolName, toolArgs, 'calling');
            // Sub-agent tool calls always run through the parent's executeTool
            // (sensitive operations still respect user approval settings).
            const toolResult = await this.executeTool(toolName, toolArgs);
            const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            // 与主 agentLoop 一致：阈值 20000，保留前 18000 + 尾 2000
            let truncated = resultStr;
            if (resultStr.length > 20000) {
              const head = resultStr.substring(0, 18000);
              const tail = resultStr.substring(resultStr.length - 2000);
              truncated = `${head}\n\n...[中间部分已截断，共${resultStr.length}字符]...\n\n${tail}`;
            }
            // 隐私信息保护：子代理工具结果注入其上下文前同样过滤隐私信息
            if (this.settings?.privacyProtection?.enabled
                && this.settings.privacyProtection.filterResults !== false
                && typeof PrivacyFilter?.filterPrivacyInfo === 'function') {
              truncated = PrivacyFilter.filterPrivacyInfo(truncated, this._getPrivacyCategories());
            }
            subAgent.contextManager.addToolResult(tc.id, toolName, truncated);
            // 隐私信息保护：子代理 UI 展示副本过滤隐私信息
            const subDisplayResult = this._sanitizeToolResultForDisplay(toolResult);
            if (subAgent.onToolCall) subAgent.onToolCall(toolName, toolArgs, 'done', subDisplayResult);
          }
          if (subAgent.stopped || subRunId !== subAgent.runId) break;
          continue; // let the agent process tool results
        }

        // No tool calls → done
        if (choice.finish_reason === 'stop') break;
      }

      // 检查是否因达到迭代上限而退出（非正常 stop）
      if (iterations >= maxIter && maxIter !== Infinity) {
        hitMaxIter = true;
        // 要求子代理写出完整结果报告，而非直接停止
        if (parentOnMessage) parentOnMessage('sub-agent-message', { id: subAgentId, task, content: '[系统] 已达迭代上限，正在生成完整结果报告...' });
        try {
          subAgent.contextManager.addUserMessage(
            '【系统指令】你已达到迭代上限。请立即停止调用工具，写出当前任务的完整结果报告：\n' +
            '1. 已完成的工作和结果\n2. 未完成的步骤和原因\n3. 遇到的问题和建议\n请简洁但完整地总结。'
          );
          const summaryResult = await window.api.chatLLM(subAgent.contextManager.getMessages(), {
            requestId: 'sub-' + Date.now().toString() + '-final-report',
            sessionKey: this.sessionKey || null
          });
          if (summaryResult.ok && summaryResult.data?.choices?.[0]?.message?.content) {
            finalContent = summaryResult.data.choices[0].message.content;
            subAgent.contextManager.addAssistantMessage(finalContent);
            if (subAgent.onMessage) subAgent.onMessage('assistant', finalContent);
          }
        } catch (e) {
          // 降级：使用已有的 finalContent
          if (parentOnMessage) parentOnMessage('sub-agent-message', { id: subAgentId, task, content: `[系统] 最终报告生成失败: ${e.message}，使用最后已知结果` });
        }
      }

      subAgent.running = false;
      subAgentRecord.status = 'done';
      subAgentRecord.endTime = Date.now();
      subAgentRecord.messages = subAgent.contextManager.getMessages();
      // 子代理聊天记录完整保留在 record.messages（含 contextManager 数据），
      // 点开详情模态框随时可查看完整对话；关闭模态框时仅移除 DOM 渲染，数据不释放。
      // 仅断开回调闭包（onMessage/onToolCall/onTitleChange），释放对父代理的引用。
      subAgent.onMessage = null;
      subAgent.onToolCall = null;
      subAgent.onTitleChange = null;
      // 限制子代理记录数量上限：只保留最近 N 条完整消息快照（供 UI 展开查看），
      // 超出上限的最早记录释放 subAgent 实例、contextManager 与消息快照
      // （消息对象随之可被 GC），防止长会话运行大量子代理时记录无限累积。
      const MAX_SUB_AGENT_RECORDS = 100;
      if (this.subAgents.length > MAX_SUB_AGENT_RECORDS) {
        const overflow = this.subAgents.splice(0, this.subAgents.length - MAX_SUB_AGENT_RECORDS);
        for (const rec of overflow) {
          if (rec.subAgent?.contextManager) {
            const cm = rec.subAgent.contextManager;
            cm.messages = [];
            cm.historyMessages = [];
            cm.summaries = [];
            cm.compactBoundaries = [];
            cm.pinnedMessages = [];
          }
          rec.subAgent = null;
          rec.messages = [];
          rec.tarot = null;
        }
      }
      const response = finalContent || '子代理完成了任务但没有文本回复';
      if (this.onMessage) this.onMessage('sub-agent-done', {
        id: subAgentId, task, result: response,
        messages: subAgentRecord.messages,
        usage: subAgentRecord.usage,
        toolUseCount: subAgentRecord.toolUseCount,
        iterations: subAgentRecord.iterations,
        duration: subAgentRecord.endTime - subAgentRecord.startTime,
        hitMaxIter // 是否因达到迭代上限而退出
      });
      return { ok: true, result: response, iterations, subAgentId, hitMaxIter };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 根据 ID 获取子代理记录（含完整消息历史和上下文） */
  getSubAgent(id) {
    return this.subAgents.find(s => s.id === id);
  }

  // ---- Game System ----
  async launchGame(game, agentCount) {
    switch (game) {
      case 'flyingFlower': return await this.playFlyingFlower(agentCount);
      case 'sanguosha': return await this.playSanguosha(agentCount);
      case 'undercover': return await this.playUndercover(agentCount);
      case 'idiom': return await this.playIdiom(agentCount);
      case 'guessCharacter': return await this.playGuessCharacter(agentCount);
      default: return { ok: false, error: typeof i18nToolReturn === 'function' ? i18nToolReturn('unknown_game', `未知游戏: ${game}`, { game }) : `未知游戏: ${game}` };
    }
  }

  async createGameAgent(name, buildPrompt) {
    const ga = new Agent();
    ga.settings = this.settings;
    ga.tarotCard = await window.api.drawTarot();
    ga.contextManager = new ContextManager(this.settings.llm.maxContextLength || 8192);
    ga.contextManager.setOutputReserve(this.settings?.llm?.maxResponseTokens || 8192);
    // buildPrompt receives tarotCard so callers can embed it without referencing ga before init
    const systemPrompt = typeof buildPrompt === 'function' ? buildPrompt(ga.tarotCard) : buildPrompt;
    ga.contextManager.setSystemPrompt(systemPrompt);
    if (this.onMessage) this.onMessage('sub-agent-start', { task: `游戏玩家 ${name}`, tarot: ga.tarotCard });
    return ga;
  }

  async gameAgentRespond(ga, userMsg) {
    ga.contextManager.addUserMessage(userMsg);
    const messages = ga.contextManager.getMessages();
    const result = await window.api.chatLLM(messages, this._llmOptions({
      temperature: 0.9,
      max_tokens: this.settings?.llm?.maxResponseTokens || 2048,
      requestId: Date.now().toString(),
      sessionKey: this.sessionKey || null
    }));
    // 游戏内 LLM 调用 token 累计到当前主会话统计（用于上下文模态框显示）
    if (result.ok && result.data?.usage) {
      this._accumulateUsage(result.data.usage, result.data?._meta?.model);
    }
    if (result.ok && result.data.choices?.[0]?.message?.content) {
      const resp = result.data.choices[0].message.content.trim();
      ga.contextManager.addMessage({ role: 'assistant', content: resp });
      return resp;
    }
    return null;
  }

  // ---- Flying Flower Game (飞花令) ----
  async playFlyingFlower(agentCount) {
    const result = await window.api.openFlyingFlower(agentCount);
    if (result && result.ok) {
      if (this.onMessage) this.onMessage('assistant', `🎮 **飞花令**游戏窗口已打开！\n\n${agentCount} 位 AI 玩家已就绪，请在游戏窗口中进行操作。`);
      return { ok: true, game: 'flyingFlower', message: '游戏窗口已打开' };
    }
    return { ok: false, error: result?.error || '无法打开飞花令游戏窗口' };
  }

  // ---- Undercover Game (谁是卧底) ----
  async playUndercover(agentCount) {
    const result = await window.api.openUndercover(agentCount);
    if (result && result.ok) {
      if (this.onMessage) this.onMessage('assistant', `🎮 **谁是卧底**游戏窗口已打开！\n\n${agentCount} 位 AI 玩家已就绪，请在游戏窗口中进行操作。`);
      return { ok: true, game: 'undercover', message: '游戏窗口已打开' };
    }
    return { ok: false, error: result?.error || '无法打开谁是卧底游戏窗口' };
  }

  // ---- Sanguosha Game (三国杀) ----
  async playSanguosha(agentCount) {
    // Open the Sanguosha game in a new window
    const result = await window.api.openSanguosha(agentCount);
    if (result && result.ok) {
      if (this.onMessage) this.onMessage('assistant', `🎮 **三国杀**游戏窗口已打开！\n\n${agentCount} 位 AI 玩家已就绪，请在游戏窗口中进行操作。`);
      return { ok: true, game: 'sanguosha', message: '游戏窗口已打开' };
    }
    return { ok: false, error: result?.error || '无法打开三国杀游戏窗口' };
  }

  // ---- Idiom Chain Game (成语接龙) ----
  async playIdiom(agentCount) {
    const result = await window.api.openIdiom(agentCount);
    if (result && result.ok) {
      if (this.onMessage) this.onMessage('assistant', `🎮 **成语接龙**游戏窗口已打开！\n\n${agentCount} 位 AI 玩家已就绪，请在游戏窗口中进行操作。`);
      return { ok: true, game: 'idiom', message: '游戏窗口已打开' };
    }
    return { ok: false, error: result?.error || '无法打开成语接龙游戏窗口' };
  }

  // ---- Guess Character Game (是否猜人物) ----
  async playGuessCharacter(agentCount) {
    const result = await window.api.openGuessCharacter(agentCount);
    if (result && result.ok) {
      if (this.onMessage) this.onMessage('assistant', `🎮 **是否猜人物**游戏窗口已打开！\n\n请在游戏窗口中向 AI 提问并猜测人物。`);
      return { ok: true, game: 'guessCharacter', message: '游戏窗口已打开' };
    }
    return { ok: false, error: result?.error || '无法打开是否猜人物游戏窗口' };
  }

  newConversation() {
    this.running = false;
    this.stopped = false;
    this.runId++;
    this.contextManager.clear();
    this.todoItems = [];
    this.todoIdCounter = 0;
    // 清空子代理记录，释放其消息快照占用的内存
    this.subAgents = [];
    this.workspacePath = null;
    this.conversationId = null;
    this.conversationTitle = null;
    this.tarotCard = null; // Reset tarot card for new conversation
    this.resetOptimizedTools();
    this.resetSessionUsage(); // 重置会话级 token 统计
    if (this.onTitleChange) this.onTitleChange('未命名对话');
    if (this.onTodoUpdate) this.onTodoUpdate(this.todoItems);
    if (this.onStatusChange) this.onStatusChange('idle');
    // Re-init for new conversation
    this.init();
  }

  /**
   * /clear：只清工作上下文（含摘要/压缩状态），保留可见聊天记录与历史 transcript。
   * 下一次请求从全新上下文开始，但聊天界面与历史记录不变。
   */
  clearContextOnly() {
    if (this.contextManager && typeof this.contextManager.clearWorkingContext === 'function') {
      this.contextManager.clearWorkingContext();
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
    }
    try { this.saveToHistory(); } catch (_) { /* 保存失败不阻断 */ }
  }

  /**
   * /compact [focus]：立即压缩当前会话上下文。
   * 上下文未达水位线时返回 skipped（提示无需压缩）。
   */
  async compactNow(focus) {
    if (this.running) {
      return { ok: false, skipped: false, message: 'Agent 正在运行，请稍后再压缩' };
    }
    try {
      return await this.contextManager.summarizeWithLLM({
        sessionKey: this.sessionKey || null,
        tools: this.getRuntimeToolSchemas(),
        focus: focus || null,
        force: true, // /compact 语义：无视当前使用率，强制压缩
        maxRetries: this.settings?.contextCompaction?.compactionRetries ?? 1,
        maxTokens: this.settings?.contextCompaction?.summarizeMaxTokens || 2048,
        model: this.llmOverride?.model || null,
        reasoningEffort: this.getActiveReasoningEffort()
      });
    } catch (e) {
      return { ok: false, skipped: false, message: e && e.message ? e.message : String(e) };
    }
  }
}
