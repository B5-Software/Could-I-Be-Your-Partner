/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHmac } = require('node:crypto');
const { credentials } = require('./coinbase-exchange');

const SOH = '\x01';
const BEGIN = Buffer.from('8=FIXT.1.1' + SOH + '9=');
const MAX_BODY = 65536;
const MAX_SEQUENCE = 2147483647;
const fail = (code = 'EXCHANGE_FIX_FRAME') => {
  throw Error(code);
};

function numberField(text, max = MAX_SEQUENCE) {
  if (!/^[1-9]\d{0,9}$/.test(text || '') || Number(text) > max) fail();
  return Number(text);
}

function checkSum(bytes) {
  let total = 0;
  for (const value of bytes) total += value;
  return String(total & 255).padStart(3, '0');
}

function timestamp(time = Date.now()) {
  const iso = new Date(time).toISOString();
  return iso.slice(0, 10).replaceAll('-', '') + '-' + iso.slice(11, 23);
}

function encode({ type, from, to, sequence, time = timestamp(), replayed = false }, fields = []) {
  const tags = [
    [35, type],
    [49, from],
    [56, to],
    [34, numberField(String(sequence))],
    ...(replayed ? [[43, 'Y']] : []),
    [52, time],
    ...fields,
  ];
  const seen = new Set([8, 9, 10]);
  const body = Buffer.from(
    tags
      .map(([tag, value]) => {
        const text = String(value ?? '');
        if (
          !Number.isSafeInteger(tag) ||
          tag < 1 ||
          seen.has(tag) ||
          !text ||
          /[\x00-\x1f\x7f]/.test(text)
        )
          fail();
        seen.add(tag);
        return `${tag}=${text}${SOH}`;
      })
      .join(''),
  );
  if (body.length > MAX_BODY) fail();
  const start = Buffer.concat([BEGIN, Buffer.from(body.length + SOH), body]);
  return Buffer.concat([start, Buffer.from(`10=${checkSum(start)}${SOH}`)]);
}

function parseFields(body) {
  if (body.at(-1) !== 1) fail();
  const fields = new Map();
  for (const part of body.subarray(0, -1).toString('utf8').split(SOH)) {
    const equal = part.indexOf('=');
    const tag = numberField(part.slice(0, equal));
    if (equal < 1 || [8, 9, 10].includes(tag) || fields.has(tag) || part.length <= equal + 1)
      fail();
    fields.set(tag, part.slice(equal + 1));
  }
  if (fields.keys().next().value !== 35) fail();
  return fields;
}

class FixFramer {
  pending = Buffer.alloc(0);

  push(bytes, handle) {
    const frames = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    let head = 0;
    while (head < frames.length) {
      const prefix = frames.subarray(head, head + BEGIN.length);
      if (!prefix.equals(BEGIN.subarray(0, prefix.length))) fail();
      if (prefix.length < BEGIN.length) break;
      const sizeStart = head + BEGIN.length;
      const sizeEnd = frames.indexOf(1, sizeStart);
      if (sizeEnd < 0 && frames.length - sizeStart <= 5) break;
      if (sizeEnd < 0 || sizeEnd - sizeStart > 5) fail();
      const size = numberField(frames.toString('ascii', sizeStart, sizeEnd), MAX_BODY);
      const checksumAt = sizeEnd + 1 + size;
      const end = checksumAt + 7;
      if (end > frames.length) break;
      const start = frames.subarray(head, checksumAt);
      if (frames.toString('latin1', checksumAt, end) !== `10=${checkSum(start)}${SOH}`) fail();
      handle(parseFields(frames.subarray(sizeEnd + 1, checksumAt)));
      head = end;
    }
    // Copy only the unfinished frame. A small remainder must not retain a large network buffer.
    this.pending = Buffer.from(frames.subarray(head));
  }
}

function logonFields(account, sentAt, heartbeat, resume) {
  const { key, passphrase, secret } = credentials(account);
  const signingKey = Buffer.from(secret, 'base64');
  try {
    const signature = createHmac('sha256', signingKey)
      .update([sentAt, 'A', '1', key, 'Coinbase', passphrase].join(SOH))
      .digest('base64');
    return [
      [98, 0],
      [108, heartbeat],
      [141, resume ? 'N' : 'Y'],
      [553, key],
      [554, passphrase],
      [95, Buffer.byteLength(signature)],
      [96, signature],
      [1137, 9],
    ];
  } finally {
    signingKey.fill(0);
  }
}

module.exports = { FixFramer, encode, timestamp, logonFields, numberField, MAX_SEQUENCE };
