/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { LineEditor } = require('./editor');
const { t, getLanguage } = require('./text');

const ENUMS = {
  'budget.subscriptionDisplay': ['api-equivalent', '5hour', 'weekly', 'monthly', 'urgent'],
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
    this.category = null;
    this.group = null;
  }
  async open(query = '') {
    this.settings = await this.app.runtime.getSettings();
    this.catalog =
      (await this.app.runtime.getSettingsCatalog?.()) ||
      require('../main/core/settings-catalog').settingsCatalog(this.settings);
    const metadata = new Map(this.catalog.fields.map((field) => [field.path, field]));
    this.all = fields(this.settings)
      .filter((field) => metadata.has(field.path))
      .map((field) => ({
        ...field,
        ...metadata.get(field.path),
        value: field.value,
        type: field.type,
      }));
    this.query = query;
    this.list();
  }
  label(field) {
    return (
      field.labels?.[getLanguage()] ||
      t(
        'ui.settings.field.' + field.path,
        field.label ||
          field.path
            .split('.')
            .at(-1)
            .replace(/([a-z])([A-Z])/g, '$1 $2'),
      )
    );
  }
  categoryLabel(id) {
    const category = this.catalog.categories.find((row) => row.id === id);
    return (
      category?.labels?.[getLanguage()] || t('ui.settings.category.' + id, category?.label || id)
    );
  }
  readable(field) {
    if (field.secret) return field.value ? MASK : '—';
    if (field.type === 'boolean')
      return field.value ? t('ui.tui.configOn', '开启') : t('ui.tui.configOff', '关闭');
    if (Array.isArray(field.value))
      return t('ui.tui.configItems', '{count} 项', { count: field.value.length });
    if (field.options?.length)
      return (
        field.options.find((option) => option.value === field.value)?.label ||
        String(field.value || '—')
      );
    return String(field.value ?? '') || '—';
  }
  list() {
    const editor = new LineEditor();
    editor.setValue(this.query || '');
    this.app.state.modal = {
      kind: 'configList',
      title: this.group
        ? this.group.label
        : this.category
          ? this.categoryLabel(this.category)
          : t('ui.tui.configTitle', '设置'),
      inputMode: true,
      editor,
      selected: 0,
      footer: t('ui.tui.configNavigation', '输入搜索 · ↑↓ 选择 · Enter 打开或修改 · Esc 返回'),
    };
    this.filter();
  }
  filter() {
    const modal = this.app.state.modal;
    this.query = modal.editor.value;
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (this.group) {
      const group = this.group;
      const data = group.value;
      modal.options = (
        Array.isArray(data)
          ? data.map((value, index) => [String(index), value])
          : Object.entries(data || {})
      ).map(([name, value]) => {
        const field = {
          path: group.path + '.' + name,
          label: Array.isArray(data)
            ? value?.name || value?.model || value?.id || String(Number(name) + 1)
            : name.replace(/([a-z])([A-Z])/g, '$1 $2'),
          value,
          type: value && typeof value === 'object' ? 'json' : typeof value,
          secret: secret(name),
        };
        return {
          label:
            this.label(field) +
            '  ' +
            (value && typeof value === 'object' ? '›' : this.readable(field)),
          field,
        };
      });
      if (Array.isArray(data))
        modal.options.push({ label: t('ui.tui.configAdd', '+ 添加项目'), add: true });
      if (group.parent)
        modal.options.push({ label: t('ui.tui.configDelete', '删除此项目'), remove: true });
      modal.options = modal.options.filter((option) =>
        words.every((word) => option.label.toLowerCase().includes(word)),
      );
    } else if (!this.category && !words.length) {
      modal.options = this.catalog.categories
        .map((category) => ({
          label: this.categoryLabel(category.id) + '  ›',
          category: category.id,
        }))
        .filter((option) => this.all.some((field) => field.category === option.category));
    } else {
      modal.options = this.all
        .filter((field) => !this.category || field.category === this.category)
        .filter((field) =>
          words.every((word) =>
            (field.path + ' ' + this.label(field) + ' ' + this.categoryLabel(field.category))
              .toLowerCase()
              .includes(word),
          ),
        )
        .map((field) => ({ label: this.label(field) + '  ' + this.readable(field), field }));
      if (this.category === 'webcontrol' && !words.length)
        modal.options.push(
          ...['webStart', 'webStop', 'torStart', 'torStop', 'torStatus'].map((action) => ({
            action,
            label: t(
              'ui.tui.configAction.' + action,
              {
                webStart: '启动 WebUI',
                webStop: '停止 WebUI',
                torStart: '连接 Tor',
                torStop: '停止 Tor',
                torStatus: 'Tor 连接状态',
              }[action],
            ),
          })),
        );
    }
    modal.selected = Math.min(modal.selected || 0, Math.max(0, modal.options.length - 1));
    modal.subtitle = t('ui.tui.configShared', '与 GUI / WebUI 共享设置，修改后即时保存');
  }
  edit(field) {
    if (field.value && typeof field.value === 'object') {
      this.group = { ...field, parent: this.group };
      this.query = '';
      this.list();
      return;
    }
    const options =
      field.options || (ENUMS[field.path] || []).map((value) => ({ value, label: value }));
    if (options.length) {
      this.app.state.modal = {
        kind: 'configChoice',
        title: this.label(field),
        field,
        options: options.map((option) => ({
          ...option,
          label: (option.value === field.value ? '● ' : '○ ') + option.label,
        })),
        selected: Math.max(
          0,
          options.findIndex((option) => option.value === field.value),
        ),
      };
      return;
    }
    const editor = new LineEditor();
    editor.setValue(field.secret ? '' : String(field.value ?? ''));
    this.app.state.modal = {
      kind: 'configEdit',
      title: this.label(field),
      subtitle:
        field.type === 'number'
          ? [field.min, field.max].filter((value) => value !== undefined).join(' – ')
          : '',
      inputMode: true,
      masked: field.secret,
      editor,
      field,
      footer: t('ui.tui.configSaveHint', 'Enter 保存 · Esc 返回'),
    };
  }
  async handle(key) {
    const modal = this.app.state.modal;
    if (!modal?.kind?.startsWith('config')) return false;
    if (key.ctrl && key.char === 'c') {
      this.app.state.modal = null;
      return true;
    }
    if (key.name === 'escape') {
      if (modal.kind !== 'configList') this.list();
      else if (this.group) {
        this.group = this.group.parent;
        this.query = '';
        this.list();
      } else if (this.category) {
        this.category = null;
        this.query = '';
        this.list();
      } else this.app.state.modal = null;
      return true;
    }
    if (
      ['up', 'down', 'pageup', 'pagedown', 'wheel'].includes(key.name) &&
      modal.kind !== 'configEdit'
    ) {
      const delta = key.name === 'up' || key.name === 'pageup' || key.direction === 'up' ? -1 : 1;
      const step = key.name.startsWith('page')
        ? Math.max(1, Math.floor(this.app.state.height / 2))
        : 1;
      modal.selected = Math.max(
        0,
        Math.min(modal.options.length - 1, (modal.selected || 0) + delta * step),
      );
      return true;
    }
    if (key.name === 'enter' && !key.alt) {
      try {
        if (modal.kind === 'configEdit') {
          const value = parseValue(modal.field, modal.editor.value);
          if (
            (modal.field.min !== undefined && value < Number(modal.field.min)) ||
            (modal.field.max !== undefined && value > Number(modal.field.max))
          )
            throw Error(t('ui.tui.configRange', '数值超出允许范围'));
          await this.save(modal.field, value);
        } else if (modal.kind === 'configChoice')
          await this.save(modal.field, modal.options[modal.selected].value);
        else {
          const option = modal.options[modal.selected];
          if (!option) return true;
          if (option.action) {
            const method = {
              webStart: 'webControlStart',
              webStop: 'webControlStop',
              torStart: 'remoteTorStart',
              torStop: 'remoteTorStop',
              torStatus: 'remoteTorStatus',
            }[option.action];
            const result = await this.app.runtime.api[method]();
            if (result.ok === false) throw new Error(result.error);
            modal.subtitle =
              result.onion || result.url || result.phase || t('ui.tui.configSaved', '已保存');
          } else if (option.category) {
            this.category = option.category;
            this.query = '';
            this.list();
          } else if (option.add) {
            const field = this.group;
            const template =
              field.path === 'llm.pool'
                ? {
                    id: require('node:crypto').randomUUID(),
                    name: '',
                    provider: 'openai-compat',
                    apiUrl: '',
                    apiKey: '',
                    model: '',
                    enabled: true,
                  }
                : field.path === 'mcp.servers'
                  ? {
                      id: require('node:crypto').randomUUID(),
                      name: '',
                      type: 'stdio',
                      command: '',
                      args: [],
                      autoConnect: false,
                    }
                  : field.value[0] && typeof field.value[0] === 'object'
                    ? Object.fromEntries(
                        Object.entries(field.value[0]).map(([key, value]) => [
                          key,
                          typeof value === 'boolean'
                            ? false
                            : typeof value === 'number'
                              ? 0
                              : typeof value === 'object'
                                ? Array.isArray(value)
                                  ? []
                                  : {}
                                : '',
                        ]),
                      )
                    : '';
            await this.save(field, [...field.value, template]);
          } else if (option.remove) {
            const parent = this.group.parent;
            const index = Number(this.group.path.split('.').at(-1));
            this.group = parent;
            await this.save(
              parent,
              parent.value.filter((_, i) => i !== index),
            );
            this.list();
          } else if (option.field.readOnly)
            modal.subtitle = t('ui.tui.configReadOnly', '这项由运行时维护，只读');
          else if (option.field.type === 'boolean')
            await this.save(option.field, !option.field.value);
          else this.edit(option.field);
        }
      } catch (error) {
        modal.subtitle = error.message;
      }
    } else if (modal.editor) {
      modal.editor.handleKey(key);
      modal.selected = 0;
      if (modal.kind === 'configList') this.filter();
    }
    return true;
  }
  async save(field, value) {
    // Arrays are updated as complete arrays; nested form edits never create an
    // object with numeric keys in the shared settings store.
    let target = field;
    let next = value;
    if (this.group) {
      let group = this.group;
      const clone = structuredClone(group.value);
      if (field.path === group.path) next = value;
      else {
        clone[field.path.slice(group.path.length + 1)] = value;
        next = clone;
      }
      target = group;
      while (group.parent) {
        const parent = group.parent;
        const copy = structuredClone(parent.value);
        copy[group.path.slice(parent.path.length + 1)] = next;
        next = copy;
        target = parent;
        group = parent;
      }
    }
    await this.app.runtime.saveSettings(patchFor(target.path, next));
    await this.app.refreshSettings();
    const groups = [];
    for (let group = this.group; group; group = group.parent) groups.unshift(group);
    for (const group of groups) {
      group.value = group.path
        .split('.')
        .reduce((value, key) => value?.[key], this.app.state.settings);
    }
    await this.open(this.query);
    this.app.state.toast = {
      text: t('ui.tui.configSaved', '已保存：{path}', { path: this.label(field) }),
    };
  }
}

module.exports = { ConfigBrowser, fields, patchFor, parseValue, secret, valueLabel };
