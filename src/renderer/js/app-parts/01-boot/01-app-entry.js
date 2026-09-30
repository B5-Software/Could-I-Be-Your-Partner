/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Main Application Controller
// 注：本 part 已不包含 IIFE 包装，由 build-app-bundle.js 生成 ESM app.js 时
// 统一包在 `export default (async function appEntry() { ... })();` 中。
  // Wait for KaTeX to load
  await waitForDependency(() => !!window.katex);

  // Init theme
  await ThemeManager.init();
