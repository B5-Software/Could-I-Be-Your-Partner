/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 斜线命令体系：
 *
 *   - 内置命令表（同时用于 /help 与补全面板）
 *   - 自定义命令：`~/.cibyp/commands/*.md` 与 `<工作区>/.cibyp/commands/*.md`
 *       ---
 *       description: 提交代码          ← 可选，补全面板显示
 *       agent: code                   ← 可选，限定模式（chat|babe|code）
 *       ---
 *       请把工作区改动整理成一次提交…… $ARGUMENTS
 *     执行 `/name 参数` 时正文作为提示词发送，$ARGUMENTS / {{args}} 替换为参数
 *   - 补全建议：命令补全（带描述）与参数补全（模式 / 历史会话等）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { t } = require('./text.js');

/** 命令的展示文案（延迟翻译：语言由 settings.language 在运行时决定） */
function localizeCommand(cmd) {
  if (!cmd) return { desc: '', args: '' };
  if (cmd.custom) return { desc: cmd.desc || '', args: cmd.args || '' };
  return {
    desc: t('ui.tui.cmd.' + cmd.name, cmd.desc),
    args: t('ui.tui.args.' + cmd.name, cmd.args),
  };
}

/** 内置命令表 */
const COMMANDS = [
  { name: 'undo', args: '', desc: '停止并撤回最近一条用户消息及对应回复', group: 'message' },
  { name: 'cwd', args: '', desc: '用系统文件管理器打开当前工作区', group: 'general' },
  { name: 'config', args: '[搜索]', desc: '搜索和编辑共享设置', group: 'general' },
  { name: 'theme', args: '[on|off]', desc: '切换是否沿用 GUI 色系（持久化）', group: 'general' },
  { name: 'help', args: '', desc: '显示帮助', group: 'general' },
  {
    name: 'mode',
    args: '<chat|babe|code>',
    desc: '切换模式（无参数弹出选择器）',
    group: 'session',
  },
  { name: 'new', args: '[mode]', desc: '新建会话', group: 'session' },
  { name: 'sessions', args: '', desc: '会话列表 / 切换', group: 'session' },
  { name: 'history', args: '', desc: '历史会话（按模式）', group: 'session' },
  { name: 'open', args: '[关键词]', desc: '选择并打开历史会话', group: 'session' },
  {
    name: 'rename',
    args: '[标题]',
    desc: '选择会话重命名；带标题时重命名当前会话',
    group: 'session',
  },
  { name: 'delete', args: '[关键词]', desc: '选择并删除历史会话', group: 'session' },
  { name: 'commands', args: '', desc: '查看 / 重载自定义命令', group: 'general' },
  { name: 'attach', args: '<文件路径>', desc: '附加文件给下一条消息', group: 'message' },
  {
    name: 'workspace',
    args: '[路径|sync]',
    desc: '选择本地工作区；sync 取回 VM 文件',
    group: 'session',
  },
  { name: 'todo', args: '', desc: '查看待办清单', group: 'info' },
  { name: 'usage', args: '', desc: '查看本轮 Token 用量', group: 'info' },
  { name: 'model', args: '', desc: '查看当前模型与模型池', group: 'info' },
  { name: 'status', args: '', desc: '查看运行状态', group: 'info' },
  { name: 'thinking', args: '', desc: '切换推理内容折叠/展开', group: 'info' },
  {
    name: 'vmdesk',
    args: '',
    desc: '打开 VM 桌面（虚拟机图形环境）',
    group: 'session',
  },
  { name: 'clear', args: '', desc: '清屏（不影响历史）', group: 'general' },
  { name: 'stop', args: '', desc: '停止当前任务', group: 'message' },
  { name: 'continue', args: '[补充说明]', desc: '继续 / 热消息注入', group: 'message' },
  { name: 'compact', args: '', desc: '压缩上下文（释放窗口）', group: 'message' },
  { name: 'quit', args: '', desc: '退出（等价 Ctrl+C 两次）', group: 'general' },
];

/** 解析 markdown 自定义命令文件（简单 frontmatter） */
function parseCommandFile(name, text) {
  const raw = String(text == null ? '' : text);
  let description = '';
  let agent = '';
  let body = raw;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match) {
    body = match[2];
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim();
      if (key === 'description' || key === 'desc') description = value;
      else if (key === 'agent' || key === 'mode') agent = value.toLowerCase();
    }
  }
  return {
    name,
    args: t('ui.tui.customArgs', '[参数]'),
    desc: description || t('ui.tui.customCommand', '自定义命令'),
    group: 'custom',
    custom: true,
    agent: ['chat', 'babe', 'code'].includes(agent) ? agent : '',
    body: body.trim(),
  };
}

/**
 * 从目录列表加载自定义命令（不存在/不可读的目录跳过）。
 * @param {string[]} dirs
 * @returns {Map<string, object>}
 */
function loadCustomCommands(dirs) {
  const map = new Map();
  for (const dir of dirs || []) {
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
    } catch {
      continue;
    }
    for (const file of entries) {
      const name = file
        .replace(/\.md$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-');
      if (!name) continue;
      try {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        map.set(name, parseCommandFile(name, text));
      } catch {
        /* 单个文件读取失败不影响其余 */
      }
    }
  }
  return map;
}

/** 默认的自定义命令目录（用户级 + 工作区级） */
function defaultCommandDirs(options = {}) {
  const home = (options.env && options.env.CIBYP_USER_DATA) || path.join(os.homedir(), '.cibyp');
  const dirs = [path.join(home, 'commands')];
  if (options.workspace) dirs.push(path.join(options.workspace, '.cibyp', 'commands'));
  return dirs;
}

/**
 * 解析输入文本。
 * @returns {{kind: 'command'|'message', name?: string, argText?: string, error?: string, custom?: object, text?: string}}
 */
function parseInput(raw, options = {}) {
  const text = String(raw == null ? '' : raw);
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message', text };
  const spaceIndex = trimmed.search(/\s/);
  const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).toLowerCase();
  const argText = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

  const builtin = COMMANDS.find((c) => c.name === name);
  if (builtin) return { kind: 'command', name, argText, builtin };

  const custom = options.customCommands && options.customCommands.get(name);
  if (custom) return { kind: 'command', name, argText, custom };

  return {
    kind: 'command',
    name,
    argText,
    error: t(
      'ui.tui.unknownCommandHelp',
      '未知命令 /{name}（/help 查看命令表，/commands 查看自定义命令）',
      { name },
    ),
  };
}

/**
 * 命令补全建议（输入以 / 开头时）。
 * @returns {Array<{label: string, value: string, description: string, hint?: string}>}
 */
function suggestCommands(partial, options = {}) {
  const text = String(partial || '').trimStart();
  if (!text.startsWith('/')) return [];
  const query = text.slice(1).split(/\s/)[0].toLowerCase();
  const items = [];
  for (const cmd of COMMANDS) {
    if (!cmd.name.startsWith(query)) continue;
    const localized = localizeCommand(cmd);
    items.push({
      label: '/' + cmd.name,
      value: '/' + cmd.name,
      description: localized.desc,
      hint: localized.args || '',
    });
  }
  const custom = options.customCommands;
  if (custom) {
    for (const cmd of custom.values()) {
      if (!cmd.name.startsWith(query)) continue;
      items.push({
        label: '/' + cmd.name,
        value: '/' + cmd.name,
        description: cmd.desc,
        hint: t('ui.tui.customTag', '自定义'),
      });
    }
  }
  return items.slice(0, 8);
}

/**
 * 参数补全建议。
 * @param {string} name 命令名
 * @param {string} argPrefix 已输入的参数前缀
 * @param {{modes?: string[], history?: Array<{id: string, title?: string}>}} context
 */
function suggestArgs(name, argPrefix, context = {}) {
  const prefix = String(argPrefix || '')
    .trimStart()
    .toLowerCase();
  const items = [];
  if (name === 'theme') {
    for (const value of ['on', 'off']) {
      if (value.startsWith(prefix)) items.push({ label: value, value });
    }
  }
  if (name === 'mode' || name === 'new') {
    for (const mode of context.modes || ['chat', 'babe', 'code']) {
      if (!mode.startsWith(prefix)) continue;
      items.push({
        label: mode,
        value: mode,
        description:
          mode === 'chat'
            ? t('ui.tui.modeOptionChat', '日常对话（全工具面）')
            : mode === 'babe'
              ? t('ui.tui.modeOptionBabe', '陪伴模式（好感度）')
              : t('ui.tui.modeOptionCode', '编码模式（工作区为中心）'),
      });
    }
  }
  return items.slice(0, 8);
}

/** 自定义命令正文 → 提示词（替换参数占位符） */
function expandCustomCommand(command, argText) {
  const args = String(argText || '');
  return String(command.body || '')
    .replace(/\$ARGUMENTS\b/g, args)
    .replace(/\{\{\s*args\s*\}\}/g, args)
    .trim();
}

/** /help 内容行（按分组） */
function helpLines(customCommands) {
  const groups = new Map();
  const push = (cmd) => {
    const key = cmd.group || 'general';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cmd);
  };
  COMMANDS.forEach(push);
  if (customCommands) for (const cmd of customCommands.values()) push(cmd);

  const titles = {
    general: '通用',
    session: '会话',
    message: '消息',
    info: '信息',
    custom: '自定义命令',
  };
  const lines = [];
  for (const [key, list] of groups) {
    const localized = list.map((cmd) => {
      const text = localizeCommand(cmd);
      return { head: '/' + cmd.name + ' ' + text.args, desc: text.desc };
    });
    const width = Math.max(...localized.map((c) => c.head.length)) + 3;
    lines.push(t('ui.tui.group.' + key, titles[key] || key));
    for (const entry of localized) {
      lines.push('  ' + entry.head.padEnd(width) + entry.desc);
    }
    lines.push('');
  }
  return lines;
}

module.exports = {
  COMMANDS,
  parseCommandFile,
  loadCustomCommands,
  defaultCommandDirs,
  parseInput,
  suggestCommands,
  suggestArgs,
  expandCustomCommand,
  helpLines,
};
