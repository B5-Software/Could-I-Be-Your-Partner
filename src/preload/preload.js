/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const { contextBridge, ipcRenderer } = require('electron');

// 多会话复用型事件通道：每个通道只往 ipcRenderer 挂一个监听器，
// 订阅者以 Set 维护，退订时按引用移除。这样无论同时存在多少个会话，
// 每个通道的 ipcRenderer 监听器数量恒为 1，彻底避免
// MaxListenersExceededWarning（默认上限 10，多会话并发时极易触发）。
const _channelSubscribers = new Map();
function onChannel(channel, cb) {
  if (!_channelSubscribers.has(channel)) {
    const subs = new Set();
    const listener = (_event, data) => {
      for (const fn of subs) {
        try { fn(data); } catch { /* 单个订阅者异常不应影响其他订阅者 */ }
      }
    };
    ipcRenderer.on(channel, listener);
    _channelSubscribers.set(channel, { subs, listener });
  }
  const entry = _channelSubscribers.get(channel);
  entry.subs.add(cb);
  return () => {
    entry.subs.delete(cb);
    if (entry.subs.size === 0) {
      ipcRenderer.removeListener(channel, entry.listener);
      _channelSubscribers.delete(channel);
    }
  };
}

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  // 监听设置广播（语言/主题/输入法/语音等），返回取消订阅函数
  onSettingsChanged: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },

  // Theme
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_, data) => cb(data)),

  // 构建标志：检测是否为 --no-tarot 打包版本
  isNoTarotBuild: () => ipcRenderer.invoke('app:is-no-tarot-build'),

  // Window Controls
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Tray Mode (后台托盘模式)
  // 监听主进程发出的"关闭时询问"事件 → 渲染器弹模态框
  onTrayAskCloseDecision: (cb) => {
    ipcRenderer.removeAllListeners('tray:ask-close-decision');
    ipcRenderer.on('tray:ask-close-decision', () => cb());
  },
  // 渲染器回传用户的决策：'always' | 'once' | 'never' | 'cancel'
  trayRespondCloseDecision: (decision) => ipcRenderer.send('tray:respond-close-decision', decision),
  // 修改设置项
  traySetCloseToTray: (mode) => ipcRenderer.invoke('tray:set-close-to-tray', mode),
  traySetEnabled: (enabled) => ipcRenderer.invoke('tray:set-enabled', enabled),
  // 手动测试
  trayHideToTray: () => ipcRenderer.invoke('tray:hide-to-tray'),
  trayShowWindow: () => ipcRenderer.invoke('tray:show-window'),

  // Memory
  memorySearch: (q) => ipcRenderer.invoke('memory:search', q),
  memoryAdd: (item) => ipcRenderer.invoke('memory:add', item),
  memoryDelete: (id) => ipcRenderer.invoke('memory:delete', id),
  memoryUpdate: (id, data) => ipcRenderer.invoke('memory:update', { id, data }),

  // 历史搜索（标题/内容，主进程分页扫描）
  historySearch: (opts) => ipcRenderer.invoke('history:search', opts),

  // Knowledge Base
  knowledgeSearch: (q) => ipcRenderer.invoke('knowledge:search', q),
  knowledgeAdd: (item) => ipcRenderer.invoke('knowledge:add', item),
  knowledgeDelete: (id) => ipcRenderer.invoke('knowledge:delete', id),
  knowledgeUpdate: (id, data) => ipcRenderer.invoke('knowledge:update', { id, data }),
  knowledgeImportFile: (p, workspacePath) => ipcRenderer.invoke('knowledge:importFile', p, workspacePath),

  // File System
  readFile: (p, encoding) => ipcRenderer.invoke('fs:readFile', p, encoding),
  writeFile: (p, c, opts) => ipcRenderer.invoke('fs:writeFile', p, c, opts),
  createFile: (p, c, opts) => ipcRenderer.invoke('fs:createFile', p, c, opts),
  getFileEncodingInfo: (p) => ipcRenderer.invoke('fs:getFileInfo', p),
  convertFileEncoding: (p, opts) => ipcRenderer.invoke('fs:convertFileEncoding', p, opts),
  deleteFile: (p) => ipcRenderer.invoke('fs:deleteFile', p),
  moveFile: (s, d) => ipcRenderer.invoke('fs:moveFile', s, d),
  copyFile: (s, d) => ipcRenderer.invoke('fs:copyFile', s, d),
  listDirectory: (p) => ipcRenderer.invoke('fs:listDirectory', p),
  makeDirectory: (p) => ipcRenderer.invoke('fs:makeDirectory', p),
  deleteDirectory: (p) => ipcRenderer.invoke('fs:deleteDirectory', p),
  localSearch: (dir, pattern, options) => ipcRenderer.invoke('fs:localSearch', dir, pattern, options),
  searchInFiles: (paths, pattern, options) => ipcRenderer.invoke('fs:searchInFiles', paths, pattern, options),
  readFileBase64: (p) => ipcRenderer.invoke('fs:readFileBase64', p),
  saveUploadedFile: (name, data) => ipcRenderer.invoke('fs:saveUploadedFile', name, data),

  // Terminal
  makeTerminal: (cwd, sessionKey, sandboxMode) => ipcRenderer.invoke('terminal:make', cwd, { sessionKey, sandboxMode }),
  runTerminalCommand: (id, cmd) => ipcRenderer.invoke('terminal:run', id, cmd),
  awaitTerminalCommand: (id, cmd, timeoutMs) => ipcRenderer.invoke('terminal:await', id, cmd, timeoutMs),
  killTerminal: (id) => ipcRenderer.invoke('terminal:kill', id),
  // 终端可见化：列出所有终端、回写用户输入、调整尺寸、获取历史
  listTerminals: () => ipcRenderer.invoke('terminal:list'),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  getTerminalHistory: (id) => ipcRenderer.invoke('terminal:getHistory', id),
  // 终端交互工具集：读取输出、发送文本（不带回车）、发送按键序列
  readTerminalOutput: (id, lastLines) => ipcRenderer.invoke('terminal:read', id, lastLines),
  sendTerminalText: (id, text) => ipcRenderer.invoke('terminal:sendText', id, text),
  pressTerminalKey: (id, keyName) => ipcRenderer.invoke('terminal:pressKey', id, keyName),
  onTerminalData: (cb) => {
    ipcRenderer.removeAllListeners('terminal:data');
    ipcRenderer.on('terminal:data', (_, payload) => cb(payload));
  },
  onTerminalExit: (cb) => {
    ipcRenderer.removeAllListeners('terminal:exit');
    ipcRenderer.on('terminal:exit', (_, payload) => cb(payload));
  },

  // Clipboard
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (t) => ipcRenderer.invoke('clipboard:write', t),

  // Screenshot
  takeScreenshot: (workspacePath) => ipcRenderer.invoke('screenshot:take', workspacePath),

  // System
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getFullSystemInfo: () => ipcRenderer.invoke('system:fullInfo'),
  getNetworkStatus: () => ipcRenderer.invoke('system:network'),

  // Shell
  openBrowser: (url) => ipcRenderer.invoke('shell:openBrowser', url),
  openFileExplorer: (p) => ipcRenderer.invoke('shell:openFileExplorer', p),

  // Calculator
  calcEvaluate: (expression) => ipcRenderer.invoke('calc:evaluate', expression),
  calcFactorInteger: (value) => ipcRenderer.invoke('calc:factorInteger', value),
  calcGcdLcm: (values) => ipcRenderer.invoke('calc:gcdLcm', values),
  calcBaseConvert: (value, fromBase, toBase) => ipcRenderer.invoke('calc:baseConvert', value, fromBase, toBase),
  calcFactorial: (n) => ipcRenderer.invoke('calc:factorial', n),
  calcComplexMath: (operation, a, b, exponent) => ipcRenderer.invoke('calc:complexMath', operation, a, b, exponent),
  calcMatrixMath: (operation, A, B) => ipcRenderer.invoke('calc:matrixMath', operation, A, B),
  calcVectorMath: (operation, a, b, c) => ipcRenderer.invoke('calc:vectorMath', operation, a, b, c),
  calcSolveInequality: (coefficients, relation, variable) => ipcRenderer.invoke('calc:solveInequality', coefficients, relation, variable),
  calcSolveLinearSystem: (A, b) => ipcRenderer.invoke('calc:solveLinearSystem', A, b),
  calcSolvePolynomial: (coefficients) => ipcRenderer.invoke('calc:solvePolynomial', coefficients),
  calcDistribution: (distribution, operation, params, x) => ipcRenderer.invoke('calc:distributionCalc', distribution, operation, params, x),
  calcCombinatorics: (operation, n, r, repetition) => ipcRenderer.invoke('calc:combinatorics', operation, n, r, repetition),
  calcFractionBaseConvert: (value, fromBase, toBase, precision) => ipcRenderer.invoke('calc:fractionBaseConvert', value, fromBase, toBase, precision),

  // Code Execution
  runJS: (code, cwd, sandboxMode) => ipcRenderer.invoke('code:runJS', code, cwd, sandboxMode),
  runNodeJS: (code, cwd, sandboxMode) => ipcRenderer.invoke('code:runNodeJS', code, cwd, sandboxMode),
  runShell: (script, cwd, sandboxMode) => ipcRenderer.invoke('code:runShell', script, cwd, sandboxMode),
  runPython: (code, cwd, sandboxMode) => ipcRenderer.invoke('code:runPython', code, cwd, sandboxMode),
  sandboxGetStatus: () => ipcRenderer.invoke('sandbox:getStatus'),
  sandboxProbe: () => ipcRenderer.invoke('sandbox:probe'),

  // Image Generation
  generateImage: (prompt, workspacePath) => ipcRenderer.invoke('image:generate', prompt, workspacePath),

  // Web
  webSearch: (q, workspacePath) => ipcRenderer.invoke('web:search', q, workspacePath),
  webFetch: (url) => ipcRenderer.invoke('web:fetch', url),
  webOffscreenSnapshotOCR: (options) => ipcRenderer.invoke('web:offscreenSnapshotOCR', options),
  webOffscreenRenderedContent: (options) => ipcRenderer.invoke('web:offscreenRenderedContent', options),

  // Tarot
  drawTarot: (options) => ipcRenderer.invoke('tarot:draw', options),

  // TRNG
  trngListPorts: () => ipcRenderer.invoke('trng:listPorts'),
  trngTest: () => ipcRenderer.invoke('trng:test'),

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  createSkill: (s) => ipcRenderer.invoke('skills:create', s),
  deleteSkill: (id) => ipcRenderer.invoke('skills:delete', id),
  updateSkill: (id, data) => ipcRenderer.invoke('skills:update', id, data),
  openSkillEditor: (payload) => ipcRenderer.invoke('skill-editor:open', payload),
  onSkillsChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('skills:changed', listener);
    return () => ipcRenderer.removeListener('skills:changed', listener);
  },

  // ---- Code Mode ----
  codeOpenWorkspace: () => ipcRenderer.invoke('code:openWorkspace'),
  codeGetLastWorkspace: () => ipcRenderer.invoke('code:getLastWorkspace'),
  codeSetLastWorkspace: (wsPath) => ipcRenderer.invoke('code:setLastWorkspace', wsPath),
  codeListHistory: (ws) => ipcRenderer.invoke('code:listHistory', ws),
  codeLoadHistory: (ws, id) => ipcRenderer.invoke('code:loadHistory', ws, id),
  codeSaveHistory: (ws, id, data) => ipcRenderer.invoke('code:saveHistory', ws, id, data),
  codeDeleteHistory: (ws, id) => ipcRenderer.invoke('code:deleteHistory', ws, id),
  codeGetFileTree: (dir) => ipcRenderer.invoke('code:getFileTree', dir),

  // ---- Playwright Browser ----
  browserNavigate: (url, waitUntil, workspacePath) => ipcRenderer.invoke('browser:navigate', url, waitUntil, workspacePath),
  browserScreenshot: (fullPage, workspacePath) => ipcRenderer.invoke('browser:screenshot', fullPage, workspacePath),
  browserClick: (selector, timeout, workspacePath) => ipcRenderer.invoke('browser:click', selector, timeout, workspacePath),
  browserType: (selector, text, submit, clear, workspacePath) => ipcRenderer.invoke('browser:type', selector, text, submit, clear, workspacePath),
  browserGetContent: (selector, workspacePath) => ipcRenderer.invoke('browser:getContent', selector, workspacePath),
  browserEvaluate: (script, workspacePath) => ipcRenderer.invoke('browser:evaluate', script, workspacePath),
  browserScroll: (dir, amount, workspacePath) => ipcRenderer.invoke('browser:scroll', dir, amount, workspacePath),
  browserBack: (workspacePath) => ipcRenderer.invoke('browser:back', workspacePath),
  browserForward: (workspacePath) => ipcRenderer.invoke('browser:forward', workspacePath),
  browserRefresh: (workspacePath) => ipcRenderer.invoke('browser:refresh', workspacePath),
  browserWait: (selector, timeout, workspacePath) => ipcRenderer.invoke('browser:wait', selector, timeout, workspacePath),
  browserHover: (selector, workspacePath) => ipcRenderer.invoke('browser:hover', selector, workspacePath),
  browserSelect: (selector, value, workspacePath) => ipcRenderer.invoke('browser:select', selector, value, workspacePath),
  browserGetInfo: (workspacePath) => ipcRenderer.invoke('browser:getInfo', workspacePath),
  browserClose: (workspacePath) => ipcRenderer.invoke('browser:close', workspacePath),

  // Playwright Settings
  pwSearchBrowsers: () => ipcRenderer.invoke('pw:searchBrowsers'),
  pwBrowserDialog: () => ipcRenderer.invoke('pw:browserDialog'),
  pwTestLaunch: (settings) => ipcRenderer.invoke('pw:testLaunch', settings),
  pwCloseBrowser: () => ipcRenderer.invoke('pw:closeBrowser'),
  pwHideBanner: () => ipcRenderer.invoke('pw:hideBanner'),

  // Agent Abort (停止按钮：瞬间中止所有 LLM 请求 + 杀掉所有终端)
  agentAbortAll: () => ipcRenderer.invoke('agent:abortAll'),
  agentAbort: (sessionKey) => ipcRenderer.invoke('agent:abort', { sessionKey }),

  // 头像框系统：列出/读取内置 SVG 头像框
  avatarFramesList: () => ipcRenderer.invoke('avatar-frames:list'),
  avatarFramesGet: (id) => ipcRenderer.invoke('avatar-frames:get', id),

  // Computer Use Protocol (CUP)
  computerScreenshot: (workspacePath) => ipcRenderer.invoke('computer:screenshot', workspacePath),
  computerMouseMove: (x, y) => ipcRenderer.invoke('computer:mouseMove', x, y),
  computerClick: (button, x, y, doubleClick) => ipcRenderer.invoke('computer:click', button, x, y, doubleClick),
  computerDrag: (startX, startY, endX, endY) => ipcRenderer.invoke('computer:drag', startX, startY, endX, endY),
  computerType: (text) => ipcRenderer.invoke('computer:type', text),
  computerKey: (key) => ipcRenderer.invoke('computer:key', key),
  computerScroll: (x, y, direction, amount) => ipcRenderer.invoke('computer:scroll', x, y, direction, amount),
  computerCursorPosition: () => ipcRenderer.invoke('computer:cursorPosition'),
  computerWait: (duration) => ipcRenderer.invoke('computer:wait', duration),
  computerGetScreenSize: () => ipcRenderer.invoke('computer:getScreenSize'),
  computerGetUITree: () => ipcRenderer.invoke('computer:getUITree'),

  // LLM
  chatLLM: (messages, options) => ipcRenderer.invoke('llm:chat', messages, options),
  chatLLMStream: (messages, options) => ipcRenderer.invoke('llm:chatStream', messages, options),
  summarizeLLM: (messages, options) => ipcRenderer.invoke('llm:summarize', messages, options),
  zenFetchModels: () => ipcRenderer.invoke('zen:fetchModels'),
  llmFetchModels: (provider, apiUrl, apiKey) => ipcRenderer.invoke('llm:fetchModels', provider, apiUrl, apiKey),
  usageGetRange: (period) => ipcRenderer.invoke('usage:getRange', period),
  onUsageChanged: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('usage:changed', listener);
    return () => ipcRenderer.removeListener('usage:changed', listener);
  },
  budgetGetStatus: () => ipcRenderer.invoke('budget:getStatus'),
  budgetCheck: () => ipcRenderer.invoke('budget:check'),
  // ESLint
  eslintIsLintable: (workspacePath) => ipcRenderer.invoke('eslint:isLintable', workspacePath),
  eslintLint: (workspacePath, opts) => ipcRenderer.invoke('eslint:lint', workspacePath, opts),
  eslintLintFile: (filePath) => ipcRenderer.invoke('eslint:lintFile', filePath),
  eslintClearCache: (workspacePath) => ipcRenderer.invoke('eslint:clearCache', workspacePath),
  // ---- FFmpeg 媒体工具集 ----
  ffmpegInvoke: (tool, params, workspacePath, sandboxMode) => ipcRenderer.invoke('ffmpeg:invoke', tool, params, workspacePath, sandboxMode),
  ffmpegAvailable: () => ipcRenderer.invoke('ffmpeg:available'),
  onStreamChunk: (cb) => onChannel('llm:stream-chunk', cb),
  onStreamEnd: (cb) => onChannel('llm:stream-end', cb),
  onLLMRetry: (cb) => onChannel('llm:retry', cb),
  // 监听游戏窗口/子窗口的 LLM usage 推送（累计到当前会话统计）
  onLLMExternalUsage: (cb) => onChannel('llm:external-usage', cb),

  // ---- 语音（STT/TTS/唤醒）----
  voiceGetStatus: () => ipcRenderer.invoke('voice:getStatus'),
  voiceSttStart: (opts) => ipcRenderer.invoke('voice:stt:start', opts || {}),
  voiceSttStop: (sessionId) => ipcRenderer.invoke('voice:stt:stop', sessionId),
  voiceSttCancel: (sessionId) => ipcRenderer.invoke('voice:stt:cancel', sessionId),
  voiceSendAudio: (target, sessionId, samples) => ipcRenderer.send('voice:audio', { target, sessionId, samples }),
  voiceTtsSpeak: (data) => ipcRenderer.invoke('voice:tts:speak', data),
  voiceTtsStop: () => ipcRenderer.invoke('voice:tts:stop'),
  voiceWakeSetEnabled: (enabled) => ipcRenderer.invoke('voice:wake:setEnabled', enabled),
  voiceWakeRestart: () => ipcRenderer.invoke('voice:wake:restart'),
  voiceBarOpen: () => ipcRenderer.invoke('voice:bar:open'),
  onVoiceSttPartial: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:stt-partial', listener);
    return () => ipcRenderer.removeListener('voice:stt-partial', listener);
  },
  onVoiceSttFinal: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:stt-final', listener);
    return () => ipcRenderer.removeListener('voice:stt-final', listener);
  },
  onVoiceTtsAudio: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:tts-audio', listener);
    return () => ipcRenderer.removeListener('voice:tts-audio', listener);
  },
  onVoiceTtsDone: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:tts-done', listener);
    return () => ipcRenderer.removeListener('voice:tts-done', listener);
  },
  onVoiceTtsError: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:tts-error', listener);
    return () => ipcRenderer.removeListener('voice:tts-error', listener);
  },
  onVoiceWake: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:wake', listener);
    return () => ipcRenderer.removeListener('voice:wake', listener);
  },
  onVoiceHotkeyToggle: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:hotkey-toggle', listener);
    return () => ipcRenderer.removeListener('voice:hotkey-toggle', listener);
  },
  onVoiceError: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:error', listener);
    return () => ipcRenderer.removeListener('voice:error', listener);
  },

  // Paths
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  platform: process.platform,

  // Dialog
  confirmSensitive: (msg) => ipcRenderer.invoke('dialog:confirm', msg),
  openFileDialog: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  saveFileDialog: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),

  // Chat History
  historyList: () => ipcRenderer.invoke('history:list'),
  historyGet: (id) => ipcRenderer.invoke('history:get', id),
  historySave: (conv) => ipcRenderer.invoke('history:save', conv),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  historyRename: (id, title) => ipcRenderer.invoke('history:rename', id, title),

  // Babe History (独立持久化，含好感度等会话属性)
  babeHistoryList: () => ipcRenderer.invoke('babeHistory:list'),
  babeHistoryGet: (id) => ipcRenderer.invoke('babeHistory:get', id),
  babeHistorySave: (conv) => ipcRenderer.invoke('babeHistory:save', conv),
  babeHistoryDelete: (id) => ipcRenderer.invoke('babeHistory:delete', id),
  babeHistoryRename: (id, title) => ipcRenderer.invoke('babeHistory:rename', id, title),

  // Workspace
  workspaceCreate: () => ipcRenderer.invoke('workspace:create'),
  workspaceGetBase: () => ipcRenderer.invoke('workspace:getBase'),
  workspaceOpenInExplorer: (p) => ipcRenderer.invoke('workspace:openInExplorer', p),
  workspaceGetFileTree: (p) => ipcRenderer.invoke('workspace:getFileTree', p),

  // GeoGebra
  geogebraInit: () => ipcRenderer.invoke('geogebra:init'),
  geogebraEvalCommand: (cmd) => ipcRenderer.invoke('geogebra:evalCommand', cmd),
  geogebraGetAllObjects: () => ipcRenderer.invoke('geogebra:getAllObjects'),
  geogebraDeleteObject: (name) => ipcRenderer.invoke('geogebra:deleteObject', name),
  geogebraExportPNG: (workspacePath) => ipcRenderer.invoke('geogebra:exportPNG', workspacePath),

  // OCR
  ocrRecognize: (imagePath) => ipcRenderer.invoke('ocr:recognize', imagePath),

  // QR Code
  qrScan: (imagePath) => ipcRenderer.invoke('qr:scan', imagePath),
  qrGenerate: (text, workspacePath, filename) => ipcRenderer.invoke('qr:generate', text, workspacePath, filename),

  // Download
  downloadFile: (url, filename, workspacePath) => ipcRenderer.invoke('file:download', url, filename, workspacePath),

  // Aria2 Download Manager（异步下载、状态查询、暂停/恢复/取消）
  aria2: {
    start: () => ipcRenderer.invoke('aria2:start'),
    status: () => ipcRenderer.invoke('aria2:status'),
    addUri: (url, opts) => ipcRenderer.invoke('aria2:add-uri', url, opts),
    tellStatus: (gid) => ipcRenderer.invoke('aria2:tell-status', gid),
    listAll: () => ipcRenderer.invoke('aria2:list-all'),
    pause: (gid, force) => ipcRenderer.invoke('aria2:pause', gid, force),
    unpause: (gid) => ipcRenderer.invoke('aria2:unpause', gid),
    cancel: (gid, force) => ipcRenderer.invoke('aria2:cancel', gid, force),
    removeResult: (gid) => ipcRenderer.invoke('aria2:remove-result', gid),
  },

  // Proxy（代理设置应用 + aria2 同步）
  applyProxy: (proxy) => ipcRenderer.invoke('proxy:apply', proxy),

  // Network Tools
  httpRequest: (opts) => ipcRenderer.invoke('net:httpRequest', opts),
  httpFormPost: (opts) => ipcRenderer.invoke('net:httpFormPost', opts),
  dnsLookup: (hostname, rrtype) => ipcRenderer.invoke('net:dnsLookup', hostname, rrtype),
  ping: (host, count) => ipcRenderer.invoke('net:ping', host, count),
  urlShorten: (url) => ipcRenderer.invoke('net:urlShorten', url),
  urlEncodeDecode: (input, operation) => ipcRenderer.invoke('net:urlEncodeDecode', input, operation),
  checkSSLCert: (hostname, port) => ipcRenderer.invoke('net:checkSSLCert', hostname, port),
  traceroute: (host) => ipcRenderer.invoke('net:traceroute', host),
  portScan: (host, ports, timeout) => ipcRenderer.invoke('net:portScan', host, ports, timeout),

  // Firmware
  firmwareExport: () => ipcRenderer.invoke('firmware:export'),
  
  // Dialog Events (for in-app modals)
  onShowConfirmDialog: (cb) => ipcRenderer.on('show-confirm-dialog', (_, data) => cb(data)),
  sendConfirmDialogResponse: (response) => ipcRenderer.send('confirm-dialog-response', response),
  // File picker dialog uses system dialog now

  // Sanguosha Game
  openSanguosha: (aiCount) => ipcRenderer.invoke('sanguosha:open', aiCount),

  // Flying Flower Game
  openFlyingFlower: (aiCount) => ipcRenderer.invoke('flyingflower:open', aiCount),

  // Undercover Game
  openUndercover: (aiCount) => ipcRenderer.invoke('undercover:open', aiCount),

  // Idiom Chain Game
  openIdiom: (aiCount) => ipcRenderer.invoke('idiom:open', aiCount),

  // Guess Character Game
  openGuessCharacter: (aiCount, category) => ipcRenderer.invoke('guesscharacter:open', aiCount, category),

  // CIPYP-CAD - 2D drafting CAD sub-application
  openCipypCad: () => ipcRenderer.invoke('cipypcad:open'),
  cadRunCommand: (cmd) => ipcRenderer.invoke('cipypcad:runCommand', cmd),
  cadRunCommands: (cmds) => ipcRenderer.invoke('cipypcad:runCommands', cmds),
  cadGetState: () => ipcRenderer.invoke('cipypcad:getState'),
  cadGetObjectList: () => ipcRenderer.invoke('cipypcad:getObjectList'),
  cadSaveProject: (path) => ipcRenderer.invoke('cipypcad:saveProject', path),
  cadSaveProjectDialog: () => ipcRenderer.invoke('cipypcad:saveProjectDialog'),
  cadLoadProject: (path) => ipcRenderer.invoke('cipypcad:loadProject', path),
  cadLoadProjectDialog: () => ipcRenderer.invoke('cipypcad:loadProjectDialog'),
  cadExportDxf: (path) => ipcRenderer.invoke('cipypcad:exportDxf', path),
  cadImportDxfDialog: () => ipcRenderer.invoke('cipypcad:importDxfDialog'),
  cadGetHatchPatterns: () => ipcRenderer.invoke('cipypcad:getHatchPatterns'),
  cadExportImage: (path, format) => ipcRenderer.invoke('cipypcad:exportImage', path, format),
  cadClose: () => ipcRenderer.invoke('cipypcad:close'),
  cadAgentClose: () => ipcRenderer.invoke('cipypcad:agentClose'),

  // CIBYP-PCB-EDA - PCB design sub-application (schematic + layout + Gerber)
  openPcbEda: () => ipcRenderer.invoke('pcbeda:open'),
  pcbRunCommand: (cmd) => ipcRenderer.invoke('pcbeda:runCommand', cmd),
  pcbRunCommands: (cmds) => ipcRenderer.invoke('pcbeda:runCommands', cmds),
  pcbGetState: () => ipcRenderer.invoke('pcbeda:getState'),
  pcbSaveProject: (path, multi) => ipcRenderer.invoke('pcbeda:saveProject', path, multi),
  pcbLoadProject: (path) => ipcRenderer.invoke('pcbeda:loadProject', path),
  pcbExportFiles: (dir, files, zipName) => ipcRenderer.invoke('pcbeda:exportFiles', dir, files, zipName),
  pcbWriteFile: (path, content) => ipcRenderer.invoke('pcbeda:writeFile', path, content),
  pcbExportGerber: (dir, baseName, options, zipName) => ipcRenderer.invoke('pcbeda:exportGerber', dir, baseName, options, zipName),
  pcbExportTextFile: (kind, path, baseName) => ipcRenderer.invoke('pcbeda:exportTextFile', kind, path, baseName),
  pcbImportFile: (path) => ipcRenderer.invoke('pcbeda:importFile', path),
  pcbClose: () => ipcRenderer.invoke('pcbeda:close'),
  pcbAgentClose: () => ipcRenderer.invoke('pcbeda:agentClose'),

  // MCP
  mcpListServers: () => ipcRenderer.invoke('mcp:listServers'),
  mcpAddServer: (config) => ipcRenderer.invoke('mcp:addServer', config),
  mcpRemoveServer: (name) => ipcRenderer.invoke('mcp:removeServer', name),
  mcpUpdateServer: (name, updates) => ipcRenderer.invoke('mcp:updateServer', name, updates),
  mcpConnect: (name) => ipcRenderer.invoke('mcp:connect', name),
  mcpDisconnect: (name) => ipcRenderer.invoke('mcp:disconnect', name),
  mcpListTools: (serverName) => ipcRenderer.invoke('mcp:listTools', serverName),
  // ---- DeepSeek 插件 ----
  dsListPlugins: () => ipcRenderer.invoke('plugins:list'),
  dsInstallLocal: (dirPath) => ipcRenderer.invoke('plugins:installLocal', dirPath),
  dsInstallNpm: (name) => ipcRenderer.invoke('plugins:installNpm', name),
  dsInstallGithub: (repo) => ipcRenderer.invoke('plugins:installGithub', repo),
  dsInstallTgz: (filePath) => ipcRenderer.invoke('plugins:installTgz', filePath),
  dsSetPluginEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
  dsUninstallPlugin: (id) => ipcRenderer.invoke('plugins:uninstall', id),
  dsSetPluginConfig: (id, patch) => ipcRenderer.invoke('plugins:setConfig', id, patch),
  dsListPluginTools: () => ipcRenderer.invoke('ds:listTools'),
  dsPluginToolCall: (pluginId, toolName, args, cwd, sandboxMode, sessionKey) => ipcRenderer.invoke('ds:toolCall', pluginId, toolName, args, { cwd, sandboxMode, sessionKey }),
  dsAgentSync: (entries) => ipcRenderer.invoke('ds:agentsSync', entries),
  dsApprovalRespond: (id, outcome) => ipcRenderer.invoke('ds:approvalRespond', id, outcome),
  automationList: () => ipcRenderer.invoke('automation:list'),
  automationSave: (task) => ipcRenderer.invoke('automation:save', task),
  automationDelete: (id) => ipcRenderer.invoke('automation:delete', id),
  automationSetEnabled: (id, enabled) => ipcRenderer.invoke('automation:setEnabled', id, enabled),
  automationRun: (id, params) => ipcRenderer.invoke('automation:run', id, params),
  automationTest: (task, params) => ipcRenderer.invoke('automation:test', task, params),
  detectEnvironment: () => ipcRenderer.invoke('env:detect'),
  onPluginsChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('plugins:changed', listener);
    return () => ipcRenderer.removeListener('plugins:changed', listener);
  },
  onPluginsInstallProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('plugins:installProgress', listener);
    return () => ipcRenderer.removeListener('plugins:installProgress', listener);
  },
  onDsAgentMessage: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('ds:pluginAgentMessage', listener);
    return () => ipcRenderer.removeListener('ds:pluginAgentMessage', listener);
  },
  onDsApprovalRequest: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('ds:approvalRequest', listener);
    return () => ipcRenderer.removeListener('ds:approvalRequest', listener);
  },
  onAutomationDispatch: (cb) => {
    const listener = (_event, payload) => {
      if (!payload || !payload.requestId) return;
      Promise.resolve(cb(payload)).then(
        (result) => ipcRenderer.send('automation:dispatched', payload.requestId, result || {}),
        (error) => ipcRenderer.send('automation:dispatched', payload.requestId, { error: error && error.message ? error.message : String(error) })
      );
    };
    ipcRenderer.on('automation:dispatch', listener);
    return () => ipcRenderer.removeListener('automation:dispatch', listener);
  },
  mcpCallTool: (serverName, toolName, args) => ipcRenderer.invoke('mcp:callTool', serverName, toolName, args),
  mcpGetStatus: () => ipcRenderer.invoke('mcp:getStatus'),

  // Serial Port
  serialListPorts: () => ipcRenderer.invoke('serial:listPorts'),
  serialOpenPort: (path, options) => ipcRenderer.invoke('serial:openPort', path, options),
  serialWritePort: (path, data, encoding) => ipcRenderer.invoke('serial:writePort', path, data, encoding),
  serialReadPort: (path, timeout, encoding) => ipcRenderer.invoke('serial:readPort', path, timeout, encoding),
  serialClosePort: (path) => ipcRenderer.invoke('serial:closePort', path),
  serialSetSignals: (path, signals) => ipcRenderer.invoke('serial:setSignals', path, signals),

  // Office
  officeUnpack: (path) => ipcRenderer.invoke('office:unpack', path),
  officeListContents: (dir) => ipcRenderer.invoke('office:listContents', dir),
  officeRepack: (dir, outputPath) => ipcRenderer.invoke('office:repack', dir, outputPath),
  officeGetSlideTexts: (dir, slideFile) => ipcRenderer.invoke('office:getSlideTexts', dir, slideFile),
  officeSetSlideTexts: (dir, slideFile, translations) => ipcRenderer.invoke('office:setSlideTexts', dir, slideFile, translations),
  officeWordExtract: (pathOrDir, options) => ipcRenderer.invoke('office:wordExtract', pathOrDir, options),
  officeWordApplyTexts: (pathOrDir, updates) => ipcRenderer.invoke('office:wordApplyTexts', pathOrDir, updates),
  officeWordGetStyles: (pathOrDir) => ipcRenderer.invoke('office:wordGetStyles', pathOrDir),
  officeWordFillTemplate: (pathOrDir, replacements) => ipcRenderer.invoke('office:wordFillTemplate', pathOrDir, replacements),

  // Office-Word（正规库）
  wordExtractText: (path, format) => ipcRenderer.invoke('word:extractText', path, format),
  wordCreate: (spec, workspacePath) => ipcRenderer.invoke('word:create', spec, workspacePath),
  wordFillTemplate: (templatePath, outputPath, data, workspacePath) => ipcRenderer.invoke('word:fillTemplate', templatePath, outputPath, data, workspacePath),
  wordGetMetadata: (path) => ipcRenderer.invoke('word:getMetadata', path),
  wordListStyles: (path) => ipcRenderer.invoke('word:listStyles', path),

  // PPT Maker
  pptMakerCreate: (spec, workspacePath) => ipcRenderer.invoke('ppt:create', spec, workspacePath),

  // Spreadsheet File I/O
  spreadsheetImportFile: (filePath) => ipcRenderer.invoke('spreadsheet:importFile', filePath),
  spreadsheetExportFile: (filePath, cells, sheetName) => ipcRenderer.invoke('spreadsheet:exportFile', filePath, cells, sheetName),

  // Email
  emailGenerateTOTP: () => ipcRenderer.invoke('email:generateTOTP'),
  emailSaveTOTPSecret: (secret) => ipcRenderer.invoke('email:saveTOTPSecret', secret),
  emailVerifyTOTP: (code) => ipcRenderer.invoke('email:verifyTOTP', code),
  emailConnect: () => ipcRenderer.invoke('email:connect'),
  emailDisconnect: () => ipcRenderer.invoke('email:disconnect'),
  emailSend: (to, subject, html, text) => ipcRenderer.invoke('email:send', to, subject, html, text),
  emailFetchNew: () => ipcRenderer.invoke('email:fetchNew'),
  emailStartPolling: () => ipcRenderer.invoke('email:startPolling'),
  emailStopPolling: () => ipcRenderer.invoke('email:stopPolling'),
  emailRequestApproval: (toolName, args, chatMd) => ipcRenderer.invoke('email:requestApproval', toolName, args, chatMd),
  emailSendConversation: (messages, title) => ipcRenderer.invoke('email:sendConversation', messages, title),
  onEmailReceived: (cb) => ipcRenderer.on('email:received', (_, email) => cb(email)),

  // Web Control
  webControlStart: () => ipcRenderer.invoke('webControl:start'),
  webControlStop: () => ipcRenderer.invoke('webControl:stop'),
  webControlReconfigure: () => ipcRenderer.invoke('webControl:reconfigure'),
  webControlGetStatus: () => ipcRenderer.invoke('webControl:getStatus'),
  webControlHashPassword: (password) => ipcRenderer.invoke('webControl:hashPassword', password),
  webControlGenerateTOTP: () => ipcRenderer.invoke('webControl:generateTOTP'),
  webControlVerifyTOTP: (code) => ipcRenderer.invoke('webControl:verifyTOTP', code),
  webControlPushMessage: (role, content, extra) => ipcRenderer.send('webControl:pushMessage', role, content, extra),
  webControlPushStatus: (status) => ipcRenderer.send('webControl:pushStatus', status),
  webControlPushApproval: (toolName, args) => ipcRenderer.send('webControl:pushApproval', toolName, args),
  webControlClearApproval: () => ipcRenderer.send('webControl:clearApproval'),
  webControlPushToolCall: (toolName, args, status, result) => ipcRenderer.send('webControl:pushToolCall', toolName, args, status, result),
  webControlPushConversationSwitch: (conversationId) => ipcRenderer.send('webControl:pushConversationSwitch', conversationId),
  webControlPushHistoryMessages: (messages) => ipcRenderer.send('webControl:pushHistoryMessages', messages),
  webControlPushTheme: (vars) => ipcRenderer.send('webControl:pushTheme', vars),
  webControlPushTarot: (card) => ipcRenderer.send('webControl:pushTarot', card),
  webControlPushTitle: (title) => ipcRenderer.send('webControl:pushTitle', title),
  webControlSetWorkDir: (dir) => ipcRenderer.send('webControl:setWorkDir', dir),
  webControlSetAvatars: (avatars) => ipcRenderer.send('webControl:setAvatars', avatars),
  webControlPushModeSwitch: (mode) => ipcRenderer.send('webControl:pushModeSwitch', mode),
  webControlPushContextProgress: (data) => ipcRenderer.send('webControl:pushContextProgress', data),
  webControlPushReoptimizeState: (visible) => ipcRenderer.send('webControl:pushReoptimizeState', visible),
  webControlPushOskState: (state) => ipcRenderer.send('webControl:pushOskState', state),
  onWebControlToggleOsk: (cb) => ipcRenderer.on('webControl:toggleOsk', () => cb()),
  onWebControlSwitchMode: (cb) => ipcRenderer.on('webControl:switchMode', (_, mode) => cb(mode)),
  onWebControlReoptimizeTools: (cb) => ipcRenderer.on('webControl:reoptimizeTools', () => cb()),
  avatarPickAndEncode: () => ipcRenderer.invoke('avatar:pickAndEncode'),
  avatarEncodeFile: (filePath) => ipcRenderer.invoke('avatar:encodeFile', filePath),
  onWebControlNewChat: (cb) => ipcRenderer.on('webControl:newChat', () => cb()),
  onWebControlSendMessage: (cb) => ipcRenderer.on('webControl:sendMessage', (_, message) => cb(message)),
  onWebControlStopAgent: (cb) => ipcRenderer.on('webControl:stopAgent', () => cb()),
  onWebControlApprovalResponse: (cb) => ipcRenderer.on('webControl:approvalResponse', (_, approved) => cb(approved)),
  onWebControlLoadConversation: (cb) => ipcRenderer.on('webControl:loadConversation', (_, id) => cb(id)),
  // DOM Mirror: renderer listens for mirror-init trigger, sends mirror updates, receives UI events from WebUI
  webControlMirrorInit: (cb) => ipcRenderer.on('webControl:mirrorInit', () => cb()),
  webControlUiEvent: (data) => ipcRenderer.send('webControl:uiEvent', data),
  webControlMirrorUpdate: (data) => ipcRenderer.send('webControl:mirrorUpdate', data),
  onWebControlUiEvent: (cb) => ipcRenderer.on('webControl:uiEvent', (_, data) => cb(data)),
  onWebControlFileUploaded: (cb) => ipcRenderer.on('webControl:fileUploaded', (_, data) => cb(data)),
  onGameFinished: (cb) => ipcRenderer.on('game:finished', (_, data) => cb(data)),

  // 语音条：把识别文本填入当前模式输入框 / 自动发送
  onVoiceBarFill: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('voice:bar:fill', listener);
    return () => ipcRenderer.removeListener('voice:bar:fill', listener);
  },

  // Pending Session: 异常中断时保存正在工作的会话，启动时弹模态框询问是否继续
  onSavePending: (cb) => ipcRenderer.on('agent:save-pending', () => cb()),
  savePendingSession: (payload) => ipcRenderer.invoke('agent:save-pending-session', payload),
  skipPending: () => ipcRenderer.invoke('agent:skip-pending'),
  getPendingSession: () => ipcRenderer.invoke('agent:get-pending-session'),
  clearPendingSession: () => ipcRenderer.invoke('agent:clear-pending-session'),

  // Notifications: 系统桌面通知（敏感操作/会话完成/问卷/文件呈递等需用户干预时）
  sendNotification: (opts) => ipcRenderer.invoke('notifications:send', opts),
  onNotificationClick: (cb) => ipcRenderer.on('notifications:click', (_, data) => cb(data)),
});
