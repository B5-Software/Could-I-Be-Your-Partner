/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * electron-builder beforePack 钩子（模块式）。
 * electron-builder 26 起不再支持 shell 命令字符串形式的钩子，
 * 只接受可解析的模块路径（default export 或命名导出 beforePack）。
 * 职责：打包前刷新 build-info.json（git 哈希 + 构建时间）。
 */

'use strict';

const buildInfo = require('./build-info');

exports.beforePack = () => buildInfo();
