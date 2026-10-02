/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { saveJSON } = require('../core/json-store');

class TodoService {
  constructor({ file, historyDirectories = [], changed = () => {} }) {
    this.file = file;
    this.changed = changed;
    this.state = { schemaVersion: 1, revision: 0, counter: 0, items: [] };
    this.ready = this.initialize(historyDirectories);
    this.ready.catch(() => {}); // IPC reports initialization failures without unhandled rejections.
    this.queue = this.ready;
  }
  async initialize(directories) {
    let stored;
    try {
      stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Unable to read persistent todos: ' + error.message);
    }
    if (stored !== undefined) {
      if (!stored || stored.schemaVersion !== 1 || !Array.isArray(stored.items))
        throw new Error('Invalid persistent todo file');
      if (
        !Number.isSafeInteger(stored.revision) ||
        stored.revision < 0 ||
        !Number.isSafeInteger(stored.counter) ||
        stored.counter < 0 ||
        stored.items.some(
          (item) =>
            !item ||
            !Number.isSafeInteger(item.id) ||
            item.id < 1 ||
            typeof item.text !== 'string' ||
            !item.text.trim() ||
            typeof item.done !== 'boolean',
        ) ||
        new Set(stored.items.map((item) => item.id)).size !== stored.items.length
      )
        throw new Error('Invalid persistent todo state');
      stored.counter = stored.items.reduce(
        (counter, item) => Math.max(counter, item.id),
        stored.counter,
      );
      this.state = stored;
      return;
    }
    // Import old conversation snapshots exactly once. Later history restores and
    // conversation deletion must never resurrect or remove global todos.
    const seen = new Map();
    for (const directory of directories) {
      let files;
      try {
        files = await fs.readdir(directory);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
        let conversation;
        try {
          conversation = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
        } catch {
          console.warn('[todos] Skipping an unreadable legacy history file:', file);
          continue;
        }
        for (const item of Array.isArray(conversation?.todoItems) ? conversation.todoItems : []) {
          if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
          const text = item.text.trim();
          const previous = seen.get(text);
          if (previous) previous.done = previous.done && item.done === true;
          else seen.set(text, { id: ++this.state.counter, text, done: item.done === true });
        }
      }
    }
    this.state.items = [...seen.values()];
    saveJSON(this.file, this.state);
  }
  async get() {
    await this.ready;
    await this.queue;
    return structuredClone(this.state);
  }
  mutate(args = {}) {
    const operation = this.queue.then(async () => {
      await this.ready;
      if (args.action === 'list') return { ok: true, items: this.state.items, state: this.state };
      const operations = Array.isArray(args.operations) ? args.operations : [args];
      if (!operations.length || operations.length > 200)
        return { ok: false, error: 'Provide between 1 and 200 todo operations.' };
      const state = structuredClone(this.state);
      const results = operations.map((op) => this.apply(state, op));
      if (results.some((result) => result.ok)) {
        state.revision++;
        // Publish only after the atomic disk commit succeeds.
        saveJSON(this.file, state);
        this.state = state;
        try {
          this.changed(structuredClone(state));
        } catch (error) {
          console.warn('[todos] State broadcast failed:', error.message);
        }
      }
      const result =
        results.length === 1
          ? results[0]
          : {
              ok: results.every((item) => item.ok),
              count: results.length,
              succeeded: results.filter((item) => item.ok).length,
              results,
              added: results
                .filter((item) => item.ok && item.action === 'add')
                .map((item) => item.id),
            };
      return { ...result, items: this.state.items, state: this.state };
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.catch((error) => ({ ok: false, error: error.message }));
  }
  apply(state, op) {
    const action = op?.action;
    if (action === 'add' || action === 'update') {
      if (typeof op.text !== 'string' || !op.text.trim() || op.text.length > 4000)
        return { ok: false, action, error: 'Todo text must contain 1 to 4000 characters.' };
    }
    if (action === 'add') {
      const item = { id: ++state.counter, text: op.text.trim(), done: false };
      state.items.push(item);
      return { ok: true, action, ...item };
    }
    const id = Number(op?.id);
    const item = state.items.find((item) => item.id === id);
    if (!item)
      return {
        ok: false,
        action,
        id,
        error: 'Todo not found. Refresh the list and use its current ID.',
      };
    if (action === 'remove') state.items = state.items.filter((item) => item.id !== id);
    else if (action === 'toggle') item.done = !item.done;
    else if (action === 'update') item.text = op.text.trim();
    else return { ok: false, action, error: 'Unknown todo action.' };
    return { ok: true, action, ...item };
  }
}
module.exports = { TodoService };
