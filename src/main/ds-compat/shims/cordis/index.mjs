/*
 * CIBYP 的 @deepseek-ai/cordis ESM 兼容 shim。
 *
 * 真实 DSH 插件普遍写 `import { Context, Service } from '@deepseek-ai/cordis'`。
 * 纯 CJS 的 `module.exports = require('@deepseek-ai/cordis')` 无法被
 * cjs-module-lexer 静态识别命名导出，会导致 "Named export 'Context' not found"。
 * 这里显式重导出真实内核的全部命名导出；同时通过真实路径解析，保证与宿主
 * 的 require('@deepseek-ai/cordis') 落在同一个模块实例（instanceof 一致，
 * Cordis 跨副本的 global Symbol 品牌也依然有效）。
 */

import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 不能用 createRequire(...) 后按名字 require('@deepseek-ai/cordis')：
// 本 shim 的 package.json 带 exports + name，会触发 Node 包自引用，解析回
// 自己形成循环依赖（拿到空对象）。改为沿目录树向上找“非本 shim 自身”的
// 真实 cordis，保证与宿主的 require 落在同一模块实例。
const selfDir = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
let dir = path.dirname(selfDir);
let realEntry = null;
while (true) {
  const candidate = path.join(dir, 'node_modules', '@deepseek-ai', 'cordis');
  if (existsSync(candidate)) {
    let real = candidate;
    try { real = realpathSync(candidate); } catch { /* keep */ }
    if (real !== selfDir) { realEntry = candidate; break; }
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

const require = createRequire(import.meta.url);
const cordis = realEntry ? require(realEntry) : {};

export const {
  Context,
  CordisError,
  DisposableList,
  EventsService,
  Fiber,
  Inject,
  Logger,
  LoggerService,
  RegistryService,
  Service,
  ValidationError,
  buildOuterStack,
  c16,
  c256,
  composeError,
  createCallable,
  defaultFormatters,
  getPropertyDescriptor,
  getTraceable,
  isBailed,
  isConstructor,
  isObject,
  joinPrototype,
  resolveConfig,
  symbols,
  withProps
} = cordis;

export default cordis;
