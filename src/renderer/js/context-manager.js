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
    this.messages = [];
    this.pinnedMessages = []; // Important messages that should not be removed
    this.systemPrompt = null;
    this.summaries = []; // Compressed history summaries
    this.compactBoundaries = []; // CompactBoundary tracking
  }

  setMaxTokens(max) {
    this.maxTokens = max;
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
    this.messages.push(msg);
    // Sync lightweight trim — only runs strategy 1 (truncate long tool results).
    // Heavy LLM-based summarization is invoked explicitly via summarizeWithLLM().
    this.lightTrim();
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

  addToolResult(toolCallId, name, result) {
    this.addMessage({ role: 'tool', tool_call_id: toolCallId, name, content: typeof result === 'string' ? result : JSON.stringify(result) });
  }

  /**
   * 添加多模态工具结果：文本 + 图片（OpenAI vision format content array）
   * 用于 readImageFile 等工具，将图片直接注入上下文而非返回 base64 字符串。
   */
  addMultimodalToolResult(toolCallId, name, textContent, imageUrl) {
    const content = [
      { type: 'text', text: textContent },
      { type: 'image_url', image_url: { url: imageUrl } }
    ];
    this.addMessage({ role: 'tool', tool_call_id: toolCallId, name, content });
  }

  pinMessage(index) {
    if (index >= 0 && index < this.messages.length) {
      this.pinnedMessages.push(index);
    }
  }

  /**
   * Lightweight synchronous trim: truncate long tool results.
   * Called on every addMessage. Does NOT call LLM.
   */
  lightTrim() {
    const threshold = this.maxTokens * 0.85;
    if (this.getTotalTokens() <= threshold) return;
    for (let i = 0; i < this.messages.length; i++) {
      if (this.pinnedMessages.includes(i)) continue;
      const msg = this.messages[i];
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 500) {
        msg.content = msg.content.substring(0, 300) + '\n...[内容已截断]';
      }
    }
  }

  /**
   * MicroCompact — clear stale tool results beyond a sliding window.
   * No API call. Replaces the old >70% "clear_tool_results" strategy.
   * Returns the count of cleared tool results.
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
          msg.content = '[旧工具结果已清理，详见对话历史]';
          cleared++;
        } else if (Array.isArray(msg.content)) {
          // 多模态工具结果：清理为文本提示
          msg.content = '[旧工具结果已清理（含图片），详见对话历史]';
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
        temperature: 0.3
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
    return {
      tokens,
      maxTokens,
      usage,
      totalMessages: this.messages.length,
      summaries: this.summaries.length,
      compactions: this.compactBoundaries.length
    };
  }

  clear() {
    this.messages = [];
    this.pinnedMessages = [];
    this.summaries = [];
    this.compactBoundaries = [];
  }
}

// Expose for node tests; in renderer the class is consumed via globalThis
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ContextManager, TOKENS_PER_CJK_CHAR, TOKENS_PER_OTHER_CHAR };
}
