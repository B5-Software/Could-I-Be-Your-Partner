/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** A failed commit must never truncate the last valid settings or history file. */
function createJsonStore(io = fs) {
  function loadJSON(file, fallback) {
    try {
      return JSON.parse(io.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function saveJSON(file, data, pretty = true) {
    const json = JSON.stringify(data, null, pretty ? 2 : undefined);
    if (json === undefined) throw new TypeError('JSON data must be serializable');
    const directory = path.dirname(file);
    io.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = io.openSync(temporary, 'wx', 0o600);
      io.writeFileSync(descriptor, json, 'utf8');
      io.fsyncSync(descriptor);
      io.closeSync(descriptor);
      descriptor = undefined;
      io.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) io.closeSync(descriptor);
      try {
        io.unlinkSync(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT')
          console.warn('[json-store] temporary cleanup failed:', error.code);
      }
    }
  }
  return { loadJSON, saveJSON };
}

module.exports = { createJsonStore, ...createJsonStore() };
