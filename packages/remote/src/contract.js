/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const PROTOCOL = Object.freeze({ major: 2, minor: 0 });
const LIMITS = Object.freeze({ maxMessageBytes: 262144, maxInFlight: 8, maxDepth: 24 });
const REASONS = Object.freeze({
  AUTH_REQUIRED: 1001,
  FORBIDDEN: 1003,
  CAPABILITY_UNAVAILABLE: 1004,
  REVISION_CONFLICT: 1009,
  RESOURCE_BUSY: 1010,
  DEVICE_OFFLINE: 1011,
  DEADLINE_EXCEEDED: 1012,
  RESULT_UNKNOWN: 1013,
  PAYLOAD_TOO_LARGE: 1014,
  RESYNC_REQUIRED: 1015,
});
class RemoteError extends Error {
  constructor(reason, message = reason, data = {}) {
    super(message);
    this.name = 'RemoteError';
    this.code = REASONS[reason] || -32602;
    this.data = { reason, retryable: false, ...data };
  }
}
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function identifier(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:@/-]{1,160}$/.test(value))
    throw new RemoteError('INVALID_PARAMS', `Invalid ${label}`);
  return value;
}
function bounded(value, depth = 0) {
  if (depth > LIMITS.maxDepth)
    throw new RemoteError('INVALID_PARAMS', 'Object nesting limit exceeded');
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new RemoteError('PAYLOAD_TOO_LARGE');
    for (const v of value) bounded(v, depth + 1);
  } else if (record(value))
    for (const [key, v] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new RemoteError('INVALID_PARAMS', 'Forbidden property');
      bounded(v, depth + 1);
    }
  else if (typeof value === 'number' && !Number.isFinite(value))
    throw new RemoteError('INVALID_PARAMS', 'Non-finite number');
}
function request(value) {
  if (
    !record(value) ||
    value.jsonrpc !== '2.0' ||
    typeof value.method !== 'string' ||
    value.method.length > 100 ||
    !/^[a-zA-Z][\w.-]*$/.test(value.method)
  )
    throw Object.assign(new RemoteError('INVALID_REQUEST'), { code: -32600 });
  identifier(value.id); // Confirmable calls only. Telemetry has its separate event envelope.
  if (Object.keys(value).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key)))
    throw new RemoteError('INVALID_REQUEST', 'Unknown request field');
  if (value.params !== undefined && !record(value.params))
    throw new RemoteError('INVALID_PARAMS', 'Named parameters are required');
  bounded(value.params || {});
  return value;
}
function requireScope(principal, scope) {
  if (!principal?.id) throw new RemoteError('AUTH_REQUIRED');
  if (!(principal.scopes || []).some((v) => v === '*' || v === scope))
    throw new RemoteError('FORBIDDEN', `Missing scope: ${scope}`);
}
function errorResponse(id, error) {
  return {
    jsonrpc: '2.0',
    id: typeof id === 'string' ? id : null,
    error: {
      code: error.code || -32603,
      message: error instanceof RemoteError ? error.message : 'Internal service error',
      data: error.data || { reason: 'INTERNAL_ERROR', retryable: false },
    },
  };
}
// Secrets are omitted at the server boundary, not hidden by each frontend.
const PRIVATE =
  /^(?:api[_-]?key|zenApiKey|deviceToken|access[_-]?token|refresh[_-]?token|idToken|password|passwordHash|totpSecret|clientSecret|privateKey|secret|token|vault|authorization|cookie|llmOverride|systemPrompt|workingMessages|providerReasoning|encryptedReasoning|encrypted_content|signature|customHeaders|env|headers)$/i;
function publicValue(value, depth = 0) {
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.map((v) => publicValue(v, depth + 1));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) => !PRIVATE.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key),
      )
      .map(([key, v]) => [key, publicValue(v, depth + 1)]),
  );
}
module.exports = {
  PROTOCOL,
  LIMITS,
  REASONS,
  RemoteError,
  record,
  identifier,
  bounded,
  request,
  requireScope,
  errorResponse,
  publicValue,
};
