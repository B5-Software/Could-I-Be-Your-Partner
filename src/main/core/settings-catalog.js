/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const catalog = require('../../shared/generated/settings-catalog.json');
const { FIELDS } = require('../services/settings-assistant');
const rootCategories = {
  aiPersona: 'ai',
  userProfile: 'user',
  llm: 'llm',
  decision: 'decision',
  contextCompaction: 'context',
  toolExposure: 'context',
  budget: 'budget',
  runtime: 'runtime',
  terminal: 'terminal',
  theme: 'theme',
  tui: 'tui',
  webControl: 'webcontrol',
  webResearch: 'webresearch',
  voice: 'voice',
  notifications: 'notifications',
  imageGen: 'image',
  email: 'email',
  proxy: 'proxy',
  mcp: 'mcp',
  updates: 'updates',
  privacyProtection: 'privacy',
  sessions: 'sessions',
  sandbox: 'sandbox',
  entropy: 'entropy',
  babe: 'babe',
  ime: 'osk',
};
const title = (value) =>
  String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
function settingsCatalog(settings) {
  const fields = [];
  function walk(object, prefix = '') {
    for (const [name, value] of Object.entries(object || {})) {
      if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
      const settingPath = prefix ? prefix + '.' + name : name;
      if (
        /usageHistory|dailyTokensUsed|dailyTokenDate|^toolAuthGranted|^codeMode|^onboarding|passwordHash|^webControl\.last/.test(
          settingPath,
        )
      )
        continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, settingPath);
        continue;
      }
      if (
        /usageHistory|dailyTokensUsed|dailyTokenDate|^toolAuthGranted|^codeMode|^onboarding/.test(
          settingPath,
        )
      )
        continue;
      const control = catalog.fields.find((row) => row.path === settingPath);
      const safe = FIELDS.find((row) => row[0] === settingPath);
      const range = safe?.[4];
      fields.push({
        path: settingPath,
        label: control?.label || safe?.[3] || title(name),
        labels: control?.labels,
        category:
          control?.category || safe?.[1] || rootCategories[settingPath.split('.')[0]] || 'general',
        fieldId: control?.id,
        type:
          control?.type === 'checkbox' ? 'boolean' : Array.isArray(value) ? 'list' : typeof value,
        secret: /api.?key|password|secret|credential|cookie|private.?key|authorization/i.test(name),
        options:
          control?.options ||
          (Array.isArray(range) && typeof range[0] === 'string'
            ? range.map((value) => ({ value, label: value }))
            : undefined),
        min: Array.isArray(range) && typeof range[0] === 'number' ? range[0] : control?.min,
        max: Array.isArray(range) && typeof range[0] === 'number' ? range[1] : control?.max,
      });
    }
  }
  walk(settings);
  return { categories: [...catalog.categories, { id: 'general', label: '其他设置' }], fields };
}
module.exports = { settingsCatalog };
