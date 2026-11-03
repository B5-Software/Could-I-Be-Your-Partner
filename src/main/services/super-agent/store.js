/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const clone = (v) => structuredClone(v);
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const STATES = ['queued', 'running', 'waiting', 'needs_attention', 'completed', 'stopped'];
class SuperStore {
  constructor(directory) {
    this.file = path.join(directory, 'state.json');
    this.state = { version: 1, revision: 0, paused: false, events: [], tasks: [], deliveries: [] };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lockFile = path.join(directory, 'owner.lock');
    this.token = randomUUID();
    this.acquire();
    try {
      if (fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > 32 * 1024 * 1024) throw Error('SUPER_STORAGE_LIMIT');
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (digest(saved.state) !== saved.checksum) throw Error('SUPER_STORAGE_INVALID');
        this.validate(saved.state);
        this.state = saved.state;
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  acquire() {
    for (let i = 0; i < 2; i++) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token }));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const raw = fs.readFileSync(this.lockFile, 'utf8'),
          owner = JSON.parse(raw);
        if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string')
          throw Error('SUPER_STORAGE_LOCKED');
        try {
          process.kill(owner.pid, 0);
          throw Error('SUPER_STORAGE_LOCKED');
        } catch (e) {
          if (e.code !== 'ESRCH') throw Error('SUPER_STORAGE_LOCKED');
        }
        if (fs.readFileSync(this.lockFile, 'utf8') !== raw) throw Error('SUPER_STORAGE_LOCKED');
        fs.unlinkSync(this.lockFile);
      }
    }
    throw Error('SUPER_STORAGE_LOCKED');
  }
  validate(s) {
    if (
      !s ||
      s.version !== 1 ||
      !Number.isSafeInteger(s.revision) ||
      typeof s.paused !== 'boolean' ||
      !Array.isArray(s.tasks) ||
      !Array.isArray(s.events) ||
      !Array.isArray(s.deliveries) ||
      s.tasks.length > 1000 ||
      s.events.length > 10000 ||
      s.deliveries.length > 10000
    )
      throw Error('SUPER_STORAGE_INVALID');
    for (const rows of [s.tasks, s.events, s.deliveries])
      if (
        new Set(rows.map((r) => r.id)).size !== rows.length ||
        rows.some((r) => typeof r.id !== 'string')
      )
        throw Error('SUPER_STORAGE_INVALID');
    for (const t of s.tasks)
      if (
        !STATES.includes(t.status) ||
        !Array.isArray(t.inputIds) ||
        !Number.isSafeInteger(t.generation) ||
        !Number.isSafeInteger(t.attempts) ||
        !Number.isFinite(t.tokens) ||
        typeof t.scope !== 'string'
      )
        throw Error('SUPER_STORAGE_INVALID');
    for (const e of s.events)
      if (
        !['pending', 'routing', 'assigned', 'ignored', 'needs_attention'].includes(e.status) ||
        typeof e.text !== 'string' ||
        typeof e.threadId !== 'string' ||
        (e.taskId && !s.tasks.some((t) => t.id === e.taskId))
      )
        throw Error('SUPER_STORAGE_INVALID');
    for (const t of s.tasks)
      if (t.inputIds.some((id) => !s.events.some((e) => e.id === id && e.taskId === t.id)))
        throw Error('SUPER_STORAGE_INVALID');
  }
  change(fn) {
    if (this.closed || this.error) throw Error('SUPER_STORAGE_UNAVAILABLE');
    const next = clone(this.state),
      result = fn(next);
    next.revision++;
    this.validate(next);
    const text = JSON.stringify({ state: next, checksum: digest(next) });
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error('SUPER_STORAGE_LIMIT');
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      if (process.platform !== 'win32') {
        const dir = fs.openSync(path.dirname(this.file), 'r');
        try {
          fs.fsyncSync(dir);
        } finally {
          fs.closeSync(dir);
        }
      }
      this.state = next;
      return clone(result);
    } catch (error) {
      this.error = true;
      throw error;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  close() {
    this.closed = true;
    try {
      if (JSON.parse(fs.readFileSync(this.lockFile, 'utf8')).token === this.token)
        fs.unlinkSync(this.lockFile);
    } catch {
      /* never delete another owner's lock */
    }
  }
}
module.exports = { SuperStore, STATES, digest };
