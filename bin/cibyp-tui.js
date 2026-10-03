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

const { bootNodeRuntime, waitForRuntime } = require('../src/tui/node-entry.js');

const main = bootNodeRuntime(process.argv.slice(2));

waitForRuntime(main)
  .then(() => {
    // TUI 由 main.js 的 --tui 启动块拉起；此处仅保证运行时可见
  })
  .catch((error) => {
    console.error('[cibyp-tui] 启动失败:', error);
    process.exit(1);
  });
