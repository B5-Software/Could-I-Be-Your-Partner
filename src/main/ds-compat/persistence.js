/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const {
  SessionPersistence,
  materializeCreateHeader,
  materializeAppendBatch,
  assertContiguous,
  validateStoredEvents,
} = require('@deepseek-ai/dsh-session-persistence');
const {
  SessionPersistenceNotFoundError,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionReadOnlyError,
  SessionHandleClosedError,
} = require('@deepseek-ai/dsh-session-persistence');
function error(code, message) {
  return Object.assign(new Error(message), { code });
}
class CibypPersistence extends SessionPersistence {
  constructor(ctx, options) {
    super(ctx);
    this.root = path.join(options.dataDir, 'plugin-session-journals');
    this.writers = new Map();
    this.locks = new Map();
    ctx.effect(() => async () => {
      await this.flush();
      await Promise.all([...this.writers.values()].map((handle) => handle.close()));
    });
  }
  file(id) {
    return path.join(this.root, createHash('sha256').update(String(id)).digest('hex') + '.json');
  }
  async document(id) {
    try {
      const document = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
      validateStoredEvents(document.header, document.events);
      return document;
    } catch (e) {
      if (e.code === 'ENOENT')
        throw Object.assign(new SessionPersistenceNotFoundError(id), { code: 'SESSION_NOT_FOUND' });
      throw e;
    }
  }
  locked(id, run) {
    const task = (this.locks.get(id) || Promise.resolve()).then(run, run);
    this.locks.set(id, task);
    task
      .finally(() => {
        if (this.locks.get(id) === task) this.locks.delete(id);
      })
      .catch(() => {});
    return task;
  }
  async write(document) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = this.file(document.header.id),
      temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(document));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  create(header, options = {}) {
    options.signal?.throwIfAborted();
    const meta = materializeCreateHeader(header);
    return this.locked(meta.id, async () => {
      if (await this.stat(meta.id))
        throw Object.assign(new SessionAlreadyExistsError(meta.id), {
          code: 'SESSION_ALREADY_EXISTS',
        });
      const inheritedEventCount = options.inheritedEventCount || 0;
      if (
        !Number.isSafeInteger(inheritedEventCount) ||
        inheritedEventCount < 0 ||
        (!meta.isSeeded && inheritedEventCount)
      )
        throw new TypeError('Invalid inherited event count');
      options.signal?.throwIfAborted();
      await this.write({ header: meta, events: [], inheritedEventCount });
      return this.handle(meta, 'write', inheritedEventCount);
    });
  }
  open(id, access, options = {}) {
    options.signal?.throwIfAborted();
    if (!['read', 'write'].includes(access)) throw new TypeError('Invalid session access');
    return this.locked(id, async () => {
      const doc = await this.document(id);
      options.signal?.throwIfAborted();
      return this.handle(doc.header, access, doc.inheritedEventCount || 0);
    });
  }
  handle(header, access, inheritedEventCount) {
    const id = header.id,
      service = this;
    let closed = false,
      closing;
    if (access === 'write' && this.writers.has(id))
      throw Object.assign(new SessionAlreadyOwnedError(id), { code: 'SESSION_ALREADY_OWNED' });
    const check = (writing, signal) => {
      if (closed)
        throw Object.assign(new SessionHandleClosedError(id, 'operation'), {
          code: 'SESSION_HANDLE_CLOSED',
        });
      if (writing && access !== 'write')
        throw Object.assign(new SessionReadOnlyError(id, 'operation'), {
          code: 'SESSION_READ_ONLY',
        });
      signal?.throwIfAborted();
    };
    const handle = {
      id,
      header,
      access,
      inheritedEventCount,
      async read(offset = 0, length, options = {}) {
        check(false, options.signal);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
        )
          throw new TypeError('Invalid session read range');
        const document = await service.document(id);
        return {
          events: document.events.slice(offset, length === undefined ? undefined : offset + length),
          eventState: 'detached',
        };
      },
      append(events, options = {}) {
        check(true, options.signal);
        const batch = materializeAppendBatch(events);
        return service.locked(id, async () => {
          check(true, options.signal);
          const doc = await service.document(id);
          assertContiguous(id, batch, doc.events.length);
          const combined = [...doc.events, ...batch];
          validateStoredEvents(header, combined);
          await service.write({ ...doc, events: combined });
        });
      },
      async flush(options = {}) {
        check(true, options.signal);
        await service.locks.get(id);
      },
      close() {
        return (closing ||= (async () => {
          if (access === 'write') await handle.flush();
          closed = true;
          if (service.writers.get(id) === handle) service.writers.delete(id);
        })());
      },
      [Symbol.asyncDispose]() {
        return handle.close();
      },
    };
    if (access === 'write') this.writers.set(id, handle);
    return handle;
  }
  async flush() {
    await Promise.all([...this.writers.values()].map((handle) => handle.flush()));
  }
  async stat(id, options = {}) {
    options.signal?.throwIfAborted();
    try {
      const doc = await this.document(id);
      return {
        header: doc.header,
        eventCount: doc.events.length,
        revision: createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
      };
    } catch (e) {
      if (e.code === 'SESSION_NOT_FOUND') return undefined;
      throw e;
    }
  }
  async list(options = {}) {
    options.signal?.throwIfAborted();
    let names;
    try {
      names = await fs.readdir(this.root);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const result = [];
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      options.signal?.throwIfAborted();
      const doc = JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8'));
      result.push(await this.stat(doc.header.id, options));
    }
    return result;
  }
}
module.exports = { CibypPersistence };
