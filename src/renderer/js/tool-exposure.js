/* SPDX-License-Identifier: GPL-3.0-or-later */
// A local registry: discovery never sends the entire catalog to a selection model.
(function (root) {
  'use strict';
  const schema = (name, description, properties, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });
  const DISCOVERY_SCHEMAS = [
    schema(
      'searchTools',
      'Search all enabled built-in, MCP and plugin tools by name, category or capability (Chinese/English). Matching tools are loaded for the NEXT request within the schema budget. Empty query lists categories. Discover missing tools before claiming a capability is unavailable.',
      {
        query: { type: 'string' },
        names: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        category: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 8 },
        load: { type: 'boolean', description: 'Default true; false only browses.' },
      },
    ),
    schema(
      'describeTool',
      'Read the original input schema of a discovered tool. Paginated properties or JSON pointer path avoid large responses. Use before invokeTool if the original tool cannot fit the schema budget.',
      {
        name: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        path: {
          type: 'string',
          description: 'JSON pointer within parameters, e.g. /properties/options/properties',
        },
      },
      ['name'],
    ),
    schema(
      'invokeTool',
      'Call a tool previously discovered with searchTools, using its original parameters encoded as a JSON object string. Useful for schemas too large to load. The original tool permissions and enabled state still apply.',
      {
        name: { type: 'string' },
        arguments_json: {
          type: 'string',
          description: 'JSON object matching the original input schema.',
        },
      },
      ['name', 'arguments_json'],
    ),
  ];
  const CORE = [
    'todoList',
    'readFile',
    'listDirectory',
    'localSearch',
    'editFile',
    'webSearch',
    'makeTerminal',
    'runTerminalCommand',
    'awaitTerminalCommand',
  ];
  const cost = (value) => Math.ceil(JSON.stringify(value).length / 4);
  const fold = (value) => String(value || '').toLowerCase();
  const cap = (value, max) => String(value || '').slice(0, max);

  class ToolExposure {
    constructor() {
      this.catalog = new Map();
      this.loaded = new Map();
      this.discovered = new Set();
      this.clock = 0;
      this.budget = 4000;
      this.lastStats = null;
    }
    configure(definitions, schemas, budget = 4000) {
      this.budget = Math.max(cost(DISCOVERY_SCHEMAS) + 64, Math.min(16000, Number(budget) || 4000));
      const byName = new Map(schemas.map((entry) => [entry.function.name, entry]));
      this.catalog = new Map(
        definitions
          .filter((entry) => byName.has(entry.name))
          .map((entry) => {
            const original = byName.get(entry.name);
            return [
              entry.name,
              {
                ...entry,
                category: cap(entry.category || '其他', 100),
                schema: original,
                cost: cost(original),
              },
            ];
          }),
      );
      for (const name of this.loaded.keys()) if (!this.catalog.has(name)) this.loaded.delete(name);
      for (const name of this.discovered) if (!this.catalog.has(name)) this.discovered.delete(name);
      // Core schemas are optional, so even a tiny budget keeps all capabilities reachable.
      let used = cost(DISCOVERY_SCHEMAS) + 64;
      for (const value of this.loaded.values()) used += value.cost;
      for (const name of CORE) {
        const entry = this.catalog.get(name);
        if (entry && !this.loaded.has(name) && used + entry.cost <= this.budget) {
          this.loaded.set(name, { cost: entry.cost, used: 0 });
          used += entry.cost;
        }
      }
      // Schema/config hot updates may change costs. Never keep revoked or stale definitions.
      for (const [name, value] of this.loaded) value.cost = this.catalog.get(name).cost;
      this.trim();
    }
    trim(protectedNames = new Set()) {
      let used = cost(DISCOVERY_SCHEMAS) + 64;
      for (const value of this.loaded.values()) used += value.cost;
      const victims = [...this.loaded]
        .filter(([name]) => !protectedNames.has(name))
        .sort((a, b) => a[1].used - b[1].used);
      for (const [name, value] of victims) {
        if (used <= this.budget) break;
        this.loaded.delete(name);
        used -= value.cost;
      }
      return used;
    }
    touch(name) {
      const value = this.loaded.get(name);
      if (value) value.used = ++this.clock;
    }
    preload(names) {
      this.preferSelection = true;
      const keep = new Set();
      let used = cost(DISCOVERY_SCHEMAS) + 64;
      for (const name of [...new Set(names)]) {
        const entry = this.catalog.get(name);
        if (!entry) continue;
        this.discovered.add(name);
        if (used + entry.cost > this.budget) continue;
        keep.add(name);
        used += entry.cost;
        this.loaded.set(name, { cost: entry.cost, used: ++this.clock });
      }
      this.trim(keep);
      return {
        loaded: [...keep],
        deferred: names.filter((name) => this.catalog.has(name) && !keep.has(name)),
      };
    }
    schemas() {
      this.trim();
      const full = [...this.catalog.values()].map((entry) => entry.schema);
      if (!this.preferSelection && cost(full) <= this.budget) {
        for (const entry of this.catalog.values())
          if (!this.loaded.has(entry.name))
            this.loaded.set(entry.name, { cost: entry.cost, used: 0 });
        this.lastStats = {
          enabled: this.catalog.size,
          loaded: this.catalog.size,
          deferred: 0,
          budget: this.budget,
          estimatedTokens: cost(full),
          fullEstimatedTokens: cost(full),
        };
        return full;
      }
      const result = [
        ...DISCOVERY_SCHEMAS,
        ...[...this.loaded.keys()].map((name) => this.catalog.get(name).schema),
      ];
      this.lastStats = {
        enabled: this.catalog.size,
        loaded: this.loaded.size,
        deferred: this.catalog.size - this.loaded.size,
        budget: this.budget,
        estimatedTokens: cost(result),
        fullEstimatedTokens: cost([...this.catalog.values()].map((entry) => entry.schema)),
      };
      return result;
    }
    search(args = {}) {
      const query = fold(args.query).trim();
      const category = args.category;
      const names = new Set(Array.isArray(args.names) ? args.names.slice(0, 8) : []);
      if (!query && !category && !names.size) {
        const groups = new Map();
        for (const entry of this.catalog.values())
          groups.set(entry.category || '其他', (groups.get(entry.category || '其他') || 0) + 1);
        const groupsArray = [...groups].map(([name, count]) => ({ name, count }));
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        return {
          ok: true,
          categories: groupsArray.slice(offset, offset + 40),
          total: this.catalog.size,
          nextOffset: offset + 40 < groupsArray.length ? offset + 40 : null,
          hint: 'Search by category or tool name to load tools.',
        };
      }
      const words = query.match(/[\p{L}\p{N}_]+/gu) || [];
      for (const phrase of query.match(/[\p{Script=Han}]{2,}/gu) || []) {
        for (let i = 0; i < phrase.length - 1 && words.length < 40; i++)
          words.push(phrase.slice(i, i + 2));
      }
      const matches = [...this.catalog.values()]
        .map((entry) => {
          const text = fold(
            `${entry.name} ${entry.category} ${cap(entry.desc, 2000)} ${cap(entry.schema.function.description, 4000)}`,
          );
          const exact = names.has(entry.name) || fold(entry.name) === query;
          const score = exact
            ? 10000
            : words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
          return { entry, score };
        })
        .filter(
          ({ entry, score }) =>
            (!category || entry.category === category) &&
            (names.size ? names.has(entry.name) : !query || score > 0),
        )
        .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const limit = Math.max(1, Math.min(8, Math.floor(Number(args.limit) || 5)));
      const selected = matches.slice(offset, offset + limit).map(({ entry }) => entry);
      const keep = new Set();
      const base = cost(DISCOVERY_SCHEMAS) + 64;
      let requestedCost = base;
      for (const entry of selected) {
        this.discovered.add(entry.name);
        if (args.load === false || requestedCost + entry.cost > this.budget) continue;
        keep.add(entry.name);
        requestedCost += entry.cost;
        this.loaded.set(entry.name, { cost: entry.cost, used: ++this.clock });
      }
      this.trim(keep);
      return {
        ok: true,
        total: matches.length,
        nextOffset: offset + limit < matches.length ? offset + limit : null,
        tools: selected.map((entry) => ({
          name: entry.name,
          category: cap(entry.category, 100),
          description: cap(entry.desc || entry.schema.function.description, 200),
          loaded: this.loaded.has(entry.name),
          estimatedTokens: entry.cost,
          required: (entry.schema.function.parameters?.required || []).slice(0, 40),
          hint: this.loaded.has(entry.name)
            ? 'Callable directly in the next request.'
            : 'Use describeTool and invokeTool; capability remains available.',
        })),
        unavailable: [...names].filter((name) => !this.catalog.has(name)),
        budget: this.budget,
      };
    }
    describe(args = {}) {
      const entry = this.catalog.get(args.name);
      if (!entry || !this.discovered.has(args.name))
        return { ok: false, error: 'Search for this enabled tool first.' };
      let value = entry.schema.function.parameters || {};
      if (args.path) {
        if (!String(args.path).startsWith('/'))
          return { ok: false, error: 'path must be a JSON pointer' };
        for (const segment of String(args.path).slice(1).split('/')) {
          const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
          if (!value || !Object.prototype.hasOwnProperty.call(value, key))
            return { ok: false, error: 'Schema path not found' };
          value = value[key];
        }
      } else {
        const keys = Object.keys(value.properties || {});
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        let bytes = 0;
        const properties = {};
        for (const key of keys.slice(offset, offset + 12)) {
          const part = value.properties[key];
          const size = JSON.stringify(part).length;
          if (bytes + size > 6000) break;
          properties[key] = part;
          bytes += size;
        }
        const count = Object.keys(properties).length;
        const constraints = {},
          constraintPaths = [];
        for (const [key, item] of Object.entries(value)) {
          if (['properties', 'type', 'required'].includes(key)) continue;
          if (JSON.stringify(item).length < 1200 && JSON.stringify(constraints).length < 2000)
            constraints[key] = item;
          else constraintPaths.push('/' + key.replace(/~/g, '~0').replace(/\//g, '~1'));
        }
        return {
          ok: true,
          name: entry.name,
          description: cap(entry.schema.function.description, 1200),
          type: value.type,
          required: (value.required || []).slice(0, 40),
          properties,
          constraints,
          constraintPaths,
          totalProperties: keys.length,
          nextOffset: offset + count < keys.length ? offset + count : null,
          hint:
            count || !keys.length
              ? undefined
              : `Use path /properties/${keys[offset]?.replace(/~/g, '~0').replace(/\//g, '~1')} to inspect this large field in sections.`,
        };
      }
      if (JSON.stringify(value).length > 6000)
        return {
          ok: false,
          error: 'Schema section too large; select a deeper path.',
          keys: Object.keys(value).slice(0, 40),
        };
      return { ok: true, name: entry.name, path: args.path, schema: value };
    }
    resolve(args = {}) {
      if (!this.catalog.has(args.name) || !this.discovered.has(args.name))
        throw new Error('Tool must be enabled and discovered before invocation.');
      const parsed = JSON.parse(args.arguments_json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('arguments_json must contain a JSON object');
      return { name: args.name, args: parsed };
    }
  }
  ToolExposure.discoverySchemas = DISCOVERY_SCHEMAS;
  if (typeof module !== 'undefined' && module.exports) module.exports = { ToolExposure };
  root.ToolExposure = ToolExposure;
})(typeof window !== 'undefined' ? window : globalThis);
