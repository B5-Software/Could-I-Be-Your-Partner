/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function diff(before, after, path = '') {
    const patch = {};
    for (const [key, value] of Object.entries(after)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || equal(before?.[key], value))
        continue;
      const nextPath = path ? `${path}.${key}` : key;
      patch[key] =
        nextPath !== 'budget.models' && value && typeof value === 'object' && !Array.isArray(value)
          ? diff(before?.[key] || {}, value, nextPath)
          : structuredClone(value);
    }
    return patch;
  }
  function create(api, onState = () => {}) {
    const snapshots = new WeakMap();
    let queue = Promise.resolve();
    return {
      async read() {
        const settings = await api.getSettings();
        snapshots.set(settings, structuredClone(settings));
        return settings;
      },
      save(updates) {
        const snapshot = snapshots.get(updates);
        const patch = snapshot ? diff(snapshot, updates) : structuredClone(updates);
        const nextSnapshot = snapshot ? structuredClone(updates) : null;
        onState('saving');
        const pending = queue.then(async () => {
          try {
            const settings = Object.keys(patch).length
              ? await api.setSettings(patch)
              : await api.getSettings();
            if (nextSnapshot) snapshots.set(updates, nextSnapshot);
            onState('saved');
            return settings;
          } catch (error) {
            onState('error', error);
            throw error;
          }
        });
        queue = pending.catch(() => {});
        return pending;
      },
    };
  }
  const api = { diff, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SettingsClient = api;
})(typeof window !== 'undefined' ? window : globalThis);
