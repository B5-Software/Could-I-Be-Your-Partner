/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const TokenPolicy = require('../../shared/token-policy');
function isRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

/** Merge partial settings without erasing sibling fields or mutating defaults. */
function mergeSettings(defaults, saved) {
  if (!isRecord(saved)) throw new TypeError('Settings must be an object');
  function merge(base, value, depth, path = '') {
    if (depth > 32) throw new RangeError('Settings nesting is too deep');
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(value)])) {
      if (forbidden.has(key)) continue;
      const original = base[key];
      const incoming = Object.hasOwn(value, key) ? value[key] : original;
      const nextPath = path ? `${path}.${key}` : key;
      if (nextPath === 'budget.models' && Object.hasOwn(value, key) && isRecord(incoming))
        result[key] = merge({}, incoming, depth + 1, nextPath);
      else if (isRecord(original))
        result[key] = merge(original, isRecord(incoming) ? incoming : {}, depth + 1, nextPath);
      else if (isRecord(incoming)) result[key] = merge({}, incoming, depth + 1, nextPath);
      else result[key] = structuredClone(incoming);
    }
    return result;
  }
  return merge(defaults, saved, 0);
}

function loadSettings(defaults, saved, legacyTuiPreferences = {}) {
  saved = isRecord(saved) ? saved : {};
  // The former standalone file is read only for migration. New values live in
  // shared settings, so /thinking, /theme and the GUI edit the same preferences.
  const tui = { ...(isRecord(saved.tui) ? saved.tui : {}) };
  for (const key of ['thinkingExpanded', 'followGuiTheme']) {
    if (typeof tui[key] !== 'boolean' && typeof legacyTuiPreferences?.[key] === 'boolean')
      tui[key] = legacyTuiPreferences[key];
  }
  if (Object.keys(tui).length) saved = { ...saved, tui };
  return TokenPolicy.normalize(mergeSettings(defaults, TokenPolicy.migratePatch(saved)));
}

module.exports = { mergeSettings, loadSettings };
