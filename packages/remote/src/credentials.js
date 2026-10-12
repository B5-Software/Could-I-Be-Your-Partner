/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { read, atomic } = require('./store');
const { RemoteError, identifier } = require('./contract');
const SCOPES = [
  'system.read',
  'system.manage',
  'events.read',
  'sessions.read',
  'sessions.write',
  'interactions.answer',
  'settings.read',
  'settings.write',
  'secrets.write',
  'workspace.read',
  'workspace.write',
  'files.read',
  'files.write',
  'tools.read',
  'tools.invoke',
  'devices.read',
  'devices.manage',
  'clients.manage',
  'updates.manage',
];
const hash = (token) => createHash('sha256').update(token).digest('hex');
class Credentials {
  constructor(file) {
    this.file = file;
    this.entries = new Map(read(file, []));
  }
  list() {
    return [...this.entries].map(([id, { label, scopes, expires }]) => ({
      id,
      label,
      scopes,
      expires,
    }));
  }
  issue({
    label = '',
    scopes = ['system.read', 'sessions.read', 'events.read'],
    durationMs = 86400000,
  }) {
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((s) => !SCOPES.includes(s)) ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 60000 ||
      durationMs > 31536000000
    )
      throw new RemoteError('INVALID_PARAMS');
    for (const [id, entry] of this.entries)
      if (entry.expires <= Date.now()) this.entries.delete(id);
    if (this.entries.size >= 128) throw new RemoteError('RESOURCE_BUSY');
    const id = randomUUID(),
      accessToken = randomBytes(32).toString('hex');
    this.entries.set(id, {
      label: String(label).slice(0, 80),
      scopes: [...new Set(scopes)],
      tokenHash: hash(accessToken),
      expires: Date.now() + durationMs,
    });
    atomic(this.file, [...this.entries]);
    return { id, accessToken, scopes, expires: this.entries.get(id).expires };
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const digest = hash(token);
    for (const [id, entry] of this.entries)
      if (entry.tokenHash === digest && entry.expires > Date.now())
        return { id, scopes: entry.scopes };
    return null;
  }
  revoke(id) {
    identifier(id);
    this.entries.delete(id);
    atomic(this.file, [...this.entries]);
    return { revoked: true };
  }
  attach(service) {
    service.register('client.list', 'clients.manage', () => this.list());
    service.register('client.issue', 'clients.manage', (p) => this.issue(p), {
      write: true,
      raw: true,
    });
    service.register('client.revoke', 'clients.manage', (p) => this.revoke(p.clientId), {
      write: true,
    });
  }
}
module.exports = { Credentials, SCOPES };
