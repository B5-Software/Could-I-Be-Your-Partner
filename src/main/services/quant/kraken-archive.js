/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { crc32, inflateRaw } = require('node:zlib');
const { kraken: intervals } = require('../../../shared/quant-market-intervals.json');
const { validateCandles } = require('./backtest');

const inflate = promisify(inflateRaw);
const ORIGIN = 'https://assets.kraken.com/marketing/institutions/';
const SOURCE = 'kraken-spot-quarterly-ohlcvt';
const PAIRS = new Map([
  ['BTC-USD', 'XBTUSD'],
  ['ETH-USD', 'ETHUSD'],
  ['SOL-USD', 'SOLUSD'],
]);
const MAX_BARS = 10000;
const DAY = 86400;
const MAX_MEMBER = 32 * 1024 * 1024;
const DIRECTORY_END = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const ZIP_TAIL = 65535 + 22;
const ZIP_FLAGS = 0x080e; // Deflate options, descriptor and UTF-8.
const etagPattern = /^"[\x21\x23-\x7e]{1,128}"$/;
const badZip = () => new Error('KRAKEN_ARCHIVE_INVALID_ZIP');

function day(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw Error('KRAKEN_ARCHIVE_RANGE');
  const date = new Date(text + 'T00:00:00Z');
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== text)
    throw Error('KRAKEN_ARCHIVE_RANGE');
  return date.valueOf() / 1000;
}

function quarter(time) {
  const date = new Date(time * 1000);
  const year = date.getUTCFullYear(),
    month = Math.floor(date.getUTCMonth() / 3) * 3;
  return {
    code: year + 'Q' + (1 + month / 3),
    start: Date.UTC(year, month, 1) / 1000,
    end: Date.UTC(year, month + 3, 1) / 1000,
  };
}

function windowFor(interval, input, now) {
  const completed = quarter(quarter(now).start - 1);
  const exact = input.from !== undefined || input.to !== undefined;
  const end = Math.floor((exact ? day(input.to) : completed.end) / interval) * interval;
  const start = exact
    ? Math.ceil(day(input.from) / interval) * interval
    : Math.max(Math.ceil(completed.start / interval) * interval, end - interval * MAX_BARS);
  if (start < Date.UTC(2026, 0, 1) / 1000 || end <= start || end > completed.end)
    throw Error('KRAKEN_ARCHIVE_RANGE');
  if ((end - start) / interval > MAX_BARS) throw Error('CANDLES_LIMIT');
  const quarters = [];
  for (let cursor = start; cursor < end;) {
    const item = quarter(cursor);
    if (quarters.length >= 8) throw Error('KRAKEN_ARCHIVE_QUARTER_LIMIT');
    quarters.push(item);
    cursor = item.end;
  }
  return { start, end, quarters };
}

async function readRange(fetcher, url, offset, length, entity, signal) {
  const last = entity && offset + length - 1;
  const response = await fetcher(url, {
    headers: {
      Range: entity ? `bytes=${offset}-${last}` : `bytes=-${length}`,
      'Accept-Encoding': 'identity',
      ...(entity && { 'If-Match': entity.etag }),
    },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  const reader = response.body?.getReader();
  try {
    if (response.status === 404) throw Error('KRAKEN_ARCHIVE_UNAVAILABLE');
    if (response.status === 412) throw Error('KRAKEN_ARCHIVE_CHANGED');
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    const etag = response.headers.get('etag');
    if (entity && etag !== entity.etag) throw Error('KRAKEN_ARCHIVE_CHANGED');
    if (
      response.status !== 206 ||
      !match ||
      !reader ||
      !etagPattern.test(etag || '') ||
      ![null, 'identity'].includes(response.headers.get('content-encoding'))
    )
      throw Error('KRAKEN_ARCHIVE_RANGE_RESPONSE');
    const [start, end, size] = match.slice(1).map(Number);
    const count = end - start + 1;
    if (
      !Number.isSafeInteger(size) ||
      size > 0xffffffff ||
      count < 1 ||
      count > length ||
      (entity
        ? start !== offset || end !== last || size !== entity.size
        : end !== size - 1 || start !== Math.max(0, size - length))
    )
      throw Error('KRAKEN_ARCHIVE_RANGE_RESPONSE');
    const bytes = Buffer.allocUnsafe(count);
    let read = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (read + value.length > count) throw Error('KRAKEN_ARCHIVE_RANGE_RESPONSE');
      bytes.set(value, read);
      read += value.length;
    }
    if (read !== count) throw Error('KRAKEN_ARCHIVE_RANGE_RESPONSE');
    return { bytes, start, size, etag };
  } finally {
    await reader?.cancel().catch(() => {});
  }
}

function directory({ bytes, start }) {
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (
      bytes.readUInt32LE(at) !== DIRECTORY_END ||
      at + 22 + bytes.readUInt16LE(at + 20) !== bytes.length
    )
      continue;
    const count = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 12);
    const offset = bytes.readUInt32LE(at + 16);
    if (
      bytes.readUInt32LE(at + 4) ||
      bytes.readUInt16LE(at + 8) !== count ||
      !count ||
      count === 0xffff ||
      size < count * 46 ||
      size > 8 * 1024 * 1024 ||
      offset + size !== start + at
    )
      throw badZip();
    return { count, size, offset };
  }
  throw badZip();
}

function findMember(bytes, count, name) {
  let index = 0,
    member;
  for (let row = 0; row < count; row++) {
    if (index + 46 > bytes.length || bytes.readUInt32LE(index) !== DIRECTORY_ENTRY) throw badZip();
    const nameSize = bytes.readUInt16LE(index + 28);
    const next =
      index + 46 + nameSize + bytes.readUInt16LE(index + 30) + bytes.readUInt16LE(index + 32);
    if (next > bytes.length) throw badZip();
    if (bytes.toString('utf8', index + 46, index + 46 + nameSize) === name) {
      if (member || bytes.readUInt16LE(index + 34)) throw badZip();
      member = {
        flags: bytes.readUInt16LE(index + 8),
        method: bytes.readUInt16LE(index + 10),
        crc: bytes.readUInt32LE(index + 16),
        packed: bytes.readUInt32LE(index + 20),
        size: bytes.readUInt32LE(index + 24),
        offset: bytes.readUInt32LE(index + 42),
      };
    }
    index = next;
  }
  if (index !== bytes.length) throw badZip();
  return member;
}

async function archiveMember(fetcher, code, name, signal) {
  const url = ORIGIN + 'Kraken_OHLCVT_' + code + '.zip';
  const tail = await readRange(fetcher, url, null, ZIP_TAIL, null, signal);
  const central = directory(tail);
  const centralBytes =
    central.offset >= tail.start
      ? tail.bytes.subarray(central.offset - tail.start, central.offset - tail.start + central.size)
      : (await readRange(fetcher, url, central.offset, central.size, tail, signal)).bytes;
  const member = findMember(centralBytes, central.count, name);
  if (!member) throw Error('KRAKEN_ARCHIVE_MEMBER_UNAVAILABLE');
  if (
    member.flags & ~ZIP_FLAGS ||
    ![0, 8].includes(member.method) ||
    member.packed < 1 ||
    member.packed > MAX_MEMBER ||
    member.size < 1 ||
    member.size > MAX_MEMBER ||
    member.offset + 30 + member.packed > central.offset
  )
    throw badZip();
  const { bytes: local } = await readRange(fetcher, url, member.offset, 30, tail, signal);
  const nameSize = local.readUInt16LE(26),
    extraSize = local.readUInt16LE(28);
  const offset = member.offset + 30;
  if (
    local.readUInt32LE(0) !== LOCAL_ENTRY ||
    local.readUInt16LE(6) !== member.flags ||
    local.readUInt16LE(8) !== member.method ||
    nameSize !== name.length ||
    offset + nameSize + extraSize + member.packed > central.offset
  )
    throw badZip();
  const { bytes } = await readRange(
    fetcher,
    url,
    offset,
    nameSize + extraSize + member.packed,
    tail,
    signal,
  );
  if (bytes.toString('utf8', 0, nameSize) !== name) throw badZip();
  const payload = bytes.subarray(nameSize + extraSize);
  const csv = member.method ? await inflate(payload, { maxOutputLength: member.size }) : payload;
  if (csv.length !== member.size || crc32(csv) !== member.crc)
    throw Error('KRAKEN_ARCHIVE_CHECKSUM');
  return {
    csv,
    evidence: {
      quarter: code,
      url,
      member: name,
      etag: tail.etag,
      crc32: member.crc.toString(16).padStart(8, '0'),
      sha256: createHash('sha256').update(csv).digest('hex'),
    },
  };
}

function addRows(bars, csv, period, sourceInterval, interval, start, end) {
  let previous = period.start - 1;
  const decimals = /^\d+(?:\.\d+)?$/;
  for (const line of csv.toString('utf8').trimEnd().split(/\r?\n/)) {
    const cells = line.split(',');
    const [time, open, high, low, close, volume, trades] = cells.map(Number);
    if (
      cells.length !== 7 ||
      !cells.every((cell) => decimals.test(cell)) ||
      !Number.isSafeInteger(time) ||
      time <= previous ||
      time % sourceInterval ||
      time >= period.end ||
      !Number.isSafeInteger(trades) ||
      trades <= 0 ||
      !Number.isFinite(volume) ||
      low <= 0 ||
      high > 1e12 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close)
    )
      throw Error('KRAKEN_ARCHIVE_INVALID_CSV');
    previous = time;
    if (time < start || time >= end) continue;
    const bucket = Math.floor(time / interval) * interval;
    const prior = bars.at(-1);
    if (prior?.time === bucket) {
      prior.high = Math.max(prior.high, high);
      prior.low = Math.min(prior.low, low);
      prior.close = close;
      prior.volume += volume;
    } else bars.push({ time: bucket, open, high, low, close, volume });
  }
}

async function readArchive(fetcher, { product, interval }, input, signal, now = Date.now() / 1000) {
  const pair = PAIRS.get(product);
  if (!pair || !intervals.includes(interval)) throw Error('KRAKEN_ARCHIVE_MARKET');
  const { start, end, quarters } = windowFor(interval, input, now);
  const sourceInterval = interval === 1800 ? 900 : Math.min(interval, DAY);
  const name = pair + '_' + sourceInterval / 60 + '.csv';
  const evidence = [],
    bars = [];
  for (const period of quarters) {
    signal.throwIfAborted();
    const { csv, evidence: item } = await archiveMember(fetcher, period.code, name, signal);
    addRows(bars, csv, period, sourceInterval, interval, start, end);
    evidence.push(item);
  }
  signal.throwIfAborted();
  if (!bars.length) throw Error('KRAKEN_ARCHIVE_NO_CANDLES');
  const slots = (end - start) / interval;
  return {
    candles: validateCandles(bars),
    archive: { start, end, sourceInterval, slots, gaps: slots - bars.length, entries: evidence },
  };
}

module.exports = { readArchive, SOURCE };
