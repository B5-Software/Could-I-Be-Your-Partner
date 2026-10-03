/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 的纯 Node 入口（脱离 Electron）。
 *
 *   node bin/cibyp-tui.js [--mode=chat|babe|code] [--workspace=路径] [--web]
 *
 * 工作方式：
 *   1. 安装 Electron shim（src/tui/electron-shim.js）
 *   2. 载入 src/main/main.js —— 服务装配（settings/LLM/历史/文件/终端/网络/…）
 *      与 Electron 模式共用同一套代码，457 个 IPC handler 照常注册
 *   3. main.js 的 --tui 启动块创建 Agent 运行时并拉起 TUI
 *
 * 为什么必须是纯 Node：Electron 是 GUI 子系统程序，Windows 下它的
 * process.stdin 不是 TTY（setRawMode 都不存在），无法做交互界面；
 * 而原生模块都是 N-API，Node 与 Electron 共用同一份编译产物。
 */

'use strict';

const path = require('node:path');
const { installElectronShim } = require('./electron-shim.js');

const ROOT = path.resolve(__dirname, '../..');

/**
 * 启动纯 Node 运行时（不拉起 TUI，便于测试/嵌入）。
 * @param {string[]} argv 额外参数（--mode= --workspace= --web --headless …）
 * @returns {{ getAgentRuntime: Function, getTuiHandle: Function, isHeadless: Function }}
 */
function bootNodeRuntime(argv = []) {
  installElectronShim();
  const forwarded = Array.isArray(argv) ? argv.slice() : [];
  // 显式 --headless 时只跑服务（如纯 WebUI）；否则以 TUI 方式启动
  if (!forwarded.includes('--headless') && !forwarded.includes('--tui')) {
    forwarded.unshift('--tui');
  }
  process.argv = [process.argv[0], path.join(ROOT, 'src/main/main.js'), ...forwarded];
  // 入口崩溃要看得见（否则只是静默退出）
  if (!process.__cibypNodeEntryErrorHandler) {
    process.__cibypNodeEntryErrorHandler = true;
    process.on('uncaughtException', (error) => {
      console.error('[cibyp] uncaught exception:', error);
    });
    process.on('unhandledRejection', (error) => {
      console.error('[cibyp] unhandled rejection:', error instanceof Error ? error.stack : error);
    });
  }
  return require('../main/main.js');
}

/**
 * 等待 Agent 运行时就绪（main.js 的 whenReady 异步装配）。
 * @param {{getAgentRuntime: Function}} main
 */
async function waitForRuntime(main, timeoutMs = 60000) {
  const startedAt = Date.now();
  for (;;) {
    const runtime = main.getAgentRuntime && main.getAgentRuntime();
    if (runtime) return runtime;
    if (Date.now() - startedAt > timeoutMs) throw new Error('agent runtime did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

module.exports = { bootNodeRuntime, waitForRuntime, ROOT };

if (require.main === module) {
  const args = process.argv.slice(2);
  let main;
  try {
    main = bootNodeRuntime(args);
  } catch (error) {
    console.error('[cibyp] 启动失败:', error);
    process.exit(1);
  }
  waitForRuntime(main)
    .then((runtime) => {
      console.error(`[cibyp] 无头运行时就绪（${runtime.listSessions().length} 个会话）`);
    })
    .catch((error) => {
      console.error('[cibyp] 运行时未就绪:', error);
      process.exit(1);
    });
}
