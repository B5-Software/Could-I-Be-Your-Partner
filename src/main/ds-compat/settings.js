/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Service } = require('@deepseek-ai/cordis');
const path = require('node:path');
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const secretName = /(?:api.?key|password|secret|token|credential|private.?key)/i;
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function redact(value, schema, trail = [], secrets = []) {
  if (schema?.meta?.role === 'secret' || secretName.test(trail.at(-1) || '')) {
    secrets.push({ path: trail, present: value !== undefined && value !== '' });
    return undefined;
  }
  if (Array.isArray(value))
    return value.map((v, i) => redact(v, schema?.inner, [...trail, String(i)], secrets) ?? null);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !FORBIDDEN.has(k))
        .map(([k, v]) => [k, redact(v, schema?.dict?.[k] || schema?.inner, [...trail, k], secrets)])
        .filter(([, v]) => v !== undefined),
    );
  return value;
}
function merge(a, b) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (FORBIDDEN.has(key)) throw new TypeError('Invalid settings key');
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(a?.[key] || {}, value)
        : value;
  }
  return out;
}
class CibypSettings extends Service {
  constructor(ctx, options) {
    super(ctx, 'settings');
    this.options = options;
    this.entries = new Map();
    this.locks = new Map();
    this.documentPath =
      options.manifestPath || path.join(options.dataDir || process.cwd(), 'plugins.json');
  }
  get writable() {
    return typeof this.options.setPluginConfig === 'function';
  }
  prepareDocument() {
    return Promise.resolve(this.documentPath);
  }
  configure({ auto = true } = {}) {
    const owner = this.ctx[Symbol.for('cibyp.plugin.owner')];
    if (!owner) return () => {};
    const entry = this.entries.get(owner.pluginId);
    if (!entry) return () => {};
    const previous = entry.autoGenerate;
    entry.autoGenerate = auto;
    return this.ctx.effect(() => () => {
      entry.autoGenerate = previous;
    });
  }
  registerPlugin(id, schema, value) {
    const previous = this.entries.get(id);
    this.entries.set(id, {
      ns: id,
      autoGenerate: true,
      schema,
      value: clone(value),
      revision: (previous?.revision || 0) + 1,
    });
  }
  describe(options = {}) {
    return [...this.entries.values()].map((entry) => {
      const secrets = [];
      const value =
        options.redactSecrets === false
          ? clone(entry.value)
          : redact(entry.value, entry.schema, [], secrets);
      return {
        ns: entry.ns,
        schema: entry.schema?.toJSON?.() || entry.schema || {},
        autoGenerate: entry.autoGenerate,
        value,
        revision: entry.revision,
        applies: 'live',
        secrets,
      };
    });
  }
  get(ns) {
    return ns === undefined ? this.describe() : this.describe().find((e) => e.ns === ns)?.value;
  }
  _edit(ns, expected, operation) {
    const previous = this.locks.get(ns) || Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(async () => {
        const entry = this.entries.get(ns);
        if (!entry) throw new Error('Unknown plugin settings namespace: ' + ns);
        if (expected !== undefined && entry.revision !== expected)
          throw Object.assign(new Error('Plugin settings changed since they were read'), {
            code: 'SETTINGS_CONFLICT',
            expected,
            actual: entry.revision,
          });
        let value = operation(clone(entry.value));
        if (typeof entry.schema === 'function') value = await entry.schema(value);
        if (!this.writable) throw new Error('Plugin settings backend is read-only');
        await this.options.setPluginConfig(ns, value);
        entry.value = clone(value);
        entry.revision++;
        this.ctx.emit('settings/change', ns);
      });
    this.locks.set(ns, pending);
    return pending.finally(() => {
      if (this.locks.get(ns) === pending) this.locks.delete(ns);
    });
  }
  update(ns, patch, revision) {
    return this._edit(ns, revision, (value) => merge(value, clone(patch)));
  }
  replace(ns, section, revision) {
    return this._edit(ns, revision, () => clone(section));
  }
  mutate(ns, operations, revision) {
    return this._edit(ns, revision, (value) => {
      for (const operation of operations) {
        if (
          !['set', 'unset'].includes(operation.op) ||
          !operation.path?.length ||
          operation.path.some((k) => typeof k !== 'string' || FORBIDDEN.has(k))
        )
          throw new TypeError('Invalid settings mutation');
        let current = value;
        for (const key of operation.path.slice(0, -1)) current = current[key] ||= {};
        const key = operation.path.at(-1);
        if (operation.op === 'set') current[key] = clone(operation.value);
        else if (Array.isArray(current)) current.splice(Number(key), 1);
        else delete current[key];
      }
      return value;
    });
  }
}
module.exports = { CibypSettings, redact };
