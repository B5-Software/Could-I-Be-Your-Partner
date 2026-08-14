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

// ---- Test Privacy Filter ----
console.log('\nPrivacy Filter:');

const vm = require('vm');
const privacyContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/privacy-filter.js'), 'utf-8');
const privSandbox = { window: {} };
vm.createContext(privSandbox);
vm.runInContext(privacyContent, privSandbox);
const PrivacyFilter = privSandbox.window.PrivacyFilter;

test('PrivacyFilter module should be exposed', () => {
  assert.ok(PrivacyFilter, 'window.PrivacyFilter missing');
  assert.strictEqual(typeof PrivacyFilter.filterPrivacyInfo, 'function');
  assert.strictEqual(typeof PrivacyFilter.filterSensitiveArgs, 'function');
  assert.strictEqual(typeof PrivacyFilter.sanitizeToolCallsForContext, 'function');
});

test('privacy filter masks API keys and git keys', () => {
  assert.ok(!PrivacyFilter.filterPrivacyInfo('sk-abc1234567890abcdef1234567890abcdef').includes('sk-abc1234567890'));
  assert.ok(PrivacyFilter.filterPrivacyInfo('sk-abc1234567890abcdef1234567890abcdef').includes('[已过滤'));
  assert.ok(!PrivacyFilter.filterPrivacyInfo('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh').includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh'));
  assert.ok(!PrivacyFilter.filterPrivacyInfo('github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef').includes('github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'));
  assert.ok(!PrivacyFilter.filterPrivacyInfo('glpat-1234567890abcdefghijkl').includes('glpat-1234567890abcdefghijkl'));
});

test('privacy filter masks ID numbers and SSN', () => {
  assert.ok(!PrivacyFilter.filterPrivacyInfo('11010519900307123X').includes('11010519900307123X'));
  assert.ok(!PrivacyFilter.filterPrivacyInfo('110105900307123').includes('110105900307123'));
  assert.ok(!PrivacyFilter.filterPrivacyInfo('SSN 123-45-6789').includes('123-45-6789'));
});

test('privacy filter masks phone numbers', () => {
  assert.ok(!PrivacyFilter.filterPrivacyInfo('手机号13812345678').includes('13812345678'));
  assert.ok(!PrivacyFilter.filterPrivacyInfo('call (212) 555-0123 now').includes('212) 555-0123'));
  assert.ok(!PrivacyFilter.filterPrivacyInfo('tel +8613812345678').includes('8613812345678'));
});

test('privacy filter masks SSH private keys', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1ABC\n-----END RSA PRIVATE KEY-----';
  assert.ok(!PrivacyFilter.filterPrivacyInfo(key).includes('MIIEowIBAAKCAQEA1ABC'));
});

test('privacy filter masks .env secret lines and config password KV', () => {
  const envOut = PrivacyFilter.filterPrivacyInfo('API_KEY=sk-abc1234567890\nDB_PASSWORD=hunter2\nPORT=8080');
  assert.ok(!envOut.includes('hunter2'), '.env password should be masked');
  assert.ok(envOut.includes('PORT=8080'), 'non-sensitive .env line should be kept');
  const yamlOut = PrivacyFilter.filterPrivacyInfo('password: s3cr3t\nusername: alice');
  assert.ok(!yamlOut.includes('s3cr3t'));
  assert.ok(yamlOut.includes('username: alice'));
  const jsonOut = PrivacyFilter.filterPrivacyInfo('{"client_secret":"xyz123","name":"bob"}');
  assert.ok(!jsonOut.includes('xyz123'));
  assert.ok(jsonOut.includes('"name":"bob"'));
});

test('privacy filter masks Tor .onion addresses', () => {
  assert.ok(!PrivacyFilter.filterPrivacyInfo('http://abcdefghijklmnopqrstuvwxyz234567abcd.onion/path').includes('.onion'));
  assert.ok(!PrivacyFilter.filterPrivacyInfo('visit abcdefghijklmnop.onion now').includes('abcdefghijklmnop.onion'));
});

test('privacy filter masks Tor ED25519-V3 secret key', () => {
  const key = 'ED25519-V3:zfn6hqkp3k5p3f5sq2qplz5vk3p4d3k5p3f5sq2qplz5vk3p4d3k5p3f';
  const out = PrivacyFilter.filterPrivacyInfo(`private_key=${key}`);
  assert.ok(!out.includes('ED25519-V3'), 'Tor v3 private key should be masked');
  assert.ok(out.includes('[已过滤'), 'should show filtered placeholder');
});

test('privacy filter masks CN social security card numbers', () => {
  assert.ok(!PrivacyFilter.filterPrivacyInfo('社保110123456789012345').includes('110123456789012345'), '18-digit CN social number should be masked');
  assert.ok(!PrivacyFilter.filterPrivacyInfo('社保卡A12345678号').includes('A12345678'), 'A+8digit social card should be masked');
  // 合法身份证不能被社保号模式误伤
  assert.strictEqual(
    PrivacyFilter.filterPrivacyInfo('11010519900307123X', { phone: false, idCard: false, ssn: true, apiKey: false, sshKey: false, env: false, tor: false, gitKey: false, configPassword: false }),
    '11010519900307123X',
    'legal ID must NOT be masked by ssn category'
  );
});

test('privacy filter masks Google and Django keys', () => {
  assert.ok(!PrivacyFilter.filterPrivacyInfo('key AIzaSyD1234567890abcdefghijklmnopqrstuvwx').includes('AIzaSyD1234567890abcdefghijklmnopqrstuvwx'));
  const onlyApi = { phone: false, idCard: false, ssn: false, apiKey: true, sshKey: false, env: false, tor: false, gitKey: false, configPassword: false };
  assert.ok(!PrivacyFilter.filterPrivacyInfo('SECRET_KEY=django-insecure-abc123def456ghi789jkl012', onlyApi).includes('django-insecure'));
});

test('privacy filter categories can be toggled independently', () => {
  const noPhone = PrivacyFilter.filterPrivacyInfo('手机13812345678 身份证11010519900307123X', { phone: false });
  assert.ok(noPhone.includes('13812345678'), 'phone category off should keep phone');
  assert.ok(!noPhone.includes('11010519900307123X'), 'idCard still on should mask ID');
  const allOff = PrivacyFilter.filterPrivacyInfo('手机13812345678', {
    phone: false, idCard: false, ssn: false, apiKey: false, sshKey: false, env: false, tor: false, gitKey: false, configPassword: false
  });
  assert.strictEqual(allOff, '手机13812345678', 'all categories off should keep text');
});

test('filterToolResult masks strings but preserves structure and imageUrl', () => {
  const r = {
    ok: true,
    content: '手机13812345678\nkey=sk-abc1234567890',
    imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA',
    nested: { phone: '13812345678', url: 'https://example.com' }
  };
  const out = PrivacyFilter.filterToolResult(r);
  assert.ok(!out.content.includes('13812345678'));
  assert.ok(!out.content.includes('sk-abc1234567890'));
  assert.strictEqual(out.imageUrl, r.imageUrl, 'base64 imageUrl must be preserved');
  assert.strictEqual(out.nested.phone, '[已过滤:手机号]');
  assert.strictEqual(out.nested.url, 'https://example.com');
  assert.strictEqual(out.ok, true);
  // 原始对象不被修改
  assert.ok(r.content.includes('13812345678'));
});

test('sub-agent records are persisted in history and restored', () => {
  const agentContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/agent.js'), 'utf-8');
  assert.ok(agentContent.includes('payload.subAgents'), 'saveToHistory should persist subAgents');
  assert.ok(agentContent.includes('this.subAgents = conversation.subAgents.map'), 'loadFromHistory should restore subAgents');
  assert.ok(agentContent.includes('subAgent: null'), 'restored records should have subAgent null');
  assert.ok(agentContent.includes('MAX_SUB_AGENT_RECORDS = 100'), 'sub-agent record cap should be 100');
});

test('session cumulative token usage is persisted in history and restored', () => {
  const agentContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/agent.js'), 'utf-8');
  assert.ok(agentContent.includes('usage: { ...this.sessionUsage }'), 'saveToHistory should persist sessionUsage snapshot');
  const loadBlock = agentContent.slice(agentContent.indexOf('async loadFromHistory'));
  assert.ok(loadBlock.includes('conversation.usage'), 'loadFromHistory should read conversation.usage');
  assert.ok(loadBlock.includes('savedUsage.prompt'), 'loadFromHistory should restore saved prompt tokens');
  assert.ok(loadBlock.includes('resetSessionUsage()'), 'loadFromHistory should reset usage first (fallback for legacy conversations)');
});

test('privacy filter should not corrupt normal text', () => {
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('const x = 42; return x * 2;'), 'const x = 42; return x * 2;');
  const s = '{"enabled":true,"timeout":30,"name":"server","note":"authorization is tricky"}';
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo(s), s);
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('the author wrote the book'), 'the author wrote the book');
});

test('privacy filter evasion category is off by default', () => {
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('138_1234_5678'), '138_1234_5678', 'underscore phone should stay without evasion');
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('１３８１２３４５６７８'), '１３８１２３４５６７８', 'full-width phone should stay without evasion');
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('MTM4MTIzNDU2Nzg='), 'MTM4MTIzNDU2Nzg=', 'base64 phone should stay without evasion');
  // categories 对象缺 evasion 键时也按默认关闭处理
  const catsMissingEvasion = { phone: true, idCard: true, ssn: true, apiKey: true, sshKey: true, env: true, tor: true, gitKey: true, configPassword: true };
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('138_1234_5678', catsMissingEvasion), '138_1234_5678', 'missing evasion key should default to off');
});

test('privacy filter evasion detects transformation tricks when enabled', () => {
  const cases = [
    ['138_1234_5678', '手机号'],
    ['１３８１２３４５６７８', '手机号'],
    ['138\u200B1234\u200B5678', '手机号'],
    ['138%2D1234%2D5678', '手机号'],
    ['MTM4MTIzNDU2Nzg=', '手机号'],
    ['１１０１０１１９９００１０１１２３４', '身份证号'],
    ['110101\u200B19900101\u200B1234', '身份证号'],
    ['110101%2D19900101%2D1234', '身份证号'],
    ['MTEwMTAxMTk5MDAxMDExMjM0', '身份证号'],
    ['社保号 １１０１２３４５６７８９０１２３４５', '社保号']
  ];
  for (const [input, label] of cases) {
    const out = PrivacyFilter.filterPrivacyInfo(input, { evasion: true });
    assert.ok(out.includes(`[已过滤:${label}]`), `"${input}" should be masked as ${label}, got: ${out}`);
  }
});

test('privacy filter evasion respects category toggles', () => {
  const noPhone = { evasion: true, phone: false };
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('１３８１２３４５６７８', noPhone), '１３８１２３４５６７８', 'evasion should respect phone off');
  assert.ok(PrivacyFilter.filterPrivacyInfo('１３８１２３４５６７８', { evasion: true }).includes('[已过滤:手机号]'));
  const noEvasion = PrivacyFilter.filterPrivacyInfo('138_1234_5678', { evasion: false });
  assert.ok(noEvasion.includes('138_1234_5678'), 'evasion off should keep evasive phone');
});

test('privacy filter evasion skips base64 data URLs', () => {
  const url = 'data:image/png;base64,MTM4MTIzNDU2Nzg=';
  const out = PrivacyFilter.filterPrivacyInfo(url, { evasion: true });
  assert.ok(out.includes('MTM4MTIzNDU2Nzg='), 'base64 inside data URL must be preserved');
});

test('privacy filter evasion does not corrupt normal text', () => {
  const ev = { evasion: true };
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('const x = 42; return x * 2;', ev), 'const x = 42; return x * 2;');
  assert.strictEqual(PrivacyFilter.filterPrivacyInfo('config.host = "localhost"; port = 5432', ev), 'config.host = "localhost"; port = 5432');
});

test('evasion category defaults wired in main.js and settings UI', () => {
  const path = require('path');
  const mainContent = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf-8');
  assert.ok(mainContent.includes('evasion: false'), 'main.js default categories should have evasion off');
  const htmlContent = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/index.html'), 'utf-8');
  assert.ok(htmlContent.includes('data-cat="evasion"'), 'settings UI should have evasion checkbox');
});

test('i18n settings tab translations are complete for budget/notifications/terminal/language', () => {
  const path = require('path');
  const i18nJs = fs.readFileSync(path.join(__dirname, '../src/renderer/js/i18n.js'), 'utf-8');
  const enJs = fs.readFileSync(path.join(__dirname, '../src/renderer/js/i18n/en.js'), 'utf-8');
  const deJs = fs.readFileSync(path.join(__dirname, '../src/renderer/js/i18n/de.js'), 'utf-8');
  for (const tab of ['budget', 'notifications', 'terminal', 'language']) {
    assert.ok(i18nJs.includes(`data-tab="${tab}"]`), `i18n.js should map .settings-tab[data-tab="${tab}"]`);
  }
  for (const key of ['budget', 'notifications', 'terminal', 'language']) {
    assert.ok(enJs.includes(key + ": '"), `en.js tabs should have ${key}`);
    assert.ok(deJs.includes(key + ": '"), `de.js tabs should have ${key}`);
  }
  for (const zh of ['预算控制', '通知', '终端', '系统通知', '终端策略', '模型价格表']) {
    assert.ok(enJs.includes(`'${zh}'`), `en.js _textMap should have ${zh}`);
    assert.ok(deJs.includes(`'${zh}'`), `de.js _textMap should have ${zh}`);
  }
});

test('filterSensitiveArgs masks sensitive keys and keeps others', () => {
  const out = PrivacyFilter.filterSensitiveArgs({ apiKey: 'sk-xxx', DB_PASSWORD: 'pwd1', path: '/home/user', nested: { password: 'pwd', port: 3000 } });
  assert.strictEqual(out.apiKey, '[已过滤]');
  assert.strictEqual(out.DB_PASSWORD, '[已过滤]');
  assert.strictEqual(out.path, '/home/user');
  assert.strictEqual(out.nested.password, '[已过滤]');
  assert.strictEqual(out.nested.port, 3000);
});

test('sanitizeToolCallsForContext keeps original tool_calls untouched', () => {
  const tcs = [{ id: 'call_1', function: { name: 'readFile', arguments: '{"path":"/x","apiKey":"sk-zzz"}' } }];
  const orig = JSON.stringify(tcs);
  const clean = PrivacyFilter.sanitizeToolCallsForContext(tcs, { maskArgs: true, scanTerminal: true });
  assert.strictEqual(orig, JSON.stringify(tcs), 'original must not be mutated');
  assert.ok(!clean[0].function.arguments.includes('sk-zzz'));
  assert.ok(clean[0].function.arguments.includes('/x'));
});

test('sanitizeToolCallsForContext scans terminal commands when enabled', () => {
  const tcs = [{ id: 'c1', function: { name: 'runTerminalCommand', arguments: '{"command":"curl -H \\"Authorization: Bearer sk-abc1234567890abcdef\\" https://api.example.com"}' } }];
  const withScan = PrivacyFilter.sanitizeToolCallsForContext(tcs, { maskArgs: false, scanTerminal: true });
  assert.ok(!withScan[0].function.arguments.includes('sk-abc1234567890abcdef'), 'terminal command should be scanned');
  const withoutScan = PrivacyFilter.sanitizeToolCallsForContext(tcs, { maskArgs: false, scanTerminal: false });
  assert.ok(withoutScan[0].function.arguments.includes('sk-abc1234567890abcdef'), 'scanTerminal=false keeps text');
});

test('sub-agent chat history should be preserved on completion', () => {
  const agentContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/agent.js'), 'utf-8');
  const doneBlock = agentContent.slice(agentContent.indexOf('subAgentRecord.status = \'done\''));
  assert.ok(!doneBlock.includes('subCm.messages = []'), 'sub-agent context messages must NOT be cleared on completion');
  assert.ok(doneBlock.includes('MAX_SUB_AGENT_RECORDS = 100'), 'sub-agent record cap should be 100');
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
const llmRetry = require('../src/main/llm-retry');
const sessionPreloadContent = fs.readFileSync(require('path').join(__dirname, '../src/preload/preload.js'), 'utf-8');
const sessionIndexContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/pages/index.html'), 'utf-8');

test('scoped abort helpers should be exported and wired', () => {
  assert.strictEqual(typeof llmRetry.abortRequests, 'function');
  const terminalContent = fs.readFileSync(require('path').join(__dirname, '../src/main/terminal-service.js'), 'utf-8');
  assert.ok(terminalContent.includes("ipcMain.handle('agent:abort'"), 'terminal service should register agent:abort');
  assert.ok(sessionPreloadContent.includes('agentAbort'), 'preload should expose agentAbort');
});

test('multi-session infrastructure should be loaded', () => {
  assert.ok(sessionIndexContent.includes('session-manager.js'), 'session-manager.js should be loaded');
  assert.ok(sessionIndexContent.includes('app-utils.js'), 'app-utils.js should be loaded');
  assert.ok(sessionIndexContent.includes('skill-parsers.js'), 'skill-parsers.js should be loaded');
  assert.ok(mainContent.includes('sessions: { maxConcurrent: 10 }') || mainContent.includes('maxConcurrent: 10'), 'default maxConcurrent should be 10');
});

test('session manager should track background sessions and queue overflow', () => {
  const vm = require('vm');
  const code = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/session-manager.js'), 'utf-8');
  const sandbox = { window: {}, console, EventTarget, CustomEvent, Map, Set, Date, Promise };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const SessionManager = sandbox.SessionManager;
  const SessionStatus = sandbox.SessionStatus;
  const makeAgent = (id) => ({
    conversationId: id,
    running: false,
    onStatusChange: null,
    onMessage: null,
    onTitleChange: null,
    sessionStatus: 'idle',
    sessionLastError: null,
    sessionUsage: { prompt: 0, completion: 0, total: 0, cached: 0, cacheCreation: 0, estimated: false },
    setSessionKey() {},
    stop() { this.running = false; }
  });
  const manager = new SessionManager({ maxConcurrent: 1 });
  const a = manager.registerAgent('chat', makeAgent('a'));
  const b = manager.registerAgent('chat', makeAgent('b'));
  assert.ok(a && b);
  manager.activate('chat', a.key);
  a.agent.onStatusChange('working');
  assert.strictEqual(a.status, SessionStatus.RUNNING);
  assert.strictEqual(manager.requestStart(b), false);
  assert.strictEqual(b.status, SessionStatus.QUEUED);
  a.agent.onStatusChange('idle');
  assert.strictEqual(a.status, SessionStatus.DONE);
});

test('多会话标签栏常驻并支持右键批量关闭', () => {
  const sessionsContent = fs.readFileSync(require('path').join(__dirname, '../src/renderer/js/app-parts/02-mode-sessions.js'), 'utf-8');
  assert.ok(sessionsContent.includes('标签栏常驻'), '标签栏应常驻，不随会话数量隐藏');
  assert.ok(sessionsContent.includes('打开工作目录'), '右键菜单应含打开工作目录');
  assert.ok(sessionsContent.includes('关闭左侧所有标签页'), '右键菜单应含关闭左侧');
  assert.ok(sessionsContent.includes('关闭右侧所有标签页'), '右键菜单应含关闭右侧');
  assert.ok(sessionsContent.includes('关闭其他标签页'), '右键菜单应含关闭其他');
  assert.ok(sessionsContent.includes('关闭所有标签页'), '右键菜单应含关闭所有');
  assert.ok(sessionsContent.includes('关闭此标签页'), '右键菜单应含关闭此标签页');
  assert.ok(sessionsContent.includes('createNewSession(mode)'), '关闭最后一个标签页应新建会话');
});

test('思考容器宽度约束与 Babe 标签栏圆角、光标一致性', () => {
  const chatCss = fs.readFileSync(require('path').join(__dirname, '../src/renderer/css/chat.css'), 'utf-8');
  const componentsCss = fs.readFileSync(require('path').join(__dirname, '../src/renderer/css/components.css'), 'utf-8');
  const mainCss = fs.readFileSync(require('path').join(__dirname, '../src/renderer/css/main.css'), 'utf-8');
  assert.ok(chatCss.includes('.message-body') && /\.message-body\s*\{[\s\S]*min-width:\s*0/.test(chatCss), '消息体应允许收缩');
  assert.ok(/\.reasoning-content\s*\{[\s\S]*max-width:\s*100%/.test(chatCss), '推理内容应有最大宽度');
  assert.ok(chatCss.includes('.babe-mode #babe-session-tabs'), 'Babe 标签栏应有圆角规则');
  assert.ok(componentsCss.includes('.reasoning-content.markdown-body pre'), '推理代码块应可横向滚动');
  assert.ok(mainCss.includes('cursor: inherit'), '交互元素后代应继承光标');
});

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
  const terminalContent = fs.readFileSync(require('path').join(__dirname, '../src/main/terminal-service.js'), 'utf-8');
  assert.ok(terminalContent.includes("terminal:make"));
  assert.ok(terminalContent.includes("terminal:run"));
  assert.ok(terminalContent.includes("terminal:kill"));
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
  const ocrContent = fs.readFileSync(require('path').join(__dirname, '../src/main/ocr.js'), 'utf-8');
  assert.ok(ocrContent.includes("const languages = 'chi_sim+eng'"));
});

test('ocr handler should create worker with languages and langPath', () => {
  const ocrContent = fs.readFileSync(require('path').join(__dirname, '../src/main/ocr.js'), 'utf-8');
  assert.ok(ocrContent.includes('createWorker(languages, OEM.LSTM_ONLY'));
  assert.ok(ocrContent.includes('langPath'));
});

test('ocr handler should disable gzip for local traineddata files', () => {
  const ocrContent = fs.readFileSync(require('path').join(__dirname, '../src/main/ocr.js'), 'utf-8');
  assert.ok(ocrContent.includes('gzip: false'));
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

// ---- Test PCB-EDA ----
console.log('\nPCB-EDA:');

const path_ = require('path');
const Geo = require('../src/renderer/js/pcbeda/pcb-geometry.js');
const PCBModelT = require('../src/renderer/js/pcbeda/pcb-model.js');
const PCBFpT = require('../src/renderer/js/pcbeda/pcb-footprints.js');
const PCBSymT = require('../src/renderer/js/pcbeda/pcb-symbols.js');
const PCBGerberT = require('../src/renderer/js/pcbeda/pcb-gerber.js');
const PCBDrctT = require('../src/renderer/js/pcbeda/pcb-drc.js');
const PCBRouteT = require('../src/renderer/js/pcbeda/pcb-autorouter.js');
const PCBIoT = require('../src/renderer/js/pcbeda/pcb-io.js');

test('pcb-geometry: point/segment/polygon basics', () => {
  assert.strictEqual(Geo.dist(0, 0, 3, 4), 5);
  assert.ok(Geo.pointInPolygon(1, 1, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]));
  assert.ok(!Geo.pointInPolygon(5, 5, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]));
  const sp = Geo.snapRoutePoint(0, 0, 10, 3, '45');
  assert.ok(Math.abs(Math.atan2(sp.y, sp.x) % (Math.PI / 4)) < 1e-6 || Math.abs(sp.y) < 1e-6);
});

test('pcb-footprints: named + parametric generation', () => {
  const fp0805 = PCBFpT.generate('R_0805', {});
  assert.strictEqual(fp0805.pads.length, 2);
  assert.ok(fp0805.three.w > 0);
  const soic = PCBFpT.generate('SOIC_CUSTOM', { pins: 16, pitch: 1.27 });
  assert.strictEqual(soic.pads.length, 16);
  const dip = PCBFpT.generate('DIP_CUSTOM', { pins: 8, holeD: 0.9 });
  assert.strictEqual(dip.pads.length, 8);
  assert.ok(dip.pads[0].drill > 0);
  assert.ok(PCBFpT.list().length >= 60);
});

test('pcb-symbols: library + parametric IC/CONN', () => {
  assert.ok(PCBSymT.get('R').pins.length === 2);
  const ic = PCBSymT.get('IC', { left: ['VCC', 'D0'], right: ['GND', 'O0'] });
  assert.strictEqual(ic.pins.length, 4);
  const conn = PCBSymT.get('CONN', { pins: 6 });
  assert.strictEqual(conn.pins.length, 6);
});

function makeTestBoard() {
  const b = PCBModelT.newBoard('TestBoard', 40, 30, 2);
  PCBModelT.Board.addComponent(b, { ref: 'R1', value: '10k', footprint: 'R_0805', x: 10, y: 10 });
  PCBModelT.Board.addComponent(b, { ref: 'R2', value: '10k', footprint: 'R_0805', x: 25, y: 10 });
  PCBModelT.Board.addComponent(b, { ref: 'J1', value: '', footprint: 'HDR-1x4', x: 10, y: 22 });
  PCBModelT.Board.setPadNet(b, 'R1', '1', 'NET1');
  PCBModelT.Board.setPadNet(b, 'R2', '1', 'NET1');
  PCBModelT.Board.setPadNet(b, 'R1', '2', 'GND');
  PCBModelT.Board.setPadNet(b, 'J1', '1', 'GND');
  PCBModelT.Board.addTrace(b, { net: 'GND', layer: 'F.Cu', width: 0.3, pts: [{ x: 9.05, y: 10 }, { x: 5, y: 14 }, { x: 10, y: 20.1 }] });
  PCBModelT.Board.addVia(b, { net: 'GND', x: 6, y: 16, drill: 0.3, diameter: 0.6 });
  PCBModelT.Board.addZone(b, { net: 'GND', layer: 'F.Cu', pts: [{ x: 2, y: 2 }, { x: 38, y: 2 }, { x: 38, y: 28 }, { x: 2, y: 28 }] });
  return b;
}

test('pcb-model: pads/nets/connectivity/ratsnest', () => {
  const b = makeTestBoard();
  const pads = PCBModelT.Board.allPads(b, PCBFpT);
  assert.strictEqual(pads.length, 2 + 2 + 4);
  const nets = PCBModelT.Board.netNames(b, PCBFpT);
  assert.ok(nets.includes('GND') && nets.includes('NET1'));
  const rats = PCBModelT.Board.ratsnest(b, PCBFpT);
  // NET1 (R1.1-R2.1) unrouted => at least one ratsnest line
  assert.ok(rats.some(l => l.net === 'NET1'));
});

test('pcb-model: single-file + multi-file serialization roundtrip', () => {
  const doc = PCBModelT.Doc;
  doc.reset('RoundTrip', 50, 40, 2);
  doc.board().components.push({ id: 'cmp_1', ref: 'U1', value: 'X', footprint: 'SOIC-8', params: {}, x: 5, y: 5, rot: 90, side: 'F', locked: false, padNets: { '1': 'VCC' } });
  const single = JSON.parse(JSON.stringify(doc.toSingleFileJSON()));
  const multi = doc.toMultiFiles('rt');
  assert.strictEqual(multi.files.length, 2); // 1 sheet + 1 board
  const doc2 = PCBModelT.Doc;
  assert.ok(doc2.loadJSON(single).ok);
  assert.strictEqual(doc2.board().components[0].ref, 'U1');
  const fileContents = {};
  for (const f of multi.files) fileContents[f.name] = f.data;
  assert.ok(doc2.loadMultiFiles(multi.manifest, fileContents).ok);
  assert.strictEqual(doc2.board().components[0].padNets['1'], 'VCC');
  doc.reset('TestReset', 100, 80, 2);
});

test('pcb-gerber: RS-274X structure + zones (LP) + apertures', () => {
  const b = makeTestBoard();
  const files = PCBGerberT.exportAll(b, PCBFpT, 'test', { naming: 'jlc' });
  const names = files.map(f => f.name);
  for (const need of ['test.gtl', 'test.gbl', 'test.gts', 'test.gbs', 'test.gto', 'test.gko', 'test-PTH.drl']) {
    assert.ok(names.includes(need), 'missing gerber file: ' + need);
  }
  const gtl = files.find(f => f.name === 'test.gtl').content;
  assert.ok(gtl.includes('%FSLAX46Y46*%'), 'missing format statement');
  assert.ok(gtl.includes('%MOMM*%'), 'missing mm unit');
  assert.ok(gtl.includes('%ADD'), 'missing aperture definitions');
  assert.ok(gtl.includes('G36*'), 'zone region missing');
  assert.ok(gtl.includes('%LPC*%'), 'zone clearance polarity missing');
  assert.ok(gtl.includes('%AM'), 'thermal relief macro missing');
  assert.ok(gtl.trim().endsWith('M02*'), 'missing M02 end');
});

test('pcb-gerber: Excellon drill with tool table', () => {
  const b = makeTestBoard();
  const drl = PCBGerberT.emitDrill(b, true);
  assert.ok(drl.startsWith('M48'), 'missing M48 header');
  assert.ok(drl.includes('METRIC,TZ'), 'missing metric declaration');
  assert.ok(/T\d+C0\.300/.test(drl), 'missing via tool 0.300');
  assert.ok(/T\d+C1\.000/.test(drl), 'missing header pin tool 1.000');
  assert.ok(drl.trim().endsWith('M30'), 'missing M30 end');
});

test('pcb-gerber: stroke font + IPC356 + PnP + BOM', () => {
  const segs = PCBGerberT.textToSegments('R1', 0, 0, 1.2, 0, 'left');
  assert.ok(segs.length > 5);
  const b = makeTestBoard();
  const ipc = PCBGerberT.emitIPC356(b);
  assert.ok(ipc.includes('GND'), 'IPC356 missing net');
  const pnp = PCBGerberT.emitPnP(b);
  assert.ok(pnp.includes('R1'), 'PnP missing R1');
  const bom = PCBGerberT.emitBOM(b);
  assert.ok(bom.includes('2'), 'BOM should group 2x R_0805/10k');
});

test('pcb-drc: detects clearance + unrouted', () => {
  const b = makeTestBoard();
  // add a via of another net right next to R1 pad (clearance violation)
  PCBModelT.Board.addVia(b, { net: 'NET2', x: 10.95, y: 10, drill: 0.3, diameter: 0.6 });
  const errs = PCBDrctT.PCBDrc.run(b, PCBFpT);
  assert.ok(errs.some(e => e.type === 'clearance'), 'should detect clearance error');
  assert.ok(errs.some(e => e.type === 'unrouted'), 'should detect unrouted net');
});

test('pcb-autorouter: routes a simple net', () => {
  const b = PCBModelT.newBoard('AR', 30, 20, 2);
  PCBModelT.Board.addComponent(b, { ref: 'TP1', footprint: 'TP-TH', x: 5, y: 10 });
  PCBModelT.Board.addComponent(b, { ref: 'TP2', footprint: 'TP-TH', x: 25, y: 10 });
  PCBModelT.Board.setPadNet(b, 'TP1', '1', 'N1');
  PCBModelT.Board.setPadNet(b, 'TP2', '1', 'N1');
  const res = PCBRouteT.autoroute(b, PCBFpT, {});
  assert.ok(res.ok, 'autorouter failed: ' + (res.error || ''));
  assert.ok(res.routed >= 1, 'should route at least 1 connection');
  assert.ok(res.traces.length >= 1, 'should produce traces');
});

test('pcb-io: kicad_pcb export/import roundtrip', () => {
  const b = makeTestBoard();
  const text = PCBIoT.exportKicadPcb(b, PCBFpT);
  assert.ok(text.startsWith('(kicad_pcb'), 'not a kicad_pcb');
  assert.ok(text.includes('(segment'), 'missing segments');
  assert.ok(text.includes('(footprint'), 'missing footprints');
  const r = PCBIoT.importKicadPcb(text, PCBFpT, 'RT');
  assert.ok(r.ok, 're-import failed: ' + (r.error || ''));
  assert.strictEqual(r.board.components.length, 3);
  assert.ok(r.board.traces.length >= 1);
  assert.strictEqual(r.board.components.find(c => c.ref === 'R1').padNets['1'], 'NET1');
});

test('pcb-io: kicad netlist export/import + csv import', () => {
  const b = makeTestBoard();
  const net = PCBIoT.exportKiCadNetlist(b);
  const parsed = PCBIoT.importKiCadNetlist(net);
  assert.ok(parsed.nets.some(n => n.name === 'GND'));
  const csv = PCBIoT.importCSVNetlist('Ref,Pad,Net\nU1,1,VCC\nU1,2,GND\nR1,1,VCC');
  assert.strictEqual(csv.nets.length, 2);
  assert.ok(csv.nets.find(n => n.name === 'VCC').pads.includes('U1.1'));
});

test('pcb-io: detectAndImport dispatches formats', () => {
  assert.strictEqual(PCBIoT.detectAndImport('a.kicad_pcb', '(kicad_pcb (version 20221018) (generator "x"))').type, 'kicad_pcb');
  assert.strictEqual(PCBIoT.detectAndImport('a.csv', 'Ref,Pad,Net\nR1,1,GND').type, 'csv_netlist');
  assert.strictEqual(PCBIoT.detectAndImport('a.cipypcb', '{"kind":"cibyp-pcb-project"}').type, 'json');
});

test('PCB-EDA: main process registers pcbeda IPC channels', () => {
  for (const ch of ['pcbeda:open', 'pcbeda:runCommand', 'pcbeda:saveProject', 'pcbeda:loadProject',
    'pcbeda:exportFiles', 'pcbeda:exportGerber', 'pcbeda:exportTextFile', 'pcbeda:importFile',
    'pcbeda:confirmClose', 'pcbeda:close-requested']) {
    assert.ok(mainContent.includes(ch), 'missing IPC channel: ' + ch);
  }
});

test('PCB-EDA: preload exposes pcb APIs (main + sub window)', () => {
  for (const api of ['openPcbEda', 'pcbRunCommand', 'pcbExportGerber', 'pcbExportTextFile', 'pcbImportFile']) {
    assert.ok(preloadContent.includes(api), 'main preload missing: ' + api);
  }
  const subPreload = fs.readFileSync(path_.join(__dirname, '../src/preload/pcbeda-preload.js'), 'utf-8');
  for (const api of ['saveProject', 'exportFiles', 'writeFileBase64', 'onCloseRequested', 'importFileDialog']) {
    assert.ok(subPreload.includes(api), 'pcbeda preload missing: ' + api);
  }
});

test('PCB-EDA: tools registered in tools-def.js', () => {
  const toolsContent = fs.readFileSync(path_.join(__dirname, '../src/renderer/js/tools-def.js'), 'utf-8');
  for (const t of ['initPcbEda', 'pcbExportGerber', 'pcbAutoroute', 'pcbSchSync', 'pcbRunDRC', 'pcbImportFile']) {
    assert.ok(toolsContent.includes("'" + t + "'"), 'tools-def missing: ' + t);
  }
  assert.ok(toolsContent.includes("'PCB-EDA'"), 'missing PCB-EDA category');
});

test('PCB-EDA: agent.js routes pcb tools + prompt section', () => {
  const agentContent2 = fs.readFileSync(path_.join(__dirname, '../src/renderer/js/agent.js'), 'utf-8');
  for (const c of ["case 'initPcbEda'", "case 'pcbExportGerber'", "case 'pcbAutoroute'", "case 'pcbSchSync'"]) {
    assert.ok(agentContent2.includes(c), 'agent.js missing route: ' + c);
  }
  // 工具说明已从系统提示词解耦，PCB 工作流移到 initPcbEda 的 tool description
  const toolsDef = fs.readFileSync(path_.join(__dirname, '../src/renderer/js/tools-def.js'), 'utf-8');
  assert.ok(toolsDef.includes('initPcbEda') && /pcbNewProject[\s\S]*pcbSaveProject/.test(toolsDef), 'initPcbEda description missing workflow');
});

test('PCB-EDA: sub-app page + css exist with CSP', () => {
  const html = fs.readFileSync(path_.join(__dirname, '../src/renderer/pages/pcbeda.html'), 'utf-8');
  assert.ok(html.includes('pcbeda/pcb-gerber.js'), 'page missing gerber script');
  assert.ok(html.includes('Content-Security-Policy'), 'page missing CSP');
  assert.ok(fs.existsSync(path_.join(__dirname, '../src/renderer/css/pcbeda.css')), 'missing pcbeda.css');
  assert.ok(fs.existsSync(path_.join(__dirname, '../src/renderer/js/pcbeda.js')), 'missing pcbeda.js bootstrap');
});

// ---- Test stripThinkingTags (reasoning filter) ----
console.log('\nstripThinkingTags (reasoning filter):');

// Load the function by evaluating the relevant part of i18n.js
// We can't require() the browser file directly, so extract stripThinkingTags
const i18nSrc = fs.readFileSync(path_.join(__dirname, '../src/renderer/js/i18n.js'), 'utf-8');
const stripMatch = i18nSrc.match(/function stripThinkingTags\(text\)\s*\{[\s\S]*?^}/m);
assert.ok(stripMatch, 'stripThinkingTags function not found in i18n.js');
const stripThinkingTags = new Function(stripMatch[0] + '\nreturn stripThinkingTags;')();

test('strips paired <reasoning> tags', () => {
  const input = '<reasoning>Let me think about this carefully.\nThe answer is yes.</reasoning>是';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, '是', `expected "是", got "${result}"`);
});

test('strips paired <think> tags', () => {
  const input = '<think>internal monologue</think>否';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, '否');
});

test('strips paired <reasoning_content> tags', () => {
  const input = '<reasoning_content>deep thoughts here</reasoning_content>这个字是"花"';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, '这个字是"花"');
});

test('strips paired <thought> tags', () => {
  const input = '<thought>hmm</thought>answer here';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, 'answer here');
});

test('strips paired <reflection> tags', () => {
  const input = '<reflection>self-check</reflection>final answer';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, 'final answer');
});

test('strips unclosed <reasoning> tag to end of string', () => {
  const input = '是\n<reasoning>oops I forgot to close this tag';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, '是\n');
});

test('strips unclosed <think> tag to end of string', () => {
  const input = 'answer<think>still thinking...';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, 'answer');
});

test('preserves content when no thinking tags present', () => {
  const input = '这是一个正常的回答，没有任何思考标签。';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, input);
});

test('handles multiple paired tags', () => {
  const input = '<reasoning>first thought</reasoning>middle text<thought>second thought</thought>end';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, 'middle textend');
});

test('handles case-insensitive tags', () => {
  const input = '<REASONING>uppercase thinking</REASONING>answer';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, 'answer');
});

test('handles tags with attributes', () => {
  const input = '<reasoning type="deep">thinking with attrs</reasoning>result';
  const result = stripThinkingTags(input);
  assert.strictEqual(result, 'result');
});

test('handles multiline thinking content', () => {
  const input = '<reasoning>\nLine 1\nLine 2\nLine 3\n</reasoning>\nactual answer';
  const result = stripThinkingTags(input);
  assert.strictEqual(result.trim(), 'actual answer');
});

test('returns input as-is for null/undefined', () => {
  assert.strictEqual(stripThinkingTags(null), null);
  assert.strictEqual(stripThinkingTags(undefined), undefined);
  assert.strictEqual(stripThinkingTags(123), 123);
});

test('returns empty string for empty string', () => {
  assert.strictEqual(stripThinkingTags(''), '');
});

test('does NOT destroy content after tag (bug regression)', () => {
  // The OLD broken regex used [\s\S]*$ which ate everything after an opening tag
  // The NEW regex only eats to end of string for UNCLOSED tags
  const input = '<reasoning>thinking</reasoning>\nThe real answer is here.';
  const result = stripThinkingTags(input);
  assert.ok(result.includes('The real answer is here.'), 'content after closed tag was destroyed');
});

// ---- Test parseLLMResponse does NOT merge reasoning into content ----
console.log('\nparseLLMResponse (reasoning not leaked into content):');

// Load parseLLMResponse from llm-providers.js
const llmProvidersSrc = fs.readFileSync(path_.join(__dirname, '../src/main/llm-providers.js'), 'utf-8');
const parseMatch = llmProvidersSrc.match(/function parseLLMResponse\(data, transport\)\s*\{[\s\S]*?^}/m);
assert.ok(parseMatch, 'parseLLMResponse function not found');
// Also need parseAnthropicResponse (it's called inside)
const anthropicMatch = llmProvidersSrc.match(/function parseAnthropicResponse\(data\)\s*\{[\s\S]*?^}/m);
const parseLLMResponse = new Function(
  'parseAnthropicResponse',
  parseMatch[0] + '\nreturn parseLLMResponse;'
)(
  anthropicMatch ? new Function(anthropicMatch[0] + '\nreturn parseAnthropicResponse;')() : () => {}
);

test('does NOT copy reasoning_content into content when content is empty', () => {
  const data = {
    choices: [{
      message: {
        content: null,
        reasoning_content: 'This is my internal thinking process that should NOT appear as the answer.'
      }
    }]
  };
  const result = parseLLMResponse(data, 'openai');
  assert.strictEqual(result.choices[0].message.content, null, 'content should remain null, not be filled with reasoning');
  assert.strictEqual(result.choices[0].message.reasoning, 'This is my internal thinking process that should NOT appear as the answer.', 'reasoning should be populated for UI');
});

test('preserves content when both content and reasoning_content exist', () => {
  const data = {
    choices: [{
      message: {
        content: 'The final answer is 42.',
        reasoning_content: 'Let me think step by step...'
      }
    }]
  };
  const result = parseLLMResponse(data, 'openai');
  assert.strictEqual(result.choices[0].message.content, 'The final answer is 42.');
  assert.strictEqual(result.choices[0].message.reasoning, 'Let me think step by step...');
});

test('preserves empty content string when reasoning_content exists', () => {
  const data = {
    choices: [{
      message: {
        content: '',
        reasoning_content: 'Internal reasoning'
      }
    }]
  };
  const result = parseLLMResponse(data, 'openai');
  assert.strictEqual(result.choices[0].message.content, '', 'content should remain empty');
  assert.strictEqual(result.choices[0].message.reasoning, 'Internal reasoning');
});

test('handles missing reasoning_content gracefully', () => {
  const data = {
    choices: [{
      message: { content: 'Just an answer.' }
    }]
  };
  const result = parseLLMResponse(data, 'openai');
  assert.strictEqual(result.choices[0].message.content, 'Just an answer.');
  assert.strictEqual(result.choices[0].message.reasoning, undefined);
});

test('handles reasoning field (not reasoning_content)', () => {
  const data = {
    choices: [{
      message: {
        content: 'Final answer.',
        reasoning: 'My reasoning process.'
      }
    }]
  };
  const result = parseLLMResponse(data, 'openai');
  assert.strictEqual(result.choices[0].message.content, 'Final answer.');
  assert.strictEqual(result.choices[0].message.reasoning, 'My reasoning process.');
});

// ---- Real LLM Integration Test (reads actual AI config from settings.json) ----
console.log('\nReal LLM Integration (live API call):');

const os = require('os');
const LLMProviders = require('../src/main/llm-providers.js');

// 定位 settings.json
const settingsDir = process.env.APPDATA
  ? require('path').join(process.env.APPDATA, 'could-i-be-your-partner', 'data')
  : require('path').join(os.homedir(), '.config', 'could-i-be-your-partner', 'data');
const settingsFile = require('path').join(settingsDir, 'settings.json');

let liveLLMConfig = null;
try {
  const rawSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  liveLLMConfig = rawSettings.llm || null;
} catch { /* settings not found */ }

// 异步测试辅助：返回 Promise，resolve(true) 表示通过
async function runLiveLLMTests() {
  if (!liveLLMConfig) {
    console.log('  SKIP: 未找到 AI 配置 (settings.json)，跳过真实 LLM 测试');
    return;
  }
  if (liveLLMConfig.provider === 'opencode-zen' && !liveLLMConfig.zenApiKey) {
    console.log('  SKIP: OpenCode Zen 未配置 API Key，跳过真实 LLM 测试');
    return;
  }
  if (liveLLMConfig.provider !== 'opencode-zen' && (!liveLLMConfig.apiUrl || !liveLLMConfig.apiKey)) {
    console.log('  SKIP: LLM 未配置 apiUrl/apiKey，跳过真实 LLM 测试');
    return;
  }

  console.log(`  使用模型: ${liveLLMConfig.model} (provider: ${liveLLMConfig.provider})`);

  // 构建一个简单 prompt，要求模型只回复一个字
  const testMessages = [
    { role: 'system', content: '你只能回复一个汉字"是"，不要加任何其他内容、解释或思考。' },
    { role: 'user', content: '请回复。' }
  ];

  // 测试1: 游戏场景（不传 max_tokens，用用户配置的 maxResponseTokens；不传 reasoningEffort 避免被 API 拒绝）
  async function testReasoningOff() {
    const llm = { ...liveLLMConfig };
    const req = LLMProviders.buildLLMRequest(llm, {
      messages: testMessages,
      temperature: 0.0,
      // 不传 max_tokens，让 main.js 用 llm.maxResponseTokens
      // 不传 reasoningEffort，让模型用默认行为（reasoningEffort='off' 会被某些 API 拒绝）
      stream: false
    });

    const resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body)
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const rawData = await resp.json();
    if (rawData.error) {
      throw new Error(`API error: ${rawData.error.message || JSON.stringify(rawData.error)}`);
    }

    const data = LLMProviders.parseLLMResponse(rawData, req.transport);
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error('响应缺少 message 字段');

    const content = (msg.content || '').trim();
    const reasoning = (msg.reasoning || msg.reasoning_content || '').trim();

    // content 不应为空
    if (!content) {
      throw new Error(`content 为空 (reasoning 长度=${reasoning.length})。maxResponseTokens=${llm.maxResponseTokens}, model=${llm.model}`);
    }

    // content 不应包含思考标签
    const thinkingPatterns = [/<reasoning[\s>]/i, /<reasoning_content[\s>]/i, /<thought[\s>]/i, /<reflection[\s>]/i, /<think[\s>]/i];
    for (const p of thinkingPatterns) {
      if (p.test(content)) {
        throw new Error(`content 包含思考标签: ${p.source}。content 前100字: ${content.substring(0, 100)}`);
      }
    }

    // content 不应该是长篇大论（期望只回复"是"）
    if (content.length > 200) {
      throw new Error(`content 过长 (${content.length} 字)，可能包含思考过程。前100字: ${content.substring(0, 100)}`);
    }

    console.log(`  PASS: 游戏场景(无reasoningEffort) → content="${content.substring(0, 50)}" (len=${content.length}), reasoning=${reasoning ? `有(${reasoning.length}字)` : '无'}`);
    passed++;
  }

  // 测试2: 默认 reasoningEffort（用户全局设置）时 content 也不含思考标签
  async function testDefaultReasoning() {
    const llm = { ...liveLLMConfig };
    const req = LLMProviders.buildLLMRequest(llm, {
      messages: testMessages,
      temperature: 0.0,
      max_tokens: 200,
      stream: false
      // 不传 reasoningEffort，使用用户全局设置
    });

    const resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body)
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const rawData = await resp.json();
    if (rawData.error) {
      throw new Error(`API error: ${rawData.error.message || JSON.stringify(rawData.error)}`);
    }

    const data = LLMProviders.parseLLMResponse(rawData, req.transport);
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error('响应缺少 message 字段');

    const content = (msg.content || '').trim();
    const reasoning = (msg.reasoning || msg.reasoning_content || '').trim();

    // content 不应包含思考标签（即使模型思考了，parseLLMResponse 也不应把 reasoning 合并到 content）
    const thinkingPatterns = [/<reasoning[\s>]/i, /<reasoning_content[\s>]/i, /<thought[\s>]/i, /<reflection[\s>]/i, /<think[\s>]/i];
    for (const p of thinkingPatterns) {
      if (p.test(content)) {
        throw new Error(`content 包含思考标签: ${p.source}。content 前100字: ${content.substring(0, 100)}`);
      }
    }

    // 如果有 reasoning，验证它没有泄漏到 content
    if (reasoning && content === reasoning) {
      throw new Error('content 与 reasoning 完全相同 — reasoning 泄漏到了 content');
    }

    console.log(`  PASS: 默认 reasoningEffort → content="${content.substring(0, 50)}" (len=${content.length}), reasoning=${reasoning ? `有(${reasoning.length}字)` : '无'}`);
    passed++;
  }

  // 测试3: 模拟游戏场景 — 让模型选定一个人物
  async function testGameScenario() {
    const llm = { ...liveLLMConfig };
    const sys = `你在玩"是否猜人物"游戏，需要选定一个人物让玩家来猜。
要求：
1. 选择一个广为人知的历史人物
2. 第一行输出人物姓名
3. 第二行起用一句话简短介绍
格式：
姓名
简介`;
    const req = LLMProviders.buildLLMRequest(llm, {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: '请选定一个历史人物。' }
      ],
      temperature: 0.9,
      // 不传 max_tokens，用用户配置的 maxResponseTokens
      // 不传 reasoningEffort，避免 'off' 被 API 拒绝
      stream: false
    });

    const resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body)
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const rawData = await resp.json();
    if (rawData.error) {
      throw new Error(`API error: ${rawData.error.message || JSON.stringify(rawData.error)}`);
    }

    const data = LLMProviders.parseLLMResponse(rawData, req.transport);
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error('响应缺少 message 字段');

    let content = (msg.content || '').trim();
    if (!content) {
      throw new Error('游戏场景 content 为空 — AI 无法选定人物');
    }

    // 应用 stripThinkingTags（与游戏代码一致）
    content = stripThinkingTags(content);
    content = content.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();

    if (!content) {
      throw new Error('stripThinkingTags 后 content 为空');
    }

    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error('解析后无有效行');
    }

    // 第一行应该是人物姓名（不是思考过程）
    const name = lines[0];
    if (name.length > 50) {
      throw new Error(`姓名过长 (${name.length})，可能包含思考过程: ${name.substring(0, 80)}`);
    }

    // 不应包含思考标签
    const thinkingPatterns = [/<reasoning[\s>]/i, /<reasoning_content[\s>]/i, /<thought[\s>]/i, /<reflection[\s>]/i, /<think[\s>]/i];
    for (const p of thinkingPatterns) {
      if (p.test(name)) {
        throw new Error(`姓名包含思考标签: ${p.source}`);
      }
    }

    console.log(`  PASS: 游戏场景 → 人物="${name}", 简介="${(lines[1] || '').substring(0, 50)}"`);
    passed++;
  }

  try {
    await testReasoningOff();
  } catch (e) {
    console.log(`  FAIL: reasoningEffort='off' 测试 - ${e.message}`);
    failed++;
  }

  try {
    await testDefaultReasoning();
  } catch (e) {
    console.log(`  FAIL: 默认 reasoningEffort 测试 - ${e.message}`);
    failed++;
  }

  try {
    await testGameScenario();
  } catch (e) {
    console.log(`  FAIL: 游戏场景测试 - ${e.message}`);
    failed++;
  }
}

// ---- IME Engine ----
console.log('\nIME Engine:');
const ImeEngine = require('../src/renderer/js/oskey/ime-engine.js');

const mockZh = {
  v: 1,
  syll: ['ai', 'an', 'hao', 'ni', 'o', 'wo', 'men', 'xin', 'huo', 'zhong', 'guo', 'bei', 'jing', 'lv', 'lve', 'nv'],
  chars: {
    ai: [['爱', 1516399], ['艾', 212019]],
    an: [['安', 867275], ['案', 120000]],
    hao: [['好', 7259684], ['号', 513737]],
    ni: [['你', 1422192], ['泥', 120657]],
    o: [['哦', 3563330], ['噢', 496080]],
    wo: [['我', 29569261], ['握', 340839]],
    men: [['们', 509405], ['门', 120000]],
    xin: [['心', 2000000], ['新', 1500000]],
    huo: [['火', 1200000], ['货', 1100000]],
    zhong: [['中', 3000000], ['重', 200000]],
    guo: [['国', 2500000], ['果', 300000]],
    lv: [['绿', 3000000], ['律', 1800000], ['旅', 900000]],
    nv: [['女', 2500000], ['恧', 100]],
    lve: [['略', 1200000], ['掠', 800000]],
    bei: [['北', 1000000], ['杯', 900000]],
    jing: [['京', 800000], ['景', 700000]],
  },
  words: {
    nihao: [['你好', 332885], ['拟好', 3685]],
    women: [['我们', 509405], ['窝门', 100]],
    xinhuo: [['新货', 800000], ['心火', 750000]],
    zhongguo: [['中国', 1200000]],
    beijing: [['北京', 1000000]],
  },
  codes: ['nihao', 'women', 'xinhuo', 'zhongguo', 'beijing'],
  abbr: {
    nh: [['你好', 332885], ['女孩', 200000]],
    wm: [['我们', 509405]],
  },
};

const mockEn = ['apple', 'apples', 'applet', 'applaud', 'applause'];
const mockDe = ['ein', 'eine', 'einem', 'einer', 'einen'];

function makeEngine() {
  const e = new ImeEngine();
  assert.ok(e.initZh(JSON.parse(JSON.stringify(mockZh))));
  e.initEn(mockEn.slice());
  e.initDe(mockDe.slice());
  return e;
}

function wordsOf(engine, input, opts) {
  return engine.getCandidates(input, Object.assign({ maxLength: 10, limit: 8 }, opts || {}))
    .map((x) => x.word);
}

test('exact word match ranked first (nihao -> 你好)', () => {
  const r = wordsOf(makeEngine(), 'nihao');
  assert.strictEqual(r[0], '你好');
  assert.ok(r.includes('拟好'));
});

test('single syllable char first (wo -> 我)', () => {
  const r = wordsOf(makeEngine(), 'wo');
  assert.strictEqual(r[0], '我');
});

test('multi-syllable exact word (wo men -> 我们)', () => {
  const r = wordsOf(makeEngine(), 'women');
  assert.strictEqual(r[0], '我们');
});

test('combo must not override exact match', () => {
  // 'zhongguo' 存在完整词 中国，组合候选(中+国)不得压过它
  const r = wordsOf(makeEngine(), 'zhongguo');
  assert.strictEqual(r[0], '中国');
  const zhEntry = makeEngine().getCandidates('zhongguo', { maxLength: 10, limit: 8 })
    .find((x) => x.word === '中国');
  assert.strictEqual(zhEntry.type, 'exact');
});

test('abbr (简拼) works', () => {
  const r = wordsOf(makeEngine(), 'nh');
  assert.ok(r.includes('你好'));
});

test('syllable splitting avoids fake syllables', () => {
  const e = makeEngine();
  assert.strictEqual(e._isSyllable('nihao'), false);
  assert.strictEqual(e._isSyllable('ni'), true);
  assert.strictEqual(e._isSyllable('hao'), true);
});

test('single syllable skips sub-segment chars (ai -> 爱 first)', () => {
  const r = wordsOf(makeEngine(), 'ai');
  assert.strictEqual(r[0], '爱');
  assert.ok(!r.includes('哦')); // 不应混入 a/i 拆分后的单字
});

test('predictEn returns prefix matches', () => {
  assert.deepStrictEqual(makeEngine().predictEn('appl', 3), ['apple', 'apples', 'applet']);
});

test('predictDe returns prefix matches (case insensitive)', () => {
  assert.deepStrictEqual(makeEngine().predictDe('Ein', 3), ['ein', 'eine', 'einem']);
});

test('empty input returns no candidates', () => {
  assert.deepStrictEqual(makeEngine().getCandidates(''), []);
  assert.deepStrictEqual(makeEngine().getCandidates('123!@#'), []);
});

// ---- OskIme Manager ----
console.log('\nOskIme Manager:');
const OskIme = require('../src/renderer/js/oskey/oskey-ime.js');

function makeOsk() {
  global.ImeEngineInstance = makeEngine();
  const o = new OskIme();
  o.setMode('zh');
  return o;
}

test('OskIme buffers letters and exposes candidates', () => {
  const o = makeOsk();
  o.typeLetter('n');
  o.typeLetter('i');
  o.typeLetter('h');
  o.typeLetter('a');
  o.typeLetter('o');
  assert.strictEqual(o.getState().buffer, 'nihao');
  const cands = o.getState().candidates;
  assert.strictEqual(cands[0].word, '你好');
});

test('OskIme commitSelected commits by index', () => {
  const o = makeOsk();
  o.typeLetter('w');
  o.typeLetter('o');
  assert.strictEqual(o.commitSelected(0), '我');
  assert.strictEqual(o.getState().buffer, '');
});

test('OskIme backspace removes last letter', () => {
  const o = makeOsk();
  o.typeLetter('w');
  o.typeLetter('o');
  o.backspace();
  assert.strictEqual(o.getState().buffer, 'w');
});

test('OskIme en mode predicts via engine', () => {
  const o = makeOsk();
  o.setMode('en');
  const preds = o.predict('appl');
  assert.ok(preds.includes('apple'));
});

test('OskIme shift controls letter case', () => {
  const o = makeOsk();
  o.shift = true;
  assert.strictEqual(o.letterForInsert('a'), 'A');
  o.shift = false;
  assert.strictEqual(o.letterForInsert('a'), 'a');
});

test('OskIme v acts as ü (lv -> 绿)', () => {
  const o = makeOsk();
  o.typeLetter('l');
  o.typeLetter('v');
  assert.strictEqual(o.getState().buffer, 'lü'); // 展示 ü
  assert.strictEqual(o.getState().candidates[0].word, '绿');
  o.typeLetter('e');
  assert.strictEqual(o.getState().buffer, 'lüe');
});

test('OskIme accepts ü key in zh (lü -> 绿)', () => {
  const o = makeOsk();
  o.typeLetter('l');
  o.typeLetter('ü');
  assert.strictEqual(o.getState().buffer, 'lü');
  assert.strictEqual(o.getState().candidates[0].word, '绿');
});

test('OskIme backspace works on ü buffer', () => {
  const o = makeOsk();
  o.typeLetter('n');
  o.typeLetter('v');
  o.backspace();
  assert.strictEqual(o.getState().buffer, 'n');
});

test('OskIme letterForInsert uppercases German umlauts', () => {
  const o = makeOsk();
  o.setMode('de');
  o.shift = true;
  assert.strictEqual(o.letterForInsert('ä'), 'Ä');
  assert.strictEqual(o.letterForInsert('ü'), 'Ü');
  assert.strictEqual(o.letterForInsert('ß'), 'ẞ');
  o.shift = false;
  assert.strictEqual(o.letterForInsert('ä'), 'ä');
  assert.strictEqual(o.letterForInsert('ß'), 'ß');
});

// ---- 文档导入 / Office 工具 / PPT Maker 回归 ----

test('LLM 重试事件按 sessionKey 过滤，避免串到其他会话', () => {
  const fsLocal = require('fs');
  const pathLocal = require('path');
  const agentContent = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/agent.js'), 'utf-8');
  const mainContent = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/main/main.js'), 'utf-8');
  const codeContent = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/app-parts/08-code-mode.js'), 'utf-8');
  assert.ok(agentContent.includes('info.sessionKey && info.sessionKey !== this.sessionKey'), 'agent.js 应按 sessionKey 过滤重试事件');
  assert.ok(codeContent.includes('info.sessionKey && info.sessionKey !== ag.sessionKey'), 'code-mode 应按 sessionKey 过滤重试事件');
  assert.ok(mainContent.includes('sessionKey: options.sessionKey || null'), '主进程广播重试事件应携带 sessionKey');
});

test('Office 硬解工具改名并新增正规 Word/PPT 工具', () => {
  const fsLocal = require('fs');
  const pathLocal = require('path');
  const toolsDef = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/tools-def.js'), 'utf-8');
  for (const name of ['officeHardUnpack', 'officeHardRepack', 'wordExtractText', 'wordCreate', 'wordFillTemplate', 'wordGetMetadata', 'wordListStyles', 'pptMakerCreate']) {
    assert.ok(toolsDef.includes(`name: '${name}'`), `tools-def 应包含 ${name}`);
  }
  assert.ok(toolsDef.includes("category: 'Office 硬解'"), '低层工具应归类为 Office 硬解');
  assert.ok(!toolsDef.includes("name: 'officeUnpack'"), '旧 officeUnpack 名称不应再作为工具定义出现');
});

test('app.js 以 ESM 形式生成并作为 module 加载', () => {
  const fsLocal = require('fs');
  const pathLocal = require('path');
  const appContent = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/app.js'), 'utf-8');
  const indexHtml = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/pages/index.html'), 'utf-8');
  assert.ok(appContent.trimStart().startsWith('/*'), 'app.js 应保留生成头注释');
  assert.ok(appContent.includes('export default (async function appEntry()'), 'app.js 应为 ESM（默认导出初始化 Promise）');
  assert.ok(appContent.trimEnd().endsWith('})();'), 'app.js 应闭合 appEntry');
  assert.ok(indexHtml.includes('<script type="module" src="../js/app.js"></script>'), 'index.html 应以 module 方式加载 app.js');
});

test('Ctrl/Cmd+F 按页面路由：聊天搜索不泄露到其他标签页', () => {
  const fsLocal = require('fs');
  const pathLocal = require('path');
  const chatUi = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/app-parts/05-chat-ui.js'), 'utf-8');
  assert.ok(chatUi.includes("document.querySelector('.page.active')"), 'Ctrl+F 路由应基于当前激活页面');
  assert.ok(chatUi.includes("window.__pageSearchHandlers[pageId]"), 'Ctrl+F 路由应查页面级搜索注册表');
  assert.ok(!chatUi.includes('if ((e.ctrlKey || e.metaKey) && (e.key === \'f\' || e.key === \'F\')) {\n        e.preventDefault();\n        if (isOpen())'), '不应保留旧的无条件全局 Ctrl+F 处理');
});

test('各模式历史接入虚拟滚动与搜索', () => {
  const fsLocal = require('fs');
  const pathLocal = require('path');
  const parts = ['07-history-panels.js', '08-code-mode.js', '09-babe-input.js'];
  for (const part of parts) {
    const content = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/app-parts', part), 'utf-8');
    assert.ok(content.includes('HistoryList.attach'), `${part} 应接入 HistoryList 虚拟滚动`);
    assert.ok(content.includes('makeHistorySearch'), `${part} 应接入历史搜索`);
    assert.ok(content.includes('materializeAll'), `${part} 镜像快照前应展开虚拟列表`);
  }
  const historyList = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/history-list.js'), 'utf-8');
  assert.ok(historyList.includes('window.HistoryList'), 'history-list.js 应暴露 HistoryList');
  assert.ok(historyList.includes('window.makeHistorySearch'), 'history-list.js 应暴露历史搜索工厂');
});

test('设置页支持搜索', () => {
  const fsLocal = require('fs');
  const pathLocal = require('path');
  const settingsPart = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/app-parts/06-tools-skills-settings.js'), 'utf-8');
  const indexHtml = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/pages/index.html'), 'utf-8');
  assert.ok(settingsPart.includes("getElementById('settings-search-input')"), '设置搜索应绑定输入框');
  assert.ok(settingsPart.includes("registerPageSearch('settings'"), '设置搜索应注册到页面级路由');
  assert.ok(indexHtml.includes('id="settings-search-input"'), '设置页应包含搜索输入框');
});

async function runDocumentToolTests() {
  const fsLocal = require('fs');
  const osLocal = require('os');
  const pathLocal = require('path');
  const tmp = fsLocal.mkdtempSync(pathLocal.join(osLocal.tmpdir(), 'cibyp-doc-tests-'));
  const asyncTest = async (name, fn) => {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL: ${name} - ${e.message}`);
      failed++;
    }
  };

  console.log('Document Import & Office Tools:');

  await asyncTest('知识库导入拒绝二进制文件', async () => {
    const { importKnowledgeFile } = require('../src/main/document-import');
    const p = pathLocal.join(tmp, 'bin.png');
    fsLocal.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const r = await importKnowledgeFile(p, { targetDir: tmp });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('二进制'), '应提示二进制文件不可导入');
  });

  await asyncTest('知识库导入拒绝超大文件', async () => {
    const { importKnowledgeFile } = require('../src/main/document-import');
    const p = pathLocal.join(tmp, 'big.txt');
    const fd = fsLocal.openSync(p, 'w');
    fsLocal.closeSync(fd);
    fsLocal.truncateSync(p, 51 * 1024 * 1024);
    const r = await importKnowledgeFile(p, { targetDir: tmp });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('过大'), '应提示文件过大');
  });

  await asyncTest('知识库导入 docx 使用 mammoth 提取文本', async () => {
    const { importKnowledgeFile } = require('../src/main/document-import');
    const docx = require('docx');
    const doc = new docx.Document({
      sections: [{ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: '知识库内容测试' })] })] }]
    });
    const buf = await docx.Packer.toBuffer(doc);
    const p = pathLocal.join(tmp, 'doc.docx');
    fsLocal.writeFileSync(p, buf);
    const r = await importKnowledgeFile(p, { targetDir: tmp });
    assert.strictEqual(r.ok, true);
    assert.ok(r.content.includes('知识库内容测试'), '应提取到文档文字');
  });

  await asyncTest('知识库导入 xlsx 使用 exceljs 读取单元格', async () => {
    const { importKnowledgeFile } = require('../src/main/document-import');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['名称', '值']);
    ws.addRow(['苹果', 42]);
    const p = pathLocal.join(tmp, 'sheet.xlsx');
    await wb.xlsx.writeFile(p);
    const r = await importKnowledgeFile(p, { targetDir: tmp });
    assert.strictEqual(r.ok, true);
    assert.ok(r.content.includes('名称'), '应包含表头');
    assert.ok(r.content.includes('42'), '应包含数值');
  });

  await asyncTest('Word 模板填充（docxtemplater）保留格式', async () => {
    const { fillWordTemplate, extractWordText } = require('../src/main/word-tools');
    const docx = require('docx');
    const doc = new docx.Document({
      sections: [{ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: '你好 {{NAME}}' })] })] }]
    });
    const buf = await docx.Packer.toBuffer(doc);
    const tpl = pathLocal.join(tmp, 'tpl.docx');
    fsLocal.writeFileSync(tpl, buf);
    const out = pathLocal.join(tmp, 'out.docx');
    const r = fillWordTemplate(tpl, out, { NAME: '张三' }, tmp);
    assert.strictEqual(r.ok, true, r.error || '');
    const txt = await extractWordText(out);
    assert.ok(txt.content.includes('张三'), '占位符应被替换');
    assert.ok(!txt.content.includes('{{'), '占位符不应残留');
  });

  await asyncTest('PPT Maker 生成含图表的演示文稿', async () => {
    const { createPresentation } = require('../src/main/ppt-maker');
    const r = await createPresentation({
      title: '测试演示', filename: 't.pptx',
      slides: [
        { type: 'cover', title: '测试演示' },
        { type: 'chart', title: '数据', chart: { type: 'column', labels: ['A', 'B'], series: [{ name: '系列', values: [1, 2] }] } }
      ]
    }, { workspacePath: tmp, appTheme: { mode: 'dark', accentColor: '#4f8cff' }, nativeDark: true });
    assert.strictEqual(r.ok, true, r.error || '');
    assert.ok(fsLocal.existsSync(r.path), '应生成 .pptx 文件');
    assert.strictEqual(r.slideCount, 2);
  });

  await asyncTest('PPT Maker 图表 XML 不含带 "#" 的非法颜色', async () => {
    const AdmZip = require('adm-zip');
    const { createPresentation } = require('../src/main/ppt-maker');
    const r = await createPresentation({
      title: '颜色校验', filename: 'colors.pptx',
      slides: [
        { type: 'chart', title: '柱状图', chart: { type: 'column', labels: ['一', '二'], series: [{ name: '系列', values: [3, 7] }] } },
        { type: 'chart', title: '环形图', chart: { type: 'doughnut', labels: ['甲', '乙'], series: [{ name: '占比', values: [60, 40] }] } }
      ]
    }, { workspacePath: tmp, appTheme: { mode: 'light', accentColor: '#4f8cff' }, nativeDark: false });
    assert.strictEqual(r.ok, true, r.error || '');
    assert.strictEqual(r.accentColor, '#4F8CFF', '返回的强调色应只有一个 "#"');
    const zip = new AdmZip(r.path);
    for (const entry of zip.getEntries()) {
      if (/^ppt\/charts\/chart\d+\.xml$/.test(entry.entryName)) {
        const xml = entry.getData().toString('utf8');
        assert.ok(!/val="#[0-9A-Fa-f]{6}"/.test(xml), `${entry.entryName} 中存在带 "#" 的颜色，会被 PowerPoint 判定为损坏`);
      }
    }
  });

  await asyncTest('PPT Maker 拒绝工作区外的图片', async () => {
    const { createPresentation } = require('../src/main/ppt-maker');
    const outside = pathLocal.join(osLocal.tmpdir(), 'outside-image-test.png');
    fsLocal.writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await createPresentation({
      title: '图片测试',
      slides: [{ type: 'content', title: '图文', bullets: ['点'], layout: 'split', imagePath: outside }]
    }, { workspacePath: tmp, appTheme: { mode: 'light', accentColor: '#4f8cff' }, nativeDark: false });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('工作区'), '应拒绝工作区外的图片');
  });

  await asyncTest('PPT Maker 支持图片/视频/音频媒体插入', async () => {
    const AdmZip = require('adm-zip');
    const { createPresentation } = require('../src/main/ppt-maker');
    const img = pathLocal.join(tmp, 'frame-test.png');
    fsLocal.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const video = pathLocal.join(tmp, 'sample.mp4');
    const audio = pathLocal.join(tmp, 'sample.mp3');
    let ff = null;
    try { ff = require('../src/main/ffmpeg-tools'); } catch { /* ignore */ }
    if (ff && ff.getFfmpegPath()) {
      const gen = await ff.runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:size=64x64:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
      if (!gen.ok) fsLocal.writeFileSync(video, Buffer.from('dummy-mp4'));
      const genAudio = await ff.runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audio]);
      if (!genAudio.ok) fsLocal.writeFileSync(audio, Buffer.from('dummy-mp3'));
    } else {
      fsLocal.writeFileSync(video, Buffer.from('dummy-mp4'));
      fsLocal.writeFileSync(audio, Buffer.from('dummy-mp3'));
    }
    const r = await createPresentation({
      title: '媒体测试', filename: 'media.pptx',
      slides: [
        { type: 'media', title: '视频', media: { kind: 'video', path: 'sample.mp4' } },
        { type: 'media', title: '音频', media: { kind: 'audio', path: 'sample.mp3' } },
        { type: 'gallery', title: '画廊', images: [{ path: 'frame-test.png', caption: '图1' }] }
      ]
    }, { workspacePath: tmp });
    assert.strictEqual(r.ok, true, r.error || '');
    assert.strictEqual(r.slideCount, 3);
    const zip = new AdmZip(r.path);
    const mediaNames = zip.getEntries().map(e => e.entryName).filter(n => n.startsWith('ppt/media/'));
    assert.ok(mediaNames.some(n => /\.mp4$/.test(n)), '应包含视频媒体');
    assert.ok(mediaNames.some(n => /\.mp3$/.test(n)), '应包含音频媒体');
    assert.ok(mediaNames.some(n => /\.png$/.test(n)), '应包含图片媒体');
    const rels1 = zip.readAsText('ppt/slides/_rels/slide1.xml.rels');
    const rels2 = zip.readAsText('ppt/slides/_rels/slide2.xml.rels');
    assert.ok(/video/.test(rels1), '视频应有关系定义');
    assert.ok(/audio/.test(rels2), '音频应有关系定义');
  });

  await asyncTest('FFmpeg 工具集可离线处理媒体', async () => {
    const ff = require('../src/main/ffmpeg-tools');
    if (!ff.getFfmpegPath() || !ff.getFfprobePath()) {
      console.log('  SKIP: 未找到 ffmpeg/ffprobe 二进制');
      return;
    }
    const src = pathLocal.join(tmp, 'ff-src.mp4');
    const gen = await ff.runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    assert.strictEqual(gen.ok, true, gen.error || '');
    const info = await ff.TOOLS.info({ input: src });
    assert.strictEqual(info.ok, true, info.error || '');
    assert.ok(info.info.video.length > 0, '应解析出视频流');
    const frame = await ff.TOOLS.extractFrame({ input: src, time: 0, output: pathLocal.join(tmp, 'ff-frame.jpg') });
    assert.strictEqual(frame.ok, true, frame.error || '');
    assert.ok(fsLocal.existsSync(frame.outputPath), '应生成截图');
    let rejected = false;
    try { await ff.TOOLS.transcode({ input: src, videoCodec: 'h999' }); } catch { rejected = true; }
    assert.ok(rejected, '非法 codec 应被拒绝');
  });

  await asyncTest('表格导出保留单元格格式（xlsx/ods）', async () => {
    const AdmZip = require('adm-zip');
    const { exportSpreadsheetFile } = require('../src/main/spreadsheet-io');
    const cells = [
      { addr: 'A1', value: '指标', raw: '指标', format: { bold: true, bg: '#4f8cff', color: '#ffffff', align: 'center' } },
      { addr: 'B1', value: 1234.5, raw: '1234.5', format: { align: 'right', italic: true, fontSize: 14, color: 'red' } }
    ];
    const xlsxPath = pathLocal.join(tmp, 'fmt.xlsx');
    const xlsxRes = exportSpreadsheetFile(xlsxPath, cells, '格式');
    assert.strictEqual(xlsxRes.ok, true, xlsxRes.error || '');
    const zip = new AdmZip(xlsxPath);
    const styles = zip.getEntry('xl/styles.xml').getData().toString('utf8');
    const sheet = zip.getEntry('xl/worksheets/sheet1.xml').getData().toString('utf8');
    assert.ok(styles.includes('<b/>'), 'styles.xml 应包含粗体');
    assert.ok(styles.includes('patternType="solid"'), 'styles.xml 应包含实心背景');
    assert.ok(styles.includes('horizontal="center"'), 'styles.xml 应包含居中对齐');
    assert.ok(sheet.includes('s="1"') || sheet.includes('s="2"'), '单元格应引用样式');

    const odsPath = pathLocal.join(tmp, 'fmt.ods');
    const odsRes = exportSpreadsheetFile(odsPath, cells, '格式');
    assert.strictEqual(odsRes.ok, true, odsRes.error || '');
    const odsZip = new AdmZip(odsPath);
    const odsXml = odsZip.getEntry('content.xml').getData().toString('utf8');
    assert.ok(odsXml.includes('office:automatic-styles'), 'ODS 应包含自动样式');
    assert.ok(odsXml.includes('fo:font-weight="bold"'), 'ODS 应包含粗体样式');
    assert.ok(odsXml.includes('fo:background-color="#4F8CFF"'), 'ODS 应包含背景色');
  });

  try { fsLocal.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---- Context Compaction (重构版：真实计量 + 水位线 + 配对切点 + checkpoint) ----
function runContextCompactionTests() {
  console.log('\nContext Compaction:');
  const { ContextManager } = require('../src/renderer/js/context-manager.js');

  test('tools schema 计入上下文预算', () => {
    const cm = new ContextManager(131072);
    cm.setToolSchemaTokens(40000);
    const raw = cm.getRawTotalTokens();
    assert.ok(raw >= 40000, `raw tokens 应包含 tools schema，got ${raw}`);
    const stats = cm.getStats();
    assert.strictEqual(stats.toolSchemaTokens, 40000);
  });

  test('usage 校准：滑动更新且被 clamp', () => {
    const cm = new ContextManager(8192);
    cm.calibrateTokens(2000, 1000); // 实际是估算的 2 倍
    assert.ok(cm.tokenCalibration > 1.0 && cm.tokenCalibration <= 2.0);
    // 离谱样本丢弃
    const before = cm.tokenCalibration;
    cm.calibrateTokens(999999, 1000);
    assert.strictEqual(cm.tokenCalibration, before);
  });

  test('配对切点：不把 assistant.tool_calls 与 tool 结果拆开', () => {
    const cm = new ContextManager(131072);
    cm.addUserMessage('读文件');
    cm.addMessage({
      role: 'assistant', content: '好的',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{}' } }]
    });
    cm.addMessage({ role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(5000) });
    cm.addMessage({ role: 'assistant', content: '完成' });
    const range = cm.findCompactRange({ retainTokens: 8, thresholdTokens: 8000 });
    assert.ok(range, '应有可压缩范围');
    // 切点不能是 tool 消息的下标（2）
    assert.notStrictEqual(range.end, 2, '切点不能落在 tool 消息上');
    assert.strictEqual(range.start, 0);
  });

  test('Tier0 剪枝：只剪旧区且字节冻结（二次调用不重复）', () => {
    const cm = new ContextManager(131072);
    cm.addUserMessage('hi');
    for (let i = 0; i < 4; i++) {
      cm.addMessage({ role: 'assistant', content: 'a' });
      cm.addMessage({ role: 'tool', tool_call_id: 'x' + i, content: 'y'.repeat(2000) });
    }
    const policy = { retainTokens: 4, thresholdTokens: 8000 };
    const first = cm.pruneOldToolResults(policy);
    assert.ok(first > 0, '第一次应剪枝');
    const second = cm.pruneOldToolResults(policy);
    assert.strictEqual(second, 0, '已剪枝内容字节冻结，不应重复剪枝');
  });

  test('checkpoint 替换 + 字节冻结 + 回放前缀一致', () => {
    const cm = new ContextManager(131072);
    cm.setSystemPrompt('SYSTEM-PROMPT');
    cm.addUserMessage('u1');
    cm.addMessage({ role: 'assistant', content: 'a1' });
    cm.addUserMessage('u2');
    cm.addMessage({ role: 'assistant', content: 'a2' });
    const applied = cm.applyCheckpoint(0, 3, '早期摘要');
    assert.strictEqual(applied.count, 3);
    assert.strictEqual(cm.messages.length, 2); // checkpoint + a2
    assert.strictEqual(cm.messages[0].role, 'user');
    assert.ok(cm.messages[0].content.includes('<compacted-summary>'));
    assert.ok(cm.checkpointIndexes.has(0));
    // 回放前缀与正式请求前缀一致（system 相同、messages 头相同）
    const replay = cm.getReplayMessages(2, '指令');
    const formal = cm.getMessages();
    assert.strictEqual(replay[0].content, formal[0].content);
    assert.strictEqual(replay[1].content, formal[1].content);
    assert.strictEqual(replay[replay.length - 1].content, '指令');
  });

  test('溢出恢复 hardTruncate 保持配对合法', () => {
    const cm = new ContextManager(8192);
    cm.addUserMessage('u');
    cm.addMessage({
      role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{}' } }]
    });
    cm.addMessage({ role: 'tool', tool_call_id: 'c1', content: 'r' });
    cm.addMessage({ role: 'assistant', content: 'done' });
    const removed = cm.hardTruncate({ retainTokens: 2, thresholdTokens: 100 });
    assert.ok(removed > 0);
    // 尾巴首条不能是 tool 消息
    assert.notStrictEqual(cm.messages[0]?.role, 'tool');
  });
}

// ---- 工具页重构（两级视图：组表格三态 + 模态下钻 + DeepSeek 独立分组）----
function runToolsPageRefactorTests() {
  console.log('\nTools Page Refactor:');
  const fsLocal = require('fs');
  const pathLocal = require('path');

  test('工具页主界面为组表格 + 三态开关 + 模态下钻', () => {
    const part = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/app-parts/06-tools-skills-settings.js'), 'utf-8');
    assert.ok(part.includes('tool-group-row'), '应渲染组表格行');
    assert.ok(part.includes('indeterminate'), '应实现三态开关');
    assert.ok(part.includes('openToolGroupModal'), '应有点组打开模态框');
    assert.ok(part.includes('tools-modal-all-on'), '模态框应有全部开');
    assert.ok(part.includes('ds-section'), 'DeepSeek 插件工具应独立分区');
  });

  test('index.html 含工具组模态框骨架', () => {
    const html = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/pages/index.html'), 'utf-8');
    assert.ok(html.includes('id="tools-group-modal"'), '应有工具组模态框');
    assert.ok(html.includes('tools-modal-all-off'), '模态框应有全部关');
  });

  test('tools-def 提供分组元数据与 DeepSeek 插件注册表', () => {
    const content = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/tools-def.js'), 'utf-8');
    assert.ok(content.includes('CATEGORY_META'), '应有分组元数据');
    assert.ok(content.includes('registerDsPluginTools'), '应有 DeepSeek 插件工具注册');
    assert.ok(content.includes('getCategoryMeta'), '应有分组元数据查询');
  });

  test('DeepSeek 插件工具注册后进入定义与 schema（功能验证）', () => {
    const vm = require('vm');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    const code = fsLocal.readFileSync(pathLocal.join(__dirname, '../src/renderer/js/tools-def.js'), 'utf-8');
    vm.runInContext(code, sandbox, { filename: 'tools-def.js' });
    sandbox.registerDsPluginTools('demo', 'Demo 插件', [
      { name: 'hello', description: '打招呼' }
    ], {
      hello: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    });
    const defs = sandbox.getAllToolDefinitions('chat');
    assert.ok(defs.some(t => t.name === 'ds__demo__hello'), 'DeepSeek 工具应进入定义列表');
    assert.ok(defs.some(t => t.category === 'DS:demo'), 'DeepSeek 工具应单独分组');
    const schemas = sandbox.getToolSchemas({}, 'chat');
    assert.ok(schemas.some(s => s.function && s.function.name === 'ds__demo__hello'), 'DeepSeek 工具应进入 schema');
  });
}

// ---- Summary ----
(async () => {
  // 等待异步 LLM 测试完成
  await runLiveLLMTests();
  await runDocumentToolTests();
  runContextCompactionTests();
  runToolsPageRefactorTests();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);
})();
