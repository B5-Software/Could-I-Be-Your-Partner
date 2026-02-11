/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Context Window Intelligent Manager
// Token estimation ratios (based on typical tokenizer behavior)
const TOKENS_PER_CJK_CHAR = 1.5;
const TOKENS_PER_OTHER_CHAR = 0.4;
const MESSAGE_OVERHEAD_TOKENS = 4;

class ContextManager {
  constructor(maxTokens = 8192) {
    this.maxTokens = maxTokens;
    this.messages = [];
    this.pinnedMessages = []; // Important messages that should not be removed
    this.systemPrompt = null;
    this.summaries = []; // Compressed history summaries
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
    this.checkAndTrim();
  }

  addUserMessage(content) {
    this.addMessage({ role: 'user', content });
  }

  addAssistantMessage(content, toolCalls) {
    const msg = { role: 'assistant', content: content || '' };
    if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
    this.addMessage(msg);
  }

  addToolResult(toolCallId, name, result) {
    this.addMessage({ role: 'tool', tool_call_id: toolCallId, name, content: typeof result === 'string' ? result : JSON.stringify(result) });
  }

  pinMessage(index) {
    if (index >= 0 && index < this.messages.length) {
      this.pinnedMessages.push(index);
    }
  }

  checkAndTrim() {
    const threshold = this.maxTokens * 0.85; // Start trimming at 85% capacity
    if (this.getTotalTokens() <= threshold) return;

    // Strategy 1: Truncate long tool results
    for (let i = 0; i < this.messages.length; i++) {
      if (this.pinnedMessages.includes(i)) continue;
      const msg = this.messages[i];
      if (msg.role === 'tool' && msg.content && msg.content.length > 500) {
        msg.content = msg.content.substring(0, 300) + '\n...[内容已截断]';
      }
    }

    if (this.getTotalTokens() <= threshold) return;

    // Strategy 2: Remove old tool call pairs (keep last 5 rounds)
    const rounds = [];
    let currentRound = [];
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === 'user') {
        if (currentRound.length > 0) rounds.push([...currentRound]);
        currentRound = [i];
      } else {
        currentRound.push(i);
      }
    }
    if (currentRound.length > 0) rounds.push(currentRound);

    if (rounds.length > 6) {
      // Summarize old rounds
      const oldRounds = rounds.slice(0, rounds.length - 5);
      const oldIndices = new Set(oldRounds.flat());
      const summary = this.generateSummary(oldRounds);
      if (summary) this.summaries.push(summary);

      this.messages = this.messages.filter((_, i) => !oldIndices.has(i) || this.pinnedMessages.includes(i));
      // Reset pinned indices
      this.pinnedMessages = [];
    }

    if (this.getTotalTokens() <= threshold) return;

    // Strategy 3: Remove intermediate tool results
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.getTotalTokens() <= threshold) break;
      if (this.messages[i].role === 'tool' && i < this.messages.length - 4) {
        this.messages[i].content = '[结果已清理]';
      }
    }
  }

  generateSummary(rounds) {
    let summary = '';
    for (const round of rounds) {
      for (const idx of round) {
        const msg = this.messages[idx];
        if (!msg) continue;
        if (msg.role === 'user') {
          summary += `用户: ${(msg.content || '').substring(0, 100)}\n`;
        } else if (msg.role === 'assistant' && msg.content) {
          summary += `助手: ${msg.content.substring(0, 100)}\n`;
        }
      }
    }
    return summary ? `[历史摘要]\n${summary}` : null;
  }

  // manageContext tool handler
  manage(action, options = {}) {
    switch (action) {
      case 'summarize': {
        const summary = this.generateSummary([this.messages.map((_, i) => i).slice(0, -3)]);
        if (summary) {
          this.summaries.push(summary);
          const keepCount = options.keepLast || 4;
          this.messages = this.messages.slice(-keepCount);
        }
        return { ok: true, message: '上下文已摘要压缩' };
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
        let cleared = 0;
        for (const msg of this.messages) {
          if (msg.role === 'tool' && msg.content && msg.content.length > 100) {
            msg.content = msg.content.substring(0, 100) + '...[已截断]';
            cleared++;
          }
        }
        return { ok: true, message: `已清理${cleared}条工具结果` };
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
      summaries: this.summaries.length
    };
  }

  clear() {
    this.messages = [];
    this.pinnedMessages = [];
    this.summaries = [];
  }
}
