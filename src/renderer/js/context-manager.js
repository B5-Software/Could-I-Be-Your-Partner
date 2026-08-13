/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Context Window Intelligent Manager
 * Three-layer compaction strategy inspired by claude-code-ref:
 *   1. MicroCompact — clear stale tool results (no API call)
 *   2. Session摘要   — LLM-based semantic summary (one API call)
 *   3. Hard truncate — emergency fallback (drop oldest)
 * Token estimation ratios (heuristic; tuned for mixed CJK + code).
 */

const TOKENS_PER_CJK_CHAR = 1.5;
const TOKENS_PER_OTHER_CHAR = 0.4;
const MESSAGE_OVERHEAD_TOKENS = 4;

// MicroCompact config
const MICROCOMPACT_KEEP_LAST = 4; // keep the last N tool results intact
const MICROCOMPACT_TRUNCATE_TO = 120; // truncate old tool results to this length

// Summary config
const SUMMARY_KEEP_LAST_DEFAULT = 6;
const SUMMARY_MAX_TRANSCRIPT_CHARS = 12000; // cap transcript fed to summarizer
const SUMMARY_MAX_TOOL_RESULT_CHARS = 600; // each tool result in transcript

class ContextManager {
  constructor(maxTokens = 8192) {
    this.maxTokens = maxTokens;
    this.outputReserve = 0; // 输出预留：为模型生成回复保留的 token 空间
    // 上下文管理器与历史记录解耦（参考 claude-code-ref 的 transcript/context 边界设计）：
    //   - messages: 工作上下文（可被压缩/截断/清理），仅供 LLM 调用使用
    //   - historyMessages: 完整历史记录（transcript，append-only，永不破坏）
    //   两个数组共享消息对象引用，但上下文管理器的所有修改都采用
    //   "replace-not-mutate" 模式（替换数组元素而非原地修改字段），
    //   从而保证 historyMessages 中的原始消息对象永远不被破坏。
    this.messages = [];
    this.historyMessages = [];
    this.pinnedMessages = []; // Important messages that should not be removed
    this.systemPrompt = null;
    this.summaries = []; // Compressed history summaries
    this.compactBoundaries = []; // CompactBoundary tracking
    this._msgTokenCache = new WeakMap(); // 消息对象 -> token 估算值（避免重复全量正则扫描）
  }

  setMaxTokens(max) {
    this.maxTokens = max;
  }

  // 设置输出预留（模型生成回复需要保留的空间），
  // 用于触发器和 lightTrim 判断：占用 = 当前输入 + 输出预留
  setOutputReserve(reserve) {
    this.outputReserve = Math.max(0, Number(reserve) || 0);
  }

  setSystemPrompt(prompt) {
    this.systemPrompt = { role: 'system', content: prompt };
  }

  estimateTokens(text) {
    if (!text) return 0;
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const otherCount = text.length - cjkCount;
    return Math.ceil(cjkCount * TOKENS_PER_CJK_CHAR + otherCount * TOKENS_PER_OTHER_CHAR);
  }

  estimateMessageTokens(msg) {
    let tokens = MESSAGE_OVERHEAD_TOKENS;
    tokens += this.estimateTokens(msg.role);
    if (typeof msg.content === 'string') {
      tokens += this.estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      // 多模态 content 数组：文本部分正常估算，图片部分按固定 token 计（与 OpenAI vision 估算一致）
      for (const part of msg.content) {
        if (part.type === 'text') tokens += this.estimateTokens(part.text || '');
        else if (part.type === 'image_url') tokens += 765; // 图片 token 估算（detail:auto ≈ 765 tokens）
      }
    }
    if (msg.tool_calls) {
      tokens += this.estimateTokens(JSON.stringify(msg.tool_calls));
    }
    return tokens;
  }

  getTotalTokens() {
    let total = 0;
    if (this.systemPrompt) total += this.estimateMessageTokens(this.systemPrompt);
    for (const msg of this.messages) {
      total += this.estimateMessageTokens(msg);
    }
    return total;
  }

  addMessage(msg) {
    // 同时追加到上下文与历史记录（共享引用）。
    // 历史记录不会被任何压缩/清理操作破坏（参见 lightTrim/microCompact/sanitize
    // 均采用 replace-not-mutate 模式）。
    this.messages.push(msg);
    this.historyMessages.push(msg);
    // Sync lightweight trim — only runs strategy 1 (truncate long tool results).
    // Heavy LLM-based summarization is invoked explicitly via summarizeWithLLM().
    this.lightTrim();
  }

  /**
   * 从历史会话加载消息（同时初始化上下文与历史记录）。
   * 两个数组共享 conv.messages 的对象引用——上下文管理器后续的修改
   * 会用 replace-not-mutate 模式替换 messages[i]，不会影响 historyMessages[i]。
   *
   * 注意：不恢复 summaries/compactBoundaries——历史记录是完整 transcript，
   * 上下文管理器会在下次 agentLoop 中按需重新压缩。这样可以避免
   * "完整 transcript + 旧摘要" 导致上下文溢出。
   * @param {Array} messages 历史消息数组
   */
  loadFromHistory(messages) {
    const arr = Array.isArray(messages) ? messages : [];
    this.messages = arr.slice(); // 浅拷贝：避免上下文 slice() 影响入参
    this.historyMessages = arr.slice(); // 历史记录独立持有一份引用
    this.pinnedMessages = [];
    this.summaries = []; // 清空：上下文管理器会按需重新压缩
    this.compactBoundaries = [];
  }

  /**
   * 获取完整历史记录（transcript），用于持久化保存。
   * 返回的是 historyMessages 的浅拷贝，调用方可安全序列化。
   */
  getHistoryMessages() {
    return this.historyMessages.slice();
  }

  addUserMessage(content) {
    this.addMessage({ role: 'user', content });
  }

  addAssistantMessage(content, toolCalls, reasoning) {
    const msg = { role: 'assistant', content: content || '' };
    if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
    if (reasoning) msg.reasoning = reasoning;
    this.addMessage(msg);
  }

  /**
   * 添加系统消息到上下文（用于保存错误提示、子代理摘要、审批决策等可见内容）
   * 系统消息不会被 LLM 直接读取（取决于 provider 实现），但会保存到历史记录中
   * 以便用户重新加载历史时能看到完整的对话上下文。
   */
  addSystemMessage(content, metadata) {
    const msg = { role: 'system', content };
    if (metadata && typeof metadata === 'object') {
      msg.metadata = metadata;
    }
    this.addMessage(msg);
  }

  addToolResult(toolCallId, name, result) {
    this.addMessage({ role: 'tool', tool_call_id: toolCallId, name, content: typeof result === 'string' ? result : JSON.stringify(result) });
  }

  /**
   * 添加多模态工具结果：文本 + 图片（OpenAI vision format content array）
   * 用于 readImageFile 等工具，将图片直接注入上下文而非返回 base64 字符串。
   */
  addMultimodalToolResult(toolCallId, name, textContent, imageUrl) {
    // OpenAI/Anthropic 规范：tool 消息 content 必须是字符串，
    // 多模态 image_url 只能放在 user 消息中。
    // 因此先添加 tool 消息（文字结果），再追加一条 user 消息（图片）。
    // 参考: https://platform.openai.com/docs/guides/vision
    this.addMessage({ role: 'tool', tool_call_id: toolCallId, name, content: textContent });
    this.addMessage({
      role: 'user',
      content: [
        { type: 'text', text: `[系统注入：${name} 工具返回的图片，请结合上文工具调用查看]` },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    });
  }

  pinMessage(index) {
    if (index >= 0 && index < this.messages.length) {
      this.pinnedMessages.push(index);
    }
  }

  /**
   * Lightweight synchronous trim: truncate long tool results.
   * Called on every addMessage. Does NOT call LLM.
   * 阈值纳入输出预留：占用 = 当前输入 + 输出预留，避免挤压输出空间。
   *
   * 采用 replace-not-mutate 模式：替换 messages[i] 为克隆对象，
   * 而非原地修改 msg.content。这样共享同一引用的 historyMessages[i]
   * 不会被破坏。
   */
  lightTrim() {
    const threshold = this.maxTokens * 0.85;
    if (this.getTotalTokens() + this.outputReserve <= threshold) return;
    for (let i = 0; i < this.messages.length; i++) {
      if (this.pinnedMessages.includes(i)) continue;
      const msg = this.messages[i];
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 500) {
        // 替换数组元素为克隆，不修改原对象
        this.messages[i] = { ...msg, content: msg.content.substring(0, 300) + '\n...[内容已截断]' };
      }
    }
  }

  /**
   * MicroCompact — clear stale tool results beyond a sliding window.
   * No API call. Replaces the old >70% "clear_tool_results" strategy.
   * Returns the count of cleared tool results.
   *
   * 采用 replace-not-mutate：替换 messages[idx] 为克隆对象，
   * 不修改原对象（保护 historyMessages 中的引用）。
   */
  microCompact(keepLast = MICROCOMPACT_KEEP_LAST) {
    let cleared = 0;
    const toolIndices = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === 'tool') toolIndices.push(i);
    }
    const cutoff = toolIndices.length - keepLast;
    for (let i = 0; i < toolIndices.length; i++) {
      if (i < cutoff) {
        const idx = toolIndices[i];
        if (this.pinnedMessages.includes(idx)) continue;
        const msg = this.messages[idx];
        if (typeof msg.content === 'string' && msg.content.length > MICROCOMPACT_TRUNCATE_TO) {
          // 替换为克隆，不修改原对象
          this.messages[idx] = { ...msg, content: '[旧工具结果已清理，详见对话历史]' };
          cleared++;
        } else if (Array.isArray(msg.content)) {
          // 多模态工具结果：清理为文本提示
          this.messages[idx] = { ...msg, content: '[旧工具结果已清理（含图片），详见对话历史]' };
          cleared++;
        }
      }
    }
    if (cleared > 0) {
      this.compactBoundaries.push({
        timestamp: Date.now(),
        type: 'micro',
        clearedToolResults: cleared
      });
    }
    return cleared;
  }

  /**
   * Build a transcript string from a list of messages for the summarizer.
   */
  _buildTranscript(messages) {
    let totalChars = 0;
    const parts = [];
    for (const m of messages) {
      let line = '';
      if (m.role === 'user') {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        line = `用户: ${c}`;
      } else if (m.role === 'assistant') {
        const tools = m.tool_calls?.length
          ? ` [调用工具: ${m.tool_calls.map(t => t.function?.name).join(', ')}]`
          : '';
        line = `助手: ${m.content || ''}${tools}`;
      } else if (m.role === 'tool') {
        let c = '';
        if (typeof m.content === 'string') c = m.content;
        else if (Array.isArray(m.content)) {
          // 多模态工具结果：提取文本部分，忽略图片部分
          c = m.content.filter(p => p.type === 'text').map(p => p.text || '').join(' ');
          c = c + ' [含图片内容]';
        }
        const trimmed = c.length > SUMMARY_MAX_TOOL_RESULT_CHARS
          ? c.substring(0, SUMMARY_MAX_TOOL_RESULT_CHARS) + '...[截断]'
          : c;
        line = `工具${m.name ? '(' + m.name + ')' : ''}结果: ${trimmed}`;
      }
      if (line) {
        totalChars += line.length;
        if (totalChars > SUMMARY_MAX_TRANSCRIPT_CHARS) {
          parts.push('...[transcript truncated for summarizer]');
          break;
        }
        parts.push(line);
      }
    }
    return parts.join('\n\n');
  }

  /**
   * Mechanical fallback summary (no LLM). Used when LLM summary fails or is unavailable.
   */
  generateSummary(rounds) {
    let summary = '';
    for (const round of rounds) {
      for (const idx of round) {
        const msg = this.messages[idx];
        if (!msg) continue;
        if (msg.role === 'user') {
          const c = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? '[多模态内容]' : '');
          summary += `用户: ${c.substring(0, 100)}\n`;
        } else if (msg.role === 'assistant' && msg.content) {
          const c = typeof msg.content === 'string' ? msg.content : '';
          summary += `助手: ${c.substring(0, 100)}\n`;
        }
      }
    }
    return summary ? `[历史摘要]\n${summary}` : null;
  }

  /**
   * LLM-based semantic summarization.
   * Replaces the old mechanical generateSummary for compaction.
   * Falls back to generateSummary on LLM failure.
   *
   * @returns {Promise<{ok: boolean, message: string, summary?: string, fallback?: boolean, skipped?: boolean}>}
   */
  async summarizeWithLLM(options = {}) {
    const keepLast = options.keepLast ?? SUMMARY_KEEP_LAST_DEFAULT;
    if (this.messages.length <= keepLast) {
      return { ok: true, message: '消息数量不足，无需摘要', skipped: true };
    }

    const messagesToSummarize = this.messages.slice(0, this.messages.length - keepLast);
    const transcript = this._buildTranscript(messagesToSummarize);
    if (!transcript.trim()) {
      return { ok: true, message: '无内容可摘要', skipped: true };
    }

    const summaryMessages = [
      {
        role: 'system',
        content: '你是一个对话摘要助手。请将以下对话历史压缩为简洁的语义摘要，保留：\n1) 用户的核心需求和约束\n2) 已完成的关键决策和结果\n3) 未解决的问题与待办\n4) 重要上下文（文件路径、配置值、关键参数等）\n\n要求：\n- 不要逐条罗列消息，要提炼成连贯的摘要\n- 控制在 500 字以内\n- 用中文输出'
      },
      { role: 'user', content: transcript }
    ];

    let result;
    try {
      result = await window.api.summarizeLLM(summaryMessages, {
        max_tokens: 1024,
        temperature: 0.3,
        sessionKey: options.sessionKey || null
      });
    } catch (e) {
      // LLM call threw — fall back to mechanical summary
      const fb = this.generateSummary([messagesToSummarize.map((_, i) => i)]);
      if (fb) {
        this.summaries.push(fb);
        this.messages = this.messages.slice(-keepLast);
        this.compactBoundaries.push({
          timestamp: Date.now(), type: 'fallback_summary',
          summarizedCount: messagesToSummarize.length, error: e.message
        });
      }
      return { ok: false, message: 'LLM 摘要调用异常，已降级为机械摘要', fallback: true, error: e.message };
    }

    if (!result.ok) {
      // LLM call failed — fall back to mechanical summary
      const fb = this.generateSummary([messagesToSummarize.map((_, i) => i)]);
      if (fb) {
        this.summaries.push(fb);
        this.messages = this.messages.slice(-keepLast);
        this.compactBoundaries.push({
          timestamp: Date.now(), type: 'fallback_summary',
          summarizedCount: messagesToSummarize.length, error: result.error
        });
      }
      return { ok: false, message: 'LLM 摘要失败：' + (result.error || '未知错误') + '，已降级为机械摘要', fallback: true, error: result.error };
    }

    const summary = (result.content || '').trim();
    if (!summary) {
      return { ok: false, message: '摘要内容为空', skipped: true };
    }

    const timestamp = new Date().toLocaleString('zh-CN');
    this.summaries.push(`[语义摘要 ${timestamp}]\n${summary}`);
    this.messages = this.messages.slice(-keepLast);
    this.compactBoundaries.push({
      timestamp: Date.now(), type: 'llm_summary',
      summarizedCount: messagesToSummarize.length
    });
    return { ok: true, message: '已通过 LLM 生成语义摘要', summary };
  }

  // manageContext tool handler — synchronous actions only.
  // For LLM-based summarization, use summarizeWithLLM() instead.
  manage(action, options = {}) {
    switch (action) {
      case 'summarize': {
        // Sync mechanical fallback (caller should prefer summarizeWithLLM)
        const summary = this.generateSummary([this.messages.map((_, i) => i).slice(0, -3)]);
        if (summary) {
          this.summaries.push(summary);
          const keepCount = options.keepLast || 4;
          this.messages = this.messages.slice(-keepCount);
        }
        return { ok: true, message: '上下文已机械摘要压缩（建议使用 LLM 语义摘要）' };
      }
      case 'clear_old': {
        const keepCount = options.keepLast || 6;
        if (this.messages.length > keepCount) {
          const removed = this.messages.length - keepCount;
          this.messages = this.messages.slice(-keepCount);
          return { ok: true, message: `已清除${removed}条旧消息` };
        }
        return { ok: true, message: '无需清理' };
      }
      case 'clear_tool_results': {
        // Delegate to microCompact for consistent behavior
        const cleared = this.microCompact();
        return { ok: true, message: `已清理${cleared}条旧工具结果` };
      }
      case 'micro_compact': {
        const cleared = this.microCompact(options.keepLast);
        return { ok: true, message: `MicroCompact: 清理${cleared}条旧工具结果` };
      }
      case 'keep_essential': {
        this.messages = this.messages.filter((msg, i) =>
          msg.role === 'user' || msg.role === 'system' ||
          (msg.role === 'assistant' && msg.content) ||
          i >= this.messages.length - 3
        );
        return { ok: true, message: '已保留必要消息' };
      }
      default:
        return { ok: false, message: '未知操作' };
    }
  }

  // Get messages for API call
  getMessages() {
    const result = [];
    if (this.systemPrompt) result.push(this.systemPrompt);

    // Add summaries as system context
    if (this.summaries.length > 0) {
      result.push({
        role: 'system',
        content: '以下是之前对话的摘要:\n' + this.summaries.slice(-3).join('\n---\n')
      });
    }

    result.push(...this.messages);
    return result;
  }

  // Get the timestamp of the last compact boundary (or 0 if none)
  getLastCompactTime() {
    if (this.compactBoundaries.length === 0) return 0;
    return this.compactBoundaries[this.compactBoundaries.length - 1].timestamp;
  }

  // Get current stats
  getStats() {
    const tokens = this.getTotalTokens();
    const maxTokens = this.maxTokens || 1;
    const usage = ((tokens / maxTokens) * 100).toFixed(1);
    // 含输出预留的占用：当前输入 + 输出预留，分母为完整上下文窗口
    const occupied = tokens + this.outputReserve;
    const usageWithReserve = Math.min(100, (occupied / maxTokens) * 100).toFixed(1);
    return {
      tokens,
      maxTokens,
      usage,
      outputReserve: this.outputReserve,
      occupied,
      usageWithReserve,
      totalMessages: this.messages.length,
      summaries: this.summaries.length,
      compactions: this.compactBoundaries.length
    };
  }

  clear() {
    this.messages = [];
    this.historyMessages = [];
    this.pinnedMessages = [];
    this.summaries = [];
    this.compactBoundaries = [];
  }

  /**
   * 清理上下文中可能导致 API 400（请求不合法）的损坏消息。
   * 常见损坏场景（中断 Agent 时产生）：
   *   1. 末尾是空 assistant 消息（content 为空字符串且无 tool_calls）
   *   2. assistant 的 tool_calls 缺少对应 tool 结果消息（tool_call_id 未匹配）
   *   3. tool 消息找不到对应 assistant.tool_calls（孤儿 tool 结果）
   *   4. 消息 content 为 null/undefined（应为字符串）
   *   5. 空字符串 content 的 user/assistant 消息
   *   6. tool_calls 中 arguments 为非字符串（应为 JSON 字符串）
   *
   * 本方法保持幂等：多次调用结果一致。不会删除用户消息和摘要。
   * 返回 { fixed: boolean, removedCount, details } 用于日志展示。
   */
  sanitize() {
    let removedCount = 0;
    const details = [];
    const before = this.messages.length;

    // 第一遍：规范化字段类型（不删除，仅修正非法值）
    // 采用 replace-not-mutate：替换 messages[i] 为克隆对象，
    // 不修改原对象（保护 historyMessages 中的引用）。
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      let clone = null;
      // content 必须是字符串或合法数组；null/undefined → ''
      if (msg.content === null || msg.content === undefined) {
        clone = { ...msg, content: '' };
        details.push('修正空 content');
      }
      // tool_calls.arguments 必须是字符串；缺失 id/type 需补全
      if (Array.isArray(msg.tool_calls)) {
        let tcChanged = false;
        const newToolCalls = msg.tool_calls.map(tc => {
          if (!tc || !tc.function) return tc;
          let newTc = tc;
          let newFunc = tc.function;
          if (typeof newFunc.arguments !== 'string') {
            try { newFunc = { ...newFunc, arguments: JSON.stringify(newFunc.arguments ?? {}) }; }
            catch { newFunc = { ...newFunc, arguments: '{}' }; }
            newTc = { ...tc, function: newFunc };
            tcChanged = true;
            details.push('修正 tool_calls.arguments 类型');
          }
          if (!tc.id) { newTc = { ...newTc, id: 'call_' + Math.random().toString(36).slice(2, 10) }; tcChanged = true; }
          if (!tc.type) { newTc = { ...newTc, type: 'function' }; tcChanged = true; }
          return newTc;
        });
        if (tcChanged) {
          clone = clone ? { ...clone, tool_calls: newToolCalls } : { ...msg, tool_calls: newToolCalls };
        }
      }
      // tool 消息必须要有 tool_call_id
      if (msg.role === 'tool' && !msg.tool_call_id) {
        clone = clone ? { ...clone, tool_call_id: 'orphan_' + Math.random().toString(36).slice(2, 10) }
                      : { ...msg, tool_call_id: 'orphan_' + Math.random().toString(36).slice(2, 10) };
        details.push('补充 tool.tool_call_id');
      }
      if (clone) this.messages[i] = clone;
    }

    // 第二遍：从末尾向前删除「空尾消息」（中断时残留的空 assistant）
    // 只删除连续的尾部空 assistant（content='' 且无 tool_calls）
    while (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1];
      if (last.role === 'assistant' && (last.content === '' || last.content == null) &&
          (!last.tool_calls || last.tool_calls.length === 0)) {
        this.messages.pop();
        removedCount++;
        details.push('删除尾部空 assistant');
      } else {
        break;
      }
    }

    // 第三遍：循环修复 assistant.tool_calls 与 tool 消息的配对关系
    // 规则（严格，修复 "Messages with role 'tool' must be a response to a
    //       preceding message with 'tool_calls'" 错误）：
    //   1. 每个 tool 消息必须在其之前的某条 assistant.tool_calls 中找到 id（顺序检查！）
    //   2. 每个 assistant.tool_calls[i].id 必须在其之后有恰好一条 tool 消息对应
    //   3. 同一 tool_call_id 的 tool 消息只保留第一条（去重）
    //   4. assistant 的 tool_calls 部分缺失结果时，为缺失项补全占位 tool 结果
    //      （而不是删除整个 assistant，保留有效内容）
    const MAX_SANITIZER_PASSES = 10;
    for (let pass = 0; pass < MAX_SANITIZER_PASSES; pass++) {
      let changed = false;

      // 3a. 单次遍历：按顺序检查每条消息的合法性
      //     - tool 消息必须能在其之前的 assistant.tool_calls 中找到 id（顺序！）
      //     - 同一 tool_call_id 的 tool 消息去重
      //     - assistant 的 tool_calls 缺失后续 tool 结果时补全占位
      const seenToolCallIds = new Set();   // 所有 assistant.tool_calls 的 id（全局）
      const answeredToolCallIds = new Set(); // 已有 tool 消息回复的 id
      const newMessages = [];

      for (let i = 0; i < this.messages.length; i++) {
        const msg = this.messages[i];

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          // 记录该 assistant 的 tool_call id
          for (const tc of msg.tool_calls) {
            seenToolCallIds.add(tc.id);
          }
          newMessages.push(msg);
          continue;
        }

        if (msg.role === 'tool') {
          // 顺序检查：tool 消息的 tool_call_id 必须在之前的 assistant 中出现过
          if (!seenToolCallIds.has(msg.tool_call_id)) {
            removedCount++;
            details.push('删除无前置 tool_calls 的 tool 消息（顺序错误/孤儿）');
            changed = true;
            continue;
          }
          // 去重：同一 tool_call_id 只保留第一条
          if (answeredToolCallIds.has(msg.tool_call_id)) {
            removedCount++;
            details.push('删除重复 tool 消息');
            changed = true;
            continue;
          }
          answeredToolCallIds.add(msg.tool_call_id);
          newMessages.push(msg);
          continue;
        }

        newMessages.push(msg);
      }
      this.messages = newMessages;

      // 3b. 检查每个 assistant 的 tool_calls 是否都有对应 tool 消息
      //     如果有缺失，为缺失项补全占位 tool 结果（保留 assistant 的文本内容）
      //     这比删除整个 assistant 更安全，不会丢失用户可见的 AI 回复
      for (let i = 0; i < this.messages.length; i++) {
        const msg = this.messages[i];
        if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;

        const missingTcs = msg.tool_calls.filter(tc => !answeredToolCallIds.has(tc.id));
        if (missingTcs.length > 0) {
          // 在该 assistant 之后（下一条 assistant/user 之前）插入占位 tool 结果
          const placeholders = missingTcs.map(tc => ({
            role: 'tool',
            tool_call_id: tc.id,
            content: '[工具执行被中断，结果不可用]'
          }));
          // 找到插入位置：assistant 之后、下一个非 tool 消息之前
          let insertPos = i + 1;
          while (insertPos < this.messages.length && this.messages[insertPos].role === 'tool') {
            insertPos++;
          }
          this.messages.splice(insertPos, 0, ...placeholders);
          for (const tc of missingTcs) answeredToolCallIds.add(tc.id);
          removedCount += missingTcs.length; // 计入修复数（这里是补全而非删除）
          details.push(`为 ${missingTcs.length} 个缺失 tool_call 补全占位结果`);
          changed = true;
        }
      }

      // 3c. 删除末尾空 assistant（中断残留，或删除 tool_calls 后变空的 assistant）
      while (this.messages.length > 0) {
        const last = this.messages[this.messages.length - 1];
        if (last.role === 'assistant' && (last.content === '' || last.content == null) &&
            (!last.tool_calls || last.tool_calls.length === 0)) {
          this.messages.pop();
          removedCount++;
          details.push('删除尾部空 assistant');
          changed = true;
        } else {
          break;
        }
      }

      if (!changed) break;
    }

    // 第四遍：删除空 user/assistant 消息（content='' 且无 tool_calls，且不在末尾）
    this.messages = this.messages.filter((msg, i) => {
      if (i === this.messages.length - 1) return true; // 末尾已在前面处理
      if ((msg.role === 'user' || msg.role === 'assistant') &&
          (msg.content === '' || msg.content == null) &&
          (!msg.tool_calls || msg.tool_calls.length === 0)) {
        removedCount++;
        details.push(`删除中间空 ${msg.role} 消息`);
        return false;
      }
      return true;
    });

    // 重新规范化 pinnedMessages 索引（已删除元素，索引需要重算）
    // 简化处理：清空 pinnedMessages（影响很小，pin 主要用于防压缩）
    if (removedCount > 0) this.pinnedMessages = [];

    return {
      fixed: removedCount > 0 || details.length > 0,
      removedCount,
      details: details.slice(0, 20), // 限制日志长度
      beforeLength: before,
      afterLength: this.messages.length
    };
  }
}

// Expose for node tests; in renderer the class is consumed via globalThis
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ContextManager, TOKENS_PER_CJK_CHAR, TOKENS_PER_OTHER_CHAR };
}
