/*
 * 重导出应用安装的真实 Cordis 内核（@deepseek-ai/cordis）。
 * 该 shim 被 symlink 进插件 node_modules，使插件的
 *   import { Context, Service } from '@deepseek-ai/cordis'
 * 与宿主解析到同一个内核实例（instanceof 一致）。
 * 由于插件入口经动态 import 加载，type-only import 会被擦除；
 * 运行期 import 走本模块 → require 真实内核。
 */

'use strict';

module.exports = require('@deepseek-ai/cordis');
