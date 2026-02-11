/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Tests for core components
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} - ${e.message}`);
    failed++;
  }
}

console.log('Running tests...\n');

// ---- Test Tarot Data ----
console.log('Tarot Data:');
const tarotCards = require('../src/data/tarot.js');

test('should have 78 tarot cards', () => {
  assert.strictEqual(tarotCards.length, 78);
});

test('should have 22 major arcana cards', () => {
  const major = tarotCards.filter(c => c.arcana === 'major');
  assert.strictEqual(major.length, 22);
});

test('should have 56 minor arcana cards', () => {
  const minor = tarotCards.filter(c => c.arcana === 'minor');
  assert.strictEqual(minor.length, 56);
});

test('each card should have required fields', () => {
  for (const card of tarotCards) {
    assert.ok(card.id !== undefined, `card missing id`);
    assert.ok(card.name, `card ${card.id} missing name`);
    assert.ok(card.nameEn, `card ${card.id} missing nameEn`);
    assert.ok(card.meaning, `card ${card.id} missing meaning`);
    assert.ok(card.icon, `card ${card.id} missing icon`);
  }
});

test('minor arcana should have 4 suits with 14 cards each', () => {
  const minor = tarotCards.filter(c => c.arcana === 'minor');
  const suits = {};
  for (const c of minor) {
    suits[c.suit] = (suits[c.suit] || 0) + 1;
  }
  assert.strictEqual(Object.keys(suits).length, 4);
  for (const suit of Object.keys(suits)) {
    assert.strictEqual(suits[suit], 14, `suit ${suit} has ${suits[suit]} cards, expected 14`);
  }
});

// ---- Test Context Manager (simulated - it runs in browser) ----
console.log('\nContext Manager (logic tests):');

// Simulate the ContextManager class for testing
class TestContextManager {
  constructor(maxTokens = 8192) {
    this.maxTokens = maxTokens;
    this.messages = [];
    this.pinnedMessages = [];
    this.systemPrompt = null;
    this.summaries = [];
  }

  estimateTokens(text) {
    if (!text) return 0;
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const otherCount = text.length - cjkCount;
    return Math.ceil(cjkCount * 1.5 + otherCount * 0.4);
  }

  estimateMessageTokens(msg) {
    let tokens = 4;
    tokens += this.estimateTokens(msg.role);
    if (typeof msg.content === 'string') tokens += this.estimateTokens(msg.content);
    if (msg.tool_calls) tokens += this.estimateTokens(JSON.stringify(msg.tool_calls));
    return tokens;
  }

  getTotalTokens() {
    let total = 0;
    if (this.systemPrompt) total += this.estimateMessageTokens(this.systemPrompt);
    for (const msg of this.messages) total += this.estimateMessageTokens(msg);
    return total;
  }

  addMessage(msg) { this.messages.push(msg); }
  setSystemPrompt(p) { this.systemPrompt = { role: 'system', content: p }; }

  manage(action, options = {}) {
    switch (action) {
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
      default:
        return { ok: false, message: '未知操作' };
    }
  }

  getMessages() {
    const result = [];
    if (this.systemPrompt) result.push(this.systemPrompt);
    if (this.summaries.length > 0) {
      result.push({ role: 'system', content: '以下是之前对话的摘要:\n' + this.summaries.slice(-3).join('\n---\n') });
    }
    result.push(...this.messages);
    return result;
  }
}

test('context manager should estimate tokens', () => {
  const cm = new TestContextManager();
  assert.ok(cm.estimateTokens('hello') > 0);
  assert.ok(cm.estimateTokens('你好世界') > 0);
  // CJK should estimate higher per char
  assert.ok(cm.estimateTokens('你好') > cm.estimateTokens('hi'));
});

test('context manager should track messages', () => {
  const cm = new TestContextManager();
  cm.addMessage({ role: 'user', content: 'hello' });
  cm.addMessage({ role: 'assistant', content: 'hi there' });
  assert.strictEqual(cm.messages.length, 2);
});

test('context manager should include system prompt', () => {
  const cm = new TestContextManager();
  cm.setSystemPrompt('You are a helpful assistant');
  cm.addMessage({ role: 'user', content: 'hello' });
  const msgs = cm.getMessages();
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
});

test('context manager clear_old should remove old messages', () => {
  const cm = new TestContextManager();
  for (let i = 0; i < 10; i++) {
    cm.addMessage({ role: 'user', content: `message ${i}` });
  }
  const result = cm.manage('clear_old', { keepLast: 3 });
  assert.ok(result.ok);
  assert.strictEqual(cm.messages.length, 3);
});

test('context manager clear_tool_results should truncate long results', () => {
  const cm = new TestContextManager();
  cm.addMessage({ role: 'tool', content: 'x'.repeat(500), tool_call_id: '1', name: 'test' });
  const result = cm.manage('clear_tool_results');
  assert.ok(result.ok);
  assert.ok(cm.messages[0].content.length < 200);
});

// ---- Test Tool Definitions ----
console.log('\nTool Definitions:');

// Load the tools-def file content to check structure
const fs = require('fs');
const toolsContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/tools-def.js'), 'utf-8');

test('TOOL_DEFINITIONS should be defined', () => {
  assert.ok(toolsContent.includes('TOOL_DEFINITIONS'));
});

test('DANGEROUS_COMMANDS should include common dangerous patterns', () => {
  assert.ok(toolsContent.includes('rm -rf'));
  assert.ok(toolsContent.includes('format'));
  assert.ok(toolsContent.includes('shutdown'));
});

test('should have tool schemas function', () => {
  assert.ok(toolsContent.includes('getToolSchemas'));
});

// ---- Test JS Runner ----
console.log('\nJS Runner:');

const runnerContent = fs.readFileSync(require('path').join(__dirname, '../src/tools/js-runner.js'), 'utf-8');

test('JS runner should block dangerous globals', () => {
  assert.ok(runnerContent.includes('require'));
  assert.ok(runnerContent.includes('process'));
  assert.ok(runnerContent.includes('undefined'));
});

test('JS runner should use strict mode', () => {
  assert.ok(runnerContent.includes('"use strict"'));
});

// ---- Test Main Process Structure ----
console.log('\nMain Process:');

const mainContent = fs.readFileSync(require('path').join(__dirname, '../src/main/main.js'), 'utf-8');

test('main process should handle settings IPC', () => {
  assert.ok(mainContent.includes("settings:get"));
  assert.ok(mainContent.includes("settings:set"));
});

test('main process should handle memory IPC', () => {
  assert.ok(mainContent.includes("memory:search"));
  assert.ok(mainContent.includes("memory:add"));
  assert.ok(mainContent.includes("memory:delete"));
});

test('main process should handle knowledge IPC', () => {
  assert.ok(mainContent.includes("knowledge:search"));
  assert.ok(mainContent.includes("knowledge:add"));
});

test('main process should handle file operations', () => {
  assert.ok(mainContent.includes("fs:readFile"));
  assert.ok(mainContent.includes("fs:writeFile"));
  assert.ok(mainContent.includes("fs:deleteFile"));
  assert.ok(mainContent.includes("fs:listDirectory"));
});

test('main process should handle terminal operations', () => {
  assert.ok(mainContent.includes("terminal:make"));
  assert.ok(mainContent.includes("terminal:run"));
  assert.ok(mainContent.includes("terminal:kill"));
});

test('main process should handle LLM calls', () => {
  assert.ok(mainContent.includes("llm:chat"));
  assert.ok(mainContent.includes("llm:chatStream"));
});

test('main process should handle sensitive operation confirmation', () => {
  assert.ok(mainContent.includes("dialog:confirm"));
});

test('main process should handle image generation', () => {
  assert.ok(mainContent.includes("image:generate"));
});

test('ocr handler should define languages as string', () => {
  assert.ok(mainContent.includes("const languages = 'chi_sim+eng'"));
});

test('ocr handler should create worker with languages and langPath', () => {
  assert.ok(mainContent.includes('createWorker(languages, OEM.LSTM_ONLY'));
  assert.ok(mainContent.includes('langPath'));
});

test('ocr handler should disable gzip for local traineddata files', () => {
  assert.ok(mainContent.includes('gzip: false'));
});

// ---- Test Preload ----
console.log('\nPreload:');

const preloadContent = fs.readFileSync(require('path').join(__dirname, '../src/preload/preload.js'), 'utf-8');

test('preload should use contextBridge', () => {
  assert.ok(preloadContent.includes('contextBridge'));
  assert.ok(preloadContent.includes('contextIsolation') || preloadContent.includes('exposeInMainWorld'));
});

test('preload should expose all required APIs', () => {
  const required = ['getSettings', 'memorySearch', 'knowledgeSearch', 'readFile', 'drawTarot', 'chatLLM', 'generateImage', 'webSearch', 'listSkills'];
  for (const api of required) {
    assert.ok(preloadContent.includes(api), `missing API: ${api}`);
  }
});

// ---- Summary ----
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
