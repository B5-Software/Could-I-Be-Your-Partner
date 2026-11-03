/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID, createHash } = require('node:crypto');
const MAX_FILE = 256 * 1024 * 1024,
  MAX_LINE = 1024 * 1024;
const fail = (code) => {
  throw Error(code);
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (owner, operation) => {
  if (typeof operation !== 'string' || !/^\w[\w:-]{0,127}$/.test(operation))
    fail('NATIVE_OPERATION_ID_REQUIRED');
  return digest([owner, operation]);
};
function regular(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_FILE) fail('RECORDING_FILE_INVALID');
  return s;
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp',
    fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
function read(file) {
  regular(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function* lines(file) {
  regular(file);
  let pending = Buffer.alloc(0);
  const stream = fs.createReadStream(file, { highWaterMark: 65536 });
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > MAX_LINE) fail('RECORDING_FRAME_LIMIT');
        const line = pending.subarray(0, end + 1);
        pending = pending.subarray(end + 1);
        yield line;
      }
      if (pending.length > MAX_LINE) fail('RECORDING_FRAME_LIMIT');
    }
    if (pending.length) fail('RECORDING_TORN_FRAME');
  } finally {
    stream.destroy();
  }
}
const page = (items, input = {}) => {
  const offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    fail('INVALID_PAGINATION');
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    next: offset + limit < items.length ? offset + limit : null,
  };
};
module.exports = { MAX_FILE, MAX_LINE, fail, digest, identity, regular, write, read, lines, page };
