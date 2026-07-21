/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// ---- Dynamic MCP Tool Registry ----
const MCP_DYNAMIC_TOOLS = [];   // { name, desc, icon, category, sensitive, serverName, mcpToolName, inputSchema }
const MCP_DYNAMIC_SCHEMAS = {};  // name → OpenAI-format schema

function clearMcpDynamicTools() {
  MCP_DYNAMIC_TOOLS.length = 0;
  Object.keys(MCP_DYNAMIC_SCHEMAS).forEach(k => delete MCP_DYNAMIC_SCHEMAS[k]);
}

/**
 * Register MCP tools fetched from connected servers.
 * Each MCP tool is converted to a first-class tool definition + schema.
 * Name format: mcp__<serverName>__<toolName> (double-underscore to avoid clash)
 */
function registerMcpTools(toolsList) {
  // toolsList: [{ name, description, inputSchema, serverName }]
  clearMcpDynamicTools();
  for (const t of toolsList) {
    const safeName = `mcp__${t.serverName}__${t.name}`;
    MCP_DYNAMIC_TOOLS.push({
      name: safeName,
      desc: `[MCP:${t.serverName}] ${t.description || t.name}`,
      icon: 'fa-plug',
      category: `MCP:${t.serverName}`,
      sensitive: false,
      serverName: t.serverName,
      mcpToolName: t.name,
      dynamic: true
    });
    // Build OpenAI-format schema from MCP inputSchema
    const params = t.inputSchema && typeof t.inputSchema === 'object'
      ? t.inputSchema
      : { type: 'object', properties: {}, required: [] };
    MCP_DYNAMIC_SCHEMAS[safeName] = {
      type: 'function',
      function: {
        name: safeName,
        description: `[MCP:${t.serverName}] ${t.description || t.name}`,
        parameters: params
      }
    };
  }
}

function getAllToolDefinitions(mode) {
  return [...TOOL_DEFINITIONS, ...MCP_DYNAMIC_TOOLS].filter(t => isToolAvailableForMode(t.name, mode));
}

// Tools exclusive to Chat mode (UI-heavy: entertainment, drawing, office, serial, browser).
// Code mode only exposes file/code/terminal/network/system utilities.
const CHAT_ONLY_TOOLS = new Set([
  'getTarot', 'generateImage', 'inviteGame',
  // Geogebra
  'initGeogebra', 'runGeogebraCommand', 'getFunctionsFromGeogebra',
  'addFunctionToGeogebra', 'updateFunctionInGeogebra', 'deleteFunctionFromGeogebra',
  'getCurrentGraphFromGeogebra', 'getCurrentGraphDataFromGeogebra',
  // Canvas
  'initCanvas', 'clearCanvas', 'addCanvasObject', 'updateCanvasObject',
  'deleteCanvasObject', 'exportCanvasSVG',
  // Spreadsheet
  'initSpreadsheet', 'spreadsheetSetCells', 'spreadsheetGetCells',
  'spreadsheetSetCellFormat', 'spreadsheetSetRangeFormat', 'spreadsheetClearCells',
  'spreadsheetInsertRows', 'spreadsheetDeleteRows', 'spreadsheetInsertCols',
  'spreadsheetDeleteCols', 'spreadsheetSortRange', 'spreadsheetGetData',
  'spreadsheetExportCSV', 'spreadsheetImportCSV', 'spreadsheetImportFile', 'spreadsheetExportFile',
  // Office
  'officeUnpack', 'officeListContents', 'officeReadInnerFile', 'officeWriteInnerFile',
  'officeRepack', 'officeGetSlideTexts', 'officeSetSlideTexts', 'officeWordExtract',
  'officeWordApplyTexts', 'officeWordGetStyles', 'officeWordFillTemplate',
  // Serial
  'serialListPorts', 'serialOpenPort', 'serialWritePort', 'serialReadPort',
  'serialClosePort', 'serialSetSignals',
  // Built-in browser (Playwright)
  'browserNavigate', 'browserScreenshot', 'browserClick', 'browserType',
  'browserGetContent', 'browserScroll', 'browserBack', 'browserForward',
  'browserRefresh', 'browserEvaluate', 'browserWait', 'browserHover',
  'browserSelect', 'browserGetInfo', 'browserClose',
  // CIPYP-CAD
  'initCipypCad', 'runCipypCadCommand', 'runCipypCadCommands', 'getCipypCadState',
  'getCadObjectList', 'saveCipypCadProject', 'loadCipypCadProject',
  'exportCipypCadDxf', 'exportCipypCadImage', 'closeCipypCad',
  // CIBYP-PCB-EDA
  'initPcbEda', 'closePcbEda', 'pcbNewProject', 'pcbSetDesignRules', 'pcbSetStackup', 'pcbSetOutline',
  'pcbSchAddSymbol', 'pcbSchAddWire', 'pcbSchAddLabel', 'pcbSchAddPower', 'pcbSchAnnotate', 'pcbSchSync', 'pcbRunERC',
  'pcbAddComponent', 'pcbMoveComponent', 'pcbRotateComponent', 'pcbDeleteComponent', 'pcbListComponents',
  'pcbSetPadNet', 'pcbRouteTrace', 'pcbAddVia', 'pcbAddCopperPour', 'pcbAddSilkscreen',
  'pcbRunDRC', 'pcbAutoroute', 'pcbGetBoardInfo', 'pcbListLibrary',
  'pcbSaveProject', 'pcbLoadProject', 'pcbImportFile', 'pcbExportGerber', 'pcbExportFile',
  'runPcbEdaCommand', 'runPcbEdaCommands'
]);

function isToolAvailableForMode(toolName, mode) {
  if (!mode) return true;
  // Babe 模式优先使用自己的白名单（允许包含 CHAT_ONLY_TOOLS 中的塔罗牌等）
  if (mode === 'babe') {
    return BABE_ALLOWED_TOOLS.has(toolName);
  }
  // Code 模式使用独立白名单（参考 Claude Code 工具集，不与 Chat 共用）
  // MCP 动态工具（mcp__前缀）始终可用，不受白名单限制
  if (mode === 'code') {
    if (toolName.startsWith('mcp__')) return true;
    return CODE_TOOLS.has(toolName);
  }
  if (CHAT_ONLY_TOOLS.has(toolName)) return mode === 'chat';
  return true;
}

/**
 * 返回工具的"首次使用授权"类别。
 * - 'playwright'：内置浏览器（Playwright）工具集
 * - 'computerUse'：电脑控制（Computer Use Protocol）工具
 * - null：无需首次授权
 *
 * 工具在 TOOL_DEFINITIONS 中通过 requiresAuth 字段声明类别。
 * agent.js 在 executeTool 调用前据此判断是否触发授权模态框。
 */
function getToolAuthCategory(toolName) {
  if (!toolName) return null;
  const def = TOOL_DEFINITIONS.find(t => t.name === toolName);
  if (!def) return null;
  const cat = def.requiresAuth;
  if (cat === 'playwright' || cat === 'computerUse') return cat;
  return null;
}

// 未配置生图模型时隐藏 generateImage 工具，避免 LLM 调用后失败
function isImageGenConfigured(settings) {
  const img = settings?.imageGen;
  return !!(img && img.apiUrl && img.apiKey && img.model);
}

// 供 agent.js 在 getRuntimeToolSchemas 时调用，过滤掉未配置的生图工具
function filterToolsByConfig(tools, settings) {
  let filtered = tools;
  // .no-tarot 构建版本：过滤掉 getTarot 工具（主进程 tarot:draw 也会拒绝调用作为兜底）
  if (typeof window !== 'undefined' && window.NO_TAROT_BUILD === true) {
    filtered = filtered.filter(t => t.function?.name !== 'getTarot');
  }
  if (isImageGenConfigured(settings)) return filtered;
  return filtered.filter(t => t.function?.name !== 'generateImage');
}

// Code 模式独立工具白名单（参考 Claude Code 工具集，不与 Chat 共用）
// Code 模式聚焦文件编辑、代码搜索、终端执行和上下文管理，排除娱乐/UI-heavy 工具。
// MCP 动态工具由 getAllToolDefinitions 自动追加（不受此白名单限制，按 mode 过滤时 dynamic=true 跳过检查）。
const CODE_TOOLS = new Set([
  // 文件操作（Read/Write/Edit/Delete/Move/Copy — 对标 Claude Code 的 Read/Write/Edit）
  'readFile', 'createFile', 'editFile', 'multiEditFile', 'presentFile', 'readImageFile', 'deleteFile', 'moveFile', 'copyFile',
  'listDirectory', 'makeDirectory', 'deleteDirectory',
  'localSearch',  // 文件名搜索（对标 Claude Code 的 LS）
  'searchInFiles',  // 文件内容搜索（对标 Claude Code 的 Grep）
  // 代码执行
  'runJavaScriptCode', 'runNodeJavaScriptCode', 'runShellScriptCode',
  // 终端（对标 Claude Code 的 Bash）
  'makeTerminal', 'runTerminalCommand', 'awaitTerminalCommand', 'killTerminal',
  // 网络（代码任务常需搜索文档/获取依赖信息）
  'webSearch', 'webFetch', 'downloadFile', 'httpRequest',
  // 知识库（代码片段/项目知识）
  'knowledgeBaseSearch', 'knowledgeBaseAdd',
  // 记忆（跨会话记住项目约定）
  'memorySearch', 'memoryAdd', 'memoryUpdate', 'memoryDelete',
  // 上下文管理 + 子代理 + 待办（对标 Claude Code 的 Task/TodoWrite）
  'manageContext', 'autoSummarizeContext', 'runSubAgent', 'todoList',
  // 目标跟踪（长任务拆解）
  'goalSet', 'goalStatus', 'goalComplete',
  // 技能（Code 模式可用技能脚本）
  'listSkills', 'runSkillScript', 'activateSkill', 'deactivateSkill',
  // 系统信息
  'getSystemInfo', 'getNetworkStatus', 'openFileExplorer',
  // 内置 ESLint 代码诊断（Code 模式特有）
  'eslintLint', 'eslintLintFile',
  // MCP 工具列表
  'mcpListTools',
  // 效率
  'sleep',
  // 询问用户（复杂任务需澄清需求）
  'askQuestions',
]);

// Babe 模式允许的工具白名单（仅应用内核心工具，无 MCP、无娱乐/创作/游戏，不含 Skills）
const BABE_ALLOWED_TOOLS = new Set([
  // 记忆
  'saveMemory', 'readMemory', 'listMemories', 'deleteMemory',
  // 网络
  'webSearch', 'webFetch',
  // 知识
  'searchKnowledge', 'addKnowledge',
  // 文件（基础）
  'readFile', 'writeFile', 'listFiles',
  // 画布（简单绘图）
  'initCanvas', 'clearCanvas', 'addCanvasObject', 'updateCanvasObject', 'deleteCanvasObject', 'exportCanvasSVG',
  // 图片生成（可选，让 Babe 能发图）
  'generateImage',
  // 塔罗牌（Babe 模式特有，允许 LLM 主动抽牌）
  'getTarot',
  // 上下文管理（与 Chat/Code 对齐：三层自动压缩 + 手动 LLM 摘要）
  'manageContext', 'autoSummarizeContext',
  // 主题外观（Chat/Babe 共用，LLM 可主动调节深浅色/强调色/配色）
  'adjustAppearance'
]);

// Tool definitions for the AI Agent
const TOOL_DEFINITIONS = [
  { name: 'getTarot', desc: '抽取塔罗牌', icon: 'fa-star', category: '娱乐', sensitive: false },
  { name: 'todoList', desc: '管理待办事项', icon: 'fa-list-check', category: '效率', sensitive: false },
  { name: 'runSubAgent', desc: '运行子代理', icon: 'fa-users', category: '代理', sensitive: false },
  { name: 'generateImage', desc: '生成图片', icon: 'fa-image', category: '创作', sensitive: false },
  { name: 'calculator', desc: '精确计算表达式（本地）', icon: 'fa-calculator', category: '计算', sensitive: false },
  { name: 'factorInteger', desc: '整数质因数分解', icon: 'fa-divide', category: '计算', sensitive: false },
  { name: 'gcdLcm', desc: '计算最大公约数/最小公倍数', icon: 'fa-superscript', category: '计算', sensitive: false },
  { name: 'baseConvert', desc: '进制转换（2~36）', icon: 'fa-right-left', category: '计算', sensitive: false },
  { name: 'factorial', desc: '阶乘计算（n!）', icon: 'fa-square-root-variable', category: '计算', sensitive: false },
  { name: 'complexMath', desc: '复数运算（加减乘除/幂/模/幅角等）', icon: 'fa-wave-square', category: '计算', sensitive: false },
  { name: 'matrixMath', desc: '矩阵运算（支持自定义行列）', icon: 'fa-table-cells-large', category: '计算', sensitive: false },
  { name: 'vectorMath', desc: '向量运算（支持自定义维数与混合积）', icon: 'fa-arrows-up-down-left-right', category: '计算', sensitive: false },
  { name: 'solveInequality', desc: '不等式求解（线性/二次）', icon: 'fa-not-equal', category: '计算', sensitive: false },
  { name: 'solveLinearSystem', desc: '线性方程组求解', icon: 'fa-equals', category: '计算', sensitive: false },
  { name: 'solvePolynomial', desc: '多项式方程求根（1~4次，含复数）', icon: 'fa-superscript', category: '计算', sensitive: false },
  { name: 'distributionCalc', desc: '概率分布计算（正态/二项/泊松/均匀）', icon: 'fa-chart-area', category: '计算', sensitive: false },
  { name: 'combinatorics', desc: '排列组合计算', icon: 'fa-shuffle', category: '计算', sensitive: false },
  { name: 'fractionBaseConvert', desc: '分数（非整数）进制转换', icon: 'fa-repeat', category: '计算', sensitive: false },
  { name: 'webSearch', desc: '后台Bing搜索', icon: 'fa-magnifying-glass', category: '网络', sensitive: false },
  { name: 'webFetch', desc: '获取网页数据', icon: 'fa-download', category: '网络', sensitive: true },
  { name: 'offscreenRenderOCR', desc: '离屏打开URL渲染并OCR', icon: 'fa-camera-retro', category: '网络', sensitive: false },
  { name: 'offscreenRenderContent', desc: '离屏打开URL渲染并提取页面内容（不OCR）', icon: 'fa-file-lines', category: '网络', sensitive: false },
  { name: 'knowledgeBaseSearch', desc: '搜索知识库', icon: 'fa-database', category: '知识', sensitive: false },
  { name: 'knowledgeBaseAdd', desc: '添加知识', icon: 'fa-plus', category: '知识', sensitive: false },
  { name: 'knowledgeBaseDelete', desc: '删除知识', icon: 'fa-trash-can', category: '知识', sensitive: true },
  { name: 'knowledgeBaseUpdate', desc: '更新知识', icon: 'fa-pen', category: '知识', sensitive: false },
  { name: 'memorySearch', desc: '搜索记忆', icon: 'fa-brain', category: '记忆', sensitive: false },
  { name: 'memoryAdd', desc: '添加记忆', icon: 'fa-plus', category: '记忆', sensitive: false },
  { name: 'memoryDelete', desc: '删除记忆', icon: 'fa-trash-can', category: '记忆', sensitive: true },
  { name: 'memoryUpdate', desc: '更新记忆', icon: 'fa-pen', category: '记忆', sensitive: false },
  { name: 'localSearch', desc: '搜索本地文件', icon: 'fa-folder-open', category: '文件', sensitive: false },
  { name: 'searchInFiles', desc: '文件内搜索（grep风格，搜索文件内容）', icon: 'fa-magnifying-glass', category: '文件', sensitive: false },
  { name: 'readFile', desc: '读取文件', icon: 'fa-file', category: '文件', sensitive: false },
  { name: 'editFile', desc: '编辑文件', icon: 'fa-file-pen', category: '文件', sensitive: true },
  { name: 'multiEditFile', desc: '批量编辑文件', icon: 'fa-file-pen', category: '文件', sensitive: true },
  { name: 'presentFile', desc: '文件呈递器', icon: 'fa-file-export', category: '文件', sensitive: false },
  { name: 'readImageFile', desc: '读取图片文件（多模态：图片直接注入上下文）', icon: 'fa-file-image', category: '文件', sensitive: false },
  { name: 'createFile', desc: '创建文件', icon: 'fa-file-circle-plus', category: '文件', sensitive: false },
  { name: 'deleteFile', desc: '删除文件', icon: 'fa-file-circle-minus', category: '文件', sensitive: true },
  { name: 'moveFile', desc: '移动/重命名文件', icon: 'fa-file-export', category: '文件', sensitive: true },
  { name: 'copyFile', desc: '复制文件', icon: 'fa-copy', category: '文件', sensitive: false },
  { name: 'listDirectory', desc: '列出目录', icon: 'fa-folder', category: '文件', sensitive: false },
  { name: 'makeDirectory', desc: '创建目录', icon: 'fa-folder-plus', category: '文件', sensitive: false },
  { name: 'deleteDirectory', desc: '删除目录', icon: 'fa-folder-minus', category: '文件', sensitive: true },
  { name: 'runJavaScriptCode', desc: '运行JS代码', icon: 'fa-code', category: '代码', sensitive: false },
  { name: 'runNodeJavaScriptCode', desc: '运行JS代码(Node.js,需确认)', icon: 'fa-code', category: '代码', sensitive: true },
  { name: 'runShellScriptCode', desc: '运行Shell脚本', icon: 'fa-terminal', category: '代码', sensitive: true },
  { name: 'makeTerminal', desc: '创建终端', icon: 'fa-terminal', category: '终端', sensitive: false },
  { name: 'runTerminalCommand', desc: '执行终端命令', icon: 'fa-play', category: '终端', sensitive: true },
  { name: 'awaitTerminalCommand', desc: '等待终端命令', icon: 'fa-hourglass', category: '终端', sensitive: true },
  { name: 'killTerminal', desc: '关闭终端', icon: 'fa-xmark', category: '终端', sensitive: false },
  { name: 'readClipboard', desc: '读取剪贴板', icon: 'fa-clipboard', category: '系统', sensitive: false },
  { name: 'writeClipboard', desc: '写入剪贴板', icon: 'fa-paste', category: '系统', sensitive: false },
  { name: 'takeScreenshot', desc: '截取屏幕', icon: 'fa-camera', category: '系统', sensitive: false },
  { name: 'extractTextFromImage', desc: 'OCR文字识别', icon: 'fa-file-image', category: '系统', sensitive: false },
  { name: 'scanQRCode', desc: '扫描二维码', icon: 'fa-qrcode', category: '系统', sensitive: false },
  { name: 'generateQRCode', desc: '生成二维码', icon: 'fa-qrcode', category: '系统', sensitive: false },
  { name: 'getSystemInfo', desc: '获取系统信息', icon: 'fa-computer', category: '系统', sensitive: false },
  { name: 'getNetworkStatus', desc: '获取网络状态', icon: 'fa-wifi', category: '系统', sensitive: false },
  { name: 'openBrowser', desc: '打开浏览器', icon: 'fa-globe', category: '系统', sensitive: false },
  { name: 'openFileExplorer', desc: '打开文件管理器', icon: 'fa-folder-open', category: '系统', sensitive: false },
  { name: 'eslintLint', desc: 'ESLint 代码诊断（全工作区）', icon: 'fa-shield-halved', category: '代码', sensitive: false },
  { name: 'eslintLintFile', desc: 'ESLint 单文件诊断', icon: 'fa-shield-halved', category: '代码', sensitive: false },
  { name: 'manageContext', desc: '上下文管理：clear_old/clear_tool_results/micro_compact/keep_essential（同步操作）', icon: 'fa-broom', category: '代理', sensitive: false },
  { name: 'autoSummarizeContext', desc: 'LLM 语义摘要当前对话上下文（异步，会消耗Token）', icon: 'fa-compress', category: '代理', sensitive: false },
  { name: 'listSkills', desc: '列出技能', icon: 'fa-lightbulb', category: '技能', sensitive: false },
  { name: 'makeSkill', desc: '创建技能', icon: 'fa-wand-magic-sparkles', category: '技能', sensitive: false },
  { name: 'updateSkill', desc: '更新技能', icon: 'fa-pen-to-square', category: '技能', sensitive: false },
  { name: 'runSkillScript', desc: '运行技能脚本（自动选择Node.js或浏览器沙箱运行时）', icon: 'fa-file-code', category: '技能', sensitive: false },
  { name: 'activateSkill', desc: '激活技能：将其prompt注入系统上下文，后续对话都遵循该技能的指令', icon: 'fa-toggle-on', category: '技能', sensitive: false },
  { name: 'deactivateSkill', desc: '停用已激活的技能', icon: 'fa-toggle-off', category: '技能', sensitive: false },
  { name: 'initGeogebra', desc: '初始化Geogebra', icon: 'fa-chart-line', category: 'Geogebra', sensitive: false },
  { name: 'runGeogebraCommand', desc: '执行Geogebra命令（Classic仅1参数）', icon: 'fa-play', category: 'Geogebra', sensitive: false },
  { name: 'getFunctionsFromGeogebra', desc: '获取Geogebra对象列表', icon: 'fa-list', category: 'Geogebra', sensitive: false },
  { name: 'addFunctionToGeogebra', desc: '添加函数/对象（示例: f(x)=x^2-1）', icon: 'fa-plus', category: 'Geogebra', sensitive: false },
  { name: 'updateFunctionInGeogebra', desc: '更新函数（示例: f(x)=x^3-1）', icon: 'fa-pen', category: 'Geogebra', sensitive: false },
  { name: 'deleteFunctionFromGeogebra', desc: '删除对象（示例: f）', icon: 'fa-trash-can', category: 'Geogebra', sensitive: true },
  { name: 'getCurrentGraphFromGeogebra', desc: '导出当前图形（PNG）', icon: 'fa-image', category: 'Geogebra', sensitive: false },
  { name: 'getCurrentGraphDataFromGeogebra', desc: '获取对象/数值数据（如 Roots 返回的点需用 x(A)）', icon: 'fa-chart-bar', category: 'Geogebra', sensitive: false },
  { name: 'initCanvas', desc: '初始化画布', icon: 'fa-palette', category: '画布', sensitive: false },
  { name: 'clearCanvas', desc: '清空画布', icon: 'fa-eraser', category: '画布', sensitive: false },
  { name: 'addCanvasObject', desc: '添加画布对象（rect/circle/ellipse/line/polyline/polygon/path/text）', icon: 'fa-plus', category: '画布', sensitive: false },
  { name: 'updateCanvasObject', desc: '更新画布对象属性', icon: 'fa-pen', category: '画布', sensitive: false },
  { name: 'deleteCanvasObject', desc: '删除画布对象', icon: 'fa-trash-can', category: '画布', sensitive: false },
  { name: 'exportCanvasSVG', desc: '导出画布为SVG到工作区', icon: 'fa-file-export', category: '画布', sensitive: false },
  // ---- CIPYP-CAD ----
  { name: 'initCipypCad', desc: '打开 CIPYP-CAD 独立窗口（2D 制图 CAD）', icon: 'fa-compass-drafting', category: 'CIPYP-CAD', sensitive: false },
  { name: 'runCipypCadCommand', desc: '在 CIPYP-CAD 中执行单条命令 (如: line 0,0 100,100)', icon: 'fa-terminal', category: 'CIPYP-CAD', sensitive: false },
  { name: 'runCipypCadCommands', desc: '批量执行多条 CIPYP-CAD 命令', icon: 'fa-list-ol', category: 'CIPYP-CAD', sensitive: false },
  { name: 'getCipypCadState', desc: '查询 CIPYP-CAD 当前状态 (对象数、图层、视图等)', icon: 'fa-circle-info', category: 'CIPYP-CAD', sensitive: false },
  { name: 'getCadObjectList', desc: '列出 CIPYP-CAD 图纸中所有对象', icon: 'fa-list', category: 'CIPYP-CAD', sensitive: false },
  { name: 'saveCipypCadProject', desc: '保存 CIPYP-CAD 工程为 .cipyproj 标准格式', icon: 'fa-floppy-disk', category: 'CIPYP-CAD', sensitive: false },
  { name: 'loadCipypCadProject', desc: '从 .cipyproj 文件加载 CIPYP-CAD 工程', icon: 'fa-folder-open', category: 'CIPYP-CAD', sensitive: false },
  { name: 'exportCipypCadDxf', desc: '导出 CIPYP-CAD 图纸为标准 DXF (AutoCAD R12) 格式', icon: 'fa-file-code', category: 'CIPYP-CAD', sensitive: false },
  { name: 'exportCipypCadImage', desc: '导出 CIPYP-CAD 图纸为 PNG/SVG 图片', icon: 'fa-image', category: 'CIPYP-CAD', sensitive: false },
  { name: 'closeCipypCad', desc: '关闭 CIPYP-CAD 窗口', icon: 'fa-xmark', category: 'CIPYP-CAD', sensitive: false },
  // ---- CIBYP-PCB-EDA ----
  { name: 'initPcbEda', desc: '打开 CIBYP-PCB-EDA 独立窗口（原理图+PCB设计）', icon: 'fa-microchip', category: 'PCB-EDA', sensitive: false },
  { name: 'closePcbEda', desc: '关闭 CIBYP-PCB-EDA 窗口', icon: 'fa-xmark', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbNewProject', desc: '新建 PCB 工程（板名/尺寸/层数）', icon: 'fa-file', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSetDesignRules', desc: '设置设计规则（间距/线宽/孔径等全参数）', icon: 'fa-ruler-combined', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSetStackup', desc: '设置层叠结构（铜层数/板厚/材料）', icon: 'fa-layer-group', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSetOutline', desc: '设置板框轮廓（多边形顶点）', icon: 'fa-vector-square', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSchAddSymbol', desc: '原理图放置元件符号（R/C/IC/连接器等）', icon: 'fa-puzzle-piece', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSchAddWire', desc: '原理图绘制导线', icon: 'fa-pen', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSchAddLabel', desc: '原理图放置网络标签', icon: 'fa-tag', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSchAddPower', desc: '原理图放置电源符号（GND/VCC等）', icon: 'fa-bolt', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSchAnnotate', desc: '原理图自动标注位号', icon: 'fa-list-ol', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSchSync', desc: '原理图同步到 PCB（生成元件+网络）', icon: 'fa-arrows-rotate', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbRunERC', desc: '运行原理图电气规则检查 (ERC)', icon: 'fa-clipboard-check', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbAddComponent', desc: 'PCB 放置元件（封装+全参数）', icon: 'fa-microchip', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbMoveComponent', desc: '移动 PCB 元件到指定坐标', icon: 'fa-arrows-up-down-left-right', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbRotateComponent', desc: '旋转 PCB 元件', icon: 'fa-rotate', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbDeleteComponent', desc: '删除 PCB 元件', icon: 'fa-trash-can', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbListComponents', desc: '列出 PCB 所有元件及焊盘网络', icon: 'fa-list', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSetPadNet', desc: '设置元件焊盘的网络', icon: 'fa-circle-nodes', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbRouteTrace', desc: 'PCB 布线（指定网络/层/线宽/路径）', icon: 'fa-route', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbAddVia', desc: 'PCB 放置过孔', icon: 'fa-circle', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbAddCopperPour', desc: 'PCB 铺铜（多边形+避让+热焊盘）', icon: 'fa-fill', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbAddSilkscreen', desc: 'PCB 添加丝印（线/矩形/圆/文字）', icon: 'fa-font', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbRunDRC', desc: '运行 PCB 设计规则检查 (DRC)', icon: 'fa-clipboard-check', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbAutoroute', desc: '自动布线（A* 网格布线器）', icon: 'fa-wand-magic-sparkles', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbGetBoardInfo', desc: '获取 PCB 板子统计与状态信息', icon: 'fa-circle-info', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbListLibrary', desc: '列出可用封装库/符号库', icon: 'fa-book', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbSaveProject', desc: '保存 PCB 工程（单文件/多文件）', icon: 'fa-floppy-disk', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbLoadProject', desc: '加载 PCB 工程文件', icon: 'fa-folder-open', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbImportFile', desc: '导入其他 EDA 文件（KiCad 工程/网表、CSV 网表）', icon: 'fa-file-import', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbExportGerber', desc: '导出 Gerber 生产文件包（RS-274X+钻孔，可打zip）', icon: 'fa-file-zipper', category: 'PCB-EDA', sensitive: false },
  { name: 'pcbExportFile', desc: '导出 KiCad/网表/SVG/PNG/3D OBJ/PnP/BOM 文件', icon: 'fa-file-export', category: 'PCB-EDA', sensitive: false },
  { name: 'runPcbEdaCommand', desc: '在 PCB-EDA 中执行单条命令', icon: 'fa-terminal', category: 'PCB-EDA', sensitive: false },
  { name: 'runPcbEdaCommands', desc: '批量执行多条 PCB-EDA 命令', icon: 'fa-list-ol', category: 'PCB-EDA', sensitive: false },
  { name: 'askQuestions', desc: '询问用户问题收集信息', icon: 'fa-clipboard-question', category: '交互工具', sensitive: false },
  { name: 'downloadFile', desc: '从互联网下载文件到工作区', icon: 'fa-download', category: '网络工具', sensitive: true },
  { name: 'inviteGame', desc: '邀请用户玩游戏（飞花令/三国杀/谁是卧底/成语接龙/是否猜人物）', icon: 'fa-gamepad', category: '游戏', sensitive: false },
  { name: 'mcpListTools', desc: '列出MCP服务端可用工具（刷新动态MCP工具）', icon: 'fa-list', category: 'MCP', sensitive: false },
  // ---- 扩充网络工具 ----
  { name: 'httpRequest', desc: '发送自定义HTTP请求(GET/POST/PUT/DELETE等)', icon: 'fa-paper-plane', category: '网络工具', sensitive: true },
  { name: 'httpFormPost', desc: '发送表单/multipart请求', icon: 'fa-file-arrow-up', category: '网络工具', sensitive: true },
  { name: 'dnsLookup', desc: 'DNS域名解析', icon: 'fa-sitemap', category: '网络工具', sensitive: false },
  { name: 'ping', desc: 'Ping主机(ICMP)', icon: 'fa-satellite-dish', category: '网络工具', sensitive: false },
  { name: 'urlShorten', desc: '分析/展开短链接', icon: 'fa-link', category: '网络工具', sensitive: false },
  { name: 'urlEncodeDecode', desc: 'URL编码/解码/Base64编解码', icon: 'fa-code', category: '网络工具', sensitive: false },
  { name: 'checkSSLCert', desc: '检查网站SSL证书信息', icon: 'fa-shield-halved', category: '网络工具', sensitive: false },
  { name: 'traceroute', desc: '路由追踪', icon: 'fa-route', category: '网络工具', sensitive: false },
  { name: 'portScan', desc: '扫描目标主机端口(限单IP)', icon: 'fa-binoculars', category: '网络工具', sensitive: true },
  // Serial Port
  { name: 'serialListPorts', desc: '列出系统串口', icon: 'fa-list', category: '串口', sensitive: true },
  { name: 'serialOpenPort', desc: '打开串口连接', icon: 'fa-plug-circle-check', category: '串口', sensitive: true },
  { name: 'serialWritePort', desc: '向串口写入数据', icon: 'fa-pen-nib', category: '串口', sensitive: true },
  { name: 'serialReadPort', desc: '读取串口缓冲区', icon: 'fa-eye', category: '串口', sensitive: true },
  { name: 'serialClosePort', desc: '关闭串口连接', icon: 'fa-plug-circle-xmark', category: '串口', sensitive: true },
  { name: 'serialSetSignals', desc: '设置串口控制信号(DTR/RTS)', icon: 'fa-signal', category: '串口', sensitive: true },
  // Office
  { name: 'officeUnpack', desc: '解压Office文件为目录', icon: 'fa-box-open', category: 'Office', sensitive: true },
  { name: 'officeListContents', desc: '列出Office内部文件', icon: 'fa-folder-tree', category: 'Office', sensitive: false },
  { name: 'officeReadInnerFile', desc: '读取Office内部文件', icon: 'fa-file-code', category: 'Office', sensitive: false },
  { name: 'officeWriteInnerFile', desc: '写入Office内部文件', icon: 'fa-file-pen', category: 'Office', sensitive: true },
  { name: 'officeRepack', desc: '打包目录为Office文件', icon: 'fa-file-zipper', category: 'Office', sensitive: true },
  { name: 'officeGetSlideTexts', desc: '提取幻灯片所有文字（用于翻译等文字操作）', icon: 'fa-font', category: 'Office', sensitive: false },
  { name: 'officeSetSlideTexts', desc: '将翻译结果写回幻灯片', icon: 'fa-language', category: 'Office', sensitive: true },
  { name: 'officeWordExtract', desc: '提取Word文档文字与样式', icon: 'fa-file-word', category: 'Office-Word', sensitive: false },
  { name: 'officeWordApplyTexts', desc: '按索引覆写Word文字（保留格式）', icon: 'fa-file-pen', category: 'Office-Word', sensitive: true },
  { name: 'officeWordGetStyles', desc: '读取Word样式列表', icon: 'fa-list', category: 'Office-Word', sensitive: false },
  { name: 'officeWordFillTemplate', desc: '按占位符填充Word模板', icon: 'fa-file-signature', category: 'Office-Word', sensitive: true },
  // Spreadsheet
  { name: 'initSpreadsheet', desc: '打开数据表格侧栏', icon: 'fa-table-cells', category: '数据表格', sensitive: false },
  { name: 'spreadsheetSetCells', desc: '批量设置单元格值/公式', icon: 'fa-pen', category: '数据表格', sensitive: false },
  { name: 'spreadsheetGetCells', desc: '读取范围内的单元格', icon: 'fa-eye', category: '数据表格', sensitive: false },
  { name: 'spreadsheetSetCellFormat', desc: '设置单元格格式（字体/颜色/对齐等）', icon: 'fa-palette', category: '数据表格', sensitive: false },
  { name: 'spreadsheetSetRangeFormat', desc: '批量设置范围格式', icon: 'fa-fill-drip', category: '数据表格', sensitive: false },
  { name: 'spreadsheetClearCells', desc: '清空单元格（指定范围或全部）', icon: 'fa-eraser', category: '数据表格', sensitive: false },
  { name: 'spreadsheetInsertRows', desc: '插入行', icon: 'fa-plus', category: '数据表格', sensitive: false },
  { name: 'spreadsheetDeleteRows', desc: '删除行', icon: 'fa-minus', category: '数据表格', sensitive: false },
  { name: 'spreadsheetInsertCols', desc: '插入列', icon: 'fa-plus', category: '数据表格', sensitive: false },
  { name: 'spreadsheetDeleteCols', desc: '删除列', icon: 'fa-minus', category: '数据表格', sensitive: false },
  { name: 'spreadsheetSortRange', desc: '排序范围数据', icon: 'fa-arrow-down-a-z', category: '数据表格', sensitive: false },
  { name: 'spreadsheetGetData', desc: '获取所有表格数据', icon: 'fa-table', category: '数据表格', sensitive: false },
  { name: 'spreadsheetExportCSV', desc: '导出为CSV', icon: 'fa-file-csv', category: '数据表格', sensitive: false },
  { name: 'spreadsheetImportCSV', desc: '从CSV导入数据', icon: 'fa-file-import', category: '数据表格', sensitive: false },
  { name: 'spreadsheetImportFile', desc: '从文件导入表格(xlsx/ods/csv)', icon: 'fa-file-arrow-up', category: '数据表格', sensitive: false },
  { name: 'spreadsheetExportFile', desc: '导出表格到文件(xlsx/ods/csv)', icon: 'fa-file-arrow-down', category: '数据表格', sensitive: false },
  // ---- 内置浏览器 (Playwright) ----
  // 注意：Playwright 工具集不再标记为 sensitive（不再每次调用都弹敏感操作确认），
  // 改为"首次使用授权"机制：第一次调用任意 Playwright 工具时弹出授权模态框，
  // 用户同意后 settings.toolAuthGranted.playwright=true（持久化），之后允许使用；
  // 不同意则在工具选择器中禁用所有 Playwright 工具。
  { name: 'browserNavigate', desc: '在内置浏览器中打开网址（基于Playwright，用户可干预）', icon: 'fa-globe', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserScreenshot', desc: '截取内置浏览器当前页面截图', icon: 'fa-camera', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserClick', desc: '点击内置浏览器页面元素', icon: 'fa-hand-pointer', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserType', desc: '在内置浏览器页面元素中输入文字', icon: 'fa-keyboard', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserGetContent', desc: '获取内置浏览器页面文本内容', icon: 'fa-file-lines', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserScroll', desc: '滚动内置浏览器页面', icon: 'fa-arrows-up-down', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserBack', desc: '内置浏览器后退', icon: 'fa-arrow-left', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserForward', desc: '内置浏览器前进', icon: 'fa-arrow-right', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserRefresh', desc: '刷新内置浏览器页面', icon: 'fa-rotate-right', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserEvaluate', desc: '在页面中执行JavaScript代码', icon: 'fa-code', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserWait', desc: '等待元素出现或指定时间', icon: 'fa-hourglass-half', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserHover', desc: '鼠标悬停在页面元素上', icon: 'fa-arrow-pointer', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserSelect', desc: '选择下拉框选项', icon: 'fa-list', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserGetInfo', desc: '获取当前页面URL、标题等信息', icon: 'fa-circle-info', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  { name: 'browserClose', desc: '关闭内置浏览器', icon: 'fa-xmark', category: '浏览器', sensitive: false, requiresAuth: 'playwright' },
  // ---- Goal / 长任务跟踪 ----
  { name: 'goalSet', desc: '设置/更新长期目标(让agent自动多轮推进)', icon: 'fa-bullseye', category: '代理', sensitive: false },
  { name: 'goalStatus', desc: '查看当前目标状态', icon: 'fa-circle-info', category: '代理', sensitive: false },
  { name: 'goalComplete', desc: '标记目标完成', icon: 'fa-flag-checkered', category: '代理', sensitive: false },
  { name: 'sleep', desc: '休眠等待指定毫秒', icon: 'fa-moon', category: '效率', sensitive: false },
  // ---- 外观主题 ----
  { name: 'adjustAppearance', desc: '调整应用外观：深浅色模式、强调色、配色方案', icon: 'fa-palette', category: '系统', sensitive: false },
  // ---- Computer Use Protocol ----
  // 注意：Computer Use 工具不再标记为 sensitive（不再每次调用都弹敏感操作确认），
  // 改为"首次使用授权"机制：第一次调用时弹出授权模态框说明风险，
  // 用户同意后 settings.toolAuthGranted.computerUse=true（持久化），之后允许使用；
  // 不同意则禁用工具。
  { name: 'computer', desc: '电脑控制（截屏/鼠标/键盘/滚动）', icon: 'fa-desktop', category: '电脑控制', sensitive: false, requiresAuth: 'computerUse' },
];

// Dangerous command keywords for different platforms/shells
const DANGEROUS_COMMANDS = {
  common: ['rm -rf', 'rmdir', 'del /f', 'format', 'mkfs', 'dd if=', 'chmod 777', ':(){:|:&};:', 'fork bomb', '> /dev/sda', 'shutdown', 'reboot', 'halt', 'poweroff', 'kill -9', 'killall', 'pkill'],
  windows: ['Remove-Item -Recurse -Force', 'Format-Volume', 'Clear-Disk', 'Stop-Process -Force', 'Remove-Partition', 'rd /s /q', 'reg delete', 'bcdedit', 'diskpart'],
  linux: ['rm -rf /', 'chmod -R 777 /', 'chown -R', 'mv /* /dev/null', 'wget.*|.*sh', 'curl.*|.*sh', 'crontab -r', 'iptables -F', 'systemctl stop', 'service.*stop'],
  macos: ['rm -rf /', 'diskutil eraseDisk', 'csrutil disable', 'nvram -c', 'bless --unbless']
};

// OpenAI-format tool schemas for LLM
function getToolSchemas(enabledTools, mode) {
  const schemas = {
    getTarot: { type: 'function', function: { name: 'getTarot', description: '抽取塔罗牌（使用设置中配置的随机数源：CSPRNG软件随机或TRNG硬件真随机，返回结果中entropySource字段标明随机数类型）。支持多种牌阵(spread)：单张牌快速回答、三牌时间线、关系分析、凯尔特十字等。返回的每张牌包含位置含义(position)和正逆位(orientation)。在向用户解析时请标明随机数类型以增强可信度。', parameters: { type: 'object', properties: { spread: { type: 'string', enum: ['single', 'three-card', 'relationship', 'choice', 'body-mind-spirit', 'celtic-cross', 'horseshoe', 'yes-no'], description: '牌阵类型。single=单张牌(1张,快速回答/每日运势), three-card=三牌牌阵(过去/现在/未来), relationship=关系牌阵(你/对方/关系), choice=选择牌阵(选项A/选项B/建议), body-mind-spirit=身心灵牌阵, celtic-cross=凯尔特十字(10牌全面分析), horseshoe=马蹄铁牌阵(7牌), yes-no=是非牌阵(正位=是,逆位=否)。默认single。' } }, required: [] } } },
    todoList: { type: 'function', function: { name: 'todoList', description: '管理待办事项列表', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'remove', 'toggle', 'list'], description: '操作类型' }, text: { type: 'string', description: '待办事项内容' }, id: { type: 'number', description: '待办事项ID' } }, required: ['action'] } } },
    runSubAgent: { type: 'function', function: { name: 'runSubAgent', description: '运行一个独立子代理完成特定任务。子代理拥有自己的 agent loop（可多轮调用工具）、隔离上下文和工具白名单，完成后返回结果报告。适用于并行/分解任务、独立调查、批处理等场景。', parameters: { type: 'object', properties: { task: { type: 'string', description: '子代理要完成的任务（含目标、约束、验收标准）' }, context: { type: 'string', description: '给子代理的额外上下文信息（如相关文件路径、已有发现）' }, tools: { type: 'array', items: { type: 'string' }, description: '允许子代理使用的工具名称白名单。省略则使用默认安全集：readFile/listDirectory/localSearch/createFile/editFile/copyFile/makeDirectory/getSystemInfo/calculator/webSearch/webFetch/runJavaScriptCode。危险工具（deleteFile/runTerminalCommand 等）默认禁用，必须显式列出才会授予。' }, maxIterations: { type: 'number', description: '子代理最大循环轮数，默认 10，上限 30' } }, required: ['task'] } } },
    generateImage: { type: 'function', function: { name: 'generateImage', description: '根据文本提示生成图片', parameters: { type: 'object', properties: { prompt: { type: 'string', description: '图片描述(英文)' } }, required: ['prompt'] } } },
    calculator: { type: 'function', function: { name: 'calculator', description: '精确计算数学表达式（本地执行，支持常见中英文/全角符号与百分号写法）。任何涉及算式求值都应优先使用此工具，避免模型口算误差。', parameters: { type: 'object', properties: { expression: { type: 'string', description: '表达式，例如：(1+2.5)×3^2、50%+1、10 mod 3' } }, required: ['expression'] } } },
    factorInteger: { type: 'function', function: { name: 'factorInteger', description: '对整数做质因数分解，返回每个质因子的指数。适合约分、数论、分解验证等。', parameters: { type: 'object', properties: { value: { type: 'string', description: '要分解的整数，可为字符串/数字，如 "360" 或 "-84"' } }, required: ['value'] } } },
    gcdLcm: { type: 'function', function: { name: 'gcdLcm', description: '计算多个整数的最大公约数(gcd)和最小公倍数(lcm)。', parameters: { type: 'object', properties: { values: { type: 'array', items: { type: 'string' }, description: '整数数组，至少2个元素，如 ["12","18","30"]' } }, required: ['values'] } } },
    baseConvert: { type: 'function', function: { name: 'baseConvert', description: '在2~36进制间转换整数，支持负数。', parameters: { type: 'object', properties: { value: { type: 'string', description: '输入值（按fromBase解释）' }, fromBase: { type: 'number', description: '源进制(2~36)' }, toBase: { type: 'number', description: '目标进制(2~36)' } }, required: ['value', 'fromBase', 'toBase'] } } },
    factorial: { type: 'function', function: { name: 'factorial', description: '计算非负整数 n 的阶乘 n!，返回精确整数结果。', parameters: { type: 'object', properties: { n: { type: 'number', description: '非负整数，建议不超过2000' } }, required: ['n'] } } },
    complexMath: { type: 'function', function: { name: 'complexMath', description: '复数运算工具。支持 add/sub/mul/div/pow/conjugate/abs/arg。复数格式：{re:number,im:number}。', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['add','sub','mul','div','pow','conjugate','abs','arg'], description: '运算类型' }, a: { type: 'object', properties: { re: { type: 'number' }, im: { type: 'number' } }, required: ['re','im'] }, b: { type: 'object', properties: { re: { type: 'number' }, im: { type: 'number' } } }, exponent: { type: 'number', description: '整数幂（operation=pow时使用）' } }, required: ['operation','a'] } } },
    matrixMath: { type: 'function', function: { name: 'matrixMath', description: '矩阵运算（自定义行列）。支持 add/sub/mul/transpose/determinant/inverse/rank。', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['add','sub','mul','transpose','determinant','inverse','rank'] }, A: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '矩阵A（二维数组）' }, B: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '矩阵B（二维数组）' } }, required: ['operation','A'] } } },
    vectorMath: { type: 'function', function: { name: 'vectorMath', description: '向量运算（自定义维度）。支持 add/sub/dot/cross/mixed/norm。cross 支持3维与7维；mixed 为三向量混合积（3维或7维）。', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['add','sub','dot','cross','mixed','norm'] }, a: { type: 'array', items: { type: 'number' } }, b: { type: 'array', items: { type: 'number' } }, c: { type: 'array', items: { type: 'number' } } }, required: ['operation','a'] } } },
    solveInequality: { type: 'function', function: { name: 'solveInequality', description: '解线性/二次不等式。输入系数表示多项式 a_n x^n + ... + a_0 与0比较。', parameters: { type: 'object', properties: { coefficients: { type: 'array', items: { type: 'number' }, description: '按降幂排列的系数，长度2或3' }, relation: { type: 'string', enum: ['<','<=','>','>='], description: '不等关系' }, variable: { type: 'string', description: '变量名，默认x' } }, required: ['coefficients','relation'] } } },
    solveLinearSystem: { type: 'function', function: { name: 'solveLinearSystem', description: '解线性方程组 Ax=b（高斯消元）。返回唯一解/无解/无穷多解。', parameters: { type: 'object', properties: { A: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '系数矩阵' }, b: { type: 'array', items: { type: 'number' }, description: '常数向量' } }, required: ['A','b'] } } },
    solvePolynomial: { type: 'function', function: { name: 'solvePolynomial', description: '求解1~4次多项式方程 roots，支持复数结果（数值法）。coefficients按降幂输入。', parameters: { type: 'object', properties: { coefficients: { type: 'array', items: { type: 'number' }, description: '多项式系数，如 x^2+1 => [1,0,1]' } }, required: ['coefficients'] } } },
    distributionCalc: { type: 'function', function: { name: 'distributionCalc', description: '概率分布计算。支持 normal(binomial/poisson/uniform) 的 pdf/pmf/cdf/mean/variance。', parameters: { type: 'object', properties: { distribution: { type: 'string', enum: ['normal','binomial','poisson','uniform'] }, operation: { type: 'string', enum: ['pdf','pmf','cdf','mean','variance'] }, params: { type: 'object', description: '分布参数（normal:mu,sigma; binomial:n,p; poisson:lambda; uniform:a,b）' }, x: { type: 'number', description: '随机变量取值（pdf/pmf/cdf时）' } }, required: ['distribution','operation','params'] } } },
    combinatorics: { type: 'function', function: { name: 'combinatorics', description: '排列组合计算。支持 permutation/combination，支持是否可重复。', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['permutation','combination'] }, n: { type: 'number' }, r: { type: 'number' }, repetition: { type: 'boolean', description: '是否允许重复' } }, required: ['operation','n','r'] } } },
    fractionBaseConvert: { type: 'function', function: { name: 'fractionBaseConvert', description: '分数（含小数）进制转换，支持循环节识别与精度控制。', parameters: { type: 'object', properties: { value: { type: 'string', description: '输入值，如 101.101 或 -12.75' }, fromBase: { type: 'number', description: '源进制(2~36)' }, toBase: { type: 'number', description: '目标进制(2~36)' }, precision: { type: 'number', description: '小数位最大长度，默认40' } }, required: ['value','fromBase','toBase'] } } },
    webSearch: { type: 'function', function: { name: 'webSearch', description: '通过Bing搜索信息', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    webFetch: { type: 'function', function: { name: 'webFetch', description: '获取网页内容', parameters: { type: 'object', properties: { url: { type: 'string', description: '网页URL' } }, required: ['url'] } } },
    offscreenRenderOCR: { type: 'function', function: { name: 'offscreenRenderOCR', description: '离屏打开指定URL（不调用外部浏览器），等待渲染后截屏并OCR提取页面文本。用于动态网页内容抓取前，必须先使用webSearch拿到准确URL。', parameters: { type: 'object', properties: { url: { type: 'string', description: '目标URL（建议来自webSearch结果）' }, waitMs: { type: 'number', description: '渲染等待毫秒数，默认10000' }, width: { type: 'number', description: '截图宽度，默认1366' }, height: { type: 'number', description: '截图高度，默认900' } }, required: ['url'] } } },
    offscreenRenderContent: { type: 'function', function: { name: 'offscreenRenderContent', description: '离屏打开指定URL并等待页面渲染后，直接提取页面已渲染内容（文本/HTML），不进行OCR。可选保存截图。', parameters: { type: 'object', properties: { url: { type: 'string', description: '目标URL（建议来自webSearch结果）' }, waitMs: { type: 'number', description: '渲染等待毫秒数，默认10000' }, width: { type: 'number', description: '渲染宽度，默认1366' }, height: { type: 'number', description: '渲染高度，默认900' }, captureScreenshot: { type: 'boolean', description: '是否保存截图（默认true）' }, includeHtml: { type: 'boolean', description: '是否返回渲染后的HTML（默认true）' } }, required: ['url'] } } },
    knowledgeBaseSearch: { type: 'function', function: { name: 'knowledgeBaseSearch', description: '搜索知识库', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    knowledgeBaseAdd: { type: 'function', function: { name: 'knowledgeBaseAdd', description: '向知识库添加信息', parameters: { type: 'object', properties: { title: { type: 'string', description: '标题' }, content: { type: 'string', description: '内容' } }, required: ['title', 'content'] } } },
    knowledgeBaseDelete: { type: 'function', function: { name: 'knowledgeBaseDelete', description: '从知识库删除信息', parameters: { type: 'object', properties: { id: { type: 'string', description: '知识条目ID' } }, required: ['id'] } } },
    knowledgeBaseUpdate: { type: 'function', function: { name: 'knowledgeBaseUpdate', description: '更新知识库信息', parameters: { type: 'object', properties: { id: { type: 'string', description: '知识条目ID' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['id'] } } },
    memorySearch: { type: 'function', function: { name: 'memorySearch', description: '搜索长期记忆', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    memoryAdd: { type: 'function', function: { name: 'memoryAdd', description: '添加长期记忆', parameters: { type: 'object', properties: { content: { type: 'string', description: '记忆内容' }, tags: { type: 'array', items: { type: 'string' }, description: '标签' } }, required: ['content'] } } },
    memoryDelete: { type: 'function', function: { name: 'memoryDelete', description: '删除长期记忆', parameters: { type: 'object', properties: { id: { type: 'string', description: '记忆ID' } }, required: ['id'] } } },
    memoryUpdate: { type: 'function', function: { name: 'memoryUpdate', description: '更新长期记忆', parameters: { type: 'object', properties: { id: { type: 'string', description: '记忆ID' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['id'] } } },
    localSearch: { type: 'function', function: { name: 'localSearch', description: '搜索本地文件和目录', parameters: { type: 'object', properties: { directory: { type: 'string', description: '搜索目录' }, pattern: { type: 'string', description: '搜索模式（支持通配符或正则表达式）' }, options: { type: 'object', properties: { ignoreCase: { type: 'boolean', description: '是否忽略大小写（默认true）' }, maxResults: { type: 'number', description: '最大结果数（默认200）' }, fileOnly: { type: 'boolean', description: '仅搜索文件' }, dirOnly: { type: 'boolean', description: '仅搜索目录' }, regex: { type: 'boolean', description: '使用正则表达式匹配' }, depth: { type: 'number', description: '搜索深度限制（-1表示无限制）' } }, description: '搜索选项' } }, required: ['directory', 'pattern'] } } },
    searchInFiles: { type: 'function', function: { name: 'searchInFiles', description: '在文件内容中搜索（grep风格，对标Claude Code的Grep工具）。支持多文件/目录递归、文件名通配符过滤（include/exclude）、文本/正则表达式搜索、自动编码检测或手动指定编码（utf-8/gbk/big5/shift_jis等）。结果按文件组织，每条匹配包含文件路径、行号、列号、匹配行文本及可选上下文行。', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: '要搜索的文件或目录路径列表（绝对路径或工作目录相对路径）。可传入多个文件或目录。' }, pattern: { type: 'string', description: '搜索模式（文本或正则表达式）' }, isRegex: { type: 'boolean', description: '是否将pattern作为正则表达式（默认false，文本搜索）' }, ignoreCase: { type: 'boolean', description: '是否忽略大小写（默认true）' }, include: { type: 'string', description: '文件名通配符（glob），多个用逗号分隔。例：*.js,*.ts 仅搜索JS和TS文件。默认搜索所有非二进制文件。' }, exclude: { type: 'string', description: '要排除的文件/目录通配符，多个用逗号分隔。例：node_modules,.git,*.min.js' }, encoding: { type: 'string', description: '手动指定文件编码（如utf-8、gbk、big5、shift_jis等）。不指定则使用chardet自动检测。' }, maxResults: { type: 'number', description: '最大匹配结果数（默认500，避免超大输出）' }, contextLines: { type: 'number', description: '每个匹配项前后的上下文行数（默认0，仅返回匹配行）' }, multiline: { type: 'boolean', description: '是否允许正则跨行匹配（默认false）' } }, required: ['paths', 'pattern'] } } },
    readFile: { type: 'function', function: { name: 'readFile', description: '读取文件内容（返回带行号的内容，便于后续编辑定位）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径（工作目录相对路径或绝对路径）' } }, required: ['path'] } } },
    editFile: { type: 'function', function: { name: 'editFile', description: '编辑文件（支持字符串替换和全量覆写两种模式）。字符串替换模式：指定 old_string（要查找的原文）和 new_string（替换文本），支持 replace_all 全局替换。全量覆写模式：仅指定 content 参数。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径（工作目录相对路径或绝对路径）' }, old_string: { type: 'string', description: '要查找并替换的原文（必须与文件内容精确匹配，包括缩进和换行）' }, new_string: { type: 'string', description: '替换后的文本' }, replace_all: { type: 'boolean', description: '是否替换所有匹配项（默认false，仅替换第一个）。当old_string出现多次且未设此选项时将报错。' }, content: { type: 'string', description: '全量覆写模式：直接写入完整新内容（与old_string/new_string互斥）' } }, required: ['path'] } } },
    multiEditFile: { type: 'function', function: { name: 'multiEditFile', description: '批量编辑文件：对同一文件执行多处字符串替换。按顺序依次应用每个编辑。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string', description: '要查找的原文' }, new_string: { type: 'string', description: '替换后的文本' }, replace_all: { type: 'boolean', description: '是否替换所有匹配项' } }, required: ['old_string', 'new_string'] }, description: '编辑列表（按顺序依次应用）' } }, required: ['path', 'edits'] } } },
    presentFile: { type: 'function', function: { name: 'presentFile', description: '文件呈递器：将工作目录中的文件以卡片形式呈递给用户，包含下载按钮。工具调用后立即返回，不阻塞Agent循环。', parameters: { type: 'object', properties: { path: { type: 'string', description: '工作目录中的文件相对路径（必须使用相对路径，禁止使用绝对路径或盘符开头的路径如C:\\或/开头）。正确示例：output/report.pdf、data/result.json；错误示例：C:\\Users\\report.pdf、/home/user/report.pdf' }, title: { type: 'string', description: '卡片标题（可选，默认为文件名）' }, description: { type: 'string', description: '文件描述（可选）' } }, required: ['path'] } } },
    readImageFile: { type: 'function', function: { name: 'readImageFile', description: '读取图片文件并将其作为图片内容直接注入上下文（仅多模态模型可用）。当模型支持视觉输入时，优先使用此工具读取图片而非OCR。图片以标准多模态格式注入，LLM可直接"看到"图片内容。', parameters: { type: 'object', properties: { path: { type: 'string', description: '图片文件的相对路径（支持 png/jpg/jpeg/gif/webp/bmp 格式）' }, description: { type: 'string', description: '对图片的描述或备注（可选，帮助模型理解图片用途）' } }, required: ['path'] } } },
    createFile: { type: 'function', function: { name: 'createFile', description: '创建新文件', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '文件内容' } }, required: ['path'] } } },
    deleteFile: { type: 'function', function: { name: 'deleteFile', description: '删除文件', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } } },
    moveFile: { type: 'function', function: { name: 'moveFile', description: '移动/重命名文件', parameters: { type: 'object', properties: { source: { type: 'string', description: '源路径' }, destination: { type: 'string', description: '目标路径' } }, required: ['source', 'destination'] } } },
    copyFile: { type: 'function', function: { name: 'copyFile', description: '复制文件', parameters: { type: 'object', properties: { source: { type: 'string', description: '源路径' }, destination: { type: 'string', description: '目标路径' } }, required: ['source', 'destination'] } } },
    listDirectory: { type: 'function', function: { name: 'listDirectory', description: '列出目录内容', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径' } }, required: ['path'] } } },
    makeDirectory: { type: 'function', function: { name: 'makeDirectory', description: '创建目录', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径' } }, required: ['path'] } } },
    deleteDirectory: { type: 'function', function: { name: 'deleteDirectory', description: '删除目录', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径' } }, required: ['path'] } } },
    runJavaScriptCode: { type: 'function', function: { name: 'runJavaScriptCode', description: '运行纯JS代码（浏览器沙箱，不支持require/fs/Buffer等Node.js API，仅适合纯计算逻辑）。严禁在此工具中使用require()，否则会报错。需要操作文件/模块时必须改用runNodeJavaScriptCode。', parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript代码（不能含require/fs/path等Node.js专用API）' } }, required: ['code'] } } },
    runNodeJavaScriptCode: { type: 'function', function: { name: 'runNodeJavaScriptCode', description: '运行Node.js代码（支持require/fs/path/Buffer/adm-zip等所有Node.js API，可操作文件系统，需用户确认）。凡需要require()或文件操作，必须使用此工具而非runJavaScriptCode。', parameters: { type: 'object', properties: { code: { type: 'string', description: 'Node.js代码（可使用require/fs/path等）' } }, required: ['code'] } } },
    runShellScriptCode: { type: 'function', function: { name: 'runShellScriptCode', description: '运行Shell脚本', parameters: { type: 'object', properties: { script: { type: 'string', description: 'Shell脚本内容' } }, required: ['script'] } } },
    makeTerminal: { type: 'function', function: { name: 'makeTerminal', description: '创建终端会话', parameters: { type: 'object', properties: {}, required: [] } } },
    runTerminalCommand: { type: 'function', function: { name: 'runTerminalCommand', description: '在终端执行命令', parameters: { type: 'object', properties: { terminalId: { type: 'number', description: '终端ID' }, command: { type: 'string', description: '命令' } }, required: ['terminalId', 'command'] } } },
    awaitTerminalCommand: { type: 'function', function: { name: 'awaitTerminalCommand', description: '在终端执行命令并等待完成', parameters: { type: 'object', properties: { terminalId: { type: 'number', description: '终端ID' }, command: { type: 'string', description: '命令' } }, required: ['terminalId', 'command'] } } },
    killTerminal: { type: 'function', function: { name: 'killTerminal', description: '关闭终端', parameters: { type: 'object', properties: { terminalId: { type: 'number', description: '终端ID' } }, required: ['terminalId'] } } },
    readClipboard: { type: 'function', function: { name: 'readClipboard', description: '读取剪贴板内容', parameters: { type: 'object', properties: {}, required: [] } } },
    writeClipboard: { type: 'function', function: { name: 'writeClipboard', description: '写入剪贴板', parameters: { type: 'object', properties: { text: { type: 'string', description: '内容' } }, required: ['text'] } } },
    takeScreenshot: { type: 'function', function: { name: 'takeScreenshot', description: '截取屏幕截图', parameters: { type: 'object', properties: {}, required: [] } } },
    extractTextFromImage: { type: 'function', function: { name: 'extractTextFromImage', description: '从图片中提取文字(OCR)', parameters: { type: 'object', properties: { imagePath: { type: 'string', description: '图片路径' } }, required: ['imagePath'] } } },
    scanQRCode: { type: 'function', function: { name: 'scanQRCode', description: '扫描图片中的二维码，返回二维码包含的文本内容', parameters: { type: 'object', properties: { imagePath: { type: 'string', description: '包含二维码的图片路径（PNG/JPG等）' } }, required: ['imagePath'] } } },
    generateQRCode: { type: 'function', function: { name: 'generateQRCode', description: '从文本内容生成二维码图片并保存到工作目录', parameters: { type: 'object', properties: { text: { type: 'string', description: '要编码到二维码中的文本内容（URL、文字等）' }, filename: { type: 'string', description: '输出文件名（可选，默认qrcode_时间戳.png）' } }, required: ['text'] } } },
    getSystemInfo: { type: 'function', function: { name: 'getSystemInfo', description: '获取系统信息', parameters: { type: 'object', properties: {}, required: [] } } },
    getNetworkStatus: { type: 'function', function: { name: 'getNetworkStatus', description: '获取网络状态', parameters: { type: 'object', properties: {}, required: [] } } },
    openBrowser: { type: 'function', function: { name: 'openBrowser', description: '打开浏览器访问URL', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL地址' } }, required: ['url'] } } },
    openFileExplorer: { type: 'function', function: { name: 'openFileExplorer', description: '打开文件管理器', parameters: { type: 'object', properties: { path: { type: 'string', description: '路径' } }, required: ['path'] } } },
    manageContext: { type: 'function', function: { name: 'manageContext', description: '管理上下文信息,清理不需要的内容', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['summarize', 'clear_old', 'clear_tool_results', 'keep_essential'], description: '操作类型' }, keepLast: { type: 'number', description: '保留最近N条消息' } }, required: ['action'] } } },
    autoSummarizeContext: { type: 'function', function: { name: 'autoSummarizeContext', description: '使用LLM自动总结当前上下文并覆盖', parameters: { type: 'object', properties: {}, required: [] } } },
    listSkills: { type: 'function', function: { name: 'listSkills', description: '列出所有技能，返回结果中ok字段表示是否成功，skills字段包含技能列表', parameters: { type: 'object', properties: {}, required: [] } } },
    makeSkill: { type: 'function', function: { name: 'makeSkill', description: '创建新技能，返回结果中ok字段表示是否成功', parameters: { type: 'object', properties: { name: { type: 'string', description: '技能名称' }, description: { type: 'string', description: '技能描述' }, prompt: { type: 'string', description: '系统提示词' } }, required: ['name', 'description', 'prompt'] } } },
    updateSkill: { type: 'function', function: { name: 'updateSkill', description: '更新已有技能，返回结果中ok字段表示是否成功', parameters: { type: 'object', properties: { id: { type: 'string', description: '技能ID' }, name: { type: 'string', description: '技能名称' }, description: { type: 'string', description: '技能描述' }, prompt: { type: 'string', description: '系统提示词' } }, required: ['id', 'name', 'description', 'prompt'] } } },
    runSkillScript: { type: 'function', function: { name: 'runSkillScript', description: '运行已导入标准技能中的JS脚本（仅支持.js）。在调用前先用listSkills查看技能及scripts列表。', parameters: { type: 'object', properties: { skillId: { type: 'string', description: '技能ID（listSkills返回的id）' }, scriptName: { type: 'string', description: '脚本文件名（例如 main.js）' } }, required: ['skillId', 'scriptName'] } } },
    initGeogebra: { type: 'function', function: { name: 'initGeogebra', description: '初始化Geogebra应用', parameters: { type: 'object', properties: { appName: { type: 'string', enum: ['classic'], description: '应用类型，默认classic' } }, required: [] } } },
    runGeogebraCommand: { type: 'function', function: { name: 'runGeogebraCommand', description: '执行GeoGebra命令（Classic）。求解方程例：先f(x)=x^2-1，再Solve[f(x)=0]只需一个参数（方程）。求根例：Roots[f]得到点A,B,C，用x(A)提取值。⚠️必须严格使用GeoGebra官方命令语法：设置线粗用 SetLineThickness[A,5]（不是SetThickness）；设置颜色用 SetColor[A,255,0,0]；设置点样式用 SetPointStyle[A,0]；设置标签用 SetCaption[A,"P"]。命令区分大小写，参数用方括号[]包裹。', parameters: { type: 'object', properties: { command: { type: 'string', description: 'GeoGebra Classic命令（严格遵循GGB语法：SetLineThickness/SetColor/SetPointStyle等，注意Solve只取1参数，Roots返回点标签）' } }, required: ['command'] } } },
    getFunctionsFromGeogebra: { type: 'function', function: { name: 'getFunctionsFromGeogebra', description: '获取Geogebra函数列表', parameters: { type: 'object', properties: {}, required: [] } } },
    addFunctionToGeogebra: { type: 'function', function: { name: 'addFunctionToGeogebra', description: '添加函数/对象（Classic），例：f(x)=x^2-1 或 g: y=2x+1', parameters: { type: 'object', properties: { expression: { type: 'string', description: '函数表达式（Classic）' } }, required: ['expression'] } } },
    updateFunctionInGeogebra: { type: 'function', function: { name: 'updateFunctionInGeogebra', description: '更新函数（Classic），例：f(x)=x^3-1（直接重定义）', parameters: { type: 'object', properties: { name: { type: 'string', description: '函数名' }, expression: { type: 'string', description: '新表达式' } }, required: ['name', 'expression'] } } },
    deleteFunctionFromGeogebra: { type: 'function', function: { name: 'deleteFunctionFromGeogebra', description: '删除Geogebra函数', parameters: { type: 'object', properties: { name: { type: 'string', description: '函数名' } }, required: ['name'] } } },
    getCurrentGraphFromGeogebra: { type: 'function', function: { name: 'getCurrentGraphFromGeogebra', description: '获取当前Geogebra图形', parameters: { type: 'object', properties: {}, required: [] } } },
    getCurrentGraphDataFromGeogebra: { type: 'function', function: { name: 'getCurrentGraphDataFromGeogebra', description: '获取Geogebra图形数据', parameters: { type: 'object', properties: {}, required: [] } } },
    initCanvas: { type: 'function', function: { name: 'initCanvas', description: '初始化SVG画布', parameters: { type: 'object', properties: {}, required: [] } } },
    clearCanvas: { type: 'function', function: { name: 'clearCanvas', description: '清空画布所有对象', parameters: { type: 'object', properties: {}, required: [] } } },
    addCanvasObject: { type: 'function', function: { name: 'addCanvasObject', description: '添加SVG对象到画布。支持：rect(矩形)、circle(圆)、ellipse(椭圆)、line(直线)、polyline(折线)、polygon(多边形)、path(路径)、text(文本)', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text'], description: 'SVG对象类型' }, id: { type: 'string', description: '对象ID（唯一标识）' }, attributes: { type: 'object', description: 'SVG属性，如{x:10,y:10,width:100,height:50,fill:"red",stroke:"black"}' } }, required: ['type', 'id', 'attributes'] } } },
    updateCanvasObject: { type: 'function', function: { name: 'updateCanvasObject', description: '更新画布对象属性', parameters: { type: 'object', properties: { id: { type: 'string', description: '对象ID' }, attributes: { type: 'object', description: '要更新的属性' } }, required: ['id', 'attributes'] } } },
    deleteCanvasObject: { type: 'function', function: { name: 'deleteCanvasObject', description: '删除画布对象', parameters: { type: 'object', properties: { id: { type: 'string', description: '对象ID' } }, required: ['id'] } } },
    exportCanvasSVG: { type: 'function', function: { name: 'exportCanvasSVG', description: '导出画布为SVG文件到工作区', parameters: { type: 'object', properties: { filename: { type: 'string', description: 'SVG文件名（默认canvas.svg）' } }, required: [] } } },
    // ---- CIPYP-CAD schemas ----
    initCipypCad: { type: 'function', function: { name: 'initCipypCad', description: '打开 CIPYP-CAD 独立子应用窗口（2D 制图 CAD）。后续所有 CIPYP-CAD 工具都需要先调用本工具初始化。返回 {ok:true} 或 {ok:false,error}', parameters: { type: 'object', properties: {}, required: [] } } },
    runCipypCadCommand: { type: 'function', function: { name: 'runCipypCadCommand', description: '在 CIPYP-CAD 中执行单条命令。命令语法(类AutoCAD命令行)：\n- line x1,y1 x2,y2  (直线)\n- polyline x1,y1 x2,y2 [x3,y3 ...] [--closed]  (多段线)\n- rect x1,y1 x2,y2  (矩形)\n- circle cx,cy radius\n- arc cx,cy radius startDeg endDeg  (圆弧,角度制,逆时针)\n- ellipse cx,cy rx ry [rotationDeg]\n- text x,y "content" [height] [rotationDeg]\n- dim x1,y1 x2,y2 [offset]  (线性标注)\n- hatch x1,y1 x2,y2 x3,y3 ... [--angle deg] [--spacing n]\n- layer new NAME [color] / layer delete NAME / layer current NAME / layer color NAME COLOR / layer on|off NAME / layer list\n- select all | clear | id <id> [--add] | layer <name>\n- move sel|all|id <id> dx,dy\n- rotate sel|all angleDeg [cx,cy]\n- scale sel|all factor [cx,cy]\n- mirror sel|all x1,y1 x2,y2  (镜像轴穿过两点)\n- delete sel | delete id <id>\n- clear  (清空所有对象)\n- zoom factor\n- pan dx,dy\n- fit  (自适应视图)\n- help [command]\n返回 {ok:true,result:{id,type,...}} 或 {ok:false,error}', parameters: { type: 'object', properties: { command: { type: 'string', description: '命令字符串, 如 "line 0,0 100,100"' } }, required: ['command'] } } },
    runCipypCadCommands: { type: 'function', function: { name: 'runCipypCadCommands', description: '批量执行 CIPYP-CAD 命令(原子性: 全部按顺序执行,但不会因单条失败而中止)。返回 {ok:true,results:Array}。当需要绘制多个对象时优先使用本工具以减少 IPC 开销', parameters: { type: 'object', properties: { commands: { type: 'array', items: { type: 'string' }, description: '命令字符串数组' } }, required: ['commands'] } } },
    getCipypCadState: { type: 'function', function: { name: 'getCipypCadState', description: '查询 CIPYP-CAD 当前文档状态: 对象总数、图层列表、当前图层、选中数、视图(pan/zoom)、是否已修改。返回 {ok:true,state:{...}}', parameters: { type: 'object', properties: {}, required: [] } } },
    getCadObjectList: { type: 'function', function: { name: 'getCadObjectList', description: '列出 CIPYP-CAD 图纸中所有对象的完整信息 (id/type/layer/selected/props)。返回 {ok:true,objects:Array}', parameters: { type: 'object', properties: {}, required: [] } } },
    saveCipypCadProject: { type: 'function', function: { name: 'saveCipypCadProject', description: '保存 CIPYP-CAD 工程为标准 .cipyproj 格式 (JSON)。若不指定 path 则保存到当前工作区', parameters: { type: 'object', properties: { path: { type: 'string', description: '绝对路径(可选, 默认 <工作区>/project.cipyproj)' }, filename: { type: 'string', description: '若未提供 path 则使用此文件名(默认 project.cipyproj)' } }, required: [] } } },
    loadCipypCadProject: { type: 'function', function: { name: 'loadCipypCadProject', description: '从 .cipyproj 文件加载 CIPYP-CAD 工程(替换当前图纸)', parameters: { type: 'object', properties: { path: { type: 'string', description: '工程文件绝对路径' } }, required: ['path'] } } },
    exportCipypCadDxf: { type: 'function', function: { name: 'exportCipypCadDxf', description: '导出 CIPYP-CAD 图纸为标准 DXF (AutoCAD R12 ASCII) 文件, 可被 AutoCAD/FreeCAD/QCAD/LibreCAD 等打开', parameters: { type: 'object', properties: { path: { type: 'string', description: '绝对路径(可选, 默认 <工作区>/export.dxf)' }, filename: { type: 'string', description: '默认 export.dxf' } }, required: [] } } },
    exportCipypCadImage: { type: 'function', function: { name: 'exportCipypCadImage', description: '导出 CIPYP-CAD 图纸为 PNG 或 SVG 图片', parameters: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'svg'], description: '图片格式(默认png)' }, path: { type: 'string', description: '绝对路径(可选, 默认 <工作区>/export.<ext>)' }, filename: { type: 'string', description: '若未提供 path 则使用此文件名' } }, required: [] } } },
    closeCipypCad: { type: 'function', function: { name: 'closeCipypCad', description: '关闭 CIPYP-CAD 窗口（若有未保存修改，会自动保存到最近一次保存/加载的路径，或回退到 userData/recovery/ 目录）', parameters: { type: 'object', properties: {}, required: [] } } },
    // ---- CIBYP-PCB-EDA schemas ----
    initPcbEda: { type: 'function', function: { name: 'initPcbEda', description: '打开 CIBYP-PCB-EDA 独立子应用窗口（原理图编辑器 + PCB 布局布线 + 3D 预览 + Gerber 生产文件导出）。后续所有 PCB-EDA 工具都需要先调用本工具初始化。返回 {ok:true} 或 {ok:false,error}', parameters: { type: 'object', properties: {}, required: [] } } },
    closePcbEda: { type: 'function', function: { name: 'closePcbEda', description: '关闭 CIBYP-PCB-EDA 窗口（若有未保存修改，会自动保存到最近一次保存/加载的路径，或回退到 userData/recovery/ 目录）', parameters: { type: 'object', properties: {}, required: [] } } },
    pcbNewProject: { type: 'function', function: { name: 'pcbNewProject', description: '新建 PCB 工程（重置当前工程）。返回 {ok:true}', parameters: { type: 'object', properties: { name: { type: 'string', description: '工程名' }, width: { type: 'number', description: '板宽 mm (默认100)' }, height: { type: 'number', description: '板高 mm (默认80)' }, layers: { type: 'number', description: '铜层数 1-16 (默认2)' } }, required: ['name'] } } },
    pcbSetDesignRules: { type: 'function', function: { name: 'pcbSetDesignRules', description: '设置 PCB 设计规则（DRC 依据），全部参数可选，仅更新传入项。返回 {ok:true}', parameters: { type: 'object', properties: { minClearance: { type: 'number', description: '最小铜间距 mm (默认0.2)' }, minTraceWidth: { type: 'number', description: '最小线宽 mm (默认0.15)' }, minViaDrill: { type: 'number', description: '最小过孔钻孔 mm (默认0.3)' }, minViaDiameter: { type: 'number', description: '最小过孔外径 mm (默认0.6)' }, minAnnularRing: { type: 'number', description: '最小环宽 mm (默认0.13)' }, minHoleToHole: { type: 'number', description: '最小孔间距 mm (默认0.25)' }, copperToBoardEdge: { type: 'number', description: '铜到板边最小距离 mm (默认0.3)' }, solderMaskExpansion: { type: 'number', description: '阻焊膨胀 mm (默认0.05)' }, pasteExpansion: { type: 'number', description: '钢网膨胀/收缩 mm (默认0)' }, defaultTraceWidth: { type: 'number', description: '默认线宽 mm (默认0.25)' }, defaultViaDrill: { type: 'number', description: '默认过孔钻孔 mm (默认0.3)' }, defaultViaDiameter: { type: 'number', description: '默认过孔外径 mm (默认0.6)' }, zoneClearance: { type: 'number', description: '铺铜默认避让 mm (默认0.3)' }, zoneThermalWidth: { type: 'number', description: '热焊盘辐条宽 mm (默认0.25)' } }, required: [] } } },
    pcbSetStackup: { type: 'function', function: { name: 'pcbSetStackup', description: '设置层叠结构。返回 {ok:true}', parameters: { type: 'object', properties: { copperLayers: { type: 'number', description: '铜层数 1-16' }, boardThickness: { type: 'number', description: '板厚 mm (默认1.6)' }, material: { type: 'string', description: '基材 (默认FR4)' } }, required: [] } } },
    pcbSetOutline: { type: 'function', function: { name: 'pcbSetOutline', description: '设置板框轮廓（多边形，mm）。返回 {ok:true}', parameters: { type: 'object', properties: { points: { type: 'array', items: { type: 'string' }, description: '顶点数组 "x,y"，至少3个，如 ["0,0","80,0","80,60","0,60"]' } }, required: ['points'] } } },
    pcbSchAddSymbol: { type: 'function', function: { name: 'pcbSchAddSymbol', description: '原理图放置元件符号。返回 {ok:true,ref,x,y,rot,pins:[{num,name,x,y}]}（pins 为每个引脚的全局坐标，已含 rot/mirror 变换，画 wire 时直接用）。原理图坐标建议用 2.54 的整数倍', parameters: { type: 'object', properties: { lib: { type: 'string', enum: ['R', 'C', 'C_Polar', 'L', 'D', 'LED', 'Zener', 'Q_NPN', 'Q_PNP', 'NMOS', 'OPAMP', 'XTAL', 'FUSE', 'SW', 'SW_PUSH', 'SPK', 'ANT', 'BAT', 'TP', 'POT', 'IC', 'CONN'], description: '符号类型' }, ref: { type: 'string', description: '位号(可选,自动分配)' }, value: { type: 'string', description: '元件值(如 10k, 100nF)' }, footprint: { type: 'string', description: 'PCB 封装名(可选,默认按符号推荐, 见 pcbAddComponent 枚举)' }, x: { type: 'number', description: 'X mm' }, y: { type: 'number', description: 'Y mm' }, rot: { type: 'number', description: '旋转角度 (默认0)' }, pins: { type: 'number', description: '仅 CONN: 针数 (默认4)' }, left: { type: 'array', items: { type: 'string' }, description: '仅 IC: 左侧引脚名数组' }, right: { type: 'array', items: { type: 'string' }, description: '仅 IC: 右侧引脚名数组' } }, required: ['lib', 'x', 'y'] } } },
    pcbSchAddWire: { type: 'function', function: { name: 'pcbSchAddWire', description: '原理图绘制导线（折线）。返回 {ok:true}', parameters: { type: 'object', properties: { points: { type: 'array', items: { type: 'string' }, description: '顶点数组 "x,y"，至少2个' } }, required: ['points'] } } },
    pcbSchAddLabel: { type: 'function', function: { name: 'pcbSchAddLabel', description: '原理图放置网络标签（同名标签自动属于同一网络）。返回 {ok:true}', parameters: { type: 'object', properties: { text: { type: 'string', description: '网络名(如 VCC, SDA, NET1)' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['text', 'x', 'y'] } } },
    pcbSchAddPower: { type: 'function', function: { name: 'pcbSchAddPower', description: '原理图放置电源符号（同名电源自动同网络）。返回 {ok:true}', parameters: { type: 'object', properties: { ptype: { type: 'string', description: '电源类型: GND/VCC/+5V/+3V3/+12V/-12V/AGND 或自定义名' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['ptype', 'x', 'y'] } } },
    pcbSchAnnotate: { type: 'function', function: { name: 'pcbSchAnnotate', description: '原理图自动标注所有未编号元件的位号。返回 {ok:true,annotated}', parameters: { type: 'object', properties: {}, required: [] } } },
    pcbSchSync: { type: 'function', function: { name: 'pcbSchSync', description: '原理图同步到 PCB：按原理图生成/更新 PCB 元件与焊盘网络（布局布线前必须执行）。返回 {ok:true,created,updated,nets}', parameters: { type: 'object', properties: {}, required: [] } } },
    pcbRunERC: { type: 'function', function: { name: 'pcbRunERC', description: '原理图电气规则检查：未连接引脚/位号重复/缺失封装/单引脚网络。返回 {ok:true,count,errors}', parameters: { type: 'object', properties: {}, required: [] } } },
    pcbAddComponent: { type: 'function', function: { name: 'pcbAddComponent', description: 'PCB 直接放置元件（不经过原理图时）。返回 {ok:true,ref,x,y,rot,side,pads:[{num,x,y,w,h,net,side}]}（pads 为每个焊盘的全局坐标，已含 rot/side 镜像变换，画 trace 时直接用）', parameters: { type: 'object', properties: { footprint: { type: 'string', enum: ['R_0201', 'R_0402', 'R_0603', 'R_0805', 'R_1206', 'R_2512', 'C_0402', 'C_0603', 'C_0805', 'C_1206', 'L_0603', 'L_0805', 'LED_0603', 'LED_0805', 'D_SOD123', 'CHIP_CUSTOM', 'SOT23-3', 'SOT23-5', 'SOT23-6', 'SOT223', 'SOIC-8', 'SOIC-14', 'SOIC-16', 'TSSOP-8', 'TSSOP-16', 'TSSOP-20', 'SOIC_CUSTOM', 'QFP-32', 'QFP-44', 'QFP-48', 'QFP-64', 'QFP-100', 'QFP_CUSTOM', 'QFN-16', 'QFN-32', 'QFN-48', 'QFN_CUSTOM', 'DIP-8', 'DIP-14', 'DIP-16', 'DIP-20', 'DIP-28', 'DIP-40', 'DIP_CUSTOM', 'HDR-1x4', 'HDR-1x6', 'HDR-1x8', 'HDR-1x10', 'HDR-2x3', 'HDR-2x5', 'HDR-2x10', 'HDR_CUSTOM', 'TBLOCK-2', 'TBLOCK-3', 'TBLOCK-4', 'TBLOCK_CUSTOM', 'USB-C-16', 'CAP-RADIAL-5', 'CAP-RADIAL-6.3', 'CAP-RADIAL-8', 'CAP-RADIAL-10', 'CAP_CUSTOM', 'AXIAL-10.16', 'AXIAL-7.62', 'AXIAL-15.24', 'XTAL-HC49', 'XTAL-3225', 'LED-3mm', 'LED-5mm', 'BUTTON-6x6', 'POT-3296', 'BUZZER-12', 'BAT-CR2032', 'MOUNT-M2', 'MOUNT-M3', 'MOUNT-M4', 'MOUNT-NPTH-M3', 'TP-SMD', 'TP-TH'], description: '封装名。CUSTOM 系列需配合 params 全参数' }, ref: { type: 'string', description: '位号(如 R1, U2)' }, value: { type: 'string', description: '元件值' }, x: { type: 'number', description: 'X mm' }, y: { type: 'number', description: 'Y mm' }, rot: { type: 'number', description: '旋转角 (默认0)' }, side: { type: 'string', enum: ['F', 'B'], description: '顶层F/底层B (默认F)' }, params: { type: 'object', description: 'CUSTOM 封装全参数: CHIP_CUSTOM{size,padW,padH,gap} SOIC_CUSTOM{pins,pitch,padW,padL,rowDist} QFP_CUSTOM{pins,pitch,body,padW,padL} QFN_CUSTOM{pins,pitch,body,epad,epadSize} DIP_CUSTOM{pins,pitch,rowPitch,holeD,padD} HDR_CUSTOM{pins,rows,pitch,holeD,padD} TBLOCK_CUSTOM{pins,pitch,holeD,padD} CAP_CUSTOM{bodyD,pitch,holeD,padD}' } }, required: ['footprint', 'ref', 'x', 'y'] } } },
    pcbMoveComponent: { type: 'function', function: { name: 'pcbMoveComponent', description: '移动元件到指定坐标。返回 {ok:true}', parameters: { type: 'object', properties: { ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['ref', 'x', 'y'] } } },
    pcbRotateComponent: { type: 'function', function: { name: 'pcbRotateComponent', description: '设置元件旋转角。返回 {ok:true}', parameters: { type: 'object', properties: { ref: { type: 'string' }, rot: { type: 'number', description: '角度 0/90/180/270 或任意' } }, required: ['ref', 'rot'] } } },
    pcbDeleteComponent: { type: 'function', function: { name: 'pcbDeleteComponent', description: '删除元件。返回 {ok:true}', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
    pcbListComponents: { type: 'function', function: { name: 'pcbListComponents', description: '列出 PCB 所有元件（位号/值/封装/坐标/焊盘网络）。返回 {ok:true,components}', parameters: { type: 'object', properties: {}, required: [] } } },
    pcbSetPadNet: { type: 'function', function: { name: 'pcbSetPadNet', description: '设置元件某焊盘的网络（空字符串表示断开）。返回 {ok:true}', parameters: { type: 'object', properties: { ref: { type: 'string' }, pad: { type: 'string', description: '焊盘号(如 "1")' }, net: { type: 'string', description: '网络名' } }, required: ['ref', 'pad', 'net'] } } },
    pcbRouteTrace: { type: 'function', function: { name: 'pcbRouteTrace', description: 'PCB 手动布线（折线）。返回 {ok:true,id}', parameters: { type: 'object', properties: { net: { type: 'string', description: '网络名' }, layer: { type: 'string', description: '铜层: F.Cu/B.Cu/In1.Cu... (默认F.Cu)' }, width: { type: 'number', description: '线宽 mm (默认设计规则默认线宽)' }, points: { type: 'array', items: { type: 'string' }, description: '路径点数组 "x,y"，至少2个，建议45°折线' } }, required: ['net', 'points'] } } },
    pcbAddVia: { type: 'function', function: { name: 'pcbAddVia', description: '放置过孔。返回 {ok:true,id}', parameters: { type: 'object', properties: { net: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, drill: { type: 'number', description: '钻孔 mm (默认0.3)' }, diameter: { type: 'number', description: '外径 mm (默认0.6)' } }, required: ['net', 'x', 'y'] } } },
    pcbAddCopperPour: { type: 'function', function: { name: 'pcbAddCopperPour', description: '添加铺铜区域（自动避让异网+热焊盘连接同网，Gerber 用 LP 负片工艺输出）。返回 {ok:true,id}', parameters: { type: 'object', properties: { net: { type: 'string', description: '网络名(如 GND)' }, layer: { type: 'string', description: '铜层 (默认F.Cu)' }, points: { type: 'array', items: { type: 'string' }, description: '多边形顶点 "x,y"，至少3个' }, clearance: { type: 'number', description: '避让间距 mm (默认0.3)' }, thermalWidth: { type: 'number', description: '热焊盘辐条宽 mm (默认0.25)' } }, required: ['net', 'points'] } } },
    pcbAddSilkscreen: { type: 'function', function: { name: 'pcbAddSilkscreen', description: '添加丝印图形。返回 {ok:true}', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['line', 'rect', 'circle', 'text'], description: '类型' }, side: { type: 'string', enum: ['F', 'B'], description: '面(默认F)' }, x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number', description: 'line/rect 需要' }, y2: { type: 'number', description: 'line/rect 需要' }, r: { type: 'number', description: 'circle 半径' }, text: { type: 'string', description: 'text 内容(仅ASCII)' }, size: { type: 'number', description: 'text 字高 mm (默认1.2)' } }, required: ['kind', 'x1', 'y1'] } } },
    pcbRunDRC: { type: 'function', function: { name: 'pcbRunDRC', description: '运行 PCB 设计规则检查：铜间距/线宽/孔径/环宽/板边距/未布线网络。返回 {ok:true,count,errors:[{severity,type,message,x,y}]}', parameters: { type: 'object', properties: {}, required: [] } } },
    pcbAutoroute: { type: 'function', function: { name: 'pcbAutoroute', description: '自动布线（A* 网格布线器，顺序布各网络，失败网络返回列表可手动处理）。返回 {ok:true,routed,failed,failedNets}', parameters: { type: 'object', properties: { nets: { type: 'array', items: { type: 'string' }, description: '仅布指定网络(可选,默认全部未布网络)' }, traceWidth: { type: 'number', description: '线宽 mm (默认设计规则默认线宽)' }, clearance: { type: 'number', description: '间距 mm (默认设计规则最小间距)' } }, required: [] } } },
    pcbGetBoardInfo: { type: 'function', function: { name: 'pcbGetBoardInfo', description: '获取板子统计信息（元件/焊盘/走线/过孔/网络/未布线数/层叠/设计规则）。返回 {ok:true,...}', parameters: { type: 'object', properties: {}, required: [] } } },
    pcbListLibrary: { type: 'function', function: { name: 'pcbListLibrary', description: '列出可用封装库或原理图符号库。返回 {ok:true,items}', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['footprint', 'symbol'], description: '库类型(默认footprint)' } }, required: [] } } },
    pcbSaveProject: { type: 'function', function: { name: 'pcbSaveProject', description: '保存 PCB 工程。单文件 .cipypcb（原理图+PCB一体）或多文件工程（.cibypcbproj 清单 + 每图纸/板一文件）', parameters: { type: 'object', properties: { path: { type: 'string', description: '绝对路径(可选,默认 <工作区>/<name>.cipypcb)' }, filename: { type: 'string', description: '若未提供 path 则使用此文件名' }, multi: { type: 'boolean', description: 'true=多文件工程(清单+分文件), false=单文件(默认)' } }, required: [] } } },
    pcbLoadProject: { type: 'function', function: { name: 'pcbLoadProject', description: '加载 PCB 工程（.cipypcb/.cibypcbproj），也可直接加载 .kicad_pcb/.net/.csv 作为导入', parameters: { type: 'object', properties: { path: { type: 'string', description: '工程文件绝对路径' } }, required: ['path'] } } },
    pcbImportFile: { type: 'function', function: { name: 'pcbImportFile', description: '导入其他 EDA 文件：KiCad 工程(.kicad_pcb)、KiCad 网表(.net)、CSV 网表(ref,pad,net)。导入 KiCad 工程会替换当前 PCB；导入网表会合并元件与网络。返回 {ok:true,type,...}', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' } }, required: ['path'] } } },
    pcbExportGerber: { type: 'function', function: { name: 'pcbExportGerber', description: '导出完整 Gerber 生产文件包：全部铜层(RS-274X)+阻焊+丝印+钢网+板框+PTH/NPTH 钻孔(Excellon)+IPC-D-356 测试网表+PnP+BOM。文件命名兼容嘉立创/JLCPCB。返回 {ok:true,count,zipPath|paths}', parameters: { type: 'object', properties: { dir: { type: 'string', description: '导出目录(可选,默认 <工作区>/gerber_<时间戳>)' }, zip: { type: 'boolean', description: '是否打包为 zip (默认true)' }, naming: { type: 'string', enum: ['jlc', 'protel'], description: '命名风格(默认jlc)' }, tentedVias: { type: 'boolean', description: '过孔盖油(默认false=开窗)' } }, required: [] } } },
    pcbExportFile: { type: 'function', function: { name: 'pcbExportFile', description: '导出单一文件：KiCad 工程/网表/SVG/PNG/3D 模型/贴片坐标/BOM。返回 {ok:true,path}', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['kicad', 'netlist-kicad', 'netlist-csv', 'svg-pcb', 'svg-sch', 'png-pcb', 'png-3d', 'obj', 'pnp', 'bom'], description: '导出类型: kicad=.kicad_pcb工程; netlist-kicad=KiCad网表; netlist-csv=CSV网表; svg-pcb/svg-sch=2D矢量预览; png-pcb/png-3d=位图预览; obj=3D模型(OBJ+MTL); pnp=贴片坐标; bom=物料清单' }, path: { type: 'string', description: '绝对路径(可选,默认 <工作区>/<name>.<ext>)' }, filename: { type: 'string', description: '若未提供 path 则使用此文件名' } }, required: ['kind'] } } },
    runPcbEdaCommand: { type: 'function', function: { name: 'runPcbEdaCommand', description: '在 PCB-EDA 中执行单条命令（高级兜底，优先使用专用工具）。命令: new/board/rules/stackup/comp/net/trace/via/zone/silk/sch/drc/erc/autoroute/clear/del/mode/fit/undo/redo/state/help。例: "comp add R_0805 R1 20 20"、"trace GND F.Cu 0.3 10,10 30,10 30,25"。返回 {ok:true} 或 {ok:false,error}', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    runPcbEdaCommands: { type: 'function', function: { name: 'runPcbEdaCommands', description: '批量执行多条 PCB-EDA 命令（顺序执行，单条失败不中止）。返回 {ok:true,results:Array}', parameters: { type: 'object', properties: { commands: { type: 'array', items: { type: 'string' }, description: '命令字符串数组' } }, required: ['commands'] } } },
    askQuestions: { type: 'function', function: { name: 'askQuestions', description: '向用户提出问题收集信息，支持单选/多选/自由输入。返回{ok:true,answers:Array}', parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string', description: '问题文本' }, options: { type: 'array', items: { type: 'string' }, description: '选项列表(可选,留空则为自由输入)' }, multiSelect: { type: 'boolean', description: '是否多选(仅当有options时有效)' } }, required: ['question'] }, description: '问题列表' } }, required: ['questions'] } } },
    eslintLint: { type: 'function', function: { name: 'eslintLint', description: '对当前 Code 模式工作区执行 ESLint 静态代码诊断。返回所有支持文件（JS/TS/JSX/TSX/Vue/Svelte 等）中的错误、警告与提示信息，包含文件路径、行号、列号、严重性、规则 ID 与消息。当用户报告代码有 bug、询问代码质量、要求重构或修复 lint 报错时优先调用本工具获取全量诊断。返回 {ok, summary:{total,errors,warnings,infos,fileCount,scannedFiles}, results:[{filePath,file,line,column,severity,message,ruleId}], error?}。', parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: '可选：仅诊断指定的文件列表（绝对路径或相对工作区路径）。不传则扫描整个工作区。' }, maxFiles: { type: 'number', description: '可选：单次扫描文件数上限（默认 500）' } }, required: [] } } },
    eslintLintFile: { type: 'function', function: { name: 'eslintLintFile', description: '对单个文件执行 ESLint 诊断（用于打开文件后实时检查或聚焦修复某文件的 lint 问题）。返回 {ok, summary, results, error?}。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要诊断的文件路径（绝对路径或工作区相对路径）' } }, required: ['path'] } } },
    downloadFile: { type: 'function', function: { name: 'downloadFile', description: '从互联网下载文件到工作区目录', parameters: { type: 'object', properties: { url: { type: 'string', description: '文件URL' }, filename: { type: 'string', description: '保存的文件名(可选,默认从URL提取)' } }, required: ['url'] } } },
    inviteGame: { type: 'function', function: { name: 'inviteGame', description: '邀请用户玩游戏。游戏类型：flyingFlower(飞花令,诗词接龙)、sanguosha(三国杀,卡牌策略)、undercover(谁是卧底,推理游戏)、idiom(成语接龙,四字成语首尾相接)、guessCharacter(是否猜人物,通过是/否提问猜出人物)。会向用户展示一张游戏邀请卡片，用户可以接受或忽略，并指定AI参与人数。', parameters: { type: 'object', properties: { game: { type: 'string', enum: ['flyingFlower', 'sanguosha', 'undercover', 'idiom', 'guessCharacter'], description: '游戏类型' }, message: { type: 'string', description: '邀请语（显示在邀请卡片上）' }, suggestedAgents: { type: 'number', description: '建议的AI Agent参与人数(用户可调整)' } }, required: ['game'] } } },
    mcpListTools: { type: 'function', function: { name: 'mcpListTools', description: '列出并刷新所有已连接MCP服务器的工具。刷新后MCP工具会作为独立工具可直接调用（mcp__serverName__toolName格式）。', parameters: { type: 'object', properties: { serverName: { type: 'string', description: '可选,指定MCP服务器名称,不传则列出所有' } }, required: [] } } },
    // ---- 扩充网络工具 schemas ----
    httpRequest: { type: 'function', function: { name: 'httpRequest', description: '发送自定义HTTP/HTTPS请求。支持GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS等所有方法，可设请求头、请求体、超时。响应包含状态码、响应头和响应体。', parameters: { type: 'object', properties: { url: { type: 'string', description: '请求URL' }, method: { type: 'string', description: 'HTTP方法(默认GET)', enum: ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'] }, headers: { type: 'object', description: '请求头键值对' }, body: { type: 'string', description: '请求体(字符串或JSON字符串)' }, timeout: { type: 'number', description: '超时毫秒数(默认30000)' }, encoding: { type: 'string', description: '响应编码(默认utf8, 可选base64)' }, followRedirects: { type: 'boolean', description: '是否跟随重定向(默认true)' } }, required: ['url'] } } },
    httpFormPost: { type: 'function', function: { name: 'httpFormPost', description: '发送application/x-www-form-urlencoded或multipart/form-data表单请求', parameters: { type: 'object', properties: { url: { type: 'string', description: '请求URL' }, fields: { type: 'object', description: '表单字段键值对' }, files: { type: 'array', items: { type: 'object', properties: { fieldName: { type: 'string' }, filePath: { type: 'string' }, fileName: { type: 'string' } }, required: ['fieldName','filePath'] }, description: '要上传的文件列表(可选)' }, headers: { type: 'object', description: '额外请求头' } }, required: ['url','fields'] } } },
    dnsLookup: { type: 'function', function: { name: 'dnsLookup', description: 'DNS域名解析，返回A/AAAA/MX/TXT/NS/CNAME等记录', parameters: { type: 'object', properties: { hostname: { type: 'string', description: '要解析的域名' }, rrtype: { type: 'string', description: '记录类型(默认A)', enum: ['A','AAAA','MX','TXT','NS','CNAME','SOA','SRV','ANY'] } }, required: ['hostname'] } } },
    ping: { type: 'function', function: { name: 'ping', description: 'Ping目标主机，返回延迟和可达性', parameters: { type: 'object', properties: { host: { type: 'string', description: '主机名或IP' }, count: { type: 'number', description: 'ping次数(默认4)' } }, required: ['host'] } } },
    urlShorten: { type: 'function', function: { name: 'urlShorten', description: '展开短链接/分析URL重定向链', parameters: { type: 'object', properties: { url: { type: 'string', description: '短链接URL' } }, required: ['url'] } } },
    urlEncodeDecode: { type: 'function', function: { name: 'urlEncodeDecode', description: 'URL编码/解码以及Base64编码/解码', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入字符串' }, operation: { type: 'string', enum: ['urlEncode','urlDecode','base64Encode','base64Decode'], description: '操作类型' } }, required: ['input','operation'] } } },
    checkSSLCert: { type: 'function', function: { name: 'checkSSLCert', description: '获取网站HTTPS/SSL证书详情(颁发者、有效期、SAN等)', parameters: { type: 'object', properties: { hostname: { type: 'string', description: '主机名(不含https://)' }, port: { type: 'number', description: '端口(默认443)' } }, required: ['hostname'] } } },
    traceroute: { type: 'function', function: { name: 'traceroute', description: '路由追踪(tracert)，显示到目标主机的跳数、延迟', parameters: { type: 'object', properties: { host: { type: 'string', description: '目标主机' } }, required: ['host'] } } },
    portScan: { type: 'function', function: { name: 'portScan', description: '扫描目标主机的指定端口范围，返回开放端口列表', parameters: { type: 'object', properties: { host: { type: 'string', description: '目标主机' }, ports: { type: 'string', description: '端口范围(如 80,443,8000-8100)' }, timeout: { type: 'number', description: '每端口超时ms(默认2000)' } }, required: ['host','ports'] } } },
    // Serial Port
    serialListPorts: { type: 'function', function: { name: 'serialListPorts', description: '列出系统所有可用串口（COM端口）及其详细信息', parameters: { type: 'object', properties: {}, required: [] } } },
    serialOpenPort: { type: 'function', function: { name: 'serialOpenPort', description: '打开指定串口并建立连接。成功后可用serialWritePort/serialReadPort读写数据。', parameters: { type: 'object', properties: { path: { type: 'string', description: '串口路径(如COM3、/dev/ttyUSB0)' }, baudRate: { type: 'number', description: '波特率(默认9600)' }, dataBits: { type: 'number', enum: [5, 6, 7, 8], description: '数据位(默认8)' }, stopBits: { type: 'number', enum: [1, 1.5, 2], description: '停止位(默认1)' }, parity: { type: 'string', enum: ['none', 'even', 'odd', 'mark', 'space'], description: '校验位(默认none)' } }, required: ['path'] } } },
    serialWritePort: { type: 'function', function: { name: 'serialWritePort', description: '向已打开的串口写入数据', parameters: { type: 'object', properties: { path: { type: 'string', description: '串口路径' }, data: { type: 'string', description: '要写入的文本数据' }, encoding: { type: 'string', enum: ['utf8', 'ascii', 'hex', 'base64'], description: '编码格式(默认utf8)' } }, required: ['path', 'data'] } } },
    serialReadPort: { type: 'function', function: { name: 'serialReadPort', description: '读取已打开串口缓冲区中的数据。返回自上次读取以来接收到的所有数据。', parameters: { type: 'object', properties: { path: { type: 'string', description: '串口路径' }, timeout: { type: 'number', description: '等待数据的超时毫秒数(默认1000)' }, encoding: { type: 'string', enum: ['utf8', 'ascii', 'hex', 'base64'], description: '返回数据的编码(默认utf8)' } }, required: ['path'] } } },
    serialClosePort: { type: 'function', function: { name: 'serialClosePort', description: '关闭已打开的串口连接', parameters: { type: 'object', properties: { path: { type: 'string', description: '串口路径' } }, required: ['path'] } } },
    serialSetSignals: { type: 'function', function: { name: 'serialSetSignals', description: '设置串口控制信号(DTR/RTS)，可用于复位开发板等', parameters: { type: 'object', properties: { path: { type: 'string', description: '串口路径' }, dtr: { type: 'boolean', description: '设置DTR信号' }, rts: { type: 'boolean', description: '设置RTS信号' }, brk: { type: 'boolean', description: '设置BREAK信号' } }, required: ['path'] } } },
    // Office
    officeUnpack: { type: 'function', function: { name: 'officeUnpack', description: '将Office文件(.docx/.xlsx/.pptx)解压到工作区目录，以便直接操作内部XML。解压目录名为原文件名加_unpacked后缀。', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Office文件路径' } }, required: ['path'] } } },
    officeListContents: { type: 'function', function: { name: 'officeListContents', description: '列出Office解压目录的全部内部文件结构', parameters: { type: 'object', properties: { dir: { type: 'string', description: '解压后的目录路径' } }, required: ['dir'] } } },
    officeReadInnerFile: { type: 'function', function: { name: 'officeReadInnerFile', description: '读取Office解压目录中的内部文件(XML/rels等)', parameters: { type: 'object', properties: { path: { type: 'string', description: '内部文件的完整路径' } }, required: ['path'] } } },
    officeWriteInnerFile: { type: 'function', function: { name: 'officeWriteInnerFile', description: '写入/覆盖Office解压目录中的内部文件', parameters: { type: 'object', properties: { path: { type: 'string', description: '内部文件的完整路径' }, content: { type: 'string', description: '新的文件内容' } }, required: ['path', 'content'] } } },
    officeRepack: { type: 'function', function: { name: 'officeRepack', description: '将解压目录重新打包为Office文件(.docx/.xlsx/.pptx)。输出路径默认覆盖原文件，也可指定新路径。', parameters: { type: 'object', properties: { dir: { type: 'string', description: '解压后的目录路径' }, outputPath: { type: 'string', description: '输出文件路径(可选,默认覆盖原文件)' } }, required: ['dir'] } } },
    officeGetSlideTexts: { type: 'function', function: { name: 'officeGetSlideTexts', description: '从已解压的PPTX/DOCX中提取指定幻灯片XML里的所有文字节点，返回{index, text}数组（完全去除XML结构，token极少）。对于PPTX进行翻译等操作时必须优先使用此工具代替officeReadInnerFile。', parameters: { type: 'object', properties: { dir: { type: 'string', description: '解压后的目录路径' }, slideFile: { type: 'string', description: '幻灯片文件相对路径，如 ppt/slides/slide1.xml' } }, required: ['dir', 'slideFile'] } } },
    officeSetSlideTexts: { type: 'function', function: { name: 'officeSetSlideTexts', description: '将翻译后的文字写回指定幻灯片XML（与officeGetSlideTexts配套）。translations为{index, text}数组，index对应officeGetSlideTexts返回的index字段。直接修改文件，无需手动写XML。', parameters: { type: 'object', properties: { dir: { type: 'string', description: '解压后的目录路径' }, slideFile: { type: 'string', description: '幻灯片文件相对路径' }, translations: { type: 'array', items: { type: 'object', properties: { index: { type: 'number', description: '文字节点索引（来自officeGetSlideTexts）' }, text: { type: 'string', description: '处理后的文字' } }, required: ['index', 'text'] }, description: '处理结果列表' } }, required: ['dir', 'slideFile', 'translations'] } } },
    officeWordExtract: { type: 'function', function: { name: 'officeWordExtract', description: '提取Word文档（.docx/.odt）的文字与样式信息。可传文档文件路径或已解压目录，文件会自动解压。', parameters: { type: 'object', properties: { pathOrDir: { type: 'string', description: '文档路径或解压目录' }, includeEmpty: { type: 'boolean', description: '是否包含空文本节点，默认false' } }, required: ['pathOrDir'] } } },
    officeWordApplyTexts: { type: 'function', function: { name: 'officeWordApplyTexts', description: '按officeWordExtract返回的index覆写文字，尽可能保持原有格式（字体、段落样式等）。', parameters: { type: 'object', properties: { pathOrDir: { type: 'string', description: '文档路径或解压目录' }, updates: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, text: { type: 'string' } }, required: ['index', 'text'] }, description: '要覆写的文本索引与新文本' } }, required: ['pathOrDir', 'updates'] } } },
    officeWordGetStyles: { type: 'function', function: { name: 'officeWordGetStyles', description: '读取Word文档样式列表（段落/字符样式等），用于按模板保持格式。', parameters: { type: 'object', properties: { pathOrDir: { type: 'string', description: '文档路径或解压目录' } }, required: ['pathOrDir'] } } },
    officeWordFillTemplate: { type: 'function', function: { name: 'officeWordFillTemplate', description: '按占位符批量填充Word模板，支持 {{KEY}} / ${KEY} / <<KEY>> 三种占位符。', parameters: { type: 'object', properties: { pathOrDir: { type: 'string', description: '文档路径或解压目录' }, replacements: { type: 'object', description: '键值映射，如 {"NAME":"张三"}' } }, required: ['pathOrDir', 'replacements'] } } },
    // ---- Spreadsheet ----
    initSpreadsheet: { type: 'function', function: { name: 'initSpreadsheet', description: '打开数据表格侧栏面板。处理表格数据/数据集分析/数据可视化时应优先使用此工具，而非拆解Office文件。支持公式计算（SUM/AVERAGE/COUNT/MAX/MIN/IF/VLOOKUP等60+函数）、单元格格式设置、CSV导入导出、排序等功能。', parameters: { type: 'object', properties: { title: { type: 'string', description: '表格标题(可选)' } }, required: [] } } },
    spreadsheetSetCells: { type: 'function', function: { name: 'spreadsheetSetCells', description: '批量设置单元格的值或公式。值可以是文本、数字或以=开头的公式（如 =SUM(A1:A10)、=IF(A1>0,"正","负")）。', parameters: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: { addr: { type: 'string', description: '单元格地址(如A1、B3)' }, value: { type: 'string', description: '值或公式(公式以=开头)' } }, required: ['addr', 'value'] }, description: '要设置的单元格列表' } }, required: ['entries'] } } },
    spreadsheetGetCells: { type: 'function', function: { name: 'spreadsheetGetCells', description: '读取指定范围内所有单元格的值、公式和格式', parameters: { type: 'object', properties: { range: { type: 'string', description: '单元格范围(如A1:C10)' } }, required: ['range'] } } },
    spreadsheetSetCellFormat: { type: 'function', function: { name: 'spreadsheetSetCellFormat', description: '设置单个单元格的格式', parameters: { type: 'object', properties: { addr: { type: 'string', description: '单元格地址' }, format: { type: 'object', properties: { bold: { type: 'boolean', description: '粗体' }, italic: { type: 'boolean', description: '斜体' }, color: { type: 'string', description: '文字颜色(CSS颜色值)' }, bg: { type: 'string', description: '背景颜色' }, align: { type: 'string', enum: ['left', 'center', 'right'], description: '对齐方式' }, fontSize: { type: 'number', description: '字号(px)' } }, description: '格式属性' } }, required: ['addr', 'format'] } } },
    spreadsheetSetRangeFormat: { type: 'function', function: { name: 'spreadsheetSetRangeFormat', description: '批量设置范围内所有单元格的格式', parameters: { type: 'object', properties: { range: { type: 'string', description: '范围(如A1:D1)' }, format: { type: 'object', properties: { bold: { type: 'boolean' }, italic: { type: 'boolean' }, color: { type: 'string' }, bg: { type: 'string' }, align: { type: 'string', enum: ['left', 'center', 'right'] }, fontSize: { type: 'number' } } } }, required: ['range', 'format'] } } },
    spreadsheetClearCells: { type: 'function', function: { name: 'spreadsheetClearCells', description: '清空单元格。提供range则清空该范围，不提供则清空全部。', parameters: { type: 'object', properties: { range: { type: 'string', description: '要清空的范围(可选，如A1:C10)' } }, required: [] } } },
    spreadsheetInsertRows: { type: 'function', function: { name: 'spreadsheetInsertRows', description: '在指定行号处插入新行，现有行下移', parameters: { type: 'object', properties: { rowNum: { type: 'number', description: '在此行号前插入' }, count: { type: 'number', description: '插入行数(默认1)' } }, required: ['rowNum'] } } },
    spreadsheetDeleteRows: { type: 'function', function: { name: 'spreadsheetDeleteRows', description: '删除指定行', parameters: { type: 'object', properties: { rowNum: { type: 'number', description: '起始行号' }, count: { type: 'number', description: '删除行数(默认1)' } }, required: ['rowNum'] } } },
    spreadsheetInsertCols: { type: 'function', function: { name: 'spreadsheetInsertCols', description: '在指定列前插入新列，现有列右移', parameters: { type: 'object', properties: { colLetter: { type: 'string', description: '在此列前插入(如B)' }, count: { type: 'number', description: '插入列数(默认1)' } }, required: ['colLetter'] } } },
    spreadsheetDeleteCols: { type: 'function', function: { name: 'spreadsheetDeleteCols', description: '删除指定列', parameters: { type: 'object', properties: { colLetter: { type: 'string', description: '起始列(如C)' }, count: { type: 'number', description: '删除列数(默认1)' } }, required: ['colLetter'] } } },
    spreadsheetSortRange: { type: 'function', function: { name: 'spreadsheetSortRange', description: '按指定列对范围内的数据排序', parameters: { type: 'object', properties: { range: { type: 'string', description: '要排序的范围(如A1:D20)' }, colLetter: { type: 'string', description: '排序依据的列(如B)' }, ascending: { type: 'boolean', description: '升序排列(默认true)' } }, required: ['range', 'colLetter'] } } },
    spreadsheetGetData: { type: 'function', function: { name: 'spreadsheetGetData', description: '获取当前表格的所有非空数据，包含标题、使用范围和所有单元格', parameters: { type: 'object', properties: {}, required: [] } } },
    spreadsheetExportCSV: { type: 'function', function: { name: 'spreadsheetExportCSV', description: '将当前表格数据导出为CSV格式文本', parameters: { type: 'object', properties: {}, required: [] } } },
    spreadsheetImportCSV: { type: 'function', function: { name: 'spreadsheetImportCSV', description: '从CSV文本导入数据到表格', parameters: { type: 'object', properties: { csv: { type: 'string', description: 'CSV格式文本' }, startAddr: { type: 'string', description: '起始单元格(默认A1)' } }, required: ['csv'] } } },
    spreadsheetImportFile: { type: 'function', function: { name: 'spreadsheetImportFile', description: '从磁盘文件导入表格数据，支持.xlsx(Excel)、.ods(LibreOffice)、.csv格式。导入后自动打开表格面板并显示数据。', parameters: { type: 'object', properties: { filePath: { type: 'string', description: '要导入的表格文件路径(.xlsx/.ods/.csv)' } }, required: ['filePath'] } } },
    spreadsheetExportFile: { type: 'function', function: { name: 'spreadsheetExportFile', description: '将当前表格数据导出到磁盘文件，支持.xlsx(Excel)、.ods(LibreOffice)、.csv格式。根据文件扩展名自动选择格式。', parameters: { type: 'object', properties: { filePath: { type: 'string', description: '导出文件路径(扩展名决定格式: .xlsx/.ods/.csv)' } }, required: ['filePath'] } } },
    // ---- 内置浏览器 (Playwright) ----
    browserNavigate: { type: 'function', function: { name: 'browserNavigate', description: '在内置浏览器中打开指定网址（基于Playwright引擎）。浏览器窗口会显示在应用右侧栏，用户可实时观看并干预。适合需要浏览网页、查看动态内容、与页面交互的场景。', parameters: { type: 'object', properties: { url: { type: 'string', description: '要打开的网址(需含http://或https://)' }, waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: '等待条件(默认load): load=页面完全加载, domcontentloaded=DOM就绪, networkidle=网络空闲' } }, required: ['url'] } } },
    browserScreenshot: { type: 'function', function: { name: 'browserScreenshot', description: '截取内置浏览器当前页面截图并返回base64图像，可用于AI查看页面当前状态。', parameters: { type: 'object', properties: { fullPage: { type: 'boolean', description: '是否截取整页(默认false,仅截可视区域)' } }, required: [] } } },
    browserClick: { type: 'function', function: { name: 'browserClick', description: '点击内置浏览器页面中的元素。使用Playwright的click方法，支持自动等待元素可点击。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS选择器(如 "button.submit"、"#login-link"、"a[href*=github]")' }, timeout: { type: 'number', description: '超时毫秒数(默认5000)' } }, required: ['selector'] } } },
    browserType: { type: 'function', function: { name: 'browserType', description: '在内置浏览器页面的指定输入框中输入文字。使用Playwright的fill方法模拟真实输入。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS选择器定位输入框' }, text: { type: 'string', description: '要输入的文字' }, submit: { type: 'boolean', description: '输入后是否按回车提交(默认false)' }, clear: { type: 'boolean', description: '是否先清空输入框(默认true)' } }, required: ['selector', 'text'] } } },
    browserGetContent: { type: 'function', function: { name: 'browserGetContent', description: '获取内置浏览器当前页面的文本内容(去除HTML标签)。', parameters: { type: 'object', properties: { selector: { type: 'string', description: '可选CSS选择器，仅获取匹配元素的文本(不传则获取整页)' } }, required: [] } } },
    browserScroll: { type: 'function', function: { name: 'browserScroll', description: '滚动内置浏览器页面。', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' }, amount: { type: 'number', description: '滚动像素数(默认500)' } }, required: ['direction'] } } },
    browserBack: { type: 'function', function: { name: 'browserBack', description: '内置浏览器后退到上一页。', parameters: { type: 'object', properties: {}, required: [] } } },
    browserForward: { type: 'function', function: { name: 'browserForward', description: '内置浏览器前进到下一页。', parameters: { type: 'object', properties: {}, required: [] } } },
    browserRefresh: { type: 'function', function: { name: 'browserRefresh', description: '刷新内置浏览器当前页面。', parameters: { type: 'object', properties: {}, required: [] } } },
    browserEvaluate: { type: 'function', function: { name: 'browserEvaluate', description: '在内置浏览器页面中执行任意JavaScript代码并返回结果。可用于提取复杂数据、操作DOM、调用页面API等。', parameters: { type: 'object', properties: { script: { type: 'string', description: '要执行的JavaScript代码(可以是表达式或函数体)。如 "document.title" 或 "Array.from(document.querySelectorAll(\"a\")).map(a=>a.href)"' } }, required: ['script'] } } },
    browserWait: { type: 'function', function: { name: 'browserWait', description: '等待页面中某个元素出现，或等待指定时间。适合等待异步加载内容。', parameters: { type: 'object', properties: { selector: { type: 'string', description: '要等待的CSS选择器。传入则等待该元素出现(默认timeout=5000ms)。' }, timeout: { type: 'number', description: '超时毫秒数(默认5000)。若不传selector，则作为固定等待时长。' } }, required: [] } } },
    browserHover: { type: 'function', function: { name: 'browserHover', description: '将鼠标悬停在页面指定元素上，触发hover效果。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS选择器定位元素' } }, required: ['selector'] } } },
    browserSelect: { type: 'function', function: { name: 'browserSelect', description: '选择下拉框(select元素)的选项。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'select元素的CSS选择器' }, value: { type: 'string', description: '要选择的选项值(value属性)' } }, required: ['selector', 'value'] } } },
    browserGetInfo: { type: 'function', function: { name: 'browserGetInfo', description: '获取内置浏览器当前页面的基本信息：URL、标题、是否可后退/前进。', parameters: { type: 'object', properties: {}, required: [] } } },
    browserClose: { type: 'function', function: { name: 'browserClose', description: '关闭内置浏览器并隐藏侧边栏面板。', parameters: { type: 'object', properties: {}, required: [] } } },
    // ---- Goal / 长任务跟踪 ----
    goalSet: { type: 'function', function: { name: 'goalSet', description: '设置或更新当前长期目标。设置后agent会自动多轮推进直到完成或达到限制。适用于需要多步骤、长时间才能完成的复杂任务。', parameters: { type: 'object', properties: { objective: { type: 'string', description: '清晰、可验证的目标描述，包含验收标准' }, tokenBudget: { type: 'number', description: '可选token预算上限，超过后agent会停止并总结进度' } }, required: ['objective'] } } },
    goalStatus: { type: 'function', function: { name: 'goalStatus', description: '查询当前目标的执行状态、已执行轮数、token使用量等。', parameters: { type: 'object', properties: {}, required: [] } } },
    goalComplete: { type: 'function', function: { name: 'goalComplete', description: '标记当前目标为已完成。仅在目标的所有验收标准都满足时调用。', parameters: { type: 'object', properties: { summary: { type: 'string', description: '完成总结：做了什么、结果如何' } }, required: ['summary'] } } },
    sleep: { type: 'function', function: { name: 'sleep', description: '让agent休眠等待指定的毫秒数。用于等待异步操作完成、轮询间隔等场景。最大60秒。', parameters: { type: 'object', properties: { ms: { type: 'number', description: '等待毫秒数(1-60000)' } }, required: ['ms'] } } },
    adjustAppearance: { type: 'function', function: { name: 'adjustAppearance', description: '调整应用外观主题。可切换深浅色模式、设置强调色（HEX）、或应用预设配色方案。省略的字段保持当前值不变。调用后立即生效并持久化保存。', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['light', 'dark', 'system'], description: '深浅色模式：light=浅色，dark=深色，system=跟随系统' }, accentColor: { type: 'string', description: '强调色HEX值，如 #4f8cff。仅在需要更改强调色时传入。' }, schemeName: { type: 'string', description: '预设配色方案名（优先级高于accentColor）。可取值：清新蓝/自然绿/海洋/珊瑚/青碧/紫雾/粉黛/玫瑰/浅海/薄荷/柔金/石榴/湖光/蔚蓝/薰衣/暖橙/清绿/晴空/淡紫/薄荷冰/柠檬/杏橙/清澈蓝/樱红/嫩绿/紫晶/青松/焦糖/赤霞/海风/冷灰/暗夜玫瑰/深湖/深紫/莓夜/深海蓝/松夜/暗金/赤夜/夜航/深林/暖夜/夜紫/夜绯/深蓝/墨青/深柠/炉火/午夜蓝/暗樱/深绿松/翠夜/夜晶/深松/暗橙/暗红/夜石/深灰/琥珀夜/绯红夜/极夜蓝/深绿/夜紫罗。' } }, required: [] } } },
    // ---- Computer Use Protocol ----
    computer: { type: 'function', function: { name: 'computer', description: 'Computer Use Protocol - 控制电脑桌面：截屏、获取UI组件树、移动鼠标、点击、输入文本、按键、滚动等。推荐工作流：先调用 action=screenshot 截屏查看当前画面，再调用 action=get_ui_tree 获取可交互元素的组件树（含坐标和索引），然后根据元素坐标执行点击/输入等操作。坐标原点在屏幕左上角。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['screenshot', 'get_ui_tree', 'mouse_move', 'left_click', 'right_click', 'double_click', 'middle_click', 'left_click_drag', 'type', 'key', 'scroll', 'wait', 'cursor_position', 'get_screen_size'], description: '要执行的操作：screenshot=截屏, get_ui_tree=获取当前焦点窗口的UI组件树(含元素类型/名称/值/坐标/可执行动作), mouse_move=移动鼠标, left_click/right_click/double_click/middle_click=鼠标点击, left_click_drag=拖拽, type=输入文本, key=按键, scroll=滚动, wait=等待, cursor_position=获取鼠标位置, get_screen_size=获取屏幕尺寸' }, coordinate: { type: 'array', items: { type: 'number' }, description: '目标坐标 [x, y]（像素）。mouse_move/left_click/right_click/double_click/middle_click/scroll 需要此参数' }, start_coordinate: { type: 'array', items: { type: 'number' }, description: '拖拽起始坐标 [x, y]（仅 left_click_drag 使用）' }, text: { type: 'string', description: '要输入的文本（仅 type 操作使用）' }, key: { type: 'string', description: '按键名称或组合键，用+连接。如 Return, Tab, Escape, ctrl+c, alt+Tab, shift+End, win+d。支持单字符如 a/b/c 或功能键 F1-F12' }, scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向（仅 scroll 操作使用）' }, scroll_amount: { type: 'number', description: '滚动量，默认3（仅 scroll 操作使用）' }, duration: { type: 'number', description: '等待秒数（仅 wait 操作使用，范围0.1-10）' } }, required: ['action'] } } },
  };

  const result = Object.keys(schemas)
    .filter(name => (!enabledTools || enabledTools[name] !== false) && isToolAvailableForMode(name, mode))
    .map(name => schemas[name]);
  // Append dynamic MCP tool schemas (filtered by mode — MCP tools default to both modes)
  for (const [mcpName, mcpSchema] of Object.entries(MCP_DYNAMIC_SCHEMAS)) {
    if ((!enabledTools || enabledTools[mcpName] !== false) && isToolAvailableForMode(mcpName, mode)) {
      result.push(mcpSchema);
    }
  }
  return result;
}
