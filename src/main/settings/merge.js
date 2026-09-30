/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
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
  function merge(base, value, depth) {
    if (depth > 32) throw new RangeError('Settings nesting is too deep');
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(value)])) {
      if (forbidden.has(key)) continue;
      const original = base[key];
      const incoming = Object.hasOwn(value, key) ? value[key] : original;
      if (isRecord(original))
        result[key] = merge(original, isRecord(incoming) ? incoming : {}, depth + 1);
      else if (isRecord(incoming)) result[key] = merge({}, incoming, depth + 1);
      else result[key] = structuredClone(incoming);
    }
    return result;
  }
  return merge(defaults, saved, 0);
}

function loadSettings(defaults, saved) {
  return mergeSettings(defaults, isRecord(saved) ? saved : {});
}

module.exports = { mergeSettings, loadSettings };
