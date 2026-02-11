/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Sandboxed JS code runner - uses Node.js vm module for proper isolation
const vm = require('vm');

process.on('message', ({ code }) => {
  try {
    const logs = [];
    const safeConsole = {
      log: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => logs.push('[ERROR] ' + a.map(String).join(' ')),
      warn: (...a) => logs.push('[WARN] ' + a.map(String).join(' '))
    };

    const sandbox = {
      console: safeConsole,
      Math, Date, JSON, parseInt, parseFloat, isNaN, isFinite,
      String, Number, Boolean, Array, Object, RegExp, Map, Set, Promise, Symbol,
      setTimeout: undefined, setInterval: undefined, setImmediate: undefined,
      require: undefined, process: undefined, global: undefined, Buffer: undefined,
      __dirname: undefined, __filename: undefined, module: undefined, exports: undefined
    };

    const context = vm.createContext(sandbox);
    const result = vm.runInContext(`"use strict";\n${code}`, context, { timeout: 30000 });

    process.send({ output: logs.join('\n'), result: result !== undefined ? String(result) : undefined });
  } catch (e) {
    process.send({ error: e.message });
  }
  process.exit(0);
});
