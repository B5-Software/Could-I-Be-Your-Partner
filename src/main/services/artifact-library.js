/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');

class ArtifactLibrary {
  constructor(file) {
    this.file = file;
    this.pending = Promise.resolve();
  }
  record(source, data) {
    const row = {
      id: randomUUID(),
      mode: source.mode,
      conversationId: source.conversationId,
      conversationTitle: String(source.title || '').slice(0, 120),
      createdAt: Date.now(),
      location: data.location === 'vm' ? 'vm' : 'host',
      path: String(data.fullPath || '').slice(0, 4096),
      filename: String(data.filename || '').slice(0, 255),
      title: String(data.title || data.filename || '').slice(0, 200),
      description: String(data.description || '').slice(0, 1000),
      ...(Number.isSafeInteger(data.size) && data.size >= 0 && { size: data.size }),
    };
    const task = this.pending.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.appendFile(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
      return row;
    });
    this.pending = task.catch(() => {});
    return task;
  }
  async list({ query = '', mode = '', before, limit = 30 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('INVALID_ARTIFACT_PAGE');
    await this.pending;
    const filter = String(query).slice(0, 200).trim().toLocaleLowerCase();
    let file;
    try {
      file = await fs.promises.open(this.file);
    } catch (error) {
      if (error.code === 'ENOENT') return { items: [], next: null };
      throw error;
    }
    const stream = file.createReadStream();
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const rows = [];
    let found = !before;
    try {
      for await (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || typeof row !== 'object') continue;
        if (row.id === before) {
          found = true;
          break;
        }
        if (mode && row.mode !== mode) continue;
        const haystack = [row.title, row.filename, row.description, row.path, row.conversationTitle]
          .join('\n')
          .toLocaleLowerCase();
        if (!haystack.includes(filter)) continue;
        rows.push(row);
        if (rows.length > limit + 1) rows.shift();
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (!found) throw new Error('INVALID_ARTIFACT_PAGE');
    const items = rows.slice(-limit).reverse();
    return { items, next: rows.length > limit ? items.at(-1).id : null };
  }
}

module.exports = { ArtifactLibrary };
