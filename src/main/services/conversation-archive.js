/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const { createCipheriv, createDecipheriv, randomBytes, scrypt } = require('node:crypto');
const { promisify } = require('node:util');

const LIMIT = 8 * 1024 * 1024;
const FORMAT = 'cibyp-conversations';
const SEALED = 'cibyp-conversations-encrypted';
const MODES = new Set(['chat', 'babe', 'code']);
const ID = /^[a-z0-9_-]{1,128}$/i;
const keyFor = promisify(scrypt);
const derive = (password, salt) => {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024)
    throw new Error('ARCHIVE_PASSWORD_LENGTH');
  return keyFor(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
};

const encode = (text) => Buffer.from(text, 'utf8');
function validate(snapshot) {
  if (
    snapshot?.format !== FORMAT ||
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.rows) ||
    snapshot.rows.length < 1 ||
    snapshot.rows.length > 200
  )
    throw new Error('INVALID_CONVERSATION_ARCHIVE');
  for (const row of snapshot.rows) {
    if (
      !MODES.has(row?.mode) ||
      !ID.test(String(row?.data?.id || '')) ||
      !Array.isArray(row.data.messages) ||
      row.data.messages.some((message) => !message || typeof message.role !== 'string')
    )
      throw new Error('INVALID_CONVERSATION_ARCHIVE');
  }
  return snapshot.rows;
}

function binary(value, length, max = length) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(max / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error('INVALID_CONVERSATION_ARCHIVE');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < length || bytes.length > max || bytes.toString('base64') !== value)
    throw new Error('INVALID_CONVERSATION_ARCHIVE');
  return bytes;
}

async function encodeBackup(rows, password) {
  const snapshot = { format: FORMAT, version: 1, rows };
  validate(snapshot);
  const plain = encode(JSON.stringify(snapshot));
  if (plain.length > LIMIT) throw new Error('CONVERSATION_ARCHIVE_SIZE');
  if (password === undefined) return plain.toString('utf8');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await derive(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(encode(SEALED + '-1'));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({
      format: SEALED,
      version: 1,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  } finally {
    key.fill(0);
  }
}

async function decodeBackup(text, password) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > Math.ceil((LIMIT * 4) / 3) + 512)
    throw new Error('CONVERSATION_ARCHIVE_SIZE');
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new Error('INVALID_CONVERSATION_ARCHIVE');
  }
  if (snapshot?.format !== SEALED) {
    if (Buffer.byteLength(text) > LIMIT) throw new Error('CONVERSATION_ARCHIVE_SIZE');
    return validate(snapshot);
  }
  if (snapshot.version !== 1) throw new Error('INVALID_CONVERSATION_ARCHIVE');
  const salt = binary(snapshot.salt, 16),
    nonce = binary(snapshot.nonce, 12);
  const tag = binary(snapshot.tag, 16),
    data = binary(snapshot.data, 1, LIMIT);
  const key = await derive(password, salt);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(encode(SEALED + '-1'));
    cipher.setAuthTag(tag);
    const plain = Buffer.concat([cipher.update(data), cipher.final()]);
    return validate(JSON.parse(plain.toString('utf8')));
  } catch {
    throw new Error('CONVERSATION_ARCHIVE_AUTH');
  } finally {
    key.fill(0);
  }
}

function exportRows(rows, format) {
  if (format === 'json') return JSON.stringify(rows, null, 2);
  if (format === 'sql') {
    // SQLite text literals via hex keep arbitrary markdown and NULs out of SQL syntax.
    const sql = (value) => "CAST(X'" + encode(String(value)).toString('hex') + "' AS TEXT)";
    return [
      'BEGIN;',
      'CREATE TABLE IF NOT EXISTS conversations (mode TEXT, original_id TEXT, title TEXT, transcript_json TEXT);',
      ...rows.map(
        ({ mode, data }) =>
          'INSERT INTO conversations VALUES (' +
          [mode, data.id, data.title || '', JSON.stringify(data)].map(sql).join(', ') +
          ');',
      ),
      'COMMIT;',
    ].join('\n');
  }
  if (!['md', 'txt'].includes(format)) throw new Error('INVALID_CONVERSATION_EXPORT');
  return rows
    .map(({ mode, data }) => {
      const title = String(data.title || data.id).replace(/[\r\n]+/g, ' ');
      const heading = (label) => (format === 'md' ? '# ' + label : label);
      const messages = data.messages.filter((message) =>
        ['user', 'assistant'].includes(message.role),
      );
      return [
        heading(title + ' · ' + mode),
        ...messages.map((message) => {
          const content = require('../../shared/attachments').presentation(message);
          const filenames = content.attachments.map(({ name }) => name);
          return (
            (format === 'md' ? '## ' : '') +
            message.role +
            '\n\n' +
            content.content +
            (filenames.length ? '\n\n' + filenames.join('\n') : '')
          );
        }),
      ].join('\n\n');
    })
    .join('\n\n---\n\n');
}

module.exports = { LIMIT, MODES, ID, encodeBackup, decodeBackup, exportRows };
