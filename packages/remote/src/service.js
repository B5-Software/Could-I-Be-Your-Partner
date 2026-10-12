/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const {
  PROTOCOL,
  LIMITS,
  RemoteError,
  request,
  identifier,
  requireScope,
  errorResponse,
  publicValue,
} = require('./contract');
const { Operations, read, atomic } = require('./store');
const { EventLog } = require('./events');
class RemoteService {
  constructor({
    identityFile,
    operationsFile,
    product = { name: 'CIBYP', version: '0.1.0' },
    capabilities = [],
    limits = {},
  } = {}) {
    this.instanceId = read(identityFile, null) || randomUUID();
    atomic(identityFile, this.instanceId);
    this.bootId = randomUUID();
    this.product = product;
    this.capabilities = capabilities;
    this.limits = { ...LIMITS, ...limits };
    this.methods = new Map();
    this.inFlight = 0;
    this.events = new EventLog();
    this.operations = new Operations(operationsFile);
    this.register('system.hello', 'system.read', () => ({
      protocol: PROTOCOL,
      instanceId: this.instanceId,
      bootId: this.bootId,
      product: this.product,
      profile: 'control',
      capabilities: this.capabilities,
      limits: this.limits,
      cursor: this.events.cursor(),
    }));
    this.register('operation.get', 'system.read', (p, c) => {
      identifier(p.operationId);
      const entry = this.operations.get(c.id, p.operationId);
      return entry
        ? { state: entry.state, result: publicValue(entry.result), error: entry.error }
        : null;
    });
  }
  register(name, scope, handler, { write = false, raw = false } = {}) {
    if (this.methods.has(name)) throw new Error('Duplicate remote method: ' + name);
    this.methods.set(name, { scope, handler, write, raw });
    return this;
  }
  async handle(body, principal) {
    try {
      request(body);
      if (Buffer.byteLength(JSON.stringify(body)) > this.limits.maxMessageBytes)
        throw new RemoteError('PAYLOAD_TOO_LARGE');
      const method = this.methods.get(body.method);
      if (!method) throw Object.assign(new RemoteError('METHOD_NOT_FOUND'), { code: -32601 });
      requireScope(principal, method.scope);
      if (this.inFlight >= this.limits.maxInFlight)
        throw new RemoteError('RESOURCE_BUSY', 'Too many in-flight requests', {
          retryable: true,
          retryAfterMs: 500,
        });
      this.inFlight++;
      try {
        const p = body.params || {};
        const run = () => method.handler(p, principal);
        const result = method.write
          ? await this.operations.run(
              principal.id,
              identifier(p.operationId, 'operationId'),
              body.method,
              p,
              run,
            )
          : await run();
        const output = method.raw ? result : publicValue(result);
        if (Buffer.byteLength(JSON.stringify(output ?? null)) > this.limits.maxMessageBytes)
          throw new RemoteError('PAYLOAD_TOO_LARGE', 'Use pagination for this result');
        return { jsonrpc: '2.0', id: body.id, result: output ?? null };
      } finally {
        this.inFlight--;
      }
    } catch (error) {
      return errorResponse(body?.id, error);
    }
  }
}
module.exports = { RemoteService };
