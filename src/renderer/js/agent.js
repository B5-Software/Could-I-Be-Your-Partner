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
    description: '当当前工具集不足以完成任务时，查看全部已启用工具并重新优化本对话工具选择。',
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
    description: '在本次会话中禁用自动工具选择优化，让所有已启用工具都可用。适用于需要频繁使用多种工具的复杂任务。',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }
};

// AI Agent Engine - handles the autonomous agent loop
class Agent {
  constructor() {
    this.contextManager = new ContextManager();
    this.running = false;
    this.stopped = false;
    this.paused = false;
    this.tarotCard = null;
    this.todoItems = [];
    this.todoIdCounter = 0;
    this.terminals = new Map();
    this.pendingApproval = null;
    this.approvalResolve = null;
    this.settings = null;
    this.systemInfo = null;
    this.workspacePath = null;
    this.conversationId = null;
    this.conversationTitle = null;
    this.onMessage = null; // callback(type, data)
    this.onStatusChange = null;
    this.onToolCall = null;
    this.onTodoUpdate = null;
    this.subAgents = [];
    this.runId = 0;
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

  async init() {
    this.settings = await window.api.getSettings();
    if (!this.settings.tools || typeof this.settings.tools !== 'object') {
      this.settings.tools = {};
    }
    this.systemInfo = await window.api.getFullSystemInfo();
    this.contextManager.setMaxTokens(this.settings.llm.maxContextLength || 8192);
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
        if (this.onMessage && info) {
          const kind = info.kind || 'unknown';
          const delayTxt = info.delayMs ? `，${Math.round(info.delayMs / 100) / 10}s 后重试` : '';
          const reasonTxt = info.reason ? `（${info.reason}）` : '';
          const msg = `LLM 请求失败（${kind}），第 ${info.attempt || 1} 次重试${delayTxt}${reasonTxt}`;
          this.onMessage('system', msg);
        }
      });
    }

    // Increment Dream session counter (used by autoDream gating)
    try { await window.api.dreamIncrementSession(); } catch { /* ignore */ }

    // Subscribe to LLM stream events to surface live tokens to the UI.
    // Only chunks matching the active requestId are forwarded (sub-agent &
    // dream loops use their own requestIds and don't emit to the main UI).
    if (window.api?.onStreamChunk && !this._streamChunkUnsub) {
      this._streamChunkUnsub = window.api.onStreamChunk((chunk) => {
        if (!chunk || chunk.requestId !== this._activeStreamRequestId) return;
        if (this.onMessage) this.onMessage('stream-chunk', chunk);
      });
    }
    if (window.api?.onStreamEnd && !this._streamEndUnsub) {
      this._streamEndUnsub = window.api.onStreamEnd((data) => {
        if (!data || data.requestId !== this._activeStreamRequestId) return;
        if (this.onMessage) this.onMessage('stream-end', data);
      });
    }
  }

  /**
   * Auto-Dream: check triple gate and run memory consolidation if passed.
   * Called after each conversation turn completes.
   * Gate 1: settings.agent.autoDreamEnabled (default true)
   * Gate 2: >= minHours since last consolidation (default 24h)
   * Gate 3: >= minSessions since last consolidation (default 5)
   * Lock: PID-based, expires after 1 hour
   */
  async maybeRunAutoDream() {
    if (!window.api?.dreamCheckGate) return;
    let gate;
    try { gate = await window.api.dreamCheckGate(); } catch { return; }
    if (!gate?.passed) {
      // Release lock if we acquired it but won't run (shouldn't happen, but be safe)
      return;
    }
    if (this.onMessage) {
      this.onMessage('system', '🌙 自动 Dream 启动：开始整理持久化记忆...');
    }
    try {
      await this._runDreamInline();
      await window.api.dreamRecordConsolidation();
      if (this.onMessage) {
        this.onMessage('system', '🌙 Dream 完成：记忆已整理');
      }
    } catch (e) {
      if (this.onMessage) {
        this.onMessage('system', `Dream 失败：${e.message}`);
      }
    } finally {
      try { await window.api.dreamReleaseLock(); } catch { /* ignore */ }
    }
  }

  /**
   * Run Dream as a forked agent: temporary context + dream skill prompt + file tools.
   * Saves and restores the main conversation context.
   */
  async _runDreamInline() {
    // Find the dream bundled skill
    await this.refreshSkillsCatalog();
    const dreamSkill = this.skillsCatalog.find(s => s.name === 'dream' || s.id === 'bundled-dream');
    if (!dreamSkill?.prompt) throw new Error('dream skill prompt not found');

    let memoryDir = '';
    try { memoryDir = await window.api.dreamGetMemoryDir(); } catch { /* ignore */ }

    // Save current context
    const savedContext = this.contextManager;
    const savedActiveSkills = this.activeSkills;
    const savedRunning = this.running;
    const savedStopped = this.stopped;

    // Create a fresh context for Dream
    const dreamContext = new ContextManager(this.settings?.llm?.maxContextLength || 8192);
    const sysInfo = this.systemInfo || {};
    const username = sysInfo.username || '用户';
    dreamContext.setSystemPrompt(`${dreamSkill.prompt}

# 环境信息
- 用户名: ${username}
- 记忆目录: ${memoryDir || '(未配置)'}
- 当前时间: ${this.getLocalDateTimeString()}
- 工作目录: ${this.workspacePath || '(未创建)'}

你拥有完整的文件工具权限来读取和修改记忆目录中的文件。请严格按照 Dream 流程执行。`);
    dreamContext.addUserMessage(`请立即开始 Dream 记忆整理流程。记忆目录位于：${memoryDir}。

执行步骤：
1. 调用 listDirectory 查看记忆目录
2. 调用 readFile 读取 topics.md（若存在）
3. 检查是否有 session_*.jsonl 文件，读取最近的
4. 整合、修剪、更新 topics.md
5. 完成后报告整理结果

请开始。`);

    // Swap in dream context
    this.contextManager = dreamContext;
    this.activeSkills = [];
    this.running = true;
    this.stopped = false;

    // Tools allowed during Dream (file ops + system info)
    const dreamAllowedTools = new Set([
      'readFile', 'listDirectory', 'createFile', 'editFile', 'deleteFile',
      'moveFile', 'copyFile', 'makeDirectory', 'localSearch',
      'getSystemInfo', 'manageContext'
    ]);

    try {
      // Run a mini agent loop (max 10 iterations)
      const dreamRunId = ++this.runId;
      let iterations = 0;
      const maxDreamIterations = 10;
      while (this.running && !this.stopped && iterations < maxDreamIterations && dreamRunId === this.runId) {
        iterations++;
        const messages = dreamContext.getMessages();
        const allTools = this.getRuntimeToolSchemas();
        const dreamTools = allTools.filter(t => dreamAllowedTools.has(t.name));
        const result = await window.api.chatLLM(messages, {
          tools: dreamTools.length > 0 ? dreamTools : undefined,
          requestId: 'dream-' + Date.now().toString()
        });
        if (!result.ok) {
          if (this.onMessage) this.onMessage('system', `Dream LLM 调用失败：${result.error}`);
          break;
        }
        const choice = result.data.choices?.[0];
        if (!choice) break;
        const assistantMsg = choice.message;
        if (choice.finish_reason === 'stop' && (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0)) {
          // Dream completed
          if (assistantMsg.content && this.onMessage) {
            this.onMessage('assistant', `[Dream] ${assistantMsg.content}`);
          }
          break;
        }
        dreamContext.addAssistantMessage(assistantMsg.content, assistantMsg.tool_calls);
        if (assistantMsg.content && this.onMessage) {
          this.onMessage('assistant', `[Dream] ${assistantMsg.content}`);
        }
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          for (const tc of assistantMsg.tool_calls) {
            const toolName = tc.function.name;
            let args;
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
            if (this.onToolCall) this.onToolCall(toolName, args, 'calling');
            const toolResult = await this.executeTool(toolName, args);
            const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            const truncated = resultStr.length > 3000 ? resultStr.substring(0, 3000) + '...[结果已截断]' : resultStr;
            dreamContext.addToolResult(tc.id, toolName, truncated);
            if (this.onToolCall) this.onToolCall(toolName, args, 'done', typeof toolResult === 'string' ? null : toolResult);
          }
        }
      }
    } finally {
      // Restore original context
      this.contextManager = savedContext;
      this.activeSkills = savedActiveSkills;
      this.running = savedRunning;
      this.stopped = savedStopped;
      this.runId++; // invalidate any pending dream iterations
    }
  }

  getSystemPrompt() {
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
    const enabledTools = this.settings?.tools || {};
    const allDefs = getAllToolDefinitions();
    const activeToolSet = new Set(this.getActiveToolNames ? this.getActiveToolNames() : allDefs.filter(tool => enabledTools[tool.name] !== false).map(t => t.name));
    const toolList = allDefs
      .filter(tool => activeToolSet.has(tool.name))
      .map(tool => `${tool.name}: ${tool.desc}`)
      .join('\n- ');
    const toolListSection = toolList ? `\n\n当前可用工具：\n- ${toolList}` : '';
    const skillsSection = this.skillsCatalog.length > 0
      ? `\n\n已加载技能目录：\n- ${this.skillsCatalog
          .map(skill => {
            const scripts = Array.isArray(skill?.scripts)
              ? skill.scripts.filter(s => String(s?.name || s || '').toLowerCase().endsWith('.js')).map(s => s?.name || s)
              : [];
            const scriptsText = scripts.length ? `（JS脚本: ${scripts.join(', ')}）` : '';
            const hasPrompt = skill.prompt ? ' [含prompt]' : '';
            return `${skill.name || '未命名技能'}: ${skill.description || '无描述'}${scriptsText}${hasPrompt}`;
          })
          .join('\n- ')}`
      : '';
    // Active skills: their prompts are injected into the system context.
    const activeSkillsSection = (Array.isArray(this.activeSkills) && this.activeSkills.length > 0)
      ? '\n\n【已激活技能 Prompt】（必须严格遵守以下技能的指令）\n' +
          this.activeSkills.map(s => `--- 技能: ${s.name} ---\n${s.prompt}`).join('\n\n')
      : '';
    const optimizationGuidance = this.settings?.autoOptimizeToolSelection && !this.sessionAutoOptimizeDisabled
      ? `\n\n【工具优化模式（必须遵守）】：
- 当前处于“工具精简”模式，你只会看到本轮优化后的工具。
- 如果你认为当前工具不足以完成任务，必须立即调用内部工具 __reoptimizeToolSelection 重新优化。
- 如果你需要频繁使用多种工具（复杂任务），可调用 __disableAutoOptimize 在本会话中禁用自动优化，让所有已启用工具都可用。
- 触发时机：出现“工具不可用/能力不足/需要新类别能力/多次尝试失败”任一情况就触发，不要硬撑。`
      : (this.sessionAutoOptimizeDisabled ? '\n\n【工具优化已禁用】本会话中自动工具选择优化已被禁用，所有已启用工具均可用。' : '');
    return `你是"Could I Be Your Partner"的AI Agent，你的名字叫${name}。${bio}
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
9. 用户上传Office/PDF文件时，原始文件和提取的文本(.txt)均已保存到工作目录。读取内容请用.txt；如需**输出/生成/翻译Office文件**，请对工作目录里的原始.docx/.xlsx/.pptx文件使用officeUnpack→修改XML→officeRepack流程
10. 当用户想玩游戏（飞花令、三国杀、谁是卧底等）时，必须调用inviteGame工具发起邀请，绝不能用普通对话方式模拟游戏

【代码执行工具选择规范】：
- runJavaScriptCode：仅适用于纯计算/逻辑，无任何文件系统或模块需求
- runNodeJavaScriptCode：只要涉及 require/fs/path/Buffer 等，以及一切文件生成、压缩、网络请求，必须使用此工具
- 绝对不能在 runJavaScriptCode 中使用 require()，这在浏览器沙箱中不可用
- runSkillScript：仅用于执行已导入标准技能中的 .js 脚本，且必须从 listSkills 返回的 scripts 中选择

【计算与网页抓取规范】：
- 任何算式求值、数值计算、百分比/幂/取模运算，优先调用 calculator 工具，禁止自行心算
- 只要用户要求“搜索/查资料/找信息”，不要只停留在 webSearch 结果列表；必须继续抓取内容后再回答
- 搜索链路必须按以下流程执行：
  1) webSearch：先找候选URL
  2) webFetch 或 offscreenRenderContent/offscreenRenderOCR：至少再调用一个内容抓取工具读取正文
  3) 基于抓取到的正文总结回答，并在回答中说明信息来源链接
- 当页面是动态渲染（天气、论坛、社媒、SPA）时，优先 offscreenRenderContent；需要识别图片文字时再用 offscreenRenderOCR
- 若只调用了 webSearch 而未抓取正文，视为任务未完成，必须继续调用抓取工具

【Office-Word文档规范】：
- 处理 .docx/.odt 模板与格式化文本时，优先使用 officeWordExtract / officeWordApplyTexts / officeWordGetStyles / officeWordFillTemplate
- 需要最终文件输出时，按 officeUnpack/officeRepack 流程完成打包

【PPTX/DOCX翻译规范 - 必须遵守】：
- 翻译PPTX/DOCX时，必须使用专用翻译工具，而不是读取原始XML：
  1. officeUnpack 解压原始文件
  2. officeListContents 获取所有slide文件名（如 ppt/slides/slide1.xml ... slide24.xml）
  3. 每次处理 1-3 张：officeGetSlideTexts 获取文字列表（只返回短文字，不含XML）→ 你直接翻译每条文字 → officeSetSlideTexts 写回
  4. 所有幻灯片处理完后：officeRepack 打包
- officeGetSlideTexts 返回 {index, text} 数组，每条都是幻灯片中的一个文字节点
- officeSetSlideTexts 接收翻译结果数组，index 对应 officeGetSlideTexts 返回的 index，text 为翻译后文字
- 严禁使用 officeReadInnerFile 读取原始 XML 来做翻译——那会导致输出窗口撑爆
- 严禁调用 runNodeJavaScriptCode 或任何脚本做翻译——翻译工作必须由你自己完成
- 每次最多同时处理 3 张幻灯片，完成后再处理下一批

【Office文件生成/修改规范（非翻译场景）】：
- 如需生成或结构性修改 .docx/.xlsx/.pptx，使用 officeUnpack → officeReadInnerFile → officeWriteInnerFile → officeRepack 流程
- 输出的 Office 文件必须保存到工作目录

【数据表格侧栏使用规范】：
- 处理表格数据、数据集分析、数据统计、制作数据报表时，优先使用数据表格侧栏（initSpreadsheet），而非拆解Office文件来操作
- 工作流程：initSpreadsheet打开面板 → spreadsheetSetCells填充数据 → spreadsheetSetCellFormat/spreadsheetSetRangeFormat设置表头格式 → 使用公式进行计算
- 支持60+内置函数：SUM/AVERAGE/COUNT/MAX/MIN/MEDIAN/STDEV（统计），IF/AND/OR/IFERROR（逻辑），VLOOKUP/CONCATENATE/LEFT/MID/SUBSTITUTE（文本），ROUND/ABS/SQRT/POWER/MOD（数学），NOW/TODAY/YEAR/MONTH/DAY（日期），PRODUCT/PI/SIN/COS等
- 公式以=开头，引用格式：A1单元格引用，A1:B5范围引用
- 可通过spreadsheetImportCSV快速导入CSV数据，spreadsheetExportCSV导出
- 支持文件导入导出：spreadsheetImportFile从磁盘加载.xlsx/.ods/.csv文件，spreadsheetExportFile导出到磁盘文件
- 当用户提供表格文件时，优先使用spreadsheetImportFile直接加载，而非手动解析
- 格式属性：bold(粗体) italic(斜体) color(文字颜色) bg(背景色) align(left/center/right) fontSize(字号px)

【邮件控制说明】：
- 用户可能通过邮件发送指令，这些邮件消息会以“[来自邮件]”前缀注入，应像普通用户消息一样响应
- 当敏感操作需要审批时，如果邮件控制已启用，审批请求会通过邮件发送给用户，用户回复TOTP验证码确认
- 每轮对话结束后，对话摘要会自动通过邮件发送给用户

【askQuestions交互工具 - 优先使用规范】：
- 当你需要同时了解用户的多个偏好/选择/信息时，**必须优先使用 askQuestions 工具**，而不是在回复中直接文字提问
- askQuestions 支持单选/多选/自由文本输入，可一次收集多个问题的答案，效率远高于逐条文字提问
- 典型场景：需求确认（功能?风格?范围?）、偏好收集（颜色?尺寸?格式?）、多选调查、项目初始化问卷
- 只有单个简单问题且无需选项时才用普通文字提问

【todoList待办事项 - 大任务必须使用】：
- 收到复杂任务（含3个以上步骤或多个子目标）时，**必须立即使用 todoList 工具拆分任务并写入待办列表**
- 每完成一个子步骤立即 toggle 标记为已完成，让用户随时看到进度
- 这能防止上下文过长导致遗忘任务目标，也方便你自己追踪进度
- 即使自动优化工具选择，todoList 始终保留在可用工具中

【网络工具使用规范】：
- httpRequest：发送任意HTTP请求（GET/POST/PUT/DELETE等），可自定义请求头、请求体、超时、跟随重定向等
- httpFormPost：发送表单或multipart文件上传请求
- dnsLookup/ping/checkSSLCert/traceroute/portScan：网络诊断与信息收集
- urlEncodeDecode：编码解码工具（URL编码、Base64）
- urlShorten：展开短链接

【MCP动态工具规范】：
- MCP服务器连接后，其工具会注册为独立工具，名称格式 mcp__serverName__toolName，可直接调用
- 如需查看/刷新MCP可用工具，调用 mcpListTools

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
${customPrompt ? '\n用户自定义提示词:\n' + customPrompt : ''}${toolListSection}${skillsSection}${activeSkillsSection}${optimizationGuidance}${this.getGoalSteeringSection()}`;
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

    const enabledTools = this.settings?.tools || {};
    const allDefs = getAllToolDefinitions(this.mode);
    const activeToolSet = new Set(this.getActiveToolNames ? this.getActiveToolNames() : allDefs.filter(tool => enabledTools[tool.name] !== false).map(t => t.name));
    const toolList = allDefs
      .filter(tool => activeToolSet.has(tool.name))
      .map(tool => `${tool.name}: ${tool.desc}`)
      .join('\n- ');
    const toolListSection = toolList ? `\n\n可用工具（仅应用内工具，不允许操作应用外的系统）：\n- ${toolList}` : '';

    return `你是"${name}"，一个${age ? age + '的' : ''}${genderText}，正在和一个你叫"${userNickname}"的用户进行恋爱模式对话。

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
${toolListSection}`;
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

    const enabledTools = this.settings?.tools || {};
    const allDefs = getAllToolDefinitions(this.mode);
    const activeToolSet = new Set(this.getActiveToolNames ? this.getActiveToolNames() : allDefs.filter(tool => enabledTools[tool.name] !== false).map(t => t.name));
    const toolList = allDefs
      .filter(tool => activeToolSet.has(tool.name))
      .map(tool => `${tool.name}: ${tool.desc}`)
      .join('\n- ');
    const toolListSection = toolList ? `\n\n可用工具：\n- ${toolList}` : '';

    const convoTitle = this.conversationTitle || '未命名会话';

    return `你是 CIBYP Code Agent，一个专业的编程助手。你的核心职责是协助用户在指定工作区内进行软件开发、代码阅读、重构、调试和文件管理。

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
4. 修改代码前先阅读目标文件，理解上下文；改动后说明修改了什么、为什么改。
5. 终端命令：先调用 makeTerminal 创建终端会话（已自动定位 cwd 到工作区），拿到 terminalId 后调用 runTerminalCommand/awaitTerminalCommand 执行命令；任务结束用 killTerminal 关闭。也可用 runShellScriptCode 一次性执行脚本。
6. 提供代码时使用 markdown 代码块并标注语言；执行命令时优先使用工具而非让用户手动操作。
7. 遇到不确定的需求时主动询问用户，不要臆测后大量改代码。
8. 工具调用失败时检查参数（路径、命令语法），重试或换方案，不要静默放弃。
9. 不要使用 emoji 表情符号，不要使用"亲昵语气词"。使用简体中文回复，代码注释也用中文。
10. 如果当前任务涉及大量工具调用或频繁切换工具，可调用 __disableAutoOptimize 在本会话中禁用工具选择优化。
${toolListSection}`;
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
    const enabledNames = this.getEnabledToolDefinitions().map(t => t.name);
    if (!this.hasUsableOptimizedSelection()) {
      return enabledNames;
    }
    const selectedSet = new Set(this.optimizedToolNames);
    return enabledNames.filter(name => selectedSet.has(name));
  }

  getRuntimeToolSchemas() {
    const activeNames = new Set(this.getActiveToolNames());
    const enabledToolsMap = {};
    getAllToolDefinitions(this.mode || 'chat').forEach(tool => {
      enabledToolsMap[tool.name] = activeNames.has(tool.name);
    });
    const tools = getToolSchemas(enabledToolsMap, this.mode || 'chat');
    if (this.settings?.autoOptimizeToolSelection && !this.sessionAutoOptimizeDisabled) {
      tools.push(INTERNAL_REOPTIMIZE_TOOL_SCHEMA);
      tools.push(INTERNAL_DISABLE_AUTO_OPTIMIZE_SCHEMA);
    }
    return tools;
  }

  /**
   * 检测当前模型是否支持多模态视觉输入。
   * 通过模型 ID 关键词判断，也检查 settings.llm.visionModels 自定义列表。
   */
  isVisionModel() {
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
      // Zen 免费模型中支持 vision 的
      'big-pickle', 'mimo-v2.5'
    ];
    return VISION_KEYWORDS.some(k => model.includes(k));
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
      { test: /word|docx|odt|文档模板|公文|格式化|套模板|占位符|正文|段落|样式/i, categories: ['Office-Word', 'Office'] },
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

  async optimizeToolsForConversation(firstUserMessage, reason = '') {
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
        max_tokens: 800,
        response_format: { type: 'json_object' },
        requestId: Date.now().toString()
      });

      const msg = result?.data?.choices?.[0]?.message;
      const content = (msg?.content || '').trim();
      // 思考模型（如 deepseek-v4-flash-free）经常 content 为空，答案在 reasoning_content 里
      const reasoningContent = (msg?.reasoning_content || '').trim();
      console.log('[tool-opt] LLM 返回:', { contentLen: content.length, reasoningLen: reasoningContent.length, contentPreview: content.substring(0, 200), reasoningPreview: reasoningContent.substring(0, 200) });

      // 从 content 或 reasoning_content 中提取 JSON
      let parsed = null;
      const tryParseJson = (text) => {
        if (!text) return null;
        try { return JSON.parse(text); } catch {}
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          try { return JSON.parse(match[0]); } catch {}
        }
        return null;
      };
      parsed = tryParseJson(content) || tryParseJson(reasoningContent);

      // 构建工具名查找表（大小写不敏感）
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
          console.log('[tool-opt] 兜底：从文本提取工具名（JSON 模式未生效）:', extractedFromText);
          selected = extractedFromText;
        }
      }
      console.log('[tool-opt] 解析结果:', { parsedSelected: selectedRaw.length, validSelected: selected.length, selectedNames: selected });
      const compacted = this.compactOptimizedSelection(selected, enabledDefs, firstUserMessage);

      // 关键修复：无论 LLM 返回什么都必须给 optimizedToolNames 赋非空值，
      // 否则下一次 sendMessage 会再次进入“检测到优化未执行”分支形成死循环。
      // 优先用 LLM 选择（compacted），其次用启发式 fallback，最后兜底用所有启用工具。
      const allEnabledNames = enabledDefs.map(t => t.name);
      let finalSelection = compacted.length > 0 ? compacted : fallback;
      if (finalSelection.length === 0) finalSelection = allEnabledNames.slice(0, Math.min(12, allEnabledNames.length));
      this.optimizedToolNames = finalSelection;
      this.optimizedToolReason = typeof parsed?.reason === 'string' ? parsed.reason : (reason || '首条消息优化');
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
      console.log('[tool-opt] 优化完成:', { selected: selected.length, final: finalSelection.length, reason: this.optimizedToolReason });
      return { ok: true, selected: this.optimizedToolNames, reason: this.optimizedToolReason };
    } catch (e) {
      // 即使失败也要赋非空值，避免下次 sendMessage 重复触发补偿优化
      let safeFallback = fallback.length > 0 ? fallback : enabledDefs.slice(0, 12).map(t => t.name);
      if (safeFallback.length === 0) safeFallback = enabledDefs.map(t => t.name);
      this.optimizedToolNames = safeFallback;
      this.optimizedToolReason = '优化失败，回退到精简启发式工具集';
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
    if (!this.settings?.llm?.apiUrl || !this.settings?.llm?.apiKey) {
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
        if (a.ocrText) return `[附件: ${a.name}]${exactPath}\nOCR识别文本:\n${a.ocrText}`;
        if (a.extractedText) {
          const text = a.extractedText.length > 2000 ? a.extractedText.substring(0, 2000) + '\n...[已截断]' : a.extractedText;
          const converted = a.convertedPath ? `\n已转换文本路径: ${a.convertedPath}` : '';
          const original = a.path && a.convertedPath && a.path !== a.convertedPath ? `\n⚠️ 原始文件精确路径（用于officeUnpack，必须原样使用）: ${a.path}` : exactPath;
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

    // Append this turn to the daily session log (Dream consolidation data source)
    try {
      await this.appendSessionRecord(userMessage, fullMessage);
    } catch { /* ignore session-log failures */ }

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

    // Auto-Dream: check triple gate and run memory consolidation if passed.
    // Runs after the user-visible turn completes so it never blocks the response.
    await this.maybeRunAutoDream();
  }

  /**
   * Append a compact JSONL record of this conversation turn to the daily
   * session file (memory/session_YYYY-MM-DD.jsonl). Dream reads these to
   * consolidate persistent memory. Failures are non-fatal.
   */
  async appendSessionRecord(userText, fullMessage) {
    if (!window.api?.dreamAppendSession) return;
    const msgs = this.contextManager.getMessages();
    // Capture assistant turns produced in this run (after the user message)
    const turns = [];
    let sawUser = false;
    for (const m of msgs) {
      if (m.role === 'user' && (m.content === fullMessage || m.content === userText)) {
        sawUser = true;
        continue;
      }
      if (sawUser && m.role === 'assistant') {
        turns.push({
          content: typeof m.content === 'string' ? m.content.slice(0, 2000) : '',
          toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.length : 0
        });
      }
    }
    const record = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      conversationId: this.conversationId,
      title: this.conversationTitle || '',
      user: typeof userText === 'string' ? userText.slice(0, 1000) : String(userText).slice(0, 1000),
      assistantTurns: turns
    };
    await window.api.dreamAppendSession(record);
  }

  async saveToHistory() {
    if (!this.conversationId) return;
    try {
      const payload = {
        id: this.conversationId,
        title: this.conversationTitle || '未命名对话',
        messages: this.contextManager.messages,
        summaries: this.contextManager.summaries,
        tarotCard: this.tarotCard,
        workspacePath: this.workspacePath
      };
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
    this.contextManager.clear();
    this.contextManager.messages = conversation.messages || [];
    this.contextManager.summaries = conversation.summaries || [];
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
    this.contextManager.setSystemPrompt(this.getSystemPrompt());
    if (this.onTitleChange) this.onTitleChange(this.conversationTitle || '未命名对话');
  }

  async generateConversationTitle(userMessage) {
    try {
      const normalize = (text) => ((text || '').replace(/[\s\r\n]+/g, ' ').trim()) || '未命名对话';
      const cleaned = normalize(userMessage);
      // 快速兜底：LLM 调用失败时使用第一句话
      const quickFallback = (() => {
        const firstSentence = cleaned.split(/[，。！？、,.;:；：\n]+/)[0] || cleaned;
        let base = firstSentence.replace(/\s+/g, '').trim();
        base = base.replace(/^(请|帮我|麻烦|能否|可以|如何|怎么|需要|我要|想要|修复|实现|增加|优化|解决|改进|调整|删除|添加|生成|完善|修正|处理)+/g, '').trim();
        if (!base) base = cleaned;
        return base.slice(0, 20);
      })();

      // 检测 LLM 是否返回了 meta 描述（把指令复述出来）而非实际标题
      const isMetaDescription = (text) => {
        if (!text || typeof text !== 'string') return true;
        const lower = text.toLowerCase();
        // 常见 meta 描述特征：LLM 复述任务而非给出实际答案
        const metaPatterns = [
          /我们被要求/, /我们被问到/, /我们问到/, /被问到/, /用户消息.*提到/, /用户.*想要/,
          /请为.+生成/, /请为.+对话/, /生成.+标题/, /简短的中文标题/,
          /为以下对话/, /直接返回标题/, /不超过.*字/, /这是一个编码任务/,
          /这是一个对话场景/, /请输入文本/, /title:|标题：/,
          /所以应该/, /可能的工具/, /可能的.*工具/, /所以选择/, /应该选择/,
          /用户可能/, /可能想要/, /可能的 geogebra/i, /可能的工具/i
        ];
        return metaPatterns.some(p => p.test(text)) || text.length > 30;
      };

      // 语义化标题：所有模式都用 LLM 生成，更贴合对话意图
      const modeHint = this.mode === 'code'
        ? '主题与编程/代码相关。'
        : this.mode === 'babe'
          ? '风格温馨。'
          : '';
      // 注意：prompt 不能用"请为以下对话生成标题"这种容易被复述的句式，
      // 改用"任务：起标题"这种直接指令 + few-shot 示例引导 LLM 输出实际标题。
      const prompt = `任务：根据用户消息起一个简短标题。
要求：
- 只输出标题文字（2-15个字），不要任何前缀、引号、解释、标点
- 不要描述任务本身（禁止输出"标题:""为对话生成"等元描述）
- ${modeHint || '概括用户意图即可。'}

示例：
用户消息: "帮我写一个Python爬虫" → 输出: Python爬虫
用户消息: "今天天气怎么样" → 输出: 查天气
用户消息: "解释一下闭包" → 输出: JS闭包解释`;

      const result = await window.api.chatLLM([
        { role: 'system', content: prompt },
        { role: 'user', content: cleaned }
      ], { temperature: 0.2, max_tokens: 30, requestId: Date.now().toString() });

      const msg = result?.data?.choices?.[0]?.message;
      // 优先用 Final（content），如果 content 为空或是 meta 描述，才尝试 reasoning_content
      let title = (msg?.content || '').trim();
      if (isMetaDescription(title)) {
        // content 为空或是 meta 描述，回退到 reasoning_content（思考模型可能把简短答案放这里）
        const reasoning = (msg?.reasoning_content || '').trim();
        if (reasoning && !isMetaDescription(reasoning)) {
          // 从 reasoning 中提取最后一行或最短的句子作为标题
          const lines = reasoning.split(/\n/).map(l => l.trim()).filter(Boolean);
          title = lines[lines.length - 1] || reasoning;
        } else {
          title = '';
        }
      }
      if (title) {
        const cleanedTitle = title.replace(/["「」『』《》""'']/g, '')
          .replace(/^(标题[:：]|title[:：])\s*/i, '')
          .replace(/\s+/g, ' ').trim().substring(0, 20);
        if (cleanedTitle && cleanedTitle.length >= 2 && !isMetaDescription(cleanedTitle)) {
          return cleanedTitle;
        }
      }
      return quickFallback;
    } catch { /* ignore */ }
    return (userMessage ? userMessage : '未命名对话').replace(/\s+/g, ' ').substring(0, 20);
  }

  stop() {
    this.stopped = true;
    this.running = false;
    this.runId++;
    this.hotMessages = [];
    if (this.pendingApproval) this.resolveApproval(false);
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
        if (a.ocrText) return `[附件: ${a.name}]${exactPath}\nOCR识别文本:\n${a.ocrText}`;
        if (a.extractedText) {
          const text = a.extractedText.length > 2000 ? a.extractedText.substring(0, 2000) + '\n...[已截断]' : a.extractedText;
          const converted = a.convertedPath ? `\n已转换文本路径: ${a.convertedPath}` : '';
          const original = a.path && a.convertedPath && a.path !== a.convertedPath ? `\n⚠️ 原始文件精确路径（用于officeUnpack，必须原样使用）: ${a.path}` : exactPath;
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

  async agentLoop(runId) {
    let iterations = 0;
    const maxIterations = this.settings?.agent?.maxIterations || 50; // Safety limit (configurable)

    while (this.running && !this.stopped && iterations < maxIterations && runId === this.runId) {
      iterations++;

      // Check if context needs management (with autoCompact circuit breaker)
      const maxFailures = this.settings?.agent?.autoCompactMaxFailures ?? 3;
      const stats = this.contextManager.getStats();
      // Three-layer compaction: Micro (>70%) → LLM summary (>85%) → hard truncate (>95%)
      if (parseFloat(stats.usage) > 70) {
        const cleared = this.contextManager.microCompact();
        if (cleared > 0 && this.onMessage) {
          this.onMessage('system', `MicroCompact: 已清理 ${cleared} 条旧工具结果（上下文使用 ${stats.usage}%）`);
        }
      }
      if (parseFloat(stats.usage) > 85 && this.autoCompactFailures < maxFailures) {
        try {
          const sumRes = await this.contextManager.summarizeWithLLM({ keepLast: 6 });
          if (sumRes.ok) {
            this.autoCompactFailures = 0;
            if (this.onMessage) {
              this.onMessage('system', `已自动压缩上下文（${sumRes.message}），当前使用 ${this.contextManager.getStats().usage}%`);
            }
          } else {
            this.autoCompactFailures++;
            if (this.onMessage) {
              this.onMessage('system', `上下文压缩失败（${this.autoCompactFailures}/${maxFailures}）：${sumRes.message}`);
            }
          }
        } catch (e) {
          this.autoCompactFailures++;
          if (this.onMessage) {
            this.onMessage('system', `上下文压缩异常（${this.autoCompactFailures}/${maxFailures}）：${e.message}`);
          }
        }
      }
      if (parseFloat(stats.usage) > 95) {
        // Emergency: hard truncate to keep last 4 messages
        this.contextManager.manage('clear_old', { keepLast: 4 });
        if (this.onMessage) {
          this.onMessage('system', '⚠️ 上下文严重溢出，已强制截断最近4条消息');
        }
      }

      // 热对话：注入用户在Agent工作期间发送的新消息
      while (this.hotMessages.length > 0) {
        const hotMsg = this.hotMessages.shift();
        this.contextManager.addUserMessage(`【用户追加消息】${hotMsg}`);
        if (this.onMessage) this.onMessage('system', '已将新消息注入当前对话');
      }

      if (this.settings?.autoOptimizeToolSelection && !this.sessionAutoOptimizeDisabled && !this.hasUsableOptimizedSelection()) {
        await this.optimizeToolsForConversation(this.getLatestUserMessageText(), '循环检测到优化未执行，自动补偿优化');
      }

      const messages = this.contextManager.getMessages();
      const tools = this.getRuntimeToolSchemas();
      const streamEnabled = this.settings?.llm?.streamResponses !== false;
      const reqId = 'agent-' + Date.now().toString() + '-' + iterations;

      let result;
      let usedStreaming = false;
      if (streamEnabled && typeof window.api.chatLLMStream === 'function') {
        // Streaming path: surface live tokens to the UI via stream-chunk events.
        // If streaming fails for any reason, fall back to non-streaming.
        this._activeStreamRequestId = reqId;
        if (this.onMessage) this.onMessage('stream-start', { requestId: reqId });
        try {
          result = await window.api.chatLLMStream(messages, {
            tools: tools.length > 0 ? tools : undefined,
            requestId: reqId
          });
          usedStreaming = true;
        } catch (streamErr) {
          // Streaming failed — fall back to non-streaming
          if (this.onMessage) this.onMessage('stream-end', { requestId: reqId, content: '', fallback: true });
          if (this.onMessage) this.onMessage('system', `流式请求失败，回退到普通模式：${streamErr.message || streamErr}`);
          result = await window.api.chatLLM(messages, {
            tools: tools.length > 0 ? tools : undefined,
            requestId: reqId + '-retry'
          });
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
          requestId: reqId
        });
      }

      if (this.stopped || runId !== this.runId) break;

      if (!result.ok) {
        if (this.onMessage) this.onMessage('error', result.error);
        break;
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
      this.contextManager.addAssistantMessage(assistantMsg.content, assistantMsg.tool_calls, assistantMsg.reasoning);

      // Emit assistant text — only in non-streaming mode (streaming path
      // already rendered tokens via stream-chunk/stream-end).
      if (!usedStreaming && assistantMsg.content) {
        if (this.onMessage) this.onMessage('assistant', assistantMsg.content);
      }

      // Handle tool calls
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (const tc of assistantMsg.tool_calls) {
          if (this.stopped || runId !== this.runId) break;

          const toolName = tc.function.name;
          let args;
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }

          if (toolName === '__reoptimizeToolSelection') {
            if (this.onToolCall) this.onToolCall(toolName, args, 'calling');
            const reasonText = typeof args?.reason === 'string' ? args.reason : '';
            const optimizeRes = await this.optimizeToolsForConversation(this.getLatestUserMessageText(), reasonText || '运行中重优化');
            const resultStr = JSON.stringify({
              ok: optimizeRes.ok !== false,
              selected: this.optimizedToolNames || [],
              reason: this.optimizedToolReason || reasonText || '重优化完成',
              allEnabled: this.getEnabledToolDefinitions().map(t => t.name)
            });
            this.contextManager.addToolResult(tc.id, toolName, resultStr);
            if (this.onToolCall) this.onToolCall(toolName, args, 'done', JSON.parse(resultStr));
            continue;
          }

          if (toolName === '__disableAutoOptimize') {
            if (this.onToolCall) this.onToolCall(toolName, args, 'calling');
            this.sessionAutoOptimizeDisabled = true;
            this.optimizedToolNames = null; // 清除优化结果，恢复全部工具
            this.contextManager.setSystemPrompt(this.getSystemPrompt());
            const resultStr = JSON.stringify({
              ok: true,
              message: '已在本会话中禁用自动工具选择优化，所有已启用工具现在都可用。',
              allEnabled: this.getEnabledToolDefinitions().map(t => t.name)
            });
            this.contextManager.addToolResult(tc.id, toolName, resultStr);
            if (this.onToolCall) this.onToolCall(toolName, args, 'done', JSON.parse(resultStr));
            continue;
          }

          if (this.onToolCall) this.onToolCall(toolName, args, 'calling');
          // 通知 UI（Code 模式用于显示工具调用卡片）
          if (this.onMessage) this.onMessage('tool_call', { name: toolName, args });

          // Check if sensitive
          const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
          const isSensitive = toolDef?.sensitive && !this.settings.autoApproveSensitive;

          // Extra check for terminal commands
          let needsApproval = isSensitive;
          if (toolName === 'runTerminalCommand' || toolName === 'awaitTerminalCommand' || toolName === 'runShellScriptCode') {
            const cmd = args.command || args.script || '';
            if (this.isDangerousCommand(cmd)) needsApproval = true;
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
              if (this.onToolCall) this.onToolCall(toolName, args, 'denied');
              continue;
            }
          }

          const toolResult = await this.executeTool(toolName, args);
          if (this.stopped || runId !== this.runId) break;

          // 通知 UI 工具执行结果
          if (this.onMessage) this.onMessage('tool-result', { name: toolName, result: toolResult });

          const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

          // 小文件不截断：Code Agent 常需读取完整源代码，3000字符阈值会把小文件也截断。
          // 仅对大结果截断，且阈值提高到 20000，保留前 18000 + 尾部 2000（保留文件开头和结尾）。
          let truncated = resultStr;
          if (resultStr.length > 20000) {
            const head = resultStr.substring(0, 18000);
            const tail = resultStr.substring(resultStr.length - 2000);
            truncated = `${head}\n\n...[中间部分已截断，共${resultStr.length}字符]...\n\n${tail}`;
          }
          this.contextManager.addToolResult(tc.id, toolName, truncated);

          if (this.onToolCall) this.onToolCall(toolName, args, 'done', toolResult);
        }

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
  }

  async executeTool(name, args) {
    try {
      const normalizeOk = (result, key = 'result') => {
        if (result && typeof result === 'object' && result.ok !== undefined) return result;
        if (key) return { ok: true, [key]: result };
        return { ok: true, result };
      };
      if (this.settings?.tools && this.settings.tools[name] === false) {
        if (this.settings?.autoOptimizeToolSelection && !name.startsWith('__')) {
          await this.optimizeToolsForConversation(this.getLatestUserMessageText(), `工具 ${name} 被禁用，需要重优化`);
        }
        return { ok: false, error: '该工具已禁用' };
      }
      switch (name) {
        case 'getTarot': {
          const card = await window.api.drawTarot();
          return { ok: true, card };
        }
        case 'todoList': return this.handleTodo(args);
        case 'runSubAgent': return await this.runSubAgent(args);
        case 'generateImage': {
          if (!this.workspacePath) {
            return { ok: false, error: '未设置工作区路径' };
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
        case 'localSearch': return await window.api.localSearch(args.directory, args.pattern, args.options || {});
        case 'readFile': {
          const pathStr = args.path || '';
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
            return { ok: true, content: imported.content, images: imported.images, convertedPath };
          }
          return await window.api.readFile(pathStr);
        }
        case 'editFile': return await window.api.writeFile(args.path, args.content);
        case 'createFile': return await window.api.createFile(args.path, args.content || '');
        case 'deleteFile': return await window.api.deleteFile(args.path);
        case 'moveFile': return await window.api.moveFile(args.source, args.destination);
        case 'copyFile': return await window.api.copyFile(args.source, args.destination);
        case 'listDirectory': return await window.api.listDirectory(args.path);
        case 'makeDirectory': return await window.api.makeDirectory(args.path);
        case 'deleteDirectory': return await window.api.deleteDirectory(args.path);
        case 'runJavaScriptCode': return await window.api.runJS(args.code);
        case 'runNodeJavaScriptCode': return await window.api.runNodeJS(args.code);
        case 'runShellScriptCode': return await window.api.runShell(args.script);
        case 'makeTerminal': {
          // 传入工作目录：Chat 模式用 workspacePath，Code 模式用 codeWorkspacePath
          const cwd = this.mode === 'code' ? (this.codeWorkspacePath || this.workspacePath) : this.workspacePath;
          const result = await window.api.makeTerminal(cwd);
          if (result.ok) this.terminals.set(result.terminalId, true);
          return result;
        }
        case 'runTerminalCommand': return await window.api.runTerminalCommand(args.terminalId, args.command);
        case 'awaitTerminalCommand': return await window.api.awaitTerminalCommand(args.terminalId, args.command);
        case 'killTerminal': {
          this.terminals.delete(args.terminalId);
          return await window.api.killTerminal(args.terminalId);
        }
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
          const ocrResult = await window.api.ocrRecognize(args.imagePath || args.path);
          return ocrResult;
        }
        case 'scanQRCode': {
          return await window.api.qrScan(args.imagePath || args.path);
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
          const result = await window.api.openFileExplorer(args.path);
          return result.ok !== undefined ? result : { ok: true };
        }
        case 'manageContext': return this.contextManager.manage(args.action, args);
        case 'autoSummarizeContext': {
          // Use the new LLM summary path; falls back to mechanical on failure.
          const sumRes = await this.contextManager.summarizeWithLLM({ keepLast: args.keepLast || 6 });
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
          const res = await window.api.createSkill({ name: args.name, description: args.description, prompt: args.prompt });
          await this.refreshSkillsCatalog();
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          return normalizeOk(res, 'skill');
        }
        case 'updateSkill': {
          const res = await window.api.updateSkill(args.id, { name: args.name, description: args.description, prompt: args.prompt });
          await this.refreshSkillsCatalog();
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          return normalizeOk(res, 'skill');
        }
        case 'runSkillScript': {
          await this.refreshSkillsCatalog();
          const skillId = String(args.skillId || '').trim();
          const scriptName = String(args.scriptName || '').trim();
          const skill = this.skillsCatalog.find(s => String(s?.id) === skillId);
          if (!skill) return { ok: false, error: '技能不存在，请先调用listSkills确认skillId' };
          const scriptList = Array.isArray(skill?.scripts) ? skill.scripts : [];
          const scriptItem = scriptList.find(item => {
            const nameText = String(item?.name || item || '');
            return nameText === scriptName;
          });
          const scriptPath = String(scriptItem?.path || scriptItem || '');
          if (!scriptPath || !scriptPath.toLowerCase().endsWith('.js')) {
            return { ok: false, error: '仅支持运行 .js 技能脚本' };
          }
          const readRes = await window.api.readFile(scriptPath);
          if (!readRes?.ok) return readRes;
          // Choose runtime: 'node' for scripts needing require/fs/path/Buffer; 'browser' for sandboxed pure JS.
          // Skill script entries may declare runtime explicitly; otherwise infer from script content.
          const code = readRes.content || '';
          const declaredRuntime = String(scriptItem?.runtime || '').toLowerCase();
          const needsNode = declaredRuntime === 'node'
            || (!declaredRuntime && /\brequire\s*\(|\bprocess\.\b|\bfs\.\b|\bpath\.\b|\bBuffer\b|__dirname|__filename|\bimport\s+/.test(code));
          const runRes = needsNode
            ? await window.api.runNodeJS(code)
            : await window.api.runJS(code);
          return normalizeOk(runRes);
        }
        case 'activateSkill': {
          // Inject a skill's prompt into the system context.
          await this.refreshSkillsCatalog();
          const skillId = String(args.skillId || '').trim();
          const skill = this.skillsCatalog.find(s => String(s?.id) === skillId);
          if (!skill) return { ok: false, error: '技能不存在' };
          if (!skill.prompt) return { ok: false, error: '该技能没有 prompt 内容' };
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
            this.activeSkills = this.activeSkills.filter(s => s.id !== skillId);
            this.contextManager.setSystemPrompt(this.getSystemPrompt());
            return { ok: true, message: '技能已停用' };
          }
          return { ok: true, message: '无激活技能' };
        }
        case 'initGeogebra': {
          return await window.api.geogebraInit(args.appName || 'classic');
        }
        case 'runGeogebraCommand': {
          return await window.api.geogebraEvalCommand(args.command);
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
            return { ok: false, error: '未设置工作区路径' };
          }
          return window.exportCanvasSVG ? window.exportCanvasSVG(args.filename || 'canvas.svg', this.workspacePath) : { ok: false, error: '画布功能未初始化' };
        }
        case 'askQuestions': {
          const answers = await window.askQuestions(args.questions);
          return { ok: true, answers };
        }
        case 'downloadFile': {
          if (!this.workspacePath) {
            return { ok: false, error: '未设置工作区路径' };
          }
          return await window.api.downloadFile(args.url, args.filename, this.workspacePath);
        }
        // ---- 游戏工具 ----
        case 'inviteGame': {
          // Web控制模式下拒绝游戏
          if (this._fromWeb) {
            return { ok: false, error: '独立窗口小游戏在Web控制模式下不可用，请在主机上操作' };
          }
          const invitation = await window.showGameInvitation(args.game, args.message, args.suggestedAgents);
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
        // ---- Office工具 ----
        case 'officeUnpack':
          return await window.api.officeUnpack(args.path);
        case 'officeListContents':
          return await window.api.officeListContents(args.dir);
        case 'officeReadInnerFile':
          return await window.api.readFile(args.path);
        case 'officeWriteInnerFile':
          return await window.api.writeFile(args.path, args.content);
        case 'officeRepack':
          return await window.api.officeRepack(args.dir, args.outputPath);
        case 'officeGetSlideTexts':
          return await window.api.officeGetSlideTexts(args.dir, args.slideFile);
        case 'officeSetSlideTexts':
          return await window.api.officeSetSlideTexts(args.dir, args.slideFile, args.translations);
        case 'officeWordExtract':
          return await window.api.officeWordExtract(args.pathOrDir, { includeEmpty: args.includeEmpty });
        case 'officeWordApplyTexts':
          return await window.api.officeWordApplyTexts(args.pathOrDir, args.updates || []);
        case 'officeWordGetStyles':
          return await window.api.officeWordGetStyles(args.pathOrDir);
        case 'officeWordFillTemplate':
          return await window.api.officeWordFillTemplate(args.pathOrDir, args.replacements || {});
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
          if (!navUrl) return { ok: false, error: 'browserNavigate 缺少 url 参数' };
          const r = await window.api.browserNavigate(navUrl);
          if (r?.ok && window.showBrowserPanel) window.showBrowserPanel();
          return r;
        }
        case 'browserScreenshot':
          return await window.api.browserScreenshot();
        case 'browserClick':
          return await window.api.browserClick(args.selector);
        case 'browserType':
          return await window.api.browserType(args.selector, args.text, args.submit);
        case 'browserGetContent':
          return await window.api.browserGetContent(args.selector);
        case 'browserScroll':
          return await window.api.browserScroll(args.direction, args.amount);
        case 'browserBack':
          return await window.api.browserBack();
        case 'browserClose': {
          const r = await window.api.browserClose();
          if (window.hideBrowserPanel) window.hideBrowserPanel();
          return r;
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
          const ms = Math.min(Math.max(parseInt(args.ms) || 1000, 1), 60000);
          await new Promise(resolve => setTimeout(resolve, ms));
          return { ok: true, slept: ms };
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
          return { ok: false, error: `未知工具: ${name}` };
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
        return { ok: false, error: '未找到该待办事项' };
      case 'list':
        return { ok: true, items: this.todoItems };
      default:
        return { ok: false, error: '未知操作' };
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
      if (!task) return { ok: false, error: 'task 不能为空' };

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
      const maxIter = Math.min(Math.max(parseInt(args.maxIterations) || 10, 1), 30);

      // Create isolated sub-agent
      const subAgent = new Agent();
      subAgent.settings = this.settings;
      subAgent.workspacePath = this.workspacePath;
      subAgent.systemInfo = this.systemInfo;
      subAgent.cachedWorkspaceTree = this.cachedWorkspaceTree;
      subAgent.tarotCard = await window.api.drawTarot();
      const maxCtx = this.settings?.llm?.maxContextLength || 8192;
      subAgent.contextManager = new ContextManager(maxCtx);
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
5. 最多 ${maxIter} 轮迭代，合理安排工作`
      );

      if (this.onMessage) this.onMessage('sub-agent-start', { task, tarot: subAgent.tarotCard });

      subAgent.contextManager.addUserMessage(task);
      subAgent.running = true;
      subAgent.stopped = false;

      // Forward sub-agent messages to parent's onMessage (prefixed)
      const parentOnMessage = this.onMessage;
      subAgent.onMessage = (type, data) => {
        if (!parentOnMessage) return;
        if (type === 'assistant') parentOnMessage('sub-agent-message', { task, content: data });
        else if (type === 'system') parentOnMessage('sub-agent-message', { task, content: `[系统] ${data}` });
      };
      subAgent.onToolCall = (name, a, status, result) => {
        if (this.onToolCall) this.onToolCall(name, a, status, result);
      };

      // Run a mini agent loop with the tool whitelist
      let iterations = 0;
      let finalContent = '';
      const subRunId = ++subAgent.runId;

      while (subAgent.running && !subAgent.stopped && iterations < maxIter && subRunId === subAgent.runId) {
        iterations++;
        const messages = subAgent.contextManager.getMessages();
        const allSchemas = getToolSchemas(this.settings?.tools);
        const subTools = allSchemas.filter(t => allowedSet.has(t.function?.name));

        const result = await window.api.chatLLM(messages, {
          tools: subTools.length > 0 ? subTools : undefined,
          requestId: 'sub-' + Date.now().toString()
        });

        if (!result.ok) {
          if (parentOnMessage) parentOnMessage('sub-agent-message', { task, content: `[错误] ${result.error}` });
          break;
        }
        const choice = result.data.choices?.[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        subAgent.contextManager.addAssistantMessage(assistantMsg.content, assistantMsg.tool_calls);

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
            subAgent.contextManager.addToolResult(tc.id, toolName, truncated);
            if (subAgent.onToolCall) subAgent.onToolCall(toolName, toolArgs, 'done', toolResult);
          }
          if (subAgent.stopped || subRunId !== subAgent.runId) break;
          continue; // let the agent process tool results
        }

        // No tool calls → done
        if (choice.finish_reason === 'stop') break;
      }

      subAgent.running = false;
      const response = finalContent || '子代理完成了任务但没有文本回复';
      if (this.onMessage) this.onMessage('sub-agent-done', { task, result: response });
      return { ok: true, result: response, iterations };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- Game System ----
  async launchGame(game, agentCount) {
    switch (game) {
      case 'flyingFlower': return await this.playFlyingFlower(agentCount);
      case 'sanguosha': return await this.playSanguosha(agentCount);
      case 'undercover': return await this.playUndercover(agentCount);
      default: return { ok: false, error: `未知游戏: ${game}` };
    }
  }

  async createGameAgent(name, buildPrompt) {
    const ga = new Agent();
    ga.settings = this.settings;
    ga.tarotCard = await window.api.drawTarot();
    ga.contextManager = new ContextManager(this.settings.llm.maxContextLength || 8192);
    // buildPrompt receives tarotCard so callers can embed it without referencing ga before init
    const systemPrompt = typeof buildPrompt === 'function' ? buildPrompt(ga.tarotCard) : buildPrompt;
    ga.contextManager.setSystemPrompt(systemPrompt);
    if (this.onMessage) this.onMessage('sub-agent-start', { task: `游戏玩家 ${name}`, tarot: ga.tarotCard });
    return ga;
  }

  async gameAgentRespond(ga, userMsg) {
    ga.contextManager.addUserMessage(userMsg);
    const messages = ga.contextManager.getMessages();
    const result = await window.api.chatLLM(messages, {
      temperature: 0.9,
      max_tokens: this.settings?.llm?.maxResponseTokens || 2048,
      requestId: Date.now().toString()
    });
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

  newConversation() {
    this.running = false;
    this.stopped = false;
    this.runId++;
    this.contextManager.clear();
    this.todoItems = [];
    this.todoIdCounter = 0;
    this.workspacePath = null;
    this.conversationId = null;
    this.conversationTitle = null;
    this.tarotCard = null; // Reset tarot card for new conversation
    this.resetOptimizedTools();
    if (this.onTitleChange) this.onTitleChange('未命名对话');
    if (this.onTodoUpdate) this.onTodoUpdate(this.todoItems);
    if (this.onStatusChange) this.onStatusChange('idle');
    // Re-init for new conversation
    this.init();
  }
}
