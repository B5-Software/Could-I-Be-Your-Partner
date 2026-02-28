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

function getAllToolDefinitions() {
  return [...TOOL_DEFINITIONS, ...MCP_DYNAMIC_TOOLS];
}

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
  { name: 'readFile', desc: '读取文件', icon: 'fa-file', category: '文件', sensitive: false },
  { name: 'editFile', desc: '编辑文件', icon: 'fa-file-pen', category: '文件', sensitive: true },
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
  { name: 'manageContext', desc: '管理上下文', icon: 'fa-window-maximize', category: '代理', sensitive: false },
  { name: 'autoSummarizeContext', desc: '自动总结上下文', icon: 'fa-highlighter', category: '代理', sensitive: false },
  { name: 'listSkills', desc: '列出技能', icon: 'fa-lightbulb', category: '技能', sensitive: false },
  { name: 'makeSkill', desc: '创建技能', icon: 'fa-wand-magic-sparkles', category: '技能', sensitive: false },
  { name: 'updateSkill', desc: '更新技能', icon: 'fa-pen-to-square', category: '技能', sensitive: false },
  { name: 'runSkillScript', desc: '运行技能脚本（仅JS）', icon: 'fa-file-code', category: '技能', sensitive: false },
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
  { name: 'askQuestions', desc: '询问用户问题收集信息', icon: 'fa-clipboard-question', category: '交互工具', sensitive: false },
  { name: 'downloadFile', desc: '从互联网下载文件到工作区', icon: 'fa-download', category: '网络工具', sensitive: true },
  { name: 'inviteGame', desc: '邀请用户玩游戏（飞花令/三国杀/谁是卧底）', icon: 'fa-gamepad', category: '游戏', sensitive: false },
  { name: 'mcpListTools', desc: '列出MCP服务端可用工具（刷新动态MCP工具）', icon: 'fa-list', category: 'MCP', sensitive: false },
  // ---- 扩充网络工具 ----
  { name: 'httpRequest', desc: '发送自定义HTTP请求(GET/POST/PUT/DELETE等)', icon: 'fa-paper-plane', category: '网络工具', sensitive: true },
  { name: 'httpFormPost', desc: '发送表单/multipart请求', icon: 'fa-file-arrow-up', category: '网络工具', sensitive: true },
  { name: 'dnsLookup', desc: 'DNS域名解析', icon: 'fa-sitemap', category: '网络工具', sensitive: false },
  { name: 'ping', desc: 'Ping主机(ICMP)', icon: 'fa-satellite-dish', category: '网络工具', sensitive: false },
  { name: 'whois', desc: '查询域名WHOIS信息', icon: 'fa-circle-info', category: '网络工具', sensitive: false },
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
];

// Dangerous command keywords for different platforms/shells
const DANGEROUS_COMMANDS = {
  common: ['rm -rf', 'rmdir', 'del /f', 'format', 'mkfs', 'dd if=', 'chmod 777', ':(){:|:&};:', 'fork bomb', '> /dev/sda', 'shutdown', 'reboot', 'halt', 'poweroff', 'kill -9', 'killall', 'pkill'],
  windows: ['Remove-Item -Recurse -Force', 'Format-Volume', 'Clear-Disk', 'Stop-Process -Force', 'Remove-Partition', 'rd /s /q', 'reg delete', 'bcdedit', 'diskpart'],
  linux: ['rm -rf /', 'chmod -R 777 /', 'chown -R', 'mv /* /dev/null', 'wget.*|.*sh', 'curl.*|.*sh', 'crontab -r', 'iptables -F', 'systemctl stop', 'service.*stop'],
  macos: ['rm -rf /', 'diskutil eraseDisk', 'csrutil disable', 'nvram -c', 'bless --unbless']
};

// OpenAI-format tool schemas for LLM
function getToolSchemas(enabledTools) {
  const schemas = {
    getTarot: { type: 'function', function: { name: 'getTarot', description: '抽取一张塔罗牌（使用设置中配置的随机数源：CSPRNG软件随机或TRNG硬件真随机，调用后返回结果中entropySource字段会标明使用的随机数类型，在向用户解析塔罗牌时请标明随机数类型以增强可信度）', parameters: { type: 'object', properties: {}, required: [] } } },
    todoList: { type: 'function', function: { name: 'todoList', description: '管理待办事项列表', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'remove', 'toggle', 'list'], description: '操作类型' }, text: { type: 'string', description: '待办事项内容' }, id: { type: 'number', description: '待办事项ID' } }, required: ['action'] } } },
    runSubAgent: { type: 'function', function: { name: 'runSubAgent', description: '运行子代理完成特定任务', parameters: { type: 'object', properties: { task: { type: 'string', description: '子代理要完成的任务' }, context: { type: 'string', description: '给子代理的上下文信息' } }, required: ['task'] } } },
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
    readFile: { type: 'function', function: { name: 'readFile', description: '读取文件内容', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } } },
    editFile: { type: 'function', function: { name: 'editFile', description: '编辑文件', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '新内容' } }, required: ['path', 'content'] } } },
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
    runGeogebraCommand: { type: 'function', function: { name: 'runGeogebraCommand', description: '执行Geogebra命令（Classic）。求解方程例：先f(x)=x^2-1，再Solve[f(x)=0]只需一个参数（方程）。求根例：Roots[f]得到点A,B,C，用x(A)提取值。', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Geogebra Classic命令（注意Solve只取1参数，Roots返回点标签）' } }, required: ['command'] } } },
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
    askQuestions: { type: 'function', function: { name: 'askQuestions', description: '向用户提出问题收集信息，支持单选/多选/自由输入。返回{ok:true,answers:Array}', parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string', description: '问题文本' }, options: { type: 'array', items: { type: 'string' }, description: '选项列表(可选,留空则为自由输入)' }, multiSelect: { type: 'boolean', description: '是否多选(仅当有options时有效)' } }, required: ['question'] }, description: '问题列表' } }, required: ['questions'] } } },
    downloadFile: { type: 'function', function: { name: 'downloadFile', description: '从互联网下载文件到工作区目录', parameters: { type: 'object', properties: { url: { type: 'string', description: '文件URL' }, filename: { type: 'string', description: '保存的文件名(可选,默认从URL提取)' } }, required: ['url'] } } },
    inviteGame: { type: 'function', function: { name: 'inviteGame', description: '邀请用户玩游戏。游戏类型：flyingFlower(飞花令,诗词接龙)、sanguosha(三国杀,卡牌策略)、undercover(谁是卧底,推理游戏)。会向用户展示一张游戏邀请卡片，用户可以接受或忽略，并指定AI参与人数。', parameters: { type: 'object', properties: { game: { type: 'string', enum: ['flyingFlower', 'sanguosha', 'undercover'], description: '游戏类型' }, message: { type: 'string', description: '邀请语（显示在邀请卡片上）' }, suggestedAgents: { type: 'number', description: '建议的AI Agent参与人数(用户可调整)' } }, required: ['game'] } } },
    mcpListTools: { type: 'function', function: { name: 'mcpListTools', description: '列出并刷新所有已连接MCP服务器的工具。刷新后MCP工具会作为独立工具可直接调用（mcp__serverName__toolName格式）。', parameters: { type: 'object', properties: { serverName: { type: 'string', description: '可选,指定MCP服务器名称,不传则列出所有' } }, required: [] } } },
    // ---- 扩充网络工具 schemas ----
    httpRequest: { type: 'function', function: { name: 'httpRequest', description: '发送自定义HTTP/HTTPS请求。支持GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS等所有方法，可设请求头、请求体、超时。响应包含状态码、响应头和响应体。', parameters: { type: 'object', properties: { url: { type: 'string', description: '请求URL' }, method: { type: 'string', description: 'HTTP方法(默认GET)', enum: ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'] }, headers: { type: 'object', description: '请求头键值对' }, body: { type: 'string', description: '请求体(字符串或JSON字符串)' }, timeout: { type: 'number', description: '超时毫秒数(默认30000)' }, encoding: { type: 'string', description: '响应编码(默认utf8, 可选base64)' }, followRedirects: { type: 'boolean', description: '是否跟随重定向(默认true)' } }, required: ['url'] } } },
    httpFormPost: { type: 'function', function: { name: 'httpFormPost', description: '发送application/x-www-form-urlencoded或multipart/form-data表单请求', parameters: { type: 'object', properties: { url: { type: 'string', description: '请求URL' }, fields: { type: 'object', description: '表单字段键值对' }, files: { type: 'array', items: { type: 'object', properties: { fieldName: { type: 'string' }, filePath: { type: 'string' }, fileName: { type: 'string' } }, required: ['fieldName','filePath'] }, description: '要上传的文件列表(可选)' }, headers: { type: 'object', description: '额外请求头' } }, required: ['url','fields'] } } },
    dnsLookup: { type: 'function', function: { name: 'dnsLookup', description: 'DNS域名解析，返回A/AAAA/MX/TXT/NS/CNAME等记录', parameters: { type: 'object', properties: { hostname: { type: 'string', description: '要解析的域名' }, rrtype: { type: 'string', description: '记录类型(默认A)', enum: ['A','AAAA','MX','TXT','NS','CNAME','SOA','SRV','ANY'] } }, required: ['hostname'] } } },
    ping: { type: 'function', function: { name: 'ping', description: 'Ping目标主机，返回延迟和可达性', parameters: { type: 'object', properties: { host: { type: 'string', description: '主机名或IP' }, count: { type: 'number', description: 'ping次数(默认4)' } }, required: ['host'] } } },
    whois: { type: 'function', function: { name: 'whois', description: '查询域名WHOIS注册信息', parameters: { type: 'object', properties: { domain: { type: 'string', description: '域名' } }, required: ['domain'] } } },
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
  };

  const result = Object.keys(schemas)
    .filter(name => !enabledTools || enabledTools[name] !== false)
    .map(name => schemas[name]);
  // Append dynamic MCP tool schemas
  for (const [mcpName, mcpSchema] of Object.entries(MCP_DYNAMIC_SCHEMAS)) {
    if (!enabledTools || enabledTools[mcpName] !== false) {
      result.push(mcpSchema);
    }
  }
  return result;
}
