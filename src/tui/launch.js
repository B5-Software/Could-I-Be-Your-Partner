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
  const interactive = Boolean(stdin.isTTY) && Boolean(stdout.isTTY);

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
    clearInterval(animTimer);
    clearTimeout(onStdin.flushTimer);
    try {
      stdin.removeListener('data', onStdin);
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      stdin.pause();
    } catch {
      /* ignore */
    }
    try {
      screen.exit();
    } catch {
      /* ignore */
    }
    app.dispose();
    console.log = originalLog;
    if (typeof options.onExit === 'function') options.onExit(quitRequested ? 0 : 0);
    else process.exit(0);
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
    // 非 TTY（管道/测试）：不进 alt-screen，只渲染一次，便于自动化读取
    render();
  }

  // 动画时钟：spinner / 闪烁 / 计时
  animTimer = setInterval(() => {
    app.tick();
    render();
  }, 120);
  if (typeof animTimer.unref === 'function') animTimer.unref();

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
