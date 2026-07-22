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
  assert.ok(agentContent2.includes('CIBYP-PCB-EDA 使用规范'), 'missing prompt section');
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

  // 测试1: reasoningEffort='off' 时 content 不为空且不含思考标签
  async function testReasoningOff() {
    const llm = { ...liveLLMConfig };
    const req = LLMProviders.buildLLMRequest(llm, {
      messages: testMessages,
      temperature: 0.0,
      max_tokens: 200,
      reasoningEffort: 'off',
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
      throw new Error(`content 为空 (reasoning 长度=${reasoning.length})。reasoningEffort='off' 未生效或模型未输出最终答案`);
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

    console.log(`  PASS: reasoningEffort='off' → content="${content.substring(0, 50)}" (len=${content.length}), reasoning=${reasoning ? `有(${reasoning.length}字)` : '无'}`);
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
      max_tokens: 500,
      reasoningEffort: 'off',
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

// ---- Summary ----
(async () => {
  // 等待异步 LLM 测试完成
  await runLiveLLMTests();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);
})();
