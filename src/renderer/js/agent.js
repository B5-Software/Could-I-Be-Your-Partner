/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

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
    const ws = await window.api.workspaceCreate();
    if (ws.ok) this.workspacePath = ws.path;
    
    // 异步获取工作目录文件树
    if (this.workspacePath) {
      try {
        const treeResult = await window.api.workspaceGetFileTree(this.workspacePath);
        if (treeResult.ok) {
          this.cachedWorkspaceTree = treeResult.tree;
        }
      } catch { /* ignore */ }
    }
    
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
    const toolList = TOOL_DEFINITIONS
      .filter(tool => enabledTools[tool.name] !== false)
      .map(tool => `${tool.name}: ${tool.desc}`)
      .join('\n- ');
    const toolListSection = toolList ? `\n\n当前可用工具：\n- ${toolList}` : '';
    return `你是"Could I Be Your Partner"的AI Agent，你的名字叫${name}。${bio}
  当前对话标题：${convoTitle}
你的人称代词是：${pronouns}
你的性格：${personality}

你的命运之牌是: ${this.tarotCard ? `${this.tarotCard.name}${this.tarotCard.isReversed ? '(逆位)' : '(正位)'}(${this.tarotCard.nameEn}) - ${(this.tarotCard.isReversed ? this.tarotCard.meaningOfReversed : this.tarotCard.meaningOfUpright) || ''}` : '尚未抽取'}

当前用户信息：
- 用户名: ${username}
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
9. 用户上传Office/PDF文件时，已自动转换为.txt并保存到工作目录，请直接读取.txt文件

说话风格：
- 像朋友之间聊天一样自然亲切，多用语气词（呢、呀、啦、嘛、哦、嗯）
- 语气生动可爱，带有适当的情感表达
- 可以用"~"来表达轻松愉快的语气
- 回复要有温度有个性，不要太机械
- 复杂任务完成后可以表达一下小成就感

你使用简体中文回复。
请勿在回复中使用任何emoji表情符号。
${customPrompt ? '\n用户自定义提示词:\n' + customPrompt : ''}${toolListSection}`;
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
        if (a.ocrText) return `[附件: ${a.name}]\nOCR识别文本:\n${a.ocrText}`;
        if (a.extractedText) {
          const text = a.extractedText.length > 2000 ? a.extractedText.substring(0, 2000) + '\n...[已截断]' : a.extractedText;
          const converted = a.convertedPath ? `\n已转换文本路径: ${a.convertedPath}` : '';
          return `[文件附件: ${a.name}]${converted}\n提取文本:\n${text}`;
        }
        if (a.convertedPath) return `[文件附件: ${a.name}]\n已转换文本路径: ${a.convertedPath}`;
        if (a.isImage) return `[图片附件: ${a.name}, 路径: ${a.path}]`;
        return `[文件附件: ${a.name}, 路径: ${a.path}]`;
      }).join('\n');
      fullMessage = userMessage + '\n\n' + attachInfo;
    }

    this.contextManager.addUserMessage(fullMessage);

    // Save immediately after user message so history exists even before agent finishes
    this.saveToHistory();

    await this.agentLoop(runId);

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
    if (conversation.workspacePath) this.workspacePath = conversation.workspacePath;
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
    if (this.pendingApproval) this.resolveApproval(false);
    if (this.onStatusChange) this.onStatusChange('idle');
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

      const messages = this.contextManager.getMessages();
      const tools = getToolSchemas(this.settings.tools);

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
            const approved = await this.requestApproval(toolName, args);
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
        case 'webSearch': return await window.api.webSearch(args.query, this.workspacePath);
        case 'webFetch': return await window.api.webFetch(args.url);
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
        case 'listSkills': return normalizeOk(await window.api.listSkills(), 'skills');
        case 'makeSkill': return normalizeOk(await window.api.createSkill({ name: args.name, description: args.description, prompt: args.prompt }), 'skill');
        case 'updateSkill': return normalizeOk(await window.api.updateSkill(args.id, { name: args.name, description: args.description, prompt: args.prompt }), 'skill');
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
        default:
          return { ok: false, error: `未知工具: ${name}` };
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
    if (this.onTitleChange) this.onTitleChange('未命名对话');
    if (this.onTodoUpdate) this.onTodoUpdate(this.todoItems);
    if (this.onStatusChange) this.onStatusChange('idle');
    // Re-init for new conversation
    this.init();
  }
}
