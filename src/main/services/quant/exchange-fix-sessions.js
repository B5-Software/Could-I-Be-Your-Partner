/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CoinbaseFixSession } = require('./coinbase-fix-session');
const { MAX_SEQUENCE } = require('./coinbase-fix-wire');

class ExchangeFixSessions {
  constructor(owner, { create = (options) => new CoinbaseFixSession(options) } = {}) {
    this.owner = owner;
    this.create = create;
    this.sessions = new Map();
  }

  status(env) {
    return this.sessions.get(env)?.status() || { phase: 'idle', lastSequence: null, error: null };
  }

  writer(env, account, expected) {
    const session = this.sessions.get(env);
    const connectionId = session?.connectionId();
    if (
      this.owner.closed ||
      this.owner.accounts.get(env) !== account ||
      !connectionId ||
      (expected && connectionId !== expected)
    )
      throw Error(expected ? 'EXCHANGE_FIX_SAME_CONNECTION' : 'EXCHANGE_FIX_NOT_READY');
    return { session, connectionId };
  }

  connectionId(env) {
    return this.sessions.get(env)?.connectionId();
  }

  session(env, account) {
    if (this.owner.closed || this.owner.accounts.get(env) !== account)
      throw Error('EXCHANGE_FIX_CLOSED');
    const existing = this.sessions.get(env);
    if (existing) return existing;
    const file = path.join(this.owner.service.directory, `coinbase-fix-${env}.json`);
    const binding = account.credentialId || account.profileId;
    let cursor = 2;
    let stored = false;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw Error('invalid');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        record.version !== 1 ||
        typeof record.binding !== 'string' ||
        !Number.isInteger(record.cursor) ||
        record.cursor < 2 ||
        record.cursor >= MAX_SEQUENCE
      )
        throw Error('invalid');
      if (record.binding === binding) {
        cursor = record.cursor;
        stored = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('EXCHANGE_FIX_STORE');
    }
    const session = this.create({
      env,
      account,
      cursor,
      previousSession: stored,
      checkpoint: (next) => {
        if (stored && next === cursor) return;
        try {
          this.owner.write(file, { version: 1, binding, cursor: next });
        } catch {
          throw Error('EXCHANGE_FIX_STORE');
        }
        cursor = next;
        stored = true;
      },
      change: () => this.owner.watch.emit(env, { fix: this.status(env) }),
      venueUpdate: (fields) => this.owner.applyTpslUpdate(env, account, fields),
    });
    this.sessions.set(env, session);
    return session;
  }

  drop(env) {
    const session = this.sessions.get(env);
    this.sessions.delete(env);
    session?.close();
    return this.status(env);
  }

  dispose() {
    for (const env of this.sessions.keys()) this.drop(env);
  }
}

module.exports = { ExchangeFixSessions };
