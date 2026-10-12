/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { RemoteError, publicValue } = require('./contract');
function atomic(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function read(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
class Operations {
  constructor(file, { maximum = 512, retentionMs = 86400000 } = {}) {
    this.file = file;
    this.maximum = maximum;
    this.retentionMs = retentionMs;
    this.pending = new Map();
    this.entries = new Map(read(file, []));
    for (const entry of this.entries.values())
      if (entry.state === 'running') entry.state = 'unknown';
    this.save();
  }
  save() {
    atomic(
      this.file,
      [...this.entries].map(([key, value]) => [
        key,
        {
          ...value,
          ...(Object.hasOwn(value, 'result') ? { result: publicValue(value.result) } : {}),
        },
      ]),
    );
  }
  get(principal, id) {
    return this.entries.get(principal + ':' + id) || null;
  }
  async run(principal, id, method, params, execute) {
    const key = principal + ':' + id,
      signature = createHash('sha256')
        .update(canonical([method, params]))
        .digest('hex');
    const prior = this.entries.get(key);
    if (prior) {
      if (prior.signature !== signature)
        throw new RemoteError('REVISION_CONFLICT', 'Operation ID reused with different parameters');
      if (this.pending.has(key)) return this.pending.get(key);
      if (prior.state === 'unknown' || prior.state === 'running')
        throw new RemoteError(
          'RESULT_UNKNOWN',
          'Operation interrupted; inspect its state before retrying',
          { operationId: id },
        );
      if (prior.error)
        throw new RemoteError(prior.error.reason, prior.error.message, prior.error.data);
      return prior.result;
    }
    for (const [k, v] of this.entries)
      if (!this.pending.has(k) && v.state !== 'running' && v.at < Date.now() - this.retentionMs)
        this.entries.delete(k);
    // Never silently forget recent hardware operations and repeat them.
    if (this.entries.size >= this.maximum)
      throw new RemoteError('RESOURCE_BUSY', 'Operation journal is full', { retryable: true });
    const entry = { signature, method, at: Date.now(), state: 'running' };
    this.entries.set(key, entry);
    this.save();
    const promise = Promise.resolve()
      .then(execute)
      .then(
        (result) => {
          entry.result = result ?? null;
          entry.state = 'succeeded';
          this.save();
          return result;
        },
        (error) => {
          entry.state = error?.data?.reason === 'RESULT_UNKNOWN' ? 'unknown' : 'failed';
          entry.error = {
            reason: error.data?.reason || 'INTERNAL_ERROR',
            message: error instanceof RemoteError ? error.message : 'Operation failed',
            data: error.data,
          };
          this.save();
          throw error;
        },
      )
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
module.exports = { atomic, read, canonical, Operations };
