/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const fail = (code) => {
  throw Error(code);
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
class EmergencyStop {
  constructor(directory, write) {
    this.file = path.join(directory, 'live-emergency-stop.json');
    this.write = write;
    this.record = { version: 1, generation: 'initial', halt: null };
    this.storageError = false;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error();
      const { record, sha256 } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        !record ||
        sha256 !== hash(record) ||
        record.version !== 1 ||
        !(record.generation === 'initial' || uuid(record.generation)) ||
        (record.halt !== null &&
          (!record.halt ||
            !uuid(record.halt.id) ||
            record.halt.id !== record.generation ||
            !Number.isSafeInteger(record.halt.at) ||
            record.halt.at < 0 ||
            !(record.halt.before === 'initial' || uuid(record.halt.before))))
      )
        throw Error();
      this.record = record;
    } catch (error) {
      if (error.code !== 'ENOENT') fail('WALLET_EMERGENCY_STORE_CORRUPT');
    }
  }
  get halted() {
    return this.record.halt !== null;
  }
  get generation() {
    return this.record.generation;
  }
  blocked(wallet) {
    return (
      this.halted ||
      this.storageError ||
      (wallet.policy?.mode === 'autonomous' &&
        (wallet.policy.emergencyGeneration || 'initial') !== this.generation)
    );
  }
  assert(generation) {
    if (this.halted || this.storageError) fail('WALLET_EMERGENCY_STOPPED');
    if (generation !== undefined && generation !== this.generation)
      fail('WALLET_EMERGENCY_CHANGED');
    return this.generation;
  }
  save() {
    try {
      this.write(this.file, { record: this.record, sha256: hash(this.record) });
      this.storageError = false;
    } catch {
      this.storageError = true;
      fail('WALLET_EMERGENCY_STORAGE_FAILED');
    }
  }
  halt(expected) {
    if (this.halted && this.record.halt.before === expected) {
      if (this.storageError) this.save();
      return;
    }
    if (expected !== this.generation) fail('WALLET_EMERGENCY_CHANGED');
    if (this.halted) {
      if (this.storageError) this.save();
      return;
    }
    const id = randomUUID();
    this.record = {
      version: 1,
      generation: id,
      halt: { id, at: Date.now(), before: expected },
    };
    // Install the in-memory barrier before I/O. A storage failure never re-enables signing.
    this.save();
  }
  reset(latch) {
    if (!this.halted || latch !== this.record.halt.id || this.storageError)
      fail('WALLET_EMERGENCY_CHANGED');
    const before = this.record;
    this.record = { ...before, generation: randomUUID(), halt: null };
    try {
      this.save();
    } catch (error) {
      this.record = before;
      throw error;
    }
  }
  status() {
    return {
      halted: this.halted,
      generation: this.generation,
      latchId: this.record.halt?.id || null,
      stoppedAt: this.record.halt?.at || null,
      storageError: this.storageError ? 'WALLET_EMERGENCY_STORAGE_FAILED' : null,
    };
  }
}
module.exports = { EmergencyStop };
