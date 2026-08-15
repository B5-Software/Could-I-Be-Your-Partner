/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 终端（node-pty）IPC 服务：创建/读写/调整/终止终端会话，以及按会话
 * 定向中止。通过工厂函数注入 mainWindow 与 settings 的访问器。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { abortAllRequests, abortRequests } = require('./llm-retry');

module.exports = function registerTerminalIpc({ ipcMain, getMainWindow, getSettings }) {
const terminals = new Map();
let terminalIdCounter = 0;
const TERMINAL_HISTORY_MAX = 100000; // 100KB

// 特殊按键 → 终端转义序列（用于 TUI/menuconfig 键盘交互）
// 参考 xterm 与 readline 的标准按键编码
const TERMINAL_KEY_SEQUENCES = {
  Enter: '\r',
  Return: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Esc: '\x1b',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
  Insert: '\x1b[2~',
  Space: ' ',
  CtrlC: '\x03',
  CtrlD: '\x04',
  CtrlZ: '\x1a',
  CtrlA: '\x01',
  CtrlE: '\x05',
  CtrlW: '\x17',
  CtrlU: '\x15',
  CtrlL: '\x0c',
  CtrlR: '\x12',
  CtrlT: '\x14',
  CtrlG: '\x07',
  CtrlH: '\x08',
  CtrlJ: '\x0a',
  CtrlK: '\x0b',
  CtrlN: '\x0e',
  CtrlP: '\x10',
  CtrlX: '\x18',
  CtrlY: '\x19',
  AltEnter: '\x1b\r',
  AltUp: '\x1b\x1b[A',
  AltDown: '\x1b\x1b[B',
  ShiftTab: '\x1b[Z'
};

function _broadcastTerminalEvent(channel, payload) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send(channel, payload); } catch { /* ignore */ }
}

function _appendTerminalData(id, entry, data) {
  entry.agentBuffer += data;
  entry.fullHistory += data;
  if (entry.fullHistory.length > TERMINAL_HISTORY_MAX) {
    // 保留尾部一半，丢弃头部
    entry.fullHistory = entry.fullHistory.slice(-TERMINAL_HISTORY_MAX / 2);
  }
  _broadcastTerminalEvent('terminal:data', { id, data });
}

// 解析终端使用的 Shell：
//   shellSetting: 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'custom'
//   customShellPath: shellSetting === 'custom' 时的自定义 Shell 路径
// 返回可执行文件路径（优先）或可执行名（由 node-pty 通过 PATH 解析）
function _resolveTerminalShell(shellSetting, customShellPath) {
  const platform = process.platform;
  const _existsInPath = (name) => {
    try {
      if (name.includes('\\') || name.includes('/')) return fs.existsSync(name);
      return (process.env.PATH || '').split(/[;]+/).some(d => {
        if (!d) return false;
        try { return fs.existsSync(path.join(d, name)); } catch { return false; }
      });
    } catch { return false; }
  };
  const _firstExisting = (arr) => arr.find(p => { try { return fs.existsSync(p); } catch { return false; } });

  // 自定义 Shell：路径有效则直接使用，否则回退自动检测
  if (shellSetting === 'custom' && customShellPath) {
    if (fs.existsSync(customShellPath)) return customShellPath;
    console.warn('[terminal] customShellPath 无效，回退自动检测:', customShellPath);
  }
  if (platform === 'win32') {
    const pwshCandidates = [
      'pwsh.exe',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PowerShell', '7', 'pwsh.exe')
    ];
    const ps5Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    switch (shellSetting) {
      case 'pwsh': return pwshCandidates.find(p => _existsInPath(p)) || 'pwsh.exe';
      case 'powershell': return (fs.existsSync(ps5Path) ? ps5Path : 'powershell.exe');
      case 'cmd': return process.env.ComSpec || 'cmd.exe';
      case 'bash': return _existsInPath('bash.exe') ? 'bash.exe' : (process.env.ComSpec || 'cmd.exe');
      default: {
        // 'auto' 或未知：优先 pwsh → PowerShell 5 → cmd
        const foundPwsh = pwshCandidates.find(p => _existsInPath(p));
        if (foundPwsh) return foundPwsh;
        if (fs.existsSync(ps5Path)) return ps5Path;
        return process.env.ComSpec || 'cmd.exe';
      }
    }
  }
  // macOS / Linux
  const shellCandidates = [];
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) shellCandidates.push(process.env.SHELL);
  if (process.platform === 'darwin') shellCandidates.push('/bin/zsh', '/bin/bash', '/bin/sh');
  else shellCandidates.push('/bin/bash', '/bin/sh');
  if (shellSetting === 'zsh') return _firstExisting(['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/bin/sh']) || '/bin/sh';
  if (shellSetting === 'bash') return _firstExisting(['/bin/bash', '/usr/bin/bash', '/bin/sh']) || '/bin/sh';
  return shellCandidates.find(s => fs.existsSync(s)) || '/bin/sh';
}

ipcMain.handle('terminal:make', (_, cwd, opts = {}) => {
  try {
    const pty = require('node-pty');
    const id = ++terminalIdCounter;
    // Shell 选择：手动选择（设置-终端）优先，否则自动检测
    const shellSetting = (getSettings().terminal && getSettings().terminal.shell) || 'auto';
    const customShellPath = (getSettings().terminal && getSettings().terminal.customShellPath) || '';
    const shellName = _resolveTerminalShell(shellSetting, customShellPath);
    const shellArgs = [];
    // 优先使用传入的工作目录（Chat 模式工作目录 / Code 模式工作区），回退到家目录
    const effectiveCwd = (cwd && typeof cwd === 'string' && fs.existsSync(cwd)) ? cwd : os.homedir();
    // macOS 打包后 process.env 可能被精简（从 Finder 启动时 PATH 只有 /usr/bin:/bin），
    // 显式补充关键环境变量，确保 shell 内命令（如 git、node）可正常工作。
    // 注意：posix_spawnp 失败的根因是 spawn-helper 二进制被困在 app.asar 内，
    // 已通过 package.json 的 asarUnpack 配置 node_modules/node-pty/**/* 解决。
    const userInfo = os.userInfo();
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      HOME: process.env.HOME || userInfo.homedir || os.homedir(),
      USER: process.env.USER || userInfo.username,
      LOGNAME: process.env.LOGNAME || process.env.USER || userInfo.username,
      SHELL: process.env.SHELL || shellName,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    };
    // 沙箱：受限模式（read-only / workspace-write）用后端包装 pty shell；
    // danger-full-access 或缺省时透传。后端不可用则 fail-closed 抛错。
    let spawnShell = shellName;
    let spawnArgs = shellArgs;
    let confined = false;
    const sandboxMode = (opts && opts.sandboxMode) || 'danger-full-access';
    if (sandboxMode !== 'danger-full-access') {
      const sandboxRunner = require('./sandbox-runner');
      // Windows 受限后端（cibyp-sandbox）无法透传 ConPTY 伪终端（进程属性无法
      // 跨包装器转发，TUI/交互式程序会损坏）—— fail-closed，给出明确提示。
      if (process.platform === 'win32' && sandboxRunner.detectBackend().backend === 'acl') {
        throw new Error('Windows 受限沙箱模式暂不支持终端：ConPTY 伪终端无法穿越沙箱包装器，请在设置中关闭该会话的沙箱或改用完整访问模式');
      }
      const wrapped = sandboxRunner.confine([shellName, ...shellArgs], {
        mode: sandboxMode,
        workspaceRoot: effectiveCwd
      });
      spawnShell = wrapped.argv[0];
      spawnArgs = wrapped.argv.slice(1);
      confined = wrapped.confined;
    }
    const term = pty.spawn(spawnShell, spawnArgs, {
      name: 'xterm',
      cols: 120,
      rows: 30,
      cwd: effectiveCwd,
      env
    });
    // 终端元数据：buffer 兼容 Agent 现有调用；fullHistory 用于 xterm.js 回放与显示
    const entry = {
      term,
      agentBuffer: '',
      fullHistory: '',
      cwd: effectiveCwd,
      createdAt: Date.now(),
      lastCommand: '',
      shellName,
      ownerSessionKey: typeof opts.sessionKey === 'string' ? opts.sessionKey : null,
      sandboxMode,
      sandboxed: confined,
      // 兼容旧接口：Agent 调用 t.buffer() 取走 agentBuffer
      buffer: () => { const b = entry.agentBuffer; entry.agentBuffer = ''; return b; }
    };
    term.onData(data => _appendTerminalData(id, entry, data));
    term.onExit(({ exitCode }) => {
      _broadcastTerminalEvent('terminal:exit', { id, exitCode });
    });
    terminals.set(id, entry);
    return { ok: true, terminalId: id, cwd: effectiveCwd, createdAt: entry.createdAt };
  } catch (e) {
    // 捕获详细错误信息，便于诊断
    const detail = e.stack || e.message;
    console.error('[terminal:make] failed:', detail);
    return { ok: false, error: e.message, detail };
  }
});

// 列出所有终端元数据（用于前端标签页展示）
ipcMain.handle('terminal:list', () => {
  const list = [];
  for (const [id, t] of terminals) {
    list.push({
      id,
      cwd: t.cwd,
      createdAt: t.createdAt,
      lastCommand: t.lastCommand,
      shellName: t.shellName,
      exited: false // onExit 后会从 Map 中删除
    });
  }
  return { ok: true, terminals: list };
});

// xterm.js 用户输入回写到 pty
ipcMain.handle('terminal:write', (_, id, data) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  try {
    // \n → \r：pty 终端只认 \r 作为回车，TUI/menuconfig 交互时按 \n 不会提交
    let payload = String(data);
    if (payload.includes('\n')) payload = payload.replace(/\n/g, '\r');
    t.term.write(payload);
    // 简单识别命令行：以 \r 结尾的输入视为命令（用于标签页标题展示）
    if (payload.endsWith('\r')) {
      const cmd = payload.replace(/\r$/, '').trim();
      if (cmd) t.lastCommand = cmd.slice(0, 60);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 发送指定文本（不自动回车，用于 TUI/menuconfig 输入框）
ipcMain.handle('terminal:sendText', (_, id, text) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  try {
    let payload = String(text || '');
    if (payload.includes('\n')) payload = payload.replace(/\n/g, '\r');
    t.term.write(payload);
    return { ok: true, sent: payload };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 发送特殊按键序列（Enter/Tab/Esc/方向键/功能键/组合键），用于 TUI/menuconfig 键盘导航
ipcMain.handle('terminal:pressKey', (_, id, keyName) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  const seq = TERMINAL_KEY_SEQUENCES[keyName];
  if (!seq) return { ok: false, error: `未知按键: ${keyName}` };
  try {
    t.term.write(seq);
    return { ok: true, key: keyName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 读取终端输出：lastLines>0 时只返回末尾 N 行，否则返回全部
ipcMain.handle('terminal:read', (_, id, lastLines) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  let text = t.fullHistory;
  if (lastLines && lastLines > 0) {
    // 去掉尾部残留的半行，再取末尾 N 行（按 \r\n 或 \n 切分）
    const normalized = text.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const slice = lines.slice(-lastLines);
    text = slice.join('\n');
  }
  return { ok: true, output: text, full: text === t.fullHistory, length: text.length };
});

// xterm.js fit 后调用，调整 pty 尺寸
ipcMain.handle('terminal:resize', (_, id, cols, rows) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  try {
    t.term.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 获取终端完整历史（用于 xterm.js 后加入时回放）
ipcMain.handle('terminal:getHistory', (_, id) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  return { ok: true, history: t.fullHistory };
});

ipcMain.handle('terminal:run', (_, id, command) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  t.agentBuffer = ''; // 清空 Agent 读取缓冲区
  t.term.write(command + '\r');
  t.lastCommand = String(command).slice(0, 60);
  return new Promise(resolve => {
    setTimeout(() => { resolve({ ok: true, output: t.buffer() }); }, 2000);
  });
});
ipcMain.handle('terminal:await', (_, id, command, timeoutMs) => {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: '终端不存在' };
  t.agentBuffer = ''; // 清空 Agent 读取缓冲区
  t.term.write(String(command) + '\r');
  t.lastCommand = String(command).slice(0, 60);
  const effectiveTimeout = (Number(timeoutMs) > 0) ? Number(timeoutMs) : 120000;
  return new Promise(resolve => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearInterval(checkInterval);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: true, output: t.buffer(), timedOut: true }), effectiveTimeout);
    let checkInterval = setInterval(() => {
      const output = t.buffer();
      if (output.includes('$') || output.includes('>') || output.includes('#') || output.includes('%')) {
        finish({ ok: true, output });
      }
    }, 500);
  });
});
ipcMain.handle('terminal:kill', (_, id) => {
  const t = terminals.get(id);
  if (t) {
    try { t.term.kill(); } catch { /* ignore */ }
    terminals.delete(id);
    _broadcastTerminalEvent('terminal:exit', { id, exitCode: 0, killed: true });
  }
  return { ok: true };
});

// ---- 中止 AI 请求与终端 ----
function abortTerminalsForSession(sessionKey, scopeAll = false) {
  // Abort 聊天时的终端策略（设置-终端）：
  //   'kill'   - 直接掐断整个运行中的终端（默认）
  //   'clearC' - 传入 Ctrl+C（保留终端，仅中止当前进程）
  //   'none'   - 不管，让终端继续运行
  const strategy = (getSettings().terminal && getSettings().terminal.abortStrategy) || 'kill';
  let termCount = 0;
  const termIds = [...terminals.keys()];
  for (const id of termIds) {
    const t = terminals.get(id);
    if (!t || !t.term) continue;
    if (!scopeAll && sessionKey && t.ownerSessionKey !== sessionKey) continue;
    try {
      if (strategy === 'clearC') {
        // 向运行中的进程发送 Ctrl+C（SIGINT 等效），保留终端会话
        t.term.write('\x03');
        termCount++;
      } else if (strategy === 'none') {
        // 不管：让终端继续运行
      } else {
        // 'kill'（默认）：直接掐断终端
        t.term.kill();
        terminals.delete(id);
        _broadcastTerminalEvent('terminal:exit', { id, exitCode: 0, killed: true });
        termCount++;
      }
    } catch { /* ignore */ }
  }
  return { killedTerminals: termCount, abortStrategy: strategy };
}

// ---- 瞬间中止所有 AI 请求 + 杀掉所有正在运行的终端（停止按钮） ----
ipcMain.handle('agent:abortAll', () => {
  const reqCount = abortAllRequests();
  const terminalResult = abortTerminalsForSession(null, true);
  console.log(`[Agent] Aborted ${reqCount} LLM request(s); terminal strategy='${terminalResult.abortStrategy}', affected ${terminalResult.killedTerminals} terminal(s)`);
  return { ok: true, abortedRequests: reqCount, killedTerminals: terminalResult.killedTerminals, abortStrategy: terminalResult.abortStrategy };
});

// ---- 按会话定向中止：只停止指定会话的 LLM 请求和终端 ----
ipcMain.handle('agent:abort', (_, opts = {}) => {
  const sessionKey = String(opts.sessionKey || '');
  if (!sessionKey) return { ok: false, error: 'missing sessionKey' };
  const reqCount = abortRequests({ sessionKey });
  const terminalResult = abortTerminalsForSession(sessionKey, false);
  return { ok: true, abortedRequests: reqCount, killedTerminals: terminalResult.killedTerminals, abortStrategy: terminalResult.abortStrategy };
});

  return { abortTerminalsForSession };
};
