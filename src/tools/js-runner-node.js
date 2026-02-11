/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Node.js enabled JS runner - allows require and filesystem access
process.on('message', async ({ code }) => {
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

    process.send({ output: logs.join('\n'), result: result !== undefined ? String(result) : undefined });
  } catch (e) {
    process.send({ error: e.message });
  }
  process.exit(0);
});
