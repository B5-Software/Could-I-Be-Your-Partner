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
    assert.ok(card.meaningOfUpright, `card ${card.id} missing meaningOfUpright`);
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

// ---- Test GeoGebra Integration ----
console.log('\nGeoGebra Integration:');

const appContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/app.js'), 'utf-8');

test('initGeoGebra should be async (return Promise)', () => {
  // 必须返回 Promise（或 ggbInitPromise）—— 修复同步返回导致后续工具调用的 race condition
  assert.ok(/window\.initGeoGebra\s*=\s*function\s*\([^)]*\)\s*{[\s\S]*?return\s+(Promise\.resolve|ggbInitPromise)/.test(appContent),
    'initGeoGebra 应返回 Promise/ggbInitPromise');
});

test('initGeoGebra should register error listener on applet load', () => {
  // 必须注册 setErrorListener / setClientListener —— 否则命令失败会静默返回 { ok: true, label: null }
  assert.ok(appContent.includes('setErrorListener'), '未注册 setErrorListener');
  assert.ok(appContent.includes('setClientListener'), '未注册 setClientListener');
});

test('initGeoGebra should use local ggbLastError state (not window.__ggbLastError)', () => {
  // 旧代码读取 window.__ggbLastError 但从未赋值；新代码使用本地 ggbLastError
  assert.ok(appContent.includes('ggbLastError'), '未使用本地 ggbLastError 状态');
  assert.ok(!/window\.__ggbLastError\s*=\s*null/.test(appContent), '仍使用旧的 window.__ggbLastError 清空逻辑');
});

test('initGeoGebra should have a load timeout', () => {
  // 必须有超时保护（远程加载 web3d 模块可能失败）
  assert.ok(/timeoutMs\s*=\s*\d+/.test(appContent), '未设置 initGeoGebra 超时');
  assert.ok(appContent.includes('GeoGebra 加载超时'), '缺少超时错误提示');
});

test('evalGeoGebraCommand should retry on lazy-module errors with broader pattern', () => {
  // 新的懒加载正则应覆盖 "正在加载" / "未加载" 等多语言措辞
  assert.ok(appContent.includes('正在加载'), '懒加载正则未覆盖中文 "正在加载"');
  assert.ok(appContent.includes('not loaded yet'), '懒加载正则未覆盖英文 "not loaded yet"');
});

test('evalGeoGebraCommand should detect failed label-producing commands', () => {
  // 应该对预期产生 label 的命令（赋值/Solve/Roots 等）做非空检查
  assert.ok(appContent.includes('producesLabel'), '未实现 producesLabel 检查');
  assert.ok(/producesLabel\s*&&\s*labels\.length\s*===\s*0/.test(appContent), '未对 label 命令做空值检查');
});

test('evalGeoGebraCommand should await init if applet not ready', () => {
  // 应该在 ggbApplet 未就绪时 await ggbInitPromise
  assert.ok(/if\s*\(\s*ggbInitPromise\s*\)\s*{[\s\S]*?await\s+ggbInitPromise/.test(appContent),
    '未在 applet 未就绪时等待初始化完成');
});

test('main.js geogebra:evalCommand should use JSON.stringify (not regex replace)', () => {
  // 修复 IPC 注入漏洞：使用 JSON.stringify 而非 cmd.replace(/"/g, '\\"')
  const mainGgbSection = mainContent.split('// ---- IPC: GeoGebra')[1] || '';
  assert.ok(mainGgbSection.includes('JSON.stringify'), 'geogebra IPC 未使用 JSON.stringify 转义');
  // 不应再使用易受注入的 replace 模式
  assert.ok(!/geogebra.*?\\.replace\(\s*\/"\/g\\\s*,\s*'\\\\\\"'\s*\)/s.test(mainGgbSection) ||
            !mainGgbSection.includes('cmd.replace(/"/g'), '仍在使用 cmd.replace 转义双引号');
});

test('agent.js updateFunctionInGeogebra should validate expression parameter', () => {
  // 修复 updateFunctionInGeogebra 不再静默忽略 expression 缺失
  const agentContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/agent.js'), 'utf-8');
  assert.ok(agentContent.includes("updateFunctionInGeogebra 需要 expression 参数"),
    'updateFunctionInGeogebra 未对缺失 expression 报错');
});

test('geogebra-panel HTML should exist with ggb-element div', () => {
  const htmlContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/pages/index.html'), 'utf-8');
  assert.ok(htmlContent.includes('id="geogebra-panel"'), '缺少 geogebra-panel');
  assert.ok(htmlContent.includes('id="ggb-element"'), '缺少 ggb-element 容器');
});

test('CSP should allow https://www.geogebra.org for script/style/img', () => {
  const htmlContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/pages/index.html'), 'utf-8');
  const cspMatch = htmlContent.match(/Content-Security-P[^>]*content="([^"]+)"/);
  assert.ok(cspMatch, '未找到 CSP meta 标签');
  const csp = cspMatch[1];
  assert.ok(csp.includes('https://www.geogebra.org'), 'CSP 未允许 https://www.geogebra.org');
  assert.ok(/script-src[^;]*geogebra/.test(csp), 'CSP script-src 未允许 geogebra');
});

// ---- Summary ----
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
