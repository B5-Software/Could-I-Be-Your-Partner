/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 终端接线：把 TuiApp 接到真实终端。
 *
 *   - alt-screen 进出、光标隐藏、鼠标跟踪（滚轮滚动聊天）、窗口尺寸与 resize
 *   - **日志隔离**：console.* 与 stdout/stderr 写入一律改道日志文件
 *     （只有界面自身的渲染写入放行），网络/LLM/VM 日志不再撕裂 TUI 画面
 *   - stdin raw mode → 按键解码 → TuiApp
 *   - 渲染循环：事件/按键后立即渲染 + 动画时钟（spinner 120ms）
 *   - VM 模式：VM 启动完成后再进界面，期间渲染加载进度条
 *   - 退出时恢复终端（raw mode / 鼠标 / alt-screen / 光标）
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TuiApp } = require('./app.js');
const { createKeyDecoder } = require('./keys.js');
const { themeFromEnv } = require('./theme.js');
const { CSI, CH, style, paint, visibleWidth, padWidth, truncate } = require('./ansi.js');
const { FIGURES, BOX } = require('./theme.js');

const ALT_ENTER = CSI + '?1049h' + CSI + '2J' + CSI + 'H';
const ALT_EXIT = CSI + '?1049l';
const HIDE_CURSOR = CSI + '?25l';
const SHOW_CURSOR = CSI + '?25h';
const CLEAR_LINE_END = CSI + 'K';
const CLEAR_REST = CSI + 'J';
// 鼠标跟踪：普通点击 + SGR 坐标（滚轮滚动聊天记录；选中文本请按住 Shift 拖动）
const MOUSE_ON = CSI + '?1000h' + CSI + '?1002h' + CSI + '?1006h';
const MOUSE_OFF = CSI + '?1006l' + CSI + '?1002l' + CSI + '?1000l';

/** 日志文件位置：<userData>/logs/tui-YYYYMMDD.log（取不到 userData 时用系统临时目录） */
function resolveLogFile() {
  let dir = null;
  try {
    dir = require('electron').app.getPath('userData');
  } catch {
    dir = null;
  }
  const logs = dir ? path.join(dir, 'logs') : path.join(os.tmpdir(), 'cibyp-tui-logs');
  try {
    fs.mkdirSync(logs, { recursive: true });
  } catch {
    /* 只读环境忽略 */
  }
  const day = new Date().toISOString().slice(0, 10);
  return path.join(logs, `tui-${day}.log`);
}

/**
 * 日志隔离：TUI 占用整个终端，任何日志输出都会撕裂画面。
 * console.* 与 process.stdout/stderr.write 一律写入日志文件；
 * 只有屏幕自身的渲染写入（screen.guarded 期间）放行到真实终端。
 */
function installLogIsolation(logPath, screen) {
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  const format = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const write = (level, args) => {
    try {
      stream.write(`[${new Date().toISOString()}] ${level} ${args.map(format).join(' ')}\n`);
    } catch {
      /* 日志失败不影响界面 */
    }
  };

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  console.log = (...args) => write('info', args);
  console.info = (...args) => write('info', args);
  console.warn = (...args) => write('warn', args);
  console.error = (...args) => write('error', args);
  console.debug = (...args) => write('debug', args);

  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) =>
    screen.guarded ? realStdout(chunk, ...rest) : (write('stdout', [String(chunk)]), true);
  process.stderr.write = (chunk, ...rest) =>
    screen.guarded ? realStderr(chunk, ...rest) : (write('stderr', [String(chunk)]), true);

  return {
    logPath,
    restore() {
      Object.assign(console, original);
      process.stdout.write = realStdout;
      process.stderr.write = realStderr;
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    },
  };
}

/** 终端屏幕：整帧重绘（免差分，简单可靠）；guarded 期间的日志写入放行 */
function createTerminalScreen(stdout) {
  const screen = {
    width: (stdout.columns && Number(stdout.columns)) || 100,
    height: (stdout.rows && Number(stdout.rows)) || 30,
    guarded: false,
    _write(text) {
      screen.guarded = true;
      try {
        stdout.write(text);
      } finally {
        screen.guarded = false;
      }
    },
    enter() {
      screen._write(ALT_ENTER + HIDE_CURSOR + MOUSE_ON);
    },
    exit() {
      screen._write(MOUSE_OFF + SHOW_CURSOR + CLEAR_REST + '\n' + ALT_EXIT);
    },
    render(frame) {
      const lines = frame.lines || [];
      let out = CSI + 'H';
      for (let i = 0; i < lines.length; i += 1) {
        out += lines[i] + CLEAR_LINE_END;
        if (i < lines.length - 1) out += '\r\n';
      }
      out += CLEAR_REST;
      const cursor = frame.cursor || { row: 1, col: 1 };
      out += CSI + cursor.row + ';' + cursor.col + 'H';
      out += SHOW_CURSOR;
      screen._write(out);
    },
  };
  return screen;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 1/8 块进度条（与设计系统一致） */
function renderBar(theme, ratio, width) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const full = Math.floor(clamped * width);
  const partial = Math.round((clamped * width - full) * 8);
  let out = style(FIGURES.progress[8].repeat(full), { fg: theme.rateFill });
  if (full < width && partial > 0) out += style(FIGURES.progress[partial], { fg: theme.rateFill });
  const used = full + (partial > 0 ? 1 : 0);
  out += style(FIGURES.progress[8].repeat(Math.max(0, width - used)), { fg: theme.rateEmpty });
  return out;
}

/**
 * VM 启动屏：虚拟机模式下，VM 就绪后才进主界面；期间渲染加载进度条。
 * @param {() => ({required: boolean, ready: boolean, failed: boolean, progress: number, detail: string})} getBootState
 */
async function waitForVmBoot(screen, theme, getBootState, options = {}) {
  if (typeof getBootState !== 'function') return { skipped: true };
  let state = getBootState();
  if (!state || !state.required || state.ready || state.failed) return state || { ready: true };

  const frames = FIGURES.spinner;
  let tick = 0;
  const startedAt = Date.now();
  for (;;) {
    state = getBootState();
    const width = Math.max(20, Math.min(screen.width - 8, 60));
    const percent = Math.max(0, Math.min(100, Number(state.progress) || 0));
    const lines = [
      '',
      '  ' +
        style(frames[tick % frames.length], { fg: theme.accent, bold: true }) +
        '  ' +
        style('正在启动虚拟机…', { bold: true }),
      '',
      '  ' +
        renderBar(theme, percent / 100, width) +
        '  ' +
        paint(theme, 'suggestion', String(percent).padStart(3) + '%', { bold: true }),
      '',
      '  ' +
        paint(
          theme,
          'subtle',
          truncate(String(state.detail || state.phase || '准备运行环境…'), screen.width - 6),
          { dim: true },
        ),
      '  ' + paint(theme, 'subtle', 'VM 就绪后自动进入界面', { dim: true, italic: true }),
    ];
    screen.render({ lines, cursor: { row: 1, col: 1 } });
    tick += 1;
    if (state.ready || state.failed) return state;
    if (Date.now() - startedAt > (options.timeoutMs || 10 * 60 * 1000)) {
      return Object.assign({}, state, { timeout: true });
    }
    await sleep(200);
  }
}

/**
 * 启动 TUI。
 * @param {{
 *   runtime: object, stdout?: NodeJS.WriteStream, stdin?: NodeJS.ReadStream, argv?: string[],
 *   onExit?: Function, getBootState?: () => object, logFile?: string,
 * }} options
 */
function startTui(options) {
  const stdout = options.stdout || process.stdout;
  const stdin = options.stdin || process.stdin;
  const argv = options.argv || process.argv;
  const theme = themeFromEnv();
  const screen = createTerminalScreen(stdout);
  let quitRequested = false;

  // 交互性 = 能设原始模式（要收逐键输入）。
  // 注意：Windows 下 Electron 主进程的 stdin 不是 TTY（setRawMode 不存在），
  // 那种情况无法做交互界面 —— 渲染预览帧并提示改用纯 Node 入口（bin/cibyp-tui.js）。
  const interactive = typeof stdin.setRawMode === 'function';
  const looksLikeTerminal = Boolean(stdin.isTTY) || Boolean(stdout.isTTY);
  if (!interactive && looksLikeTerminal) {
    // 提示要在安装日志隔离之前输出（隔离后 stderr 也进文件）
    console.error('[cibyp] 当前进程无法接收键盘输入（stdin 不是终端 / setRawMode 不可用）。');
    console.error('[cibyp] 交互界面请运行: node bin/cibyp-tui.js   （已渲染一帧预览）');
  }

  // 日志隔离：界面期间任何日志都改道文件（含网络/LLM/VM 日志）
  const logFile = options.logFile || resolveLogFile();
  const logIsolation = installLogIsolation(logFile, screen);

  const app = new TuiApp({
    runtime: options.runtime,
    theme,
    width: screen.width,
    height: screen.height,
    onQuit: () => {
      quitRequested = true;
      shutdown();
    },
  });

  const decoder = createKeyDecoder();
  let rendering = false;
  let enteredScreen = false;

  function render() {
    if (rendering || quitRequested || !enteredScreen) return;
    rendering = true;
    try {
      screen.render(app.frame());
    } catch (error) {
      try {
        console.error('[tui] render failed:', error);
      } catch {
        /* ignore */
      }
    } finally {
      rendering = false;
    }
  }

  function enqueueKey(key) {
    Promise.resolve(app.handleKey(key))
      .catch((error) => {
        try {
          console.error('[tui] key handling failed:', error);
        } catch {
          /* ignore */
        }
      })
      .then(render);
  }

  function onStdin(chunk) {
    for (const key of decoder.push(chunk)) enqueueKey(key);
    if (decoder.pending) {
      clearTimeout(onStdin.flushTimer);
      onStdin.flushTimer = setTimeout(() => {
        for (const key of decoder.flush()) enqueueKey(key);
      }, 30);
    }
  }

  let animTimer = null;
  function shutdown() {
    if (shutdown.done) return;
    shutdown.done = true;
    detachSignals();
    clearInterval(animTimer);
    clearTimeout(onStdin.flushTimer);
    try {
      stdin.removeListener('data', onStdin);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      stdin.pause();
    } catch {
      /* ignore */
    }
    try {
      if (enteredScreen) screen.exit();
      else stdout.write('\n');
    } catch {
      /* ignore */
    }
    try {
      app.dispose();
    } catch {
      /* ignore */
    }
    logIsolation.restore();
    // 同步退出：不留竞态窗口（否则控制台可能再把排队的 Ctrl+C 当信号杀掉进程）
    const code = typeof options.onExit === 'function' ? options.onExit(0) : 0;
    process.exit(typeof code === 'number' ? code : 0);
  }

  // 启动流程：VM 启动（如需）→ 建会话 → 渲染
  const boot = (async () => {
    const bootState = await waitForVmBoot(screen, theme, options.getBootState);
    if (bootState && bootState.failed) {
      console.error('[tui] VM 启动失败:', bootState.detail || bootState.reason || '');
    }
    const modeArg = argv.find((a) => a.startsWith('--mode='));
    const workspaceArg = argv.find((a) => a.startsWith('--workspace='));
    await app.start({
      mode: modeArg ? modeArg.slice('--mode='.length) : 'chat',
      workspacePath: workspaceArg ? workspaceArg.slice('--workspace='.length) : undefined,
    });
  })()
    .catch((error) => {
      try {
        console.error('[tui] boot failed:', error);
      } catch {
        /* ignore */
      }
    })
    .then(() => {
      render();
    });

  if (interactive) {
    screen.enter();
    enteredScreen = true;
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.resume();
    if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');
    stdin.on('data', onStdin);
    if (typeof process.stdout.on === 'function') {
      process.stdout.on('resize', () => {
        screen.width = process.stdout.columns || screen.width;
        screen.height = process.stdout.rows || screen.height;
        app.resize(screen.width, screen.height);
        render();
      });
    }
  } else {
    // 非 TTY（管道/自动化，或 Windows 下的 Electron 主进程）：渲染一帧后退出，
    // 便于脚本直接读取界面文本（长驻无界面请用 --headless --web）。
    boot
      .then(() => {
        render();
        shutdown();
      })
      .catch(() => shutdown());
  }

  // 动画时钟：spinner / 闪烁 / 计时
  animTimer = setInterval(() => {
    app.tick();
    render();
  }, 120);
  if (typeof animTimer.unref === 'function') animTimer.unref();

  // 控制台信号也当作 Ctrl+C 键处理：
  //   - raw 模式下 Ctrl+C 本就是数据（0x03），走按键路径；
  //   - 非 raw（或窗口期）时控制台会发 CTRL_C_EVENT → Node 暴露为 SIGINT，
  //     若不处理会被默认行为直接杀掉（Windows 退出码 0xC000013A）。
  const onSigint = () => enqueueKey({ name: 'char', char: 'c', ctrl: true });
  const onSigterm = () => {
    quitRequested = true;
    shutdown();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const detachSignals = () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };

  return {
    app,
    screen,
    render,
    boot,
    shutdown,
    logFile,
    get quitRequested() {
      return quitRequested;
    },
  };
}

module.exports = {
  startTui,
  createTerminalScreen,
  installLogIsolation,
  renderBar,
  waitForVmBoot,
  ALT_ENTER,
  ALT_EXIT,
  CH,
  CSI,
};
