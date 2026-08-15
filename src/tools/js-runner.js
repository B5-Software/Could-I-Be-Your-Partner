/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Sandboxed JS code runner - uses Node.js vm module for proper isolation
const vm = require('vm');
const fs = require('fs');

// 文件模式（Windows 受限执行：IPC 通道无法穿越中间进程，改为代码文件 + stdout JSON）
const codeFile = process.argv[2];

function execute(code, respond) {
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

    respond({ output: logs.join('\n'), result: result !== undefined ? String(result) : undefined });
  } catch (e) {
    respond({ error: e.message });
  }
}

if (codeFile) {
  let code;
  try {
    code = fs.readFileSync(codeFile, 'utf8');
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: '无法读取代码文件: ' + e.message }));
    process.exit(1);
  }
  execute(code, (payload) => {
    process.stdout.write(JSON.stringify(payload));
    process.exit(0);
  });
} else {
  process.on('message', ({ code }) => {
    execute(code, (payload) => {
      process.send(payload);
      process.exit(0);
    });
  });
}
