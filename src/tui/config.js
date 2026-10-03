/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { LineEditor } = require('./editor');
const { t } = require('./text');

const ENUMS = {
  language: ['zh-CN', 'en', 'de'],
  'theme.mode': ['system', 'light', 'dark'],
  'runtime.location': ['host', 'vm'],
  'runtime.workspaceMode': ['shared', 'isolated'],
  'webResearch.engine': ['fusion', 'bing', 'exa', 'parallel', 'tinyfish'],
};
const secret = (path) =>
  /(?:api.?key|password|secret|token|credential|private.?key|authorization|cookie|passphrase)$/i.test(
    path,
  ) && !/(?:max|daily|total|context|response)Tokens?$/i.test(path);
const MASK = '••••••••';
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, secret(key) && item ? MASK : redact(item)]),
    );
  return value;
}
function restoreSecrets(value, original) {
  if (Array.isArray(value))
    return value.map((item, index) => restoreSecrets(item, original?.[index]));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secret(key) && item === MASK
          ? original?.[key] || ''
          : restoreSecrets(item, original?.[key]),
      ]),
    );
  return value;
}
const readOnly = (path) =>
  /(?:usageHistory|dailyTokensUsed|dailyTokenDate|usage\.|lastWorkspace|accounts\..*\.last)/.test(
    path,
  );
function fields(settings, prefix = '') {
  return Object.entries(settings || {}).flatMap(([key, value]) => {
    const path = prefix ? prefix + '.' + key : key;
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return [];
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length)
      return fields(value, path);
    return [
      {
        path,
        value,
        type:
          value === null
            ? 'json'
            : Array.isArray(value) || typeof value === 'object'
              ? 'json'
              : typeof value,
        secret: secret(path),
        readOnly: readOnly(path),
      },
    ];
  });
}
function patchFor(path, value) {
  const parts = path.split('.');
  if (parts.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part)))
    throw new Error('Invalid settings path');
  return parts.reverse().reduce((patch, key) => ({ [key]: patch }), value);
}
function parseValue(field, value) {
  let parsed = value;
  if (field.type === 'boolean') {
    if (!['true', 'false'].includes(value))
      throw new Error(t('ui.tui.configBoolean', '请输入 true 或 false'));
    parsed = value === 'true';
  } else if (field.type === 'number') {
    parsed = Number(value);
    if (!value.trim() || !Number.isFinite(parsed))
      throw new Error(t('ui.tui.configNumber', '请输入有效数字'));
  } else if (field.type === 'json') parsed = restoreSecrets(JSON.parse(value), field.value);
  if (ENUMS[field.path] && !ENUMS[field.path].includes(parsed))
    throw new Error(ENUMS[field.path].join(' | '));
  return parsed;
}
function valueLabel(field) {
  if (field.secret) return field.value ? '••••••••' : '—';
  return JSON.stringify(redact(field.value));
}

class ConfigBrowser {
  constructor(app) {
    this.app = app;
  }
  async open(query = '') {
    this.settings = await this.app.runtime.getSettings();
    this.all = fields(this.settings);
    this.query = query;
    this.list();
  }
  list() {
    const editor = new LineEditor();
    editor.setValue(this.query || '');
    this.app.state.modal = {
      kind: 'configList',
      title: t('ui.tui.configTitle', '设置'),
      inputMode: true,
      editor,
      selected: 0,
      footer: t('ui.tui.configHint', '输入搜索 · ↑↓ 选择 · Enter 编辑 · Esc 关闭'),
    };
    this.filter();
  }
  filter() {
    const modal = this.app.state.modal;
    this.query = modal.editor.value;
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    modal.options = this.all
      .filter((field) =>
        words.every((word) => (field.path + ' ' + this.label(field)).toLowerCase().includes(word)),
      )
      .map((field) => ({
        label: this.label(field) + ' · ' + field.path + ' = ' + valueLabel(field),
        field,
      }));
    modal.selected = Math.min(modal.selected || 0, Math.max(0, modal.options.length - 1));
    modal.subtitle = t('ui.tui.configCount', '{count} 项 · 与 GUI 共享，普通字段即时保存', {
      count: modal.options.length,
    });
  }
  label(field) {
    const root = field.path.split('.')[0];
    return t(
      'ui.tui.configGroup.' + root,
      {
        llm: '模型',
        theme: '外观',
        tui: 'TUI 偏好',
        runtime: '运行位置',
        webResearch: '网络搜索',
        budget: '用量与成本',
        voice: '语音',
        babe: 'Babe 模式',
        decision: 'Jev',
        tools: '工具',
        tarotVisible: '显示命运之牌',
        language: '语言',
      }[root] || root,
    );
  }
  async handle(key) {
    const modal = this.app.state.modal;
    if (!modal?.kind?.startsWith('config')) return false;
    if (key.name === 'escape') {
      if (modal.kind === 'configEdit') this.list();
      else this.app.state.modal = null;
      return true;
    }
    if (key.ctrl && key.char === 'c') {
      this.app.state.modal = null;
      return true;
    }
    if (modal.kind === 'configList') {
      if (['up', 'down', 'pageup', 'pagedown', 'wheel'].includes(key.name)) {
        const delta = key.name === 'up' || key.name === 'pageup' || key.direction === 'up' ? -1 : 1;
        const step = key.name.startsWith('page')
          ? Math.max(1, Math.floor(this.app.state.height / 2))
          : 1;
        modal.selected = Math.max(
          0,
          Math.min(modal.options.length - 1, (modal.selected || 0) + delta * step),
        );
      } else if (key.name === 'enter') {
        const field = modal.options[modal.selected]?.field;
        if (!field) return true;
        if (field.readOnly) {
          modal.subtitle = t('ui.tui.configReadOnly', '这项由运行时维护，只读');
          return true;
        }
        if (field.type === 'boolean') await this.save(field, !field.value);
        else {
          const editor = new LineEditor();
          editor.setValue(
            field.secret
              ? ''
              : field.type === 'string'
                ? field.value
                : JSON.stringify(redact(field.value)),
          );
          this.app.state.modal = {
            kind: 'configEdit',
            title: field.path,
            subtitle: field.type + (ENUMS[field.path] ? ' · ' + ENUMS[field.path].join(' | ') : ''),
            inputMode: true,
            masked: field.secret,
            editor,
            field,
            footer: t('ui.tui.configEditHint', 'Enter 保存 · Esc 返回；JSON 字段可编辑数组和对象'),
          };
        }
      } else {
        modal.editor.handleKey(key);
        modal.selected = 0;
        this.filter();
      }
    } else if (key.name === 'enter' && !key.alt) {
      try {
        await this.save(modal.field, parseValue(modal.field, modal.editor.value));
      } catch (error) {
        modal.subtitle = error.message;
      }
    } else modal.editor.handleKey(key);
    return true;
  }
  async save(field, value) {
    await this.app.runtime.saveSettings(patchFor(field.path, value));
    await this.app.refreshSettings();
    await this.open(this.query);
    this.app.state.toast = {
      text:
        t('ui.tui.configSaved', '已保存：{path}', { path: field.path }) +
        (field.path === 'runtime.location' ? ' · ' + t('ui.tui.configRestart', '重启后生效') : ''),
    };
  }
}
module.exports = { ConfigBrowser, fields, patchFor, parseValue, secret, valueLabel };
