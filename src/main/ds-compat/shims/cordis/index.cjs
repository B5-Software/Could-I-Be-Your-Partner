/*
 * CJS 入口：重导出应用安装的真实 Cordis 内核。
 * 插件入口若被 require() 加载（非 ESM 插件），走这里；
 * 命名导出场景由 index.mjs 覆盖。
 */

'use strict';

// 见 index.mjs 的说明：按名字 require 会自引用形成循环，这里同样沿目录树
// 向上定位真实 cordis，保证单实例。
const path = require('path');
const fs = require('fs');

const selfDir = fs.realpathSync(__dirname);
let dir = path.dirname(selfDir);
let realEntry = null;
while (true) {
  const candidate = path.join(dir, 'node_modules', '@deepseek-ai', 'cordis');
  if (fs.existsSync(candidate)) {
    let real = candidate;
    try { real = fs.realpathSync(candidate); } catch { /* keep */ }
    if (real !== selfDir) { realEntry = candidate; break; }
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

module.exports = realEntry ? require(realEntry) : {};
