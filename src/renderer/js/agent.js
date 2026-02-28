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
  }

  getLocalDateTimeString() {
    const now = new Date();
    return now.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
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
  }

  getSystemPrompt() {
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
            return `${skill.name || '未命名技能'}: ${skill.description || '无描述'}${scriptsText}`;
          })
          .join('\n- ')}`
      : '';
    const optimizationGuidance = this.settings?.autoOptimizeToolSelection
      ? `\n\n【工具优化模式（必须遵守）】：
- 当前处于“工具精简”模式，你只会看到本轮优化后的工具。
- 如果你认为当前工具不足以完成任务，必须立即调用内部工具 __reoptimizeToolSelection 重新优化。
- 触发时机：出现“工具不可用/能力不足/需要新类别能力/多次尝试失败”任一情况就触发，不要硬撑。`
      : '';
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
- dnsLookup/ping/whois/checkSSLCert/traceroute/portScan：网络诊断与信息收集
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
${customPrompt ? '\n用户自定义提示词:\n' + customPrompt : ''}${toolListSection}${skillsSection}${optimizationGuidance}`;
  }

  resetOptimizedTools() {
    this.optimizedToolNames = null;
    this.optimizedToolReason = '';
    if (this.contextManager && this.settings) {
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
    }
  }

  getEnabledToolDefinitions() {
    const enabled = this.settings?.tools || {};
    return getAllToolDefinitions().filter(tool => enabled[tool.name] !== false);
  }

  hasUsableOptimizedSelection() {
    if (!this.settings?.autoOptimizeToolSelection) return false;
    if (!Array.isArray(this.optimizedToolNames)) return false;
    const enabledCount = this.getEnabledToolDefinitions().length;
    if (enabledCount === 0) return true;
    return this.optimizedToolNames.length > 0;
  }

  async refreshSkillsCatalog() {
    try {
      const skills = await window.api.listSkills();
      this.skillsCatalog = Array.isArray(skills) ? skills : [];
    } catch {
      this.skillsCatalog = [];
    }
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
    getAllToolDefinitions().forEach(tool => {
      enabledToolsMap[tool.name] = activeNames.has(tool.name);
    });
    const tools = getToolSchemas(enabledToolsMap);
    if (this.settings?.autoOptimizeToolSelection) {
      tools.push(INTERNAL_REOPTIMIZE_TOOL_SCHEMA);
    }
    return tools;
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
      { test: /dns|ping|whois|ssl|证书|端口|扫描|traceroute|路由|域名/i, categories: ['网络工具'] },
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

      return { tool, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.tool.name);
  }

  compactOptimizedSelection(selectedNames, enabledDefs, userMessage) {
    const enabledSet = new Set(enabledDefs.map(t => t.name));
    const enabledCount = enabledDefs.length;
    const dynamicCap = Math.max(6, Math.min(16, Math.ceil(enabledCount * 0.32)));
    const core = ['manageContext', 'askQuestions', 'todoList'];

    const heuristics = this.buildHeuristicToolCandidates(userMessage, enabledDefs);
    const merged = [];
    const pushUnique = (name) => {
      if (!name || !enabledSet.has(name)) return;
      if (!merged.includes(name)) merged.push(name);
    };

    core.forEach(pushUnique);
    selectedNames.forEach(pushUnique);
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
      const systemPrompt = [
        '你是工具选择优化器。',
        '请从给定候选工具中选择本次对话最可能需要的工具，以节省上下文。',
        '规则：',
        '1) 只能从候选工具中选；',
        '2) 优先覆盖用户目标所需能力，尽量精简；',
        '3) 优先选择 4-10 个工具，除非任务确实复杂；',
        '4) 若用户需求含“搜索/查找/资料/网页信息”，若选择了 webSearch，则必须同时选择 webFetch、offscreenRenderContent、offscreenRenderOCR 中至少一个（建议包含 webFetch + offscreenRenderContent）；',
        '5) 禁止只返回 webSearch 而没有任何内容抓取工具；',
        '6) 返回 JSON，格式：{"selected":["toolA","toolB"],"reason":"简短说明"}；',
        '7) 若不确定可返回稍多工具，但不要超过 12 个。'
      ].join('\n');
      const userPrompt = [
        reason ? `触发原因：${reason}` : '触发原因：首条消息优化',
        `用户消息：${firstUserMessage || ''}`,
        '候选工具列表：',
        candidates
      ].join('\n\n');
      const result = await window.api.chatLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.2, max_tokens: 400, requestId: Date.now().toString() });

      const content = result?.data?.choices?.[0]?.message?.content?.trim() || '';
      let parsed = null;
      try { parsed = JSON.parse(content); } catch {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch {}
        }
      }

      const validNames = new Set(enabledDefs.map(t => t.name));
      const selectedRaw = Array.isArray(parsed?.selected) ? parsed.selected : [];
      const selected = selectedRaw.filter(name => typeof name === 'string' && validNames.has(name));
      const compacted = this.compactOptimizedSelection(selected, enabledDefs, firstUserMessage);

      this.optimizedToolNames = compacted.length > 0 ? compacted : fallback;
      this.optimizedToolReason = typeof parsed?.reason === 'string' ? parsed.reason : (reason || '首条消息优化');
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
      return { ok: true, selected: this.optimizedToolNames, reason: this.optimizedToolReason };
    } catch (e) {
      this.optimizedToolNames = fallback;
      this.optimizedToolReason = '优化失败，回退到精简启发式工具集';
      this.contextManager.setSystemPrompt(this.getSystemPrompt());
      return { ok: false, error: e?.message || '优化失败', selected: fallback };
    } finally {
      if (this.onMessage) this.onMessage('optimize-tools-end');
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

    if (this.settings?.autoOptimizeToolSelection && !this.hasUsableOptimizedSelection()) {
      await this.optimizeToolsForConversation(fullMessage, '检测到优化未执行，发送前自动补偿优化');
    }

    await this.refreshSkillsCatalog();
    this.contextManager.setSystemPrompt(this.getSystemPrompt());

    this.contextManager.addUserMessage(fullMessage);

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
  }

  async saveToHistory() {
    if (!this.conversationId) return;
    try {
      await window.api.historySave({
        id: this.conversationId,
        title: this.conversationTitle || '未命名对话',
        messages: this.contextManager.messages,
        summaries: this.contextManager.summaries,
        tarotCard: this.tarotCard,
        workspacePath: this.workspacePath
      });
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
    this.contextManager.setSystemPrompt(this.getSystemPrompt());
    if (this.onTitleChange) this.onTitleChange(this.conversationTitle || '未命名对话');
  }

  async generateConversationTitle(userMessage) {
    try {
      const normalize = (text) => (text || '').replace(/[\s\r\n]+/g, ' ').trim();
      const stripPunct = (text) => (text || '').replace(/[\p{P}\p{S}\s]+/gu, '');
      const isTooSimilar = (title, source) => {
        const t = stripPunct(title);
        const s = stripPunct(source);
        if (!t || !s) return false;
        return s.includes(t) || t.includes(s) || t === s.slice(0, t.length);
      };
      const buildFallbackTitle = (text) => {
        const cleaned = normalize(text).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
        const segments = cleaned.split(/[，。！？、,.;:；：\n]+/).map(s => s.trim()).filter(Boolean);
        const stripLeading = (s) => s.replace(/^(请|帮我|麻烦|能否|可以|如何|怎么|需要|我要|想要|修复|实现|增加|优化|解决|改进|调整|删除|添加|生成|完善|修正|处理)+/g, '').trim();
        const picked = segments.map(stripLeading).filter(Boolean);
        let base = picked.slice(0, 2).join('、') || cleaned;
        base = base.replace(/\s+/g, '');
        if (base.length < 6) base = (base + '处理').slice(0, 12);
        return base.slice(0, 12);
      };

      const prompt = '你是标题生成专家。请为对话生成一个简洁、专业的中文标题（类似新闻标题或文章标题）。要求：\n1. 长度6-12个汉字\n2. 提炼主题，不要复述原句或直接复制用户输入\n3. 使用名词短语，避免冗长句子\n4. 不要使用引号、书名号等符号\n5. 直接返回标题，不要其他内容';
      const result = await window.api.chatLLM([
        { role: 'system', content: prompt },
        { role: 'user', content: normalize(userMessage) }
      ], { temperature: 0.2, max_tokens: 30, requestId: Date.now().toString() });
      const title = result?.data?.choices?.[0]?.message?.content?.trim();
      if (title) {
        // Remove quotes and other punctuation, trim to 12 chars
        const cleanedTitle = title.replace(/["「」『』《》""'']/g, '').replace(/\s+/g, ' ').trim().substring(0, 12);
        if (cleanedTitle && !isTooSimilar(cleanedTitle, userMessage)) return cleanedTitle;
        return buildFallbackTitle(userMessage);
      }
    } catch { /* ignore */ }
    return (userMessage ? userMessage : '未命名对话').replace(/\s+/g, ' ').substring(0, 12);
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
    const maxIterations = 30; // Safety limit

    while (this.running && !this.stopped && iterations < maxIterations && runId === this.runId) {
      iterations++;

      // Check if context needs management
      const stats = this.contextManager.getStats();
      if (parseFloat(stats.usage) > 70) {
        this.contextManager.manage('clear_tool_results');
      }
      if (parseFloat(stats.usage) > 85) {
        this.contextManager.manage('summarize', { keepLast: 6 });
      }

      // 热对话：注入用户在Agent工作期间发送的新消息
      while (this.hotMessages.length > 0) {
        const hotMsg = this.hotMessages.shift();
        this.contextManager.addUserMessage(`【用户追加消息】${hotMsg}`);
        if (this.onMessage) this.onMessage('system', '已将新消息注入当前对话');
      }

      if (this.settings?.autoOptimizeToolSelection && !this.hasUsableOptimizedSelection()) {
        await this.optimizeToolsForConversation(this.getLatestUserMessageText(), '循环检测到优化未执行，自动补偿优化');
      }

      const messages = this.contextManager.getMessages();
      const tools = this.getRuntimeToolSchemas();

      const result = await window.api.chatLLM(messages, { tools: tools.length > 0 ? tools : undefined, requestId: Date.now().toString() });

      if (this.stopped || runId !== this.runId) break;

      if (!result.ok) {
        if (this.onMessage) this.onMessage('error', result.error);
        break;
      }

      const choice = result.data.choices?.[0];
      if (!choice) break;

      const assistantMsg = choice.message;
      if (this.stopped || runId !== this.runId) break;
      this.contextManager.addAssistantMessage(assistantMsg.content, assistantMsg.tool_calls);

      // Emit assistant text
      if (assistantMsg.content) {
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

          if (this.onToolCall) this.onToolCall(toolName, args, 'calling');

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
          
          const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

          // Truncate very large results
          const truncated = resultStr.length > 3000 ? resultStr.substring(0, 3000) + '...[结果已截断]' : resultStr;
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
          const result = await window.api.makeTerminal();
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
          const prompt = '你是上下文整理器，请将以下对话上下文提炼为简洁、结构化的摘要，保留关键事实、目标、约束与未完成事项。仅返回摘要正文。';
          const context = this.contextManager.getMessages();
          const result = await window.api.chatLLM([
            { role: 'system', content: prompt },
            { role: 'user', content: JSON.stringify(context) }
          ], { temperature: 0.2, max_tokens: this.settings?.llm?.maxResponseTokens || 8192, requestId: Date.now().toString() });
          const summary = result?.data?.choices?.[0]?.message?.content?.trim();
          if (!summary) return { ok: false, error: '上下文摘要失败' };

          this.contextManager.clear();
          this.contextManager.setSystemPrompt(this.getSystemPrompt());
          this.contextManager.addMessage({ role: 'system', content: `[上下文摘要]\n${summary}` });
          return { ok: true, summary };
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
          const runRes = await window.api.runJS(readRes.content || '');
          return normalizeOk(runRes);
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
        case 'addFunctionToGeogebra':
        case 'updateFunctionInGeogebra': {
          return await window.api.geogebraEvalCommand(args.command || args.expression);
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
        case 'whois':
          return await window.api.whois(args.domain);
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
    try {
      // Create a sub-agent with its own context
      const subAgent = new Agent();
      subAgent.settings = this.settings;
      subAgent.tarotCard = await window.api.drawTarot();
      subAgent.contextManager = new ContextManager(this.settings.llm.maxContextLength || 8192);
      subAgent.contextManager.setSystemPrompt(
        `你是一个子代理Agent。你的任务是:\n${args.task}\n\n上下文信息:\n${args.context || '无额外上下文'}\n\n你的命运之牌是: ${subAgent.tarotCard.name}${subAgent.tarotCard.isReversed ? '(逆位)' : '(正位)'} - ${(subAgent.tarotCard.isReversed ? subAgent.tarotCard.meaningOfReversed : subAgent.tarotCard.meaningOfUpright) || ''}\n\n完成任务后，请给出简洁的结果报告。不要使用emoji。`
      );

      if (this.onMessage) this.onMessage('sub-agent-start', { task: args.task, tarot: subAgent.tarotCard });

      // Simplified sub-agent execution
      subAgent.contextManager.addUserMessage(args.task);
      const messages = subAgent.contextManager.getMessages();
      const tools = getToolSchemas(this.settings.tools);
      const result = await window.api.chatLLM(messages, { tools: tools.length > 0 ? tools : undefined });

      if (result.ok && result.data.choices?.[0]) {
        const response = result.data.choices[0].message.content || '子代理完成了任务但没有文本回复';
        if (this.onMessage) this.onMessage('sub-agent-done', { task: args.task, result: response });
        return { ok: true, result: response };
      }
      return { ok: false, error: result.error || '子代理执行失败' };
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
