/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Node.js enabled JS runner - allows require and filesystem access
const fs = require('fs');

// 文件模式（Windows 受限执行：IPC 通道无法穿越中间进程，改为代码文件 + stdout JSON）
const codeFile = process.argv[2];

async function execute(code, respond) {
  try {
    const logs = [];
    const safeConsole = {
      log: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => logs.push('[ERROR] ' + a.map(String).join(' ')),
      warn: (...a) => logs.push('[WARN] ' + a.map(String).join(' '))
    };

    const runner = new Function(
      'require',
      'process',
      'Buffer',
      '__dirname',
      '__filename',
      'module',
      'exports',
      'console',
      'code',
      'return (async () => {"use strict";\n' + code + '\n})();'
    );

    const result = await runner(
      require,
      process,
      Buffer,
      process.cwd(),
      __filename,
      module,
      exports,
      safeConsole,
      code
    );

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
  process.on('message', async ({ code }) => {
    await execute(code, (payload) => {
      process.send(payload);
      process.exit(0);
    });
  });
}
