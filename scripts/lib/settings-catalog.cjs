/* SPDX-License-Identifier: GPL-3.0-or-later */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { parseDocument } = require('htmlparser2');
const { FIELDS } = require('../../src/main/services/settings-assistant');
const { collectParts } = require('./renderer-parts.cjs');
const vm = require('node:vm');

function buildSettingsCatalog(root) {
  const dictionaries = {};
  for (const language of ['en', 'de'])
    vm.runInNewContext(
      fs.readFileSync(path.join(root, 'src/renderer/js/i18n', language + '.js'), 'utf8'),
      {
        i18nRegister: (name, dictionary) => {
          dictionaries[name] = dictionary;
        },
      },
    );
  const translations = (label) => ({
    'zh-CN': label,
    en: dictionaries.en._textMap?.[label] || label,
    de: dictionaries.de._textMap?.[label] || label,
  });
  const html = parseDocument(
    fs.readFileSync(path.join(root, 'src/renderer/pages/index.html'), 'utf8'),
  );
  const text = (node) =>
    node.type === 'text'
      ? node.data
      : (node.children || []).map(text).join(' ').replace(/\s+/g, ' ').trim();
  const all = [];
  const visit = (node) => {
    if (node.attribs) all.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(html);
  const categories = all
    .filter((node) => node.attribs.class?.split(' ').includes('settings-tab'))
    .map((node) => ({
      id: node.attribs['data-tab'],
      label: text(node),
      labels: translations(text(node)),
    }));
  const ancestor = (node, test) => {
    for (let current = node.parent; current; current = current.parent)
      if (test(current)) return current;
    return null;
  };
  const controls = all
    .filter(
      (node) =>
        ['input', 'select', 'textarea'].includes(node.name) &&
        ancestor(node, (n) => n.attribs?.class?.includes('settings-panel')),
    )
    .map((node) => {
      const item = ancestor(node, (n) => n.attribs?.class?.split(' ').includes('setting-item'));
      const panel = ancestor(node, (n) => n.attribs?.class?.split(' ').includes('settings-panel'));
      const labels = item?.children?.filter((n) => n.name === 'label') || [];
      return {
        id: node.attribs.id,
        path: node.attribs['data-setting'],
        category: panel.attribs['data-tab'],
        label: text(labels[0] || node) || node.attribs.placeholder || node.attribs.id,
        type: node.attribs.type || node.name,
        min: node.attribs.min,
        max: node.attribs.max,
        options:
          node.name === 'select'
            ? node.children
                .filter((n) => n.name === 'option')
                .map((n) => ({
                  value: n.attribs.value || text(n),
                  label: text(n),
                  labels: translations(text(n)),
                }))
            : undefined,
      };
    })
    .filter((row) => row.id);
  const bindings = new Map(FIELDS.filter((row) => row[2]).map((row) => [row[2], row[0]]));
  const controlIds = new Set(controls.map((row) => row.id));
  const directory = path.join(root, 'src/renderer/js/app-parts');
  const variables = new Map();
  for (const file of collectParts(directory)) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    let tree;
    try {
      tree = acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
      });
    } catch {
      continue;
    } // Some legacy parts intentionally split a lexical block.
    const aliases = new Map([
      ['s', ''],
      ['settings', ''],
    ]);
    function domId(node) {
      if (!node) return null;
      if (node.type === 'Identifier') return variables.get(node.name);
      if (node.type === 'Literal' && controlIds.has(node.value)) return node.value;
      if (
        node.type === 'CallExpression' &&
        node.callee.property?.name === 'getElementById' &&
        typeof node.arguments[0]?.value === 'string'
      )
        return node.arguments[0].value;
      if (node.type === 'CallExpression' && node.arguments.length === 1)
        return domId(node.arguments[0]);
      if (node.type === 'MemberExpression') return domId(node.object);
      if (node.type === 'ChainExpression') return domId(node.expression);
      return null;
    }
    function settingPath(node) {
      if (!node) return null;
      if (node.type === 'Identifier') return aliases.has(node.name) ? aliases.get(node.name) : null;
      if (node.type === 'MemberExpression' && !node.computed) {
        const parent = settingPath(node.object);
        return parent === null ? null : (parent ? parent + '.' : '') + node.property.name;
      }
      if (node.type === 'LogicalExpression')
        return settingPath(node.left) || settingPath(node.right);
      if (node.type === 'BinaryExpression') return settingPath(node.left);
      if (node.type === 'UnaryExpression') return settingPath(node.argument);
      if (node.type === 'CallExpression')
        return (
          settingPath(node.callee.object) ||
          node.arguments.map(settingPath).find((value) => value !== null) ||
          null
        );
      if (node.type === 'ConditionalExpression')
        return (
          settingPath(node.consequent) || settingPath(node.alternate) || settingPath(node.test)
        );
      if (node.type === 'ChainExpression') return settingPath(node.expression);
      return null;
    }
    function walk(node) {
      if (node.type === 'CallExpression') {
        const id = domId(node.arguments[0]);
        const value = settingPath(node.arguments[1]);
        if (id && value) bindings.set(id, value);
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        const id = domId(node.init);
        if (id) variables.set(node.id.name, id);
        const value = settingPath(node.init);
        if (value) aliases.set(node.id.name, value);
      }
      if (node.type === 'AssignmentExpression' && node.operator === '=') {
        const id = domId(node.left);
        const value = settingPath(node.right);
        if (id && value) bindings.set(id, value);
        const reverse = domId(node.right);
        const target = settingPath(node.left);
        if (reverse && target) bindings.set(reverse, target);
        if (target && node.right.type === 'ObjectExpression')
          for (const property of node.right.properties) {
            const id = domId(property.value);
            const key = property.key?.name || property.key?.value;
            if (id && key) bindings.set(id, target + '.' + key);
          }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.filter((child) => child?.type).forEach(walk);
        else if (value?.type) walk(value);
      }
    }
    walk(tree);
  }
  const extras = {
    'setting-reasoning-summary': 'llm.requestReasoningSummary',
    'setting-reasoning-preserve': 'llm.preserveEncryptedReasoning',
    'setting-wc-host': 'webControl.host',
    'setting-wc-enabled': 'webControl.enabled',
    'setting-wc-autostart': 'webControl.autoStartOnOpen',
    'setting-wc-port': 'webControl.port',
    'setting-wc-password': 'webControl.password',
    'setting-wc-enable-2fa': 'webControl.enable2FA',
    'setting-llm-provider': 'llm.provider',
    'setting-llm-model': 'llm.model',
    'setting-llm-url': 'llm.apiUrl',
    'setting-llm-key': 'llm.apiKey',
  };
  for (const [id, value] of Object.entries(extras)) bindings.set(id, value);
  const fields = controls.map((row) => ({
    ...row,
    labels: translations(row.label),
    path: row.path || bindings.get(row.id) || null,
  }));
  const target = path.join(root, 'src/shared/generated/settings-catalog.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ categories, fields }, null, 2) + '\n');
  return { categories, fields };
}
module.exports = { buildSettingsCatalog };
