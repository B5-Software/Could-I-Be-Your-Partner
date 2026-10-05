/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// An explicit leaf allowlist prevents nested patches and prototype paths from escaping the scope.
const FIELDS = [
  ['language', 'language', 'setting-language', 'Language', ['zh-CN', 'en', 'de']],
  ['theme.mode', 'theme', null, 'Appearance mode', ['system', 'light', 'dark']],
  ['theme.accentColor', 'theme', 'setting-accent-color', 'Accent color', 'color'],
  ['theme.backgroundColor', 'theme', 'setting-bg-color', 'Background color', 'color'],
  ['theme.focusOutlines', 'theme', 'setting-focus-outlines', 'Focus outlines', 'boolean'],
  ['animations', 'animations', 'setting-ui-animations', 'Interface animations', 'boolean'],
  ['modalAnimations', 'animations', 'setting-ui-modal-animations', 'Modal animations', 'boolean'],
  ['tui.followGuiTheme', 'tui', 'setting-tui-follow-theme', 'TUI follows appearance', 'boolean'],
  ['tui.thinkingExpanded', 'tui', 'setting-tui-thinking', 'TUI expanded reasoning', 'boolean'],
  ['tui.mouse', 'tui', 'setting-tui-mouse', 'TUI mouse interaction', 'boolean'],
  ['tarotVisible', 'ai', 'setting-tarot-visible', 'Show fate card', 'boolean'],
  ['llm.streamResponses', 'llm', 'setting-llm-stream', 'Stream replies', 'boolean'],
  ['llm.temperature', 'llm', 'setting-llm-temp', 'Temperature', [0, 2]],
  ['llm.maxContextLength', 'context', 'setting-llm-ctx', 'Context tokens', [1024, 2000000]],
  ['llm.maxResponseTokens', 'context', 'setting-llm-max-response', 'Output tokens', [256, 128000]],
  ['llm.maxRetries', 'llm', 'setting-llm-retries', 'Request retries', [0, 20]],
  [
    'contextCompaction.enabled',
    'context',
    'setting-context-auto',
    'Automatic compaction',
    'boolean',
  ],
  [
    'contextCompaction.thresholdRatio',
    'context',
    'setting-context-threshold',
    'Compaction threshold',
    [0.6, 0.95],
  ],
  [
    'contextCompaction.retainRatio',
    'context',
    'setting-context-retain',
    'Retained recent context',
    [0.05, 0.4],
  ],
  [
    'contextCompaction.compactionRetries',
    'context',
    'setting-context-retries',
    'Summary retries',
    [0, 5],
  ],
  [
    'contextCompaction.summarizeMaxTokens',
    'context',
    'setting-context-max-tokens',
    'Summary output tokens',
    [512, 8192],
  ],
  [
    'toolExposure.budgetTokens',
    'context',
    'tool-schema-budget',
    'Tool definition budget',
    [1000, 16000],
  ],
  [
    'budget.subscriptionDisplay',
    'budget',
    'setting-subscription-display',
    'Subscription progress display',
    ['api-equivalent', '5hour', 'weekly', 'monthly', 'urgent'],
  ],
  [
    'budget.dailyLimitUSD',
    'budget',
    'setting-budget-daily-cap',
    'Daily API spending cap',
    [0, 100000],
  ],
  [
    'budget.weeklyLimitUSD',
    'budget',
    'setting-budget-weekly-cap',
    'Weekly API spending cap',
    [0, 100000],
  ],
  [
    'budget.monthlyLimitUSD',
    'budget',
    'setting-budget-monthly-cap',
    'Monthly API spending cap',
    [0, 100000],
  ],
  [
    'budget.dailyTokenLimit',
    'budget',
    'setting-llm-daily-limit',
    'Daily token cap',
    [0, 1000000000],
  ],
  [
    'budget.weekMode',
    'budget',
    'setting-budget-week-mode',
    'Budget week cycle',
    ['natural', 'rolling'],
  ],
  [
    'budget.monthMode',
    'budget',
    'setting-budget-month-mode',
    'Budget month cycle',
    ['natural', 'rolling'],
  ],
];
const PRIVATE = {
  llm: ['llm', 'setting-llm-key'],
  imageGen: ['image', 'setting-image-key'],
  decision: ['decision', 'setting-decision-key'],
  proxy: ['proxy', null],
  privacyProtection: ['privacy', null],
  sandbox: ['sandbox', null],
  runtime: ['vm', null],
  email: ['email', null],
  webControl: ['webcontrol', null],
  mcp: ['mcp', null],
  ai: ['ai', null],
  user: ['user', null],
  babe: ['babe', null],
  shell: ['shell', null],
  automation: ['automation', null],
  tools: ['tools', null],
  resources: ['resources', null],
  chatgpt: ['llm', 'chatgpt-account-select'],
  notifications: ['notifications', null],
};
const valueAt = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
class SettingsAssistant {
  constructor({ getSettings, update }) {
    this.getSettings = getSettings;
    this.update = update;
    this.revision = 0;
  }
  catalog(query = '') {
    const filter = String(query).slice(0, 200).toLowerCase();
    const entries = FIELDS.filter(
      (row) => !filter || (row[0] + ' ' + row[3]).toLowerCase().includes(filter),
    ).map(([path, category, fieldId, label, type]) => ({
      path,
      category,
      fieldId,
      label,
      type,
      value: valueAt(this.getSettings(), path),
    }));
    return {
      ok: true,
      entries,
      manualCategories: Object.keys(PRIVATE),
      notice:
        'Only the listed safe fields can be read or changed. Credentials, account identity, personal prompts and security controls are never returned. Navigate to other categories for manual editing.',
    };
  }
  patch(changes) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 20)
      throw new Error('Provide 1–20 safe setting changes');
    const patch = {};
    for (const change of changes) {
      const descriptor = FIELDS.find((row) => row[0] === change?.path);
      if (!descriptor)
        throw new Error('This setting requires manual editing; use settings_navigate');
      const type = descriptor[4];
      const value = change.value;
      const valid =
        type === 'boolean'
          ? typeof value === 'boolean'
          : type === 'color'
            ? typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
            : typeof type[0] === 'number'
              ? typeof value === 'number' &&
                Number.isFinite(value) &&
                value >= type[0] &&
                value <= type[1] &&
                (!/(?:Tokens|Length|Retries|Limit)$/.test(change.path) || Number.isInteger(value))
              : type.includes(value);
      if (!valid) throw new Error('Invalid setting value: ' + change.path);
      const keys = change.path.split('.');
      let target = patch;
      for (const key of keys.slice(0, -1)) target = target[key] ||= {};
      target[keys.at(-1)] = value;
    }
    this.update(patch);
    this.revision++;
    return {
      ok: true,
      changes: changes.map(({ path }) => ({ path, value: valueAt(this.getSettings(), path) })),
      revision: this.revision,
    };
  }
  navigate(path) {
    const exact = FIELDS.find((row) => row[0] === path);
    const prefix = String(path).split('.')[0];
    const privateRow = Object.hasOwn(PRIVATE, prefix) ? PRIVATE[prefix] : null;
    if (exact) return { ok: true, category: exact[1], fieldId: exact[2], manual: false };
    if (privateRow)
      return { ok: true, category: privateRow[0], fieldId: privateRow[1], manual: true };
    throw new Error('Unknown setting category');
  }
}
module.exports = { SettingsAssistant, FIELDS };
