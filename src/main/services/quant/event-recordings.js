/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { createHash } = require('node:crypto');
const {
  MAX_FILE,
  MAX_LINE,
  fail,
  identity,
  write,
  read,
  lines,
  page,
  digest,
} = require('./event-files');
class EventRecordings {
  constructor(service) {
    this.service = service;
    this.directory = path.join(service.directory, 'recordings');
    this.active = new Map();
    this.failedRecords = new Map();
    this.queue = Promise.resolve();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const item of this.listAll())
      if (item.status === 'recording')
        this.persist({ ...item, status: 'interrupted', error: 'RECORDING_INTERRUPTED' });
  }
  folder(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('RECORDING_ID_INVALID');
    return path.join(this.directory, id);
  }
  persist(value) {
    write(path.join(this.folder(value.recordingId), 'manifest.json'), value);
    return value;
  }
  listAll() {
    return fs
      .readdirSync(this.directory)
      .filter((id) => /^[a-f0-9]{64}$/.test(id))
      .map((id) => read(path.join(this.folder(id), 'manifest.json')));
  }
  get(id, owner) {
    const value =
      this.active.get(id)?.value ||
      this.failedRecords.get(id) ||
      read(path.join(this.folder(id), 'manifest.json'));
    if (value.owner !== owner) fail('RECORDING_SCOPE_MISMATCH');
    return structuredClone(value);
  }
  changed(value) {
    try {
      this.service.publish({ type: 'quant-recordings-changed', id: value.owner });
    } catch {}
  }
  request(action, input) {
    this.service.workspace(input.id);
    if (action === 'list')
      return page(
        this.listAll()
          .filter((v) => v.owner === input.id)
          .map(
            (v) =>
              this.active.get(v.recordingId)?.value || this.failedRecords.get(v.recordingId) || v,
          )
          .sort((a, b) => b.createdAt - a.createdAt),
        input,
      );
    if (action === 'get') return this.get(input.recordingId, input.id);
    if (action === 'events') return this.events(input);
    if (!['start', 'stop'].includes(action)) fail('UNKNOWN_RECORDING_ACTION');
    const task = this.queue.then(() => (action === 'start' ? this.start(input) : this.stop(input)));
    this.queue = task.catch(() => {});
    return task;
  }
  async start(input) {
    const recordingId = identity(input.id, input.operationId),
      folder = this.folder(recordingId),
      file = path.join(folder, 'manifest.json');
    if (fs.existsSync(file)) {
      const old = this.get(recordingId, input.id);
      if (old.product !== input.product || (input.name && old.name !== String(input.name).trim()))
        fail('RECORDING_OPERATION_CONFLICT');
      return old;
    }
    if (this.active.size >= 4) fail('RECORDING_LIMIT');
    const entry = this.service.nativeMarkets.sources.get(input.product);
    if (!entry?.instrument || !entry.source.desired) fail('SOURCE_NOT_READY');
    const name = String(input.name || input.product).trim();
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
      fail('RECORDING_NAME_INVALID');
    return entry.source.captureSnapshot((seed) => {
      const value = {
        version: 1,
        recordingId,
        owner: input.id,
        name,
        product: input.product,
        instrument: entry.instrument,
        assumptions: entry.assumptions,
        captureEngineSha256: this.service.native.inspect().sha256,
        createdAt: Date.now(),
        status: 'recording',
        events: 0,
        bytes: 0,
        sha256: null,
        errors: 0,
        timing: 'host-adapter-input',
        error: null,
      };
      this.persist(value);
      const stream = fs.createWriteStream(path.join(folder, 'events.jsonl'), {
        flags: 'wx',
        mode: 0o600,
        highWaterMark: 1024 * 1024,
      });
      const item = {
        value,
        stream,
        hash: createHash('sha256'),
        origin: process.hrtime.bigint(),
        unsubscribe: null,
      };
      this.active.set(recordingId, item);
      stream.on('error', () => this.failed(item, 'RECORDING_WRITE_FAILED'));
      item.unsubscribe = this.service.native.onFeed((method, params) => {
        if ((params.instrument || params.id) === entry.instrument.id)
          this.append(item, method, params);
      });
      this.append(item, 'market.snapshot', seed);
      this.changed(value);
      return structuredClone(value);
    });
  }
  append(item, method, params) {
    if (item.value.status !== 'recording') return;
    try {
      const mono = (process.hrtime.bigint() - item.origin).toString(),
        wall = (BigInt(Date.now()) * 1000000n).toString();
      const row = {
        sequence: item.value.events,
        wall_ns: wall,
        mono_ns: item.value.events === 0 ? '0' : mono,
        method,
        params,
      };
      const bytes = Buffer.from(JSON.stringify(row) + '\n');
      if (
        bytes.length > MAX_LINE ||
        item.value.bytes + bytes.length > MAX_FILE ||
        item.stream.writableLength + bytes.length > 4 * MAX_LINE ||
        BigInt(mono) > 86400000000000n
      )
        return this.failed(item, 'RECORDING_QUOTA_OR_BACKPRESSURE');
      item.stream.write(bytes);
      item.hash.update(bytes);
      item.value.events++;
      item.value.bytes += bytes.length;
      item.value.lastWallNs = wall;
      item.value.lastMonoNs = row.mono_ns;
    } catch {
      this.failed(item, 'RECORDING_WRITE_FAILED');
    }
  }
  failed(item, error) {
    if (item.value.status !== 'recording') return;
    item.value.status = 'failed';
    item.value.error = error;
    item.unsubscribe?.();
    item.stream.destroy();
    this.active.delete(item.value.recordingId);
    this.failedRecords.set(item.value.recordingId, item.value);
    if (this.failedRecords.size > 64)
      this.failedRecords.delete(this.failedRecords.keys().next().value);
    try {
      this.persist(item.value);
    } catch {}
    this.changed(item.value);
  }
  async stop(input) {
    const value = this.get(input.recordingId, input.id),
      item = this.active.get(input.recordingId);
    if (!item) return value;
    item.unsubscribe?.();
    const endedAt = Date.now(),
      endedMonoNs = (process.hrtime.bigint() - item.origin).toString(),
      endedWallNs = (BigInt(endedAt) * 1000000n).toString();
    try {
      await new Promise((resolve, reject) => {
        item.stream.once('close', resolve);
        item.stream.once('error', reject);
        item.stream.end();
      });
      if (item.value.status !== 'recording') return this.get(input.recordingId, input.id);
      const fd = await fs.promises.open(
        path.join(this.folder(value.recordingId), 'events.jsonl'),
        'r+',
      );
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
      const complete = {
        ...item.value,
        status: 'complete',
        endedAt,
        endedMonoNs,
        endedWallNs,
        sha256: item.hash.digest('hex'),
      };
      complete.manifestHash = digest(complete);
      this.persist(complete);
      item.value = complete;
      this.active.delete(value.recordingId);
      this.changed(item.value);
      return structuredClone(item.value);
    } catch {
      this.failed(item, 'RECORDING_WRITE_FAILED');
      return this.get(input.recordingId, input.id);
    }
  }
  async verify(id, owner) {
    const value = this.get(id, owner);
    if (value.status !== 'complete' || value.version !== 1) fail('RECORDING_NOT_COMPLETE');
    const { manifestHash, ...metadata } = value;
    if (manifestHash !== digest(metadata)) fail('RECORDING_MANIFEST_HASH_MISMATCH');
    let count = 0,
      size = 0,
      last = -1n;
    const hash = createHash('sha256');
    for await (const bytes of lines(path.join(this.folder(id), 'events.jsonl'))) {
      hash.update(bytes);
      size += bytes.length;
      const row = JSON.parse(bytes),
        mono = BigInt(row.mono_ns);
      if (
        row.sequence !== count ||
        mono < last ||
        mono > 86400000000000n ||
        !/^\d{1,39}$/.test(row.wall_ns) ||
        !/^\d{1,20}$/.test(row.mono_ns) ||
        !['market.snapshot', 'market.delta', 'market.trade', 'market.invalidate'].includes(
          row.method,
        ) ||
        (row.params?.instrument || row.params?.id) !== value.instrument.id ||
        (count === 0 && (row.method !== 'market.snapshot' || mono !== 0n))
      )
        fail('RECORDING_EVENT_INVALID');
      last = mono;
      count++;
    }
    if (
      !count ||
      count !== value.events ||
      size !== value.bytes ||
      hash.digest('hex') !== value.sha256
    )
      fail('RECORDING_HASH_MISMATCH');
    if (
      value.endedMonoNs &&
      (!/^\d{1,20}$/.test(value.endedMonoNs) ||
        BigInt(value.endedMonoNs) < last ||
        BigInt(value.endedMonoNs) > 86400000000000n)
    )
      fail('RECORDING_EVENT_INVALID');
    return value;
  }
  async events(input) {
    const value = await this.verify(input.recordingId, input.id);
    page([], input);
    const offset = input.offset ?? 0,
      limit = input.limit ?? 20,
      items = [];
    let count = 0;
    for await (const bytes of lines(path.join(this.folder(input.recordingId), 'events.jsonl'))) {
      if (count++ >= offset) items.push(JSON.parse(bytes));
      if (items.length === limit) break;
    }
    return {
      items,
      total: value.events,
      next: offset + limit < value.events ? offset + limit : null,
    };
  }
  dispose() {
    for (const item of [...this.active.values()]) this.failed(item, 'RECORDING_INTERRUPTED');
  }
}
module.exports = { EventRecordings };
