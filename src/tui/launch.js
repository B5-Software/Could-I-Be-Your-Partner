/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 终端接线：把 TuiApp 接到真实终端。
 *
 *   - alt-screen 进出、光标隐藏、窗口尺寸与 resize
 *   - stdin raw mode → 按键解码 → TuiApp
 *   - 渲染循环：事件/按键后立即渲染 + 动画时钟（spinner 120ms）
 *   - 退出时恢复终端（raw mode / alt-screen / 光标），并保留日志文件
 *
 * 为了让 TUI 画面干净，进程日志（console.*）改写到 stderr；
 * 诊断日志不会污染 stdout 上的界面。
 */

'use strict';

const { TuiApp } = require('./app.js');
const { createKeyDecoder } = require('./keys.js');
const { themeFromEnv } = require('./theme.js');
const { CSI, CH } = require('./ansi.js');

const ALT_ENTER = CSI + '?1049h' + CSI + '2J' + CSI + 'H';
const ALT_EXIT = CSI + '?1049l';
const HIDE_CURSOR = CSI + '?25l';
const SHOW_CURSOR = CSI + '?25h';
const CLEAR_LINE_END = CSI + 'K';
const CLEAR_REST = CSI + 'J';

/** 终端屏幕：整帧重绘（免差分，简单可靠） */
function createTerminalScreen(stdout) {
  const screen = {
    width: (stdout.columns && Number(stdout.columns)) || 100,
    height: (stdout.rows && Number(stdout.rows)) || 30,
    enter() {
      stdout.write(ALT_ENTER + HIDE_CURSOR);
    },
    exit() {
      stdout.write(SHOW_CURSOR + CLEAR_REST + '\n' + ALT_EXIT);
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
      stdout.write(out);
    },
  };
  return screen;
}

/**
 * 启动 TUI。
 * @param {{runtime: object, stdout?: NodeJS.WriteStream, stdin?: NodeJS.ReadStream, argv?: string[], onExit?: Function}} options
 */
function startTui(options) {
  const stdout = options.stdout || process.stdout;
  const stdin = options.stdin || process.stdin;
  const argv = options.argv || process.argv;

  // 界面占 stdout：把日志改道 stderr，避免日志撕裂画面
  const originalLog = console.log;
  console.log = (...args) => {
    try {
      console.error(...args);
    } catch {
      /* ignore */
    }
  };

  const theme = themeFromEnv();
  const screen = createTerminalScreen(stdout);
  let quitRequested = false;

  // 交互性 = 能设原始模式（要收逐键输入）。
  // 注意：Windows 下 Electron 主进程的 stdin 不是 TTY（setRawMode 不存在），
  // 那种情况无法做交互界面 —— 渲染预览帧并提示改用纯 Node 入口（bin/cibyp-tui.js）。
  const interactive = typeof stdin.setRawMode === 'function';
  const looksLikeTerminal = Boolean(stdin.isTTY) || Boolean(stdout.isTTY);
  if (!interactive && looksLikeTerminal) {
    console.error('[cibyp] 当前进程无法接收键盘输入（stdin 不是终端 / setRawMode 不可用）。');
    console.error('[cibyp] 交互界面请运行: node bin/cibyp-tui.js   （已渲染一帧预览）');
  }

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
    if (rendering || quitRequested) return;
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
      // 疑似孤立 ESC：短暂等待后判定
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
    console.log = originalLog;
    try {
      console.error('[tui] shutdown: exiting cleanly');
    } catch {
      /* ignore */
    }
    // 同步退出：不留竞态窗口（否则控制台可能再把排队的 Ctrl+C 当信号杀掉进程）
    const code = typeof options.onExit === 'function' ? options.onExit(0) : 0;
    process.exit(typeof code === 'number' ? code : 0);
  }

  // 启动流程
  const boot = (async () => {
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
    // 非 TTY（管道/自动化）：不进 alt-screen，渲染一帧后退出，
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
  // 统一走按键路径后，退出由应用自己决定，退出码干净。
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
    get quitRequested() {
      return quitRequested;
    },
  };
}

module.exports = { startTui, createTerminalScreen, ALT_ENTER, ALT_EXIT, CH, CSI };
