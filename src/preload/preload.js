/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),

  // Theme
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_, data) => cb(data)),

  // Window Controls
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Memory
  memorySearch: (q) => ipcRenderer.invoke('memory:search', q),
  memoryAdd: (item) => ipcRenderer.invoke('memory:add', item),
  memoryDelete: (id) => ipcRenderer.invoke('memory:delete', id),
  memoryUpdate: (id, data) => ipcRenderer.invoke('memory:update', { id, data }),

  // Knowledge Base
  knowledgeSearch: (q) => ipcRenderer.invoke('knowledge:search', q),
  knowledgeAdd: (item) => ipcRenderer.invoke('knowledge:add', item),
  knowledgeDelete: (id) => ipcRenderer.invoke('knowledge:delete', id),
  knowledgeUpdate: (id, data) => ipcRenderer.invoke('knowledge:update', { id, data }),
  knowledgeImportFile: (p, workspacePath) => ipcRenderer.invoke('knowledge:importFile', p, workspacePath),

  // File System
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  createFile: (p, c) => ipcRenderer.invoke('fs:createFile', p, c),
  deleteFile: (p) => ipcRenderer.invoke('fs:deleteFile', p),
  moveFile: (s, d) => ipcRenderer.invoke('fs:moveFile', s, d),
  copyFile: (s, d) => ipcRenderer.invoke('fs:copyFile', s, d),
  listDirectory: (p) => ipcRenderer.invoke('fs:listDirectory', p),
  makeDirectory: (p) => ipcRenderer.invoke('fs:makeDirectory', p),
  deleteDirectory: (p) => ipcRenderer.invoke('fs:deleteDirectory', p),
  localSearch: (dir, pattern, options) => ipcRenderer.invoke('fs:localSearch', dir, pattern, options),
  readFileBase64: (p) => ipcRenderer.invoke('fs:readFileBase64', p),
  saveUploadedFile: (name, data) => ipcRenderer.invoke('fs:saveUploadedFile', name, data),

  // Terminal
  makeTerminal: () => ipcRenderer.invoke('terminal:make'),
  runTerminalCommand: (id, cmd) => ipcRenderer.invoke('terminal:run', id, cmd),
  awaitTerminalCommand: (id, cmd) => ipcRenderer.invoke('terminal:await', id, cmd),
  killTerminal: (id) => ipcRenderer.invoke('terminal:kill', id),

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
  runJS: (code) => ipcRenderer.invoke('code:runJS', code),
  runNodeJS: (code) => ipcRenderer.invoke('code:runNodeJS', code),
  runShell: (script) => ipcRenderer.invoke('code:runShell', script),

  // Image Generation
  generateImage: (prompt, workspacePath) => ipcRenderer.invoke('image:generate', prompt, workspacePath),

  // Web
  webSearch: (q, workspacePath) => ipcRenderer.invoke('web:search', q, workspacePath),
  webFetch: (url) => ipcRenderer.invoke('web:fetch', url),
  webOffscreenSnapshotOCR: (options) => ipcRenderer.invoke('web:offscreenSnapshotOCR', options),
  webOffscreenRenderedContent: (options) => ipcRenderer.invoke('web:offscreenRenderedContent', options),

  // Tarot
  drawTarot: () => ipcRenderer.invoke('tarot:draw'),

  // TRNG
  trngListPorts: () => ipcRenderer.invoke('trng:listPorts'),
  trngTest: () => ipcRenderer.invoke('trng:test'),

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  createSkill: (s) => ipcRenderer.invoke('skills:create', s),
  deleteSkill: (id) => ipcRenderer.invoke('skills:delete', id),
  updateSkill: (id, data) => ipcRenderer.invoke('skills:update', id, data),

  // LLM
  chatLLM: (messages, options) => ipcRenderer.invoke('llm:chat', messages, options),
  chatLLMStream: (messages, options) => ipcRenderer.invoke('llm:chatStream', messages, options),
  onStreamChunk: (cb) => ipcRenderer.on('llm:stream-chunk', (_, data) => cb(data)),
  onStreamEnd: (cb) => ipcRenderer.on('llm:stream-end', (_, data) => cb(data)),

  // Paths
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

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

  // Network Tools
  httpRequest: (opts) => ipcRenderer.invoke('net:httpRequest', opts),
  httpFormPost: (opts) => ipcRenderer.invoke('net:httpFormPost', opts),
  dnsLookup: (hostname, rrtype) => ipcRenderer.invoke('net:dnsLookup', hostname, rrtype),
  ping: (host, count) => ipcRenderer.invoke('net:ping', host, count),
  whois: (domain) => ipcRenderer.invoke('net:whois', domain),
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

  // MCP
  mcpListServers: () => ipcRenderer.invoke('mcp:listServers'),
  mcpAddServer: (config) => ipcRenderer.invoke('mcp:addServer', config),
  mcpRemoveServer: (name) => ipcRenderer.invoke('mcp:removeServer', name),
  mcpUpdateServer: (name, updates) => ipcRenderer.invoke('mcp:updateServer', name, updates),
  mcpConnect: (name) => ipcRenderer.invoke('mcp:connect', name),
  mcpDisconnect: (name) => ipcRenderer.invoke('mcp:disconnect', name),
  mcpListTools: (serverName) => ipcRenderer.invoke('mcp:listTools', serverName),
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
  avatarPickAndEncode: () => ipcRenderer.invoke('avatar:pickAndEncode'),
  avatarEncodeFile: (filePath) => ipcRenderer.invoke('avatar:encodeFile', filePath),
  onWebControlNewChat: (cb) => ipcRenderer.on('webControl:newChat', () => cb()),
  onWebControlSendMessage: (cb) => ipcRenderer.on('webControl:sendMessage', (_, message) => cb(message)),
  onWebControlStopAgent: (cb) => ipcRenderer.on('webControl:stopAgent', () => cb()),
  onWebControlApprovalResponse: (cb) => ipcRenderer.on('webControl:approvalResponse', (_, approved) => cb(approved)),
  onWebControlLoadConversation: (cb) => ipcRenderer.on('webControl:loadConversation', (_, id) => cb(id)),
  onGameFinished: (cb) => ipcRenderer.on('game:finished', (_, data) => cb(data)),
});
