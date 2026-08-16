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

// Compaction watermark policy (借鉴 DeepSeek Harness compaction-basic，自研实现)
// - thresholdRatio：输入包络（system+tools+messages+输出预留）超过窗口该比例时触发压缩
// - retainRatio：最近保留尾巴占窗口比例（token 预算制，替代"最近 N 条"）
// - 实际值可由 settings.contextCompaction 覆盖
const COMPACT_THRESHOLD_RATIO = 0.80;
const COMPACT_RETAIN_RATIO = 0.16;
const COMPACT_RETAIN_MIN_TOKENS = 1024;

// 结构化摘要输出模板（八段式，借鉴 dsh compaction-basic，中文化）
const STRUCTURED_SUMMARY_TEMPLATE = [
  '## 主要请求与意图',
  '- （用户原始与演化的目标；措辞必须精确处请逐字引用）',
  '',
  '## 关键技术概念',
  '- （涉及的技术、框架、约定）',
  '',
  '## 文件与代码',
  '- （精确路径：为什么重要、关键改动或片段）',
  '',
  '## 错误与修复',
  '- （错误：如何解决，以及相关用户反馈）',
  '',
  '## 待办事项',
  '- （明确要求但尚未完成的工作）',
  '',
  '## 当前进度',
  '- （检查点时刻正在做什么）',
  '',
  '## 下一步',
  '- （与最近请求直接衔接的单个下一步动作，没有则写"(无)"）',
  '',
  '## 关键上下文',
  '- （决策与理由、约束、用户偏好、待确认问题、继续所需数据）'
].join('\n');

// 压缩 checkpooint 前言：让模型把摘要当作已确立背景，直接续作而非复述
const COMPACT_CHECKPOINT_PREAMBLE =
  '这是一条自动生成的上下文检查点，浓缩了此前一段对话以释放上下文空间。'
  + '请将其中内容视为已确立的背景，直接在此基础上继续工作，不要复述，也不要提及"摘要"本身。';

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
    // ---- 真实计量（Phase A1）----
    // 工具 schema 是输入包络的大头（270+ 工具 ≈ 数万 token），必须计入预算，
    // 否则 UI 圆环与压缩阈值系统性低估，API 先溢出而管理器无感知。
    this.toolSchemaTokens = 0;
    // 启发式估算与真实 tokenizer 存在偏差（尤其 CJK）。用 API 返回的
    // 真实 prompt_tokens 做滑动校准，把估算值往真实值拉齐。
    this.tokenCalibration = 1.0;
    // 压缩事务锁：{ id, start, end, inProgress }。内存 + 会话状态持久化，
    // 崩溃后孤儿锁可检测（借鉴 dsh compaction/start…end 括号）。
    this.compactionLock = null;
    this.checkpointCount = 0;
    this.checkpointIndexes = new Set(); // messages 中 checkpoint 消息的下标（字节冻结）
    this.prunedIndexes = new Set(); // 已被 Tier0 剪枝的消息下标（不再二次改写，保证字节稳定）
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

  // 由 agent 在每次计算工具 schema 后调用：把 tools 计入上下文预算。
  // 估算口径与工具页一致：JSON 字符串长度 / 4（每 token ≈ 4 字符）。
  setToolSchemaTokens(tokens) {
    this.toolSchemaTokens = Math.max(0, Number(tokens) || 0);
  }

  // 用 API 真实 usage 校准估算器。
  // actualPromptTokens: provider 返回的 prompt_tokens；estimatedTokens: 我方当次估算。
  // EWMA 平滑，防止单次异常扰动；clamp 到 [0.5, 2.0] 防失控。
  calibrateTokens(actualPromptTokens, estimatedTokens) {
    const actual = Number(actualPromptTokens);
    const estimated = Number(estimatedTokens);
    if (!Number.isFinite(actual) || !Number.isFinite(estimated) || actual <= 0 || estimated <= 0) return;
    const ratio = actual / estimated;
    if (ratio <= 0 || ratio > 4) return; // 明显异常样本丢弃
    const alpha = 0.25;
    const next = this.tokenCalibration * (1 - alpha) + ratio * alpha;
    this.tokenCalibration = Math.min(2.0, Math.max(0.5, next));
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

  // 未乘校准因子的原始估算（供校准器使用；校准因子按 raw 与实际值之比更新）
  getRawTotalTokens() {
    let total = 0;
    if (this.systemPrompt) total += this.estimateMessageTokens(this.systemPrompt);
    for (const msg of this.messages) {
      total += this.estimateMessageTokens(msg);
    }
    // 工具 schema 计入预算；估算整体乘校准因子
    return total + this.toolSchemaTokens;
  }

  getTotalTokens() {
    const raw = this.getRawTotalTokens();
    return Math.ceil(raw * this.tokenCalibration);
  }

  addMessage(msg) {
    // 同时追加到上下文与历史记录（共享引用）。
    // 历史记录不会被任何压缩/清理操作破坏（参见 lightTrim/microCompact/sanitize
    // 均采用 replace-not-mutate 模式）。
    this.messages.push(msg);
    this.historyMessages.push(msg);
    // 安全阀：仅对刚追加的"病态超大"单条工具结果做兜底截断（防单步溢出），
    // 常规压缩交给 step 边界的 Tier0 剪枝，不再每轮追加都全量扫描/破坏工作视图。
    this._emergencyTrimOne(msg);
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
    this.checkpointIndexes = new Set();
    this.prunedIndexes = new Set();
    this.checkpointCount = 0;
    this.compactionLock = null;
    this._compactionInProgress = false;
    this.toolSchemaTokens = 0;
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
   * 安全阀（O(1)）：截断刚追加的病态超大工具结果，防止单条消息撑爆上下文。
   * 常规压缩（Tier0 剪枝 / Tier1 摘要）在 step 边界由 _manageContext 负责。
   * replace-not-mutate：替换数组元素为克隆，保护 historyMessages 引用。
   */
  _emergencyTrimOne(msg) {
    if (!msg || msg.role !== 'tool') return;
    const CAP = 30000, HEAD = 8000;
    if (typeof msg.content === 'string' && msg.content.length > CAP) {
      const idx = this.messages.length - 1;
      this.messages[idx] = {
        ...msg,
        content: `[工具结果过大已兜底截断：原 ${msg.content.length} 字符]\n${msg.content.substring(0, HEAD)}\n...[已截断，详见对话历史]`
      };
      this.prunedIndexes.add(idx);
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
   * 工具调用/结果配对切点分析。
   * 返回 { safeAt: Set<number>, openerOf: Map<callId, idx> }
   * safeAt 包含所有"可以在此处切开"的下标（messages[i] 作为尾巴首条）。
   * 规则：messages[i] 是 tool 消息时不可切（其配对 opener 会被割走）。
   */
  _analyzeToolPairing() {
    const safeAt = new Set();
    const openers = new Map(); // tool_call_id -> assistant idx
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc && tc.id) openers.set(tc.id, i);
        }
      }
    }
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m && m.role === 'tool') {
        // 切在 tool 消息前会把它的 opener 留在头里被替换 → 不允许
        continue;
      }
      safeAt.add(i);
    }
    return { safeAt, openers };
  }

  /**
   * 选择要压缩的头部范围 [start, end)（end 为保留尾巴的首条下标）。
   * - 保留尾巴按 token 预算（retainTokens），而非"最近 N 条"。
   * - 切点对齐 tool 配对：不允许 assistant.tool_calls 与其 tool 结果被切开。
   * - 无安全范围（如尾部正在等工具结果、或头为空）返回 null。
   */
  findCompactRange(policy) {
    const p = policy || this.resolvePolicy();
    const n = this.messages.length;
    if (n <= 1) return null;
    const { safeAt, openers } = this._analyzeToolPairing();

    let tailTokens = 0;
    let cut = n;
    for (let i = n - 1; i >= 0; i--) {
      tailTokens += this.estimateMessageTokens(this.messages[i]);
      cut = i;
      if (tailTokens >= p.retainTokens) break;
    }
    if (cut >= n) cut = n - 1;

    // 把切点调整到安全位置：cut 处若是 tool 消息，回退到其 opener
    // （opener 是 assistant，一定是安全切点）。循环防多层异常结构。
    let guard = 0;
    while (cut > 0 && cut < n && this.messages[cut]?.role === 'tool' && guard++ < 64) {
      const callId = this.messages[cut].tool_call_id;
      const opener = callId != null ? openers.get(callId) : undefined;
      cut = (typeof opener === 'number' && opener >= 0 && opener < cut) ? opener : cut - 1;
    }
    if (cut <= 0) return null; // 头部为空，无可压缩范围
    if (!safeAt.has(cut)) {
      // 最终兜底：向前找到最近的合法切点
      let j = cut;
      while (j > 0 && !safeAt.has(j)) j--;
      cut = j;
    }
    if (cut <= 0 || cut >= n) return null;
    return { start: 0, end: cut };
  }

  /**
   * Tier0 无模型剪枝：确定性截断"旧"的超大工具结果（不调 LLM）。
   * - 只处理保留尾巴之前的旧消息；已剪枝的（prunedIndexes）不再改写 → 字节稳定。
   * - 截断后若占用仍超阈值，由调用方决定是否进入 Tier1 摘要。
   * @returns {number} 剪枝条数
   */
  pruneOldToolResults(policy, capChars = 800, keepHeadChars = 400) {
    const p = policy || this.resolvePolicy();
    const n = this.messages.length;
    if (n === 0) return 0;

    // 旧区边界：按 retainTokens 的一半（剪枝比摘要更保守）
    let tailTokens = 0;
    let tailStart = n;
    for (let i = n - 1; i >= 0; i--) {
      tailTokens += this.estimateMessageTokens(this.messages[i]);
      tailStart = i;
      if (tailTokens >= Math.floor(p.retainTokens * 0.5)) break;
    }

    let pruned = 0;
    for (let i = 0; i < tailStart; i++) {
      if (this.prunedIndexes.has(i) || this.pinnedMessages.includes(i)) continue;
      const msg = this.messages[i];
      if (!msg || msg.role !== 'tool') continue;
      if (typeof msg.content !== 'string' || msg.content.length <= capChars) continue;
      const head = msg.content.substring(0, keepHeadChars);
      // replace-not-mutate：保护 historyMessages 里的原始引用
      this.messages[i] = {
        ...msg,
        content: `[工具结果已截断：原 ${msg.content.length} 字符]\n${head}\n...[已截断，详见对话历史]`
      };
      this.prunedIndexes.add(i);
      pruned++;
    }
    return pruned;
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
   * LLM 结构化语义摘要（重构版）。
   *
   * 与旧版的本质区别：
   * 1. 压缩对象是最老的 head 范围（token 预算 + tool 配对切点），而非"最近 N 条"。
   * 2. 摘要请求"会话回放"：system + 摘要块 + 被压缩区消息逐字节原样 + 末尾压缩指令，
   *    并携带当前 tools → 命中暖前缀缓存。
   * 3. 输出强制八段式 Markdown；只取 content。
   * 4. 摘要必须短于源（shrink 验证），否则重试；重试耗尽则机械降级且不改坏表面。
   * 5. 成功后 checkpoint 替换 head 范围并字节冻结。
   *
   * @returns {Promise<{ok, message, summary?, fallback?, skipped?, checkpoint?}>}
   */
  async summarizeWithLLM(options = {}) {
    // 事务锁：同一 ContextManager 内串行，防止并发摘要互相踩踏
    if (this._compactionInProgress) {
      return { ok: false, message: '已有压缩进行中', skipped: true };
    }
    this._compactionInProgress = true;
    try {
      const policy = this.resolvePolicy(options.policy);
      const range = this.findCompactRange(policy);
      if (!range) {
        return { ok: true, message: '无可安全压缩的范围（消息不足或工具调用未闭合）', skipped: true };
      }
      const { start, end } = range;
      const head = this.messages.slice(start, end);
      if (!head.some(m => m && (typeof m.content === 'string' ? m.content.trim() : true))) {
        return { ok: true, message: '头部无实质内容可摘要', skipped: true };
      }

      // 合并旧 checkpoint：若头部已含此前压缩检查点，提醒摘要器它们是既定背景
      const priorCheckpoints = [];
      for (const idx of this.checkpointIndexes) {
        if (idx >= start && idx < end && this.messages[idx]) {
          const c = this.messages[idx].content;
          if (typeof c === 'string') priorCheckpoints.push(c);
        }
      }
      const mergeNote = priorCheckpoints.length
        ? '\n\n注意：下文可能包含更早的 <compacted-summary> 检查点，它们代表已确立的背景。请将其内容合并进本检查点，不要丢，也不要重复展开细节。'
        : '';

      const instruction = [
        '你现在作为本 AI 编码助手的压缩引擎工作。把上面的对话浓缩成一份结构化检查点，'
        + '让另一个模型能无损接续工作。',
        '',
        '严格按下面的 Markdown 结构输出：保留每个小节、按顺序。用精简的要点而非成段散文。'
        + '某节为空时写"(无)"——绝不省略任何小节。',
        '',
        STRUCTURED_SUMMARY_TEMPLATE,
        mergeNote,
        '',
        '只输出检查点本体，不要任何前言、解释或代码围栏。'
      ].join('\n');

      const headTokens = head.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);
      const maxRetries = Math.max(0, Number(options.maxRetries ?? 1));
      let summary = '';
      let lastError = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let instructionForAttempt = instruction;
        if (attempt > 0) {
          instructionForAttempt += '\n\n（上一版过长。请压缩到原来一半以下，用最精简的要点，只保留接续任务所必需的事实。）';
        }
        const replayMessages = this.getReplayMessages(end, instructionForAttempt);
        let result;
        try {
          result = await window.api.summarizeLLM(replayMessages, {
            max_tokens: options.maxTokens ?? 2048,
            temperature: 0.3,
            sessionKey: options.sessionKey || null,
            tools: options.tools || null,
            purpose: 'compaction',
            // 会话级模型/变体覆盖：压缩与主请求同模型，复用暖前缀缓存
            model: options.model || null,
            reasoningEffort: options.reasoningEffort || null
          });
        } catch (e) {
          lastError = e;
          result = null;
        }
        const content = (result && result.ok ? (result.content || '') : '').trim();
        if (!content) {
          lastError = lastError || new Error(result && result.error ? result.error : '摘要内容为空');
          continue;
        }
        summary = content;
        // shrink 验证：摘要必须明显短于源（留 15% 余量防估算抖动）
        const summaryTokens = this.estimateTokens(summary);
        if (summaryTokens < headTokens * 0.85) break;
        summary = '';
      }

      if (!summary) {
        // 重试耗尽：机械降级，保持消息表面不变（不删不切）
        const fb = this.generateSummary([head.map((_, i) => start + i)]);
        if (fb) {
          this.applyCheckpoint(start, end, fb.replace(/^\[历史摘要\]\n?/, ''), { mechanical: true });
          this.compactBoundaries.push({
            timestamp: Date.now(), type: 'fallback_checkpoint',
            summarizedCount: end - start, error: lastError ? lastError.message : '摘要为空'
          });
          return { ok: true, message: 'LLM 摘要未收敛，已用机械检查点替换', fallback: true, summary: fb };
        }
        return { ok: false, message: 'LLM 摘要失败：' + (lastError ? lastError.message : '摘要为空'), fallback: false, error: lastError ? lastError.message : '摘要为空' };
      }

      const applied = this.applyCheckpoint(start, end, summary, { mechanical: false });
      this.compactBoundaries.push({
        timestamp: Date.now(), type: 'llm_checkpoint',
        summarizedCount: end - start,
        headTokens, summaryTokens: this.estimateTokens(summary)
      });
      return { ok: true, message: `已生成结构化检查点（压缩 ${end - start} 条消息）`, summary, checkpoint: applied };
    } finally {
      this._compactionInProgress = false;
    }
  }

  /**
   * 会话回放消息：与 getMessages() 前缀逐字节一致（system + 旧摘要块 + 头部消息），
   * 末尾追加压缩指令。配合 tools 复用暖前缀缓存。
   */
  getReplayMessages(end, instruction) {
    const result = [];
    if (this.systemPrompt) result.push(this.systemPrompt);
    if (this.summaries.length > 0) {
      result.push({
        role: 'system',
        content: '以下是之前对话的摘要:\n' + this.summaries.slice(-3).join('\n---\n')
      });
    }
    result.push(...this.messages.slice(0, end));
    result.push({ role: 'user', content: instruction });
    return result;
  }

  /**
   * checkpoint 替换：把 [start, end) 替换为一条 user 检查点消息。
   * 落定后字节冻结（checkpointIndexes 标记，后续压缩不再改写）。
   */
  applyCheckpoint(start, end, summaryText, meta = {}) {
    const text = String(summaryText || '').trim() || '[压缩检查点：早期对话内容]';
    const checkpointMsg = {
      role: 'user',
      content: `${COMPACT_CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${text}\n</compacted-summary>`,
      metadata: { kind: 'compaction-checkpoint', mechanical: !!meta.mechanical, at: Date.now() }
    };
    this.messages.splice(start, end - start, checkpointMsg);
    // 下标重建（数组被 splice，旧下标作废）
    this.checkpointIndexes = new Set([start]);
    this.prunedIndexes = new Set();
    this.checkpointCount++;
    this.compactBoundaries.push({
      timestamp: Date.now(), type: 'checkpoint',
      start, end, count: end - start
    });
    return { start, end, count: end - start };
  }

  // manageContext tool handler — synchronous actions only.
  // For LLM-based summarization, use summarizeWithLLM() instead.
  manage(action, options = {}) {
    switch (action) {
      case 'prune': {
        const pruned = this.pruneOldToolResults(options.policy);
        return { ok: true, message: `已剪枝 ${pruned} 条旧工具结果` };
      }
      case 'summarize': {
        // Sync mechanical fallback (caller should prefer summarizeWithLLM)
        const range = this.findCompactRange(options.policy || this.resolvePolicy());
        if (!range) return { ok: true, message: '无可安全压缩范围' };
        const head = this.messages.slice(range.start, range.end);
        const summary = this.generateSummary([head.map((_, i) => range.start + i)]);
        if (summary) {
          this.applyCheckpoint(range.start, range.end, summary.replace(/^\[历史摘要\]\n?/, ''), { mechanical: true });
        }
        return { ok: true, message: '上下文已机械压缩（建议使用 LLM 结构化摘要）' };
      }
      case 'clear_old': {
        const policy = options.policy || this.resolvePolicy({ retainRatio: 0.08 });
        const removed = this.hardTruncate(policy);
        return { ok: true, message: removed > 0 ? `已安全截断 ${removed} 条旧消息` : '无需清理' };
      }
      case 'hard_truncate': {
        const removed = this.hardTruncate(options.policy || this.resolvePolicy());
        return { ok: true, message: `硬截断 ${removed} 条旧消息` };
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
        this.checkpointIndexes = new Set();
        this.prunedIndexes = new Set();
        return { ok: true, message: '已保留必要消息' };
      }
      case 'status': {
        return { ok: true, stats: this.getStats(), policy: this.resolvePolicy(options.policy) };
      }
      default:
        return { ok: false, message: '未知操作' };
    }
  }

  /**
   * 紧急硬截断（Tier2 局部）：把最老 head 替换为占位 checkpoint。
   * 切点仍对齐 tool 配对，避免孤儿 tool 结果。
   * @returns {number} 被替换的消息条数
   */
  hardTruncate(policy) {
    const range = this.findCompactRange(policy);
    if (!range) return 0;
    this.applyCheckpoint(range.start, range.end, '早期对话内容因上下文溢出被截断，详见对话历史。', { mechanical: true });
    return range.end - range.start;
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
      compactions: this.compactBoundaries.length,
      toolSchemaTokens: this.toolSchemaTokens,
      tokenCalibration: Number(this.tokenCalibration.toFixed(3)),
      checkpoints: this.checkpointCount
    };
  }

  /**
   * 解析压缩策略（水位线阈值 + 保留预算）。
   * @param {object} overrides settings.contextCompaction 覆盖项
   */
  resolvePolicy(overrides = {}) {
    const cfg = overrides && typeof overrides === 'object' ? overrides : {};
    const thresholdRatio = Number(cfg.thresholdRatio) > 0 && Number(cfg.thresholdRatio) < 1
      ? Number(cfg.thresholdRatio) : COMPACT_THRESHOLD_RATIO;
    const retainRatio = Number(cfg.retainRatio) > 0 && Number(cfg.retainRatio) < thresholdRatio
      ? Number(cfg.retainRatio) : COMPACT_RETAIN_RATIO;
    const retainTokens = Math.max(
      COMPACT_RETAIN_MIN_TOKENS,
      Math.floor((this.maxTokens || 8192) * retainRatio)
    );
    const thresholdTokens = Math.floor((this.maxTokens || 8192) * thresholdRatio);
    return { thresholdRatio, retainRatio, retainTokens, thresholdTokens };
  }

  clear() {
    this.messages = [];
    this.historyMessages = [];
    this.pinnedMessages = [];
    this.summaries = [];
    this.compactBoundaries = [];
    this.checkpointIndexes = new Set();
    this.prunedIndexes = new Set();
    this.checkpointCount = 0;
    this.compactionLock = null;
    this._compactionInProgress = false;
    this.toolSchemaTokens = 0;
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
