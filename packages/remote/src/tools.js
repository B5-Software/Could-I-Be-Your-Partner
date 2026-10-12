/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { RemoteError, requireScope, identifier, record, publicValue } = require('./contract');
function checkSchema(schema, depth = 0) {
  if (
    !record(schema) ||
    depth > 12 ||
    !['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(schema.type)
  )
    throw new RemoteError('INVALID_PARAMS', 'Unsupported tool schema');
  if (schema.type === 'object') {
    if (!record(schema.properties) || Object.keys(schema.properties).length > 64)
      throw new RemoteError('INVALID_PARAMS', 'Invalid tool properties');
    for (const [key, value] of Object.entries(schema.properties)) {
      identifier(key, 'property');
      checkSchema(value, depth + 1);
    }
    if (
      schema.required &&
      (!Array.isArray(schema.required) ||
        schema.required.some((key) => !Object.hasOwn(schema.properties, key)))
    )
      throw new RemoteError('INVALID_PARAMS', 'Invalid required fields');
  }
  if (schema.type === 'array') checkSchema(schema.items, depth + 1);
}
function validate(schema, value, label = 'input', depth = 0) {
  if (!schema || depth > 12) throw new RemoteError('INVALID_PARAMS', 'Invalid tool schema');
  const type = schema.type;
  if (type === 'object') {
    if (!record(value)) throw new RemoteError('INVALID_PARAMS', `${label} must be an object`);
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key)) throw new RemoteError('INVALID_PARAMS', `Missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (!schema.properties?.[key]) {
        if (schema.additionalProperties !== true)
          throw new RemoteError('INVALID_PARAMS', `Unknown field: ${key}`);
      } else validate(schema.properties[key], v, key, depth + 1);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems || 64))
      throw new RemoteError('INVALID_PARAMS', `Invalid ${label}`);
    for (const v of value) validate(schema.items, v, label, depth + 1);
  } else if (type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length > (schema.maxLength || 4096) ||
      (schema.minLength && value.length < schema.minLength)
    )
      throw new RemoteError('INVALID_PARAMS', `Invalid ${label}`);
  } else if (type === 'integer' || type === 'number') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isSafeInteger(value)) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    )
      throw new RemoteError('INVALID_PARAMS', `Invalid ${label}`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new RemoteError('INVALID_PARAMS', `Invalid ${label}`);
  } else throw new RemoteError('INVALID_PARAMS', 'Unsupported tool schema type');
  if (schema.enum && !schema.enum.includes(value))
    throw new RemoteError('INVALID_PARAMS', `Invalid ${label}`);
}
class ToolRegistry {
  constructor({ events } = {}) {
    this.entries = new Map();
    this.leases = new Map();
    this.generations = new Map();
    this.revision = 0;
    this.events = events;
    this.active = 0;
    this.running = new Map();
    this.results = new Map();
    this.resultBytes = 0;
  }
  register(manifest, execute, policy = {}) {
    identifier(manifest.name, 'tool name');
    if (this.entries.has(manifest.name) || typeof execute !== 'function')
      throw new Error('Invalid or duplicate tool');
    checkSchema(manifest.inputSchema);
    if (Buffer.byteLength(JSON.stringify(manifest)) > 16384)
      throw new RemoteError('PAYLOAD_TOO_LARGE');
    const entry = { manifest: structuredClone(manifest), execute, policy };
    this.entries.set(manifest.name, entry);
    this.changed();
    return () => {
      if (this.entries.get(manifest.name) === entry) {
        this.entries.delete(manifest.name);
        this.changed();
      }
    };
  }
  changed() {
    this.events?.publish('tools.changed', { revision: ++this.revision });
  }
  describe(name) {
    const entry = this.entries.get(identifier(name));
    if (!entry) throw new RemoteError('CAPABILITY_UNAVAILABLE');
    return entry.manifest;
  }
  result(params, principal) {
    this.pruneResults();
    const result = this.results.get(identifier(params.resultId));
    if (!result)
      throw new RemoteError('RESYNC_REQUIRED', 'Tool result expired or gateway restarted');
    if (result.owner !== principal.id) throw new RemoteError('FORBIDDEN');
    const offset = params.offset ?? 0,
      limit = params.limit ?? 16384;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > result.text.length ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 16384
    )
      throw new RemoteError('INVALID_PARAMS');
    return {
      encoding: 'json',
      resultId: params.resultId,
      sha256: result.sha256,
      offset,
      totalChars: result.text.length,
      text: result.text.slice(offset, offset + limit),
      nextOffset: offset + limit < result.text.length ? offset + limit : null,
    };
  }
  pruneResults() {
    for (const [id, result] of this.results)
      if (result.expires < Date.now()) {
        this.results.delete(id);
        this.resultBytes -= result.bytes;
      }
  }
  compactResult(value, principal) {
    const text = JSON.stringify(publicValue(value) ?? null),
      bytes = Buffer.byteLength(text);
    if (bytes <= 65536) return value;
    this.pruneResults();
    if (
      bytes > 8 * 1024 * 1024 ||
      this.resultBytes + bytes > 8 * 1024 * 1024 ||
      this.results.size >= 128
    )
      throw new RemoteError('PAYLOAD_TOO_LARGE', 'Tool result exceeds the result store budget');
    const resultId = randomUUID(),
      sha256 = createHash('sha256').update(text).digest('hex');
    this.results.set(resultId, {
      text,
      bytes,
      sha256,
      owner: principal.id,
      expires: Date.now() + 600000,
    });
    this.resultBytes += bytes;
    return {
      resultId,
      sha256,
      totalChars: text.length,
      readMethod: 'tool.result',
      preview: text.slice(0, 2048),
    };
  }
  cancel(params, principal) {
    const controller = this.running.get(principal.id + '\0' + identifier(params.targetOperationId));
    if (!controller) return { cancelRequested: false };
    controller.abort();
    return { cancelRequested: true, state: 'unknown' };
  }
  list({ offset = 0, limit = 32 } = {}) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64
    )
      throw new RemoteError('INVALID_PARAMS');
    const all = [...this.entries.values()].map((v) => v.manifest);
    return {
      revision: this.revision,
      items: all.slice(offset, offset + limit),
      total: all.length,
      nextOffset: offset + limit < all.length ? offset + limit : null,
    };
  }
  acquire(resource, principal, durationMs = 30000) {
    identifier(resource, 'resource');
    if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 60000)
      throw new RemoteError('INVALID_PARAMS');
    const previous = this.leases.get(resource);
    if (previous && previous.until > performance.now() && previous.owner !== principal.id)
      throw new RemoteError('RESOURCE_BUSY', 'Resource already leased');
    const generation = (this.generations.get(resource) || 0) + 1;
    this.generations.set(resource, generation);
    const lease = {
      id: randomUUID(),
      generation,
      resource,
      owner: principal.id,
      until: performance.now() + durationMs,
    };
    this.leases.set(resource, lease);
    return { leaseId: lease.id, generation, durationMs };
  }
  release(resource, leaseId, principal) {
    const lease = this.leases.get(resource);
    if (!lease || lease.owner !== principal.id || lease.id !== leaseId)
      throw new RemoteError('FORBIDDEN');
    this.leases.delete(resource);
    return { released: true };
  }
  async invoke(p, principal) {
    requireScope(principal, 'tools.invoke');
    identifier(p.name, 'tool name');
    identifier(p.operationId, 'operationId');
    const entry = this.entries.get(p.name);
    if (!entry) throw new RemoteError('CAPABILITY_UNAVAILABLE');
    validate(entry.manifest.inputSchema, p.input || {});
    if (entry.policy.allow && !entry.policy.allow(p.input, principal))
      throw new RemoteError('FORBIDDEN', 'Tool resource is not granted');
    let lease;
    if (entry.manifest.execution?.requiresLease) {
      lease = this.leases.get(p.input.resource);
      if (
        !lease ||
        lease.until <= performance.now() ||
        lease.owner !== principal.id ||
        lease.id !== p.leaseId ||
        lease.generation !== p.generation
      )
        throw new RemoteError('FORBIDDEN', 'Valid resource lease required');
    }
    if (p.remainingMs !== undefined && !Number.isSafeInteger(p.remainingMs))
      throw new RemoteError('INVALID_PARAMS');
    const remainingMs = Math.floor(
      Math.min(
        60000,
        p.remainingMs ?? entry.manifest.execution?.timeoutMs ?? 5000,
        lease ? lease.until - performance.now() : 60000,
      ),
    );
    if (!Number.isFinite(remainingMs) || remainingMs <= 0)
      throw new RemoteError('DEADLINE_EXCEEDED');
    const controller = new AbortController();
    const runningKey = principal.id + '\0' + p.operationId;
    this.running.set(runningKey, controller);
    const timer = setTimeout(
      () => controller.abort(new RemoteError('DEADLINE_EXCEEDED')),
      remainingMs,
    );
    let abort;
    const expired = new Promise((_, reject) => {
      abort = () =>
        reject(
          new RemoteError(
            'RESULT_UNKNOWN',
            'Tool deadline exceeded; do not automatically repeat the action',
          ),
        );
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    this.active++;
    try {
      return this.compactResult(
        await Promise.race([
          Promise.resolve().then(() =>
            entry.execute(p.input || {}, {
              principal,
              operationId: p.operationId,
              lease,
              signal: controller.signal,
              remainingMs,
            }),
          ),
          expired,
        ]),
        principal,
      );
    } finally {
      this.active--;
      if (this.running.get(runningKey) === controller) this.running.delete(runningKey);
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
    }
  }
  attach(service) {
    service.register('tool.list', 'tools.read', (p) => {
      const page = this.list(p);
      return { ...page, items: page.items.map(({ inputSchema: _schema, ...summary }) => summary) };
    });
    service.register('tool.describe', 'tools.read', (p) => this.describe(p.name));
    service.register('tool.result', 'tools.invoke', (p, c) => this.result(p, c));
    service.register('tool.cancel', 'tools.invoke', (p, c) => this.cancel(p, c), { write: true });
    service.register('tool.invoke', 'tools.invoke', (p, c) => this.invoke(p, c), { write: true });
    service.register(
      'tool.lease',
      'tools.invoke',
      (p, c) => this.acquire(p.resource, c, p.durationMs),
      { write: true },
    );
    service.register(
      'tool.release',
      'tools.invoke',
      (p, c) => this.release(p.resource, p.leaseId, c),
      { write: true },
    );
  }
}
module.exports = { ToolRegistry, validate };
