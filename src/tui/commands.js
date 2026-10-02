/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 斜杠命令：命令表（同时用于 /help 展示与输入补全提示）+ 解析。
 */

'use strict';

/** 命令表：name 参数名 说明 */
const COMMANDS = [
  { name: 'help', args: '', desc: '显示帮助' },
  { name: 'mode', args: '<chat|babe|code>', desc: '切换模式（新建该模式的会话）' },
  { name: 'new', args: '[mode]', desc: '新建会话' },
  { name: 'sessions', args: '', desc: '会话列表 / 切换' },
  { name: 'history', args: '', desc: '历史会话（按模式）' },
  { name: 'open', args: '<id>', desc: '打开历史会话' },
  { name: 'rename', args: '<标题>', desc: '重命名当前会话' },
  { name: 'delete', args: '<id>', desc: '删除历史会话' },
  { name: 'attach', args: '<文件路径>', desc: '附加文件给下一条消息' },
  { name: 'workspace', args: '[路径]', desc: '查看/设置 Code 模式工作区' },
  { name: 'todo', args: '', desc: '查看待办清单' },
  { name: 'usage', args: '', desc: '查看本轮 Token 用量' },
  { name: 'model', args: '', desc: '查看当前模型与模型池' },
  { name: 'status', args: '', desc: '查看运行状态' },
  { name: 'clear', args: '', desc: '清屏（不影响历史）' },
  { name: 'stop', args: '', desc: '停止当前任务' },
  { name: 'continue', args: '[补充说明]', desc: '继续 / 热消息注入' },
  { name: 'compact', args: '', desc: '压缩上下文（释放窗口）' },
  { name: 'quit', args: '', desc: '退出（等价 Ctrl+C 两次）' },
];

const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]));

/**
 * 解析输入文本。
 * @returns {{kind: 'command'|'message', name?: string, args?: string, argText?: string, text?: string, error?: string}}
 */
function parseInput(raw) {
  const text = String(raw == null ? '' : raw);
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message', text };
  const spaceIndex = trimmed.search(/\s/);
  const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).toLowerCase();
  const argText = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  const command = COMMAND_MAP.get(name);
  if (!command)
    return { kind: 'command', name, argText, error: `未知命令 /${name}（输入 /help 查看命令表）` };
  return { kind: 'command', name, argText, args: argText };
}

/** 输入中的斜杠命令前缀 → 补全建议 */
function suggest(partial) {
  const text = String(partial || '').trimStart();
  if (!text.startsWith('/')) return [];
  const query = text.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(query)).slice(0, 6);
}

/** /help 内容行 */
function helpLines() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length + c.args.length)) + 3;
  return COMMANDS.map((c) => {
    const head = ('/' + c.name + ' ' + c.args).padEnd(width);
    return head + c.desc;
  });
}

module.exports = { COMMANDS, COMMAND_MAP, parseInput, suggest, helpLines };
