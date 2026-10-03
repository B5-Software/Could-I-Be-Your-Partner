#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * cibyp-tui —— 纯 Node 的 CIBYP 终端界面（脱离 Electron）。
 *
 *   cibyp-tui                          Chat 模式
 *   cibyp-tui --mode=babe              Babe 模式
 *   cibyp-tui --mode=code --workspace=/path
 *   cibyp-tui --web                    同时提供 WebUI
 *   cibyp-tui --headless --web         只跑服务（不开终端界面）
 */
'use strict';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(require('../package.json').version.split('+')[0]);
  return;
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`CIBYP terminal interface

  cibyp-tui                         Chat
  cibyp-tui --mode=babe             Babe
  cibyp-tui --mode=code --workspace=/path
  cibyp-tui --headless --web        Web service

Use /help for interactive commands, /workspace to choose a local Code directory.
GUI and TUI share settings and cannot run at the same time.`);
  return;
}
const { bootNodeRuntime, waitForRuntime } = require('../src/tui/node-entry.js');

const main = bootNodeRuntime(args);

waitForRuntime(main)
  .then(() => {
    // TUI 由 main.js 的 --tui 启动块拉起；此处仅保证运行时可见
  })
  .catch((error) => {
    console.error('[cibyp-tui] 启动失败:', error);
    process.exit(1);
  });
